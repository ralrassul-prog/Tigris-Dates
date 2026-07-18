# Tigris Dates Ordering App

A customer-friendly ordering web app for Medjool dates with:

- Direct guest checkout (no account required)
- Product selection for your four box options
- Credit card checkout (Stripe)
- Zelle pay-later option
- One-click WhatsApp order message link
- Owner backend endpoints for order tracking

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

When customer chooses **Zelle (pay later)**:

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

## Security Notes

- Basic rate limiting and helmet headers included

## Production Tips

- Put app behind HTTPS (required for secure checkout UX)
- Set `CORS_ORIGIN` to your production domain
- Use a process manager (PM2 or similar)
- Back up `data/tigris-dates.db` regularly
