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
  total_cents INTEGER NOT NULL,
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
`);

const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
const hasCustomerName = orderColumns.some((col) => col.name === "customer_name");
const hasCustomerEmail = orderColumns.some((col) => col.name === "customer_email");
const hasLegacyUserId = orderColumns.some((col) => col.name === "user_id");
const hasAdminSeen = orderColumns.some((col) => col.name === "admin_seen");

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
