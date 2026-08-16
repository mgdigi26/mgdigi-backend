const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const prisma = new PrismaClient();

function verifyToken(req) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

function generateCashfreeSignature() {
  const clientId = process.env.CASHFREE_SECURE_ID;
  const publicKey = process.env.CASHFREE_SECURE_PUBLIC_KEY;

  if (!clientId || !publicKey) {
    throw new Error("Cashfree Secure ID public key configuration is missing.");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const data = `${clientId}.${timestamp}`;

  const encrypted = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(data, "utf8"),
  );

  return encrypted.toString("base64");
}

// GET saved bank details
router.get("/", async (req, res) => {
  try {
    const decoded = verifyToken(req);

    if (!decoded) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        bankAccount: true,
        bankIfsc: true,
        bankName: true,
        accountHolderName: true,
        bankVerified: true,
        bankVerifiedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      success: true,
      bank: user,
    });
  } catch (error) {
    console.error("[bank/get] ERROR:", error);
    res.status(500).json({ error: "Could not load bank details" });
  }
});

// VERIFY bank account through Cashfree
router.post("/verify", async (req, res) => {
  try {
    const decoded = verifyToken(req);

    if (!decoded) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { bankAccount, bankIfsc, accountHolderName } = req.body;

    if (!bankAccount || !bankIfsc || !accountHolderName) {
      return res.status(400).json({
        error: "Account number, IFSC and account holder name are required.",
      });
    }

    const account = String(bankAccount).trim();
    const ifsc = String(bankIfsc).trim().toUpperCase();
    const name = String(accountHolderName).trim();

    if (account.length < 6 || account.length > 40) {
      return res.status(400).json({
        error: "Please enter a valid bank account number.",
      });
    }

    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      return res.status(400).json({
        error: "Please enter a valid 11-character IFSC code.",
      });
    }

    if (name.length < 2) {
      return res.status(400).json({
        error: "Please enter a valid account holder name.",
      });
    }

    if (
      !process.env.CASHFREE_SECURE_ID ||
      !process.env.CASHFREE_SECURE_SECRET
    ) {
      console.error("[bank/verify] Cashfree credentials missing");

      return res.status(500).json({
        error: "Bank verification service is not configured.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: "User not found.",
      });
    }

    const cashfreeSignature = generateCashfreeSignature();

    const cashfreeResponse = await fetch(
      "https://api.cashfree.com/verification/bank-account/sync",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": process.env.CASHFREE_SECURE_ID,
          "x-client-secret": process.env.CASHFREE_SECURE_SECRET,
          "x-cf-signature": cashfreeSignature,
        },
        body: JSON.stringify({
          bank_account: account,
          ifsc,
          name,
        }),
      },
    );

    const result = await cashfreeResponse.json();

    console.log("[bank/verify] Cashfree:", {
      httpStatus: cashfreeResponse.status,
      accountStatus: result.account_status,
      accountStatusCode: result.account_status_code,
      nameMatchResult: result.name_match_result,
    });

    if (!cashfreeResponse.ok) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: result.message || "Bank verification failed.",
        code: result.code || result.account_status_code || null,
      });
    }

    if (result.account_status !== "VALID") {
      return res.status(400).json({
        success: false,
        verified: false,
        error: "Bank account could not be verified.",
        accountStatus: result.account_status || null,
        accountStatusCode: result.account_status_code || null,
        nameAtBank: result.name_at_bank || null,
        bankName: result.bank_name || null,
        nameMatchResult: result.name_match_result || null,
        nameMatchScore: result.name_match_score || null,
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        bankAccount: account,
        bankIfsc: ifsc,
        bankName: result.bank_name || null,
        accountHolderName: result.name_at_bank || name,
        bankVerified: true,
        bankVerifiedAt: new Date(),
      },
      select: {
        bankAccount: true,
        bankIfsc: true,
        bankName: true,
        accountHolderName: true,
        bankVerified: true,
        bankVerifiedAt: true,
      },
    });

    return res.json({
      success: true,
      verified: true,
      bank: updatedUser,
      verification: {
        referenceId: result.reference_id || null,
        nameAtBank: result.name_at_bank || null,
        nameMatchResult: result.name_match_result || null,
        nameMatchScore: result.name_match_score || null,
      },
    });
  } catch (error) {
    console.error("[bank/verify] ERROR:", error);

    res.status(500).json({
      error: "Bank verification failed. Please try again.",
    });
  }
});

module.exports = router;
