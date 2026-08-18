const adminForm = document.getElementById("adminForm");
const adminPasswordInput = document.getElementById("adminPasswordInput");
const adminMessage = document.getElementById("adminMessage");
const adminProtected = document.getElementById("adminProtected");
const summaryText = document.getElementById("summaryText");
const ordersWrap = document.getElementById("ordersWrap");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");
const activeTabButton = document.getElementById("activeTabButton");
const completedTabButton = document.getElementById("completedTabButton");
const productForm = document.getElementById("productForm");
const productEditingId = document.getElementById("productEditingId");
const productNameInput = document.getElementById("productNameInput");
const productPriceInput = document.getElementById("productPriceInput");
const productWeightInput = document.getElementById("productWeightInput");
const productTypeInput = document.getElementById("productTypeInput");
const productFileInput = document.getElementById("productFileInput");
const productImageInput = document.getElementById("productImageInput");
const productResetButton = document.getElementById("productResetButton");
const productMessage = document.getElementById("productMessage");
const productList = document.getElementById("productList");
const paidTotal = document.getElementById("paidTotal");
const unpaidTotal = document.getElementById("unpaidTotal");
const paidByZelle = document.getElementById("paidByZelle");
const paidByCard = document.getElementById("paidByCard");
const paidByCash = document.getElementById("paidByCash");
const awaitingByZelle = document.getElementById("awaitingByZelle");
const awaitingByCard = document.getElementById("awaitingByCard");
const awaitingByCash = document.getElementById("awaitingByCash");
const newOrdersCount = document.getElementById("newOrdersCount");

let isAuthenticated = false;
let currentTab = "active";
let allOrders = [];
let allProducts = [];
const READY_FLAG_KEY = "tigris_ready_flags";
let readyFlags = {};

try {
  readyFlags = JSON.parse(localStorage.getItem(READY_FLAG_KEY) || "{}") || {};
} catch (_error) {
  readyFlags = {};
}

async function adminApi(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      ...(!isFormData ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Admin request failed.");
  }

  return data;
}

function formatProductPrice(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function renderSummary(summary) {
  paidTotal.textContent = summary.revenuePaid;
  unpaidTotal.textContent = summary.revenueUnpaid;
  paidByZelle.textContent = summary.paidByZelle;
  paidByCard.textContent = summary.paidByCard;
  paidByCash.textContent = summary.paidByCash;
  awaitingByZelle.textContent = summary.awaitingByZelle;
  awaitingByCard.textContent = summary.awaitingByCard;
  awaitingByCash.textContent = summary.awaitingByCash;
  newOrdersCount.textContent = String(summary.newOrders || 0);

  summaryText.textContent = [
    `Total orders: ${summary.totalOrders}`,
    `Awaiting payment: ${summary.awaitingPayment}`,
    `Completed: ${summary.completed}`,
    `Cancelled: ${summary.cancelled}`
  ].join(" | ");
}

function statusLabel(status) {
  const map = {
    awaiting_card_payment: "Awaiting Card",
    awaiting_zelle: "Awaiting Zelle",
    awaiting_cash: "Awaiting Cash",
    paid: "Paid",
    ready_for_pickup: "Ready",
    completed: "Completed",
    cancelled: "Cancelled"
  };

  return map[status] || status;
}

function isClosedStatus(status) {
  return status === "completed" || status === "cancelled";
}

function isWaitingStatus(status) {
  return status === "awaiting_card_payment" || status === "awaiting_zelle" || status === "awaiting_cash";
}

function isReadyStatus(status) {
  return status === "paid" || status === "ready_for_pickup";
}

function isOrderMarkedReady(orderId) {
  return readyFlags[String(orderId)] === true;
}

function setOrderMarkedReady(orderId, markedReady) {
  const key = String(orderId);

  if (markedReady) {
    readyFlags[key] = true;
  } else {
    delete readyFlags[key];
  }

  localStorage.setItem(READY_FLAG_KEY, JSON.stringify(readyFlags));
}

function sortUncheckedFirst(orders) {
  return [...orders].sort((a, b) => {
    const aReady = isOrderMarkedReady(a.id) ? 1 : 0;
    const bReady = isOrderMarkedReady(b.id) ? 1 : 0;
    return aReady - bReady;
  });
}

async function updateOrderStatus(orderId, nextStatus, successMessage) {
  adminMessage.style.color = "#0f766e";
  adminMessage.textContent = `Updating order #${orderId}...`;

  await adminApi(`/api/admin/orders/${orderId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: nextStatus })
  });

  adminMessage.textContent = successMessage;
  await loadAdminData();
}

function createStatusSelect(order) {
  const select = document.createElement("select");
  const statuses = [
    "awaiting_card_payment",
    "awaiting_zelle",
    "awaiting_cash",
    "paid",
    "completed",
    "cancelled"
  ];

  for (const status of statuses) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    option.selected = status === order.status;
    select.appendChild(option);
  }

  select.addEventListener("change", async () => {
    try {
      await updateOrderStatus(
        order.id,
        select.value,
        `Order #${order.id} updated to ${select.value}.`
      );
    } catch (error) {
      adminMessage.style.color = "#a61b1b";
      adminMessage.textContent = error.message;
    }
  });

  return select;
}

function createReadyCheckbox(order) {
  const wrapper = document.createElement("label");
  wrapper.className = "ready-toggle";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = isOrderMarkedReady(order.id);
  checkbox.disabled = order.status === "cancelled" || order.status === "completed";

  const text = document.createElement("span");
  text.textContent = "Ready for pickup";

  checkbox.addEventListener("change", () => {
    setOrderMarkedReady(order.id, checkbox.checked);
    adminMessage.style.color = "#0f766e";
    adminMessage.textContent = checkbox.checked
      ? `Order #${order.id} marked ready for pickup.`
      : `Order #${order.id} marked not ready.`;
    renderOrders();
  });

  wrapper.appendChild(checkbox);
  wrapper.appendChild(text);
  return wrapper;
}

function createOpenButton(order) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn ghost";
  button.textContent = "Open Order";

  button.addEventListener("click", async () => {
    try {
      adminMessage.style.color = "#0f766e";
      adminMessage.textContent = `Opening order #${order.id}...`;

      await adminApi(`/api/admin/orders/${order.id}/open`, {
        method: "PATCH"
      });

      adminMessage.textContent = `Order #${order.id} moved to active bins.`;
      await loadAdminData();
    } catch (error) {
      adminMessage.style.color = "#a61b1b";
      adminMessage.textContent = error.message;
    }
  });

  return button;
}

function setProductMessage(text, isError = false) {
  productMessage.style.color = isError ? "#a61b1b" : "#0f766e";
  productMessage.textContent = text;
}

function clearProductForm() {
  productEditingId.value = "";
  productNameInput.value = "";
  productPriceInput.value = "";
  productWeightInput.value = "";
  productTypeInput.value = "";
  if (productFileInput) {
    productFileInput.value = "";
  }
  productImageInput.value = "";
  setProductMessage("");
}

function populateProductForm(product) {
  productEditingId.value = product.id;
  productNameInput.value = product.name || "";
  productPriceInput.value = product.priceCents ? (Number(product.priceCents) / 100).toFixed(2) : "";
  productWeightInput.value = product.weightLabel || "";
  productTypeInput.value = product.typeLabel || "";
  if (productFileInput) {
    productFileInput.value = "";
  }
  productImageInput.value = product.imageUrl || "";
  setProductMessage(`Editing ${product.name}.`);
}

async function moveProductPosition(productId, direction) {
  const normalizedDirection = String(direction || "").trim().toLowerCase();
  const label = normalizedDirection === "up" ? "up" : "down";

  try {
    setProductMessage(`Moving product ${label}...`);
    const data = await adminApi(`/api/admin/products/${encodeURIComponent(productId)}/move`, {
      method: "POST",
      body: JSON.stringify({ direction: normalizedDirection })
    });

    allProducts = data.products || [];
    renderProducts();
    setProductMessage(data.message || "Product moved.");
  } catch (error) {
    setProductMessage(error.message, true);
  }
}

function renderProductCard(product) {
  const card = document.createElement("article");
  card.className = "product-item product-admin-card";

  const main = document.createElement("div");
  main.className = "product-admin-main";

  const imageWrap = document.createElement("div");
  imageWrap.className = "product-image-frame";

  if (product.imageUrl) {
    const img = document.createElement("img");
    img.className = "product-image";
    img.src = product.imageUrl;
    img.alt = product.name;
    img.loading = "lazy";
    imageWrap.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "product-image-placeholder";
    placeholder.textContent = "No image";
    imageWrap.appendChild(placeholder);
  }

  const info = document.createElement("div");
  info.className = "stacked-form";

  const title = document.createElement("h4");
  title.textContent = product.name;

  const meta = document.createElement("p");
  meta.className = "product-meta";
  const parts = [product.id];
  if (product.weightLabel) {
    parts.push(product.weightLabel);
  }
  if (product.typeLabel) {
    parts.push(product.typeLabel);
  }
  meta.textContent = parts.join(" • ");

  const price = document.createElement("p");
  price.className = "hint";
  price.textContent = `Price: ${formatProductPrice(product.priceCents)}`;

  const position = document.createElement("p");
  position.className = "hint";
  position.textContent = `Position: ${Number(product.sortOrder || 0)}`;

  info.appendChild(title);
  info.appendChild(meta);
  info.appendChild(price);
  info.appendChild(position);

  main.appendChild(imageWrap);
  main.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "summary-row product-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "btn ghost";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => populateProductForm(product));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "btn ghost";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    const confirmed = window.confirm(`Delete ${product.name}?`);
    if (!confirmed) {
      return;
    }

    try {
      setProductMessage(`Deleting ${product.name}...`);
      await adminApi(`/api/admin/products/${encodeURIComponent(product.id)}`, { method: "DELETE" });
      setProductMessage(`Deleted ${product.name}.`);
      clearProductForm();
      await loadAdminData();
    } catch (error) {
      setProductMessage(error.message, true);
    }
  });

  actions.appendChild(editButton);
  const moveUpButton = document.createElement("button");
  moveUpButton.type = "button";
  moveUpButton.className = "btn ghost";
  moveUpButton.textContent = "Move Up";
  moveUpButton.addEventListener("click", () => {
    moveProductPosition(product.id, "up");
  });

  const moveDownButton = document.createElement("button");
  moveDownButton.type = "button";
  moveDownButton.className = "btn ghost";
  moveDownButton.textContent = "Move Down";
  moveDownButton.addEventListener("click", () => {
    moveProductPosition(product.id, "down");
  });

  actions.appendChild(moveUpButton);
  actions.appendChild(moveDownButton);
  actions.appendChild(deleteButton);

  card.appendChild(main);
  card.appendChild(actions);
  return card;
}

function renderProducts() {
  productList.innerHTML = "";

  if (!allProducts.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No products yet.";
    productList.appendChild(empty);
    return;
  }

  for (const product of allProducts) {
    productList.appendChild(renderProductCard(product));
  }
}

function getVisibleOrders() {
  if (currentTab === "completed") {
    return allOrders.filter((order) => isClosedStatus(order.status));
  }

  return allOrders.filter((order) => !isClosedStatus(order.status));
}

function buildOrderCard(order) {
    const card = document.createElement("article");
    card.className = "product-item";

    const itemsText = order.items
      .map((item) => `${item.quantity} x ${item.productName} (${item.lineTotal})`)
      .join("; ");

    const top = document.createElement("div");
    top.className = "summary-row";

    const titleWrap = document.createElement("div");
    titleWrap.className = "stacked-form";

    const title = document.createElement("p");
    title.className = "product-meta";
    title.textContent = `#${order.id} | ${order.customerName} | ${order.total}`;

    const chips = document.createElement("div");
    chips.className = "chip-row";

    const statusChip = document.createElement("span");
    statusChip.className = `chip chip-status-${order.status}`;
    statusChip.textContent = statusLabel(order.status);

    const paymentChip = document.createElement("span");
    paymentChip.className = "chip";
    paymentChip.textContent = `Pay: ${order.paymentMethod}`;

    chips.appendChild(statusChip);
    chips.appendChild(paymentChip);

    titleWrap.appendChild(title);
    titleWrap.appendChild(chips);

    const statusSelect = createStatusSelect(order);

    top.appendChild(titleWrap);

    if (order.adminSeen) {
      const controls = document.createElement("div");
      controls.className = "order-controls";
      controls.appendChild(statusSelect);
      controls.appendChild(createReadyCheckbox(order));
      top.appendChild(controls);
    } else {
      top.appendChild(createOpenButton(order));
    }

    const details = document.createElement("p");
    details.className = "hint";
    details.textContent = `Phone: ${order.phone} | Created: ${order.createdAt}`;

    const items = document.createElement("p");
    items.className = "hint";
    items.textContent = `Items: ${itemsText}`;

    card.appendChild(top);
    card.appendChild(details);
    card.appendChild(items);

    if (order.notes) {
      const notes = document.createElement("p");
      notes.className = "hint";
      notes.textContent = `Notes: ${order.notes}`;
      card.appendChild(notes);
    }

    return card;
}

function appendOrderSection(titleText, orders) {
  const section = document.createElement("section");
  section.className = "stacked-form";

  const title = document.createElement("p");
  title.className = "section-caption";
  title.textContent = `${titleText} (${orders.length})`;
  section.appendChild(title);

  if (!orders.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "None";
    section.appendChild(empty);
  } else {
    for (const order of orders) {
      section.appendChild(buildOrderCard(order));
    }
  }

  ordersWrap.appendChild(section);
}

function renderOrders() {
  const orders = getVisibleOrders();
  ordersWrap.innerHTML = "";

  if (!orders.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = currentTab === "completed"
      ? "No closed orders yet."
      : "No active orders right now.";
    ordersWrap.appendChild(p);
    return;
  }

  if (currentTab === "active") {
    const newInbox = orders.filter((order) => !order.adminSeen);
    const opened = orders.filter((order) => order.adminSeen);
    const activeOpened = sortUncheckedFirst(opened);

    appendOrderSection("New Orders (Unopened)", newInbox);
    appendOrderSection("Opened Orders", activeOpened);
    return;
  }

  const completed = sortUncheckedFirst(orders.filter((order) => order.status === "completed" && order.adminSeen));
  const cancelled = sortUncheckedFirst(orders.filter((order) => order.status === "cancelled" && order.adminSeen));

  appendOrderSection("Completed", completed);
  appendOrderSection("Cancelled", cancelled);
}

function setTab(nextTab) {
  currentTab = nextTab;

  const activeSelected = nextTab === "active";
  activeTabButton.classList.toggle("tab-active", activeSelected);
  completedTabButton.classList.toggle("tab-active", !activeSelected);
  activeTabButton.setAttribute("aria-selected", String(activeSelected));
  completedTabButton.setAttribute("aria-selected", String(!activeSelected));

  renderOrders();
}

async function loadAdminData() {
  const [summaryData, ordersData, productsData] = await Promise.all([
    adminApi("/api/admin/summary", { method: "GET" }),
    adminApi("/api/admin/orders?limit=200", { method: "GET" }),
    adminApi("/api/admin/products", { method: "GET" })
  ]);

  allOrders = ordersData.orders || [];
  allProducts = productsData.products || [];
  renderSummary(summaryData.summary);
  renderProducts();
  renderOrders();
}

async function checkAdminSession() {
  try {
    const data = await adminApi("/api/admin/session", { method: "GET" });
    isAuthenticated = Boolean(data.authenticated);
  } catch (_error) {
    isAuthenticated = false;
  }

  return isAuthenticated;
}

function setAdminSignedOutState(message = "Please sign in.") {
  isAuthenticated = false;
  allOrders = [];
  allProducts = [];
  adminProtected.classList.add("hidden");
  renderOrders();
  renderProducts();
  adminMessage.style.color = "#a61b1b";
  adminMessage.textContent = message;
}

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminMessage.textContent = "";
  adminMessage.style.color = "#a61b1b";

  try {
    await adminApi("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: adminPasswordInput.value.trim() })
    });

    await loadAdminData();
    isAuthenticated = true;
    adminProtected.classList.remove("hidden");
    adminMessage.style.color = "#0f766e";
    adminMessage.textContent = "Admin backend loaded.";
  } catch (error) {
    isAuthenticated = false;
    adminProtected.classList.add("hidden");
    adminMessage.textContent = error.message;
  }
});

refreshButton.addEventListener("click", async () => {
  if (!isAuthenticated) {
    adminMessage.style.color = "#a61b1b";
    adminMessage.textContent = "Sign in first.";
    return;
  }

  try {
    await loadAdminData();
    adminProtected.classList.remove("hidden");
    adminMessage.style.color = "#0f766e";
    adminMessage.textContent = "Refreshed.";
  } catch (error) {
    adminProtected.classList.add("hidden");
    adminMessage.style.color = "#a61b1b";
    adminMessage.textContent = error.message;
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await adminApi("/api/admin/logout", { method: "POST" });
    setAdminSignedOutState("Signed out.");
  } catch (error) {
    adminMessage.style.color = "#a61b1b";
    adminMessage.textContent = error.message;
  }
});

productForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const editingId = productEditingId.value.trim();
  const priceValue = Number(productPriceInput.value);
  const hasImageFile = Boolean(productFileInput?.files && productFileInput.files.length > 0);
  const payload = {
    name: productNameInput.value.trim(),
    priceCents: Number.isFinite(priceValue) ? Math.round(priceValue * 100) : 0,
    weightLabel: productWeightInput.value.trim(),
    typeLabel: productTypeInput.value.trim(),
    imageUrl: productImageInput.value.trim()
  };

  try {
    setProductMessage(editingId ? "Saving product..." : "Creating product...");

    if (hasImageFile) {
      const formData = new FormData();
      formData.append("name", payload.name);
      formData.append("priceCents", String(payload.priceCents));
      formData.append("weightLabel", payload.weightLabel);
      formData.append("typeLabel", payload.typeLabel);
      formData.append("imageUrl", payload.imageUrl);
      formData.append("image", productFileInput.files[0]);

      if (editingId) {
        await adminApi(`/api/admin/products/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: formData
        });
        setProductMessage(`Updated ${payload.name}.`);
      } else {
        await adminApi("/api/admin/products", {
          method: "POST",
          body: formData
        });
        setProductMessage(`Created ${payload.name}.`);
      }

      clearProductForm();
      await loadAdminData();
      return;
    }

    if (editingId) {
      await adminApi(`/api/admin/products/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      setProductMessage(`Updated ${payload.name}.`);
    } else {
      await adminApi("/api/admin/products", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setProductMessage(`Created ${payload.name}.`);
    }

    clearProductForm();
    await loadAdminData();
  } catch (error) {
    setProductMessage(error.message, true);
  }
});

productResetButton.addEventListener("click", () => {
  clearProductForm();
});

activeTabButton.addEventListener("click", () => setTab("active"));
completedTabButton.addEventListener("click", () => setTab("completed"));

setTab("active");
checkAdminSession().then(async (authed) => {
  if (!authed) {
    setAdminSignedOutState("Please sign in with admin password.");
    return;
  }

  try {
    await loadAdminData();
    adminProtected.classList.remove("hidden");
    adminMessage.style.color = "#0f766e";
    adminMessage.textContent = "Admin backend loaded.";
  } catch (error) {
    adminProtected.classList.add("hidden");
    adminMessage.style.color = "#a61b1b";
    adminMessage.textContent = error.message;
  }
});
