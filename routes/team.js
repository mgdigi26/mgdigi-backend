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

router.get('/', auth, async (req, res) => {
  const LEVEL_POINTS = [100, 30, 15, 15, 20, 30, 50]
  let levels = []
  let currentIds = [req.user.userId]

  for (let i = 0; i < 7; i++) {
    const members = await prisma.user.findMany({
      where: { uplineId: { in: currentIds } },
      select: { id: true, name: true, phone: true, createdAt: true }
    })
    if (members.length === 0) break
    levels.push({
      level: i + 1,
      count: members.length,
      pointsPerAction: LEVEL_POINTS[i],
      members
    })
    currentIds = members.map(m => m.id)
  }

  const totalTeam = levels.reduce((sum, l) => sum + l.count, 0)
  res.json({ levels, totalTeam })
})

module.exports = router