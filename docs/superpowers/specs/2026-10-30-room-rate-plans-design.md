# Room rate plans (Saver / Flex)

Agreed with Robert, 30 Oct 2026. Saver/Flex is the standard hotel setup on
the systems Robert has worked on and used; OTA rooms have one price per
night and no cancellation terms. This adds rate plans: the same room sold
at different prices with different payment and cancellation terms, and
card payment for room bookings (OTA takes none today — `payment` rows are
manual records).

## Intent

A guest on a hotel's site sees each room type at, say, Saver £180
(non-refundable, paid now) and Flex £205 (free cancellation to 48 h before
arrival). They pick one, pay by card on the site, and get a confirmation.
Staff booking by phone or at the desk pick a plan too; the guest is emailed
a pay link, unless staff decide this guest isn't chased for payment.

## Goals

- Rate plans per room type: a price adjustment, refundable or not, a free
  cancellation deadline, and how the guest pays (full / deposit / hold).
- Online card payment for room bookings on the website (API-key) rail.
- Staff bookings with a plan: emailed pay link, or "pay at hotel".
- Guest cancellation online enforces the plan; staff can always cancel.
- Bookings that are never paid expire and release the room.

## Non-goals (this round)

- Dated per-plan prices ("Saver is £150 on 24 Dec"). Robert may want this
  later; the price rule below leaves a slot for it (see Later).
- Late-cancellation and no-show fees — manual, as on Robert's systems.
- Stay restrictions (min nights, advance purchase, plan only on some
  dates), channel-manager distribution, Stripe webhooks.
- A stored "trusted guest" flag.
- Dashboard screens — the room-bookings dashboard is `ota-table-bookings`
  (`src/pages/room-bookings.astro`) with `hotal-ui` components; planned
  separately. This spec covers the API they call.
- MCP tools for plans (`mcp-server/tools.js`) — add when wanted.

## Anti-goals (failure even if it works)

- **A website can skip payment.** The API-key rail must not be able to book
  a plan-enabled room type without paying (no plan, or pay-at-hotel).
- **Existing integrations change behaviour.** A room type with no rate
  plans, and any booking without a plan, behaves exactly as today:
  `confirmed` immediately, no payment, no email, cancel as today.
- **A guest is charged twice** or a paid booking expires.
- **Editing a plan changes the terms of bookings already made.**

## Decisions

### 1. `rate_plan` table

```sql
CREATE TABLE IF NOT EXISTS rate_plan (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID          NOT NULL REFERENCES property(id),
  room_type_id        UUID          NOT NULL REFERENCES room_type(id),
  name                VARCHAR(100)  NOT NULL,           -- 'Saver', 'Flex'
  adjustment_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0, -- -12.00 = 12% off; >= -100
  refundable          BOOLEAN       NOT NULL,
  cancel_cutoff_hours INT,                              -- required iff refundable; >= 0
  payment_mode        VARCHAR(10)   NOT NULL,           -- 'full' | 'deposit' | 'hold'
  deposit_kind        VARCHAR(10),                      -- 'percent' | 'fixed'; required iff deposit
  deposit_value       NUMERIC(10,2),                    -- required iff deposit; > 0 (percent <= 100)
  sort_order          INT           NOT NULL DEFAULT 0,
  status              VARCHAR(20)   NOT NULL DEFAULT 'active' -- 'active' | 'archived'
);
CREATE INDEX IF NOT EXISTS idx_rate_plan_room_type ON rate_plan(room_type_id);
```

CHECK constraints enforce the "required iff" rules and the enums.
`payment_mode = 'hold'` is not allowed on a non-refundable plan (a hold
exists to cover the free-cancellation window; a non-refundable plan has
none). No delete: plans are archived, since bookings reference them.

### 2. Price

Per night, resolve the rate exactly as today (`room_availability.override_rate`
→ `room_type_rate.rate` → `room_type.base_rate`), then apply the plan:
`round2(night_rate × (1 + adjustment_pct / 100))`. Sum the nights. (My
call: round per night, not on the total, so a nightly breakdown shown to
the guest adds up to the total.) No plan = no adjustment = today's total.

### 3. Booking columns and statuses

```sql
ALTER TABLE booking
  ADD COLUMN rate_plan_id             UUID REFERENCES rate_plan(id),
  ADD COLUMN rate_plan_terms          JSONB,        -- snapshot at booking time
  ADD COLUMN payment_due_at           TIMESTAMPTZ,  -- set while pending_payment
  ADD COLUMN stripe_payment_intent_id VARCHAR(255); -- the booking's card PI
```

- `rate_plan_terms` snapshots `{ name, adjustment_pct, refundable,
  cancel_cutoff_hours, payment_mode, deposit_kind, deposit_value }` plus
  `pay_at_hotel` and the `payment_mode` actually used (see hold fallback).
  All enforcement reads the snapshot, never the live plan, so editing a
  plan only affects new bookings.
- New statuses: **`pending_payment`** (holds the room, awaiting card) and
  **`expired`** (never paid; room released). Lifecycle:
  `pending_payment → confirmed → checked_in → checked_out`, ending early as
  `cancelled` or `expired`.
- Everywhere that treats `cancelled` as "no longer holds the room" must
  treat `expired` the same:
  - `booking_no_overlap` exclusion: `WHERE (status NOT IN ('cancelled','expired'))`
    (migration drops and re-adds the constraint).
  - Folio guard `src/controllers/folio.js:88`: refuse `expired` too.
  - Guest stats `src/controllers/guests.js:126`: add
    `COUNT(*) FILTER (WHERE b.status = 'expired') AS expired` — the
    dashboard's "should we chase this guest" prompt reads it.
  - Review-request view `src/db/schema.sql:656`: exclude `expired` and
    `pending_payment`.
- `PUT /api/bookings/:id` must refuse setting `pending_payment` or
  `expired` by hand (400); those are system-set.
- The card PI lives on the booking, **not** as a `pending` payment row:
  `findPendingCardPayment` in folio reuses any pending card row's intent,
  and a booking hold must never be reused for a folio charge. A `payment`
  row is written only when money is actually taken (`completed`), so the
  folio balance is right automatically.

### 4. Who is calling

`req.auth_method === 'api_key'` (set in `src/middleware/auth.js:94`) is
the guest/website rail: plan rules are enforced. Anything else on
`authenticateOrApiKey` routes is a signed-in staff member: may choose
pay-at-hotel and may override cancellation rules. Nothing extra is stored
to tell them apart.

### 5. Creating a booking — `POST /api/bookings`

New optional body fields: `rate_plan_id`, `pay_at_hotel` (boolean).

Validation:
- `rate_plan_id` must be an `active` plan of this property whose
  `room_type_id` is the booked room type (from `room_type_id`, or the
  room's type for `room_id`). Else 400.
- **API-key rail:** if the room type has any active plan, `rate_plan_id` is
  required (400). `pay_at_hotel` on this rail is 403.
- `pay_at_hotel` without `rate_plan_id` is 400 (no plan = today's
  behaviour already, nothing to waive).

Outcomes:

| Caller | Plan | Result |
|---|---|---|
| any | none | Exactly today: `confirmed`, no payment, no email. |
| staff | plan + `pay_at_hotel` | `confirmed`; snapshot stored; confirmation email; balance on folio. |
| API key | plan | `pending_payment`, `payment_due_at = now() + 30 min`. No PI yet — the site attaches extras, then calls `payment-intent` (§7). |
| staff | plan | `pending_payment`, `payment_due_at = now() + 24 h`; pay-request email sent. |

The booking insert stays in the existing transaction (availability marked
unavailable as today — a `pending_payment` booking holds the room). No
Stripe call happens in `POST /api/bookings`; the PI is created later, once
the bill is final (Robert: the online charge covers extras too — Peter
Island charges room + extras in one payment today).

Preconditions, checked before insert (409 with a clear message):
- Plan booking that needs a card (not pay-at-hotel) and the property has no
  `stripe_secret_key` / `stripe_publishable_key`: "Online payment is not
  set up for this property". Staff can still use pay-at-hotel.
- Staff plan booking (not pay-at-hotel) and the property has no
  `room_booking_url` (§7): the pay link has nowhere to point — "Set the
  room booking page link in Settings → Branding, or use pay at hotel".
- Room total rounds to 0: treat as pay-at-hotel (Stripe refuses zero),
  marina's rule.

### 6. Amount charged, and the hold fallback

Worked out when the PI is created (§7), from the booking's folio
(`computeFolio`, `src/lib/folio.js`): **charges** = room + extras +
anything else on the bill at that moment; **balance** = charges − completed
payments.

- `full`: the balance, captured.
- `deposit`: `percent` → `round2(charges × value / 100)`; `fixed` →
  `value`; either capped at the balance. Captured. The rest sits on the
  folio and is paid through the existing folio payment routes.
- `hold`: the balance, `capture_method: 'manual'`.

A balance of 0 when the PI is requested → confirm straight away with no
PI (nothing to charge).

**Cancellation deadline** = check-in date at 00:00 in the property's
`timezone`, minus `cancel_cutoff_hours`. (My call: there is no property
check-in time to anchor on; midnight is the conservative choice.)

**Hold fallback:** Stripe card authorisations last about 7 days, and a hold
is captured at the deadline. So hold is used only when the deadline is in
the future and within 6 days of when the PI is created; otherwise the
booking charges `full` instead (refundable before the deadline like any
Flex booking). Decided at PI creation (that's when the authorisation
starts), recorded in the snapshot, and returned as `mode`.

### 7. Paying — card step and pay link

- `POST /api/bookings/:id/payment-intent` (`authenticateOrApiKey`): for a
  `pending_payment` booking, works out the amount (§6) and returns
  `{ client_secret, publishable_key, amount, mode }`. Reuses the booking's
  existing PI if there is one, updating its amount if the bill changed
  (Stripe allows this before confirmation); creates it otherwise
  (idempotency key `room-booking-<id>`, metadata `{ property_id,
  booking_id }`). Website flow: create booking → attach extras
  (`POST /api/extras/booking/:id`, existing) → this → Stripe card form →
  confirm-payment. The pay-link page calls the same endpoint. Stripe
  failure → 502; the booking stays `pending_payment` so the guest can retry
  until it expires.
- `POST /api/bookings/:id/confirm-payment` (`authenticateOrApiKey`): the site
  calls it after Stripe confirms the card. Retrieves the PI from Stripe;
  if it is `succeeded` (full/deposit) or `requires_capture` (hold), then
  under a row lock: `pending_payment → confirmed`, clear `payment_due_at`,
  and for full/deposit insert a `payment` row (`method 'card'`,
  `status 'completed'`, `amount` = the PI's `amount_received`,
  `stripe_payment_intent_id`, `paid_at now()`). Idempotent: already
  `confirmed` → 200 with the booking. Sends the confirmation email.
  Publishes the Ably status change as `updateBooking` does. Extras added
  after this go on the folio as today.
- **Pay link — new property setting `room_booking_url`** (Robert's call:
  the existing `email_cancel_url` is spa-only — its `{id}` is a spa
  appointment id). `TEXT`, nullable, may contain `{id}` (the room booking
  id), validated like `cancel_url` (`src/middleware/validate.js:71`). Read
  and written through the existing Settings → Branding endpoints in
  `src/controllers/property.js` (`REVIEW_REQUEST_FIELDS` and the branding
  update), shown in swagger. It is the hotel's room manage-booking page:
  for a `pending_payment` booking it shows the card form, otherwise the
  booking and a cancel button. Used by both emails. The link carries the
  booking id only, the same exposure as spa's cancel link today; a signed
  token like `src/lib/marinaToken.js` can be added later if wanted.
- **Staff confirm by hand:** `PUT /api/bookings/:id { status: 'confirmed' }`
  on a `pending_payment` booking (staff route already) is allowed — the
  guest paid another way, or staff decided not to chase after all. It
  cancels the booking's uncaptured/unpaid PI, clears `payment_due_at`, and
  sets `rate_plan_terms.pay_at_hotel = true`. Staff record any cash/bank
  payment through the existing payments/folio routes.

### 8. Background jobs

Both follow the existing `start…Job` pattern (`src/server.js`), every
minute, each row under its own row lock (`src/lib/marinaLifecycle.js`
sweep).

- **Expiry:** `pending_payment` with `payment_due_at < now()`. If there
  is a PI, first retrieve it: if it is already paid/held (the guest paid but
  confirm-payment never arrived) → confirm it as in §7. Otherwise cancel
  the PI (ignore "already cancelled"), set `expired`, release
  availability, refresh the view, publish the status change.
- **Hold capture:** `confirmed` bookings whose snapshot `payment_mode` is
  `hold`, PI still `requires_capture`, and deadline passed → capture, then
  insert the `completed` payment row. On failure (declined, authorisation
  lapsed): log it and leave it — the amount stays on the folio and the
  existing check-out gate catches it. No retry loop. (My call.)

### 9. Cancelling — `DELETE /api/bookings/:id`

| Booking | Caller | Result |
|---|---|---|
| no plan | any | Exactly today. |
| `pending_payment` | any | Cancel the PI, `cancelled`, release. |
| plan, refundable, before deadline | API key | Refund every `completed` card payment on the booking via Stripe (payment → `refunded`), or cancel an uncaptured hold; then `cancelled`, release. |
| plan, after deadline, or non-refundable | API key | **409** `{ error: "This booking can no longer be cancelled online. Please contact the hotel.", details: <deadline or 'non-refundable'> }` |
| any | staff | `cancelled`, release. **No automatic refund.** An uncaptured hold is released (nothing was charged, and before the deadline the guest was entitled to free cancellation anyway). |

Pay-at-hotel bookings (including staff-confirmed-by-hand) follow their
plan's terms like any other: a Flex one can be cancelled online before the
deadline. Only card payments made through OTA are refunded automatically;
anything staff recorded (cash, bank transfer) is refunded by staff, who see
the cancellation on the live feed. (My call.)

The MCP server forwards the caller's `X-Api-Key` (`src/routes/mcp.js:11`),
so a cancel through Claude on an API key gets the guest rules, refund
included. Accepted: the guest rules only refund what the guest is entitled
to. (My call.)

Stripe calls happen before the status change (idempotency key
`room-refund-<payment id>`); if Stripe fails → 502 and the booking is
untouched.

### 10. Emails

Room bookings send no email today. Add two templates in `src/lib/resend.js`,
using the property's `email_branding` like the other modules:

- **Pay request** (staff `pending_payment` booking): stay details, plan
  name, amount due now, pay-by time (`payment_due_at` in the property
  timezone), pay link.
- **Confirmation** (any plan booking reaching `confirmed`, including
  pay-at-hotel): stay, plan, amount paid, balance due at the hotel,
  cancellation terms with the deadline in the property timezone (or
  "non-refundable"), link to `room_booking_url` (omitted if unset).

Bookings without a plan send nothing, as today.

### 11. Search — `GET /api/availability/search`

Additive; existing fields and ordering unchanged. Each room type gains
`plans`, active plans in `sort_order`:

```json
{ "id": "...", "name": "Saver", "from_rate": 158.40,
  "refundable": false, "cancel_deadline": null,
  "payment_mode": "full", "deposit": null }
```

`from_rate` = the row's `from_rate` with the plan's adjustment applied;
`cancel_deadline` computed for this `check_in` (ISO timestamp); `payment_mode`
is the mode that would be used (hold fallback applied); `deposit` is
`{ kind, value }` when relevant. A room type with no plans gets
`plans: []`. The exact total comes back on booking.

### 12. Managing plans

Under room types (`src/routes/roomTypes.js`):

- `GET /api/room-types/:id/rate-plans` — `authenticateOrApiKey`; the API-key
  rail sees `active` only.
- `POST /api/room-types/:id/rate-plans` — staff (`authenticate`).
- `PUT /api/room-types/:id/rate-plans/:plan_id` — staff. Partial update,
  including `status: 'archived'`. Affects new bookings only.

Validation mirrors the CHECK constraints with 400s and readable messages.
Document all new routes and fields in `src/docs/swagger.js`.

## Rollout (Robert's call: an order, not a code gate)

Live hotel sites already book rooms their own way: Peter Island
(`peter-island/src/pages/api/book.ts`) charges the card on its own Stripe
key, then calls `POST /api/bookings` with `room_id` only and sends its own
confirmation email; `tested-trappist` (`src/lib/rooms.ts`) also creates
bookings over the API key. Once a room type has an active plan, those calls
get 400 — after the site has already charged the guest. So, per property:

1. Ship the API (plans exist on no room type yet → nothing changes).
2. Set the property's Stripe keys and `room_booking_url`.
3. Move the site to the plan flow (search `plans` → create with
   `rate_plan_id` → extras → `payment-intent` → `confirm-payment`), and
   drop the site's own charge and confirmation email at the same time so
   guests aren't charged twice or emailed twice.
4. Only then create that property's rate plans.

## Later

- **Dated per-plan prices:** a `rate_plan_rate (rate_plan_id, date, rate)`
  table that, when a row exists, replaces the adjustment for that night.
  It slots into the per-night step in §2; nothing else changes.
- Signed tokens on pay/cancel links; fees for late cancellation/no-show;
  plan restrictions; MCP tools; Stripe webhooks if the sweep proves too
  slow.

## Left to the builder

Migration file naming and order; helper placement (a `src/lib/roomPayments.js`
alongside the controller is fine); exact error copy beyond what's given;
email layout; how the sweep and capture jobs share code with marina's.
Tests: the repo has no test runner — leave one runnable self-check for the
money paths (price with adjustment and rounding, deposit amount, deadline
and hold fallback, cancellation decision table).

## Calls I made (for Robert to check)

1. Price rounding per night (§2).
2. Deadline anchored at 00:00 on check-in day, property timezone (§6).
3. Pay link carries the booking id only, no signed token (§7).
4. Stripe failure creating the PI → 502, booking stays `pending_payment`
   until it expires (§7).
5. Hold-capture failure is logged and left to the folio/check-out gate (§8).
6. Staff cancellation releases an uncaptured hold (§9).
7. Pay-at-hotel bookings follow their plan's cancel terms; non-card
   payments are refunded by staff (§9).
8. MCP calls on an API key get the guest cancellation rules (§9).
9. Confirmation email for every plan booking, including pay-at-hotel (§10).
10. Staff "confirm by hand" doubles as converting to pay-at-hotel (§7).
11. Hold-vs-full decided when the PI is created, not at booking (§6).
