# Spa Tap to Pay — OTA backend requirements

Date: 2026-08-30

## Context

The waitress app (ota-waitress-app, "Hotal") is growing a spa/barber mode:
a therapist schedule screen with walk-in booking, cancellation, and Tap to
Pay against an appointment. First real user: Bedford Barber Co (see
`2026-08-30-spa-barbershop-bookings-design.md`), whose barber will charge
the treatment price by tapping the customer's card on the same phone that
shows his schedule.

Restaurant Tap to Pay already exists end-to-end
(`2026-08-23-restaurant-tap-to-pay-backend-requirements.md`): payment
fields on `restaurant_table_session`, a property-level Terminal location +
connection token, an idempotent PaymentIntent endpoint, and close-time
verification. This spec is the spa equivalent, deliberately smaller:

- The billable unit is a single `spa_appointment`, and its amount is the
  treatment's `price` — there is no tab to sum and no "close" moment to
  fold confirmation into, so confirmation is its own endpoint.
- Terminal only. The restaurant endpoint grew an `'online'` channel for
  the guest-pays-on-their-phone flow; nothing books spa payments online
  today, so no channel parameter here. (`payment_method_types:
  ['card_present']` always.)

The walk-in and cancel halves of the app's needs are already served:
`POST /:spa_id/appointments {treatment_id, date, time, contact_name}` and
`PUT /:spa_id/appointments/:id {status: 'cancelled'}` exist and require no
change. The only read-side gap is a subscribe token for the app's live
schedule (section 4).

**v1 scope**: full treatment price, no tips, no partial/split payments, no
refunds.

## 1. `spa_appointment` gets payment fields

```sql
ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

ALTER TABLE spa_appointment
  ADD CONSTRAINT spa_appointment_payment_status CHECK (payment_status IN ('unpaid', 'paid'));
```

Same shape and semantics as `restaurant_table_session`. No backfill —
every existing appointment defaults to `'unpaid'`, which is true (none
went through Stripe). Migration file:
`migrate-2026-08-30-spa-appointment-payment.sql`; `schema.sql` updated in
place.

`listAppointments` / `getAppointment` select `sa.*`, so the new columns
flow into their responses with no query change — the app's schedule reads
`payment_status` straight off the row.

## 2. New endpoint: create a PaymentIntent for an appointment

```
POST /api/spa/:spa_id/appointments/:id/payment-intent
```

- `authenticateOrApiKey`, property-scoped like every spa route. No body —
  the amount is computed server-side, never trusted from the client.
- 404 if the appointment isn't found via the usual
  `spa_appointment JOIN spa_therapist ON st.spa_id = :spa_id AND
  sa.property_id = req.property_id` scoping.
- 409 if `property.stripe_secret_key` isn't set, if
  `status = 'cancelled'` (can't charge a cancelled booking), or if
  `payment_status = 'paid'`.
- Amount: the joined `spa_treatment.price` (`NUMERIC(10,2)`) converted to
  minor units with the same `Math.round(Number(price) * 100)` conversion
  `sessionTotalCents` uses — read that helper and mirror it, don't
  reinvent. 409 if the result is `<= 0`.
- **Idempotency** (same rules as `createSessionPaymentIntent`, minus the
  channel logic): if `stripe_payment_intent_id` is already set, retrieve
  it first.
  - Still pending (`requires_payment_method` / `requires_confirmation` /
    `requires_capture` / `requires_action`): return the same intent's
    `{client_secret, payment_intent_id, amount}`.
  - `succeeded` (crash-window recovery — the tap landed but the app died
    before confirm-payment): verify `intent.amount` equals the recomputed
    price; on match, mark the appointment paid (`payment_status='paid',
    paid_at=now()`) and return `{already_paid: true, payment_intent_id}`;
    on mismatch, 409 `'A payment already succeeded for a different
    amount'` without touching the row.
  - `canceled`: fall through and mint a fresh intent.
- Create via `stripe.paymentIntents.create({ amount, currency:
  property.currency.toLowerCase(), payment_method_types: ['card_present'],
  capture_method: 'automatic', metadata: { spa_appointment_id, spa_id } })`.
- Store the intent id on the appointment immediately after creation.
- Response: `{ client_secret, payment_intent_id, amount }`.
- Stripe errors map to 502 `Stripe error: …`, same as the session
  endpoint.

## 3. New endpoint: confirm payment

```
POST /api/spa/:spa_id/appointments/:id/confirm-payment
```

Body: `{ stripe_payment_intent_id }`.

- Same auth + scoping + 404 rules as above. 409 if already `paid`.
- Must equal the appointment's stored `stripe_payment_intent_id` (409
  `'Payment intent does not match this appointment'` otherwise).
- Retrieve from Stripe: require `status === 'succeeded'` and
  `intent.amount` equal to the recomputed treatment price in minor units.
  Any failure: 409, row untouched.
- On success: `UPDATE … SET payment_status = 'paid', paid_at = now()`.
- Response: the updated appointment row (the app flips its Paid badge
  from this).
- No Ably publish and no email on payment — the payer is standing next to
  the phone; the schedule refetches on focus. (Reconsider if a dashboard
  ever needs live payment state.)

## 4. New endpoint: Ably subscribe token for a spa

```
GET /api/spa/:spa_id/ably-token
```

Mirrors `restaurantOrders.getAblyToken`: `authenticateOrApiKey`, 404 if
the spa isn't the property's, then a subscribe-only token request for the
existing `spa:{spa_id}:appointments` channel (the one
`publishNewAppointment` / `publishAppointmentStatusChanged` already
publish to). Response `{ tokenRequest, channel }`.

## 5. Connection token: no new endpoint

The app reuses `POST /api/restaurant-table-sessions/connection-token`.
Despite its path it is property-scoped, not restaurant-scoped: it reads
`property.stripe_secret_key`, lazily creates the property's Terminal
`Location`, and mints a connection token — all exactly what the spa flow
needs. Moving/aliasing it to a property-level path is deliberately not
done now; one caller, one endpoint.

## Rollout prerequisites (ops, not code)

- Bedford Barber Co's `property.stripe_secret_key` set to a **test-mode**
  key (Stripe stays test everywhere for now — same status as the
  restaurant rollout).
- A Clerk staff user linked to the Bedford Barber Co property so the
  barber can sign into the app (`2026-08-09-clerk-staff-auth-design.md`).

## Verification

Stripe test mode, `curl` against `npm run dev`, this repo's convention:

1. Run the migration locally; confirm existing appointments read
   `payment_status = 'unpaid'`.
2. `POST …/payment-intent` on a confirmed appointment → 200 with `amount`
   = treatment price in pence; the intent id lands on the row.
3. Repeat the call while the intent is untouched → same
   `payment_intent_id` back, no second intent in the Stripe dashboard.
4. Confirm the intent server-side with `pm_card_visa` (test mode stand-in
   for a tap), then `POST …/confirm-payment` with the right id → 200,
   `payment_status = 'paid'`, `paid_at` set.
5. `confirm-payment` with a mismatched id → 409, row unchanged. With a
   never-confirmed intent → 409, still `unpaid`.
6. `payment-intent` again after paid → 409 `already paid`.
7. Crash-window path: mint, confirm via `pm_card_visa`, then call
   `payment-intent` again (not confirm-payment) → `{already_paid: true}`
   and the row is now paid.
8. Cancelled appointment → `payment-intent` 409. Wrong property's key →
   404 everywhere.
9. `GET …/ably-token` → `{tokenRequest, channel: 'spa:<id>:appointments'}`;
   token subscribes but cannot publish.

## What this spec deliberately doesn't cover

Tips, split payments, refunds, an online payment channel, a `completed`
appointment status, receipt emails, and the app-side Terminal SDK flow
(ota-waitress-app's own spec:
`2026-08-30-spa-schedule-tap-to-pay-design.md` in that repo).
