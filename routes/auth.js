const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const jwt = require('jsonwebtoken')
const prisma = new PrismaClient()

// Generate 6 digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// Generate unique referral code
function generateReferralCode() {
  return 'P-' + Math.random().toString(36).substring(2, 6).toUpperCase()
}

// SEND OTP
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'Phone required' })

  const code = generateOTP()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 mins

  await prisma.oTP.create({
    data: { phone, code, expiresAt }
  })

  // In production replace with MSG91
  console.log(`OTP for ${phone}: ${code}`)

  res.json({ success: true, message: 'OTP sent', otp: code }) // Remove otp in production
})

// VERIFY OTP + LOGIN or REGISTER
router.post('/verify-otp', async (req, res) => {
  const { phone, code, name, referralCode } = req.body

  const otp = await prisma.oTP.findFirst({
    where: { phone, code, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  })

  if (!otp) return res.status(400).json({ error: 'Invalid or expired OTP' })

  // Mark OTP as used
  await prisma.oTP.update({ where: { id: otp.id }, data: { used: true } })

  // Check if user exists
  let user = await prisma.user.findUnique({ where: { phone } })

  if (!user) {
    // Find upline if referral code provided
    let uplineId = null
    if (referralCode) {
      const upline = await prisma.user.findUnique({ where: { referralCode } })
      if (upline) uplineId = upline.id
    }

    // Create new user
    user = await prisma.user.create({
      data: {
        name: name || 'Partner',
        phone,
        referralCode: generateReferralCode(),
        uplineId,
        pointsWallet: { create: { balance: 0, lifetime: 0 } },
        earningsWallet: { create: { balance: 0, lifetime: 0 } }
      },
      include: { pointsWallet: true, earningsWallet: true }
    })
  }

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  )

  res.json({ success: true, token, user })
})

// GET PROFILE
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { pointsWallet: true, earningsWallet: true }
    })
    res.json(user)
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})
// CHECK REFERRAL CODE
router.post('/check-referral', async (req, res) => {
  const { referralCode } = req.body
  if (!referralCode) return res.status(400).json({ error: 'Required' })
  const user = await prisma.user.findUnique({
    where: { referralCode: referralCode.toUpperCase() },
    select: { id: true, name: true, referralCode: true }
  })
  if (!user) return res.status(404).json({ error: 'Code not found' })
  res.json({ user })
})

// UPDATE PROFILE
router.post('/update-profile', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET)
    const { name } = req.body
    const user = await prisma.user.update({
      where: { id: decoded.userId },
      data: { name: name || 'Partner' }
    })
    res.json({ success: true, user })
  } catch { res.status(401).json({ error: 'Invalid token' }) }
})
// CHECK REFERRAL CODE
router.post('/check-referral', async (req, res) => {
  try {
    const { referralCode } = req.body
    if (!referralCode) return res.status(400).json({ error: 'Required' })
    const user = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase() },
      select: { id: true, name: true, referralCode: true }
    })
    if (!user) return res.status(404).json({ error: 'Code not found' })
    res.json({ user })
  } catch(e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// UPDATE PROFILE
router.post('/update-profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET)
    const { name } = req.body
    const user = await prisma.user.update({
      where: { id: decoded.userId },
      data: { name: name || 'Partner' }
    })
    res.json({ success: true, user })
  } catch(e) {
    res.status(500).json({ error: 'Server error' })
  }
})
module.exports = router