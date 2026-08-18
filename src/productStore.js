const db = require("./db");

function toProduct(row) {
  return {
    id: row.id,
    name: row.name,
    weightLabel: row.weight_label,
    typeLabel: row.type_label,
    priceCents: row.price_cents,
    imageUrl: row.image_url || "",
    sortOrder: Number(row.sort_order || 0)
  };
}

function listProducts() {
  const rows = db.prepare(`
    SELECT id, name, weight_label, type_label, price_cents, image_url, sort_order
    FROM products
    ORDER BY sort_order ASC, created_at ASC, id ASC
  `).all();

  return rows.map(toProduct);
}

function getProductById(productId) {
  if (!productId) {
    return null;
  }

  const row = db.prepare(`
    SELECT id, name, weight_label, type_label, price_cents, image_url, sort_order
    FROM products
    WHERE id = ?
  `).get(productId);

  return row ? toProduct(row) : null;
}

function slugifyProductId(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `product-${Date.now()}`;
}

function normalizeProductInput(input) {
  const name = String(input?.name || "").trim();
  const weightLabel = String(input?.weightLabel || "").trim();
  const typeLabel = String(input?.typeLabel || "").trim();
  const imageUrl = String(input?.imageUrl || "").trim();
  const priceInput = Number(input?.priceCents ?? input?.price ?? 0);
  const priceCents = Number.isFinite(priceInput) ? Math.max(0, Math.round(priceInput)) : 0;

  if (!name) {
    return { error: "Product name is required." };
  }

  if (priceCents <= 0) {
    return { error: "Product price must be greater than 0." };
  }

  return {
    name,
    weightLabel,
    typeLabel,
    priceCents,
    imageUrl
  };
}

function createProduct(input) {
  const normalized = normalizeProductInput(input);
  if (normalized.error) {
    return normalized;
  }

  const baseId = String(input?.id || "").trim() || slugifyProductId(normalized.name);
  let productId = baseId;
  let suffix = 2;

  while (getProductById(productId)) {
    productId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const maxSortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS value FROM products").get().value;

  const result = db.prepare(`
    INSERT INTO products (id, name, weight_label, type_label, price_cents, image_url, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    normalized.name,
    normalized.weightLabel,
    normalized.typeLabel,
    normalized.priceCents,
    normalized.imageUrl,
    Number(maxSortOrder) + 1
  );

  return {
    product: getProductById(productId),
    productId,
    changes: result.changes
  };
}

function updateProduct(productId, input) {
  const existing = getProductById(productId);
  if (!existing) {
    return { error: "Product not found." };
  }

  const normalized = normalizeProductInput(input);
  if (normalized.error) {
    return normalized;
  }

  db.prepare(`
    UPDATE products
    SET name = ?, weight_label = ?, type_label = ?, price_cents = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    normalized.name,
    normalized.weightLabel,
    normalized.typeLabel,
    normalized.priceCents,
    normalized.imageUrl,
    productId
  );

  return { product: getProductById(productId) };
}

function deleteProduct(productId) {
  const existing = getProductById(productId);
  if (!existing) {
    return { error: "Product not found." };
  }

  const result = db.prepare("DELETE FROM products WHERE id = ?").run(productId);
  return {
    deleted: result.changes > 0
  };
}

function moveProduct(productId, direction) {
  const normalizedDirection = String(direction || "").trim().toLowerCase();
  if (normalizedDirection !== "up" && normalizedDirection !== "down") {
    return { error: "Direction must be up or down." };
  }

  const rows = db.prepare(`
    SELECT id, sort_order
    FROM products
    ORDER BY sort_order ASC, created_at ASC, id ASC
  `).all();

  const currentIndex = rows.findIndex((row) => row.id === productId);
  if (currentIndex < 0) {
    return { error: "Product not found." };
  }

  const targetIndex = normalizedDirection === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= rows.length) {
    return { moved: false, product: getProductById(productId) };
  }

  const currentRow = rows[currentIndex];
  const targetRow = rows[targetIndex];
  const swapOrder = db.prepare("UPDATE products SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  const swapTxn = db.transaction(() => {
    swapOrder.run(-1, currentRow.id);
    swapOrder.run(currentRow.sort_order, targetRow.id);
    swapOrder.run(targetRow.sort_order, currentRow.id);
  });

  swapTxn();

  return {
    moved: true,
    product: getProductById(productId)
  };
}

module.exports = {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  moveProduct,
  normalizeProductInput,
  slugifyProductId
};
