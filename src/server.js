require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");

const db = require("./db");
const { products, getProductById } = require("./config/products");

const app = express();
const port = Number(process.env.PORT || 4000);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const currency = process.env.STRIPE_CURRENCY || "usd";
const ADMIN_SESSION_COOKIE = "tigris_admin_session";
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || baseUrl
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200
}));

app.set("trust proxy", 1);
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecure = req.secure || forwardedProto === "https";
  if (isSecure) {
    return next();
  }

  return res.redirect(`https://${req.headers.host}${req.originalUrl}`);
});

const allowedOrderStatuses = new Set([
  "awaiting_card_payment",
  "awaiting_zelle",
  "awaiting_cash",
  "paid",
  "ready_for_pickup",
  "completed",
  "cancelled"
]);

const adminLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many admin login attempts. Try again in a few minutes."
  }
});

function safeCompare(input, expected) {
  const inputBuffer = Buffer.from(String(input || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));

  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function getAdminPassword() {
  return String(process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY || "").trim();
}

function getAdminSessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_API_KEY || "").trim();
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const parts = raw.split(";");
  const cookies = {};

  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      continue;
    }

    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) {
      continue;
    }

    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function signAdminSession(expiry) {
  const secret = getAdminSessionSecret();
  if (!secret) {
    return null;
  }

  return crypto
    .createHmac("sha256", secret)
    .update(String(expiry))
    .digest("hex");
}

function createAdminSessionCookieValue() {
  const expiry = Date.now() + ADMIN_SESSION_TTL_MS;
  const signature = signAdminSession(expiry);
  if (!signature) {
    return null;
  }

  return `${expiry}.${signature}`;
}

function isValidAdminSession(value) {
  const token = String(value || "");
  const [expiryRaw, signatureRaw] = token.split(".");
  const expiry = Number(expiryRaw);

  if (!Number.isFinite(expiry) || expiry < Date.now() || !signatureRaw) {
    return false;
  }

  const expectedSignature = signAdminSession(expiryRaw);
  if (!expectedSignature) {
    return false;
  }

  return safeCompare(signatureRaw, expectedSignature);
}

function buildCookie(name, value, maxAgeSeconds) {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (process.env.NODE_ENV === "production") {
    segments.push("Secure");
  }

  return segments.join("; ");
}

function setAdminSessionCookie(res) {
  const value = createAdminSessionCookieValue();
  if (!value) {
    return false;
  }

  res.setHeader("Set-Cookie", buildCookie(ADMIN_SESSION_COOKIE, value, Math.floor(ADMIN_SESSION_TTL_MS / 1000)));
  return true;
}

function clearAdminSessionCookie(res) {
  res.setHeader("Set-Cookie", buildCookie(ADMIN_SESSION_COOKIE, "", 0));
}

function requireAdmin(req, res, next) {
  const expectedPassword = getAdminPassword();
  const expectedSessionSecret = getAdminSessionSecret();
  if (!expectedPassword || !expectedSessionSecret) {
    return res.status(503).json({
      error: "Admin auth is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in .env."
    });
  }

  const sessionToken = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (!isValidAdminSession(sessionToken)) {
    return res.status(401).json({ error: "Unauthorized admin request." });
  }

  return next();
}

function formatUsd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function buildOrderSummaryText(items, totalCents, customerName) {
  const lines = [
    "New Tigris Dates order",
    `Customer: ${customerName}`,
    "Items:"
  ];

  for (const item of items) {
    lines.push(`- ${item.quantity} x ${item.product.name} (${formatUsd(item.lineTotalCents)})`);
  }

  lines.push(`Total: ${formatUsd(totalCents)}`);
  lines.push("Payment: Zelle (pay later)");

  return lines.join("\n");
}

function buildWhatsappLink(message) {
  const businessNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || "").replace(/\D/g, "");
  if (!businessNumber) {
    return null;
  }

  const encoded = encodeURIComponent(message);
  return `https://wa.me/${businessNumber}?text=${encoded}`;
}

function validateCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "Please select at least one product." };
  }

  const normalized = [];
  let totalCents = 0;

  for (const rawItem of items) {
    const quantity = Number(rawItem.quantity || 0);
    const productId = rawItem.productId;

    if (!productId || !Number.isInteger(quantity) || quantity < 1) {
      return { error: "Each selected product must include a valid quantity." };
    }

    const product = getProductById(productId);
    if (!product) {
      return { error: "One or more products are invalid." };
    }

    const lineTotalCents = product.priceCents * quantity;
    totalCents += lineTotalCents;

    normalized.push({
      product,
      quantity,
      lineTotalCents
    });
  }

  return {
    items: normalized,
    totalCents
  };
}

function loadOrderItems(orderId) {
  return db.prepare(`
    SELECT product_id, product_name, quantity, unit_price_cents, line_total_cents
    FROM order_items
    WHERE order_id = ?
    ORDER BY id ASC
  `).all(orderId).map((item) => ({
    productId: item.product_id,
    productName: item.product_name,
    quantity: item.quantity,
    unitPrice: formatUsd(item.unit_price_cents),
    lineTotal: formatUsd(item.line_total_cents)
  }));
}

function mapOrderRow(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    adminSeen: row.admin_seen === 1,
    total: formatUsd(row.total_cents),
    paymentMethod: row.payment_method,
    status: row.status,
    phone: row.phone,
    notes: row.notes,
    createdAt: row.created_at,
    items: loadOrderItems(row.id)
  };
}

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET || !stripe) {
    return res.status(400).send("Webhook is not configured.");
  }

  const signature = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook error: ${error.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.metadata && session.metadata.orderId) {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?")
        .run("paid", Number(session.metadata.orderId));
    }
  }

  return res.json({ received: true });
});

app.use(express.json());

app.get("/api/admin/session", (req, res) => {
  return res.json({ authenticated: isValidAdminSession(parseCookies(req)[ADMIN_SESSION_COOKIE]) });
});

app.post("/api/admin/login", adminLoginLimiter, (req, res) => {
  const expectedPassword = getAdminPassword();
  const expectedSessionSecret = getAdminSessionSecret();
  if (!expectedPassword || !expectedSessionSecret) {
    return res.status(503).json({
      error: "Admin auth is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in .env."
    });
  }

  const password = String(req.body.password || "").trim();
  if (!safeCompare(password, expectedPassword)) {
    return res.status(401).json({ error: "Invalid admin password." });
  }

  if (!setAdminSessionCookie(res)) {
    return res.status(503).json({
      error: "Admin auth is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in .env."
    });
  }

  return res.json({ message: "Admin login successful." });
});

app.post("/api/admin/logout", (_req, res) => {
  clearAdminSessionCookie(res);
  return res.json({ message: "Admin logged out." });
});

app.get("/api/products", (_req, res) => {
  return res.json({ products });
});

app.get("/api/orders", (_req, res) => {
  const rows = db.prepare(`
    SELECT id, customer_name, admin_seen, total_cents, payment_method, status, phone, notes, created_at
    FROM orders
    ORDER BY id DESC
    LIMIT 20
  `).all();

  return res.json({
    orders: rows.map(mapOrderRow)
  });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const status = String(req.query.status || "").trim();
  const paymentMethod = String(req.query.paymentMethod || "").trim();
  const customer = String(req.query.customer || "").trim();
  const limitRaw = Number(req.query.limit || 100);
  const limit = Number.isInteger(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 500)
    : 100;

  const where = [];
  const values = [];

  if (status) {
    where.push("status = ?");
    values.push(status);
  }

  if (paymentMethod) {
    where.push("payment_method = ?");
    values.push(paymentMethod);
  }

  if (customer) {
    where.push("customer_name LIKE ?");
    values.push(`%${customer}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT id, customer_name, admin_seen, total_cents, payment_method, status, phone, notes, created_at
    FROM orders
    ${whereSql}
    ORDER BY id DESC
    LIMIT ?
  `).all(...values, limit);

  return res.json({
    count: rows.length,
    orders: rows.map(mapOrderRow)
  });
});

app.get("/api/admin/orders/:orderId", requireAdmin, (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id." });
  }

  const row = db.prepare(`
    SELECT id, customer_name, admin_seen, total_cents, payment_method, status, phone, notes, created_at
    FROM orders
    WHERE id = ?
  `).get(orderId);

  if (!row) {
    return res.status(404).json({ error: "Order not found." });
  }

  return res.json({ order: mapOrderRow(row) });
});

app.patch("/api/admin/orders/:orderId/status", requireAdmin, (req, res) => {
  const orderId = Number(req.params.orderId);
  const nextStatus = String(req.body.status || "").trim();

  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id." });
  }

  if (!allowedOrderStatuses.has(nextStatus)) {
    return res.status(400).json({
      error: "Invalid status. Use: awaiting_card_payment, awaiting_zelle, awaiting_cash, paid, ready_for_pickup, completed, cancelled."
    });
  }

  const update = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(nextStatus, orderId);
  if (update.changes === 0) {
    return res.status(404).json({ error: "Order not found." });
  }

  const row = db.prepare(`
    SELECT id, customer_name, admin_seen, total_cents, payment_method, status, phone, notes, created_at
    FROM orders
    WHERE id = ?
  `).get(orderId);

  return res.json({
    message: "Order status updated.",
    order: mapOrderRow(row)
  });
});

app.patch("/api/admin/orders/:orderId/open", requireAdmin, (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id." });
  }

  const update = db.prepare("UPDATE orders SET admin_seen = 1 WHERE id = ?").run(orderId);
  if (update.changes === 0) {
    return res.status(404).json({ error: "Order not found." });
  }

  const row = db.prepare(`
    SELECT id, customer_name, admin_seen, total_cents, payment_method, status, phone, notes, created_at
    FROM orders
    WHERE id = ?
  `).get(orderId);

  return res.json({
    message: "Order marked as opened.",
    order: mapOrderRow(row)
  });
});

app.get("/api/admin/summary", requireAdmin, (_req, res) => {
  const totalOrders = db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  const awaitingPayment = db.prepare(
    "SELECT COUNT(*) AS count FROM orders WHERE status IN ('awaiting_card_payment', 'awaiting_zelle', 'awaiting_cash')"
  ).get().count;
  const paid = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'paid'").get().count;
  const readyForPickup = db.prepare(
    "SELECT COUNT(*) AS count FROM orders WHERE status = 'ready_for_pickup'"
  ).get().count;
  const completed = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'completed'").get().count;
  const cancelled = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'cancelled'").get().count;
  const newOrders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE admin_seen = 0").get().count;

  const revenuePaidCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE status IN ('paid', 'ready_for_pickup', 'completed')"
  ).get().sum_cents;

  const revenueUnpaidCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE status IN ('awaiting_card_payment', 'awaiting_zelle', 'awaiting_cash')"
  ).get().sum_cents;

  const paidByZelleCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE payment_method = 'zelle' AND status IN ('paid', 'ready_for_pickup', 'completed')"
  ).get().sum_cents;

  const paidByCardCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE payment_method = 'card' AND status IN ('paid', 'ready_for_pickup', 'completed')"
  ).get().sum_cents;

  const paidByCashCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE payment_method = 'cash' AND status IN ('paid', 'ready_for_pickup', 'completed')"
  ).get().sum_cents;

  const awaitingByZelleCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE payment_method = 'zelle' AND status IN ('awaiting_zelle')"
  ).get().sum_cents;

  const awaitingByCardCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE payment_method = 'card' AND status IN ('awaiting_card_payment')"
  ).get().sum_cents;

  const awaitingByCashCents = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS sum_cents FROM orders WHERE payment_method = 'cash' AND status IN ('awaiting_cash')"
  ).get().sum_cents;

  return res.json({
    summary: {
      totalOrders,
      awaitingPayment,
      paid,
      readyForPickup,
      completed,
      cancelled,
      newOrders,
      revenuePaid: formatUsd(revenuePaidCents),
      revenueUnpaid: formatUsd(revenueUnpaidCents),
      paidByZelle: formatUsd(paidByZelleCents),
      paidByCard: formatUsd(paidByCardCents),
      paidByCash: formatUsd(paidByCashCents),
      awaitingByZelle: formatUsd(awaitingByZelleCents),
      awaitingByCard: formatUsd(awaitingByCardCents),
      awaitingByCash: formatUsd(awaitingByCashCents)
    }
  });
});

app.post("/api/orders", async (req, res) => {
  const { customerName, items, paymentMethod, phone, notes } = req.body;

  const cleanCustomerName = String(customerName || "").trim();
  const cleanPhone = String(phone || "").trim();
  const cleanNotes = String(notes || "").trim();

  if (!cleanCustomerName || !cleanPhone) {
    return res.status(400).json({
      error: "Customer name and phone number are required."
    });
  }

  if (!["card", "zelle", "cash"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Payment method must be card, zelle, or cash." });
  }

  const cart = validateCart(items);
  if (cart.error) {
    return res.status(400).json({ error: cart.error });
  }

  if (paymentMethod === "card" && !stripe) {
    return res.status(503).json({
      error: "Card checkout is not configured yet. Add STRIPE_SECRET_KEY to enable it."
    });
  }

  const initialStatus = paymentMethod === "card"
    ? "awaiting_card_payment"
    : paymentMethod === "zelle"
      ? "awaiting_zelle"
      : "awaiting_cash";

  const hasLegacyUserId = db.prepare("PRAGMA table_info(orders)").all()
    .some((column) => column.name === "user_id");

  let orderResult;
  if (hasLegacyUserId) {
    const guestEmail = "guest-checkout@tigris.local";
    let guest = db.prepare("SELECT id FROM users WHERE email = ?").get(guestEmail);
    if (!guest) {
      const insertGuest = db.prepare(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
      ).run("Guest Checkout", guestEmail, "guest-checkout");
      guest = { id: Number(insertGuest.lastInsertRowid) };
    }

    const insertLegacyOrder = db.prepare(`
      INSERT INTO orders (
        user_id,
        customer_name,
        admin_seen,
        total_cents,
        payment_method,
        status,
        address,
        phone,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    orderResult = insertLegacyOrder.run(
      guest.id,
      cleanCustomerName,
      0,
      cart.totalCents,
      paymentMethod,
      initialStatus,
      "",
      cleanPhone,
      cleanNotes
    );
  } else {
    const insertOrder = db.prepare(`
      INSERT INTO orders (
        customer_name,
        admin_seen,
        total_cents,
        payment_method,
        status,
        address,
        phone,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    orderResult = insertOrder.run(
      cleanCustomerName,
      0,
      cart.totalCents,
      paymentMethod,
      initialStatus,
      "",
      cleanPhone,
      cleanNotes
    );
  }

  const orderId = Number(orderResult.lastInsertRowid);

  const insertItem = db.prepare(`
    INSERT INTO order_items (
      order_id,
      product_id,
      product_name,
      quantity,
      unit_price_cents,
      line_total_cents
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const item of cart.items) {
    insertItem.run(
      orderId,
      item.product.id,
      item.product.name,
      item.quantity,
      item.product.priceCents,
      item.lineTotalCents
    );
  }

  if (paymentMethod === "zelle") {
    const message = buildOrderSummaryText(cart.items, cart.totalCents, cleanCustomerName);
    const whatsappLink = buildWhatsappLink(message);

    db.prepare("UPDATE orders SET whatsapp_link = ? WHERE id = ?").run(whatsappLink, orderId);

    return res.status(201).json({
      orderId,
      paymentMethod,
      status: "awaiting_zelle",
      total: formatUsd(cart.totalCents),
      zellePayee: process.env.ZELLE_PAYEE || "Set ZELLE_PAYEE in your .env",
      whatsappLink
    });
  }

  if (paymentMethod === "cash") {
    return res.status(201).json({
      orderId,
      paymentMethod,
      status: "awaiting_cash",
      total: formatUsd(cart.totalCents)
    });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${baseUrl}/?checkout=success&order=${orderId}`,
      cancel_url: `${baseUrl}/?checkout=cancelled&order=${orderId}`,
      payment_method_types: ["card"],
      metadata: {
        orderId: String(orderId)
      },
      line_items: cart.items.map((item) => ({
        quantity: item.quantity,
        price_data: {
          currency,
          product_data: {
            name: item.product.name
          },
          unit_amount: item.product.priceCents
        }
      }))
    });
  } catch (error) {
    console.error("Stripe checkout session creation failed:", error.message);
    return res.status(502).json({
      error: "Card checkout is temporarily unavailable. Verify your live Stripe key and account activation."
    });
  }

  db.prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ?").run(session.id, orderId);

  return res.status(201).json({
    orderId,
    paymentMethod,
    status: "awaiting_card_payment",
    total: formatUsd(cart.totalCents),
    checkoutUrl: session.url
  });
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.use((_req, res) => {
  return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(port, () => {
  // Startup info is intentionally concise for hosting logs.
  console.log(`Tigris Dates app running on ${baseUrl}`);
});
