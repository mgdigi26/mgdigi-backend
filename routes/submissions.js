const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const prisma = new PrismaClient();

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

router.post("/", auth, async (req, res) => {
  try {
    const { campaignId, dayNumber, screenshotUrl, remarks } = req.body;

    // ------------------------------------------------------------------
    // NEW FLOW
    // campaignId coming from frontend is actually CampaignSchedule.id
    // ------------------------------------------------------------------

    const enrollment = await prisma.campaignEnrollment.findFirst({
      where: {
        userId: req.user.userId,
        scheduleId: campaignId,
      },
    });

    if (enrollment) {
      const updated = await prisma.campaignEnrollment.update({
        where: { id: enrollment.id },
        data: {
          screenshotUrl,
          submittedAt: new Date(),
          status: "pending",
        },
      });

      return res.json({
        success: true,
        submission: updated,
      });
    }

    // ------------------------------------------------------------------
    // LEGACY FLOW
    // Existing Submission table remains untouched.
    // ------------------------------------------------------------------

    const submission = await prisma.submission.create({
      data: {
        userId: req.user.userId,
        campaignId,
        remarks,
        screenshotUrl,
        status: "pending",
      },
    });

    res.json({
      success: true,
      submission,
    });
  } catch (e) {
    console.error("[POST /submissions]", e);
    res.status(500).json({
      error: e.message || "Server error",
    });
  }
});

router.get("/", auth, async (req, res) => {
  const submissions = await prisma.submission.findMany({
    where: { userId: req.user.userId },
    include: { campaign: true },
    orderBy: { submittedAt: "desc" },
  });
  res.json(submissions);
});

module.exports = router;
