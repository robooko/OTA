# Guest folio (room bill) — Design

## Context

A room booking accumulates charges from several places, but nothing adds
them up and nothing knows whether the guest has paid:

- `booking.total_price` — the room nights themselves.
- `booking_extra` — priced extras attached to the booking.
- `restaurant_order` rows with `booking_id` set — room-service orders
  with a `total_price` that today posts nowhere.
- `payment` — a manual ledger (`POST /api/payments`) that nothing reads
  back; bookings have no balance concept, and the `checked_out` status
  transition is an unguarded flip.

Meanwhile spa appointments and restaurant table sessions each settle
themselves in isolation via Stripe Tap to Pay (per-property
`stripe_secret_key`), with a proven intent/confirm flow in
`src/controllers/spaPayments.js`.

This spec adds the missing piece for room bookings: a **guest folio** —
one bill per booking with line items, payments, and a balance — plus
Tap to Pay settlement and a soft check-out gate.

Naming note: `/api/billing` is already taken by **platform token
billing** (properties buying AI-reply token packs — commit `c975659`,
`src/controllers/billing.js`). That feature is unrelated to guest
bills. Everything here lives under `/api/bookings/:id/folio` and the
word for it is *folio*, never *billing*.

## Decisions (confirmed with the user)

- **Charge scope:** room nights + extras + room-service orders. Spa,
  golf, beach, and equipment charges to a room are out of scope — they
  would each need a new `booking_id` link and a charge-to-room step in
  their flows; a later pass.
- **Storage: computed, not posted.** No `folio_item` ledger. The folio
  is aggregated live from the source tables on every read, so an order
  edited or cancelled after the fact is always reflected — no posting
  hooks, no drift. One small table (`folio_adjustment`) covers manual
  lines. This matches the codebase's drift toward computed state (spa
  computed availability). Trade-off accepted: the bill is not frozen at
  check-out; nothing needs a frozen bill until invoices exist.
- **Payments: manual ledger + Stripe Tap to Pay.** The existing
  `payment` table stays the single ledger; the new Stripe flow writes
  into it rather than growing a parallel `payment_status` flag the way
  spa/table-sessions did.
- **Check-out: soft gate.** Non-zero balance → `409` unless
  `force: true`.
- **Out of scope:** invoices/invoice numbers, PDFs, VAT/tax breakdown,
  refund initiation (refunds remain a manual `payment.status` update),
  charging spa/golf/etc. to rooms, and any UI.

## Data model

Two idempotent migrations, house style (`IF NOT EXISTS`, `DO $$` guard
for constraints), mirrored into `schema.sql`.

### `migrate-2026-09-01-folio-adjustment.sql`

```sql
CREATE TABLE IF NOT EXISTS folio_adjustment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES booking(id),
  description VARCHAR(200)  NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,  -- positive = charge, negative = credit/comp
  created_at  TIMESTAMPTZ   DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_folio_adjustment_booking ON folio_adjustment(booking_id);
```

`amount = 0` is rejected at the API layer, not by constraint.

### `migrate-2026-09-01-payment-stripe-intent.sql`

```sql
ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);
```

No backfill: existing rows are manual payments, NULL is correct.

## Folio computation — `src/lib/folio.js`

`computeFolio(bookingId, propertyId)` → the single source of truth,
used by the read endpoint and the check-out gate. Returns `null` when
the booking doesn't exist in that property (callers 404).

```js
{
  booking_id, currency,            // property.currency
  items: [
    // one line: { type: 'room', description: 'Room 101 · 3 nights', amount }
    // per booking_extra: { type: 'extra', source_id, description, amount }
    // per non-cancelled restaurant_order with this booking_id:
    //   { type: 'room_service', source_id, description: 'Room service · <restaurant>',
    //     amount, created_at }
    // per folio_adjustment: { type: 'adjustment', source_id, description, amount, created_at }
  ],
  charges_total,                   // sum of items
  payments: [ /* payment rows, newest first */ ],
  payments_total,                  // sum of payment rows with status = 'completed'
  balance                          // charges_total - payments_total
}
```

Rules:

- Room line amount is `booking.total_price`; nights =
  `check_out - check_in`.
- `restaurant_order.status = 'cancelled'` rows are excluded; all other
  statuses (pending/preparing/delivered) count — an order placed is an
  order owed.
- Pending and refunded payments appear in `payments` but do not reduce
  the balance.
- All money math in integer cents server-side (reusing the
  `treatmentPriceCents`-style conversion), serialized back to 2-dp
  strings like every other NUMERIC in the API.
- Cancelled bookings still return a folio (read-only view of what was
  charged/paid).

## Endpoints

New controller `src/controllers/folio.js`; routes appended to
`src/routes/bookings.js` (they are booking-subordinate, like spa
payments are appointment-subordinate). All `authenticate` +
property-scoped; cross-property ids read as 404. Swagger entries under
a new `Folio` tag.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/bookings/:id/folio` | Folio JSON above |
| POST | `/api/bookings/:id/folio/adjustments` | `{description, amount}`; both required, `amount ≠ 0` → 201 with the row |
| DELETE | `/api/bookings/:id/folio/adjustments/:adjustment_id` | 204; 404 if not on this booking/property |
| POST | `/api/bookings/:id/folio/payment-intent` | `{amount?}` — see Tap to Pay |
| POST | `/api/bookings/:id/folio/confirm-payment` | `{stripe_payment_intent_id}` — see Tap to Pay |

## Tap to Pay flow

Mirrors `spaPayments.js` (same guards, same idempotency, same 502 on
Stripe errors) with one structural difference: **the pending state
lives in the `payment` ledger**, not in a status column.

### `POST /:id/folio/payment-intent`

1. Load booking + property (`stripe_secret_key`, `currency`); 404 / 409
   `No Stripe secret key configured` as in spa.
2. 409 if the booking status is `cancelled`.
3. `amount` (request body) defaults to the outstanding balance; must be
   > 0 and ≤ balance (409 otherwise — no overpayment, nothing to pay).
4. Idempotency: look for this booking's `payment` row with
   `status = 'pending' AND method = 'card' AND stripe_payment_intent_id IS NOT NULL`
   (at most one exists by construction):
   - intent in `requires_payment_method / requires_confirmation /
     requires_capture / requires_action` → reuse: return its
     `client_secret` (if the requested amount differs from the row's,
     update the Stripe intent amount and the row to match).
   - intent `succeeded` (crash window) → complete the row
     (`status = 'completed'`, `paid_at = now()`), return
     `{ already_paid: true, payment_intent_id }`.
   - intent `canceled` → mint a fresh intent and overwrite the same
     row's intent id and amount.
5. Otherwise create the intent (`payment_method_types: ['card_present']`,
   `capture_method: 'automatic'`, property currency, metadata
   `{ booking_id }`) and insert the pending `payment` row
   (`method 'card'`, the amount, the intent id).
6. Return `{ client_secret, payment_intent_id, amount }`.

### `POST /:id/folio/confirm-payment`

1. `stripe_payment_intent_id` required; must match this booking's
   pending card `payment` row (409 `Payment intent does not match` —
   prevents attaching an unrelated charge).
2. Retrieve the intent; 409 unless `succeeded`; 409 if `intent.amount`
   differs from the row's amount in cents.
3. Update the row: `status = 'completed'`, `paid_at = now()`. Return
   the updated payment row.

Partial payments fall out naturally (pay some now by card, the rest
later); manual cash/card entries continue through the existing
`POST /api/payments` untouched.

## Check-out soft gate

In `updateBooking` (`src/controllers/bookings.js`): when the requested
status is `checked_out` and the current status isn't already
`checked_out`, compute the folio. If `balance > 0` and the body does
not carry `force: true` →

```json
409 { "error": "Outstanding folio balance", "balance": "42.50" }
```

`force: true` proceeds (comps/disputes are the property's call). No
other transitions change.

## Error handling

House pattern throughout: `{ error, details? }`, 400 validation, 404
not-found (including cross-property), 409 conflicts, 502 for Stripe
errors (`err.type?.startsWith('Stripe')`), everything else to
`errorHandler`.

## Verification

No test framework exists in this repo; verification is endpoint-level
against the dev server, consistent with every prior feature:

1. Migrations apply cleanly and are idempotent (run twice).
2. Folio for a seeded booking shows room line = `total_price`; adding a
   `booking_extra` and a room-service order changes `charges_total`
   accordingly; cancelling the order removes its line.
3. Adjustment add/delete round-trip; `amount: 0` and missing fields 400.
4. Manual `POST /api/payments` (completed) reduces the balance; pending
   ones don't.
5. Check-out with balance → 409; with `force: true` → succeeds; with
   zero balance → succeeds.
6. Payment-intent/confirm flow exercised against Stripe test mode where
   a key is configured; guard paths (no key, cancelled booking, amount
   > balance, mismatched intent) exercised regardless.
7. Cross-property scoping: another property's booking id 404s on every
   new endpoint.
