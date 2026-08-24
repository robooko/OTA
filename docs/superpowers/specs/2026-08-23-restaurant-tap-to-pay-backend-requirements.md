# Restaurant Tap to Pay — OTA backend requirements

Date: 2026-08-23

## Context

The waitress app's status board has a permanently-disabled "Take payment (coming soon)" button — deferred pending exactly this work (see `2026-08-16-mobile-ordering-app-backend-requirements.md`, section 2, which left the payment-tracking shape undecided between two order-level options). Since then, `restaurant_table_session` (`2026-08-23-restaurant-table-sessions-backend-requirements.md`) now exists and groups a table's rounds into one tab — that's the natural unit to bill, not an individual order. This spec settles the payment shape on that basis and adds Stripe Terminal Tap to Pay support.

This spec is decided, not a stub. Confirmed via Stripe's docs: Tap to Pay on Android requires Android 13+, an unrooted/unmodified GMS-certified device, and is available in GB (this property's region) among others. The mobile app cannot use Expo Go for this — it needs the native Terminal SDK, handled entirely on the waitress-app side (out of scope here).

**v1 scope**: single full-tab charge per session, no tips, no split payments. Those are separate follow-ups if ever needed.

## 1. `restaurant_table_session` gets payment fields

```sql
ALTER TABLE restaurant_table_session
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

ALTER TABLE restaurant_table_session
  ADD CONSTRAINT restaurant_table_session_payment_status CHECK (payment_status IN ('unpaid', 'paid'));
```

No backfill needed — every existing row defaults to `'unpaid'`, which is correct (none of them went through a Stripe charge).

## 2. `property` gets a Terminal location

Stripe Terminal requires a `Location` object even for Tap to Pay (no physical reader to register, but `discoverReaders` still needs a `locationId`). Lazily created on first use, not required up front.

```sql
ALTER TABLE property
  ADD COLUMN IF NOT EXISTS stripe_terminal_location_id VARCHAR(255);
```

## 3. New endpoint: connection token (+ lazy location creation)

```
POST /api/restaurant-table-sessions/connection-token
```

- `authenticateOrApiKey`. No body.
- 409 if `property.stripe_secret_key` isn't set (matches the existing pattern in `getReservationPaymentIntent`).
- If `property.stripe_terminal_location_id` is null: create one via `stripe.terminal.locations.create({ display_name: property.name, address: {...} })` and store it. (Address: use whatever the `property` table already has — check its columns before writing this; if there's no address data at all, a minimal placeholder US/GB address is acceptable since Tap to Pay doesn't ship anything physical to this location, but confirm against the property row rather than guessing here.)
- Mint via `stripe.terminal.connectionTokens.create()`.
- Response: `{ secret, location_id }` — the RN SDK's `fetchConnectionToken` callback needs `secret`; `discoverReaders({ discoveryMethod: 'tapToPay', locationId })` needs `location_id`.

## 4. New endpoint: create a PaymentIntent for a session

```
POST /api/restaurant-table-sessions/:id/payment-intent
```

- `authenticateOrApiKey`. No body — the amount is computed server-side, never trusted from the client.
- 404 if session not found / wrong property.
- 409 if session `status != 'open'` (can't charge a closed tab) or `payment_status = 'paid'` (already paid).
- **Idempotency**: if `stripe_payment_intent_id` is already set on the session, retrieve that intent from Stripe first. If its status is still `requires_payment_method` / `requires_confirmation` / `requires_capture` (i.e. not yet terminal), return the *same* intent's `{client_secret, payment_intent_id}` instead of creating a second one — a waitress retrying a failed tap shouldn't double-charge. If the existing intent is `canceled` or `succeeded`-but-session-still-unpaid (a logged-then-lost edge case), fall through and create a fresh one.
- Amount: `SUM(o.total_price) FROM restaurant_order o WHERE o.table_session_id = $1`, converted to minor units (pence) for Stripe — reuse the same `NUMERIC(10,2)` → integer-cents conversion pattern already used wherever this codebase creates Stripe amounts (check `getReservationPaymentIntent`'s sibling creation code for the exact rounding approach and mirror it, don't reinvent).
- Create via `stripe.paymentIntents.create({ amount, currency: property.currency.toLowerCase(), payment_method_types: ['card_present'], capture_method: 'automatic', metadata: { table_session_id: session.id, restaurant_id } })`.
- Store the intent id on the session (`stripe_payment_intent_id`) immediately after creation — this is what makes the idempotency check above possible on a retry.
- Response: `{ client_secret, payment_intent_id }`.

## 5. `closeSession` gains optional payment confirmation

Extend the existing `PUT /api/restaurant-table-sessions/:id/close` (in `restaurantTableSessions.js`) rather than adding a new endpoint — paying and closing are the same real-world moment.

- Body (optional): `{ stripe_payment_intent_id }`.
- Active-order guard (existing) unchanged — still 409 while any order is `pending`/`confirmed`/`preparing`.
- If `stripe_payment_intent_id` provided:
  - Must match `session.stripe_payment_intent_id` (reject `409` "Payment intent does not match this session" otherwise — prevents attaching an unrelated intent).
  - Retrieve the intent from Stripe. Require `status === 'succeeded'`. Require `intent.amount` equals the CURRENT session total recomputed the same way endpoint 4 computed it (guards against orders changing between intent creation and close — extremely unlikely given the active-order guard, but cheap to check and matches this codebase's existing amount-integrity habits elsewhere in Stripe code).
  - On all checks passing: set `payment_status = 'paid'`, `paid_at = now()` in the same `UPDATE` that already sets `status = 'closed', closed_at = now()`.
  - On any check failing: `409`, don't close.
- If omitted: close exactly as today (`payment_status` stays whatever it already was — e.g. a comp'd table or cash paid outside Stripe). Don't force every close through this flow.

## Verification

Stripe test mode only (`sk_test_...` — the "Robs" property already has one). `curl`-based, this repo's convention:
- Connection-token: confirm it lazily creates exactly one `Location` on first call and reuses it on a second call (check `stripe_terminal_location_id` doesn't change).
- PaymentIntent creation: confirm the amount matches session orders' summed total in minor units; confirm a second call while the first intent is still `requires_payment_method` returns the same `payment_intent_id`, not a new one.
- Close with a real test-mode intent (use Stripe's test PaymentMethod `pm_card_visa` via `paymentIntents.confirm` in test mode to actually reach `succeeded` — Tap to Pay itself can't be simulated server-side, but a normal test confirm exercises the same close-time verification logic).
- Close with a mismatched `stripe_payment_intent_id` (e.g. a random UUID) — confirm 409, confirm the session stays open.
- Close with `stripe_payment_intent_id` pointing at a `requires_payment_method` (never confirmed) intent — confirm 409, confirm `payment_status` stays `unpaid`.

## What this spec deliberately doesn't cover

Tips, split payments, refunds, and the frontend Terminal SDK integration / Expo dev-client migration (waitress-app's own concern — see its own docs, not this repo's).
