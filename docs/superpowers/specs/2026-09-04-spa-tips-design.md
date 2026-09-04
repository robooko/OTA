# Spa Tips — design

Date: 2026-09-04
Status: design only, not built. Follows on from
`2026-08-30-spa-tap-to-pay-backend-requirements.md` (which deliberately
excluded tips).

## Why

Barbering is a heavily tipped trade, and a card-paying customer can't tip
if there's no prompt. Adding a tip step to the spa Tap to Pay flow captures
tips that otherwise vanish when the customer has no cash. Not legally
required; genuinely valuable for this audience.

## Principle: record the tip, don't let it live only in Stripe

Confirmed empirically (test-mode sample, 2026-09-04): creating a
PaymentIntent with the tip simply folded into `amount` leaves Stripe's
`amount_details.tip` **empty** — Stripe sees one undifferentiated total, and
the only trace is whatever we put in `metadata`. So the tip must be recorded
in our own data, both for per-barber reporting and for the record-keeping the
Employment (Allocation of Tips) Act 2023 expects of employers. Our DB is the
source of truth; Stripe is the money ledger.

## Approach (recommended): server-validated tip parameter

Keeps the server as the amount authority, exactly like the existing
price-only flow — the only new input is the customer-chosen tip, which the
server validates and then owns.

### 1. Migration

```sql
ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
```

`schema.sql` updated in place. No backfill (existing appointments correctly
have no tip).

### 2. `payment-intent` endpoint gains an optional tip

`POST /api/spa/:spa_id/appointments/:id/payment-intent`

- Body (optional): `{ tip_amount }` in **minor units** (integer pence), the
  tip the barber/customer chose on the device.
- Validate: integer, `>= 0`, and `<= ` a sanity cap — recommend the greater
  of the treatment price or a fixed ceiling (e.g. cap at 100% of price) to
  catch fat-finger entry. Reject out-of-range with 409.
- `amount = treatmentPriceCents + tip_amount`.
- Store `tip_amount` (converted to pounds) on the appointment at creation,
  alongside `stripe_payment_intent_id`.
- `metadata` gains `tip_amount` and `treatment_amount` (so the split is
  visible in Stripe too, even though `amount_details.tip` stays empty on a
  non-Terminal-tipping charge).
- **Idempotency:** the tip is locked once the intent exists. A retry reuses
  the pending intent as-is (same total). Changing the tip means the old
  intent is canceled (unpaid) and a fresh one minted — document, don't
  over-engineer.

### 3. `confirm-payment` verifies the total including tip

- Require `intent.amount === treatmentPriceCents + storedTipCents` (instead
  of just the treatment price). Any mismatch → 409, row untouched.
- On success: `payment_status='paid'`, `paid_at=now()`, `tip_amount`
  already stored.

### 4. Reads

`listAppointments` / `getAppointment` already `SELECT sa.*`, so `tip_amount`
flows to the app with no query change.

## App side (ota-waitress-app)

- **Tip step**: after "Take payment", before the tap, show quick options —
  `No tip · 10% · 15% · 20% · Custom` — computed off the treatment price.
  A pure helper `tipOptions(priceCents)` → `[{label, amountCents}]`, unit
  tested.
- `createSpaPaymentIntent(spaId, appointmentId, tipCents)` passes the chosen
  tip. `useTapToPay.pay(createIntent)` is already a callback, so no reader
  pipeline change.
- Optional: show `£22 + £3 tip` on paid cards, and add tips into the day
  summary (`£139 + £18 tips`).

## Alternative considered: Stripe Terminal native tipping

Stripe Terminal can capture the tip during collection and populate
`amount_details.tip` natively (clean split on Stripe's dashboard/receipt).
Rejected as the primary approach because it depends on the RN SDK's tipping
API and takes the amount out of the server's hands, which breaks the
existing server-authoritative pattern. If a future need arises for Stripe's
native split, layer it on — our `tip_amount` record stays the source of
truth either way. (Confirm the exact `@stripe/stripe-terminal-react-native`
tipping call against Stripe's docs if this path is ever taken.)

## Testing

- Backend (curl, test mode): tip within bounds → total = price + tip, tip
  persisted; tip over cap → 409; confirm verifies the full total; retry
  reuses the same intent.
- App: `tipOptions` maths (unit); manual simulated-reader run adding a tip →
  paid row shows the tip, DB has `tip_amount`.

## Out of scope

Splitting tips across barbers, tronc arrangements, editing/refunding a tip
after payment, and tip distribution/payroll (the shop's responsibility under
the Act, not the app's to enforce).
