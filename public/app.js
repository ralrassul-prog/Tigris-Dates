const state = {
  products: []
};

const productGrid = document.getElementById("productGrid");
const orderForm = document.getElementById("orderForm");
const orderMessage = document.getElementById("orderMessage");
const orderTotal = document.getElementById("orderTotal");
const zelleHint = document.getElementById("zelleHint");
const whatsappLink = document.getElementById("whatsappLink");
const deliveryAddressWrap = document.getElementById("deliveryAddressWrap");
const deliveryAddressInput = document.getElementById("deliveryAddressInput");
const orderSummaryDialog = document.getElementById("orderSummaryDialog");
const orderSummaryText = document.getElementById("orderSummaryText");
const closeSummaryButton = document.getElementById("closeSummaryButton");
const submitButton = orderForm.querySelector("button[type='submit']");
const DELIVERY_FEE_CENTS = 500;
const CARD_FEE_PERCENT = 0.029;
const CARD_FEE_FIXED_CENTS = 30;
const CARD_FEE_MODE = "gross_up";

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function getQuantity(productId) {
  const input = document.getElementById(`qty-${productId}`);
  if (!input) {
    return 0;
  }

  const quantity = Number(input.value || 0);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return 0;
  }

  return Math.floor(quantity);
}

function setQuantity(productId, nextValue) {
  const input = document.getElementById(`qty-${productId}`);
  if (!input) {
    return;
  }

  const value = Math.max(0, Math.min(99, Math.floor(nextValue)));
  input.value = String(value);
  updateTotal();
}

function getCartItems() {
  return state.products
    .map((product) => ({
      productId: product.id,
      quantity: getQuantity(product.id)
    }))
    .filter((item) => item.quantity > 0);
}

function computeTotal(items) {
  let total = 0;
  for (const item of items) {
    const product = state.products.find((p) => p.id === item.productId);
    if (product) {
      total += product.priceCents * item.quantity;
    }
  }
  return total;
}

function getSelectedPaymentMethod() {
  return document.querySelector("input[name='paymentMethod']:checked")?.value || "cash";
}

function getSelectedFulfillmentMethod() {
  return document.querySelector("input[name='fulfillmentMethod']:checked")?.value || "pickup";
}

function calculateCardFeeCents(baseCents) {
  if (baseCents <= 0) {
    return 0;
  }

  if (CARD_FEE_MODE === "simple") {
    return Math.max(0, Math.round((baseCents * CARD_FEE_PERCENT) + CARD_FEE_FIXED_CENTS));
  }

  const grossedUpTotalCents = Math.round((baseCents + CARD_FEE_FIXED_CENTS) / (1 - CARD_FEE_PERCENT));
  return Math.max(0, grossedUpTotalCents - baseCents);
}

function computeCheckoutBreakdown(items) {
  const subtotalCents = computeTotal(items);
  const fulfillmentMethod = getSelectedFulfillmentMethod();
  const paymentMethod = getSelectedPaymentMethod();
  const deliveryFeeCents = fulfillmentMethod === "delivery" ? DELIVERY_FEE_CENTS : 0;
  const preCardTotalCents = subtotalCents + deliveryFeeCents;
  const cardFeeCents = paymentMethod === "card" ? calculateCardFeeCents(preCardTotalCents) : 0;
  const totalCents = preCardTotalCents + cardFeeCents;

  return {
    subtotalCents,
    deliveryFeeCents,
    cardFeeCents,
    totalCents,
    paymentMethod
  };
}

function updateTotal() {
  const items = getCartItems();
  const breakdown = computeCheckoutBreakdown(items);
  const lines = [
    `Subtotal: ${money(breakdown.subtotalCents)}`
  ];

  if (breakdown.deliveryFeeCents > 0) {
    lines.push(`Delivery: ${money(breakdown.deliveryFeeCents)}`);
  }

  if (breakdown.paymentMethod === "card") {
    lines.push(`Card processing fee: ${money(breakdown.cardFeeCents)}`);
    lines.push(`Total due now: ${money(breakdown.totalCents)}`);
  } else {
    lines.push(`Total due: ${money(breakdown.totalCents)}`);
  }

  orderTotal.textContent = lines.join("\n");
}

function getItemName(productId) {
  const product = state.products.find((entry) => entry.id === productId);
  return product ? product.name : productId;
}

function openSummaryDialog(text) {
  if (!text) {
    return;
  }

  if (orderSummaryDialog && typeof orderSummaryDialog.showModal === "function") {
    orderSummaryText.textContent = text;
    if (!orderSummaryDialog.open) {
      orderSummaryDialog.showModal();
    }
    return;
  }

  window.alert(text);
}

function buildSummaryText({ items, paymentLabel, fulfillmentMethod, address, totalText }) {
  const lines = [
    "Order placed successfully.",
    "Items:"
  ];

  if (items.length > 0) {
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  } else {
    lines.push("None");
  }

  lines.push("");
  lines.push(`Payment: ${paymentLabel}`);
  lines.push(`Fulfillment: ${fulfillmentMethod === "delivery" ? "Delivery" : "Pickup"}`);

  if (fulfillmentMethod === "delivery" && address) {
    lines.push(`Address: ${address}`);
  }

  lines.push(`Total: ${totalText}`);
  return lines.join("\n");
}

function updateFulfillmentUI() {
  const fulfillmentMethod = getSelectedFulfillmentMethod();
  const isDelivery = fulfillmentMethod === "delivery";

  deliveryAddressWrap.classList.toggle("hidden", !isDelivery);
  deliveryAddressInput.required = isDelivery;

  if (!isDelivery) {
    deliveryAddressInput.value = "";
  }
}

function renderProducts() {
  productGrid.innerHTML = "";

  for (const product of state.products) {
    const article = document.createElement("article");
    article.className = "product-item";
    article.innerHTML = `
      <h4>${product.name}</h4>
      <p class="product-meta">${money(product.priceCents)}</p>
      <div class="qty-shell">
        <button type="button" class="qty-btn" data-action="decrement" data-product-id="${product.id}" aria-label="Decrease ${product.name}">-</button>
        <input id="qty-${product.id}" class="qty-input" type="text" inputmode="numeric" value="0" aria-label="Quantity for ${product.name}" />
        <button type="button" class="qty-btn" data-action="increment" data-product-id="${product.id}" aria-label="Increase ${product.name}">+</button>
      </div>
    `;

    productGrid.appendChild(article);
  }

  updateTotal();
}

async function loadProducts() {
  const data = await api("/api/products", { method: "GET" });
  state.products = data.products || [];
  renderProducts();
}

async function submitOrder(event) {
  event.preventDefault();

  orderMessage.textContent = "";
  orderMessage.style.color = "#a61b1b";
  whatsappLink.classList.add("hidden");
  zelleHint.classList.add("hidden");

  const selectedPayment = getSelectedPaymentMethod();
  const selectedFulfillmentMethod = getSelectedFulfillmentMethod();
  const items = getCartItems();

  submitButton.disabled = true;
  submitButton.textContent = "Placing...";

  try {
    const address = deliveryAddressInput.value.trim();

    const data = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        customerName: document.getElementById("customerNameInput").value.trim(),
        items,
        paymentMethod: selectedPayment,
        fulfillmentMethod: selectedFulfillmentMethod,
        phone: document.getElementById("phoneInput").value.trim(),
        address,
        notes: document.getElementById("notesInput").value.trim()
      })
    });

    if (selectedPayment === "card" && data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return;
    }

    orderMessage.style.color = "#0f766e";

    if (selectedPayment === "zelle") {
      orderMessage.textContent = "Your order has been sent. Please pay by Zelle and confirm with the seller. We will process your order as soon as payment is confirmed.";

      zelleHint.textContent = `Zelle recipient: ${data.zellePayee}`;
      zelleHint.classList.remove("hidden");
    } else if (selectedPayment === "cash") {
      orderMessage.textContent = "Your order has been sent. Please pay cash when you meet the seller. We will process your order right away and confirm details with you.";
    }

    if (data.whatsappLink) {
      whatsappLink.href = data.whatsappLink;
      whatsappLink.classList.remove("hidden");
    }

    const summaryItems = items.map((item) => `${item.quantity} x ${getItemName(item.productId)}`);
    const paymentLabel = selectedPayment === "card"
      ? "Card"
      : selectedPayment === "zelle"
        ? "Zelle"
        : "Cash";
    openSummaryDialog(buildSummaryText({
      items: summaryItems,
      paymentLabel,
      fulfillmentMethod: selectedFulfillmentMethod,
      address,
      totalText: data.total || orderTotal.textContent.split("\n").pop()?.replace("Total due now: ", "").replace("Total due: ", "") || "$0.00"
    }));

    const keepName = document.getElementById("customerNameInput").value;
    const keepPhone = document.getElementById("phoneInput").value;

    orderForm.reset();
    document.getElementById("customerNameInput").value = keepName;
    document.getElementById("phoneInput").value = keepPhone;

    for (const product of state.products) {
      setQuantity(product.id, 0);
    }

    updateTotal();
  } catch (error) {
    orderMessage.style.color = "#a61b1b";
    orderMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Place Order";
  }
}

productGrid.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  const productId = target.dataset.productId;
  if (!action || !productId) {
    return;
  }

  const current = getQuantity(productId);
  if (action === "increment") {
    setQuantity(productId, current + 1);
  }

  if (action === "decrement") {
    setQuantity(productId, current - 1);
  }
});

productGrid.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.id.startsWith("qty-")) {
    return;
  }

  const productId = target.id.replace("qty-", "");
  const normalized = Number((target.value || "").replace(/\D/g, ""));
  setQuantity(productId, Number.isFinite(normalized) ? normalized : 0);
});

document.querySelectorAll("input[name='paymentMethod']").forEach((radio) => {
  radio.addEventListener("change", () => {
    const selected = getSelectedPaymentMethod();
    if (selected === "zelle") {
      zelleHint.textContent = "Send payment by Zelle after you place your order.";
      zelleHint.classList.remove("hidden");
    } else if (selected === "cash") {
      zelleHint.textContent = "Choose Cash if you will pay directly to the seller.";
      zelleHint.classList.remove("hidden");
    } else {
      zelleHint.classList.add("hidden");
    }

    updateTotal();
  });
});

document.querySelectorAll("input[name='fulfillmentMethod']").forEach((radio) => {
  radio.addEventListener("change", () => {
    updateFulfillmentUI();
    updateTotal();
  });
});

closeSummaryButton?.addEventListener("click", () => {
  if (orderSummaryDialog?.open) {
    orderSummaryDialog.close();
  }
});

orderForm.addEventListener("submit", submitOrder);

loadProducts().catch((error) => {
  orderMessage.textContent = error.message;
});

const currentUrl = new URL(window.location.href);
const checkoutStatus = currentUrl.searchParams.get("checkout");
const checkoutSessionId = currentUrl.searchParams.get("session_id");

async function finalizeCardCheckout(sessionId) {
  const data = await api("/api/orders/confirm-card-session", {
    method: "POST",
    body: JSON.stringify({ sessionId })
  });

  return data;
}

async function handleCheckoutStatus() {
  if (checkoutStatus === "success") {
    orderMessage.style.color = "#0f766e";
    orderMessage.textContent = "Card payment successful. Finalizing your order...";

    if (checkoutSessionId) {
      try {
        const data = await finalizeCardCheckout(checkoutSessionId);
        orderMessage.textContent = data.alreadyConfirmed
          ? "Card payment successful. Your order is already confirmed."
          : `Card payment successful. Order #${data.orderId} is confirmed.`;

        if (data.order?.whatsappLink) {
          whatsappLink.href = data.order.whatsappLink;
          whatsappLink.classList.remove("hidden");
        }

        if (data.order) {
          const summaryItems = (data.order.items || [])
            .map((item) => `${item.quantity} x ${item.productName}`);

          openSummaryDialog(buildSummaryText({
            items: summaryItems,
            paymentLabel: "Card",
            fulfillmentMethod: data.order.fulfillmentMethod,
            address: data.order.address,
            totalText: data.order.total
          }));
        }
      } catch (error) {
        orderMessage.style.color = "#a61b1b";
        orderMessage.textContent = "Payment succeeded, but order confirmation is still processing. Please refresh admin in a moment.";
      }
    } else {
      orderMessage.textContent = "Card payment successful. Thank you for your order!";
    }
  } else if (checkoutStatus === "cancelled") {
    orderMessage.textContent = "Card payment was cancelled. You can try again.";
  } else {
    orderMessage.textContent = "";
  }

  if (checkoutStatus) {
    currentUrl.searchParams.delete("checkout");
    currentUrl.searchParams.delete("order");
    currentUrl.searchParams.delete("session_id");
    const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    window.history.replaceState({}, document.title, nextUrl);
  }
}

updateFulfillmentUI();
handleCheckoutStatus();
