const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const prisma = new PrismaClient();

const LEVEL_CREDITS = [100, 20, 15, 15, 20, 30, 50];

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateReferralCode() {
  return "P-" + Math.random().toString(36).substring(2, 6).toUpperCase();
}

router.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.oTP.create({ data: { phone, code, expiresAt } });
    console.log(`OTP for ${phone}: ${code}`);
    res.json({ success: true, message: "OTP sent", otp: code });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, code, name, referralCode } = req.body;
    const otp = await prisma.oTP.findFirst({
      where: { phone, code, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) return res.status(400).json({ error: "Invalid or expired OTP" });
    await prisma.oTP.update({ where: { id: otp.id }, data: { used: true } });

    let user = await prisma.user.findUnique({ where: { phone } });

    if (!user) {
      let uplineId = null;
      if (referralCode) {
        const upline = await prisma.user.findUnique({
          where: { referralCode: referralCode.toUpperCase() },
        });
        if (upline) uplineId = upline.id;
      }

      user = await prisma.user.create({
        data: {
          name: name || "Partner",
          phone,
          referralCode: generateReferralCode(),
          uplineId,
          pointsWallet: { create: { balance: 0, lifetime: 0 } },
          earningsWallet: { create: { balance: 0, lifetime: 0 } },
        },
      });

      // Walk 7 levels up and add run-credits to each upline
      let currentUser = user;
      for (let level = 0; level < 7; level++) {
        const current = await prisma.user.findUnique({
          where: { id: currentUser.id },
        });
        if (!current?.uplineId) break;

        await prisma.runCredit.create({
          data: {
            userId: current.uplineId,
            tier: level + 1,
            amount: LEVEL_CREDITS[level],
            sourceUserId: user.id,
            sourceLevel: level + 1,
          },
        });

        const uplineUser = await prisma.user.findUnique({
          where: { id: current.uplineId },
        });
        if (!uplineUser) break;
        currentUser = uplineUser;
      }

      // Log join to activity feed
      await prisma.activityFeed.create({
        data: {
          type: "join",
          userId: user.id,
          userName: user.name || "New Partner",
          description: `${user.name || "New Partner"} joined MGdigi`,
          amount: null,
        },
      });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.json({ success: true, token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/me", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { pointsWallet: true, earningsWallet: true },
    });
    res.json(user);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

router.post("/check-referral", async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ error: "Required" });
    const user = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase() },
      select: { id: true, name: true, referralCode: true },
    });
    if (!user) return res.status(404).json({ error: "Code not found" });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/update-profile", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { name } = req.body;
    const user = await prisma.user.update({
      where: { id: decoded.userId },
      data: { name: name || "Partner" },
    });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
