const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

// Run-credit amounts per level (L1=100, L2=20, L3=15, L4=15, L5=20, L6=30, L7=50)
const LEVEL_CREDITS = [100, 20, 15, 15, 20, 30, 50];

const BCRYPT_ROUNDS = 10;

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateReferralCode() {
  return "P-" + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/** Verify JWT from Authorization header. Returns decoded payload or null. */
function verifyToken(req) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

// ── SEND OTP ──────────────────────────────────────────────────
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

// ── VERIFY OTP + REGISTER / LOGIN ────────────────────────────
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

      // Walk upline 7 levels and credit run-credits
      let currentUser = user;
      for (let level = 0; level < 7; level++) {
        const current = await prisma.user.findUnique({
          where: { id: currentUser.id },
        });
        if (!current?.uplineId) break;
        const creditAmount = LEVEL_CREDITS[level];
        await prisma.runCredit.create({
          data: {
            userId: current.uplineId,
            tier: level + 1,
            amount: creditAmount,
            sourceUserId: user.id,
            sourceLevel: level + 1,
          },
        });
        await prisma.activityFeed.create({
          data: {
            type: "join",
            userId: user.id,
            userName: user.name || "New Partner",
            description: `${user.name || "New Partner"} joined under Level ${level + 1}`,
            amount: creditAmount,
          },
        });
        const uplineUser = await prisma.user.findUnique({
          where: { id: current.uplineId },
        });
        if (!uplineUser) break;
        currentUser = uplineUser;
      }

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

    // Include hasPassword so frontend knows whether to show password setup
    res.json({ success: true, token, user, hasPassword: !!user.password });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// ── GET PROFILE ───────────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { pointsWallet: true, earningsWallet: true },
    });
    res.json(user);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

// ── CHECK REFERRAL CODE ───────────────────────────────────────
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

// ── UPDATE PROFILE ────────────────────────────────────────────
router.post("/update-profile", async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) return res.status(401).json({ error: "Unauthorized" });
    const { name, email, city, state } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (city) updateData.city = city;
    if (state) updateData.state = state;
    const user = await prisma.user.update({
      where: { id: decoded.userId },
      data: updateData,
    });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── CHECK USER (exists + hasPassword) ────────────────────────
// Used by login screen to route: phone-only check before showing password field.
router.post("/check-user", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const user = await prisma.user.findUnique({
      where: { phone },
      select: { id: true, password: true },
    });
    if (!user) {
      return res.json({ exists: false, hasPassword: false });
    }
    res.json({ exists: true, hasPassword: !!user.password });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── LOGIN WITH PASSWORD ───────────────────────────────────────
// Authenticates an existing user using phone + password.
router.post("/login-password", async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: "Phone and password required" });
    }

    const user = await prisma.user.findUnique({ where: { phone } });

    // Generic error — do not reveal whether phone or password is wrong
    if (!user || !user.password) {
      return res
        .status(401)
        .json({ error: "Invalid mobile number or password" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res
        .status(401)
        .json({ error: "Invalid mobile number or password" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.json({ success: true, token, user });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── SET PASSWORD (new registration) ──────────────────────────
// Called after OTP verification + profile completion during registration.
// Requires a valid Bearer token (issued by verify-otp).
router.post("/set-password", async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) return res.status(401).json({ error: "Unauthorized" });

    const { password } = req.body;
    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: decoded.userId },
      data: { password: hashed },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── REQUEST PASSWORD RESET OTP ────────────────────────────────
// Sends OTP for the forgot-password flow.
// Only works for registered phone numbers.
router.post("/reset-password-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required" });

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return res
        .status(404)
        .json({ error: "No account found for this number" });
    }

    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.oTP.create({ data: { phone, code, expiresAt } });
    console.log(`Password reset OTP for ${phone}: ${code}`);
    res.json({ success: true, message: "OTP sent", otp: code });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────
// Verifies OTP and sets a new password. Returns a fresh token.
router.post("/reset-password", async (req, res) => {
  try {
    const { phone, code, password } = req.body;
    if (!phone || !code || !password) {
      return res
        .status(400)
        .json({ error: "Phone, code, and password required" });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    // Verify OTP
    const otp = await prisma.oTP.findFirst({
      where: { phone, code, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) return res.status(400).json({ error: "Invalid or expired OTP" });
    await prisma.oTP.update({ where: { id: otp.id }, data: { used: true } });

    // Find user
    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) return res.status(404).json({ error: "Account not found" });

    // Hash and save new password
    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });

    // Issue a fresh token so user is logged in immediately
    const token = jwt.sign(
      { userId: updated.id, role: updated.role },
      process.env.JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.json({ success: true, token, user: updated });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
