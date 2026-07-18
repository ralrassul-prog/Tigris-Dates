const state = {
  products: []
};

const productGrid = document.getElementById("productGrid");
const orderForm = document.getElementById("orderForm");
const orderMessage = document.getElementById("orderMessage");
const orderTotal = document.getElementById("orderTotal");
const zelleHint = document.getElementById("zelleHint");
const whatsappLink = document.getElementById("whatsappLink");
const submitButton = orderForm.querySelector("button[type='submit']");

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

function updateTotal() {
  const items = getCartItems();
  orderTotal.textContent = `Total: ${money(computeTotal(items))}`;
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

  const selectedPayment = document.querySelector("input[name='paymentMethod']:checked")?.value || "card";
  const items = getCartItems();

  submitButton.disabled = true;
  submitButton.textContent = "Placing...";

  try {
    const data = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        customerName: document.getElementById("customerNameInput").value.trim(),
        items,
        paymentMethod: selectedPayment,
        phone: document.getElementById("phoneInput").value.trim(),
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

      if (data.whatsappLink) {
        whatsappLink.href = data.whatsappLink;
        whatsappLink.classList.remove("hidden");
      }

      zelleHint.textContent = `Zelle recipient: ${data.zellePayee}`;
      zelleHint.classList.remove("hidden");
    } else if (selectedPayment === "cash") {
      orderMessage.textContent = "Your order has been sent. Please pay cash when you meet the seller. We will process your order right away and confirm details with you.";
    }

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
    const selected = document.querySelector("input[name='paymentMethod']:checked")?.value;
    if (selected === "zelle") {
      zelleHint.textContent = "Send payment by Zelle after you place your order.";
      zelleHint.classList.remove("hidden");
    } else if (selected === "cash") {
      zelleHint.textContent = "Choose Cash if you will pay directly to the seller.";
      zelleHint.classList.remove("hidden");
    } else {
      zelleHint.classList.add("hidden");
    }
  });
});

orderForm.addEventListener("submit", submitOrder);

loadProducts().catch((error) => {
  orderMessage.textContent = error.message;
});

const currentUrl = new URL(window.location.href);
const checkoutStatus = currentUrl.searchParams.get("checkout");
if (checkoutStatus === "success") {
  orderMessage.style.color = "#0f766e";
  orderMessage.textContent = "Card payment successful. Thank you for your order!";
} else if (checkoutStatus === "cancelled") {
  orderMessage.textContent = "Card payment was cancelled. You can try again.";
} else {
  orderMessage.textContent = "";
}

if (checkoutStatus) {
  currentUrl.searchParams.delete("checkout");
  currentUrl.searchParams.delete("order");
  const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
  window.history.replaceState({}, document.title, nextUrl);
}
