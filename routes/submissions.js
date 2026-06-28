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
  const { campaignId, remarks } = req.body
  const submission = await prisma.submission.create({
    data: {
      userId: req.user.userId,
      campaignId,
      remarks,
      status: 'pending'
    }
  })
  res.json({ success: true, submission })
})

router.get('/', auth, async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { userId: req.user.userId },
    include: { campaign: true },
    orderBy: { submittedAt: 'desc' }
  })
  res.json(submissions)
})

module.exports = router