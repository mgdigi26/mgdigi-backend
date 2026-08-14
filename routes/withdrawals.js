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
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount)) {
      return res.status(400).json({
        error: "Please enter a valid withdrawal amount",
      });
    }

    if (amount < 200) {
      return res.status(400).json({
        error: "Minimum withdrawal amount is ₹200",
      });
    }

    if (amount > 6000) {
      return res.status(400).json({
        error: "Maximum withdrawal amount is ₹6,000",
      });
    }

    const earnings = await prisma.earningsWallet.findUnique({
      where: { userId: req.user.userId },
    });

    if (!earnings || earnings.balance < amount) {
      return res.status(400).json({
        error: "Insufficient earnings balance",
      });
    }

    // Read current Admin Settings
    const settings = await prisma.appSetting.findMany({
      where: {
        key: {
          in: ["tds", "adminCharge"],
        },
      },
    });

    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, Number(setting.value)]),
    );

    // Existing Admin Settings defaults
    const tdsRate = Number.isFinite(settingMap.tds) ? settingMap.tds : 5;

    const adminChargeRate = Number.isFinite(settingMap.adminCharge)
      ? settingMap.adminCharge
      : 10;

    const adminCharge = Number(((amount * adminChargeRate) / 100).toFixed(2));

    const tdsDeduction = Number(((amount * tdsRate) / 100).toFixed(2));

    const netAmount = Number((amount - adminCharge - tdsDeduction).toFixed(2));

    const withdrawal = await prisma.withdrawal.create({
      data: {
        userId: req.user.userId,
        grossAmount: amount,
        adminCharge,
        tdsDeduction,
        netAmount,
        status: "pending",
      },
    });

    res.json({
      success: true,
      withdrawal,
    });
  } catch (err) {
    console.error("[withdrawal request]", err);

    res.status(500).json({
      error: "Server error",
    });
  }
});

router.get("/", auth, async (req, res) => {
  const withdrawals = await prisma.withdrawal.findMany({
    where: { userId: req.user.userId },
    orderBy: { requestedAt: "desc" },
  });
  res.json(withdrawals);
});

module.exports = router;
