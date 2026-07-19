const adminForm = document.getElementById("adminForm");
const adminPasswordInput = document.getElementById("adminPasswordInput");
const adminMessage = document.getElementById("adminMessage");
const adminDashboard = document.getElementById("adminDashboard");
const summaryText = document.getElementById("summaryText");
const ordersWrap = document.getElementById("ordersWrap");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");
const activeTabButton = document.getElementById("activeTabButton");
const completedTabButton = document.getElementById("completedTabButton");
const paidTotal = document.getElementById("paidTotal");
const unpaidTotal = document.getElementById("unpaidTotal");
const paidByZelle = document.getElementById("paidByZelle");
const paidByCard = document.getElementById("paidByCard");
const paidByCash = document.getElementById("paidByCash");
const awaitingByZelle = document.getElementById("awaitingByZelle");
const awaitingByCard = document.getElementById("awaitingByCard");
const awaitingByCash = document.getElementById("awaitingByCash");
const newOrdersCount = document.getElementById("newOrdersCount");
const weeklyProfit = document.getElementById("weeklyProfit");
const monthlyProfit = document.getElementById("monthlyProfit");
const seasonProfit = document.getElementById("seasonProfit");
const resetButton = document.getElementById("resetButton");

let currentTab = "active";
let allOrders = [];
let isAuthenticated = false;
const READY_FLAG_KEY = "tigris_ready_flags";
let readyFlags = {};

try {
  readyFlags = JSON.parse(localStorage.getItem(READY_FLAG_KEY) || "{}") || {};
} catch (_error) {
  readyFlags = {};
}

function showMessage(text, isError = false) {
  adminMessage.style.color = isError ? "#a61b1b" : "#0f766e";
  adminMessage.textContent = text;
}

function setAuthenticatedState(nextState) {
  isAuthenticated = nextState;
  adminDashboard.classList.toggle("hidden", !nextState);
  refreshButton.classList.toggle("hidden", !nextState);
  logoutButton.classList.toggle("hidden", !nextState);
  adminPasswordInput.disabled = nextState;
}

async function adminApi(path, options = {}) {
  const hasBody = typeof options.body === "string";
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    setAuthenticatedState(false);
    throw new Error("Please sign in as admin.");
  }

  if (!response.ok) {
    throw new Error(data.error || "Admin request failed.");
  }

  return data;
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
  weeklyProfit.textContent = summary.profit?.weekly || "$0.00";
  monthlyProfit.textContent = summary.profit?.monthly || "$0.00";
  seasonProfit.textContent = summary.profit?.season || "$0.00";

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
  showMessage(`Updating order #${orderId}...`);

  await adminApi(`/api/admin/orders/${orderId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: nextStatus })
  });

  showMessage(successMessage);
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
      showMessage(error.message, true);
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
    showMessage(checkbox.checked
      ? `Order #${order.id} marked ready for pickup.`
      : `Order #${order.id} marked not ready.`);
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
      showMessage(`Opening order #${order.id}...`);

      await adminApi(`/api/admin/orders/${order.id}/open`, {
        method: "PATCH"
      });

      showMessage(`Order #${order.id} moved to active bins.`);
      await loadAdminData();
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  return button;
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

    const top = document.createElement("div");
    top.className = "summary-row";

    const titleWrap = document.createElement("div");
    titleWrap.className = "stacked-form";

    const title = document.createElement("p");
    title.className = "product-meta";
    title.textContent = `#${order.id} | ${order.total}`;

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
    details.textContent = `Name: ${order.customerName} | Phone: ${order.phone} | Created: ${order.createdAt}`;

    const fulfillment = document.createElement("p");
    fulfillment.className = "hint";
    fulfillment.textContent = `Order type: ${order.fulfillmentMethod === "delivery" ? "Delivery" : "Pickup"}`;

    const addressLine = document.createElement("p");
    addressLine.className = "hint";
    addressLine.textContent = order.fulfillmentMethod === "delivery"
      ? `Delivery address: ${order.address || "Not provided"}`
      : "Pickup order";

    const itemsHeading = document.createElement("p");
    itemsHeading.className = "section-caption";
    itemsHeading.textContent = "Items";

    const itemsList = document.createElement("ul");
    itemsList.className = "admin-item-list";

    for (const item of order.items) {
      const line = document.createElement("li");
      line.textContent = `${item.quantity} x ${item.productName} (${item.lineTotal})`;
      itemsList.appendChild(line);
    }

    card.appendChild(top);
    card.appendChild(details);
    card.appendChild(fulfillment);
    card.appendChild(addressLine);
    card.appendChild(itemsHeading);
    card.appendChild(itemsList);

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
  const summaryData = await adminApi("/api/admin/summary", { method: "GET" });
  const ordersData = await adminApi("/api/admin/orders?limit=200", { method: "GET" });

  allOrders = ordersData.orders || [];
  renderSummary(summaryData.summary);
  renderOrders();
}

async function resetAllOrders() {
  const confirmed = window.confirm(
    "This will delete all orders, reset order numbers, and clear admin counts. Type RESET in the next prompt to continue."
  );

  if (!confirmed) {
    return;
  }

  const typed = window.prompt("Type RESET to confirm full data reset.");
  if (typed !== "RESET") {
    showMessage("Reset cancelled.");
    return;
  }

  showMessage("Resetting all orders...");
  await adminApi("/api/admin/reset", {
    method: "POST",
    body: JSON.stringify({ confirmation: "RESET" })
  });
  readyFlags = {};
  localStorage.removeItem(READY_FLAG_KEY);
  allOrders = [];
  ordersWrap.innerHTML = "";
  renderSummary({
    totalOrders: 0,
    awaitingPayment: 0,
    paid: 0,
    readyForPickup: 0,
    completed: 0,
    cancelled: 0,
    newOrders: 0,
    revenuePaid: "$0.00",
    revenueUnpaid: "$0.00",
    paidByZelle: "$0.00",
    paidByCard: "$0.00",
    paidByCash: "$0.00",
    awaitingByZelle: "$0.00",
    awaitingByCard: "$0.00",
    awaitingByCash: "$0.00",
    profit: {
      weekly: "$0.00",
      monthly: "$0.00",
      season: "$0.00"
    }
  });
  showMessage("All orders reset.");
}

async function checkSessionAndLoad() {
  try {
    const sessionData = await adminApi("/api/admin/session", { method: "GET" });
    if (!sessionData.authenticated) {
      setAuthenticatedState(false);
      return;
    }

    setAuthenticatedState(true);
    await loadAdminData();
    showMessage("Signed in.");
  } catch (error) {
    setAuthenticatedState(false);
    showMessage(error.message, true);
  }
}

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");

  try {
    const password = adminPasswordInput.value.trim();
    await adminApi("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });

    setAuthenticatedState(true);
    await loadAdminData();
    showMessage("Admin backend loaded.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

refreshButton.addEventListener("click", async () => {
  if (!isAuthenticated) {
    showMessage("Please sign in first.", true);
    return;
  }

  try {
    await loadAdminData();
    showMessage("Refreshed.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await adminApi("/api/admin/logout", { method: "POST" });
    setAuthenticatedState(false);
    allOrders = [];
    ordersWrap.innerHTML = "";
    summaryText.textContent = "Not loaded yet.";
    adminPasswordInput.value = "";
    adminPasswordInput.disabled = false;
    showMessage("Logged out.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

activeTabButton.addEventListener("click", () => setTab("active"));
completedTabButton.addEventListener("click", () => setTab("completed"));
resetButton.addEventListener("click", async () => {
  try {
    await resetAllOrders();
  } catch (error) {
    showMessage(error.message, true);
  }
});

setTab("active");
setAuthenticatedState(false);
checkSessionAndLoad();
