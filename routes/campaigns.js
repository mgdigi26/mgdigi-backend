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
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    include: { pointsWallet: true }
  })
  const campaigns = await prisma.campaign.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' }
  })
  const userPoints = user.pointsWallet?.balance || 0
  const result = campaigns.map(c => ({
    ...c,
    eligible: userPoints >= c.pointsReq
  }))
  res.json({ campaigns: result, userPoints })
})

module.exports = router