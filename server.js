
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "20kb" }));

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error("Origin not allowed"));
  }
}));

const PORT = process.env.PORT || 3000;
const MODE = process.env.DARAJA_ENV || "sandbox";

const KEY = process.env.DARAJA_CONSUMER_KEY;
const SECRET = process.env.DARAJA_CONSUMER_SECRET;
const SHORTCODE = process.env.DARAJA_SHORTCODE;
const PASSKEY = process.env.DARAJA_PASSKEY;
const CALLBACK_URL = process.env.DARAJA_CALLBACK_URL;

// Configure the actual price of your disclosed product/service.
const PRICE = Number(process.env.PRODUCT_PRICE_KES);

const BASE_URL = MODE === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

// Temporary storage for testing only.
// Replace with a persistent database before production.
const transactions = new Map();

function jsonError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/\s+/g, "");

  if (phone.startsWith("+")) {
    phone = phone.substring(1);
  }

  if (phone.startsWith("0")) {
    phone = "254" + phone.substring(1);
  }

  if (!/^254(7|1)\d{8}$/.test(phone)) {
    return null;
  }

  return phone;
}

function getTimestamp() {
  const date = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const p = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

async function getAccessToken() {
  const credentials = Buffer.from(`${KEY}:${SECRET}`).toString("base64");

  const response = await fetch(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Could not authenticate with Daraja");
  }

  return data.access_token;
}

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Business Payment API",
    status: "running"
  });
});

// INITIATE STK PUSH
app.post("/stk-push", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);

    if (!phone) {
      return jsonError(res, 400, "Enter a valid Kenyan phone number");
    }

    if (!Number.isInteger(PRICE) || PRICE < 1) {
      return jsonError(res, 500, "Product price is not configured");
    }

    if (!CALLBACK_URL || !CALLBACK_URL.startsWith("https://")) {
      return jsonError(res, 500, "Secure callback URL is not configured");
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();

    const password = Buffer.from(
      `${SHORTCODE}${PASSKEY}${timestamp}`
    ).toString("base64");

    const response = await fetch(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: PRICE,
          PartyA: phone,
          PartyB: SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: CALLBACK_URL,
          AccountReference: "BUSINESS-ORDER",
          TransactionDesc: "Payment for disclosed business service"
        })
      }
    );

    const data = await response.json();

    if (!response.ok || data.ResponseCode !== "0") {
      console.error("Daraja initiation error:", data);

      return jsonError(
        res,
        502,
        data.errorMessage || data.ResponseDescription ||
        "Payment provider rejected the request"
      );
    }

    const transactionId = data.CheckoutRequestID;

    transactions.set(transactionId, {
      transactionId,
      phone,
      amount: PRICE,
      status: "PENDING",
      receipt: null,
      createdAt: new Date().toISOString()
    });

    return res.status(202).json({
      success: true,
      message: "Payment request accepted",
      transactionId,
      amount: PRICE,
      status: "PENDING"
    });

  } catch (error) {
    console.error("STK PUSH ERROR:", error);

    return jsonError(res, 502, "Unable to initiate payment");
  }
});

// RECEIVE SAFARICOM CALLBACK
app.post("/callback", (req, res) => {
  // Acknowledge the callback promptly.
  res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });

  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      console.error("Invalid callback received");
      return;
    }

    const id = callback.CheckoutRequestID;
    const transaction = transactions.get(id);

    if (!transaction) {
      console.error("Unknown transaction callback:", id);
      return;
    }

    if (callback.ResultCode !== 0) {
      transaction.status = "FAILED";
      transaction.failureReason = callback.ResultDesc;
      return;
    }

    const items = callback.CallbackMetadata?.Item || [];

    const metadata = Object.fromEntries(
      items.map(item => [item.Name, item.Value])
    );

    const callbackAmount = Number(metadata.Amount);
    const callbackPhone = String(metadata.PhoneNumber || "");
    const receipt = metadata.MpesaReceiptNumber;

    // Check callback against the original order.
    if (
      callbackAmount !== transaction.amount ||
      callbackPhone !== transaction.phone ||
      !receipt
    ) {
      transaction.status = "UNVERIFIED";
      console.error("Payment verification mismatch:", id);
      return;
    }

    transaction.status = "COMPLETED";
    transaction.receipt = receipt;
    transaction.paidAt = new Date().toISOString();

    console.log("Payment callback received:", {
      transactionId: id,
      receipt
    });

  } catch (error) {
    console.error("CALLBACK ERROR:", error);
  }
});

// CHECK PAYMENT STATUS
app.post("/payment-status", (req, res) => {
  const transactionId = String(req.body.transactionId || "");

  if (!transactionId) {
    return jsonError(res, 400, "Transaction ID is required");
  }

  const transaction = transactions.get(transactionId);

  if (!transaction) {
    return jsonError(res, 404, "Transaction not found");
  }

  return res.json({
    success: true,
    transactionId,
    status: transaction.status,
    receipt: transaction.receipt
  });
});

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);

  if (res.headersSent) return next(err);

  return jsonError(res, 500, "Internal server error");
});

// START SERVER
const required = [
  "DARAJA_CONSUMER_KEY",
  "DARAJA_CONSUMER_SECRET",
  "DARAJA_SHORTCODE",
  "DARAJA_PASSKEY",
  "DARAJA_CALLBACK_URL",
  "PRODUCT_PRICE_KES"
];

const missing = required.filter(key => !process.env[key]);

if (missing.length) {
  console.error("Missing environment variables:", missing);
  process.exit(1);
}

if (!["sandbox", "production"].includes(MODE)) {
  throw new Error("DARAJA_ENV must be sandbox or production");
}

app.listen(PORT, () => {
  console.log(`Payment server running on port ${PORT}`);
  console.log(`Daraja mode: ${MODE}`);
});
