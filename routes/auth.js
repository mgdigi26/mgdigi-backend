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


const { activateMembership } = require('../services/membershipService')

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
    const isNewUser = !user

    if (isNewUser) {
      // ── NEW REGISTRATION ─────────────────────────────────────
      // Create user with PENDING status. Do NOT issue a login token yet.
      // The frontend will continue the registration flow:
      //   Profile → Password → Payment → submit-payment
      // The token returned here is a registration-only token.
      // login() / AuthContext are NOT called until REG_SUCCESS.
      let uplineId = null
      if (referralCode) {
        const upline = await prisma.user.findUnique({
          where: { referralCode: referralCode.toUpperCase() }
        })
        if (upline) uplineId = upline.id
      }

      user = await prisma.user.create({
        data: {
          name:             name || 'Partner',
          phone,
          referralCode:     generateReferralCode(),
          uplineId,
          membershipStatus: 'PENDING',
          feePaid:          false,
          pointsWallet:   { create: { balance: 0, lifetime: 0 } },
          earningsWallet: { create: { balance: 0, lifetime: 0 } }
        }
      })

      // Rewards are NOT credited at registration.
      // They are credited when membership is activated via activateMembership().

    } else {
      // ── EXISTING USER — OTP verified ──────────────────────────
      // Three sub-states for PENDING users:
      //
      //   State 1: Registration incomplete (no ManualPayment record yet)
      //            → Issue token so the frontend can resume from Profile/Password/Payment.
      //            → Do NOT return membershipPending.
      //
      //   State 2: Payment submitted (ManualPayment record exists)
      //            → Registration complete, waiting for admin approval.
      //            → Return membershipPending: true → frontend → /membership-pending.
      //
      //   State 3: membershipStatus is not PENDING (active / inactive / null)
      //            → Normal login. Pass through.
      //
      // Backward compatibility: legacy users with null/inactive/active pass through
      // without interruption regardless of ManualPayment records.
      if (user.membershipStatus === 'PENDING') {
        const hasSubmittedPayment = await prisma.manualPayment.findFirst({
          where: { userId: user.id }
        })

        if (hasSubmittedPayment) {
          // State 2 — payment submitted, awaiting admin approval
          return res.status(403).json({
            error: 'Your membership has not been activated yet. Please complete payment or contact the administrator.',
            membershipPending: true
          })
        }
        // State 1 — registration incomplete, no payment submitted yet
        // Fall through to token issuance so frontend can resume registration.
      }
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

    // Block login ONLY for users explicitly created with membershipStatus = 'PENDING'.
    // Existing users (null / 'inactive' / 'active' / any other value) pass through
    // without interruption — backward compatibility for all live users is preserved.
    if (user.membershipStatus === 'PENDING') {
      return res.status(403).json({
        error: 'Your membership has not been activated yet. Please complete payment or contact the administrator.',
        membershipPending: true
      })
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

    // Block password reset ONLY for users explicitly created with membershipStatus = 'PENDING'.
    // Existing users (null / 'inactive' / 'active' / any other value) pass through
    // without interruption — backward compatibility for all live users is preserved.
    if (user.membershipStatus === 'PENDING') {
      return res.status(403).json({
        error: 'Your membership has not been activated yet. Please complete payment or contact the administrator.',
        membershipPending: true
      })
    }

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

// ── ADMIN: ACTIVATE MEMBERSHIP ────────────────────────────────
// POST /admin/activate/:id
// Admin-only. Calls activateMembership(userId) for a PENDING partner.
// Safe to call on already-active users — activateMembership() returns early.
router.post('/admin/activate/:id', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admins only' })

    const result = await activateMembership(req.params.id)

    if (result.alreadyActive) {
      return res.json({ success: true, message: 'Membership was already active' })
    }

    // Mark the latest pending payment as APPROVED (Issue 6: only if one exists)
    // This does not affect activation — activation is already complete above.
    try {
      const pendingPayment = await prisma.manualPayment.findFirst({
        where:   { userId: req.params.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      })
      if (pendingPayment) {
        await prisma.manualPayment.update({
          where: { id: pendingPayment.id },
          data: {
            status:     'APPROVED',
            verifiedAt: new Date(),
            verifiedBy: decoded.userId,
          }
        })
      }
    } catch (paymentUpdateErr) {
      // Non-fatal — activation succeeded, payment record update is best-effort
      console.error('[admin/activate] payment record update failed (non-fatal):', paymentUpdateErr.message)
    }

    res.json({ success: true, message: 'Membership activated successfully' })
  } catch (e) {
    console.error('[admin/activate/:id]', e)
    res.status(500).json({ error: e.message || 'Server error' })
  }
})

// ── SUBMIT MANUAL PAYMENT ─────────────────────────────────────
// POST /auth/submit-payment
// Partner submits proof of manual payment (UPI/bank transfer).
// Saves a ManualPayment record with PENDING status.
// Does NOT activate membership — admin must approve manually via
// POST /admin/activate/:id after verifying the payment.
router.post('/submit-payment', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })

    const { referenceNo, screenshotUrl, amount } = req.body

    if (!referenceNo || !referenceNo.toString().trim()) {
      return res.status(400).json({ error: 'Payment reference number is required' })
    }

    // Check user exists and is still PENDING
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    if (user.membershipStatus !== 'PENDING') {
      return res.json({ success: true, message: 'Membership is already active or under review' })
    }

    // Upsert: update existing PENDING record if one exists, else create.
    // This prevents duplicate payment records for the same user.
    const existingPayment = await prisma.manualPayment.findFirst({
      where: { userId: decoded.userId, status: 'PENDING' }
    })

    if (existingPayment) {
      // Update existing record with new details
      await prisma.manualPayment.update({
        where: { id: existingPayment.id },
        data: {
          referenceNo:   referenceNo.toString().trim(),
          screenshotUrl: screenshotUrl || existingPayment.screenshotUrl,
          amount:        amount || 599,
          paymentMethod: 'MANUAL',
        }
      })
    } else {
      // Create first-time record
      await prisma.manualPayment.create({
        data: {
          userId:        decoded.userId,
          referenceNo:   referenceNo.toString().trim(),
          screenshotUrl: screenshotUrl || null,
          amount:        amount || 599,
          paymentMethod: 'MANUAL',
          status:        'PENDING',
        }
      })
    }

    res.json({ success: true, message: 'Payment submitted successfully. Your membership will be activated after verification.' })
  } catch (e) {
    console.error('[submit-payment]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET PAYMENT STATUS ─────────────────────────────────────────
// GET /auth/payment-status
// Returns the partner's latest manual payment record.
// Used by MembershipPendingPage to display payment details.
// Read-only. No writes. No business logic.
router.get('/payment-status', async (req, res) => {
  try {
    const decoded = verifyToken(req)
    if (!decoded) return res.status(401).json({ error: 'Unauthorized' })

    const payment = await prisma.manualPayment.findFirst({
      where:   { userId: decoded.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        referenceNo:   true,
        amount:        true,
        paymentMethod: true,
        status:        true,
        createdAt:     true,
        verifiedAt:    true,
      }
    })

    res.json({ payment: payment ?? null })
  } catch (e) {
    console.error('[payment-status]', e)
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
