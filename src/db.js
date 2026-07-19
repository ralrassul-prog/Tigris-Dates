const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "tigris-dates.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  admin_seen INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  card_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  fulfillment_method TEXT NOT NULL DEFAULT 'pickup',
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  notes TEXT,
  stripe_session_id TEXT,
  whatsapp_link TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS card_checkout_drafts (
  stripe_session_id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  notes TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  card_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  fulfillment_method TEXT NOT NULL DEFAULT 'pickup',
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
const hasCustomerName = orderColumns.some((col) => col.name === "customer_name");
const hasCustomerEmail = orderColumns.some((col) => col.name === "customer_email");
const hasLegacyUserId = orderColumns.some((col) => col.name === "user_id");
const hasAdminSeen = orderColumns.some((col) => col.name === "admin_seen");
const hasSubtotalCents = orderColumns.some((col) => col.name === "subtotal_cents");
const hasDeliveryFeeCents = orderColumns.some((col) => col.name === "delivery_fee_cents");
const hasCardFeeCents = orderColumns.some((col) => col.name === "card_fee_cents");
const hasFulfillmentMethod = orderColumns.some((col) => col.name === "fulfillment_method");

if (!hasCustomerName) {
  db.exec("ALTER TABLE orders ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''");
}

if (!hasCustomerEmail) {
  db.exec("ALTER TABLE orders ADD COLUMN customer_email TEXT NOT NULL DEFAULT ''");
}

if (!hasAdminSeen) {
  db.exec("ALTER TABLE orders ADD COLUMN admin_seen INTEGER NOT NULL DEFAULT 0");
  // Existing historical orders are treated as already seen to avoid a one-time inbox flood.
  db.exec("UPDATE orders SET admin_seen = 1");
}

if (!hasSubtotalCents) {
  db.exec("ALTER TABLE orders ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE orders SET subtotal_cents = total_cents");
}

if (!hasDeliveryFeeCents) {
  db.exec("ALTER TABLE orders ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0");
}

if (!hasCardFeeCents) {
  db.exec("ALTER TABLE orders ADD COLUMN card_fee_cents INTEGER NOT NULL DEFAULT 0");
}

if (!hasFulfillmentMethod) {
  db.exec("ALTER TABLE orders ADD COLUMN fulfillment_method TEXT NOT NULL DEFAULT 'pickup'");
}

const draftColumns = db.prepare("PRAGMA table_info(card_checkout_drafts)").all();
const hasDraftSubtotalCents = draftColumns.some((col) => col.name === "subtotal_cents");
const hasDraftDeliveryFeeCents = draftColumns.some((col) => col.name === "delivery_fee_cents");
const hasDraftCardFeeCents = draftColumns.some((col) => col.name === "card_fee_cents");
const hasDraftFulfillmentMethod = draftColumns.some((col) => col.name === "fulfillment_method");
const hasDraftAddress = draftColumns.some((col) => col.name === "address");

if (!hasDraftSubtotalCents) {
  db.exec("ALTER TABLE card_checkout_drafts ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE card_checkout_drafts SET subtotal_cents = total_cents");
}

if (!hasDraftDeliveryFeeCents) {
  db.exec("ALTER TABLE card_checkout_drafts ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0");
}

if (!hasDraftCardFeeCents) {
  db.exec("ALTER TABLE card_checkout_drafts ADD COLUMN card_fee_cents INTEGER NOT NULL DEFAULT 0");
}

if (!hasDraftFulfillmentMethod) {
  db.exec("ALTER TABLE card_checkout_drafts ADD COLUMN fulfillment_method TEXT NOT NULL DEFAULT 'pickup'");
}

if (!hasDraftAddress) {
  db.exec("ALTER TABLE card_checkout_drafts ADD COLUMN address TEXT NOT NULL DEFAULT ''");
}

let guestUserId = null;
if (hasLegacyUserId) {
  const guestEmail = "guest-checkout@tigris.local";
  const existingGuest = db.prepare("SELECT id FROM users WHERE email = ?").get(guestEmail);

  if (existingGuest) {
    guestUserId = existingGuest.id;
  } else {
    const guestInsert = db.prepare(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
    ).run("Guest Checkout", guestEmail, "guest-checkout");
    guestUserId = Number(guestInsert.lastInsertRowid);
  }
}

db.hasLegacyUserId = hasLegacyUserId;
db.guestUserId = guestUserId;

module.exports = db;
