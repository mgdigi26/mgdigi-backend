const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const jwt = require('jsonwebtoken')
const prisma = new PrismaClient()

const LEVEL_POINTS = [100, 30, 15, 15, 20, 30, 50]

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' })
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// Dashboard stats
router.get('/dashboard', auth, async (req, res) => {
  const totalPartners = await prisma.user.count({ where: { role: 'partner' } })
  const pendingProofs = await prisma.submission.count({ where: { status: 'pending' } })
  const pendingWithdrawals = await prisma.withdrawal.count({ where: { status: 'pending' } })
  const totalCampaigns = await prisma.submission.count({ where: { status: 'approved' } })
  res.json({ totalPartners, pendingProofs, pendingWithdrawals, totalCampaigns })
})

// Get all pending submissions
router.get('/submissions', auth, async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { status: 'pending' },
    include: { user: true, campaign: true },
    orderBy: { submittedAt: 'desc' }
  })
  res.json(submissions)
})

// Approve submission + trigger commissions
router.post('/submissions/:id/approve', auth, async (req, res) => {
  const submission = await prisma.submission.update({
    where: { id: req.params.id },
    data: { status: 'approved', reviewedBy: req.user.userId, reviewedAt: new Date() },
    include: { campaign: true, user: true }
  })

  // Credit reward to the partner
  await prisma.earningsWallet.update({
    where: { userId: submission.userId },
    data: {
      balance: { increment: submission.campaign.rewardAmt },
      lifetime: { increment: submission.campaign.rewardAmt }
    }
  })

  await prisma.transaction.create({
    data: {
      userId: submission.userId,
      type: 'campaign_reward',
      amount: submission.campaign.rewardAmt,
      referenceId: submission.id,
      description: `${submission.campaign.name} reward approved`
    }
  })

  // Walk up 7 levels and credit points
  let currentUserId = submission.userId
  for (let level = 0; level < 7; level++) {
    const currentUser = await prisma.user.findUnique({ where: { id: currentUserId } })
    if (!currentUser?.uplineId) break

    await prisma.pointsWallet.update({
      where: { userId: currentUser.uplineId },
      data: {
        balance: { increment: LEVEL_POINTS[level] },
        lifetime: { increment: LEVEL_POINTS[level] }
      }
    })

    await prisma.transaction.create({
      data: {
        userId: currentUser.uplineId,
        type: 'referral_commission',
        points: LEVEL_POINTS[level],
        referenceId: submission.id,
        description: `Level ${level + 1} commission from ${submission.user.name}`
      }
    })

    currentUserId = currentUser.uplineId
  }

  res.json({ success: true, submission })
})

// Reject submission
router.post('/submissions/:id/reject', auth, async (req, res) => {
  const { reason } = req.body
  const submission = await prisma.submission.update({
    where: { id: req.params.id },
    data: {
      status: 'rejected',
      rejectReason: reason,
      reviewedBy: req.user.userId,
      reviewedAt: new Date()
    }
  })
  res.json({ success: true, submission })
})

// Get all users
router.get('/users', auth, async (req, res) => {
  const users = await prisma.user.findMany({
    include: { pointsWallet: true, earningsWallet: true },
    orderBy: { createdAt: 'desc' }
  })
  res.json(users)
})

// Get pending withdrawals
router.get('/withdrawals', auth, async (req, res) => {
  const withdrawals = await prisma.withdrawal.findMany({
    where: { status: 'pending' },
    include: { user: true },
    orderBy: { requestedAt: 'desc' }
  })
  res.json(withdrawals)
})

// Approve withdrawal
router.post('/withdrawals/:id/approve', auth, async (req, res) => {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: req.params.id } })

  await prisma.earningsWallet.update({
    where: { userId: withdrawal.userId },
    data: { balance: { decrement: withdrawal.grossAmount } }
  })

  await prisma.withdrawal.update({
    where: { id: req.params.id },
    data: { status: 'paid', paidAt: new Date() }
  })

  res.json({ success: true })
})
// ── GET SINGLE USER ───────────────────────────────────────────
router.get('/users/:id', auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        pointsWallet: true,
        earningsWallet: true,
        submissions: { orderBy: { submittedAt: 'desc' }, take: 10,
          include: { campaign: true } },
        withdrawals: { orderBy: { requestedAt: 'desc' }, take: 5 },
        _count: { select: { submissions: true } }
      }
    })
    if (!user) return res.status(404).json({ error: 'User not found' })
    const downlineCount = await prisma.user.count({ where: { uplineId: user.id } })
    res.json({ ...user, downlineCount })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── SUSPEND USER ──────────────────────────────────────────────
router.patch('/users/:id/suspend', auth, async (req, res) => {
  try {
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: 'Cannot suspend yourself' })
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'suspended' }
    })
    await prisma.activityFeed.create({
      data: {
        type: 'suspension',
        userId: user.id,
        userName: user.name || 'Partner',
        description: `${user.name || 'Partner'} account suspended by admin`,
        amount: null
      }
    })
    res.json({ success: true, user })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ACTIVATE USER ─────────────────────────────────────────────
router.patch('/users/:id/activate', auth, async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'active' }
    })
    await prisma.activityFeed.create({
      data: {
        type: 'activation',
        userId: user.id,
        userName: user.name || 'Partner',
        description: `${user.name || 'Partner'} account reactivated by admin`,
        amount: null
      }
    })
    res.json({ success: true, user })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── SEND WARNING ──────────────────────────────────────────────
router.post('/users/:id/warning', auth, async (req, res) => {
  try {
    const { reason } = req.body
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { warnings: { increment: 1 } }
    })
    await prisma.activityFeed.create({
      data: {
        type: 'warning',
        userId: user.id,
        userName: user.name || 'Partner',
        description: `Warning issued to ${user.name || 'Partner'}${reason ? ': ' + reason : ''}`,
        amount: null
      }
    })
    res.json({ success: true, warnings: user.warnings })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router