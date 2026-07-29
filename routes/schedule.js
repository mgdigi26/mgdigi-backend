const express = require('express')
const router  = express.Router()
const { PrismaClient } = require('@prisma/client')
const jwt     = require('jsonwebtoken')
const prisma  = new PrismaClient()

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

// ── Helper: map dayNumber → proofNumber in enrollment objects ─
function withProofNumber(enrollment) {
  return { ...enrollment, proofNumber: enrollment.dayNumber }
}

// ── ADMIN: CREATE CAMPAIGN SCHEDULE ──────────────────────────
router.post('/', adminAuth, async (req, res) => {
  try {
    const {
      name, rewardAmt, pointsReq, durationDays,
      uploadsPerDay, videoUrl, instagramUrl,
      facebookUrl, instructions, startDate, endDate,
      type, description, imageUrl
    } = req.body

    if (!name || !rewardAmt) {
      return res.status(400).json({ error: 'Name and reward amount required' })
    }

    const schedule = await prisma.campaignSchedule.create({
      data: {
        name,
        rewardAmt:    parseFloat(rewardAmt),
        pointsReq:    parseInt(pointsReq) || 0,
        durationDays: parseInt(durationDays) || 1,
        uploadsPerDay: parseInt(uploadsPerDay) || 1,
        imageUrl:     imageUrl || null,
        videoUrl:     videoUrl || null,
        instagramUrl: instagramUrl || null,
        facebookUrl:  facebookUrl || null,
        instructions: instructions || null,
        startDate:    startDate ? new Date(startDate) : null,
        endDate:      endDate   ? new Date(endDate)   : null,
        type:         type || null,
        description:  description || null,
        createdBy:    req.user.userId
      }
    })

    await prisma.activityFeed.create({
      data: {
        type:        'campaign_created',
        description: `Admin created new campaign: ${name} (₹${rewardAmt})`,
        amount:      parseFloat(rewardAmt)
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
      startDate, endDate, isActive, type, description, imageUrl } = req.body

    const schedule = await prisma.campaignSchedule.update({
      where: { id: req.params.id },
      data: {
        ...(name         && { name }),
        ...(rewardAmt    && { rewardAmt: parseFloat(rewardAmt) }),
        ...(pointsReq    !== undefined && { pointsReq: parseInt(pointsReq) }),
        ...(durationDays && { durationDays: parseInt(durationDays) }),
        ...(uploadsPerDay && { uploadsPerDay: parseInt(uploadsPerDay) }),
        ...(videoUrl     !== undefined && { videoUrl }),
        ...(instagramUrl !== undefined && { instagramUrl }),
        ...(facebookUrl  !== undefined && { facebookUrl }),
        ...(instructions !== undefined && { instructions }),
        ...(startDate    && { startDate: new Date(startDate) }),
        ...(endDate      && { endDate:   new Date(endDate) }),
        ...(isActive     !== undefined && { isActive }),
        ...(type         !== undefined && { type }),
        ...(description  !== undefined && { description }),
        ...(imageUrl     !== undefined && { imageUrl })
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
      data:  { isActive: false }
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
      where:   { isActive: true },
      orderBy: { createdAt: 'desc' }
    })

    const enrollments = await prisma.campaignEnrollment.findMany({
      where:  { userId: req.user.userId },
      select: { scheduleId: true, dayNumber: true, status: true, joinedAt: true }
    })

    const enrolMap = {}
    enrollments.forEach(e => {
      if (!enrolMap[e.scheduleId]) enrolMap[e.scheduleId] = []
      enrolMap[e.scheduleId].push(e)
    })

    const result = schedules.map(s => ({
      ...s,
      totalProofsRequired: s.uploadsPerDay,
      myEnrollments:       (enrolMap[s.id] || []).map(withProofNumber),
      myProgress:          (enrolMap[s.id] || []).filter(e => e.status === 'approved').length,
      myJoinedAt:          (enrolMap[s.id] || [])[0]?.joinedAt ?? null,
    }))

    res.json(result)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: JOIN CAMPAIGN ────────────────────────────────────
// Creates all required proof slots immediately. Sets joinedAt.
// submittedAt is NOT set here — it is only set when a proof is uploaded.
router.post('/:id/join', auth, async (req, res) => {
  try {
    const schedule = await prisma.campaignSchedule.findUnique({
      where: { id: req.params.id }
    })

    // Validation
    if (!schedule) {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    if (!schedule.isActive) {
      return res.status(400).json({ error: 'Campaign is not active' })
    }
    if (schedule.endDate && schedule.endDate < new Date()) {
      return res.status(400).json({ error: 'Campaign has ended' })
    }

    // Marketing Points check
    const wallet = await prisma.pointsWallet.findUnique({
      where: { userId: req.user.userId }
    })
    if (!wallet || wallet.balance < schedule.pointsReq) {
      return res.status(400).json({ error: 'Insufficient Marketing Points to join this campaign' })
    }

    // Duplicate join check + slot creation in a single transaction
    // Prevents race condition where two simultaneous requests both pass the check
    const n = schedule.uploadsPerDay || 1
    const joinedAt = new Date()

    let created
    try {
      created = await prisma.$transaction(async (tx) => {
        // Re-check inside transaction — eliminates TOCTOU race
        const alreadyJoined = await tx.campaignEnrollment.findFirst({
          where: { userId: req.user.userId, scheduleId: req.params.id }
        })
        if (alreadyJoined) {
          throw Object.assign(new Error('ALREADY_JOINED'), { code: 'ALREADY_JOINED' })
        }
        const slots = []
        for (let i = 1; i <= n; i++) {
          slots.push(
            tx.campaignEnrollment.create({
              data: {
                userId:       req.user.userId,
                scheduleId:   req.params.id,
                dayNumber:    i,
                status:       'not_uploaded',
                screenshotUrl: null,
                joinedAt,
                submittedAt:  null,
                rejectReason: null,
                reviewedAt:   null,
              }
            })
          )
        }
        return Promise.all(slots)
      })
    } catch (txErr) {
      if (txErr.code === 'ALREADY_JOINED') {
        return res.status(400).json({ error: 'You have already joined this campaign' })
      }
      throw txErr
    }

    // Activity feed
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }, select: { name: true }
    })
    await prisma.activityFeed.create({
      data: {
        type:        'campaign_join',
        userId:      req.user.userId,
        userName:    user?.name || 'Partner',
        description: `${user?.name || 'Partner'} joined campaign: ${schedule.name}`,
        amount:      null
      }
    })

    res.json({
      success:     true,
      enrollments: created.map(withProofNumber),
      joinedAt
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: GET MY ENROLLMENTS FOR A CAMPAIGN ────────────────
// Returns per-slot detail needed by the campaign detail page.
// dayNumber is exposed as proofNumber.
router.get('/:id/my-enrollments', auth, async (req, res) => {
  try {
    const enrollments = await prisma.campaignEnrollment.findMany({
      where:   { userId: req.user.userId, scheduleId: req.params.id },
      orderBy: { dayNumber: 'asc' }
    })
    res.json(enrollments.map(withProofNumber))
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: SUBMIT / RE-SUBMIT PROOF ────────────────────────
// Extended: updates existing not_uploaded or rejected slot first.
// Fallback: creates new row for backward compatibility.
// submittedAt is set HERE only — never at join time.
router.post('/:id/submit', auth, async (req, res) => {
  try {
    const { dayNumber, screenshotUrl } = req.body

    // Validate campaign is still active
    const schedule = await prisma.campaignSchedule.findUnique({
      where: { id: req.params.id }
    })
    if (!schedule) {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    if (!schedule.isActive) {
      return res.status(400).json({ error: 'Campaign is not active' })
    }
    if (schedule.endDate && schedule.endDate < new Date()) {
      return res.status(400).json({ error: 'Campaign has ended' })
    }

    // Validate proof number and screenshot
    const parsedDayNumber = parseInt(dayNumber)
    if (!parsedDayNumber || parsedDayNumber < 1) {
      return res.status(400).json({ error: 'Invalid proof number' })
    }
    if (!screenshotUrl || !screenshotUrl.trim()) {
      return res.status(400).json({ error: 'Screenshot is required' })
    }

    // Find existing slot (not_uploaded or rejected) — this is the primary path
    const existingSlot = await prisma.campaignEnrollment.findFirst({
      where: {
        userId:    req.user.userId,
        scheduleId: req.params.id,
        dayNumber: parseInt(dayNumber) || 1,
        status:    { in: ['not_uploaded', 'rejected'] }
      }
    })

    let enrollment

    if (existingSlot) {
      // Update existing slot — submittedAt set here for the first time
      enrollment = await prisma.campaignEnrollment.update({
        where: { id: existingSlot.id },
        data:  {
          screenshotUrl,
          status:      'pending',
          submittedAt: new Date(),   // proof upload timestamp
          rejectReason: null,        // clear previous rejection reason
        }
      })
    } else {
      // Fallback: create new row (backward compat for pre-join-flow submissions)
      enrollment = await prisma.campaignEnrollment.create({
        data: {
          userId:       req.user.userId,
          scheduleId:   req.params.id,
          dayNumber:    parseInt(dayNumber) || 1,
          screenshotUrl,
          status:       'pending',
          submittedAt:  new Date(),
        }
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId }, select: { name: true }
    })
    await prisma.activityFeed.create({
      data: {
        type:        'campaign_run',
        userId:      req.user.userId,
        userName:    user?.name || 'Partner',
        description: `${user?.name || 'Partner'} submitted proof ${dayNumber} for ${schedule.name}`,
        amount:      null
      }
    })

    res.json({ success: true, enrollment: withProofNumber(enrollment) })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: APPROVE ENROLLMENT ─────────────────────────────────
// Fixed: reward released ONLY when ALL required proofs are approved.
// Idempotent: checks Transaction.referenceId before crediting.
router.post('/enrollment/:id/approve', adminAuth, async (req, res) => {
  try {
    // Step 1: approve this enrollment
    const enrollment = await prisma.campaignEnrollment.update({
      where:   { id: req.params.id },
      data:    { status: 'approved', reviewedAt: new Date() },
      include: { schedule: true, user: true }
    })

    // Step 2: check if ALL slots for this (userId, scheduleId) are approved
    const allSlots = await prisma.campaignEnrollment.findMany({
      where: { userId: enrollment.userId, scheduleId: enrollment.scheduleId }
    })
    // Use configured proof count as source of truth; fall back to slot count
    // for legacy campaigns created before the join flow existed
    const configuredRequired = enrollment.schedule.uploadsPerDay || 0
    const totalRequired = configuredRequired > 0 ? configuredRequired : allSlots.length
    const totalApproved = allSlots.filter(e => e.status === 'approved').length

    if (totalApproved < totalRequired) {
      // Not all proofs approved yet — return without crediting
      return res.json({ success: true, enrollment: withProofNumber(enrollment), rewarded: false })
    }

    // Step 3: all proofs approved — idempotency check
    const existingReward = await prisma.transaction.findFirst({
      where: {
        userId:      enrollment.userId,
        type:        'campaign_reward',
        referenceId: enrollment.scheduleId
      }
    })

    if (existingReward) {
      // Already credited — return success without double-crediting
      return res.json({ success: true, enrollment: withProofNumber(enrollment), rewarded: false, idempotent: true })
    }

    // Step 4: credit full reward exactly once — wrapped in a transaction
    const reward = enrollment.schedule.rewardAmt

    // Build commission chain before transaction (read-only, safe outside)
    const LEVEL_CREDITS = [100, 20, 15, 15, 20, 30, 50]
    const commissionOps = []
    let currentUserId = enrollment.userId
    for (let level = 0; level < 7; level++) {
      const current = await prisma.user.findUnique({ where: { id: currentUserId } })
      if (!current?.uplineId) break
      commissionOps.push({ uplineId: current.uplineId, level })
      currentUserId = current.uplineId
    }

    // All writes succeed or fail together
    await prisma.$transaction([
      prisma.earningsWallet.update({
        where: { userId: enrollment.userId },
        data:  { balance: { increment: reward }, lifetime: { increment: reward } }
      }),
      prisma.transaction.create({
        data: {
          userId:      enrollment.userId,
          type:        'campaign_reward',
          referenceId: enrollment.scheduleId,
          amount:      reward,
          description: `${enrollment.schedule.name} — all proofs approved`
        }
      }),
      prisma.activityFeed.create({
        data: {
          type:        'reward',
          userId:      enrollment.userId,
          userName:    enrollment.user.name || 'Partner',
          description: `${enrollment.user.name || 'Partner'} earned ₹${reward} from ${enrollment.schedule.name}`,
          amount:      reward
        }
      }),
      ...commissionOps.map(({ uplineId, level }) =>
        prisma.runCredit.create({
          data: {
            userId:       uplineId,
            tier:         level + 1,
            amount:       LEVEL_CREDITS[level],
            sourceUserId: enrollment.userId,
            sourceLevel:  level + 1
          }
        })
      )
    ])

    res.json({ success: true, enrollment: withProofNumber(enrollment), rewarded: true, amount: reward })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: REJECT ENROLLMENT ──────────────────────────────────
// Extended: saves mandatory rejection reason.
router.post('/enrollment/:id/reject', adminAuth, async (req, res) => {
  try {
    const { reason } = req.body
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Rejection reason is required' })
    }

    const enrollment = await prisma.campaignEnrollment.update({
      where: { id: req.params.id },
      data:  {
        status:       'rejected',
        reviewedAt:   new Date(),
        rejectReason: reason.trim()
      }
    })
    res.json({ success: true, enrollment: withProofNumber(enrollment) })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: GET ALL PENDING ENROLLMENTS ────────────────────────
router.get('/enrollments/pending', adminAuth, async (req, res) => {
  try {
    const enrollments = await prisma.campaignEnrollment.findMany({
      where:   { status: 'pending' },
      include: { user: true, schedule: true },
      orderBy: { submittedAt: 'desc' }
    })
    res.json(enrollments.map(withProofNumber))
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PARTNER: GET MY RUN CREDITS ───────────────────────────────
router.get('/my-credits', auth, async (req, res) => {
  try {
    const credits = await prisma.runCredit.findMany({
      where:   { userId: req.user.userId },
      orderBy: { createdAt: 'desc' }
    })

    const summary = {}
    credits.forEach(c => {
      if (!summary[c.tier]) summary[c.tier] = { tier: c.tier, amount: c.amount, total: 0, used: 0, available: 0 }
      summary[c.tier].total++
      if (c.used) summary[c.tier].used++
      else        summary[c.tier].available++
    })

    res.json({ credits, summary: Object.values(summary) })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
