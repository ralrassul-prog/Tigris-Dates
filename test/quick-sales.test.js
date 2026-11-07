const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tigris-register-test-"));
process.env.TIGRIS_DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = "register-test-only";
process.env.ADMIN_SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
const app = require("../src/server");
const db = require("../src/db");
const { getSalesTotals } = require("../src/quickSales");
let server;
let base;
let cookie;

async function request(url, body, authenticated = true, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

before(async () => {
  server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request("/api/admin/login", { password: process.env.ADMIN_PASSWORD }, false);
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const sale = (adjustmentCents = -500) => ({
  requestId: crypto.randomUUID(),
  items: [{ id: "mix-25", quantity: 2 }, { id: "honey-15", quantity: 1 }],
  adjustmentCents
});

test("quick sale endpoints require admin authentication", async () => {
  for (const body of [undefined, sale()]) {
    const { response } = await request("/api/admin/quick-sales", body, false);
    assert.equal(response.status, 401);
  }
});

test("catalog contains all approved presets and uncached live totals", async () => {
  const { response, data } = await request("/api/admin/quick-sales");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(data.presets.map(preset => [preset.name, preset.priceCents]), [
    ["Mix", 2500], ["Mix", 5000], ["Jumbo", 3000], ["Jumbo", 6000],
    ["Honey", 1500], ["Misc", 500], ["Misc", 1000], ["Misc", 10000]
  ]);
  assert.equal(data.totals.totalSalesCents, 0);
});

test("final sale enters walk-in sales and all financial totals exactly once", async () => {
  db.prepare("INSERT INTO expenses (name, amount_cents) VALUES ('Test expense', 1000)").run();
  const body = sale();
  const { response, data } = await request("/api/admin/quick-sales", body);
  assert.equal(response.status, 201);
  assert.equal(data.receipt.type, "walk_in");
  assert.equal(data.receipt.status, "completed");
  assert.equal(data.receipt.subtotalCents, 6500);
  assert.equal(data.receipt.adjustmentCents, -500);
  assert.equal(data.receipt.totalCents, 6000);
  assert.equal(data.receipt.salesBeforeCents, 0);
  assert.equal(data.receipt.salesAfterCents, 6000);
  assert.deepEqual(data.totals, { totalSalesCents: 6000, walkInSalesCents: 6000 });
  const summary = await request("/api/admin/summary");
  assert.equal(summary.data.summary.revenuePaid, "$60.00");
  assert.equal(summary.data.summary.walkInSales, "$60.00");
  assert.equal(summary.data.summary.netRevenuePaid, "$50.00");
  assert.deepEqual(summary.data.profit, { weekly: "$50.00", monthly: "$50.00", season: "$50.00" });
  assert.equal(summary.data.summary.totalOrders, 0, "Must not create a pre-order or double-count an order");
  const transactions = await request("/api/admin/manual-transactions");
  assert.match(transactions.data.transactions[0].description, /Mix \$25 x2; Honey \$15 x1; Discount \$5.00/);
  const retry = await request("/api/admin/quick-sales", { ...body, items: [...body.items].reverse() });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.receipt.id, data.receipt.id);
  assert.equal(getSalesTotals(db).totalSalesCents, 6000);
  const conflict = await request("/api/admin/quick-sales", { ...body, adjustmentCents: 0 });
  assert.equal(conflict.response.status, 409);
  assert.equal(getSalesTotals(db).totalSalesCents, 6000);
});

test("all eight presets, additions and cent precision are calculated by server", async () => {
  const catalog = await request("/api/admin/quick-sales");
  const { data } = await request("/api/admin/quick-sales", {
    requestId: crypto.randomUUID(),
    items: catalog.data.presets.map(preset => ({ id: preset.id, quantity: 1, priceCents: 1 })),
    adjustmentCents: 225,
    totalCents: 1
  });
  assert.equal(data.receipt.subtotalCents, 29500);
  assert.equal(data.receipt.totalCents, 29725);
});

test("invalid inputs do not change financials", async () => {
  const beforeTotals = getSalesTotals(db);
  for (const change of [
    { items: [] }, { items: [{ id: "unknown", quantity: 1 }] },
    { items: [{ id: "mix-25", quantity: 0 }] },
    { items: [{ id: "mix-25", quantity: -1 }] },
    { items: [{ id: "mix-25", quantity: 1.5 }] },
    { items: [{ id: "mix-25", quantity: 1000 }] },
    { items: [{ id: "mix-25", quantity: 1 }, { id: "mix-25", quantity: 1 }] },
    { adjustmentCents: -6500 }, { adjustmentCents: -6501 },
    { adjustmentCents: 1.5 }, { adjustmentCents: "500" },
    { adjustmentCents: Number.MAX_SAFE_INTEGER }, { adjustmentCents: null },
    { requestId: "not-an-id" }
  ]) {
    const result = await request("/api/admin/quick-sales", { ...sale(), ...change });
    assert.equal(result.response.status, 400, JSON.stringify(change));
    assert.equal(typeof result.data.error, "string");
  }
  assert.deepEqual(getSalesTotals(db), beforeTotals);
});

test("simultaneous duplicate requests create only one walk-in entry", async () => {
  const body = sale(0);
  const beforeTotals = getSalesTotals(db).totalSalesCents;
  const responses = await Promise.all([
    request("/api/admin/quick-sales", body),
    request("/api/admin/quick-sales", body)
  ]);
  assert.deepEqual(responses.map(result => result.response.status).sort(), [200, 201]);
  assert.equal(getSalesTotals(db).totalSalesCents, beforeTotals + 6500);
});

test("paid storefront sales combine with walk-ins but unpaid and cash adjustments do not", async () => {
  const beforeTotals = getSalesTotals(db);
  const insert = db.prepare("INSERT INTO orders (total_cents, payment_method, status, phone) VALUES (?, 'cash', ?, '')");
  insert.run(2500, "paid");
  insert.run(3000, "awaiting_cash");
  insert.run(5000, "cancelled");
  db.prepare("INSERT INTO manual_transactions (type, description, amount_cents) VALUES ('add', 'Test adjustment', 1000)").run();
  assert.deepEqual(getSalesTotals(db), {
    totalSalesCents: beforeTotals.totalSalesCents + 2500,
    walkInSalesCents: beforeTotals.walkInSalesCents
  });
  const summary = await request("/api/admin/summary");
  assert.equal(summary.data.summary.revenuePaid, `$${(getSalesTotals(db).totalSalesCents / 100).toFixed(2)}`);
});

test("profit periods include only walk-in sales in their date range", async () => {
  db.prepare("INSERT INTO manual_transactions (type, description, amount_cents, created_at) VALUES ('sale', 'Old sale', 10000, '2020-01-01')").run();
  const { data } = await request("/api/admin/summary");
  assert.equal(Number(data.profit.season.slice(1)) - Number(data.profit.weekly.slice(1)), 100);
  assert.equal(Number(data.profit.season.slice(1)) - Number(data.profit.monthly.slice(1)), 100);
});

test("deletion and accounting reset cannot cause an old request to record again", async () => {
  const body = sale();
  const first = await request("/api/admin/quick-sales", body);
  const deleted = await request(`/api/admin/manual-transactions/${first.data.receipt.transactionId}`, undefined, true, "DELETE");
  assert.equal(deleted.response.status, 200);
  const beforeTotals = getSalesTotals(db);
  const retry = await request("/api/admin/quick-sales", body);
  assert.equal(retry.data.receipt.voided, true);
  assert.deepEqual(getSalesTotals(db), beforeTotals);
  await request("/api/admin/reset", { confirmation: "RESET" });
  assert.equal(getSalesTotals(db).totalSalesCents, 0);
  const afterReset = await request("/api/admin/quick-sales", body);
  assert.equal(afterReset.data.replayed, true);
  assert.equal(afterReset.data.receipt.voided, true);
  assert.equal(getSalesTotals(db).totalSalesCents, 0);
  const fresh = await request("/api/admin/quick-sales", sale(225));
  assert.equal(fresh.data.receipt.totalCents, 6725);
  assert.equal(getSalesTotals(db).totalSalesCents, 6725);
});

test("receipt survives reopening SQLite and still prevents duplicates", async () => {
  const body = sale();
  const first = await request("/api/admin/quick-sales", body);
  const Database = require("better-sqlite3");
  const reopened = new Database(path.join(dataDir, "tigris-dates.db"));
  try {
    const { validateSale, recordQuickSale } = require("../src/quickSales");
    const retry = recordQuickSale(reopened, validateSale(body));
    assert.equal(retry.replayed, true);
    assert.equal(retry.receipt.id, first.data.receipt.id);
  } finally {
    reopened.close();
  }
});

test("receipt persistence failure rolls back the financial entry atomically", () => {
  const { validateSale, recordQuickSale } = require("../src/quickSales");
  const beforeTotals = getSalesTotals(db);
  db.exec(`CREATE TEMP TRIGGER block_receipt BEFORE INSERT ON quick_sale_receipts
    BEGIN SELECT RAISE(ABORT, 'Test receipt write failure'); END;`);
  try {
    assert.throws(() => recordQuickSale(db, validateSale(sale())), /Test receipt write failure/);
    assert.deepEqual(getSalesTotals(db), beforeTotals);
  } finally {
    db.exec("DROP TRIGGER block_receipt");
  }
});

test("register and installation assets are served without changing the storefront", async () => {
  for (const [url, type] of [
    ["/register/", "text/html"],
    ["/register/register.js", "javascript"],
    ["/register/register.css", "text/css"],
    ["/register/sw.js", "javascript"],
    ["/register/manifest.webmanifest", "manifest+json"],
    ["/register/icon-192.png", "image/png"],
    ["/register/icon-512.png", "image/png"],
    ["/register/icon-maskable-512.png", "image/png"],
    ["/", "text/html"],
    ["/admin.html", "text/html"]
  ]) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").includes(type), url);
    if (type === "image/png") {
      const buffer = Buffer.from(await response.arrayBuffer());
      const size = url.includes("192") ? 192 : 512;
      assert.equal(buffer.readUInt32BE(16), size);
      assert.equal(buffer.readUInt32BE(20), size);
    }
  }
  const manifest = await (await fetch(`${base}/register/manifest.webmanifest`)).json();
  assert.equal(manifest.start_url, "/register/");
  assert.equal(manifest.scope, "/register/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 3);
});
