
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend configuration
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed"));
  }
}));

app.use(express.json({ limit: "20kb" }));

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "NYOTA FUNDS API",
    status: "running"
  });
});

// Root route
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "NYOTA FUNDS API is online"
  });
});

// Payment endpoint - intentionally disabled
app.post("/stk-push", (req, res) => {
  res.status(503).json({
    success: false,
    message: "Payment service is not configured."
  });
});

// Payment status - intentionally disabled
app.post("/payment-status", (req, res) => {
  res.status(503).json({
    success: false,
    message: "Payment status service is not configured."
  });
});

// Webhook endpoint - intentionally disabled
app.post("/callback", (req, res) => {
  res.status(503).json({
    success: false,
    message: "Webhook processing is not configured."
  });
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found"
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`NYOTA FUNDS API running on port ${PORT}`);
});
