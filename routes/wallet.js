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
  const points = await prisma.pointsWallet.findUnique({
    where: { userId: req.user.userId }
  })
  const earnings = await prisma.earningsWallet.findUnique({
    where: { userId: req.user.userId }
  })
  const transactions = await prisma.transaction.findMany({
    where: { userId: req.user.userId },
    orderBy: { createdAt: 'desc' },
    take: 20
  })
  res.json({ points, earnings, transactions })
})

module.exports = router