/**
 * routes/payment.js — Razorpay payment routes
 *
 * Phase 1: Order creation only.
 * Phase 2 (future): POST /payment/verify — signature verification + activateMembership()
 * Phase 3 (future): POST /payment/webhook — Razorpay webhook handler
 *
 * Register in index.js:
 *   const paymentRouter = require('./routes/payment')
 *   app.use('/api', paymentRouter)
 *
 * Required environment variables:
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 */

const express  = require('express')
const router   = express.Router()
const Razorpay = require('razorpay')
const jwt      = require('jsonwebtoken')
const crypto   = require('crypto')

// ── Razorpay client ───────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// ── Auth middleware — same pattern as routes/team.js and routes/upload.js ──
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

// ── POST /payment/create-order ────────────────────────────────
/**
 * Creates a Razorpay order for the membership fee.
 * Returns the order details needed by the frontend Razorpay Checkout.
 *
 * Does NOT write to the database.
 * Does NOT activate membership.
 * Does NOT verify payment.
 *
 * Request:  (authenticated — Bearer token)
 * Response: { success, orderId, amount, currency, keyId }
 */
router.post('/payment/create-order', auth, async (req, res) => {
  try {
    const MEMBERSHIP_FEE_PAISE = 59900   // ₹599 in paise (Razorpay uses smallest currency unit)

    const order = await razorpay.orders.create({
      amount:   MEMBERSHIP_FEE_PAISE,
      currency: 'INR',
      receipt:  `membership_${req.user.userId}_${Date.now()}`,
      notes: {
        userId:  req.user.userId,
        purpose: 'MGdigi Membership Activation',
      },
    })

    res.json({
      success:  true,
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,
    })
  } catch (e) {
    console.error('[payment/create-order]', e)
    res.status(500).json({ error: 'Could not create payment order. Please try again.' })
  }
})

// ── POST /payment/verify ──────────────────────────────────────
/**
 * Phase 2A — Verify Razorpay payment signature.
 * Validates the HMAC-SHA256 signature exactly as required by Razorpay.
 *
 * Receives:  { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 * Returns:   { success: true }  on valid signature
 * Returns:   HTTP 400           on invalid signature
 *
 * Does NOT activate membership.
 * Does NOT update the database.
 * Does NOT save payment IDs.
 * Does NOT create transactions.
 * Does NOT update wallets or user records.
 */
router.post('/payment/verify', auth, (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification fields' })
    }

    // Razorpay signature verification:
    // Expected signature = HMAC-SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
    const body      = razorpay_order_id + '|' + razorpay_payment_id
    const expected  = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex')

    // Constant-time comparison to prevent timing attacks
    const sigBuffer      = Buffer.from(razorpay_signature, 'hex')
    const expectedBuffer = Buffer.from(expected, 'hex')

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return res.status(400).json({ error: 'Payment verification failed. Invalid signature.' })
    }

    res.json({ success: true })
  } catch (e) {
    console.error('[payment/verify]', e)
    res.status(500).json({ error: 'Server error during payment verification.' })
  }
})

module.exports = router
