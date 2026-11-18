
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const PAYLOR_BASE_URL = "https://api.paylorke.com/api/v1";

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(origin => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Check required Paylor configuration
function checkPaylorConfig() {
  return Boolean(
    process.env.PAYLOR_API_KEY &&
    process.env.PAYLOR_WEBHOOK_SECRET
  );
}

// CORS configuration
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const normalized = origin.replace(/\/$/, "");

    if (allowedOrigins.includes(normalized)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed"));
  }
}));

// Preserve raw body for webhook signature verification
app.use(express.json({
  limit: "20kb",
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

// Normalize Kenyan phone numbers
function normalizePhone(value) {
  let phone = String(value || "").replace(/[\s-]/g, "");

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

// Paylor authenticated request helper
async function paylorRequest(path, options = {}) {
  if (!checkPaylorConfig()) {
    throw new Error("Paylor credentials are not configured.");
  }

  const response = await fetch(
    `${PAYLOR_BASE_URL}${path}`,
    {
      ...options,
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${process.env.PAYLOR_API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Paylor returned an invalid response.");
  }

  if (!response.ok) {
    console.error("Paylor API error:", {
      status: response.status,
      message: data.message || "Payment request rejected",
      code: data.error?.code
    });

    const error = new Error(
      data.message ||
      data.error?.message ||
      "Paylor payment request failed."
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

// HEALTH CHECK
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "NYOTA FUNDS API is online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "NYOTA FUNDS API",
    status: "running",
    paymentConfigured: checkPaylorConfig()
  });
});

// INITIATE M-PESA STK PUSH
app.post("/stk-push", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const amount = Number(req.body.amount);

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan M-PESA phone number."
      });
    }

    if (
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > 150000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    if (!checkPaylorConfig()) {
      return res.status(503).json({
        success: false,
        message: "Paylor credentials are missing."
      });
    }

    const callbackUrl =
      process.env.CALLBACK_URL ||
      (process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL}/callback`
        : null);

    if (!callbackUrl || !callbackUrl.startsWith("https://")) {
      return res.status(503).json({
        success: false,
        message: "A valid HTTPS callback URL is required."
      });
    }

    const reference =
      "NYOTA-" +
      Date.now() +
      "-" +
      crypto.randomUUID().slice(0, 8);

    const payload = {
      phone,
      amount,
      reference,
      description: "FULIZA Processing Fee",
      callbackUrl
    };

    // Optional payment channel
    if (process.env.PAYLOR_CHANNEL_ID) {
      payload.channelId = process.env.PAYLOR_CHANNEL_ID;
    }

    const result = await paylorRequest(
      "/merchants/payments/stk-push",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": reference
        },
        body: JSON.stringify(payload)
      }
    );

    const transactionId =
      result.transactionId ||
      result.data?.transactionId;

    if (!transactionId) {
      console.error("Paylor response missing transaction ID");

      return res.status(502).json({
        success: false,
        message: "Paylor did not return a transaction ID."
      });
    }

    console.log("STK Push initiated:", reference);

    return res.status(200).json({
      success: true,
      message: "M-PESA payment request sent.",
      transactionId,
      reference,
      status: result.status || "SENT"
    });

  } catch (error) {
    console.error("STK PUSH ERROR:", error.message);

    return res.status(
      error.status && error.status >= 400 &&
      error.status < 500 ? error.status : 502
    ).json({
      success: false,
      message: error.message || "Unable to initiate payment."
    });
  }
});

// CHECK PAYMENT STATUS
app.post("/payment-status", async (req, res) => {
  try {
    const transactionId = String(
      req.body.transactionId || ""
    ).trim();

    // Paylor transaction IDs are 24-character hexadecimal IDs
    if (!/^[a-fA-F0-9]{24}$/.test(transactionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction ID."
      });
    }

    const result = await paylorRequest(
      `/merchants/payments/transactions/${encodeURIComponent(transactionId)}`,
      {
        method: "GET"
      }
    );

    const transaction = result.transaction || result.data || result;

    const status = String(
      transaction.status || ""
    ).toUpperCase();

    if (!status) {
      return res.status(502).json({
        success: false,
        message: "Paylor returned no transaction status."
      });
    }

    return res.json({
      success: true,
      transactionId,
      status,
      mpesaReceipt:
        transaction.mpesaReceipt || null
    });

  } catch (error) {
    console.error("PAYMENT STATUS ERROR:", error.message);

    return res.status(
      error.status && error.status >= 400 &&
      error.status < 500 ? error.status : 502
    ).json({
      success: false,
      message: error.message || "Unable to check payment status."
    });
  }
});

// VERIFY PAYLOR WEBHOOK SIGNATURE
function verifyWebhook(req) {
  const secret = process.env.PAYLOR_WEBHOOK_SECRET;
  const signature = req.headers["x-webhook-signature"];

  if (!secret || !signature || !req.rawBody) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest();

  let received;

  try {
    received = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

// PAYLOR PAYMENT CALLBACK
app.post("/callback", (req, res) => {
  if (!process.env.PAYLOR_WEBHOOK_SECRET) {
    return res.status(503).json({
      success: false,
      message: "Webhook secret is not configured."
    });
  }

  if (!verifyWebhook(req)) {
    console.error("Rejected invalid Paylor webhook signature");

    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature."
    });
  }

  const event = req.body.event;
  const transaction = req.body.transaction || {};

  console.log("Verified Paylor webhook:", {
    event,
    reference: transaction.reference,
    status: transaction.status,
    transactionId: transaction.id
  });

  // Do not trust unsigned or unverified callbacks.
  // Payment status is independently reconciled through Paylor.

  return res.status(200).json({
    success: true,
    received: true
  });
});

// UNKNOWN ROUTES
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found."
  });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`NYOTA FUNDS API running on port ${PORT}`);
});
