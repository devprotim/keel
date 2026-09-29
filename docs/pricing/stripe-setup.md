# Turning on billing

Billing is off until Stripe is configured. These are the steps, in the Stripe dashboard and then in Render. Do them in test mode first; nothing here needs a code change.

## 1. Products and prices

1. **Product catalogue**, then **Add product**: "Keel Team". Add a recurring price, monthly, **per unit** if `BILLING_PER_SEAT` stays `true` (the default: one unit per owner or editor), or a flat price if you set it to `false`. Copy the Price id (`price_...`).
2. Optionally the same for "Keel Business". A plan with no Price id simply isn't offered.

## 2. Customer portal

**Settings, Billing, Customer portal**: turn on cancelling, updating the payment method, and switching between the Team and Business prices. Keel sends owners there from **Manage billing**; plan changes made in the portal come back through the webhook.

## 3. Webhook

**Developers, Webhooks, Add endpoint**: `https://<your keel>/api/billing/webhook`, with these events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Copy the signing secret (`whsec_...`). Keel verifies every delivery with it, and rejects anything unsigned or older than five minutes.

## 4. Configuration

Set these on the Render service (all `sync: false` in `render.yaml`, so Render asks for them):

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | The secret key (`sk_test_...`, then `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | The endpoint's signing secret |
| `STRIPE_PRICE_TEAM` | The Team Price id |
| `STRIPE_PRICE_BUSINESS` | The Business Price id, if any |
| `BILLING_PER_SEAT` | `true` (default) or `false` |

The server refuses to boot on half a configuration (a key without a webhook secret or price, or a price without a key), so a typo shows at deploy, not at a customer's checkout. Billing also needs `DATABASE_URL`: with the memory store, plans would reset on every restart.

## 5. Check it

1. Sign in, make a diagram private in a new workspace, and open the landing page: the workspace shows **Free plan** and **Upgrade to Team**.
2. Upgrade with Stripe's test card `4242 4242 4242 4242`. Back on Keel, the card shows **Team plan** within a few seconds (after the webhook arrives).
3. **Manage billing** opens the portal. Cancel there, and the workspace returns to Free when Stripe sends `customer.subscription.deleted`.

The Stripe CLI can forward webhooks to a local server: `stripe listen --forward-to localhost:8787/api/billing/webhook`, then use the secret it prints as `STRIPE_WEBHOOK_SECRET`.

## What is not built

- **Metered billing** by monitored service (models B and C in [scenarios.md](scenarios.md)).
- **Tax and invoices** beyond what Stripe Checkout and the portal do by default. Turn on Stripe Tax in the dashboard if needed; no code change.
- **Downgrade handling beyond limits**: a workspace over its limits after a downgrade keeps what it has but cannot add more until it is back under.
