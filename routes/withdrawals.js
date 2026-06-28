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

router.post('/', auth, async (req, res) => {
  const earnings = await prisma.earningsWallet.findUnique({
    where: { userId: req.user.userId }
  })
  if (!earnings || earnings.balance < 6000) {
    return res.status(400).json({ error: 'Minimum balance of ₹6,000 required' })
  }
  const gross = earnings.balance
  const adminCharge = gross * 0.10
  const tdsDeduction = gross * 0.05
  const netAmount = gross - adminCharge - tdsDeduction

  const withdrawal = await prisma.withdrawal.create({
    data: {
      userId: req.user.userId,
      grossAmount: gross,
      adminCharge,
      tdsDeduction,
      netAmount,
      status: 'pending'
    }
  })
  res.json({ success: true, withdrawal })
})

router.get('/', auth, async (req, res) => {
  const withdrawals = await prisma.withdrawal.findMany({
    where: { userId: req.user.userId },
    orderBy: { requestedAt: 'desc' }
  })
  res.json(withdrawals)
})

module.exports = router