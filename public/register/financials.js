"use strict";

const FINANCIAL_API = "/api/admin/register-financials";
const FINANCIAL_STORAGE = "tigris-register-financial-operation-v1";
let financialData = null;
let financialLoading = false;
let financialOperation = null;
let financialSnapshot = null;
let financialStorageFailed = false;
let financialFormKind = null;
let financialPaymentOrder = null;
let financialCostRevision = 0;
let financialCountBaseline = {};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function financialError(error) {
  const message = error.name === "AbortError" ? "Connection timed out. Retry the same saved operation after reconnecting." : error.message;
  $("financial-error").textContent = message;
  $("financial-form-error").textContent = message;
  showError(error);
}

function updateFinancialControls() {
  const lockedFinancial = financialBusy || Boolean(financialOperation) || financialStorageFailed || busy || Boolean(state.pending);
  financialRecoveryLocked = Boolean(financialOperation) || financialStorageFailed;
  for (const id of ["edit-costs", "add-expense", "add-delivered", "financial-save"]) $(id).disabled = lockedFinancial || !authenticated;
  for (const button of $("pending-orders").querySelectorAll("button")) button.disabled = lockedFinancial || !authenticated;
  $("financial-refresh").disabled = financialLoading || financialBusy || !authenticated || !navigator.onLine;
  $("financial-recovery").hidden = !financialOperation && !financialStorageFailed;
  $("financial-recovery-text").textContent = financialOperation
    ? "An operation is not yet confirmed on this device. Retry the same saved request; do not create a replacement or clear browser storage."
    : "Recovery storage is unavailable or changed in another tab. Reconnect before recording financial changes.";
  $("financial-retry").disabled = financialBusy || financialStorageFailed || !financialOperation || !authenticated || !navigator.onLine;
  $("financial-nav").disabled = financialBusy || busy;
  $("financial-cancel").disabled = financialBusy;
  render();
}

function restoreFinancialOperation() {
  try {
    financialSnapshot = localStorage.getItem(FINANCIAL_STORAGE);
    financialOperation = financialSnapshot ? JSON.parse(financialSnapshot) : null;
    if (financialOperation && (!financialOperation.path?.startsWith(`${FINANCIAL_API}/`)
      || !financialOperation.body || !/^[0-9a-f-]{36}$/i.test(financialOperation.body.requestId))) {
      throw new Error("Financial recovery data is invalid. Check admin before clearing it.");
    }
    financialStorageFailed = false;
  } catch (error) {
    financialStorageFailed = true;
    financialError(error);
  }
  updateFinancialControls();
}

function saveFinancialOperation(operation) {
  try {
    if (localStorage.getItem(FINANCIAL_STORAGE) !== financialSnapshot) {
      throw new Error("Financial changes were made in another tab. Reconnect to load the saved operation.");
    }
    const snapshot = operation ? JSON.stringify(operation) : null;
    if (snapshot) localStorage.setItem(FINANCIAL_STORAGE, snapshot);
    else localStorage.removeItem(FINANCIAL_STORAGE);
    financialSnapshot = snapshot;
    financialOperation = operation;
    financialStorageFailed = false;
    return true;
  } catch (error) {
    financialStorageFailed = true;
    financialError(error);
    updateFinancialControls();
    return false;
  }
}

async function loadFinancials() {
  if (!authenticated || financialLoading) return;
  financialLoading = true;
  updateFinancialControls();
  try {
    financialData = await api(FINANCIAL_API);
    renderFinancialData();
    $("financial-error").textContent = "";
    $("financial-synced").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    $("financial-synced").textContent = "Not current - refresh before relying on these figures";
    financialError(error);
  } finally {
    financialLoading = false;
    updateFinancialControls();
  }
}

function row(label, value, className = "") {
  const node = element("div", `row ${className}`);
  node.append(element("span", "", label), element("strong", "", value));
  return node;
}

function renderFinancialData() {
  const data = financialData;
  $("financial-data").hidden = false;
  $("net-profit").textContent = data.settings ? formatMoney(data.netCents) : "Set up costs";
  $("profit-label").textContent = data.complete ? "OVERALL PROFIT - ESTIMATE" : "OVERALL ESTIMATE - COSTS EXCLUDED";
  $("profit-verdict").textContent = !data.complete ? "Complete missing costs before trusting this number."
    : data.netCents > 0 ? "You're making money on fully paid orders." : data.netCents < 0 ? "Fully paid orders are running at a loss." : "You're breaking even.";
  $("financial-revenue").textContent = formatMoney(data.revenueCents);
  $("financial-margin").textContent = data.settings && data.revenueCents ? `${(data.netCents / data.revenueCents * 100).toFixed(1)}%` : "--";
  $("cost-warning").hidden = !data.warnings.length;
  $("cost-warning").textContent = data.warnings.join(" ");
  $("breakdown-sales").textContent = formatMoney(data.revenueCents);
  $("financial-cogs").textContent = data.settings ? `- ${formatMoney(data.cogsCents)}` : "Not configured";
  $("financial-overhead").textContent = `- ${formatMoney(data.overheadCents)}`;
  $("financial-fees").textContent = `- ${formatMoney(data.feeCents)}`;
  $("breakdown-profit").textContent = data.settings ? formatMoney(data.netCents) : "--";
  $("cost-tiles").replaceChildren();
  $("cost-details").replaceChildren();
  for (const kind of ["mix", "jumbo"]) {
    const cost = data.dateCosts[kind];
    const title = kind === "mix" ? "Mix" : "Jumbo";
    const tile = element("div", "metric");
    tile.append(element("h3", "", `${title} / lb`),
      element("strong", "", cost.fullCentsPerPound === null ? "--" : formatMoney(cost.fullCentsPerPound)),
      element("p", "hint", cost.profitCentsPerPound === null ? "Enter costs and record paid sales to calculate."
        : `Dates + freight + empty box cost per lb. ${formatMoney(cost.profitCentsPerPound)} date gross profit / lb sold.`));
    tile.append(row("Paid pounds sold", String(cost.paidPounds)),
      row("Date sales", formatMoney(cost.revenueCents)),
      row("Dates, freight & boxes", cost.baseCentsPerPound === null ? "--" : formatMoney(Math.round(cost.costCents))),
      row("Gross profit", cost.grossProfitCents === null ? "--" : formatMoney(cost.grossProfitCents)));
    $("cost-tiles").append(tile);
    $("cost-details").append(element("p", "hint", `${title}: ${cost.baseCentsPerPound === null ? "costs not configured" : `${formatMoney(cost.baseCentsPerPound)} dates / lb + ${formatMoney(cost.freightCentsPerPound)} freight / lb; ${formatMoney(cost.boxesCents)} empty boxes on paid sales`}. ${cost.paidPounds} lb fully paid; ${cost.pendingPounds} lb delivered, pending payment; ${cost.remainingPounds === null ? "unknown" : cost.remainingPounds} lb remaining.`));
    if (cost.stockAdjustmentPounds) {
      $("cost-details").append(element("p", "hint", `${title} stock count adjustment: ${cost.stockAdjustmentPounds > 0 ? "+" : ""}${cost.stockAdjustmentPounds} lb versus purchase/delivery records. This changes stock only, not sales or profit.`));
    }
  }
  $("cost-details").append(element("p", "hint", "Date gross profit = paid date sales after discounts, recorded card fees and delivery charges, minus paid pounds x (date cost/lb + total inbound freight / purchased pounds), minus empty boxes used on paid sales. Unsold stock and open pending orders are not deducted from profit. Honey and operating expenses are separate. Historical sales without quantities make this comparison incomplete."));
  $("date-gross-profit").textContent = data.dateGrossProfitCents === null ? "--" : formatMoney(data.dateGrossProfitCents);
  $("date-after-expenses").textContent = data.dateProfitAfterExpensesCents === null ? "--" : formatMoney(data.dateProfitAfterExpensesCents);
  $("pending-summary").textContent = `Pending payments (${data.pending.length}) - ${formatMoney(data.pendingBalanceCents)} owed`;
  $("pending-balance").textContent = formatMoney(data.pendingBalanceCents);
  $("pending-collected").textContent = formatMoney(data.pendingReceivedCents);
  $("closed-summary").textContent = `Recently paid (${data.closed.length})`;
  for (const [id, orders] of [["pending-orders", data.pending], ["closed-orders", data.closed]]) {
    $(id).replaceChildren();
    if (!orders.length) $(id).append(element("p", "hint", id === "pending-orders" ? "Nothing outstanding." : "No recently paid delivered orders."));
    for (const order of orders) {
      const card = element("article", "pending-card");
      card.dataset.orderId = order.id;
      const heading = element("div", "row");
      heading.append(element("h3", "", order.name), element("span", `badge ${order.status === "closed" ? "closed" : ""}`,
        order.status === "closed" ? "Paid & closed" : order.receivedCents ? "Partially paid" : "Unpaid"));
      card.append(heading, element("p", "hint", `Delivered: ${order.items.map(item => `${item.quantity} x ${item.name}`).join(", ")}${order.sourceOrderId ? ` (online order #${order.sourceOrderId})` : ""}`),
        row("Order total", formatMoney(order.totalCents)), row("Received", formatMoney(order.receivedCents)), row("Balance due", formatMoney(order.balanceCents)));
      card.append(element("p", "hint", order.payments.length ? order.payments.map(payment =>
        `${payment.method === "zelle" ? "Zelle" : "Cash"} ${formatMoney(payment.amountCents)} (${new Date(payment.createdAt.replace(" ", "T") + "Z").toLocaleDateString()})`).join(" + ") : "No payments received yet."));
      if (order.status !== "closed") {
        const button = element("button", "add", "Record payment");
        button.type = "button";
        button.setAttribute("aria-label", `Record payment for ${order.name}`);
        button.onclick = () => openPayment(order);
        card.append(button);
      }
      $(id).append(card);
    }
  }
  $("financial-expenses").replaceChildren();
  for (const expense of data.expenses) {
    const expenseRow = row(expense.name, formatMoney(expense.amountCents), "expense-row");
    $("financial-expenses").append(expenseRow);
  }
  if (!data.expenses.length) $("financial-expenses").append(element("p", "hint", "No expenses recorded. Add rent and other operating costs."));
  $("cash-sales").textContent = formatMoney(data.paid.cashCents);
  $("zelle-sales").textContent = formatMoney(data.paid.zelleCents);
  $("combined-paid-sales").textContent = formatMoney(data.revenueCents);
  updateFinancialControls();
}

function field(parent, id, title, type = "number", value = "", min = "0", required = true) {
  const label = element("label", "", title);
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.value = value;
  input.required = required;
  if (type === "number") {
    input.min = min;
    input.max = "999999.99";
    input.step = "0.01";
    input.inputMode = "decimal";
  } else input.maxLength = 100;
  label.append(input);
  parent.append(label);
  return input;
}

function selectField(parent, id, title, options) {
  const label = element("label", "", title);
  const select = document.createElement("select");
  select.id = id;
  for (const [value, text] of options) {
    const option = element("option", "", text);
    option.value = value;
    select.append(option);
  }
  label.append(select); parent.append(label);
  return select;
}

function openFinancialForm(kind, title, hint, saveLabel) {
  if (financialBusy || financialOperation || financialStorageFailed || busy || state.pending) return false;
  financialFormKind = kind;
  $("financial-fields").replaceChildren();
  $("financial-dialog-title").textContent = title;
  $("financial-dialog-hint").textContent = hint;
  $("financial-form-error").textContent = "";
  $("financial-save").textContent = saveLabel;
  return true;
}

function openCosts() {
  if (!openFinancialForm("costs", "Date, freight & empty box costs", "Enter date cost per pound excluding separate freight. Freight is the cumulative inbound shipping total for the purchased pounds. If your saved rate already includes freight, leave freight at $0 or subtract it from the rate first. Honey cost remains excluded.", "Save & recalculate")) return;
  const settings = financialData.settings;
  financialCostRevision = financialData.revision;
  financialCountBaseline = Object.fromEntries(["mix", "jumbo"].map(kind => [kind, financialData.dateCosts[kind].deliveredPounds]));
  for (const kind of ["mix", "jumbo"]) {
    const group = element("fieldset");
    group.append(element("legend", "", `${kind === "mix" ? "Mix" : "Jumbo"} dates - cumulative stock`));
    field(group, `cost-${kind}-pounds`, "Pounds purchased (0 if none)", "number", settings ? settings[kind].pounds : "", "0");
    const remaining = financialData.dateCosts[kind].remainingPounds;
    field(group, `cost-${kind}-unsold`, "Pounds left unsold (actual stock count)", "number", remaining !== null && remaining >= 0 ? remaining : "", "0");
    group.append(element("p", "hint", "Enter pounds physically still in stock, excluding delivered unpaid orders. Future deliveries reduce this count. Changing it does not create sales or change profit."));
    field(group, `cost-${kind}-rate`, "Your cost per pound ($)", "number", settings ? settings[kind].costPerPoundCents / 100 : "").step = "any";
    field(group, `cost-${kind}-freight`, "Inbound shipping / freight total ($)", "number", settings ? (settings[kind].freightCents / 100).toFixed(2) : "0");
    $("financial-fields").append(group);
  }
  field($("financial-fields"), "cost-box5", "Empty 5 lb box cost ($ per box)", "number", settings ? (settings.box5Cents / 100).toFixed(2) : "0");
  field($("financial-fields"), "cost-box10", "Empty 10 lb box cost ($ per box)", "number", settings ? (settings.box10Cents / 100).toFixed(2) : "0");
  $("financial-dialog").showModal();
}

function openExpense() {
  if (!openFinancialForm("expenses", "Add an expense", "One-time operating expense, saved in the existing backend expense list. Don't add date purchases already covered by your per-pound cost.", "Add & recalculate")) return;
  field($("financial-fields"), "expense-name", "Expense name", "text");
  field($("financial-fields"), "expense-amount", "Amount ($)", "number", "", "0.01");
  $("financial-dialog").showModal();
}

function openPayment(order) {
  if (!openFinancialForm("payment", "Record payment", `${order.name} - ${formatMoney(order.balanceCents)} remaining. Record only money you actually received.`, "Record received payment")) return;
  financialPaymentOrder = order;
  const input = field($("financial-fields"), "payment-amount", "Amount received ($)", "number", (order.balanceCents / 100).toFixed(2), "0.01");
  input.max = (order.balanceCents / 100).toFixed(2);
  selectField($("financial-fields"), "payment-method", "Paid with", [["cash", "Cash"], ["zelle", "Zelle"]]);
  const effect = element("p", "hint"); effect.id = "payment-effect"; effect.setAttribute("aria-live", "polite");
  $("financial-fields").append(effect);
  input.oninput = () => {
    const amount = Math.round(Number(input.value) * 100);
    effect.textContent = amount === order.balanceCents
      ? `Clears this balance. The full ${formatMoney(order.totalCents)} order enters sales once, with product costs deducted from profit.`
      : amount > 0 && amount < order.balanceCents ? `${formatMoney(order.balanceCents - amount)} remains owed. Paid sales totals stay unchanged until cleared.` : "Enter an amount no greater than the remaining balance.";
  };
  input.oninput(); $("financial-dialog").showModal();
}

function addDeliveredLine() {
  const line = element("div", "delivered-line");
  const number = crypto.randomUUID();
  const product = selectField(line, `delivered-product-${number}`, "Product", financialData.catalog.map(item => [item.id, `${item.name} - ${formatMoney(item.priceCents)}`]));
  product.className = "delivered-product";
  const quantity = field(line, `delivered-quantity-${number}`, "Qty", "number", "1", "1");
  quantity.step = "1"; quantity.max = "999"; quantity.className = "delivered-quantity";
  const remove = element("button", "add", "-"); remove.type = "button"; remove.setAttribute("aria-label", "Remove product");
  remove.onclick = () => { line.remove(); updateDeliveredTotal(); };
  product.onchange = updateDeliveredTotal; quantity.oninput = updateDeliveredTotal;
  line.append(remove); $("delivered-lines").append(line); updateDeliveredTotal();
}

function updateDeliveredTotal() {
  if (!$("delivered-lines")) return;
  const sourceId = $("delivered-source").value;
  $("delivered-new-fields").hidden = Boolean(sourceId);
  for (const input of $("delivered-new-fields").querySelectorAll("input, select")) input.disabled = Boolean(sourceId);
  if (sourceId) {
    const source = financialData.availableOrders.find(order => String(order.id) === sourceId);
    $("delivered-total").value = (source.totalCents / 100).toFixed(2);
    $("delivered-total").readOnly = true;
  } else {
    $("delivered-total").readOnly = false;
    const total = [...$("delivered-lines").children].reduce((sum, line) => {
      const item = financialData.catalog.find(item => item.id === line.querySelector("select").value);
      return sum + item.priceCents * Number(line.querySelector("input").value);
    }, 0);
    $("delivered-total").value = (total / 100).toFixed(2);
  }
  $("delivered-initial").max = ((Math.round(Number($("delivered-total").value) * 100) - 1) / 100).toFixed(2);
}

function openDelivered() {
  if (!openFinancialForm("delivered", "Delivered order", "For goods already delivered but not fully paid. If this is an online order, select it below rather than adding a duplicate. Initial received payment must be less than the total.", "Add pending order")) return;
  selectField($("financial-fields"), "delivered-source", "Order source", [["", "New store / person order"],
    ...financialData.availableOrders.map(order => [String(order.id), `Online #${order.id} ${order.name} - ${formatMoney(order.totalCents)}`])]).onchange = updateDeliveredTotal;
  const group = element("div", "form-group"); group.id = "delivered-new-fields";
  field(group, "delivered-name", "Store or person", "text");
  const lines = element("div", "form-group"); lines.id = "delivered-lines"; group.append(lines);
  const add = element("button", "add", "+ Product"); add.type = "button"; add.onclick = addDeliveredLine; group.append(add);
  $("financial-fields").append(group);
  field($("financial-fields"), "delivered-total", "Agreed order total ($), after discounts", "number", "", "0.01").oninput = () => {
    $("delivered-initial").max = ((Math.round(Number($("delivered-total").value) * 100) - 1) / 100).toFixed(2);
  };
  field($("financial-fields"), "delivered-initial", "Already received ($)", "number", "0");
  selectField($("financial-fields"), "delivered-method", "Initial payment method", [["cash", "Cash"], ["zelle", "Zelle"]]);
  addDeliveredLine(); $("financial-dialog").showModal();
}

async function submitFinancialOperation(operation) {
  if (financialBusy || !authenticated || busy || state.pending || financialStorageFailed) return;
  if (!navigator.onLine) { financialError(new Error("Internet is required. No payment or expense was submitted.")); return; }
  if (!financialOperation && !saveFinancialOperation(operation)) return;
  financialBusy = true; updateFinancialControls();
  $("financial-error").textContent = ""; $("financial-form-error").textContent = "";
  try {
    const result = await api(financialOperation.path, financialOperation.body);
    if (!saveFinancialOperation(null)) return;
    $("financial-dialog").close();
    $("financial-notice").textContent = result.message;
    await loadFinancials();
    const current = await api(API);
    totals = current.totals; syncedAt = new Date();
    render();
  } catch (error) {
    if ([400, 409, 410].includes(error.status)) saveFinancialOperation(null);
    financialError(error);
  } finally {
    financialBusy = false; updateFinancialControls();
  }
}

function dollarsToCents(id) {
  const input = $(id);
  if (!input.validity.valid || input.value === "" || !/^\d+(?:\.\d{1,2})?$/.test(input.value)) {
    throw new Error("Enter valid dollar amounts with up to two decimal places.");
  }
  const [whole, fraction = ""] = input.value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

$("financial-form").onsubmit = async event => {
  event.preventDefault();
  if (!$("financial-form").checkValidity() || financialOperation) return;
  try {
    let path = `${FINANCIAL_API}/${financialFormKind}`, body = { requestId: crypto.randomUUID() };
    if (financialFormKind === "costs") {
      body.revision = financialCostRevision;
      body.settings = { version: 3, box5Cents: dollarsToCents("cost-box5"), box10Cents: dollarsToCents("cost-box10") };
      for (const kind of ["mix", "jumbo"]) body.settings[kind] = { pounds: Number($(`cost-${kind}-pounds`).value),
        costPerPoundCents: Number($(`cost-${kind}-rate`).value) * 100, freightCents: dollarsToCents(`cost-${kind}-freight`),
        unsoldPounds: Number($(`cost-${kind}-unsold`).value), expectedDeliveredPounds: financialCountBaseline[kind] };
    } else if (financialFormKind === "expenses") {
      body.name = $("expense-name").value.trim(); body.amountCents = dollarsToCents("expense-amount");
    } else if (financialFormKind === "payment") {
      path = `${FINANCIAL_API}/delivered/${financialPaymentOrder.id}/payments`;
      body.amountCents = dollarsToCents("payment-amount"); body.paymentMethod = $("payment-method").value;
    } else if (financialFormKind === "delivered") {
      body.initialCents = dollarsToCents("delivered-initial"); body.paymentMethod = $("delivered-method").value;
      if ($("delivered-source").value) body.sourceOrderId = Number($("delivered-source").value);
      else {
        body.name = $("delivered-name").value.trim(); body.totalCents = dollarsToCents("delivered-total");
        body.items = [...$("delivered-lines").children].map(line => ({ id: line.querySelector("select").value, quantity: Number(line.querySelector("input").value) }));
      }
    }
    await submitFinancialOperation({ path, body });
  } catch (error) { financialError(error); }
};

$("financial-nav").onclick = async () => {
  const opening = $("financial-screen").hidden;
  $("financial-screen").hidden = !opening; $("sale-screen").hidden = opening;
  $("financial-nav").textContent = opening ? "\u2190 New sale" : "Financials \u2197";
  $("financial-nav").setAttribute("aria-expanded", String(opening));
  if (opening) {
    $("financial-title").focus(); restoreFinancialOperation(); await loadFinancials();
  } else {
    $("presets").firstElementChild?.focus();
    await refreshTotals();
  }
};
$("financial-refresh").onclick = refreshTotals;
$("edit-costs").onclick = openCosts;
$("add-expense").onclick = openExpense;
$("add-delivered").onclick = openDelivered;
$("financial-cancel").onclick = () => { if (!financialBusy) $("financial-dialog").close(); };
$("financial-dialog").addEventListener("cancel", event => { if (financialBusy) event.preventDefault(); });
$("financial-retry").onclick = () => submitFinancialOperation(financialOperation);
window.addEventListener("storage", event => {
  if (event.key !== FINANCIAL_STORAGE || event.newValue === financialSnapshot) return;
  financialStorageFailed = true;
  financialError(new Error("Financial operation changed in another tab. Reconnect before continuing."));
  updateFinancialControls();
});
