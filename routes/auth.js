const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const prisma = new PrismaClient()

// Run-credit amounts per level (L1=100, L2=20, L3=15, L4=15, L5=20, L6=30, L7=50)
const LEVEL_CREDITS = [100, 30, 15, 15, 20, 30, 50]

const BCRYPT_ROUNDS = 10

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function generateReferralCode() {
  return 'P-' + Math.random().toString(36).substring(2, 6).toUpperCase()
}

/** Verify JWT from Authorization header. Returns decoded payload or null. */
function verifyToken(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return null
    return jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return null
  }
}

// ── SEND OTP ──────────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: 'Phone required' })
    const code = generateOTP()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await prisma.oTP.create({ data: { phone, code, expiresAt } })
    console.log(`OTP for ${phone}: ${code}`)
    res.json({ success: true, message: 'OTP sent', otp: code })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── VERIFY OTP + REGISTER / LOGIN ────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code, name, referralCode } = req.body

    const otp = await prisma.oTP.findFirst({
      where: { phone, code, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }
    })
    if (!otp) return res.status(400).json({ error: 'Invalid or expired OTP' })
    await prisma.oTP.update({ where: { id: otp.id }, data: { used: true } })

    let user = await prisma.user.findUnique({ where: { phone } })

    if (!user) {
      let uplineId = null
      if (referralCode) {
        const upline = await prisma.user.findUnique({
          where: { referralCode: referralCode.toUpperCase() }
        })
        if (upline) uplineId = upline.id
      }

      user = await prisma.user.create({
        data: {
          name: name || 'Partner',
          phone,
          referralCode: generateReferralCode(),
          uplineId,
          pointsWallet:   { create: { balance: 0, lifetime: 0 } },
          earningsWallet: { create: { balance: 0, lifetime: 0 } }
        }
      })

      // ── MARKETING POINTS: credit upline immediately on registration ─────
      // Walk 7 upline levels and increment PointsWallet.balance + lifetime.
      // Idempotency: skip if a Transaction (type=referral_join, referenceId=user.id)
      // already exists for this upline — prevents double-credit on retries.
      // RunCredit creation (below) is completely unchanged.
      let mpCurrentUser = user
      for (let mpLevel = 0; mpLevel < 7; mpLevel++) {
        const mpCurrent = await prisma.user.findUnique({ where: { id: mpCurrentUser.id } })
        if (!mpCurrent?.uplineId) break

        const mpPoints = LEVEL_CREDITS[mpLevel]

        // Idempotency check — one reward per registration per upline level
        const alreadyRewarded = await prisma.transaction.findFirst({
          where: {
            userId:      mpCurrent.uplineId,
            type:        'referral_join',
            referenceId: user.id,
          }
        })

        if (!alreadyRewarded) {
          // Wallet update + audit transaction are atomic — either both succeed or both roll back.
          // This prevents partial writes (wallet credited without a transaction record, or vice versa).
          await prisma.$transaction([
            prisma.pointsWallet.update({
              where: { userId: mpCurrent.uplineId },
              data:  { balance: { increment: mpPoints }, lifetime: { increment: mpPoints } }
            }),
            prisma.transaction.create({
              data: {
                userId:      mpCurrent.uplineId,
                type:        'referral_join',
                referenceId: user.id,
                amount:      0,
                points:      mpPoints,
                description: `Referral bonus — ${user.name || 'New Partner'} joined (Level ${mpLevel + 1})`,
              }
            })
          ])
        }

        const mpUpline = await prisma.user.findUnique({ where: { id: mpCurrent.uplineId } })
        if (!mpUpline) break
        mpCurrentUser = mpUpline
      }
      // ── END Marketing Points block ────────────────────────────────────

      // Walk upline 7 levels and credit run-credits
      let currentUser = user
      for (let level = 0; level < 7; level++) {
        const current = await prisma.user.findUnique({ where: { id: currentUser.id } })
        if (!current?.uplineId) break
        const creditAmount = LEVEL_CREDITS[level]
        await prisma.runCredit.create({
          data: {
            userId:      current.uplineId,
            tier:        level + 1,
            amount:      creditAmount,
            sourceUserId: user.id,
            sourceLevel: level + 1
          }
        })
        await prisma.activityFeed.create({
          data: {
            type:        'join',
            userId:      user.id,
            userName:    user.name || 'New Partner',
            description: `${user.name || 'New Partner'} joined under Level ${level + 1}`,
            amount:      creditAmount
          }
        })
        const uplineUser = await prisma.user.findUnique({ where: { id: current.uplineId } })
        if (!uplineUser) break
        currentUser = uplineUser
      }

      await prisma.activityFeed.create({
        data: {
          type:        'join',
          userId:      user.id,
          userName:    user.name || 'New Partner',
          description: `${user.name || 'New Partner'} joined MGdigi`,
          amount:      null
        }
      })
    }

    // Update lastLoginAt — non-blocking audit field
    let updatedUser = user
    try {
      updatedUser = await prisma.user.update({
        where: { id: user.id },
        data:  { lastLoginAt: new Date() }
      })
    } catch (auditErr) {
      console.error('[verify-otp] lastLoginAt update failed (non-fatal):', auditErr.message)
    }

    const token = jwt.sign(
      { userId: updatedUser.id, role: updatedUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    )

    // Include hasPassword so frontend knows whether to show password setup
    res.json({ success: true, token, user: updatedUser, hasPassword: !!updatedUser.password })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET PROFILE ───────────────────────────────────────────────
// Returns only safe, non-sensitive profile fields required by the frontend.
// Sensitive fields (password, pan, aadhaar, bank, razorpay) excluded.
router.get('/me', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })
    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: {
        id:               true,
        name:             true,
        phone:            true,
        referralCode:     true,
        role:             true,
        isActive:         true,
        email:            true,
        dob:              true,
        address1:         true,
        address2:         true,
        city:             true,
        state:            true,
        pincode:          true,
        country:          true,
        profilePhoto:     true,
        membershipStatus: true,
        feePaid:          true,
        feePaidAt:        true,
        kycStatus:        true,
        lastLoginAt:      true,
        createdAt:        true,
        updatedAt:        true,
        pointsWallet:     true,
        earningsWallet:   true,
      }
    })
    res.json(user)
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

// ── CHECK REFERRAL CODE ───────────────────────────────────────
router.post('/check-referral', async (req, res) => {
  try {
    const { referralCode } = req.body
    if (!referralCode) return res.status(400).json({ error: 'Required' })
    const user = await prisma.user.findUnique({
      where:  { referralCode: referralCode.toUpperCase() },
      select: { id: true, name: true, referralCode: true }
    })
    if (!user) return res.status(404).json({ error: 'Code not found' })
    res.json({ user })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── UPDATE PROFILE ────────────────────────────────────────────
// Saves all supported profile fields. All fields optional — only
// provided fields are written. feePaid logic unchanged.
router.post('/update-profile', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })

    const {
      name, email, dob, address1, address2,
      city, state, pincode, country, profilePhoto
    } = req.body

    const updateData = {}
    if (name        && name.trim())  updateData.name        = name.trim()
    if (email       !== undefined)   updateData.email       = email || null
    if (dob         !== undefined)   updateData.dob         = dob ? new Date(dob + 'T00:00:00.000Z') : null
    if (address1    !== undefined)   updateData.address1    = address1 || null
    if (address2    !== undefined)   updateData.address2    = address2 || null
    if (city        !== undefined)   updateData.city        = city || null
    if (state       !== undefined)   updateData.state       = state || null
    if (pincode     !== undefined)   updateData.pincode     = pincode || null
    if (country     !== undefined)   updateData.country     = country || null
    if (profilePhoto !== undefined)  updateData.profilePhoto = profilePhoto || null

    if (!Object.keys(updateData).length) {
      const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
      return res.json({ success: true, user })
    }

    const user = await prisma.user.update({
      where: { id: decoded.userId },
      data:  updateData,
    })
    res.json({ success: true, user })
  } catch (e) {
    console.error('[update-profile] ERROR:', e.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── CHECK USER (exists + hasPassword) ────────────────────────
// Used by login screen to route: phone-only check before showing password field.
router.post('/check-user', async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: 'Phone required' })
    const user = await prisma.user.findUnique({
      where:  { phone },
      select: { id: true, password: true }
    })
    if (!user) {
      return res.json({ exists: false, hasPassword: false })
    }
    res.json({ exists: true, hasPassword: !!user.password })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── LOGIN WITH PASSWORD ───────────────────────────────────────
// Authenticates an existing user using phone + password.
router.post('/login-password', async (req, res) => {
  try {
    const { phone, password } = req.body
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password required' })
    }

    const user = await prisma.user.findUnique({ where: { phone } })

    // Generic error — do not reveal whether phone or password is wrong
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid mobile number or password' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid mobile number or password' })
    }

    // Update lastLoginAt — non-blocking audit field
    try {
      await prisma.user.update({
        where: { id: user.id },
        data:  { lastLoginAt: new Date() }
      })
    } catch (auditErr) {
      console.error('[login-password] lastLoginAt update failed (non-fatal):', auditErr.message)
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    )
    res.json({ success: true, token, user })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── SET PASSWORD (new registration) ──────────────────────────
// Called after OTP verification + profile completion during registration.
// Requires a valid Bearer token (issued by verify-otp).
router.post('/set-password', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })

    const { password } = req.body
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS)
    await prisma.user.update({
      where: { id: decoded.userId },
      data:  { password: hashed }
    })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── REQUEST PASSWORD RESET OTP ────────────────────────────────
// Sends OTP for the forgot-password flow.
// Only works for registered phone numbers.
router.post('/reset-password-otp', async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: 'Phone required' })

    const user = await prisma.user.findUnique({ where: { phone } })
    if (!user) {
      return res.status(404).json({ error: 'No account found for this number' })
    }

    const code = generateOTP()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await prisma.oTP.create({ data: { phone, code, expiresAt } })
    console.log(`Password reset OTP for ${phone}: ${code}`)
    res.json({ success: true, message: 'OTP sent', otp: code })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── RESET PASSWORD ────────────────────────────────────────────
// Verifies OTP and sets a new password. Returns a fresh token.
router.post('/reset-password', async (req, res) => {
  try {
    const { phone, code, password } = req.body
    if (!phone || !code || !password) {
      return res.status(400).json({ error: 'Phone, code, and password required' })
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    // Verify OTP
    const otp = await prisma.oTP.findFirst({
      where: { phone, code, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }
    })
    if (!otp) return res.status(400).json({ error: 'Invalid or expired OTP' })
    await prisma.oTP.update({ where: { id: otp.id }, data: { used: true } })

    // Find user
    const user = await prisma.user.findUnique({ where: { phone } })
    if (!user) return res.status(404).json({ error: 'Account not found' })

    // Hash and save new password
    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const updated = await prisma.user.update({
      where: { id: user.id },
      data:  { password: hashed }
    })

    // Issue a fresh token so user is logged in immediately
    const token = jwt.sign(
      { userId: updated.id, role: updated.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    )
    res.json({ success: true, token, user: updated })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: UPDATE PARTNER ─────────────────────────────────────
// PUT /admin/users/:id
// Admin-only. Editable fields: name, phone, uplineReferralCode.
// Partner's own referral code (referralCode) is NEVER editable.
// Partner Code (id) is NEVER editable.
// uplineReferralCode updates user.uplineId — changes future hierarchy only.
// Historical commissions, wallets, and rewards are never recalculated.
router.put('/admin/users/:id', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admins only' })

    const { id } = req.params
    const { name, phone, uplineReferralCode } = req.body

    // Target user must exist
    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) return res.status(404).json({ error: 'Partner not found' })

    const updateData = {}

    // ── Name ────────────────────────────────────────────────────
    if (name !== undefined) {
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name cannot be empty' })
      updateData.name = name.trim()
    }

    // ── Phone ────────────────────────────────────────────────────
    if (phone !== undefined) {
      const cleaned = phone.toString().trim()
      if (!/^[6-9]\d{9}$/.test(cleaned)) {
        return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' })
      }
      const existing = await prisma.user.findFirst({
        where: { phone: cleaned, id: { not: id } }
      })
      if (existing) return res.status(409).json({ error: 'Mobile number already registered to another partner' })
      updateData.phone = cleaned
    }

    // ── Upline (Referred By) ─────────────────────────────────────
    // uplineReferralCode is the referral code of the NEW upline.
    // Validates: exists, not self, no circular chain.
    // Only writes uplineId — never touches referralCode, wallets, or history.
    if (uplineReferralCode !== undefined) {
      const code = uplineReferralCode.toString().toUpperCase().trim()

      if (!code) return res.status(400).json({ error: 'Referred By code cannot be empty' })

      // Upline must exist
      const newUpline = await prisma.user.findUnique({ where: { referralCode: code } })
      if (!newUpline) return res.status(404).json({ error: 'Referral code not found. Please enter a valid upline code.' })

      // Cannot refer yourself
      if (newUpline.id === id) {
        return res.status(400).json({ error: 'A partner cannot be referred by themselves' })
      }

      // Circular chain check: walk the new upline's ancestry — if we find
      // the current user anywhere in the chain, this would create a loop.
      let cursor = newUpline
      let depth  = 0
      while (cursor.uplineId && depth < 8) {
        if (cursor.uplineId === id) {
          return res.status(400).json({ error: 'This would create a circular referral relationship' })
        }
        cursor = await prisma.user.findUnique({ where: { id: cursor.uplineId } })
        if (!cursor) break
        depth++
      }

      updateData.uplineId = newUpline.id
    }

    if (!Object.keys(updateData).length) {
      return res.status(400).json({ error: 'No valid fields provided' })
    }

    const updated = await prisma.user.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, name: true, phone: true, referralCode: true,
        uplineId: true, email: true, isActive: true, role: true, createdAt: true,
        pointsWallet:   { select: { balance: true } },
        earningsWallet: { select: { balance: true } },
      },
    })

    res.json({ success: true, user: updated })
  } catch (e) {
    console.error('[admin/users/:id PUT]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
