# Restaurant order payment tracking (spec only — not implemented)

## Status

**Spec only.** No plan, no code, per explicit instruction from the
requirements stub this is based on
(`docs/superpowers/specs/2026-08-16-mobile-ordering-app-backend-requirements.md`)
and confirmed with the user. This document exists to hand the decision
and its reasoning to whoever picks this up next — it is not
implementation-ready in the sense every other spec in this repo's
`docs/superpowers/specs/` directory is; treat the schema choice below
as a strong recommendation, not a locked decision, until someone
re-confirms it immediately before writing the actual plan.

## Context

The mobile ordering app (waitress+kitchen tool) will collect payment
table-side via Stripe Terminal Tap to Pay against a `restaurant_order`.
Confirmed by reading the schema directly (not assumed): `restaurant_order`
has no field or relationship recording that a payment was ever
collected. `payment` (`src/db/schema.sql`) has `booking_id UUID NOT
NULL REFERENCES booking(id)` — a table-only order (`table_id` set,
`booking_id` null, which `restaurant_order`'s own
`CHECK (booking_id IS NOT NULL OR table_id IS NOT NULL)` explicitly
permits, and which `createOrder` accepts today) has nowhere to record
a charge at all. This is a confirmed gap in the current schema, not a
design choice someone made deliberately.

Also confirmed: `payment` currently has no Stripe-specific field
(`amount`, `method`, `status`, `paid_at` only) — whichever shape is
chosen below, a Stripe reconciliation field (`stripe_payment_intent_id`
or equivalent) is new work either way, not something Option B gets for
free by reusing the existing table.

## Two shapes — recommendation: Option A

**Option A (recommended): payment fields directly on `restaurant_order`**

```sql
ALTER TABLE restaurant_order ADD COLUMN payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid';
ALTER TABLE restaurant_order ADD COLUMN paid_at TIMESTAMPTZ;
ALTER TABLE restaurant_order ADD COLUMN stripe_payment_intent_id VARCHAR(255);
```
`payment_status` values: `unpaid` / `paid` / `refunded`.

Reasoning: `payment` was built for hotel-booking installments — a
guest can pay a deposit, then a balance, potentially get a partial
refund, all against one `booking_id`, all things the table's shape
(`amount` per row, multiple rows per booking) supports. A Tap to Pay
restaurant charge is a single atomic in-person transaction — no
split/partial/refund flow has been discussed for it anywhere. Forcing
it into a multi-row ledger designed for a genuinely different payment
pattern adds complexity (new nullable `booking_id`, a new
`restaurant_order_id` column, a CHECK constraint) without buying
anything a single status field doesn't already give.

**Option B: unify into the existing `payment` ledger**

```sql
ALTER TABLE payment ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payment ADD COLUMN restaurant_order_id UUID REFERENCES restaurant_order(id);
ALTER TABLE payment ADD CONSTRAINT payment_booking_or_order CHECK (
  (booking_id IS NOT NULL AND restaurant_order_id IS NULL) OR
  (booking_id IS NULL AND restaurant_order_id IS NOT NULL)
);
```

Mirrors `restaurant_order`'s own `booking_id`-or-`table_id` pattern,
and gives one unified place to query "all payments for this property,"
which Option A doesn't (a payment-report query would need to `UNION`
`payment` and `restaurant_order` under Option A).

Why this isn't the recommendation despite that: relaxing `booking_id`
to nullable is a behavioral change to a table hotel-booking payments
already depend on in production — every existing query or report
built against `payment` that implicitly assumes `booking_id IS NOT
NULL` (there is no code inventory confirming none do; this would need
an actual audit before being safe) needs re-checking. That's real risk
on a working, revenue-relevant path, taken on to make a
same-effort-either-way Stripe field addition slightly more unified.
Option A's blast radius is a new table with no existing dependents.

## What a real spec pass still needs to decide

Left genuinely open, not just deferred by scope:

- The mobile app needs an endpoint to report a successful charge back
  once Stripe confirms it client-side. Candidates: a new
  `PUT /api/restaurant-orders/:id/payment`, or folding payment fields
  into the existing `PUT /api/restaurant-orders/:id/status` (which
  already exists and is `authenticate`-only, per
  `docs/superpowers/specs/2026-08-16-restaurant-order-realtime-design.md`).
  Folding is more convenient for the mobile client (one call after a
  successful charge, likely alongside marking the order `delivered`)
  but conflates two independent state changes (fulfillment status vs.
  payment status) in one endpoint — worth deciding deliberately, not
  defaulting to whichever is less code.
- Whether a failed/cancelled Tap to Pay attempt needs any server-side
  record at all. Leaning no (only successful charges matter to this
  system), but not confirmed.
- Whether `payment_status: 'refunded'` needs its own `refunded_at`/
  `refund_amount` fields now, or whether that's a real "add it when
  refunds actually come up" case — no refund flow has been described
  yet for restaurant orders specifically.
- Whether an Ably event (matching the pattern established in the
  realtime-events spec) should fire on a payment status change too,
  or whether `order-status-changed`/a reload is sufficient for the
  kitchen/waitress screen to notice a table's now paid.

## Non-goals (of this document itself)

- No migration file, no controller/route code, no `curl`-based
  verification steps — this repo's established convention for a
  ready-to-build spec is deliberately not what this document is.
- No decision on the open questions above — flagged, not resolved.
