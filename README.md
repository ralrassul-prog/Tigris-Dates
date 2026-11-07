# Tigris Dates Ordering App

A customer-friendly ordering web app for Medjool dates with:

- Direct guest checkout (no account required)
- Product selection for your four box options
- Credit card checkout (Stripe)
- Zelle option
- One-click WhatsApp order message link
- Owner backend endpoints for order tracking
- Installable Android walk-in register with live sales totals
- Owner register financials, product/packaging costs, and delivered-order partial payments

## Product Catalog

- 5lb Mix Box: $25
- 5lb Jumbo Box: $30
- 10lb Mix Box: $50
- 10lb Jumbo Box: $60

## Tech Stack

- Node.js + Express
- SQLite (better-sqlite3)
- Stripe Checkout for card payments
- Vanilla HTML/CSS/JS frontend

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
copy .env.example .env
```

3. Edit `.env` and set these values:

- `ADMIN_PASSWORD`: password for admin login
- `ADMIN_SESSION_SECRET`: random secret used to sign admin session cookies
- `WHATSAPP_BUSINESS_NUMBER`: your WhatsApp number in international format, digits only
- `ZELLE_PAYEE`: your Zelle email or phone
- `STRIPE_SECRET_KEY`: your Stripe secret key to enable card checkout
- `BASE_URL`: app URL, usually `http://localhost:4000`

4. Start app in development:

```bash
npm run dev
```

5. Open in browser:

- `http://localhost:4000`

## Stripe Notes

- Card payments are handled with Stripe Checkout.
- Connect your bank account in Stripe Dashboard so payouts go to your bank.
- To automatically mark orders paid after checkout, set `STRIPE_WEBHOOK_SECRET` and configure Stripe webhook endpoint:
  - `POST /api/stripe/webhook`

## WhatsApp + Zelle Flow

When customer chooses **Zelle**:

- Order is created with status `awaiting_zelle`
- App shows your Zelle recipient value
- App provides a WhatsApp link with a prefilled order message for fast confirmation

## Owner Backend (Order Tracking)

Admin endpoints require a signed admin session cookie.
Sign in from the admin page first:

Browser admin page:

- `http://localhost:4000/admin.html`

Auth endpoints:

- `POST /api/admin/login`
  - Body: `{ "password": "<ADMIN_PASSWORD>" }`
  - Sets admin session cookie.
- `POST /api/admin/logout`
  - Clears admin session cookie.
- `GET /api/admin/session`
  - Returns whether current browser session is authenticated.

- `GET /api/admin/orders`
  - List latest orders with order items.
  - Query params: `status`, `paymentMethod`, `customer`, `limit`
- `GET /api/admin/orders/:orderId`
  - Get one order with item details.
- `PATCH /api/admin/orders/:orderId/status`
  - Update order status.
  - Allowed statuses: `awaiting_card_payment`, `awaiting_zelle`, `paid`, `ready_for_pickup`, `completed`, `cancelled`
- `GET /api/admin/summary`
  - Quick metrics: counts by status and paid revenue.

## Android Walk-in Register

Open `/register/` on the **same deployed Tigris Dates website** as the admin
backend, or use `http://localhost:4000/register/` for local development. The admin
page also has an **Open Walk-in Register** link.

On an Android phone:

1. Deploy these changes to your existing HTTPS Tigris Dates host.
2. Open that website's `/register/` address in Chrome.
3. Tap **Install app**, or use Chrome's **Install app / Add to Home screen** menu.
4. Open **Tigris Sales** from the home screen and sign in with your existing
   admin password. The signed admin session is shared with the admin page and
   expires after 12 hours.

This is a progressive web app (PWA), not an APK. No emailed installer is needed.
`localhost` on your computer is not accessible as your website on your phone;
phone installation requires your deployed HTTPS address.

### Recording a sale

- Presets: Mix $25 / $50, Jumbo $30 / $60, Honey $15, Misc $5 / $10 / $100.
  These are fixed walk-in shortcuts, independent of storefront catalog edits.
- Repeated taps add quantities. Use Undo, Clear, or the minus controls in Order
  details to correct an unsent sale.
- Subtotal remains the sum of the presets. Choose **Discount** or **Addition**
  and enter a dollar amount to adjust the final sale total.
- **Record walk-in sale** immediately creates a completed, paid walk-in
  accounting entry. It does **not** create an unpaid/pre-order, require a
  customer phone number, or collect a payment. No delivery fees, card-processing
  fees, or automatic tax are added. Select **Cash** or **Zelle** to record the
  payment actually received; this does not collect or verify payment.
- The entry appears under **Walk-in Sales & Cash Adjustments** in admin, with
  quantities, prices, and any discount/addition in its description. It increases
  **Walk-in Sales**, **Total Sales**, net revenue, and the applicable
  weekly/monthly/season profit figures. It does not duplicate the entry in the
  online orders list. New register sales retain their Cash/Zelle method.
- The register fetches **all-time Total Sales** from the same SQLite accounting
  data as admin. Before sending, it shows a projection. After confirmation, it
  shows the actual before/after totals returned by the server, plus current
  sales. Refresh retrieves the latest total; returning to the app also refreshes
  it. Other devices' sales may change the actual total from the projection.
- A positive total is required. Each preset supports up to 999 units; sale
  totals and adjustment amounts are limited to $999,999.99.

### Connection loss and recovery

The app shell is available offline after an initial online visit, but **recording
sales and loading financials require internet access and an admin session**.
There is no background submission or offline payment processing.

Unsent items, adjustments, and the current submission/receipt are saved in
browser storage on that device. The password is not stored there. A pending
submission locks editing until it is confirmed. If a response is lost, use
**Retry same sale**, including after closing/reopening or signing in again.
The persistent request ID ensures that retrying cannot add that sale twice.
Do not clear browser data or create a replacement sale while a submission is
unconfirmed; check admin first. If another tab changes the register, reconnect
to load its state before continuing.

**Start next sale** clears the confirmed basket and fetches current totals.
Accounting deletion/reset marks saved request receipts as voided and retains
them for duplicate prevention: retrying an old request will not recreate a
deleted sale. The reset still clears the financial totals.

### Register financials

Tap **Financials** at the top of `/register/`. The main purchase screen keeps
its existing all-time current and before/after sale totals.

- **Payments on fully paid orders** reads the same backend ledger, not a second
  copy of sales. Zelle orders and register payments are grouped under Zelle.
  All other paid sales (including cash, old walk-ins, and card) are grouped
  under Cash as an owner-requested reporting convention. Original online
  payment methods remain unchanged. Cash adjustments are not sales.
- **Edit costs** has exactly four inputs: cumulative purchased pounds and
  dollar cost per pound for each of Mix and Jumbo. Zero means a confirmed
  zero cost or no purchased stock. No sample costs are seeded.
- Date cost is fully paid pounds sold multiplied by the entered per-pound
  rate. Editing the rate recalculates historical estimates. Purchase totals,
  separate freight, 5/10 lb box costs, and honey/unit costs are no longer
  part of this form or automatically deducted.
- Existing purchase-plus-freight settings are read as
  `(purchaseCents + freightCents) / pounds` without rounding the stored rate.
  Original settings remain unchanged until saved in the new format. Old
  recovery submissions remain compatible. Prior box/unit costs are excluded.
- Each date tile compares actual paid date sales (after discounts, recorded
  card fees, and delivery charges) against date cost, showing gross profit
  and gross profit per pound. Honey and other sales do not inflate this
  comparison. Unsold pounds are not deducted from profit.
- Combined date gross profit sums Mix and Jumbo gross profit. **After recorded
  operating expenses** subtracts all backend operating expenses from that
  figure, without allocating overhead into the per-pound rate.
- The overall estimate retains all paid sales, subtracting only Mix/Jumbo
  date costs, existing backend expenses, and recorded card fees. It excludes
  honey, boxes, and other product costs unless recorded as expenses, so it
  is not complete business net profit. Non-date sales trigger a warning.
- Existing expenses are included automatically. Don't also expense dates
  already covered by the per-pound rate. Include freight in your rate yourself
  if desired, or record it once as an expense. Boxes, honey, rent, utilities,
  delivery, tax, and owner pay can be entered as expenses when applicable.
  Correct duplicated costs in admin; no recurring charges are invented.
- Missing costs or historical product details explicitly mark profit as
  provisional. Old manually entered walk-in sales may lack quantities, so
  their product costs and inventory cannot be reconstructed automatically.
  Existing structured quick-sale receipts are reused when available.
- Inventory subtracts known fully paid products and delivered-but-unpaid
  products. Historical entries without quantities make stock estimates
  incomplete. This view is not a tax report or a bank balance.

### Delivered orders and pending payments

Expand **Pending payments**, then use **+ Order**:

1. For an existing unpaid online order, select it in **Order source**. This
   links its original products and agreed total instead of duplicating it.
2. For a new store/person order, enter the customer, delivered products,
   quantities, agreed total after discounts, and any initial partial payment.
3. Record each received installment as Cash or Zelle. Amounts cannot exceed
   the remaining balance. Stock leaves inventory as soon as delivery is
   recorded.
4. Partial receipts are shown separately and excluded from paid sales/profit
   until the order is fully paid. At $0 balance, an online source order becomes
   completed, or a new delivered order creates one walk-in accounting entry.
   The complete payment history is preserved, including mixed methods.
5. **Recently paid** shows the latest 30 closed delivered orders.

Tracked online orders cannot be deleted or moved between paid/unpaid states
from admin; use their register payment workflow. Deleting a closed manual
transaction voids its delivered record and recovery requests. Accounting reset
clears delivered orders, payments, and cost setup too, while retaining voided
request IDs so old operations cannot recreate deleted entries.

Expenses, delivered orders, cost edits, and payment submissions use persistent
recovery request IDs. If a response is lost, **Retry same saved operation**
uses the original request; never submit a replacement or clear browser storage
until confirmed. Recovery also works after reopening/signing in. Financial
data requires internet; financial API responses are never cached by the PWA.
Concurrent cost edits require a refresh rather than overwriting another device.

On the first financial-schema upgrade, a pre-upgrade SQLite snapshot is saved
to `data/backups/pre-register-financials.db` (or the configured data directory).
The deployed disk holds this snapshot; it is not committed to Git.

### Financial API

All `/api/admin/register-financials` endpoints require owner authentication,
return uncached JSON. Payments and expenses use integer cents; per-pound
rates can use fractional cents to preserve migrated average costs:

- `GET /api/admin/register-financials`: combined ledger totals, costs,
  completeness warnings, expenses, pending/closed orders, and available
  unpaid online orders.
- `POST /api/admin/register-financials/costs`: `{requestId, revision, settings}`.
  Settings use `{version: 2, mix: {pounds, costPerPoundCents},
  jumbo: {pounds, costPerPoundCents}}`. The previous purchase/freight request
  format is accepted for saved recovery operations but converted to rates.
- `POST /api/admin/register-financials/expenses`:
  `{requestId, name, amountCents}`.
- `POST /api/admin/register-financials/delivered`:
  `{requestId, name, items: [{id, quantity}], totalCents, initialCents, paymentMethod}`
  or `{requestId, sourceOrderId, initialCents, paymentMethod}`.
- `POST /api/admin/register-financials/delivered/:id/payments`:
  `{requestId, amountCents, paymentMethod}`.

Financial mutations replay identical saved requests, reject conflicting IDs,
and commit their accounting changes and recovery responses atomically.

The service worker is scoped to `/register/` and caches only public register
assets, never admin API responses, passwords, or financial data. Browser
recovery storage does include the current sale/receipt, so use a trusted device
with a screen lock. Financial recovery storage may also contain the current
customer, costs, expense, or payment operation. Sign out when finished.

### Register API

Both endpoints require the existing signed admin session cookie:

- `GET /api/admin/quick-sales`
  - Returns presets, quantity/amount limits, and integer-cent
    `totals.totalSalesCents` / `totals.walkInSalesCents`.
- `POST /api/admin/quick-sales`
  - Body:
    ```json
    {
      "requestId": "b3ce4af1-583b-4bf8-a193-ae336caed31a",
      "items": [
        { "id": "mix-25", "quantity": 2 },
        { "id": "honey-15", "quantity": 1 }
      ],
      "adjustmentCents": -500
    }
    ```
  - Server calculates prices and totals; clients cannot override preset prices.
  - `201` for a new sale; `200` with `replayed: true` for the same request and
    payload; `409` if the request ID is reused with different sale data.
  - Returns `receipt` (including items, subtotal, adjustment, final total,
    transaction ID, before/after totals and voided state) and current `totals`.
  - Financial entry and request receipt are written in one SQLite transaction.

### Validation

Run `npm test` for isolated API/accounting/PWA asset tests. The tests create
their own temporary database and do not write to your business database.

For isolated development, set `TIGRIS_DATA_DIR` to a separate absolute directory
before starting the server; the default remains `data/`. The directory contains
the SQLite database and uploads. Back up the entire production SQLite database
before deploying schema changes, including the new request-receipt table.

## Security Notes

- Basic rate limiting and helmet headers included

## Production Tips

- Put app behind HTTPS (required for secure checkout UX)
- Set `CORS_ORIGIN` to your production domain
- Use a process manager (PM2 or similar)
- Back up `data/tigris-dates.db` regularly
