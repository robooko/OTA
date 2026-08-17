# Stripe Connect account linking — Design

Companion to `docs/superpowers/specs/2026-08-17-stripe-connect-page-design.md`
in `ota-table-bookings`, which adds the Settings page's "Payments"
section described here.

## Context

Properties currently have no way to receive payments directly — there is
no Stripe integration anywhere in this codebase. The motivating need is
mobile Tap to Pay payments for the mobile ordering app (waitress+kitchen
tool), per the existing spec-only
`docs/superpowers/specs/2026-08-16-restaurant-order-payment-tracking-design.md`.
That spec was deliberately left unimplemented and assumes *some* Stripe
account exists to charge through — this spec builds that prerequisite:
each property links its own Stripe account, so any future charging flow
(Tap to Pay, room-booking deposits, etc.) has an account to route through.

Confirmed with the user:
- **Scope: linking only.** No charging, no Payment Intents, no Stripe
  Terminal integration in this pass — that's the payment-tracking spec's
  job, once the mobile app that would call it actually exists. This spec
  only gets a property from "no Stripe account" to "connected, chargeable
  Stripe account," full stop.
- **Platform Stripe account**: the existing account already authenticated
  in the local `stripe` CLI (`acct_1FCklnIw09PSdKki`, display name
  "EitherOr") is the correct one to build Connect accounts under —
  confirmed with the user rather than assumed, despite the display name
  not matching this platform's own branding.
- **Account type: Express.** Stripe's own current guidance (`stripe
  accounts.create` with `stripe_dashboard: { type: 'express' }`) is the
  recommended type for platforms where the connected business should
  fully own and manage their own Stripe account — Stripe hosts 100% of
  the KYC/business-details onboarding UI, this platform never touches
  identity/compliance data directly.
- **Country: fixed to `GB`** for every property. Every property/domain
  seen in this codebase so far is UK-based; not worth a schema field for
  a hardcoded constant until a non-UK property actually shows up.
- **Onboarding: Account Links** (`stripe.accountLinks.create`), not the
  older OAuth-based Connect flow — Stripe-hosted, redirect-based, no
  custom onboarding UI to build.
- **Disconnect is a soft unlink**, not account deletion. Clearing
  `property.stripe_account_id` removes the property's ability to charge
  through it; the actual Stripe Express account (with its real
  KYC/financial history) is untouched. Re-connecting later creates a
  fresh Express account rather than restoring the old link.

## Goals

- `property` gains `stripe_account_id` (nullable), `stripe_charges_enabled`,
  `stripe_payouts_enabled` (both boolean, default `false`).
- `POST /api/property/stripe/connect` (admin-only) — creates an Express
  account if none exists yet, creates an Account Link, returns the
  onboarding URL.
- `POST /api/property/stripe/webhook` (unauthenticated, Stripe-signature-
  verified) — `account.updated` events update `stripe_charges_enabled`/
  `stripe_payouts_enabled` from Stripe's own view of the account. This is
  the source of truth for onboarding completion, not the browser redirect
  back from Stripe's hosted flow.
- `POST /api/property/stripe/disconnect` (admin-only) — clears the local
  `stripe_account_id`/status fields. Does not touch the Stripe account.
- `GET /api/property/me` gains the three Stripe fields, alongside the
  existing `id`/`name`/`currency`/`timezone`.
- Settings page (`ota-table-bookings`) gains a "Payments" section:
  connect / continue-onboarding / connected states, driven by the fields
  above.

## Non-goals

- No Payment Intents, no charging, no Stripe Terminal/Tap to Pay — that's
  the separate, still-spec-only payment-tracking design, blocked on the
  mobile app existing to call it.
- No per-property country selection — fixed `GB`, per Context.
- No deleting the underlying Stripe Express account on disconnect — soft
  unlink only, per Context.
- No support for a property re-linking to a *different* existing Stripe
  account (e.g. one they already manage outside this platform) — every
  connect action creates a fresh Express account under the platform's
  Stripe account. Bringing an existing account would need Standard-type
  OAuth instead, a different flow not in scope here.

## Data model

```sql
ALTER TABLE property ADD COLUMN stripe_account_id VARCHAR(255);
ALTER TABLE property ADD COLUMN stripe_charges_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT false;
```

No existing data — all three columns start `NULL`/`false` for every
property, correctly representing "not connected yet."

## `src/lib/stripe.js` (new)

Mirrors `ably.js`/`resend.js`'s guarded-singleton shape:

```js
const Stripe = require('stripe');

let client = null;
if (process.env.STRIPE_SECRET_KEY) {
  client = new Stripe(process.env.STRIPE_SECRET_KEY);
}

async function createExpressAccount() {
  if (!client) throw new Error('Stripe not configured');
  const account = await client.accounts.create({
    controller: {
      stripe_dashboard: { type: 'express' },
      fees: { payer: 'application' },
      requirement_collection: 'application',
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    country: 'GB',
  });
  return account.id;
}

async function createOnboardingLink(accountId, returnUrl, refreshUrl) {
  if (!client) throw new Error('Stripe not configured');
  const link = await client.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
  return link.url;
}

function verifyWebhook(payload, signature) {
  if (!client) throw new Error('Stripe not configured');
  return client.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { createExpressAccount, createOnboardingLink, verifyWebhook };
```

## API & behavior

```
POST /api/property/stripe/connect      authenticate, requireRole('admin')
POST /api/property/stripe/disconnect   authenticate, requireRole('admin')
POST /api/property/stripe/webhook      unauthenticated, Stripe-signature-verified
```

`src/controllers/property.js` gains:

```js
const { createExpressAccount, createOnboardingLink, verifyWebhook } = require('../lib/stripe');

async function connectStripe(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT stripe_account_id FROM property WHERE id = $1', [req.property_id]);
    let accountId = rows[0]?.stripe_account_id;

    if (!accountId) {
      accountId = await createExpressAccount();
      await pool.query('UPDATE property SET stripe_account_id = $1 WHERE id = $2', [accountId, req.property_id]);
    }

    const returnUrl = `${process.env.PUBLIC_FRONTEND_BASE_URL}/settings?stripe=return`;
    const refreshUrl = `${process.env.PUBLIC_FRONTEND_BASE_URL}/settings?stripe=refresh`;
    const url = await createOnboardingLink(accountId, returnUrl, refreshUrl);

    res.json({ url });
  } catch (err) { next(err); }
}

async function disconnectStripe(req, res, next) {
  try {
    const { rows } = await pool.query(
      `UPDATE property SET stripe_account_id = NULL, stripe_charges_enabled = false, stripe_payouts_enabled = false
       WHERE id = $1 RETURNING id, name, currency, timezone, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled`,
      [req.property_id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function handleStripeWebhook(req, res, next) {
  try {
    let event;
    try {
      event = verifyWebhook(req.body, req.headers['stripe-signature']);
    } catch {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (event.type !== 'account.updated') return res.status(200).end();

    const account = event.data.object;
    await pool.query(
      'UPDATE property SET stripe_charges_enabled = $1, stripe_payouts_enabled = $2 WHERE stripe_account_id = $3',
      [account.charges_enabled, account.payouts_enabled, account.id]
    );

    res.status(200).end();
  } catch (err) { next(err); }
}
```

(`getCurrentProperty`'s existing `SELECT` gains the three new columns;
`module.exports` gains `connectStripe`, `disconnectStripe`,
`handleStripeWebhook`.)

`src/routes/property.js` gains:

```js
router.post('/stripe/connect', authenticate, requireRole('admin'), ctrl.connectStripe);
router.post('/stripe/disconnect', authenticate, requireRole('admin'), ctrl.disconnectStripe);
```

(The webhook route is **not** added here — same raw-body-before-
`express.json()` requirement as the Resend webhook, registered directly
in `app.js`, before the global `express.json()`:)

```js
const { handleStripeWebhook } = require('./controllers/property');

app.post(
  '/api/property/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);
```

## Environment

New env vars in `OTA/.env` and OTA's Render env:
- `STRIPE_SECRET_KEY` — the platform account's secret key (test-mode key
  already available via the local `stripe` CLI config for local dev;
  live-mode key for production, added once this is ready to go live).
- `STRIPE_WEBHOOK_SECRET` — from creating a webhook endpoint (`stripe
  webhooks create` or the dashboard), subscribed to `account.updated`,
  pointed at `https://ota-u6ii.onrender.com/api/property/stripe/webhook`
  for production (and a `stripe listen --forward-to` tunnel for local
  testing, since Stripe can't reach `localhost` directly).
- `PUBLIC_FRONTEND_BASE_URL` — needed to build the Account Link's
  `return_url`/`refresh_url`. Not currently an existing env var in OTA
  (the frontend calls OTA, not the reverse) — new addition, e.g.
  `http://localhost:4335` locally, the real frontend URL in production.

## Testing approach

No automated test framework in OTA — manual `curl`/CLI checks, matching
every other module. `stripe` CLI is already installed and authenticated
locally.

1. `POST /api/property/stripe/connect` with no auth → `401`. With a
   non-admin Clerk token → `403`. With an admin token → `200`, `url`
   present and is a real `https://connect.stripe.com/...` link (or
   `https://billing.stripe.com/...`/similar hosted-onboarding domain).
   Confirm `property.stripe_account_id` is now set (`SELECT
   stripe_account_id FROM property WHERE id = ...`).
2. Call `connect` again for the same property → `200`, same
   `stripe_account_id` reused (not a second Express account created) —
   confirm via Stripe dashboard/CLI (`stripe accounts retrieve
   <account_id>`) that only one account exists for this test.
3. `stripe trigger account.updated` (or complete a small piece of the
   real test-mode onboarding form) with `stripe listen --forward-to
   http://localhost:3000/api/property/stripe/webhook` running locally →
   confirm `stripe_charges_enabled`/`stripe_payouts_enabled` update in
   the DB to match the event payload.
4. Send the webhook with a deliberately wrong signature → `400`, confirms
   verification is enforced.
5. `POST /api/property/stripe/disconnect` with no auth → `401`; non-admin
   → `403`; admin → `200`, `stripe_account_id` now `null`,
   `stripe_charges_enabled`/`stripe_payouts_enabled` both `false`.
   Confirm via Stripe CLI that the actual Express account still exists
   (`stripe accounts retrieve <account_id>` still succeeds) — proves
   disconnect is soft, not destructive.
6. `GET /api/property/me` at each stage above reflects current state.
