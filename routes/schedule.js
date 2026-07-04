const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const jwt = require('jsonwebtoken')
const prisma = new PrismaClient()

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

function adminAuth(req, res, next) {
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

// ── ADMIN: CREATE CAMPAIGN SCHEDULE ──────────────────────────
router.post('/', adminAuth, async (req, res) => {
  try {
    const {
      name, rewardAmt, pointsReq, durationDays,
      uploadsPerDay, videoUrl, instagramUrl,
      facebookUrl, instructions, startDate, endDate,
      type, description
    } = req.body

    if (!name || !rewardAmt) {
      return res.status(400).json({ error: 'Name and reward amount required' })
    }

    const schedule = await prisma.campaignSchedule.create({
      data: {
        name,
        rewardAmt: parseFloat(rewardAmt),
        pointsReq: parseInt(pointsReq) || 0,
        durationDays: parseInt(durationDays) || 1,
        uploadsPerDay: parseInt(uploadsPerDay) || 1,
        videoUrl: videoUrl || null,
        instagramUrl: instagramUrl || null,
        facebookUrl: facebookUrl || null,
        instructions: instructions || null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        type: type || null,
        description: description || null,
        createdBy: req.user.userId
      }
    })

    // Log to activity feed
    await prisma.activityFeed.create({
      data: {
        type: 'campaign_created',
        description: `Admin created new campaign: ${name} (₹${rewardAmt})`,
        amount: parseFloat(rewardAmt)
      }
    })

    res.json({ success: true, schedule })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: GET ALL SCHEDULES ──────────────────────────────────
router.get('/admin', adminAuth, async (req, res) => {
  try {
    const schedules = await prisma.campaignSchedule.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { enrollments: true } } }
    })
    res.json(schedules)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: UPDATE SCHEDULE ────────────────────────────────────
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const { name, rewardAmt, pointsReq, durationDays, uploadsPerDay,
      videoUrl, instagramUrl, facebookUrl, instructions,
      startDate, endDate, isActive, type, description } = req.body

    const schedule = await prisma.campaignSchedule.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(rewardAmt && { rewardAmt: parseFloat(rewardAmt) }),
        ...(pointsReq !== undefined && { pointsReq: parseInt(pointsReq) }),
        ...(durationDays && { durationDays: parseInt(durationDays) }),
        ...(uploadsPerDay && { uploadsPerDay: parseInt(uploadsPerDay) }),
        ...(videoUrl !== undefined && { videoUrl }),
        ...(instagramUrl !== undefined && { instagramUrl }),
        ...(facebookUrl !== undefined && { facebookUrl }),
        ...(instructions !== undefined && { instructions }),
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
        ...(isActive !== undefined && { isActive }),
        ...(type !== undefined && { type }),
        ...(description !== undefined && { description })
      }
    })
    res.json({ success: true, schedule })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: DELETE SCHEDULE ────────────────────────────────────
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    await prisma.campaignSchedule.update({
      where: { id: req.params.id },
      data: { isActive: false }
    })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: GET ACTIVE SCHEDULES ────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const schedules = await prisma.campaignSchedule.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    })

    // Get user's enrollments
    const enrollments = await prisma.campaignEnrollment.findMany({
      where: { userId: req.user.userId },
      select: { scheduleId: true, dayNumber: true, status: true }
    })

    const enrolMap = {}
    enrollments.forEach(e => {
      if (!enrolMap[e.scheduleId]) enrolMap[e.scheduleId] = []
      enrolMap[e.scheduleId].push(e)
    })

    const result = schedules.map(s => ({
      ...s,
      totalUploadsRequired: s.durationDays * s.uploadsPerDay,
      myEnrollments: enrolMap[s.id] || [],
      myProgress: (enrolMap[s.id] || []).filter(e => e.status === 'approved').length
    }))

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: SUBMIT PROOF FOR A SCHEDULED CAMPAIGN DAY ───────
router.post('/:id/submit', auth, async (req, res) => {
  try {
    const { dayNumber, screenshotUrl } = req.body

    const enrollment = await prisma.campaignEnrollment.create({
      data: {
        userId: req.user.userId,
        scheduleId: req.params.id,
        dayNumber: parseInt(dayNumber) || 1,
        screenshotUrl: screenshotUrl || null,
        status: 'pending'
      }
    })

    const schedule = await prisma.campaignSchedule.findUnique({ where: { id: req.params.id } })
    const user = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } })

    // Activity feed
    await prisma.activityFeed.create({
      data: {
        type: 'campaign_run',
        userId: req.user.userId,
        userName: user?.name || 'Partner',
        description: `${user?.name || 'Partner'} submitted proof for ${schedule?.name || 'campaign'}`,
        amount: schedule?.rewardAmt || null
      }
    })

    res.json({ success: true, enrollment })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: APPROVE ENROLLMENT ─────────────────────────────────
router.post('/enrollment/:id/approve', adminAuth, async (req, res) => {
  try {
    const enrollment = await prisma.campaignEnrollment.update({
      where: { id: req.params.id },
      data: { status: 'approved', reviewedAt: new Date() },
      include: { schedule: true, user: true }
    })

    // Credit earnings to partner
    const reward = enrollment.schedule.rewardAmt / enrollment.schedule.durationDays
    await prisma.earningsWallet.update({
      where: { userId: enrollment.userId },
      data: { balance: { increment: reward }, lifetime: { increment: reward } }
    })

    await prisma.transaction.create({
      data: {
        userId: enrollment.userId,
        type: 'campaign_reward',
        amount: reward,
        description: `${enrollment.schedule.name} Day ${enrollment.dayNumber} approved`
      }
    })

    // Activity feed
    await prisma.activityFeed.create({
      data: {
        type: 'approval',
        userId: enrollment.userId,
        userName: enrollment.user.name || 'Partner',
        description: `${enrollment.user.name || 'Partner'} earned ₹${reward} from ${enrollment.schedule.name}`,
        amount: reward
      }
    })

    res.json({ success: true, enrollment })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: REJECT ENROLLMENT ──────────────────────────────────
router.post('/enrollment/:id/reject', adminAuth, async (req, res) => {
  try {
    const enrollment = await prisma.campaignEnrollment.update({
      where: { id: req.params.id },
      data: { status: 'rejected', reviewedAt: new Date() }
    })
    res.json({ success: true, enrollment })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: GET ALL PENDING ENROLLMENTS ────────────────────────
router.get('/enrollments/pending', adminAuth, async (req, res) => {
  try {
    const enrollments = await prisma.campaignEnrollment.findMany({
      where: { status: 'pending' },
      include: { user: true, schedule: true },
      orderBy: { submittedAt: 'desc' }
    })
    res.json(enrollments)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: GET MY RUN CREDITS ───────────────────────────────
router.get('/my-credits', auth, async (req, res) => {
  try {
    const credits = await prisma.runCredit.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }
    })

    // Group by tier and count unused
    const summary = {}
    credits.forEach(c => {
      if (!summary[c.tier]) summary[c.tier] = { tier: c.tier, amount: c.amount, total: 0, used: 0, available: 0 }
      summary[c.tier].total++
      if (c.used) summary[c.tier].used++
      else summary[c.tier].available++
    })

    res.json({ credits, summary: Object.values(summary) })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
