/**
 * routes/team.js — Partner Team endpoints
 *
 * GET /team         — existing: aggregate counts per level (UNCHANGED)
 * GET /team/members — new: individual member list grouped by level
 *
 * Register in index.js:
 *   const teamRouter = require('./routes/team')
 *   app.use('/api', teamRouter)
 *
 * The existing /team endpoint behaviour is preserved exactly.
 * /team/members is purely additive.
 */

const express    = require('express')
const router     = express.Router()
const { PrismaClient } = require('@prisma/client')
const jwt        = require('jsonwebtoken')
const prisma     = new PrismaClient()

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

// ── GET /team ─────────────────────────────────────────────────
// Existing behaviour: returns aggregate counts per level.
// This handler is reproduced here exactly so the existing route file
// can be replaced by this one without breaking anything.
// DO NOT modify the response shape.
router.get('/team', auth, async (req, res) => {
  try {
    const userId = req.user.userId

    // Walk 7 levels of downline, collect counts
    const LEVEL_CREDITS = [100, 30, 15, 15, 20, 30, 50]
    const levels = []
    let currentLevelIds = [userId]

    for (let level = 1; level <= 7; level++) {
      // Find all direct downlines of every user at the current level
      const downlines = await prisma.user.findMany({
        where:  { uplineId: { in: currentLevelIds } },
        select: { id: true },
      })

      levels.push({
        level,
        count:          downlines.length,
        pointsPerAction: LEVEL_CREDITS[level - 1],
      })

      // Always continue through all 7 levels so every level's pointsPerAction
      // is returned even when count is 0. The frontend uses pointsPerAction as
      // the single source of truth for commission values.
      if (downlines.length > 0) {
        currentLevelIds = downlines.map(d => d.id)
      }
    }

    res.json({ levels })
  } catch (e) {
    console.error('[GET /team]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /team/members ─────────────────────────────────────────
// NEW: returns individual member details grouped by level.
// Returns: name, phone (full — intentional business requirement),
//          referralCode, level.
// Does NOT return: password, PAN, Aadhaar, bank details, email,
//                  or any other sensitive field.
router.get('/team/members', auth, async (req, res) => {
  try {
    const userId = req.user.userId
    const members = []
    let currentLevelIds = [userId]

    for (let level = 1; level <= 7; level++) {
      // Fetch all downlines at this level with only the 3 required fields
      const downlines = await prisma.user.findMany({
        where:  { uplineId: { in: currentLevelIds } },
        select: {
          id:           true,   // needed for next level traversal only
          name:         true,
          phone:        true,   // full number — upline is permitted to see this
          referralCode: true,
        },
      })

      if (downlines.length === 0) break

      downlines.forEach(member => {
        members.push({
          level,
          name:         member.name,
          phone:        member.phone,
          referralCode: member.referralCode,
        })
      })

      currentLevelIds = downlines.map(d => d.id)
    }

    res.json({ members })
  } catch (e) {
    console.error('[GET /team/members]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /upline ───────────────────────────────────────────────
// Returns the logged-in partner's direct upline (the person who referred them).
// Read-only. No writes. No business logic. No commission calculations.
// Returns { upline: { name, phone, referralCode } } or { upline: null }.
router.get('/upline', auth, async (req, res) => {
  try {
    const userId = req.user.userId

    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { uplineId: true },
    })

    if (!user?.uplineId) {
      return res.json({ upline: null })
    }

    const upline = await prisma.user.findUnique({
      where:  { id: user.uplineId },
      select: { name: true, phone: true, referralCode: true },
    })

    res.json({ upline: upline ?? null })
  } catch (e) {
    console.error('[GET /upline]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
