const crypto = require("crypto");

const presets = Object.freeze([
  { id: "mix-25", name: "Mix", priceCents: 2500 },
  { id: "mix-50", name: "Mix", priceCents: 5000 },
  { id: "jumbo-30", name: "Jumbo", priceCents: 3000 },
  { id: "jumbo-60", name: "Jumbo", priceCents: 6000 },
  { id: "honey-15", name: "Honey", priceCents: 1500 },
  { id: "misc-5", name: "Misc", priceCents: 500 },
  { id: "misc-10", name: "Misc", priceCents: 1000 },
  { id: "misc-100", name: "Misc", priceCents: 10000 }
]);
const MAX_SALE_CENTS = 99999999;
const MAX_QUANTITY = 999;

function getSalesTotals(db) {
  const { paid, walkIn } = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_cents), 0) FROM orders
       WHERE status IN ('paid', 'ready_for_pickup', 'completed')) AS paid,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM manual_transactions WHERE type = 'sale') AS walkIn
  `).get();
  return { totalSalesCents: paid + walkIn, walkInSalesCents: walkIn };
}

function validateSale(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Enter a valid walk-in sale." };
  }
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    return { error: "A valid sale request ID is required." };
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > presets.length) {
    return { error: "Choose at least one preset, with at most one entry per preset." };
  }
  const quantities = new Map();
  for (const item of body.items) {
    if (!item || !presets.some(preset => preset.id === item.id) || quantities.has(item.id)) {
      return { error: "Choose valid presets without duplicate entries." };
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      return { error: `Each preset quantity must be between 1 and ${MAX_QUANTITY}.` };
    }
    quantities.set(item.id, item.quantity);
  }
  if (!Number.isSafeInteger(body.adjustmentCents) || Math.abs(body.adjustmentCents) > MAX_SALE_CENTS) {
    return { error: "Enter a valid adjustment in whole cents." };
  }
  const items = presets.filter(preset => quantities.has(preset.id)).map(preset => ({
    ...preset,
    quantity: quantities.get(preset.id)
  }));
  const subtotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const totalCents = subtotalCents + body.adjustmentCents;
  if (totalCents <= 0 || totalCents > MAX_SALE_CENTS) {
    return { error: "Sale total must be between $0.01 and $999,999.99. Discount cannot exceed the subtotal." };
  }
  return {
    requestId: body.requestId.toLowerCase(),
    items,
    subtotalCents,
    adjustmentCents: body.adjustmentCents,
    totalCents
  };
}

function recordQuickSale(db, sale) {
  const payloadJson = JSON.stringify({
    items: sale.items.map(({ id, quantity }) => ({ id, quantity })),
    adjustmentCents: sale.adjustmentCents
  });
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM quick_sale_receipts WHERE request_id = ?").get(sale.requestId);
    if (existing) {
      if (existing.payload_json !== payloadJson) {
        return { conflict: true };
      }
      return {
        receipt: { ...JSON.parse(existing.receipt_json), voided: Boolean(existing.voided) },
        replayed: true,
        totals: getSalesTotals(db)
      };
    }
    const before = getSalesTotals(db);
    const description = sale.items.map(item => `${item.name} $${item.priceCents / 100} x${item.quantity}`).join("; ")
      + (sale.adjustmentCents ? `; ${sale.adjustmentCents < 0 ? "Discount" : "Addition"} $${(Math.abs(sale.adjustmentCents) / 100).toFixed(2)}` : "");
    const result = db.prepare(
      "INSERT INTO manual_transactions (type, description, amount_cents) VALUES ('sale', ?, ?)"
    ).run(description, sale.totalCents);
    const transaction = db.prepare("SELECT id, created_at FROM manual_transactions WHERE id = ?").get(result.lastInsertRowid);
    const totals = getSalesTotals(db);
    const receipt = {
      id: crypto.randomUUID(),
      transactionId: transaction.id,
      status: "completed",
      type: "walk_in",
      items: sale.items,
      subtotalCents: sale.subtotalCents,
      adjustmentCents: sale.adjustmentCents,
      totalCents: sale.totalCents,
      salesBeforeCents: before.totalSalesCents,
      salesAfterCents: totals.totalSalesCents,
      createdAt: transaction.created_at,
      voided: false
    };
    db.prepare(`
      INSERT INTO quick_sale_receipts (request_id, transaction_id, payload_json, receipt_json)
      VALUES (?, ?, ?, ?)
    `).run(sale.requestId, transaction.id, payloadJson, JSON.stringify(receipt));
    return { receipt, totals, replayed: false };
  }).immediate();
}

module.exports = { presets, MAX_SALE_CENTS, MAX_QUANTITY, getSalesTotals, validateSale, recordQuickSale };
