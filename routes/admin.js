const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const prisma = new PrismaClient();

const LEVEL_POINTS = [100, 30, 15, 15, 20, 30, 50];

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admins only" });
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Dashboard stats
router.get("/dashboard", auth, async (req, res) => {
  const totalPartners = await prisma.user.count({ where: { role: "partner" } });
  const pendingProofs = await prisma.submission.count({
    where: { status: "pending" },
  });
  const pendingWithdrawals = await prisma.withdrawal.count({
    where: { status: "pending" },
  });
  const totalCampaigns = await prisma.submission.count({
    where: { status: "approved" },
  });
  res.json({
    totalPartners,
    pendingProofs,
    pendingWithdrawals,
    totalCampaigns,
  });
});

// Get all pending proof submissions
router.get("/submissions", auth, async (req, res) => {
  try {
    const submissions = await prisma.campaignEnrollment.findMany({
      where: {
        status: "pending",
        screenshotUrl: {
          not: null,
        },
      },
      include: {
        user: true,
        schedule: true,
      },
      orderBy: {
        submittedAt: "desc",
      },
    });

    const formatted = submissions.map((item) => ({
      id: item.id,
      status: item.status,
      screenshotUrl: item.screenshotUrl,
      submittedAt: item.submittedAt,
      reviewedAt: item.reviewedAt,
      rejectReason: item.rejectReason,

      user: item.user,

      campaign: {
        id: item.schedule.id,
        name: item.schedule.name,
        type: item.schedule.type,
      },

      dayNumber: item.dayNumber,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Approve submission + trigger commissions
router.post("/submissions/:id/approve", auth, async (req, res) => {
  const submissionId = req.params.id;

  // ── Pre-flight: verify submission exists and fetch upline chain ─────────
  // This read happens outside the transaction to avoid holding a DB connection
  // during the upline traversal (up to 7 sequential queries).
  // Concurrency safety for the critical write is enforced inside the transaction.
  const preCheck = await prisma.campaignEnrollment.findUnique({
    where: { id: submissionId },
    include: { user: true, schedule: true },
  });

  if (!preCheck) {
    return res.status(404).json({ error: "Submission not found" });
  }

  // Early exit for the common non-concurrent case — avoids opening a transaction
  // for submissions that are clearly already processed.
  if (preCheck.status !== "pending") {
    return res.status(400).json({
      error: `Submission has already been ${preCheck.status}. Cannot approve again.`,
    });
  }

  // Build upline chain outside the transaction (read-only, no locks needed).
  const commissionOps = [];
  let currentUserId = preCheck.userId;
  for (let level = 0; level < 7; level++) {
    const currentUser = await prisma.user.findUnique({
      where: { id: currentUserId },
    });
    if (!currentUser?.uplineId) break;
    commissionOps.push({ uplineId: currentUser.uplineId, level });
    currentUserId = currentUser.uplineId;
  }

  // Snapshot values needed inside the transaction.
  const partnerUserId = preCheck.userId;
  const partnerName = preCheck.user.name;
  const scheduleName = preCheck.schedule.name;
  const rewardAmt = preCheck.schedule.rewardAmt;
  const pointsRequired = preCheck.schedule.pointsReq ?? 0;

  try {
    // ── Interactive transaction ────────────────────────────────────────────
    // Uses an async callback so we can perform conditional logic (status check,
    // balance check) inside the same database transaction context.
    // If any throw() is called, Prisma rolls back every write in this callback.
    const approvedEnrollment = await prisma.$transaction(async (tx) => {
      const now = new Date();

      // ── Step 1: Conditional status update ─────────────────────
      // updateMany with a status filter is the concurrency lock.
      // Only one concurrent request can satisfy { id, status: "pending" }.
      // The losing request gets count: 0 and the transaction is aborted.
      const statusUpdate = await tx.campaignEnrollment.updateMany({
        where: { id: submissionId, status: "pending" },
        data: { status: "approved", reviewedAt: now },
      });

      if (statusUpdate.count === 0) {
        // Another request already approved (or rejected) this submission.
        throw new Error("ALREADY_PROCESSED");
      }

      // ── Step 2: Re-read partner's PointsWallet inside the transaction ──
      // This read is now part of the same transaction snapshot, preventing
      // a concurrent approval from seeing a stale balance.
      const wallet = await tx.pointsWallet.findUnique({
        where: { userId: partnerUserId },
      });

      const currentBalance = wallet?.balance ?? 0;

      if (currentBalance < pointsRequired) {
        // Throws to roll back the status update above — nothing is committed.
        throw new Error("INSUFFICIENT_POINTS");
      }

      // ── Step 3: Deduct partner's Marketing Points (balance only) ──────
      await tx.pointsWallet.update({
        where: { userId: partnerUserId },
        data: { balance: { decrement: pointsRequired } },
      });

      // ── Step 4: Credit earnings reward to partner ─────────────
      await tx.earningsWallet.update({
        where: { userId: partnerUserId },
        data: {
          balance: { increment: rewardAmt },
          lifetime: { increment: rewardAmt },
        },
      });

      // ── Step 5: Campaign reward Transaction record ─────────────
      await tx.transaction.create({
        data: {
          userId: partnerUserId,
          type: "campaign_reward",
          amount: rewardAmt,
          points: 0,
          referenceId: submissionId,
          description: `${scheduleName} reward approved`,
        },
      });

      // ── Step 6: Marketing Points debit Transaction record ──────
      // points is negative to represent a deduction; amount stays 0.
      await tx.transaction.create({
        data: {
          userId: partnerUserId,
          type: "campaign_points_debit",
          amount: 0,
          points: -pointsRequired,
          referenceId: submissionId,
          description: `${scheduleName} campaign points deducted`,
        },
      });

      // ── Step 7: Upline commissions — balance + lifetime + Transaction ──
      // LEVEL_POINTS and commission logic are unchanged.
      for (const { uplineId, level } of commissionOps) {
        await tx.pointsWallet.update({
          where: { userId: uplineId },
          data: {
            balance: { increment: LEVEL_POINTS[level] },
            lifetime: { increment: LEVEL_POINTS[level] },
          },
        });

        await tx.transaction.create({
          data: {
            userId: uplineId,
            type: "referral_commission",
            amount: 0,
            points: LEVEL_POINTS[level],
            referenceId: submissionId,
            description: `Level ${level + 1} commission from ${partnerName}`,
          },
        });
      }

      // Return the fully-updated enrollment for the response.
      return tx.campaignEnrollment.findUnique({
        where: { id: submissionId },
        include: { user: true, schedule: true },
      });
    }); // end $transaction

    res.json({ success: true, submission: approvedEnrollment });
  } catch (e) {
    if (e.message === "ALREADY_PROCESSED") {
      return res.status(400).json({
        error: "Submission has already been processed. Cannot approve again.",
      });
    }
    if (e.message === "INSUFFICIENT_POINTS") {
      return res.status(400).json({
        error: "Insufficient marketing points to approve this campaign.",
        required: pointsRequired,
      });
    }
    console.error("[submissions/approve]", e);
    res.status(500).json({ error: "Server error during approval." });
  }
});

// Reject submission
router.post("/submissions/:id/reject", auth, async (req, res) => {
  const { reason } = req.body;
  const submission = await prisma.submission.update({
    where: { id: req.params.id },
    data: {
      status: "rejected",
      rejectReason: reason,
      reviewedBy: req.user.userId,
      reviewedAt: new Date(),
    },
  });
  res.json({ success: true, submission });
});

// Get all users
router.get("/users", auth, async (req, res) => {
  const users = await prisma.user.findMany({
    include: { pointsWallet: true, earningsWallet: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(users);
});

// Get pending withdrawals
router.get("/withdrawals", auth, async (req, res) => {
  const withdrawals = await prisma.withdrawal.findMany({
    where: { status: "pending" },
    include: { user: true },
    orderBy: { requestedAt: "desc" },
  });
  res.json(withdrawals);
});
router.put("/users/:id", auth, async (req, res) => {
  try {
    const { name, phone, uplineReferralCode } = req.body;

    // Check duplicate phone
    const existing = await prisma.user.findFirst({
      where: {
        phone,
        NOT: {
          id: req.params.id,
        },
      },
    });

    if (existing) {
      return res.status(400).json({
        error: "Phone number already exists",
      });
    }

    let data = {
      name,
      phone,
    };

    if (uplineReferralCode && uplineReferralCode.trim()) {
      const upline = await prisma.user.findUnique({
        where: {
          referralCode: uplineReferralCode.trim().toUpperCase(),
        },
      });

      if (!upline) {
        return res.status(400).json({
          error: "Invalid referral code",
        });
      }

      data.uplineId = upline.id;
    }

    const user = await prisma.user.update({
      where: {
        id: req.params.id,
      },
      data,
      include: {
        pointsWallet: true,
        earningsWallet: true,
      },
    });

    res.json({
      success: true,
      user,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Server error",
    });
  }
});
// Approve withdrawal
router.post("/withdrawals/:id/approve", auth, async (req, res) => {
  const withdrawalId = req.params.id;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock the withdrawal logically by changing only a pending record.
        // This prevents the same withdrawal from being approved twice.
        const statusUpdate = await tx.withdrawal.updateMany({
          where: {
            id: withdrawalId,
            status: "pending",
          },
          data: {
            status: "paid",
            paidAt: new Date(),
          },
        });

        if (statusUpdate.count === 0) {
          throw new Error("WITHDRAWAL_ALREADY_PROCESSED");
        }

        const withdrawal = await tx.withdrawal.findUnique({
          where: { id: withdrawalId },
        });

        if (!withdrawal) {
          throw new Error("WITHDRAWAL_NOT_FOUND");
        }

        // 1. Deduct the gross withdrawal amount from the partner's
        //    Earnings Wallet.
        await tx.earningsWallet.update({
          where: {
            userId: withdrawal.userId,
          },
          data: {
            balance: {
              decrement: withdrawal.grossAmount,
            },
          },
        });

        // Record the actual withdrawal payment.
        await tx.transaction.create({
          data: {
            userId: withdrawal.userId,
            type: "withdrawal_paid",
            amount: withdrawal.grossAmount,
            points: 0,
            referenceId: withdrawal.id,
            description: "Withdrawal approved and marked as paid",
          },
        });

        // ------------------------------------------------------------
        // ₹6,000 WITHDRAWAL CYCLE
        // ------------------------------------------------------------

        // Total amount of all paid withdrawals, including this one.
        const paidTotals = await tx.withdrawal.aggregate({
          where: {
            status: "paid",
          },
          _sum: {
            grossAmount: true,
          },
        });

        const totalPaidWithdrawals = Number(paidTotals._sum.grossAmount || 0);

        // Amount already consumed by completed ₹6,000 cycles.
        const cycleTotals = await tx.transaction.aggregate({
          where: {
            type: "withdrawal_cycle",
          },
          _sum: {
            amount: true,
          },
        });

        const totalConsumedByCycles = Number(cycleTotals._sum.amount || 0);

        const currentCycleAmount = totalPaidWithdrawals - totalConsumedByCycles;

        // Normally this will be 0 or 1 because individual withdrawals
        // cannot exceed ₹6,000.
        const completedCycles = Math.floor(currentCycleAmount / 6000);

        if (completedCycles > 0) {
          // ----------------------------------------------------------
          // Find partner's existing 7-level upline chain.
          // Same structure as the existing referral flow.
          // ----------------------------------------------------------
          const commissionOps = [];

          let currentUserId = withdrawal.userId;

          for (let level = 0; level < 7; level++) {
            const currentUser = await tx.user.findUnique({
              where: {
                id: currentUserId,
              },
              select: {
                uplineId: true,
              },
            });

            if (!currentUser?.uplineId) {
              break;
            }

            commissionOps.push({
              uplineId: currentUser.uplineId,
              level,
            });

            currentUserId = currentUser.uplineId;
          }

          const LEVEL_POINTS = [100, 30, 15, 15, 20, 30, 50];

          // Total points actually distributed through available uplines.
          let distributedToUplines = 0;

          // ----------------------------------------------------------
          // Each completed ₹6,000 cycle creates exactly 599 points.
          // ----------------------------------------------------------
          for (let cycle = 0; cycle < completedCycles; cycle++) {
            // Partner pays/debits 599 Marketing Points.
            await tx.pointsWallet.upsert({
              where: {
                userId: withdrawal.userId,
              },
              create: {
                userId: withdrawal.userId,
                balance: -599,
                lifetime: 0,
              },
              update: {
                balance: {
                  decrement: 599,
                },
              },
            });

            await tx.transaction.create({
              data: {
                userId: withdrawal.userId,
                type: "withdrawal_cycle_debit",
                amount: 0,
                points: -599,
                referenceId: withdrawal.id,
                description:
                  "599 Marketing Points debited for ₹6,000 withdrawal cycle",
              },
            });

            // --------------------------------------------------------
            // Existing 7-level commission structure
            // --------------------------------------------------------
            for (const { uplineId, level } of commissionOps) {
              const points = LEVEL_POINTS[level];

              await tx.pointsWallet.upsert({
                where: {
                  userId: uplineId,
                },
                create: {
                  userId: uplineId,
                  balance: points,
                  lifetime: points,
                },
                update: {
                  balance: {
                    increment: points,
                  },
                  lifetime: {
                    increment: points,
                  },
                },
              });

              await tx.transaction.create({
                data: {
                  userId: uplineId,
                  type: "referral_commission",
                  amount: 0,
                  points,
                  referenceId: withdrawal.id,
                  description: `Withdrawal cycle Level ${level + 1} commission`,
                },
              });

              distributedToUplines += points;
            }

            // --------------------------------------------------------
            // Remaining points go to MG DIGI Admin.
            //
            // If all 7 levels exist:
            // 599 - 260 = 339
            //
            // If fewer levels exist, the undistributed amount also
            // remains with Admin, ensuring the full 599 is accounted for.
            // --------------------------------------------------------
            const adminPoints = 599 - distributedToUplines;

            const admin = await tx.user.findFirst({
              where: {
                role: "admin",
              },
              select: {
                id: true,
              },
            });

            if (!admin) {
              throw new Error("ADMIN_USER_NOT_FOUND");
            }

            await tx.pointsWallet.upsert({
              where: {
                userId: admin.id,
              },
              create: {
                userId: admin.id,
                balance: adminPoints,
                lifetime: adminPoints,
              },
              update: {
                balance: {
                  increment: adminPoints,
                },
                lifetime: {
                  increment: adminPoints,
                },
              },
            });

            await tx.transaction.create({
              data: {
                userId: admin.id,
                type: "withdrawal_cycle_admin",
                amount: 0,
                points: adminPoints,
                referenceId: withdrawal.id,
                description:
                  "Remaining Marketing Points from ₹6,000 withdrawal cycle",
              },
            });

            // Mark exactly ₹6,000 as consumed.
            await tx.transaction.create({
              data: {
                userId: withdrawal.userId,
                type: "withdrawal_cycle",
                amount: 6000,
                points: 0,
                referenceId: withdrawal.id,
                description: "Completed ₹6,000 withdrawal cycle",
              },
            });

            // Reset for calculating the next possible cycle in this
            // transaction.
            distributedToUplines = 0;
          }
        }

        return {
          success: true,
          withdrawalId: withdrawal.id,
          cycleAmount: currentCycleAmount,
          completedCycles,
        };
      },
      {
        isolationLevel: "Serializable",
      },
    );

    res.json(result);
  } catch (err) {
    console.error("[withdrawal approval]", err);

    if (err.message === "WITHDRAWAL_ALREADY_PROCESSED") {
      return res.status(400).json({
        error: "Withdrawal has already been processed.",
      });
    }

    if (err.message === "WITHDRAWAL_NOT_FOUND") {
      return res.status(404).json({
        error: "Withdrawal not found.",
      });
    }

    if (err.message === "ADMIN_USER_NOT_FOUND") {
      return res.status(500).json({
        error: "Admin account not found.",
      });
    }

    res.status(500).json({
      error: "Unable to approve withdrawal.",
    });
  }
});
// ── GET SINGLE USER ───────────────────────────────────────────
router.get("/users/:id", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        pointsWallet: true,
        earningsWallet: true,
        submissions: {
          orderBy: { submittedAt: "desc" },
          take: 10,
          include: { campaign: true },
        },
        withdrawals: { orderBy: { requestedAt: "desc" }, take: 5 },
        _count: { select: { submissions: true } },
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    const downlineCount = await prisma.user.count({
      where: { uplineId: user.id },
    });
    res.json({ ...user, downlineCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ── SUSPEND USER ──────────────────────────────────────────────
router.patch("/users/:id/suspend", auth, async (req, res) => {
  try {
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: "Cannot suspend yourself" });
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: "suspended" },
    });
    await prisma.activityFeed.create({
      data: {
        type: "suspension",
        userId: user.id,
        userName: user.name || "Partner",
        description: `${user.name || "Partner"} account suspended by admin`,
        amount: null,
      },
    });
    res.json({ success: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ── ACTIVATE USER ─────────────────────────────────────────────
router.patch("/users/:id/activate", auth, async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: "active" },
    });
    await prisma.activityFeed.create({
      data: {
        type: "activation",
        userId: user.id,
        userName: user.name || "Partner",
        description: `${user.name || "Partner"} account reactivated by admin`,
        amount: null,
      },
    });
    res.json({ success: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ── SEND WARNING ──────────────────────────────────────────────
router.post("/users/:id/warning", auth, async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { warnings: { increment: 1 } },
    });
    await prisma.activityFeed.create({
      data: {
        type: "warning",
        userId: user.id,
        userName: user.name || "Partner",
        description: `Warning issued to ${user.name || "Partner"}${reason ? ": " + reason : ""}`,
        amount: null,
      },
    });
    res.json({ success: true, warnings: user.warnings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
