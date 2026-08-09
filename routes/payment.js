/**
 * routes/payment.js — Cashfree Payment Gateway routes for MGdigi
 *
 * Cashfree flow:
 *   1. POST /payment/create-order -> Cashfree payment_session_id
 *   2. Frontend opens Cashfree Hosted Checkout
 *   3. POST /payment/verify -> backend fetches Cashfree order
 *   4. Only when order_status === PAID + user tag + amount match:
 *      activateMembership(userId)
 *
 * Required environment variables:
 *   CASHFREE_APP_ID
 *   CASHFREE_SECRET_KEY
 *   CASHFREE_ENV=sandbox | production
 *   CASHFREE_RETURN_URL (optional)
 */

const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const { randomUUID } = require('crypto')
const { PrismaClient } = require('@prisma/client')
const { activateMembership } = require('../services/membershipService')

const prisma = new PrismaClient()

const MEMBERSHIP_FEE = 599
const CASHFREE_API_VERSION = '2025-01-01'

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

function cashfreeBaseUrl() {
  return process.env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg'
}

function cashfreeHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-version': CASHFREE_API_VERSION,
    'x-client-id': process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
  }
}

function cashfreeConfigured() {
  return Boolean(
    process.env.CASHFREE_APP_ID &&
    process.env.CASHFREE_SECRET_KEY
  )
}

// ── POST /payment/create-order ─────────────────────────────────────────────
router.post('/payment/create-order', auth, async (req, res) => {
  try {
    if (!cashfreeConfigured()) {
      return res.status(500).json({
        success: false,
        error: 'Cashfree is not configured on the server.'
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, phone: true, email: true, membershipStatus: true }
    })

    if (!user) return res.status(404).json({ error: 'User not found.' })

    if (user.membershipStatus === 'active') {
      return res.status(409).json({ error: 'Membership is already active.' })
    }

    // Cashfree order IDs allow alphanumeric, '_' and '-'. Keep it short.
    const orderId = `mg_${user.id.replace(/-/g, '').slice(0, 16)}_${Date.now()}`

    const returnUrl =
      process.env.CASHFREE_RETURN_URL ||
      'https://mgdigi.in/?cashfree_order_id={order_id}'

    const customerPhone = String(user.phone || '').replace(/\D/g, '').slice(-10)
    if (customerPhone.length !== 10) {
      return res.status(400).json({ error: 'A valid 10-digit mobile number is required for payment.' })
    }

    const payload = {
      order_id: orderId,
      order_amount: MEMBERSHIP_FEE,
      order_currency: 'INR',
      customer_details: {
        customer_id: user.id,
        customer_name: user.name || 'MGdigi Partner',
        customer_phone: customerPhone,
        ...(user.email ? { customer_email: user.email } : {}),
      },
      order_meta: {
        return_url: returnUrl,
      },
      order_note: 'MGdigi Lifetime Membership Activation',
      order_tags: {
        user_id: user.id,
        purpose: 'MGDIGI_MEMBERSHIP',
      },
    }

    const response = await fetch(`${cashfreeBaseUrl()}/orders`, {
      method: 'POST',
      headers: {
        ...cashfreeHeaders(),
        'x-idempotency-key': randomUUID(),
      },
      body: JSON.stringify(payload),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      console.error('[cashfree/create-order]', response.status, data)
      return res.status(502).json({
        error: data?.message || data?.message_detail || 'Cashfree could not create the payment order.'
      })
    }

    res.json({
      success: true,
      orderId: data.order_id,
      paymentSessionId: data.payment_session_id,
      amount: data.order_amount,
      currency: data.order_currency,
    })
  } catch (e) {
    console.error('[cashfree/create-order]', e)
    res.status(500).json({ error: 'Could not create payment order. Please try again.' })
  }
})

// ── POST /payment/verify ───────────────────────────────────────────────────
// Never trust the browser's "success" response. Fetch the order from Cashfree.
router.post('/payment/verify', auth, async (req, res) => {
  try {
    if (!cashfreeConfigured()) {
      return res.status(500).json({ error: 'Cashfree is not configured on the server.' })
    }

    const { orderId } = req.body
    if (!orderId) {
      return res.status(400).json({ error: 'Cashfree order ID is required.' })
    }

    const response = await fetch(
      `${cashfreeBaseUrl()}/orders/${encodeURIComponent(orderId)}`,
      {
        method: 'GET',
        headers: cashfreeHeaders(),
      }
    )

    const order = await response.json().catch(() => ({}))

    if (!response.ok) {
      console.error('[cashfree/get-order]', response.status, order)
      return res.status(502).json({ error: 'Could not verify payment with Cashfree.' })
    }

    const taggedUserId = order?.order_tags?.user_id
    const amount = Number(order?.order_amount)
    const status = order?.order_status

    // Three independent checks before activation.
    if (taggedUserId !== req.user.userId) {
      return res.status(403).json({ error: 'Payment order does not belong to this account.' })
    }

    if (amount !== MEMBERSHIP_FEE) {
      return res.status(400).json({ error: 'Payment amount does not match the membership fee.' })
    }

    if (status !== 'PAID') {
      return res.status(400).json({
        success: false,
        activated: false,
        paymentStatus: status || 'UNKNOWN',
        error: 'Payment has not been confirmed as successful yet.'
      })
    }

    // Idempotent membership activation. This is the existing MGdigi business layer.
    const activation = await activateMembership(req.user.userId)

    res.json({
      success: true,
      activated: true,
      alreadyActive: Boolean(activation?.alreadyActive),
      paymentStatus: 'PAID',
      orderId,
    })
  } catch (e) {
    console.error('[cashfree/verify]', e)
    res.status(500).json({ error: 'Server error during payment verification.' })
  }
})

module.exports = router
