# Multi-room Room Bookings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A website (or staff) can quote and book several rooms as one basket: cheapest defaults, one rate for the basket, one card payment, whole-basket guest cancel.

**Architecture:**
- Each room stays its own `booking` row. Rooms in a basket share a nullable `booking.group_id`.
- A stateless quote (`POST /api/availability/quote`) prices baskets.
- `POST /api/bookings` takes `rooms: [...]` and books them all in one transaction.
- The existing payment, expiry, capture, cancel, basket-feed and email code learns that a
  booking can have group siblings. A single-room booking is a "group of one", so its behaviour
  does not change.

**Tech Stack:** Node.js / Express / PostgreSQL (`pg`), Stripe (fake in checks), Resend.

**Spec:** `docs/superpowers/specs/2026-11-07-multi-room-bookings-design.md`

## Global Constraints

- **Single-room bookings unchanged:** same request, response, emails, Stripe idempotency keys
  (`room-booking-${id}`, `room-refund-…`, `room-confirmation-${id}`, `room-pay-request-${id}`)
  and basket rows.
- **Property scoping:** every query is scoped by property (`req.property_id`).
- **Dates and stays:** dates are `YYYY-MM-DD`; stays are `[check_in, check_out)`.
- **Transactions:** multi-step writes run in one transaction. Call
  `roomPayments.refreshAvailabilityView()` after COMMIT, never inside the transaction.
- **Lock order:** lock room types in sorted id order. Lock group members in `id` order.
- **Errors** are `{ error, details? }` with 400 / 404 / 409.
- **Size limit:** at most **10** rooms per basket (my call). More is a 400.
- **Occupancy:** a room fits a type when `adults + children <= room_type.max_occupancy`.
  `guests` stored = adults + children.
- **Same-name plans:** active plans with the same name at one property must share
  `payment_mode, refundable, cancel_cutoff_hours, deposit_kind, deposit_value`.
  `adjustment_pct` may differ.
- **Deploy order:** run the live migration (with Robert's OK) **before** pushing.

## Review Focus

1. **Two baskets race for the last room of a type.** One wins. The other gets a 409, and none of
   its rooms are held. Test: Task 3, "concurrent baskets".
2. **An extra is added to one room between payment-intent and confirm.** The payment rows split
   the amount Stripe actually received, and their sum is exactly that amount. Test: Task 4,
   "splitCents sums exactly" + "confirm splits shares".
3. **Staff cancel one room of a basket on a card hold, then the guest cancels the rest.**
   - Staff cancel: the hold stays open.
   - The capture takes only the live rooms.
   - The later guest cancel releases the hold once without errors.

   Test: Task 5, "hold: staff drops one room".
4. **The expiry sweep picks up several members of one basket in the same run.** Every member
   expires once, the PaymentIntent is cancelled once, and there are no errors. Test: Task 4,
   "expire group".
5. **A zero-decimal currency (IDR).** Group sums go through `toStripeAmount` / `fromStripeAmount`
   exactly as singles do. Test: Task 4, "IDR basket amount".

---

### Task 1: Schema + same-name plan guard

**Files:**
- Create: `src/db/migrate-2026-11-07-multi-room-bookings.sql`
- Modify: `src/db/schema.sql` (booking table, after `basket_reminder_resend_email_id`)
- Modify: `src/controllers/ratePlans.js` (`createRatePlan`, `updateRatePlan`)
- Modify: `src/lib/ratePlans.js` (add `TERM_FIELDS`, `sameTerms`)
- Test: `scripts/check-multi-room-bookings.js` (create; harness copied from
  `scripts/check-rate-plans.js` lines 1-125: remote-DB refusal, fake Stripe, `app.listen(0)`,
  throwaway properties, `api()`/`staff()` helpers, cleanup in `finally` that also deletes
  `booking_night` and `booking_room_move` rows)

**Interfaces:**
- Produces:
  - column `booking.group_id UUID NULL`;
  - index `idx_booking_group ON booking(group_id) WHERE group_id IS NOT NULL`;
  - `TERM_FIELDS = ['payment_mode','refundable','cancel_cutoff_hours','deposit_kind','deposit_value']`;
  - `sameTerms(a, b) -> boolean` (numeric-safe compare of `TERM_FIELDS`).

- [ ] **Step 1: Write the failing checks**
  - `sameTerms`: true for `{deposit_value:'20.00'}` vs `{deposit_value:20}`; false when
    `cancel_cutoff_hours` differs.
  - HTTP: create Saver (full, non-refundable) on type A → 201. Create Saver (hold, refundable 48)
    on type B → **409**, body `error` matching `/Saver/`. Create Saver identical to A's terms but
    `adjustment_pct: -5` on type B → 201.
  - HTTP: `PUT` type B's Saver to `payment_mode: 'deposit'` (+ deposit fields) → 409.
  - HTTP: archiving (`status: 'archived'`) never conflicts.
- [ ] **Step 2: Run it.** `node -r dotenv/config scripts/check-multi-room-bookings.js` → FAIL
  (`sameTerms` is not a function).
- [ ] **Step 3: Implement**
  - Migration: `ALTER TABLE booking ADD COLUMN IF NOT EXISTS group_id UUID;` plus the index.
    Make the same change in `schema.sql`, with the comment
    `-- rooms booked together (multi-room basket); null = booked alone`.
  - In both controllers, after `validatePlan` and only when the plan is `active`: select the
    property's other active plans with `lower(name) = lower($name)` (excluding this id). If any
    `!sameTerms`, return 409 with
    `{ error: 'A rate plan named "<name>" already exists with different payment or cancellation terms', details: 'Plans with the same name must share payment_mode, refundable, cancel_cutoff_hours and deposit' }`.
- [ ] **Step 4: Apply locally and run.** `node scripts/run-migration.js` is **not** used yet,
  because it also hits live. Apply locally with
  `psql "$DATABASE_URL" -f src/db/migrate-2026-11-07-multi-room-bookings.sql`. Then run the
  check → Task 1 checks PASS.
- [ ] **Step 5: Commit.** `git commit -m "Multi-room: booking.group_id + same-name rate plans share terms"`

### Task 2: Quote

**Files:**
- Create: `src/lib/roomQuote.js`
- Modify: `src/lib/ratePlans.js` (add `stayPrice`)
- Modify: `src/controllers/bookings.js` (createBooking pricing loop uses `stayPrice`)
- Modify: `src/controllers/availability.js` (add `quoteBasket`)
- Modify: `src/routes/availability.js` (`router.post('/quote', ctrl.quoteBasket)`, no auth middleware, like `/search`)
- Test: `scripts/check-multi-room-bookings.js`

**Interfaces:**
- Produces:
  - `stayPrice(nights: string[], typeRates: {[date]: number}, baseRate: number, overrides: {[date]: number}, adjustmentPct: number|null) -> number`
    - per-night `overrides[d] ?? typeRates[d] ?? baseRate`;
    - `applyAdjustment` when `adjustmentPct != null`;
    - summed and rounded to 2 dp.

    This is exactly the current loop in `createBooking`, moved.
  - `pickBasket(rooms: {guests:number, pick:string|null}[], candidates: {[typeId]: {price:number, max_occupancy:number}}, stock: {[typeId]: number}) -> { types: string[], total: number } | null`
    - the lowest-total assignment: each room gets a type that fits;
    - a room's `pick`, when set, is forced;
    - a type is used at most `stock[t]` times;
    - ties go to the order of `candidates`.
  - `quote(db, propertyId, { check_in, check_out, rooms: [{adults, children?, room_type_id?}], rate?: string|null }) -> QuoteResponse`
  - `QuoteResponse`:
    ```
    { check_in, check_out, nights, currency, available, rate, total, terms,
      rates: [{ rate, total, terms }],
      rooms: [{ adults, children, guests, room_type_id, room_type_name, rate_plan_id, price,
                options: [{ room_type_id, room_type_name, rate_plan_id, price, delta }] }],
      unavailable: [{ room: number|null, reason: 'too_many_guests'|'not_enough_rooms' }] }
    ```
    - `rate: null` means the no-online-payment rate (types with no active plan). `rate`
      **omitted** in the request means the cheapest.
    - `terms` is the plan's `TERM_FIELDS` + `name`, or null.
    - `rates` lists every rate that can place the whole basket with the current picks, cheapest
      first.

- [ ] **Step 1: Write the failing checks**
  - `pickBasket`:
    - types A(100, occ 2, stock 1) and B(150, occ 4, stock 5), rooms `[{guests:2},{guests:2}]`
      → `types ['A','B'] total 250`;
    - `[{guests:3}]` → `['B']`;
    - stock A=0, B=0 → `null`;
    - a lowest-total case that greedy filling gets wrong: rooms `[{guests:2},{guests:4}]`,
      A(100, occ 4, stock 1), B(120, occ 2, stock 5), C(300, occ 4, stock 5) →
      `['B','A'] total 220`;
    - pick forced: `[{guests:2,pick:'B'},{guests:2}]` → `['B','A']`.
  - `stayPrice(['2030-01-01','2030-01-02'], {'2030-01-01':120}, 100, {}, -10)` → `198`.
  - HTTP `POST /api/availability/quote` with API key. Fixtures: type Std (occ 2, base 100, 1
    room) and Dlx (occ 3, base 150, 3 rooms); Saver −10% (full, non-refundable) and Flex 0%
    (hold, refundable 48) on both.
    - 2 rooms × 2 adults → `rate 'Saver'`, rooms on Std then Dlx, `total = (90+135)*nights`;
      Std's `options` lists Dlx with `delta = 45*nights`; `rates` contains Flex with the higher
      total.
    - `rate:'Flex'` → every `rate_plan_id` is a Flex plan.
    - A room with 5 adults → `available:false`,
      `unavailable:[{room:1, reason:'too_many_guests'}]`.
    - 5 rooms → `available:false`, `unavailable:[{room:null, reason:'not_enough_rooms'}]`.
    - 11 rooms → 400. `check_in >= check_out` → 400. A missing key and missing `property_id`
      → 400.
    - The quote total equals the `total_price` sum of a later create (checked in Task 3).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**
  - Property resolution: copy `searchAvailability`'s key / `property_id` block into a shared
    `resolveQuoteProperty(req)` in `availability.js`, and use it in both.
  - Stock = min over nights of `sellable` from `roomNights.typeCounts(db, propertyId, null, nights)`.
  - Prices come from `room_type_rate` + `base_rate` through `stayPrice`, with no overrides.
  - `pickBasket` is a depth-first search over rooms, with candidates sorted by price and pruned
    on best total. Add the comment
    `// ponytail: exhaustive search, fine for <=10 rooms x a handful of types`.
  - Per-room options: other fitting types under the same rate where
    `count of that type among the other rooms + 1 <= stock`.
- [ ] **Step 4: Run** → Task 2 checks PASS, and `check-rate-plans.js` still passes (`stayPrice`
  refactor).
- [ ] **Step 5: Commit.** `git commit -m "Multi-room: POST /api/availability/quote (cheapest basket, one rate)"`

### Task 3: Multi-room create

**Files:**
- Modify: `src/controllers/bookings.js` (`createBooking`)
- Test: `scripts/check-multi-room-bookings.js`

**Interfaces:**
- Consumes: `stayPrice`, `booking.group_id`.
- Produces:
  - `POST /api/bookings` body may carry `rooms: [{ room_id? | room_type_id?, rate_plan_id?, guests? }]`
    (1-10) **instead of** top-level `room_id` / `room_type_id` / `rate_plan_id` / `guests`.
    Giving both forms → 400.
  - Response 201: `{ group_id: uuid|null, total_price: string, status, bookings: [joinedBooking] }`.
    `group_id` is null when `rooms.length === 1`.
  - Internal: `bookStay(client, req, { check_in, check_out, nights, guest_id, room, groupId, pay_at_hotel, viaApiKey, source, send_emails, metadata }) -> bookingRow`.
    Single-room calls it with `groupId: null`. Errors are thrown with `.status` (400/404/409),
    replacing the inline `return res.status(...)`.

- [ ] **Step 1: Write the failing checks** (API key, fixtures from Task 2)
  - The quote's rooms posted as `rooms` → 201:
    - 2 bookings, same `group_id`, both `pending_payment`, same `payment_due_at`, both
      `website_checkout`;
    - the `total_price` sum equals the quote total;
    - `total_price` in the response equals that sum.
  - Mixed plan names (Saver + Flex) → 400 `/one rate/`.
  - On a type with plans, `rate_plan_id` missing for one room (API key) → 400 (existing rule).
  - `guests` over `max_occupancy` → 400.
  - **All or nothing:** 2 rooms of Std (1 room in stock) → 409. No booking rows for the guest,
    and no `booking_night` rows.
  - **Concurrent baskets:** two `Promise.all` creates each wanting the last Std → exactly one 201
    and one 409. The loser left no rows.
  - Staff (`staff(ctrl.createBooking, …)`) with `pay_at_hotel: true` and 2 rooms → 201, both
    `confirmed`.
  - Single-room POST → response shape unchanged (has `id`, has no `bookings`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**
  - Move the per-room body of `createBooking` into `bookStay`.
  - The `rooms` path:
    - validates;
    - checks every plan has the same `name` (error `'All rooms in a booking must be on one rate'`);
    - locks all distinct room types in sorted order with `roomNights.lockType`;
    - inserts with `group_id = gen_random_uuid()` from the first insert (or a JS
      `crypto.randomUUID()`);
    - holds each stay.

    Any 409 rolls everything back.
  - After COMMIT: refresh the view once, publish each booking, and call `sendConfirmation` /
    `sendPayRequest` **once**, with the first booking's id. Task 6 makes that email list the
    whole group.
- [ ] **Step 4: Run** → Task 3 PASS; `check-rate-plans.js` and `check-overbooking.js` still pass.
- [ ] **Step 5: Commit.** `git commit -m "Multi-room: POST /api/bookings rooms[] books a basket in one transaction"`

### Task 4: Group payment (intent, confirm, settle, expire, capture)

**Files:**
- Modify: `src/lib/roomPayments.js`
- Modify: `src/lib/folio.js` (or `roomPayments.js`): add `splitCents`
- Modify: `scripts/fake-stripe.js`:
  - `capture(id, params)` sets `amount_received = params?.amount_to_capture ?? pi.amount`;
  - `refunds.create` records `amount` into `pi.refunds` (an array).

  Both changes are backward compatible.
- Test: `scripts/check-multi-room-bookings.js`

**Interfaces:**
- Produces:
  - `lockMembers(client, bookingId, propertyId) -> booking[]`. Each row is shaped like
    `lockBooking`'s. Returns `[b]` when `group_id` is null, otherwise every booking in the group
    locked `ORDER BY id`. Returns `[]` when not found.
  - `splitCents(totalCents: number, weights: number[]) -> number[]`. The parts are proportional,
    use largest remainder, and sum exactly to `totalCents`. All-zero weights split evenly.
  - `paymentIntentFor`, `confirmPaid`, `settleByHand`, `expireOnce`, `captureHoldsOnce` keep
    their signatures and act on every member.
  - The group PaymentIntent:
    - idempotency key `room-group-${group_id}`;
    - metadata `{ property_id, group_id }`;
    - amount = Σ members' `chargeAmountCents` (each from its own folio);
    - its id is stored on **every** member's `stripe_payment_intent_id`;
    - `mode_used` is set on every member.
  - Payment rows on success or capture: one per live member,
    `amount = splitCents(received, memberDueCents)`.

- [ ] **Step 1: Write the failing checks**
  - `splitCents(1000,[1,1,1])` → `[334,333,333]`. `splitCents(999,[0,0])` → sums to 999.
    `splitCents(500,[300,200])` → `[300,200]`.
  - **One PI for the basket:** `payment-intent` on booking #2's id → `amount` = sum. Calling it
    on #1 returns the same `client_secret`. Both rows carry the same PI id.
  - **Confirm splits shares:** add an extra to room 1 after payment-intent, call payment-intent
    again (the amount updates), set the fake PI to succeeded with `amount_received`, then
    `confirm-payment` on #1. Both rows are `confirmed`, there are 2 payment rows, and their sum
    = `amount_received`. Each room's folio balance = 0.
  - **IDR basket amount:** the same flow on an IDR property → the PI amount is `toStripeAmount`
    of the summed cents, and the payment rows round-trip.
  - **Expire group:** force `payment_due_at` into the past on both, then run `expireOnce()` →
    `{expired: 2}`, the PI is `canceled`, no errors are logged, and both release their nights.
    Running `expireOnce()` again → `{expired: 0}`.
  - **Expire paid:** the same with the PI `succeeded` → both `confirmed`, with payment rows.
  - **Capture hold:** a Flex basket inside the 6-day hold window → the PI is `manual`. After the
    cutoff, `captureHoldsOnce()` → one capture call, `{captured: 1}`, and 2 payment rows that sum
    to the captured amount.
  - **settleByHand** (staff `PUT` status confirmed on a pending member) → every member is
    `confirmed` with `pay_at_hotel`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**
  - Each function swaps `lockBooking` for `lockMembers` and loops over the members. The Stripe
    retrieve, cancel and capture calls happen once per PI.
  - `captureHoldsOnce` selects a group once (`DISTINCT ON (coalesce(group_id, id))`) and passes
    `amount_to_capture` = Σ live members' balance cents, capped at `pi.amount`.
  - `afterConfirmed(bookingIds[], propertyId)` publishes each member, then emails once with the
    first id.
  - Single bookings take the same code path with one member and the old idempotency key.
- [ ] **Step 4: Run** → Task 4 PASS; `check-rate-plans.js` and `check-room-baskets.js`
  still pass.
- [ ] **Step 5: Commit.** `git commit -m "Multi-room: one PaymentIntent per basket; confirm/expire/capture/settle the whole group"`

### Task 5: Cancel

**Files:**
- Modify: `src/controllers/bookings.js` (`cancelBooking`)
- Modify: `src/lib/roomPayments.js` (`stripeForCancel`)
- Test: `scripts/check-multi-room-bookings.js`

**Interfaces:**
- Consumes: `lockMembers`.
- Produces:
  - `stripeForCancel(b, { refund, keepIntent = false })`:
    - `keepIntent` skips cancelling an open or uncaptured PI;
    - refunds for a grouped booking pass `amount: toStripeAmount(toCents(p.amount), currency)`
      per payment row (idempotency key unchanged, `room-refund-${p.id}`).
  - `DELETE /api/bookings/:id`:
    - **via API key on a grouped booking:** cancels every live member. One decision for the
      basket (`guestCancelDecision` on the first member); `refuse` → 409 as today.
    - **staff on a grouped booking:**
      - `pending_payment` → 409 `{ error: 'This room is part of an unpaid multi-room booking', details: 'Cancel the whole booking from the website or confirm it first' }`;
      - otherwise cancels only that room, with `keepIntent: true` when other live members
        remain, and no refund.

- [ ] **Step 1: Write the failing checks**
  - Guest cancel of a Flex basket (refundable, before the deadline, paid in full) → all members
    `cancelled`, 2 refunds recorded on the fake PI with amounts = the payment rows, and payment
    rows `refunded`.
  - Guest cancel of a Saver basket that is paid → 409, nothing changes.
  - Guest cancel of a pending basket → all members `cancelled`, PI `canceled` once.
  - Staff cancel of one member of a pending basket → 409.
  - **Hold: staff drops one room.** Flex hold basket, staff cancel member #1 → #1 `cancelled`,
    PI still `requires_capture`. Then `captureHoldsOnce()` after the cutoff → captures only #2's
    balance; one payment row on #2. A separate run where the guest cancels the rest instead →
    PI `canceled`, no error.
  - Staff cancel of one member of a paid basket → that member `cancelled`, no refund, the other
    member untouched.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** as specified in the Interfaces above. Lock the members, decide, run
  Stripe, then update the rows, all in the existing single transaction. Release each member's
  nights with `releaseAvailability`.
- [ ] **Step 4: Run** → Task 5 PASS; `check-rate-plans.js` still passes.
- [ ] **Step 5: Commit.** `git commit -m "Multi-room: guest cancels the whole basket; staff cancel one room"`

### Task 6: Basket feed, reminder and emails list every room

**Files:**
- Modify: `src/lib/roomBaskets.js` (`OPEN`, `FEED_SELECT`, `CLAIM_SQL`, `claimDueRoomBaskets`, `sendOne`)
- Modify: `src/lib/roomBookingEmails.js` (`loadEmailContext`, `sendPayRequest`, `sendConfirmation`)
- Modify: `src/lib/resend.js` (`sendRoomPayRequest`, `sendRoomConfirmation`: accept `stays` array; `roomStayLine` per stay; `stay` still accepted)
- Test: `scripts/check-multi-room-bookings.js`

**Interfaces:**
- Produces:
  - **Basket lead:** a basket is represented by its lead member
    (`b.group_id IS NULL OR NOT EXISTS (member with smaller id)`).
  - **Feed rows:** `items` has one entry per member; `items_subtotal` = Σ `total_price`.
  - **`OPEN`:** a later booking with the same `group_id` does not close the basket.
  - **Reminder claim:** stamps the lead only. The email lists every room. Idempotency key
    `room-basket-reminder-${lead id}` is unchanged.
  - **Emails:**
    - `loadEmailContext` returns `stays` (all live members) and folio totals summed over members;
    - pay request amount = Σ member `chargeAmountCents`;
    - idempotency keys `room-pay-request-${group_id}` / `room-confirmation-${group_id}` for
      groups, unchanged for singles.

- [ ] **Step 1: Write the failing checks**
  - An expired 2-room website basket → `GET /api/bookings/baskets` has **one** row with 2 items
    and `items_subtotal` = the sum.
  - A later booking by the same guest closes it; a sibling does not.
  - `sweep()` with `basket_reminder_delay_mins` elapsed → one claim, and the stubbed
    `resend.sendBasketReminder` gets 2 items.
  - With `resend.sendRoomPayRequest` / `sendRoomConfirmation` stubbed:
    - a staff 2-room Saver basket → one pay-request call, with `stays.length === 2` and
      `amountDue` = the sum;
    - confirming it → one confirmation call.
  - A single-room booking → the stub receives `stay` (no `stays`) and the old key.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run** → Task 6 PASS; `check-room-baskets.js` and `check-rate-plans.js` still pass.
- [ ] **Step 5: Commit.** `git commit -m "Multi-room: one basket, one reminder, one email per multi-room booking"`

### Task 7: Swagger + MCP tools

**Files:**
- Modify: `src/docs/swagger.js`:
  - add `/api/availability/quote` (POST, request/response from Task 2);
  - `/api/bookings` POST gains `rooms` and the group response;
  - notes on `payment-intent`, `confirm-payment` and DELETE about group behaviour;
  - the rate plan 409.
- Modify: `mcp-server/tools.js`:
  - new tool `quote_room_basket`: `{ check_in, check_out, rooms: [{adults, children?, room_type_id?}], rate?: string|null }`
    → `apiRequest('POST', '/api/availability/quote', { body })`. Its description explains the
    cheapest defaults, `rate` omitted vs null, and `options`;
  - `create_booking` gains `rooms: z.array(z.object({ room_id, room_type_id, rate_plan_id, guests })).max(10).optional()`,
    with a description line saying it is booked as one basket, all-or-nothing, with one rate;
  - `cancel_booking` description notes that via API key a grouped booking cancels the whole
    basket.

- [ ] **Step 1: Run** `node -r dotenv/config scripts/check-mcp-coverage.js` → FAIL (`POST /api/availability/quote` uncovered).
- [ ] **Step 2: Implement** the tool and the docs above.
- [ ] **Step 3: Run** the coverage check → PASS. Run `node -e "require('./src/docs/swagger')"` →
  no error. Run the full `check-multi-room-bookings.js` → all PASS.
- [ ] **Step 4: Commit.** `git commit -m "Multi-room: Swagger + quote_room_basket MCP tool, create_booking rooms[]"`

### Task 8: Ship

- [ ] **Step 1:** Ask Robert for OK, then run
  `node scripts/run-migration.js src/db/migrate-2026-11-07-multi-room-bookings.sql`.
  It applies to local and live.
- [ ] **Step 2:** `git push` (Render auto-deploys).
- [ ] **Step 3:** Update the memory: a `project_multi_room_bookings_state.md` entry + a
  `MEMORY.md` line. Outstanding items: website basket UI, dashboard, channel multi-room.
