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
const DELIVERY_FEE_CENTS = Math.max(0, Math.round(Number(process.env.DELIVERY_FEE_CENTS || 500)));
const CARD_FEE_FIXED_CENTS = Math.max(0, Math.round(Number(process.env.STRIPE_CARD_FEE_FIXED_CENTS || 30)));
const CARD_FEE_MODE = String(process.env.STRIPE_CARD_FEE_MODE || "gross_up").trim().toLowerCase();
const CARD_FEE_PERCENT = (() => {
  const raw = Number(process.env.STRIPE_CARD_FEE_PERCENT || 2.9);
  if (!Number.isFinite(raw) || raw < 0) {
    return 0.029;
  }

  return raw > 1 ? raw / 100 : raw;
})();
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

function buildOrderSummaryText(items, totalCents, customerName, options = {}) {
  const deliveryFeeCents = Number(options.deliveryFeeCents || 0);
  const paymentMethod = String(options.paymentMethod || "").trim();
  const fulfillmentMethod = String(options.fulfillmentMethod || "pickup").trim();
  const address = String(options.address || "").trim();
  const phone = String(options.phone || "").trim();
  const lines = [
    "New Tigris Dates order",
    `Customer: ${customerName}`,
    "Items:"
  ];

  if (phone) {
    lines.push(`Phone: ${phone}`);
  }

  for (const item of items) {
    lines.push(`- ${item.quantity} x ${item.product.name} (${formatUsd(item.lineTotalCents)})`);
  }

  if (deliveryFeeCents > 0) {
    lines.push(`Delivery: ${formatUsd(deliveryFeeCents)}`);
  }

  if (fulfillmentMethod === "delivery") {
    lines.push("Fulfillment: Delivery");
    if (address) {
      lines.push(`Address: ${address}`);
    }
  } else {
    lines.push("Fulfillment: Pickup");
  }

  lines.push(`Total: ${formatUsd(totalCents)}`);
  if (paymentMethod) {
    lines.push(`Payment: ${paymentMethod}`);
  }

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

function calculateCardFeeCents(baseCents) {
  if (!Number.isFinite(baseCents) || baseCents <= 0 || CARD_FEE_PERCENT <= 0) {
    return 0;
  }

  if (CARD_FEE_MODE === "simple") {
    return Math.max(0, Math.round((baseCents * CARD_FEE_PERCENT) + CARD_FEE_FIXED_CENTS));
  }

  if (CARD_FEE_PERCENT >= 1) {
    return Math.max(0, Math.round((baseCents * CARD_FEE_PERCENT) + CARD_FEE_FIXED_CENTS));
  }

  const grossedUpTotalCents = Math.round((baseCents + CARD_FEE_FIXED_CENTS) / (1 - CARD_FEE_PERCENT));
  return Math.max(0, grossedUpTotalCents - baseCents);
}

function buildPricingBreakdown(subtotalCents, fulfillmentMethod, paymentMethod) {
  const safeSubtotal = Number.isFinite(subtotalCents) ? Math.max(0, Math.round(subtotalCents)) : 0;
  const deliveryFeeCents = fulfillmentMethod === "delivery" ? DELIVERY_FEE_CENTS : 0;
  const preCardTotalCents = safeSubtotal + deliveryFeeCents;
  const cardFeeCents = paymentMethod === "card" ? calculateCardFeeCents(preCardTotalCents) : 0;
  const totalCents = preCardTotalCents + cardFeeCents;

  return {
    subtotalCents: safeSubtotal,
    deliveryFeeCents,
    cardFeeCents,
    totalCents
  };
}

function saveCardCheckoutDraft(sessionId, customerName, phone, address, notes, cart, pricing, fulfillmentMethod) {
  db.prepare(`
    INSERT INTO card_checkout_drafts (
      stripe_session_id,
      customer_name,
      phone,
      address,
      notes,
      subtotal_cents,
      delivery_fee_cents,
      card_fee_cents,
      total_cents,
      fulfillment_method,
      items_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_session_id) DO UPDATE SET
      customer_name = excluded.customer_name,
      phone = excluded.phone,
      address = excluded.address,
      notes = excluded.notes,
      subtotal_cents = excluded.subtotal_cents,
      delivery_fee_cents = excluded.delivery_fee_cents,
      card_fee_cents = excluded.card_fee_cents,
      total_cents = excluded.total_cents,
      fulfillment_method = excluded.fulfillment_method,
      items_json = excluded.items_json
  `).run(
    sessionId,
    customerName,
    phone,
    address,
    notes,
    pricing.subtotalCents,
    pricing.deliveryFeeCents,
    pricing.cardFeeCents,
    pricing.totalCents,
    fulfillmentMethod,
    JSON.stringify(cart.items.map((item) => ({
      productId: item.product.id,
      quantity: item.quantity
    })))
  );
}

function loadCardCheckoutDraft(sessionId) {
  return db.prepare(`
    SELECT stripe_session_id, customer_name, phone, address, notes, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, items_json
    FROM card_checkout_drafts
    WHERE stripe_session_id = ?
  `).get(sessionId);
}

function deleteCardCheckoutDraft(sessionId) {
  db.prepare("DELETE FROM card_checkout_drafts WHERE stripe_session_id = ?").run(sessionId);
}

function createOrderWithItems({
  customerName,
  phone,
  address = "",
  notes,
  paymentMethod,
  status,
  cart,
  subtotalCents = cart.totalCents,
  deliveryFeeCents = 0,
  cardFeeCents = 0,
  totalCents = subtotalCents + deliveryFeeCents + cardFeeCents,
  fulfillmentMethod = "pickup",
  stripeSessionId = null,
  whatsappLink = null
}) {
  let orderResult;

  if (db.hasLegacyUserId) {
    const insertLegacyOrder = db.prepare(`
      INSERT INTO orders (
        user_id,
        customer_name,
        admin_seen,
        subtotal_cents,
        delivery_fee_cents,
        card_fee_cents,
        total_cents,
        fulfillment_method,
        payment_method,
        status,
        address,
        phone,
        notes,
        stripe_session_id,
        whatsapp_link
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    orderResult = insertLegacyOrder.run(
      db.guestUserId,
      customerName,
      0,
      subtotalCents,
      deliveryFeeCents,
      cardFeeCents,
      totalCents,
      fulfillmentMethod,
      paymentMethod,
      status,
      address,
      phone,
      notes,
      stripeSessionId,
      whatsappLink
    );
  } else {
    const insertOrder = db.prepare(`
      INSERT INTO orders (
        customer_name,
        admin_seen,
        subtotal_cents,
        delivery_fee_cents,
        card_fee_cents,
        total_cents,
        fulfillment_method,
        payment_method,
        status,
        address,
        phone,
        notes,
        stripe_session_id,
        whatsapp_link
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    orderResult = insertOrder.run(
      customerName,
      0,
      subtotalCents,
      deliveryFeeCents,
      cardFeeCents,
      totalCents,
      fulfillmentMethod,
      paymentMethod,
      status,
      address,
      phone,
      notes,
      stripeSessionId,
      whatsappLink
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

  return orderId;
}

function persistPaidCardOrderFromDraft(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return { created: false, reason: "invalid_session_id" };
  }

  const existingOrder = db.prepare("SELECT id FROM orders WHERE stripe_session_id = ?").get(normalizedSessionId);
  if (existingOrder) {
    deleteCardCheckoutDraft(normalizedSessionId);
    return {
      created: false,
      alreadyConfirmed: true,
      orderId: Number(existingOrder.id)
    };
  }

  const draft = loadCardCheckoutDraft(normalizedSessionId);
  if (!draft) {
    return { created: false, reason: "draft_not_found" };
  }

  let rawItems;
  try {
    rawItems = JSON.parse(draft.items_json);
  } catch (_error) {
    deleteCardCheckoutDraft(normalizedSessionId);
    return { created: false, reason: "invalid_draft_json" };
  }

  const cart = validateCart(rawItems);
  if (cart.error) {
    deleteCardCheckoutDraft(normalizedSessionId);
    return { created: false, reason: "invalid_draft_items" };
  }

  const subtotalCents = Number.isFinite(Number(draft.subtotal_cents))
    ? Number(draft.subtotal_cents)
    : cart.totalCents;
  const deliveryFeeCents = Number.isFinite(Number(draft.delivery_fee_cents))
    ? Math.max(0, Number(draft.delivery_fee_cents))
    : 0;
  const cardFeeCents = Number.isFinite(Number(draft.card_fee_cents))
    ? Math.max(0, Number(draft.card_fee_cents))
    : 0;
  const totalCents = Number.isFinite(Number(draft.total_cents))
    ? Math.max(0, Number(draft.total_cents))
    : subtotalCents + deliveryFeeCents + cardFeeCents;
  const fulfillmentMethod = String(draft.fulfillment_method || "pickup").toLowerCase() === "delivery"
    ? "delivery"
    : "pickup";
  const address = String(draft.address || "").trim();
  const whatsappSummary = buildOrderSummaryText(cart.items, totalCents, draft.customer_name, {
    deliveryFeeCents,
    paymentMethod: "Card",
    fulfillmentMethod,
    address,
    phone: draft.phone
  });
  const whatsappLink = buildWhatsappLink(whatsappSummary);

  let createdOrderId = 0;
  const persistPaidCardOrder = db.transaction(() => {
    createdOrderId = createOrderWithItems({
      customerName: draft.customer_name,
      phone: draft.phone,
      address,
      notes: draft.notes || "",
      paymentMethod: "card",
      status: "paid",
      cart,
      subtotalCents,
      deliveryFeeCents,
      cardFeeCents,
      totalCents,
      fulfillmentMethod,
      whatsappLink,
      stripeSessionId: normalizedSessionId
    });

    deleteCardCheckoutDraft(normalizedSessionId);
  });

  persistPaidCardOrder();

  return {
    created: true,
    alreadyConfirmed: false,
    orderId: Number(createdOrderId)
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
    subtotal: formatUsd(row.subtotal_cents || row.total_cents),
    deliveryFee: formatUsd(row.delivery_fee_cents || 0),
    cardFee: formatUsd(row.card_fee_cents || 0),
    total: formatUsd(row.total_cents),
    fulfillmentMethod: row.fulfillment_method || "pickup",
    paymentMethod: row.payment_method,
    fulfillmentMethod: row.fulfillment_method || "pickup",
    status: row.status,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    whatsappLink: row.whatsapp_link,
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
    const sessionId = String(session.id || "");
    persistPaidCardOrderFromDraft(sessionId);

    if (session.metadata && session.metadata.orderId) {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?")
        .run("paid", Number(session.metadata.orderId));
    }

    return res.json({ received: true });
  }

  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    deleteCardCheckoutDraft(String(session.id || ""));
  }

  return res.json({ received: true });
});

app.use(express.json());

app.post("/api/orders/confirm-card-session", async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required." });
  }

  if (!stripe) {
    return res.status(503).json({ error: "Card checkout is not configured." });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    return res.status(400).json({ error: "Invalid Stripe checkout session." });
  }

  if (session.mode !== "payment") {
    return res.status(400).json({ error: "Unsupported checkout session mode." });
  }

  if (session.payment_status !== "paid") {
    return res.status(409).json({ error: "Card payment is not completed yet." });
  }

  const result = persistPaidCardOrderFromDraft(sessionId);
  if (result.reason === "draft_not_found" && !result.alreadyConfirmed) {
    return res.status(404).json({
      error: "No pending order draft was found for this checkout session."
    });
  }

  if (!result.created && !result.alreadyConfirmed) {
    return res.status(422).json({
      error: "Unable to finalize this card order."
    });
  }

  return res.json({
    message: result.alreadyConfirmed ? "Order already confirmed." : "Card order confirmed.",
    alreadyConfirmed: Boolean(result.alreadyConfirmed),
    orderId: result.orderId,
    order: mapOrderRow(db.prepare(`
      SELECT id, customer_name, admin_seen, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, payment_method, status, address, phone, notes, whatsapp_link, created_at
      FROM orders
      WHERE id = ?
    `).get(result.orderId))
  });
});

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
    SELECT id, customer_name, admin_seen, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, payment_method, status, address, phone, notes, created_at
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
    SELECT id, customer_name, admin_seen, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, payment_method, status, address, phone, notes, created_at
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
    SELECT id, customer_name, admin_seen, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, payment_method, status, address, phone, notes, created_at
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
    SELECT id, customer_name, admin_seen, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, payment_method, status, address, phone, notes, created_at
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
    SELECT id, customer_name, admin_seen, subtotal_cents, delivery_fee_cents, card_fee_cents, total_cents, fulfillment_method, payment_method, status, address, phone, notes, created_at
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
  const { customerName, items, paymentMethod, fulfillmentMethod, phone, address, notes } = req.body;

  const cleanCustomerName = String(customerName || "").trim();
  const cleanPhone = String(phone || "").trim();
  const cleanAddress = String(address || "").trim();
  const cleanNotes = String(notes || "").trim();

  if (!cleanCustomerName || !cleanPhone) {
    return res.status(400).json({
      error: "Customer name and phone number are required."
    });
  }

  if (!["card", "zelle", "cash"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Payment method must be card, zelle, or cash." });
  }

  const cleanFulfillmentMethod = String(fulfillmentMethod || "pickup").trim().toLowerCase();
  if (!["pickup", "delivery"].includes(cleanFulfillmentMethod)) {
    return res.status(400).json({ error: "Fulfillment method must be pickup or delivery." });
  }

  if (cleanFulfillmentMethod === "delivery" && !cleanAddress) {
    return res.status(400).json({ error: "Delivery address is required for delivery orders." });
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

  const pricing = buildPricingBreakdown(cart.totalCents, cleanFulfillmentMethod, paymentMethod);

  const initialStatus = paymentMethod === "zelle"
      ? "awaiting_zelle"
      : "awaiting_cash";

  if (paymentMethod === "zelle") {
    const whatsappMessage = buildOrderSummaryText(cart.items, pricing.totalCents, cleanCustomerName, {
      deliveryFeeCents: pricing.deliveryFeeCents,
      paymentMethod: "Zelle",
      fulfillmentMethod: cleanFulfillmentMethod,
      address: cleanAddress,
      phone: cleanPhone
    });
    const whatsappLink = buildWhatsappLink(whatsappMessage);

    const orderId = createOrderWithItems({
      customerName: cleanCustomerName,
      phone: cleanPhone,
      address: cleanAddress,
      notes: cleanNotes,
      paymentMethod,
      status: initialStatus,
      cart,
      subtotalCents: pricing.subtotalCents,
      deliveryFeeCents: pricing.deliveryFeeCents,
      totalCents: pricing.totalCents,
      fulfillmentMethod: cleanFulfillmentMethod,
      whatsappLink
    });

    return res.status(201).json({
      orderId,
      paymentMethod,
      fulfillmentMethod: cleanFulfillmentMethod,
      status: "awaiting_zelle",
      subtotal: formatUsd(pricing.subtotalCents),
      deliveryFee: formatUsd(pricing.deliveryFeeCents),
      total: formatUsd(pricing.totalCents),
      zellePayee: process.env.ZELLE_PAYEE || "Set ZELLE_PAYEE in your .env",
      whatsappLink
    });
  }

  if (paymentMethod === "cash") {
    const whatsappMessage = buildOrderSummaryText(cart.items, pricing.totalCents, cleanCustomerName, {
      deliveryFeeCents: pricing.deliveryFeeCents,
      paymentMethod: "Cash",
      fulfillmentMethod: cleanFulfillmentMethod,
      address: cleanAddress,
      phone: cleanPhone
    });
    const whatsappLink = buildWhatsappLink(whatsappMessage);

    const orderId = createOrderWithItems({
      customerName: cleanCustomerName,
      phone: cleanPhone,
      address: cleanAddress,
      notes: cleanNotes,
      paymentMethod,
      status: initialStatus,
      cart,
      subtotalCents: pricing.subtotalCents,
      deliveryFeeCents: pricing.deliveryFeeCents,
      totalCents: pricing.totalCents,
      fulfillmentMethod: cleanFulfillmentMethod,
      whatsappLink
    });

    return res.status(201).json({
      orderId,
      paymentMethod,
      fulfillmentMethod: cleanFulfillmentMethod,
      status: "awaiting_cash",
      subtotal: formatUsd(pricing.subtotalCents),
      deliveryFee: formatUsd(pricing.deliveryFeeCents),
      total: formatUsd(pricing.totalCents),
      whatsappLink
    });
  }

  const cardCheckoutLineItems = [
    ...cart.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency,
        product_data: {
          name: item.product.name
        },
        unit_amount: item.product.priceCents
      }
    }))
  ];

  if (pricing.deliveryFeeCents > 0) {
    cardCheckoutLineItems.push({
      quantity: 1,
      price_data: {
        currency,
        product_data: {
          name: "Delivery fee"
        },
        unit_amount: pricing.deliveryFeeCents
      }
    });
  }

  if (pricing.cardFeeCents > 0) {
    cardCheckoutLineItems.push({
      quantity: 1,
      price_data: {
        currency,
        product_data: {
          name: "Card processing fee"
        },
        unit_amount: pricing.cardFeeCents
      }
    });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
      payment_method_types: ["card"],
      line_items: cardCheckoutLineItems
    });
  } catch (error) {
    console.error("Stripe checkout session creation failed:", error.message);
    return res.status(502).json({
      error: "Card checkout is temporarily unavailable. Verify your live Stripe key and account activation."
    });
  }

  saveCardCheckoutDraft(
    session.id,
    cleanCustomerName,
    cleanPhone,
    cleanAddress,
    cleanNotes,
    cart,
    pricing,
    cleanFulfillmentMethod
  );

  return res.status(201).json({
    paymentMethod,
    fulfillmentMethod: cleanFulfillmentMethod,
    status: "pending_checkout",
    subtotal: formatUsd(pricing.subtotalCents),
    deliveryFee: formatUsd(pricing.deliveryFeeCents),
    cardFee: formatUsd(pricing.cardFeeCents),
    total: formatUsd(pricing.totalCents),
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
