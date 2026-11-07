"use strict";

const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = cents => money.format(cents / 100);
const STORAGE_KEY = "tigris-walk-in-register-v1";
const API = "/api/admin/quick-sales";
let catalog = [];
let maxQuantity = 999;
let maxSaleCents = 99999999;
let totals = null;
let syncedAt = null;
let busy = false;
let financialBusy = false;
let financialRecoveryLocked = false;
let refreshing = false;
let storageFailed = false;
let storedSnapshot = null;
let authenticated = false;
let installPrompt = null;
let undoHistory = [];
let state = { quantities: {}, adjustmentType: "discount", adjustmentAmount: "", paymentMethod: "cash", pending: null, receipt: null };

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new ApiError(`Server returned an unexpected response (${response.status}). Reconnect and try again.`, response.status);
    }
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}).`, response.status);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function showError(error) {
  const message = error.name === "AbortError" ? "The connection timed out. Reconnect and try again." : error.message;
  $("app-error").textContent = message;
  $("reconnect").hidden = false;
  if (error.status === 401) {
    authenticated = false;
    $("login-section").hidden = false;
    $("protected").hidden = true;
    $("logout").hidden = true;
    $("financial-nav").hidden = true;
    $("financial-dialog").close();
    $("connection").textContent = "Sign in to continue. Your sale is kept on this device.";
    $("connection").className = "";
  }
}

function persist() {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== storedSnapshot) {
      storageFailed = true;
      showError(new Error("This register was changed in another tab. Reconnect to load that sale before continuing. Your latest change was not saved."));
      return false;
    }
    const snapshot = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, snapshot);
    storedSnapshot = snapshot;
    storageFailed = false;
    return true;
  } catch (error) {
    storageFailed = true;
    showError(new Error("Cannot save sale recovery data on this device. Enable browser storage before recording a sale."));
    return false;
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    storedSnapshot = raw;
    storageFailed = false;
    undoHistory = [];
    if (!raw) {
      state = { quantities: {}, adjustmentType: "discount", adjustmentAmount: "", paymentMethod: "cash", pending: null, receipt: null };
      $("adjustment-type").value = "discount";
      $("adjustment-amount").value = "";
      return;
    }
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.quantities !== "object" || saved.quantities === null || Array.isArray(saved.quantities)
      || !["discount", "addition"].includes(saved.adjustmentType) || typeof saved.adjustmentAmount !== "string"
      || Object.entries(saved.quantities).some(([id, quantity]) => !catalog.some(item => item.id === id)
        || !Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity)
      || (saved.pending && (typeof saved.pending.requestId !== "string" || !Array.isArray(saved.pending.items)
        || !Number.isSafeInteger(saved.pending.adjustmentCents)))
      || (saved.receipt && (!Number.isSafeInteger(saved.receipt.totalCents) || typeof saved.receipt.id !== "string"))) {
      throw new Error("Stored sale recovery data is invalid.");
    }
    if (saved.paymentMethod !== undefined && !["cash", "zelle"].includes(saved.paymentMethod)) {
      throw new Error("Stored payment method is invalid.");
    }
    state = { ...saved, paymentMethod: saved.paymentMethod || "cash" };
    $("adjustment-type").value = state.adjustmentType;
    $("adjustment-amount").value = state.adjustmentAmount;
    if (state.pending) {
      $("notice").textContent = "An unconfirmed sale was recovered. Retry the same sale to check or complete it without creating a duplicate.";
    } else if (state.receipt) {
      showReceipt();
    }
  } catch (error) {
    storageFailed = true;
    showError(new Error(`${error.message} Do not start a replacement sale. Check the walk-in transactions in admin before clearing browser data.`));
  }
}

function calculation() {
  const items = catalog.filter(item => state.quantities[item.id]).map(item => ({ ...item, quantity: state.quantities[item.id] }));
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const raw = state.adjustmentAmount.trim();
  if (raw && !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    return { items, count, subtotalCents, error: "Enter a positive dollar amount with up to 2 decimal places." };
  }
  const [dollars, decimals = ""] = (raw || "0").split(".");
  const amountCents = Number(dollars) * 100 + Number(decimals.padEnd(2, "0"));
  const adjustmentCents = amountCents * (state.adjustmentType === "discount" ? -1 : 1);
  const totalCents = subtotalCents + adjustmentCents;
  if (!Number.isSafeInteger(amountCents) || amountCents > maxSaleCents || totalCents > maxSaleCents) {
    return { items, count, subtotalCents, error: "Sale or adjustment is too large. Maximum sale: $999,999.99." };
  }
  if (totalCents < 0) return { items, count, subtotalCents, error: "Discount cannot exceed the subtotal." };
  if (count && totalCents === 0) return { items, count, subtotalCents, error: "Sale total must be greater than zero." };
  return { items, count, subtotalCents, adjustmentCents, totalCents, error: "" };
}

function locked() {
  return busy || financialBusy || financialRecoveryLocked || Boolean(state.pending) || Boolean(state.receipt) || storageFailed;
}

function render() {
  const sale = calculation();
  const isLocked = locked();
  $("subtotal").textContent = formatMoney(sale.subtotalCents);
  $("total").textContent = sale.error ? "--" : formatMoney(sale.totalCents);
  $("item-count").textContent = `${sale.count} ${sale.count === 1 ? "item" : "items"}`;
  $("order-summary").textContent = `Order details (${$("item-count").textContent})`;
  $("adjustment-error").textContent = sale.error;
  $("adjustment-amount").setAttribute("aria-invalid", String(Boolean(sale.error)));
  $("adjustment-amount").disabled = isLocked || !sale.count;
  $("adjustment-type").disabled = isLocked || !sale.count;
  $("undo").disabled = isLocked || !undoHistory.length;
  $("clear").disabled = isLocked || !sale.count;
  $("send").disabled = busy || financialBusy || financialRecoveryLocked || refreshing || storageFailed || !authenticated
    || (!state.receipt && (!navigator.onLine || (!state.pending && (!sale.count || Boolean(sale.error)))));
  $("send-label").textContent = busy ? "Confirming sale..." : state.receipt ? "Start next sale"
    : state.pending ? "Retry same sale" : "Record walk-in sale";
  $("logout").disabled = busy || financialBusy;
  $("financial-nav").disabled = busy || financialBusy;
  $("refresh").disabled = refreshing || busy || financialBusy || !navigator.onLine;
  for (const input of document.querySelectorAll('input[name="payment-method"]')) {
    input.checked = input.value === (state.paymentMethod || "cash");
    input.disabled = isLocked;
  }
  for (const button of $("presets").children) {
    const quantity = state.quantities[button.dataset.id] || 0;
    button.disabled = isLocked || quantity >= maxQuantity;
    button.classList.toggle("selected", quantity > 0);
    button.querySelector(".quantity").textContent = quantity ? `x${quantity}` : "";
  }
  $("order-lines").replaceChildren();
  for (const item of sale.items) {
    const row = document.createElement("div");
    row.className = "order-row";
    const label = document.createElement("span");
    label.textContent = `${item.name} ${formatMoney(item.priceCents)} x ${item.quantity}`;
    const subtotal = document.createElement("span");
    subtotal.textContent = formatMoney(item.priceCents * item.quantity);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "-";
    remove.disabled = isLocked;
    remove.setAttribute("aria-label", `Remove one ${item.name} ${formatMoney(item.priceCents)}`);
    remove.addEventListener("click", () => changeQuantity(item.id, -1));
    row.append(label, subtotal, remove);
    $("order-lines").append(row);
  }
  if (!sale.count) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Tap a preset to start your sale.";
    $("order-lines").append(empty);
  }
  $("sales-current").textContent = totals ? formatMoney(totals.totalSalesCents) : "--";
  $("before-row").hidden = !state.receipt;
  if (state.receipt) {
    $("sales-before").textContent = formatMoney(state.receipt.salesBeforeCents);
    $("sales-after").textContent = formatMoney(state.receipt.salesAfterCents);
    $("sales-after-label").textContent = state.receipt.voided ? "At time of sale (since removed)" : "After this sale (confirmed)";
  } else {
    $("sales-after").textContent = totals && !sale.error && !state.pending ? formatMoney(totals.totalSalesCents + sale.totalCents) : "--";
    $("sales-after-label").textContent = state.pending ? "Awaiting sale confirmation" : "After this sale (projected)";
  }
  $("synced").textContent = syncedAt ? `Last refreshed ${syncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${navigator.onLine ? "" : " - offline, may be out of date"}` : "Not loaded yet";
}

function changeQuantity(id, delta) {
  if (locked()) return;
  const quantity = (state.quantities[id] || 0) + delta;
  if (quantity > maxQuantity || quantity < 0) return;
  undoHistory.push({ id, delta });
  if (quantity) state.quantities[id] = quantity;
  else delete state.quantities[id];
  if (!Object.keys(state.quantities).length) {
    state.adjustmentAmount = "";
    $("adjustment-amount").value = "";
  }
  $("notice").textContent = "";
  persist();
  render();
}

function buildPresets() {
  $("presets").replaceChildren();
  for (const item of catalog) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `preset${item.name === "Misc" ? " misc" : ""}`;
    button.dataset.id = item.id;
    button.setAttribute("aria-label", `Add ${item.name} ${formatMoney(item.priceCents)}`);
    const name = document.createElement("span");
    name.className = "product";
    name.textContent = item.name;
    const price = document.createElement("span");
    price.className = "price";
    price.textContent = `$${item.priceCents / 100}`;
    const badge = document.createElement("span");
    badge.className = "quantity";
    badge.setAttribute("aria-hidden", "true");
    button.append(name, price, badge);
    button.addEventListener("click", () => changeQuantity(item.id, 1));
    $("presets").append(button);
  }
}

async function refreshTotals() {
  if (refreshing || busy || financialBusy) return;
  refreshing = true;
  render();
  try {
    const data = await api(API);
    totals = data.totals;
    syncedAt = new Date();
    $("app-error").textContent = "";
    $("reconnect").hidden = true;
    if (!$("financial-screen").hidden && typeof loadFinancials === "function") await loadFinancials();
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
    render();
  }
}

async function openRegister() {
  if (!window.isSecureContext || !crypto.randomUUID) {
    throw new Error("Open this register over HTTPS (or localhost during development) to protect admin access and enable safe sale recording.");
  }
  const data = await api(API);
  catalog = data.presets;
  maxQuantity = data.maxQuantity;
  maxSaleCents = data.maxSaleCents;
  totals = data.totals;
  syncedAt = new Date();
  authenticated = true;
  $("login-section").hidden = true;
  $("protected").hidden = false;
  $("logout").hidden = false;
  $("financial-nav").hidden = false;
  $("app-error").textContent = "";
  $("reconnect").hidden = true;
  $("connection").textContent = navigator.onLine ? "Connected to Tigris Dates" : "Offline - internet required to record sales";
  $("connection").className = navigator.onLine ? "online" : "";
  buildPresets();
  restore();
  render();
  if (typeof restoreFinancialOperation === "function") restoreFinancialOperation();
}

function showReceipt() {
  const receipt = state.receipt;
  $("notice").textContent = receipt.voided
    ? `Walk-in #${receipt.transactionId} was removed in admin. It has not been recorded again. Check current totals before starting another sale.`
    : `Walk-in #${receipt.transactionId} recorded: ${formatMoney(receipt.totalCents)}. Your Tigris sales total has been updated.`;
}

$("send").addEventListener("click", async () => {
  if (busy || financialBusy || financialRecoveryLocked || refreshing || storageFailed || !authenticated) return;
  if (state.receipt) {
    const previous = state;
    state = { quantities: {}, adjustmentType: "discount", adjustmentAmount: "", paymentMethod: "cash", pending: null, receipt: null };
    if (!persist()) {
      state = previous;
      render();
      return;
    }
    undoHistory = [];
    $("adjustment-type").value = "discount";
    $("adjustment-amount").value = "";
    $("notice").textContent = "";
    render();
    await refreshTotals();
    return;
  }
  if (!navigator.onLine) {
    showError(new Error("You are offline. Your sale is kept on this device. Reconnect before recording it."));
    return;
  }
  const sale = calculation();
  if (!state.pending) {
    if (!sale.count || sale.error) {
      showError(new Error(sale.error || "Choose at least one product."));
      return;
    }
    state.pending = {
      requestId: crypto.randomUUID(),
      items: sale.items.map(({ id, quantity }) => ({ id, quantity })),
      adjustmentCents: sale.adjustmentCents,
      paymentMethod: state.paymentMethod || "cash"
    };
    if (!persist()) {
      state.pending = null;
      render();
      return;
    }
  }
  busy = true;
  $("app-error").textContent = "";
  $("notice").textContent = "Confirming the walk-in sale. Do not start a replacement sale.";
  render();
  try {
    const data = await api(API, state.pending);
    state.receipt = data.receipt;
    state.pending = null;
    totals = data.totals;
    syncedAt = new Date();
    persist();
    showReceipt();
    $("reconnect").hidden = true;
  } catch (error) {
    if (error.status === 400) {
      state.pending = null;
      persist();
      $("notice").textContent = "Sale rejected. Nothing was recorded. Correct the sale and send again.";
    } else {
      $("notice").textContent = "Sale not yet confirmed on this device. Retry the same sale after reconnecting; it cannot be recorded twice.";
    }
    showError(error);
  } finally {
    busy = false;
    render();
  }
});

$("undo").addEventListener("click", () => {
  if (locked()) return;
  const change = undoHistory.pop();
  if (!change) return;
  const quantity = (state.quantities[change.id] || 0) - change.delta;
  if (quantity) state.quantities[change.id] = quantity;
  else delete state.quantities[change.id];
  if (!Object.keys(state.quantities).length) {
    state.adjustmentAmount = "";
    $("adjustment-amount").value = "";
  }
  persist();
  render();
});

$("clear").addEventListener("click", () => {
  if (locked() || !confirm("Clear all items and adjustments from this unsent sale?")) return;
  state.quantities = {};
  state.adjustmentAmount = "";
  state.adjustmentType = "discount";
  $("adjustment-amount").value = "";
  $("adjustment-type").value = "discount";
  undoHistory = [];
  $("notice").textContent = "";
  persist();
  render();
});

for (const id of ["adjustment-type", "adjustment-amount"]) {
  $(id).addEventListener(id === "adjustment-type" ? "change" : "input", () => {
    if (locked()) return;
    state.adjustmentType = $("adjustment-type").value;
    state.adjustmentAmount = $("adjustment-amount").value;
    persist();
    render();
  });
}

for (const input of document.querySelectorAll('input[name="payment-method"]')) {
  input.addEventListener("change", () => {
    if (locked()) return;
    state.paymentMethod = input.value;
    persist();
    render();
  });
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-button").disabled = true;
  try {
    await api("/api/admin/login", { password: $("password").value });
    $("password").value = "";
    await openRegister();
  } catch (error) {
    showError(error);
  } finally {
    $("login-button").disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  if (busy || financialBusy) return;
  try {
    await api("/api/admin/logout", {});
    authenticated = false;
    $("protected").hidden = true;
    $("login-section").hidden = false;
    $("logout").hidden = true;
    $("financial-nav").hidden = true;
    $("financial-dialog").close();
    $("connection").textContent = "Signed out. Unfinished sales are kept on this device.";
    $("connection").className = "";
    $("app-error").textContent = "";
  } catch (error) {
    showError(error);
  }
});

$("refresh").addEventListener("click", refreshTotals);
$("reconnect").addEventListener("click", async () => {
  if (busy) return;
  try {
    await openRegister();
  } catch (error) {
    showError(error);
  }
});

window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY || event.newValue === storedSnapshot) return;
  storageFailed = true;
  showError(new Error("This register was changed in another tab. Reconnect to load the latest sale before continuing."));
  render();
});

for (const event of ["online", "offline"]) {
  window.addEventListener(event, () => {
    $("connection").textContent = navigator.onLine ? "Reconnected - refreshing totals..." : "Offline - sale kept on this device; internet required to send";
    $("connection").className = "";
    render();
    if (navigator.onLine && authenticated) {
      refreshTotals().then(() => {
        if (!$("app-error").textContent && authenticated) {
          $("connection").textContent = "Connected to Tigris Dates";
          $("connection").className = "online";
        }
      });
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && authenticated && navigator.onLine && !busy) refreshTotals();
});

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener("appinstalled", () => { $("install").hidden = true; });
$("install").addEventListener("click", async () => {
  if (!installPrompt) {
    $("install-help").hidden = !$("install-help").hidden;
    return;
  }
  try {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
  } catch (error) {
    showError(error);
  }
});
if (matchMedia("(display-mode: standalone)").matches) $("install").hidden = true;

async function start() {
  try {
    if (!window.isSecureContext || !crypto.randomUUID) {
      throw new Error("Open this register over HTTPS (or localhost during development) to protect admin access and enable safe sale recording.");
    }
    const session = await api("/api/admin/session");
    if (session.authenticated) await openRegister();
    else {
      $("login-section").hidden = false;
      $("connection").textContent = "Sign in to connect to Tigris Dates";
    }
  } catch (error) {
    showError(error);
    $("connection").textContent = "Not connected - no sales will be sent automatically";
  }
  if ("serviceWorker" in navigator && window.isSecureContext) {
    try {
      await navigator.serviceWorker.register("/register/sw.js", { scope: "/register/" });
    } catch (error) {
      $("install-help").hidden = false;
      $("install-help").textContent = `Installation support could not load: ${error.message}. You can still use the register online.`;
    }
  }
}
start();
