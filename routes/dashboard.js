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
    include: { pointsWallet: true, earningsWallet: true }
  })

  const teamCount = await prisma.user.count({
    where: { uplineId: req.user.userId }
  })

  const transactions = await prisma.transaction.findMany({
    where: { userId: req.user.userId },
    orderBy: { createdAt: 'desc' },
    take: 5
  })

  res.json({
    name: user.name,
    phone: user.phone,
    referralCode: user.referralCode,
    points: user.pointsWallet?.balance || 0,
    earnings: user.earningsWallet?.balance || 0,
    lifetimeEarnings: user.earningsWallet?.lifetime || 0,
    teamSize: teamCount,
    transactions
  })
})

module.exports = router