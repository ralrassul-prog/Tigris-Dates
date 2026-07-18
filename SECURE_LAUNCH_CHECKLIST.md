# Secure Launch Checklist (Payments + Bank + Production)

This checklist is focused on launching Tigris Dates safely with card payments.

## 1) Stripe account and bank payouts

1. Create/complete your Stripe account at https://dashboard.stripe.com.
2. Complete business verification (KYC) in Stripe.
3. Go to `Settings -> Bank accounts and scheduling` and connect your bank account.
4. Set payout schedule (daily/weekly) based on your preference.

Important:
- Card details must never touch your server directly.
- Your app already uses Stripe Checkout, which is the correct secure model.

## 2) Required production secrets

Set these in your hosting provider's environment variables (do not commit to git):

- `NODE_ENV=production`
- `BASE_URL=https://your-domain.com`
- `CORS_ORIGIN=https://your-domain.com`
- `ADMIN_PASSWORD=<very-long-random-password>`
- `ADMIN_SESSION_SECRET=<very-long-random-secret>`
- `STRIPE_SECRET_KEY=<live_stripe_secret_key>`
- `STRIPE_WEBHOOK_SECRET=<webhook_signing_secret>`
- `STRIPE_CURRENCY=usd`
- `WHATSAPP_BUSINESS_NUMBER=<digits_only>`
- `ZELLE_PAYEE=<your zelle email/phone>`

## 3) Stripe webhook setup

1. In Stripe Dashboard, create webhook endpoint:
   - `https://your-domain.com/api/stripe/webhook`
2. Subscribe to event:
   - `checkout.session.completed`
3. Copy webhook signing secret and set `STRIPE_WEBHOOK_SECRET`.
4. Send a Stripe test event and verify your order status moves to `paid`.

## 4) Deployment security controls

1. Deploy behind HTTPS only (valid TLS certificate).
2. Keep server and dependencies updated.
3. Restrict admin password to trusted owners only.
4. Rotate `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` periodically.
5. Use platform secret manager (not plain files) in production.
6. Back up your SQLite database regularly, or move to managed Postgres for scale.

## 5) PCI and compliance basics

- Because checkout is on Stripe-hosted pages, PCI scope is much smaller.
- Never log card numbers, CVV, or raw payment details.
- Keep privacy policy and terms page available on your production site.

## 6) Pre-launch test run

1. Place test card order and confirm status updates to `paid` via webhook.
2. Place Zelle order and verify status is `awaiting_zelle`.
3. Place Cash order and verify status is `awaiting_cash`.
4. Confirm admin tabs:
   - Active tab excludes completed orders
   - Completed tab only shows completed orders
5. Confirm account metrics:
   - Paid
   - Not Paid
   - Paid by Zelle
   - Paid by Card

## 7) Suggested hosting options

- Easiest: Render, Railway, or Fly.io
- Keep app private during setup, then switch public when validated.

If you want, next step can be a provider-specific launch script (Render or Railway) with exact deployment settings.
