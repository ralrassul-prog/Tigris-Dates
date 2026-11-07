const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tigris-financials-test-"));
process.env.TIGRIS_DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = "financials-test-only";
process.env.ADMIN_SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
const app = require("../src/server");
const db = require("../src/db");
const finance = require("../src/registerFinancials");
let server, base, cookie;
const API = "/api/admin/register-financials";
const reqId = () => crypto.randomUUID();
const settings = () => ({
  version: 2,
  mix: { pounds: 1000, costPerPoundCents: 260 },
  jumbo: { pounds: 500, costPerPoundCents: 380 }
});
async function request(url, body, auth = true, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${base}${url}`, {
    method, headers: { ...(auth ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
function clear() {
  for (const table of ["delivered_payments", "delivered_orders", "register_requests", "register_costs", "quick_sale_receipts", "manual_transactions", "expenses", "order_items", "orders"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}
function quick(paymentMethod = "cash", id = "mix-25") {
  return { requestId: reqId(), items: [{ id, quantity: 1 }], adjustmentCents: 0, paymentMethod };
}
function delivered(initialCents = 0) {
  return { requestId: reqId(), name: "Test Store", items: [{ id: "preset:mix-50", quantity: 5 }], initialCents, paymentMethod: "zelle" };
}
async function setupCosts() {
  const result = await request(`${API}/costs`, { requestId: reqId(), revision: 0, settings: settings() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
before(async () => {
  server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request("/api/admin/login", { password: process.env.ADMIN_PASSWORD }, false);
  cookie = login.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db.close(); fs.rmSync(dataDir, { recursive: true, force: true });
});

test("all financial endpoints require owner authentication", async () => {
  for (const [url, body] of [[API, undefined], [`${API}/costs`, {}], [`${API}/expenses`, {}], [`${API}/delivered`, {}], [`${API}/delivered/1/payments`, {}]]) {
    assert.equal((await request(url, body, false)).status, 401);
  }
});

test("unconfigured costs and absent sales do not invent profit or divide by zero", async () => {
  clear();
  const result = await request(API);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.data.complete, false);
  assert.equal(result.data.settings, null);
  assert.equal(result.data.dateCosts.mix.fullCentsPerPound, null);
  assert.equal(result.data.revenueCents, 0);
  assert.match(result.data.warnings.join(" "), /cost per pound/);
});

test("a date type with no purchases can be zero without inventing stock or costs", async () => {
  clear();
  const setup = settings(); setup.jumbo = { pounds: 0, costPerPoundCents: 0 };
  assert.equal((await request(`${API}/costs`, { requestId: reqId(), revision: 0, settings: setup })).status, 200);
  let result = (await request(API)).data;
  assert.equal(result.dateCosts.jumbo.remainingPounds, 0);
  assert.equal(result.dateCosts.jumbo.baseCentsPerPound, null);
  await request("/api/admin/quick-sales", quick("cash", "jumbo-30"));
  result = (await request(API)).data;
  assert.equal(result.complete, false);
  assert.equal(result.dateCosts.jumbo.fullCentsPerPound, null);
  assert.match(result.warnings.join(" "), /exceed recorded purchases/);
});

test("cash, walk-in, card, other and new Zelle sales reconcile without altering old method records", async () => {
  clear();
  const insert = db.prepare("INSERT INTO orders (total_cents, payment_method, status, phone) VALUES (?, ?, ?, '')");
  insert.run(1000, "card", "paid"); insert.run(2000, "cash", "completed"); insert.run(3000, "zelle", "ready_for_pickup");
  insert.run(4000, "other", "paid"); insert.run(9000, "zelle", "awaiting_zelle"); insert.run(9000, "cash", "cancelled");
  db.prepare("INSERT INTO manual_transactions (type, description, amount_cents) VALUES ('sale', 'Historical walk-in', 5000)").run();
  db.prepare("INSERT INTO manual_transactions (type, description, amount_cents) VALUES ('add', 'Not sales', 8000)").run();
  const sale = quick("zelle");
  assert.equal((await request("/api/admin/quick-sales", sale)).status, 201);
  assert.equal((await request("/api/admin/quick-sales", sale)).data.replayed, true);
  const result = (await request(API)).data;
  assert.deepEqual(result.paid, { cashCents: 12000, zelleCents: 5500 });
  assert.equal(result.revenueCents, 17500);
  assert.equal(db.prepare("SELECT payment_method FROM orders WHERE total_cents = 1000").get().payment_method, "card");
  assert.equal((await request("/api/admin/quick-sales", { ...sale, paymentMethod: "cash" })).status, 409);
  assert.equal((await request("/api/admin/quick-sales", { ...quick(), paymentMethod: "card" })).status, 400);
});

test("approved example compares date profit separately from honey and operating expenses", async () => {
  clear(); await setupCosts();
  await request("/api/admin/quick-sales", { ...quick(), items: [{ id: "mix-25", quantity: 40 }, { id: "jumbo-30", quantity: 20 }, { id: "honey-15", quantity: 20 }] });
  await request(`${API}/expenses`, { requestId: reqId(), name: "Rent", amountCents: 30000 });
  await request(`${API}/expenses`, { requestId: reqId(), name: "Utilities", amountCents: 8000 });
  const result = (await request(API)).data;
  assert.equal(result.complete, false, "Honey costs are intentionally excluded from the overall estimate");
  assert.equal(result.revenueCents, 190000);
  assert.equal(result.cogsCents, 90000);
  assert.equal(result.netCents, 62000);
  assert.equal(result.dateGrossProfitCents, 70000);
  assert.equal(result.dateProfitAfterExpensesCents, 32000);
  assert.equal(result.dateCosts.mix.grossProfitCents, 48000);
  assert.equal(result.dateCosts.jumbo.grossProfitCents, 22000);
  assert.equal(result.dateCosts.mix.profitCentsPerPound, 240);
  assert.equal(result.dateCosts.jumbo.profitCentsPerPound, 220);
  assert.equal(result.dateCosts.mix.baseCentsPerPound, 260);
  assert.equal(result.dateCosts.mix.remainingPounds, 800);
  assert.equal(result.dateCosts.jumbo.remainingPounds, 400);
  assert.equal(result.dateCosts.mix.fullCentsPerPound, 260);
});

test("partial receipts stay separate; final mixed payment closes into backend exactly once", async () => {
  clear(); await setupCosts();
  const body = delivered(10000);
  const created = await request(`${API}/delivered`, body);
  const id = created.data.id;
  assert.equal((await request(`${API}/delivered`, body)).data.id, id);
  let result = (await request(API)).data;
  assert.equal(result.revenueCents, 0); assert.equal(result.pendingBalanceCents, 15000);
  assert.equal(result.pendingReceivedCents, 10000); assert.equal(result.dateCosts.mix.remainingPounds, 950);
  const partial = { requestId: reqId(), amountCents: 5000, paymentMethod: "cash" };
  assert.equal((await request(`${API}/delivered/${id}/payments`, partial)).data.closed, false);
  assert.equal((await request(`${API}/delivered/${id}/payments`, partial)).data.replayed, true);
  result = (await request(API)).data;
  assert.equal(result.revenueCents, 0); assert.equal(result.pendingReceivedCents, 15000);
  const final = { requestId: reqId(), amountCents: 10000, paymentMethod: "zelle" };
  const concurrent = await Promise.all([request(`${API}/delivered/${id}/payments`, final), request(`${API}/delivered/${id}/payments`, final)]);
  assert.deepEqual(concurrent.map(item => item.data.replayed).sort(), [false, true]);
  result = (await request(API)).data;
  assert.equal(result.revenueCents, 25000); assert.equal(result.netCents, 12000);
  assert.deepEqual(result.paid, { cashCents: 5000, zelleCents: 20000 });
  assert.equal(result.pending.length, 0); assert.equal(result.closed.length, 1);
  assert.equal(result.dateCosts.mix.remainingPounds, 950, "Closure must not deduct delivered inventory twice");
  assert.equal((await request("/api/admin/summary")).data.summary.revenuePaid, "$250.00");
  assert.equal((await request("/api/admin/quick-sales")).data.totals.totalSalesCents, 25000);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_transactions").get().count, 1);
  assert.equal((await request(`${API}/delivered/${id}/payments`, { ...final, requestId: reqId() })).status, 409);
});

test("existing unpaid online order is linked, not duplicated, and keeps installment methods", async () => {
  clear(); await setupCosts();
  const id = Number(db.prepare("INSERT INTO orders (customer_name, total_cents, payment_method, status, phone, card_fee_cents) VALUES ('Online Test', 3000, 'cash', 'awaiting_cash', '', 100)").run().lastInsertRowid);
  db.prepare("INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents) VALUES (?, 'jumbo-5lb', 'Jumbo dates', 1, 3000, 3000)").run(id);
  const created = await request(`${API}/delivered`, { requestId: reqId(), sourceOrderId: id, initialCents: 1000, paymentMethod: "cash" });
  assert.equal(created.status, 200);
  const pendingId = created.data.id;
  assert.equal((await request(`${API}/delivered`, { requestId: reqId(), sourceOrderId: id, paymentMethod: "cash" })).status, 409);
  assert.equal((await request(`/api/admin/orders/${id}/status`, { status: "completed" }, true, "PATCH")).status, 409);
  assert.equal((await request(`/api/admin/orders/${id}`, undefined, true, "DELETE")).status, 409);
  await request(`${API}/delivered/${pendingId}/payments`, { requestId: reqId(), amountCents: 2000, paymentMethod: "zelle" });
  const result = (await request(API)).data;
  assert.equal(result.revenueCents, 3000); assert.equal(result.cogsCents, 1900); assert.equal(result.netCents, 1000);
  assert.deepEqual(result.paid, { cashCents: 1000, zelleCents: 2000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_transactions").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id = ?").get(id).status, "completed");
  assert.equal((await request(`/api/admin/orders/${id}/status`, { status: "awaiting_cash" }, true, "PATCH")).status, 409);
});

test("invalid, fractional, excessive and overpaid requests never change ledger", async () => {
  clear();
  for (const initial of [-1, 1.5, "100", 25000]) assert.equal((await request(`${API}/delivered`, { ...delivered(), initialCents: initial })).status, 400);
  assert.equal((await request(`${API}/delivered`, { ...delivered(), name: " " })).status, 400);
  assert.equal((await request(`${API}/delivered`, { ...delivered(), items: [] })).status, 400);
  assert.equal((await request(`${API}/delivered`, { ...delivered(), items: [{ id: "preset:mix-25", quantity: 1.5 }] })).status, 400);
  const id = (await request(`${API}/delivered`, delivered())).data.id;
  for (const amount of [-1, 0, 1.5, "100", 25001]) {
    assert.ok([400, 409].includes((await request(`${API}/delivered/${id}/payments`, { requestId: reqId(), amountCents: amount, paymentMethod: "cash" })).status));
  }
  assert.equal((await request(`${API}/delivered/bad/payments`, { requestId: reqId(), amountCents: 100, paymentMethod: "cash" })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM delivered_payments").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_transactions").get().count, 0);
});

test("cost optimistic concurrency, replay, and pending inventory limits are enforced", async () => {
  clear();
  await request(`${API}/delivered`, delivered());
  const body = { requestId: reqId(), revision: 0, settings: settings() };
  assert.equal((await request(`${API}/costs`, body)).status, 200);
  assert.equal((await request(`${API}/costs`, body)).data.replayed, true);
  assert.equal((await request(`${API}/costs`, { ...body, requestId: reqId() })).status, 409);
  const low = settings(); low.mix.pounds = 49;
  assert.equal((await request(`${API}/costs`, { requestId: reqId(), revision: 1, settings: low })).status, 400);
  const invalid = settings(); invalid.mix.costPerPoundCents = "100";
  assert.equal((await request(`${API}/costs`, { requestId: reqId(), revision: 1, settings: invalid })).status, 400);
  assert.equal((await request(API)).data.revision, 1);
});

test("missing historical details and unknown unit costs explicitly mark profit incomplete", async () => {
  clear(); await setupCosts();
  db.prepare("INSERT INTO manual_transactions (type, description, amount_cents) VALUES ('sale', 'Legacy sale', 10000)").run();
  await request("/api/admin/quick-sales", quick("cash", "misc-5"));
  const result = (await request(API)).data;
  assert.equal(result.complete, false);
  assert.match(result.warnings.join(" "), /historical sale/);
  assert.match(result.warnings.join(" "), /Misc/);
});

test("legacy quick receipts retain product cost details after migration", async () => {
  clear(); await setupCosts();
  const txnId = Number(db.prepare("INSERT INTO manual_transactions (type, description, amount_cents) VALUES ('sale', 'Old register', 2500)").run().lastInsertRowid);
  db.prepare("INSERT INTO quick_sale_receipts (request_id, transaction_id, payload_json, receipt_json) VALUES (?, ?, '{}', ?)")
    .run(reqId(), txnId, JSON.stringify({ items: [{ id: "mix-25", name: "Mix", quantity: 1, priceCents: 2500 }] }));
  finance.initialize(db);
  const result = (await request(API)).data;
  assert.equal(result.cogsCents, 1300); assert.equal(result.complete, true);
  assert.deepEqual(result.paid, { cashCents: 2500, zelleCents: 0 });
});

test("historical non-date products remain in sales but not the date profit comparison", async () => {
  clear(); await setupCosts();
  const id = Number(db.prepare("INSERT INTO orders (total_cents, payment_method, status, phone) VALUES (2000, 'cash', 'paid', '')").run().lastInsertRowid);
  db.prepare("INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents) VALUES (?, 'archived-treat', 'Archived treat', 2, 1000, 2000)").run(id);
  let result = (await request(API)).data;
  assert.equal(result.catalog.some(item => item.id === "product:archived-treat"), false);
  assert.equal(result.complete, false); assert.equal(result.cogsCents, 0); assert.equal(result.netCents, 2000);
  assert.equal(result.dateGrossProfitCents, 0);
  assert.match(result.warnings.join(" "), /Archived treat/);
});

test("existing purchase and freight settings convert to rates without modifying saved history", async () => {
  clear();
  const legacy = {
    mix: { pounds: 3, purchaseCents: 1000, freightCents: 100 },
    jumbo: { pounds: 500, purchaseCents: 180000, freightCents: 10000 },
    box5Cents: 100, box10Cents: 160, unitCosts: { "preset:honey-15": 800 }
  };
  db.prepare("INSERT INTO register_costs (id, settings_json, revision) VALUES (1, ?, 1)").run(JSON.stringify(legacy));
  let result = (await request(API)).data;
  assert.equal(result.settings.mix.costPerPoundCents, 1100 / 3);
  assert.equal(result.settings.jumbo.costPerPoundCents, 380);
  assert.equal(result.settings.box5Cents, undefined);
  assert.deepEqual(JSON.parse(db.prepare("SELECT settings_json FROM register_costs").get().settings_json), legacy);
  assert.equal((await request(`${API}/costs`, { requestId: reqId(), revision: 1, settings: result.settings })).status, 200);
  result = (await request(API)).data;
  assert.equal(result.settings.mix.costPerPoundCents, 1100 / 3, "Saving must not round migrated rates");
  assert.equal(result.settings.version, 2);
});

test("old client cost requests remain compatible while ignoring removed box and unit costs", async () => {
  clear();
  const legacy = { mix: { pounds: 1000, purchaseCents: 240000, freightCents: 20000 },
    jumbo: { pounds: 500, purchaseCents: 180000, freightCents: 10000 }, box5Cents: 100, box10Cents: 160, unitCosts: {} };
  const body = { requestId: reqId(), revision: 0, settings: legacy };
  assert.equal((await request(`${API}/costs`, body)).status, 200);
  assert.equal((await request(`${API}/costs`, body)).data.replayed, true);
  const result = (await request(API)).data;
  assert.equal(result.settings.mix.costPerPoundCents, 260);
  assert.equal(result.settings.unitCosts, undefined);
});

test("schema upgrade makes a pre-financial SQLite backup without changing historical ledger", () => {
  const Database = require("better-sqlite3");
  const backup = new Database(path.join(dataDir, "backups", "pre-register-financials.db"), { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivered_orders'").get(), undefined);
  assert.ok(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").get());
  backup.close();
  const before = db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  finance.initialize(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, before);
});

test("deleted expenses, deleted closed sales, and reset cannot be resurrected by recovery", async () => {
  clear();
  const expense = { requestId: reqId(), name: "Rent", amountCents: 1000 };
  const expenseId = (await request(`${API}/expenses`, expense)).data.id;
  await request(`/api/admin/expenses/${expenseId}`, undefined, true, "DELETE");
  assert.equal((await request(`${API}/expenses`, expense)).status, 410);
  const body = delivered(), id = (await request(`${API}/delivered`, body)).data.id;
  const payment = { requestId: reqId(), amountCents: 25000, paymentMethod: "cash" };
  await request(`${API}/delivered/${id}/payments`, payment);
  const txn = db.prepare("SELECT transaction_id FROM delivered_orders WHERE id = ?").get(id).transaction_id;
  await request(`/api/admin/manual-transactions/${txn}`, undefined, true, "DELETE");
  assert.equal((await request(`${API}/delivered/${id}/payments`, payment)).status, 410);
  assert.equal((await request(`${API}/delivered`, body)).status, 410);
  await request("/api/admin/reset", { confirmation: "RESET" });
  assert.equal((await request(API)).data.revenueCents, 0);
  assert.equal((await request(API)).data.pending.length, 0);
  assert.equal((await request(`${API}/delivered`, body)).status, 410);
});

test("request persistence failure rolls back payments and sales atomically", async () => {
  clear();
  const id = (await request(`${API}/delivered`, delivered())).data.id;
  db.exec("CREATE TRIGGER financial_request_failure BEFORE INSERT ON register_requests BEGIN SELECT RAISE(ABORT, 'Test receipt failure'); END");
  const result = await request(`${API}/delivered/${id}/payments`, { requestId: reqId(), amountCents: 25000, paymentMethod: "cash" });
  assert.equal(result.status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM delivered_payments").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM manual_transactions").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM delivered_orders WHERE id = ?").get(id).status, "pending");
  db.exec("DROP TRIGGER financial_request_failure");
});
