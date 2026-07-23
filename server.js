require("dotenv").config();

const express = require("express");
const axios = require("axios");
const twilio = require("twilio");
const { Resend } = require("resend");

const app = express();
app.use(express.json());

const {
  PORT = 3000,
  AGENT_SECRET,
  WOOCOMMERCE_URL,
  WOOCOMMERCE_CONSUMER_KEY,
  WOOCOMMERCE_CONSUMER_SECRET,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER = "+18652768862",
  RESEND_API_KEY,
} = process.env;

const PAYMENT_LINK = "https://paybybankful.com/dashboard/virtual-transaction";
const DEFAULT_PRODUCT_ID = 11487;
const EMAIL_FROM = "Nationwide Peptides <customer@nationwidepeptides.com>";

function requireAgentSecret(req, res, next) {
  if (!AGENT_SECRET || req.headers["x-agent-secret"] !== AGENT_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
}

function splitName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return { first_name: "Customer", last_name: "" };
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" "),
  };
}

function normalizePhone(to) {
  if (!to) return null;
  const cleaned = String(to).trim().replace(/[\s()-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPaymentEmailHtml(customerName) {
  const name = escapeHtml(customerName);
  return `
    <p>Hi ${name},</p>
    <p>Thank you for your order!</p>
    <p>
      Please complete your payment using this secure link:<br />
      <a href="${PAYMENT_LINK}">${PAYMENT_LINK}</a>
    </p>
    <p>Once payment is received we will process your order right away.</p>
    <p>
      Best regards,<br />
      Nationwide Peptides Team
    </p>
  `.trim();
}

// Query-string auth survives redirects better than Basic auth headers.
const wcClient = axios.create({
  baseURL: `${String(WOOCOMMERCE_URL || "").replace(/\/$/, "")}/wp-json/wc/v3`,
  params: {
    consumer_key: WOOCOMMERCE_CONSUMER_KEY,
    consumer_secret: WOOCOMMERCE_CONSUMER_SECRET,
  },
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
});

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const resend = new Resend(RESEND_API_KEY);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "morgan-sales-api" });
});

/**
 * POST /create-order
 * Creates a WooCommerce order (product_id 11487), then emails the payment link.
 */
app.post("/create-order", requireAgentSecret, async (req, res) => {
  try {
    const {
      customer_name,
      customer_email,
      products,
      shipping_address,
      to,
      total_amount,
    } = req.body || {};

    if (!customer_name || !customer_email || !shipping_address) {
      return res.status(400).json({
        ok: false,
        error: "customer_name, customer_email, and shipping_address are required",
      });
    }

    const phone = normalizePhone(to) || "";
    const { first_name, last_name } = splitName(customer_name);
    const addressLine = String(shipping_address).trim();

    const orderPayload = {
      status: "pending",
      set_paid: false,
      billing: {
        first_name,
        last_name,
        address_1: addressLine,
        email: customer_email,
        phone,
      },
      shipping: {
        first_name,
        last_name,
        address_1: addressLine,
      },
      line_items: [
        {
          product_id: DEFAULT_PRODUCT_ID,
          quantity: 1,
        },
      ],
      customer_note: products
        ? `Products requested: ${products}`
        : undefined,
      meta_data: [
        ...(total_amount != null && total_amount !== ""
          ? [{ key: "_morgan_quoted_total", value: String(total_amount) }]
          : []),
        ...(products
          ? [{ key: "_morgan_products_text", value: String(products) }]
          : []),
      ],
    };

    const { data: order } = await wcClient.post("/orders", orderPayload);

    const { error: emailError } = await resend.emails.send({
      from: EMAIL_FROM,
      to: customer_email,
      subject: "Your Nationwide Peptides Order – Payment Link",
      html: buildPaymentEmailHtml(customer_name),
    });

    if (emailError) {
      throw new Error(emailError.message || "Failed to send email");
    }

    return res.status(201).json({
      ok: true,
      order_id: order.id,
      message: "Order created and email sent",
    });
  } catch (err) {
    const wcMessage = err.response?.data?.message;
    const message =
      wcMessage ||
      err.message ||
      "Failed to create order or send email";

    console.error(
      "create-order error:",
      err.response?.status,
      err.response?.data || message
    );
    return res.status(500).json({ ok: false, error: message });
  }
});

/**
 * POST /send-payment-link
 * Resend payment SMS only (same auth as create-order).
 */
app.post("/send-payment-link", requireAgentSecret, async (req, res) => {
  try {
    const { to } = req.body || {};
    if (!to) {
      return res.status(400).json({ ok: false, error: "to is required" });
    }

    const phone = normalizePhone(to);
    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "to must be a valid phone number (e.g. +18655551234)",
      });
    }

    await twilioClient.messages.create({
      body: `Nationwide Peptides — complete your payment here:\n${PAYMENT_LINK}`,
      from: TWILIO_FROM_NUMBER,
      to: phone,
    });

    return res.json({
      ok: true,
      message: "Payment link SMS sent",
    });
  } catch (err) {
    const message = err.message || "Failed to send SMS";
    console.error("send-payment-link error:", message);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Morgan sales API listening on port ${PORT}`);
});
