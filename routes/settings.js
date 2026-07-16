/**
 * routes/settings.js — Admin Financial Settings API
 *
 * Manages configurable financial parameters:
 *   gst          — GST rate (%)
 *   tds          — TDS deduction rate (%)
 *   adminCharge  — Admin processing charge rate (%)
 *
 * Defaults (if not yet seeded in DB):
 *   gst = 0, tds = 5, adminCharge = 10
 *
 * Routes:
 *   GET  /admin/settings   → returns { gst, tds, adminCharge } as numbers
 *   PUT  /admin/settings   → accepts any subset, validates 0–100, saves
 *
 * Registration in index.js:
 *   const settingsRouter = require('./routes/settings')
 *   app.use('/api', settingsRouter)
 */

const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const prisma = new PrismaClient();

function adminAuth(req, res, next) {
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

// Default values used if the DB row does not yet exist
const DEFAULTS = { gst: 0, tds: 5, adminCharge: 10 };
const VALID_KEYS = new Set(["gst", "tds", "adminCharge"]);

/**
 * GET /admin/settings
 * Returns all financial settings as numbers.
 * Falls back to defaults for any missing key.
 */
router.get("/admin/settings", adminAuth, async (req, res) => {
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: ["gst", "tds", "adminCharge"] } },
    });

    const map = {};
    rows.forEach((r) => {
      map[r.key] = parseFloat(r.value);
    });

    res.json({
      gst: map.gst ?? DEFAULTS.gst,
      tds: map.tds ?? DEFAULTS.tds,
      adminCharge: map.adminCharge ?? DEFAULTS.adminCharge,
    });
  } catch (e) {
    console.error("[settings GET]", e);
    res.status(500).json({ error: "Could not load settings" });
  }
});

/**
 * PUT /admin/settings
 * Accepts: { gst?, tds?, adminCharge? } — any subset
 * Validates each provided value is a number in [0, 100]
 * Uses upsert so it works whether the row exists or not
 */
router.put("/admin/settings", adminAuth, async (req, res) => {
  try {
    const updates = {};

    for (const key of VALID_KEYS) {
      if (req.body[key] === undefined) continue;
      const val = parseFloat(req.body[key]);
      if (isNaN(val) || val < 0 || val > 100) {
        return res
          .status(400)
          .json({ error: `${key} must be a number between 0 and 100` });
      }
      updates[key] = val;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields provided" });
    }

    // Upsert each changed key
    await Promise.all(
      Object.entries(updates).map(([key, value]) =>
        prisma.appSetting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        }),
      ),
    );

    // Return full updated settings
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: ["gst", "tds", "adminCharge"] } },
    });
    const map = {};
    rows.forEach((r) => {
      map[r.key] = parseFloat(r.value);
    });

    res.json({
      success: true,
      gst: map.gst ?? DEFAULTS.gst,
      tds: map.tds ?? DEFAULTS.tds,
      adminCharge: map.adminCharge ?? DEFAULTS.adminCharge,
    });
  } catch (e) {
    console.error("[settings PUT]", e);
    res.status(500).json({ error: "Could not save settings" });
  }
});

module.exports = router;
