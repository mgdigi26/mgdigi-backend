const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

router.get("/", async (req, res) => {
  try {
    const activities = await prisma.activityFeed.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(activities);
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
