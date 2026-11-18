
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

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

    return callback(new Error("Origin not allowed"));
  }
}));

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Independent Business API",
    status: "running"
  });
});

// Root route
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Business API is online"
  });
});

// Payment route placeholders
app.post("/stk-push", (req, res) => {
  return res.status(501).json({
    success: false,
    message: "Payment integration must be configured for the verified business."
  });
});

app.post("/payment-status", (req, res) => {
  return res.status(501).json({
    success: false,
    message: "Payment status service is not configured."
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

  if (res.headersSent) return next(err);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
