const { presets, MAX_QUANTITY, MAX_SALE_CENTS } = require("./quickSales");

const PAID = new Set(["paid", "ready_for_pickup", "completed"]);
const UNPAID = new Set(["awaiting_cash", "awaiting_zelle", "awaiting_card_payment"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const groupPayment = method => method === "zelle" ? "zelle" : "cash";

function initialize(db) {
  const columns = db.prepare("PRAGMA table_info(manual_transactions)").all();
  if (!columns.some(column => column.name === "payment_method")) {
    db.exec("ALTER TABLE manual_transactions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
  }
  if (!columns.some(column => column.name === "items_json")) {
    db.exec("ALTER TABLE manual_transactions ADD COLUMN items_json TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS register_costs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS delivered_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total_cents INTEGER NOT NULL CHECK (total_cents > 0),
      source_order_id INTEGER UNIQUE,
      transaction_id INTEGER UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'closed', 'voided')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS delivered_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivered_order_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'zelle')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS delivered_payments_order ON delivered_payments(delivered_order_id);
    CREATE TABLE IF NOT EXISTS register_requests (
      request_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      voided INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function cents(value, label, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_SALE_CENTS) {
    fail(`${label} must be ${allowZero ? "zero or " : ""}a positive amount in whole cents, up to $999,999.99.`);
  }
  return value;
}

function idempotent(db, kind, body, action) {
  if (!body || !UUID.test(body.requestId || "")) fail("A valid recovery request ID is required.");
  const payload = JSON.stringify({ kind, body });
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM register_requests WHERE request_id = ?").get(body.requestId);
    if (existing) {
      if (existing.payload_json !== payload) fail("This request ID already belongs to a different operation.", 409);
      if (existing.voided) fail("This saved operation was removed in admin. It will not be recorded again.", 410);
      return { ...JSON.parse(existing.response_json), replayed: true };
    }
    const result = action();
    db.prepare("INSERT INTO register_requests (request_id, payload_json, response_json, kind, entity_id) VALUES (?, ?, ?, ?, ?)")
      .run(body.requestId, payload, JSON.stringify(result), kind, result.id);
    return { ...result, replayed: false };
  }).immediate();
}

function itemCatalog(db) {
  const shortcutItems = presets.map(item => ({
    id: `preset:${item.id}`, name: `${item.name} $${item.priceCents / 100}`, priceCents: item.priceCents,
    kind: item.id.startsWith("mix-") ? "mix" : item.id.startsWith("jumbo-") ? "jumbo" : "unit",
    lbs: ["mix-25", "jumbo-30"].includes(item.id) ? 5 : ["mix-50", "jumbo-60"].includes(item.id) ? 10 : 0
  }));
  const products = db.prepare("SELECT id, name, price_cents, weight_label, type_label FROM products ORDER BY sort_order, id").all();
  return [...shortcutItems, ...products.map(item => {
    const text = `${item.id} ${item.name} ${item.type_label}`.toLowerCase();
    const weight = /(\d+(?:\.\d+)?)\s*lb/i.exec(`${item.weight_label} ${item.name} ${item.id}`);
    const kind = /jumbo/.test(text) ? "jumbo" : /mix/.test(text) ? "mix" : "unit";
    const lbs = kind !== "unit" && weight && [5, 10].includes(Number(weight[1])) ? Number(weight[1]) : 0;
    return { id: `product:${item.id}`, name: item.name, priceCents: item.price_cents, kind: lbs ? kind : "unit", lbs };
  })];
}

function currentSettings(db) {
  const row = db.prepare("SELECT * FROM register_costs WHERE id = 1").get();
  const saved = row ? JSON.parse(row.settings_json) : null;
  if (!saved || saved.version === 2) return { revision: row ? row.revision : 0, settings: saved };
  const settings = { version: 2 };
  for (const kind of ["mix", "jumbo"]) {
    settings[kind] = {
      pounds: saved[kind].pounds,
      costPerPoundCents: saved[kind].pounds ? (saved[kind].purchaseCents + saved[kind].freightCents) / saved[kind].pounds : 0
    };
  }
  return { revision: row.revision, settings };
}

function saveCosts(db, body) {
  if (!body || typeof body.settings !== "object" || !body.settings) fail("Enter pounds purchased and cost per pound.");
  const settings = { version: 2 };
  for (const kind of ["mix", "jumbo"]) {
    const input = body.settings[kind];
    if (!input || !Number.isFinite(input.pounds) || input.pounds < 0 || input.pounds > 999999.99) {
      fail(`Enter nonnegative cumulative purchased pounds for ${kind}.`);
    }
    settings[kind] = {
      pounds: input.pounds,
      costPerPoundCents: input.costPerPoundCents === undefined
        ? (cents(input.purchaseCents, `${kind} purchase`) + cents(input.freightCents, `${kind} freight`)) / (input.pounds || 1)
        : input.costPerPoundCents
    };
    if (!Number.isFinite(settings[kind].costPerPoundCents) || settings[kind].costPerPoundCents < 0 || settings[kind].costPerPoundCents > MAX_SALE_CENTS) {
      fail(`Enter a nonnegative cost per pound for ${kind}, up to $999,999.99.`);
    }
  }
  return idempotent(db, "costs", body, () => {
    const current = currentSettings(db);
    if (body.revision !== current.revision) fail("Costs were edited on another device. Refresh before saving again.", 409);
    const financials = getFinancials(db);
    for (const kind of ["mix", "jumbo"]) {
      if (settings[kind].pounds < financials.dateCosts[kind].deliveredPounds) {
        fail(`${kind} purchased pounds cannot be less than ${financials.dateCosts[kind].deliveredPounds} known delivered pounds.`);
      }
    }
    db.prepare(`INSERT INTO register_costs (id, settings_json, revision) VALUES (1, ?, 1)
      ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, revision = register_costs.revision + 1`)
      .run(JSON.stringify(settings));
    return { id: 1, message: "Costs saved. All-time estimates recalculated.", ...currentSettings(db) };
  });
}

function paymentsFor(db, id) {
  return db.prepare("SELECT amount_cents AS amountCents, payment_method AS method, created_at AS createdAt FROM delivered_payments WHERE delivered_order_id = ? ORDER BY id").all(id);
}

function pendingOrders(db) {
  return db.prepare("SELECT * FROM delivered_orders WHERE status != 'voided' ORDER BY id DESC").all().map(row => {
    const payments = paymentsFor(db, row.id);
    const receivedCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    return { id: row.id, name: row.customer_name, items: JSON.parse(row.items_json), totalCents: row.total_cents,
      sourceOrderId: row.source_order_id, status: row.status, createdAt: row.created_at, closedAt: row.closed_at,
      receivedCents, balanceCents: row.total_cents - receivedCents, payments };
  });
}

function createDelivered(db, body) {
  return idempotent(db, "delivered-order", body, () => {
    let name, items, total, sourceId = null;
    if (body.sourceOrderId !== undefined && body.sourceOrderId !== null) {
      if (!Number.isSafeInteger(body.sourceOrderId) || body.sourceOrderId < 1) fail("Choose a valid existing order.");
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(body.sourceOrderId);
      if (!order || !UNPAID.has(order.status)) fail("Only an existing unpaid order can be marked delivered.", 409);
      if (db.prepare("SELECT id FROM delivered_orders WHERE source_order_id = ?").get(order.id)) fail("This order is already tracked.", 409);
      name = order.customer_name || `Order #${order.id}`;
      items = db.prepare("SELECT product_id, product_name, quantity, unit_price_cents FROM order_items WHERE order_id = ?").all(order.id)
        .map(item => ({ id: `product:${item.product_id}`, name: item.product_name, quantity: item.quantity, priceCents: item.unit_price_cents }));
      total = order.total_cents;
      sourceId = order.id;
    } else {
      name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 80) fail("Enter a customer or store name up to 80 characters.");
      const catalog = itemCatalog(db);
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) fail("Add between 1 and 40 products.");
      const seen = new Set();
      items = body.items.map(item => {
        const product = item && catalog.find(product => product.id === item.id);
        if (!product || seen.has(item.id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
          fail("Choose valid products with distinct entries and quantities from 1 to 999.");
        }
        seen.add(item.id);
        return { ...product, quantity: item.quantity };
      });
      const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
      total = body.totalCents === undefined ? subtotal : cents(body.totalCents, "Delivered order total", false);
    }
    cents(total, "Delivered order total", false);
    if (!items.length) fail("The existing order has no product details. Correct it in admin first.");
    const initial = cents(body.initialCents === undefined ? 0 : body.initialCents, "Initial payment");
    if (initial >= total) fail("Fully paid orders belong in the sales register. Initial payment must be less than the order total.");
    if (!["cash", "zelle"].includes(body.paymentMethod)) fail("Choose Cash or Zelle.");
    const result = db.prepare("INSERT INTO delivered_orders (customer_name, items_json, total_cents, source_order_id) VALUES (?, ?, ?, ?)")
      .run(name, JSON.stringify(items), total, sourceId);
    const id = Number(result.lastInsertRowid);
    if (initial) db.prepare("INSERT INTO delivered_payments (delivered_order_id, amount_cents, payment_method) VALUES (?, ?, ?)").run(id, initial, body.paymentMethod);
    return { id, message: "Delivered order saved. Pending amounts do not enter paid sales yet." };
  });
}

function recordPayment(db, orderId, body) {
  return idempotent(db, `payment:${orderId}`, body, () => {
    const order = db.prepare("SELECT * FROM delivered_orders WHERE id = ?").get(orderId);
    if (!order || order.status !== "pending") fail("This delivered order is not open for payments.", 409);
    if (order.source_order_id) {
      const source = db.prepare("SELECT status FROM orders WHERE id = ?").get(order.source_order_id);
      if (!source || !UNPAID.has(source.status)) fail("The source order changed in admin. Refresh and check it before recording payment.", 409);
    }
    const amount = cents(body.amountCents, "Received payment", false);
    if (!["cash", "zelle"].includes(body.paymentMethod)) fail("Choose Cash or Zelle.");
    const received = paymentsFor(db, orderId).reduce((sum, payment) => sum + payment.amountCents, 0);
    if (amount > order.total_cents - received) fail("Payment cannot exceed the remaining balance.", 409);
    db.prepare("INSERT INTO delivered_payments (delivered_order_id, amount_cents, payment_method) VALUES (?, ?, ?)").run(orderId, amount, body.paymentMethod);
    const closed = received + amount === order.total_cents;
    if (closed) {
      let transactionId = null;
      if (order.source_order_id) {
        db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(order.source_order_id);
      } else {
        const insert = db.prepare("INSERT INTO manual_transactions (type, description, amount_cents, payment_method, items_json) VALUES ('sale', ?, ?, 'mixed', ?)")
          .run(`Delivered order #${orderId}: ${order.customer_name}`, order.total_cents, order.items_json);
        transactionId = Number(insert.lastInsertRowid);
      }
      db.prepare("UPDATE delivered_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP, transaction_id = ? WHERE id = ?").run(transactionId, orderId);
    }
    return { id: orderId, closed, balanceCents: order.total_cents - received - amount,
      message: closed ? "Paid in full. The order entered backend sales once, with product costs included in financials." : "Partial payment saved. Paid sales will update when the balance is cleared." };
  });
}

function recordExpense(db, body) {
  return idempotent(db, "expense", body, () => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) fail("Enter an expense name up to 100 characters.");
    const amount = cents(body.amountCents, "Expense amount", false);
    const result = db.prepare("INSERT INTO expenses (name, amount_cents) VALUES (?, ?)").run(name, amount);
    return { id: Number(result.lastInsertRowid), message: "Expense saved to the existing backend expense list." };
  });
}

function getFinancials(db) {
  const catalog = itemCatalog(db);
  const { settings, revision } = currentSettings(db);
  const delivered = pendingOrders(db);
  const linked = new Map(delivered.filter(order => order.status === "closed" && order.sourceOrderId).map(order => [order.sourceOrderId, order]));
  const linkedManual = new Map(db.prepare("SELECT id, transaction_id FROM delivered_orders WHERE status = 'closed' AND transaction_id IS NOT NULL").all()
    .map(row => [row.transaction_id, delivered.find(order => order.id === row.id)]));
  const sales = db.prepare("SELECT * FROM orders WHERE status IN ('paid', 'ready_for_pickup', 'completed')").all().map(order => ({
    total: order.total_cents, fee: order.card_fee_cents, shipping: order.delivery_fee_cents,
    payments: linked.has(order.id) ? linked.get(order.id).payments : [{ amountCents: order.total_cents, method: order.payment_method }],
    items: db.prepare("SELECT product_id, product_name, quantity, unit_price_cents FROM order_items WHERE order_id = ?").all(order.id)
      .map(item => ({ id: `product:${item.product_id}`, name: item.product_name, quantity: item.quantity, priceCents: item.unit_price_cents }))
  }));
  const legacyReceipts = new Map(db.prepare("SELECT transaction_id, receipt_json FROM quick_sale_receipts WHERE voided = 0").all()
    .map(row => [row.transaction_id, JSON.parse(row.receipt_json)]));
  for (const row of db.prepare("SELECT * FROM manual_transactions WHERE type = 'sale'").all()) {
    const legacy = legacyReceipts.get(row.id);
    sales.push({
      total: row.amount_cents, fee: 0, shipping: 0,
      payments: linkedManual.has(row.id) ? linkedManual.get(row.id).payments : [{ amountCents: row.amount_cents, method: row.payment_method }],
      items: row.items_json ? JSON.parse(row.items_json) : legacy ? legacy.items.map(item => ({ ...item, id: `preset:${item.id}` })) : []
    });
  }
  const revenueCents = sales.reduce((sum, sale) => sum + sale.total, 0);
  const overheadCents = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS amount FROM expenses").get().amount;
  const feeCents = sales.reduce((sum, sale) => sum + sale.fee, 0);
  const paid = { cashCents: 0, zelleCents: 0 };
  const dateCosts = { mix: { paidPounds: 0, deliveredPounds: 0, revenueCents: 0, costCents: 0 },
    jumbo: { paidPounds: 0, deliveredPounds: 0, revenueCents: 0, costCents: 0 } };
  let cogs = 0, missingSales = 0;
  const missingProducts = new Set();
  function metadata(item) {
    return catalog.find(product => product.id === item.id) || item;
  }
  for (const sale of sales) {
    for (const payment of sale.payments) paid[`${groupPayment(payment.method)}Cents`] += payment.amountCents;
    if (!sale.items.length) { missingSales++; continue; }
    const subtotal = sale.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    for (const item of sale.items) {
      const product = metadata(item);
      if (["mix", "jumbo"].includes(product.kind) && [5, 10].includes(product.lbs)) {
        const data = dateCosts[product.kind];
        data.paidPounds += product.lbs * item.quantity;
        data.revenueCents += subtotal ? (sale.total - sale.fee - sale.shipping) * item.priceCents * item.quantity / subtotal : 0;
        if (settings && settings[product.kind].pounds > 0) {
          const cost = settings[product.kind].costPerPoundCents * product.lbs * item.quantity;
          data.costCents += cost;
          cogs += cost;
        } else missingProducts.add(product.name);
      } else missingProducts.add(product.name || item.id);
    }
  }
  const open = delivered.filter(order => order.status === "pending");
  for (const kind of ["mix", "jumbo"]) {
    const data = dateCosts[kind];
    const pendingPounds = open.reduce((sum, order) => sum + order.items.reduce((pounds, item) => {
      const product = metadata(item);
      return pounds + (product.kind === kind ? product.lbs * item.quantity : 0);
    }, 0), 0);
    data.deliveredPounds = data.paidPounds + pendingPounds;
    data.pendingPounds = pendingPounds;
    data.remainingPounds = settings ? settings[kind].pounds - data.deliveredPounds : null;
    data.baseCentsPerPound = settings && settings[kind].pounds > 0 ? settings[kind].costPerPoundCents : null;
    data.fullCentsPerPound = data.baseCentsPerPound;
    data.profitCentsPerPound = data.fullCentsPerPound === null ? null : data.revenueCents / data.paidPounds - data.fullCentsPerPound;
    if (!data.paidPounds) data.profitCentsPerPound = null;
    data.grossProfitCents = data.baseCentsPerPound === null ? null : Math.round(data.revenueCents - data.costCents);
  }
  const warnings = [];
  if (!settings) warnings.push("Enter pounds purchased and cost per pound for Mix and Jumbo.");
  if (missingProducts.size) warnings.push(`Overall profit excludes costs for these products: ${[...missingProducts].join(", ")}. Honey and other sales do not enter the Mix/Jumbo gross-profit comparison.`);
  if (missingSales) warnings.push(`${missingSales} historical sale(s) have no product details. Their product costs are excluded, so profit is overstated.`);
  if (Object.values(dateCosts).some(data => data.remainingPounds !== null && data.remainingPounds < 0)) warnings.push("Known delivered pounds exceed recorded purchases. Update cumulative stock costs.");
  const cogsCents = Math.round(cogs);
  return {
    revenueCents, cogsCents, overheadCents, feeCents, netCents: revenueCents - cogsCents - overheadCents - feeCents,
    paid, dateCosts, dateGrossProfitCents: settings ? Math.round(dateCosts.mix.revenueCents + dateCosts.jumbo.revenueCents - cogs) : null,
    dateProfitAfterExpensesCents: settings ? Math.round(dateCosts.mix.revenueCents + dateCosts.jumbo.revenueCents - cogs) - overheadCents : null,
    warnings, complete: !warnings.length, settings, revision, catalog,
    expenses: db.prepare("SELECT id, name, amount_cents AS amountCents, created_at AS createdAt FROM expenses ORDER BY id DESC").all(),
    pending: open, closed: delivered.filter(order => order.status === "closed").slice(0, 30),
    pendingBalanceCents: open.reduce((sum, order) => sum + order.balanceCents, 0),
    pendingReceivedCents: open.reduce((sum, order) => sum + order.receivedCents, 0),
    availableOrders: db.prepare(`SELECT id, customer_name AS name, total_cents AS totalCents FROM orders
      WHERE status IN ('awaiting_cash', 'awaiting_zelle', 'awaiting_card_payment')
      AND id NOT IN (SELECT source_order_id FROM delivered_orders WHERE source_order_id IS NOT NULL)
      ORDER BY id DESC LIMIT 100`).all()
  };
}

function voidForTransaction(db, transactionId) {
  const order = db.prepare("SELECT id FROM delivered_orders WHERE transaction_id = ?").get(transactionId);
  if (order) {
    db.prepare("UPDATE delivered_orders SET status = 'voided' WHERE id = ?").run(order.id);
    db.prepare("UPDATE register_requests SET voided = 1 WHERE entity_id = ? AND (kind = 'delivered-order' OR kind LIKE 'payment:%')").run(order.id);
  }
}

module.exports = { initialize, getFinancials, saveCosts, createDelivered, recordPayment, recordExpense, voidForTransaction, PAID };
