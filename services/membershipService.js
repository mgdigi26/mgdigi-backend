const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// Run-credit amounts per level (L1=100, L2=20, L3=15, L4=15, L5=20, L6=30, L7=50)
const LEVEL_CREDITS = [100, 30, 15, 15, 20, 30, 50]

// ── MEMBERSHIP ACTIVATION ─────────────────────────────────────
// This is the ONLY place where:
//   • membershipStatus is set to active
//   • Marketing Points are credited to uplines
//   • RunCredit records are created
//   • ActivityFeed entries are created
//   • Referral Join Transactions are created
//
// Called from:
//   • POST /admin/activate/:id   — manual activation by admin
//   • Future: Razorpay webhook    — no further code changes required
//
// Idempotency: Transaction.referenceId = user.id prevents
//              double-credit if called twice for the same user.
async function activateMembership(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('User not found: ' + userId)

  // Guard — already active users are skipped silently
  if (user.membershipStatus === 'active') return { alreadyActive: true }

  // 1. Mark membership active + feePaid
  await prisma.user.update({
    where: { id: userId },
    data: {
      membershipStatus: 'active',
      feePaid:          true,
      feePaidAt:        new Date(),
    }
  })

  // 2. Marketing Points: walk 7 upline levels
  let mpCurrentUser = user
  for (let mpLevel = 0; mpLevel < 7; mpLevel++) {
    const mpCurrent = await prisma.user.findUnique({ where: { id: mpCurrentUser.id } })
    if (!mpCurrent?.uplineId) break

    const mpPoints = LEVEL_CREDITS[mpLevel]

    // Idempotency check — one reward per activation per upline level
    const alreadyRewarded = await prisma.transaction.findFirst({
      where: {
        userId:      mpCurrent.uplineId,
        type:        'referral_join',
        referenceId: user.id,
      }
    })

    if (!alreadyRewarded) {
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
            description: `Referral bonus — ${user.name || 'New Partner'} activated (Level ${mpLevel + 1})`,
          }
        })
      ])
    }

    const mpUpline = await prisma.user.findUnique({ where: { id: mpCurrent.uplineId } })
    if (!mpUpline) break
    mpCurrentUser = mpUpline
  }

  // 3. RunCredits + ActivityFeed: walk 7 upline levels
  let currentUser = user
  for (let level = 0; level < 7; level++) {
    const current = await prisma.user.findUnique({ where: { id: currentUser.id } })
    if (!current?.uplineId) break
    const creditAmount = LEVEL_CREDITS[level]

    // Idempotency check — skip RunCredit if one already exists for this
    // userId + sourceUserId + tier combination. Prevents duplicates if
    // activateMembership() is called more than once for the same user.
    const existingRunCredit = await prisma.runCredit.findFirst({
      where: {
        userId:       current.uplineId,
        sourceUserId: user.id,
        tier:         level + 1,
      }
    })
    if (!existingRunCredit) {
      await prisma.runCredit.create({
        data: {
          userId:       current.uplineId,
          tier:         level + 1,
          amount:       creditAmount,
          sourceUserId: user.id,
          sourceLevel:  level + 1
        }
      })
    }

    await prisma.activityFeed.create({
      data: {
        type:        'join',
        userId:      user.id,
        userName:    user.name || 'New Partner',
        description: `${user.name || 'New Partner'} activated under Level ${level + 1}`,
        amount:      creditAmount
      }
    })
    const uplineUser = await prisma.user.findUnique({ where: { id: current.uplineId } })
    if (!uplineUser) break
    currentUser = uplineUser
  }

  // 4. ActivityFeed — self entry
  await prisma.activityFeed.create({
    data: {
      type:        'join',
      userId:      user.id,
      userName:    user.name || 'New Partner',
      description: `${user.name || 'New Partner'} joined MGdigi`,
      amount:      null
    }
  })

  return { activated: true }
}

module.exports = { activateMembership }
