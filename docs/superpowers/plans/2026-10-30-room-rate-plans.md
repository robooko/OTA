# Room Rate Plans (Saver / Flex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate plans per room type (price adjustment, refundable + deadline, full/deposit/hold payment), card payment for room bookings through OTA, pay-link emails for staff bookings, policy-enforced guest cancellation, and expiry/capture jobs.

**Architecture:** Pure money/time/policy rules live in `src/lib/ratePlans.js` (no DB, no Stripe). Stripe- and lifecycle-touching code lives in `src/lib/roomPayments.js`, called from `src/controllers/bookings.js` and two background jobs. Emails are built in `src/lib/resend.js` and assembled per booking in `src/lib/roomBookingEmails.js`. Bookings without a plan take exactly today's code path.

**Tech Stack:** Node 22, Express 4, `pg`, Stripe SDK (per-property key via `marinaStripe.stripeFor`), Resend, Ably.

**Spec:** `docs/superpowers/specs/2026-10-30-room-rate-plans-design.md` — read it alongside this plan; § references below point into it.

## Global Constraints

- No plan on the booking ⇒ byte-for-byte today's behaviour: `confirmed`, no payment, no email, cancel as today.
- API-key rail = `req.auth_method === 'api_key'`; anything else reaching `authenticateOrApiKey` = staff.
- Statuses: `pending_payment`, `confirmed`, `checked_in`, `checked_out`, `cancelled`, `expired`. `pending_payment` and `expired` are system-set only.
- Pay windows: API key **30 min**, staff **24 h**. Hold only if the deadline is in the future and **≤ 6 days** from PI creation, else `full`.
- Deadline = check-in date 00:00 in `property.timezone` − `cancel_cutoff_hours`.
- Per-night price = `round2(night_rate × (1 + adjustment_pct/100))`, summed.
- Refusal copy (409): `This booking can no longer be cancelled online. Please contact the hotel.`
- Stripe idempotency keys: `room-booking-<booking id>` (PI create), `room-refund-<payment id>` (refunds).
- Stripe is always reached as `marinaStripe.stripeFor(key)` at call time (never destructured) so the check script can swap in `scripts/fake-stripe.js`. Same for `roomEmails.*` and `resend.*` calls: call through the module object so the check can spy.
- Local DB only for checks; migration applied with `psql "$DATABASE_URL" -f src/db/migrate-2026-10-30-room-rate-plans.sql`.
- Commit directly on `main` after each task (Robert's preference).

## Review Focus

1. **Double submit / retry of the card step** — calling `payment-intent` twice returns the same PI and never a second charge. Test: Task 7 `payment-intent is idempotent`.
2. **Guest paid but `confirm-payment` never arrived** (tab closed) — the expiry sweep confirms instead of expiring a paid booking. Test: Task 9 `expiry confirms a paid-but-unconfirmed booking`.
3. **Extras added after the PI exists** — PI amount follows the bill. Test: Task 7 `payment-intent updates amount after an extra is added`.
4. **Website tries to skip payment** (omits `rate_plan_id`, or sends `pay_at_hotel`) — refused. Test: Task 5 `api key cannot skip payment`.
5. **Guest cancels a pending booking whose card just succeeded** — refunded, not kept. Test: Task 8 `cancelling pending_payment refunds a just-succeeded PI`.

---

### Task 1: Pure rate-plan rules + check script

**Files:**
- Create: `src/lib/ratePlans.js`
- Create: `scripts/check-rate-plans.js`

**Interfaces:**
- Produces (all exported from `src/lib/ratePlans.js`):
  - `PAY_WINDOW_MINUTES = { api_key: 30, staff: 1440 }`
  - `HOLD_MAX_DAYS = 6`
  - `applyAdjustment(nightRate: number|string, adjustmentPct: number|string) -> number` (2dp)
  - `cancelDeadline(checkIn: 'YYYY-MM-DD', timezone: string, cutoffHours: number|null) -> Date|null` (null when cutoffHours is null)
  - `effectiveMode(terms, deadline: Date|null, now: Date) -> 'full'|'deposit'|'hold'`
  - `chargeAmountCents(mode, terms, chargesCents: int, balanceCents: int) -> int`
  - `guestCancelDecision(booking: {status, rate_plan_terms}, deadline: Date|null, now: Date) -> 'as_today'|'release'|'refund'|'refuse'`
  - `validatePlan(plan: object) -> string|null` (error message or null; validates a full merged plan)
  - `termsSnapshot(plan, { pay_at_hotel: boolean }) -> { name, adjustment_pct: number, refundable, cancel_cutoff_hours, payment_mode, deposit_kind, deposit_value: number|null, pay_at_hotel }`

- [ ] **Step 1: Write the check script with pure checks**

Copy the harness shape of `scripts/check-courses.js` (header comment, `delete process.env.RESEND_API_KEY / ABLY_API_KEY`, remote-DB refusal, `check(name, fn)`, exit code). Leave a marked `// ---- HTTP checks (Tasks 2+) ----` section that is empty for now. Pure checks:

```js
await check('applyAdjustment rounds per night', async () => {
  assert.equal(applyAdjustment('100.00', -12), 88);
  assert.equal(applyAdjustment(133.33, -12.5), 116.66);
  assert.equal(applyAdjustment(99.99, -10), 89.99);
  assert.equal(applyAdjustment(150, 0), 150);
});
await check('cancelDeadline: midnight local minus cutoff', async () => {
  assert.equal(cancelDeadline('2030-07-10', 'Europe/London', 48).toISOString(), '2030-07-07T23:00:00.000Z'); // BST
  assert.equal(cancelDeadline('2030-01-10', 'Europe/London', 24).toISOString(), '2030-01-09T00:00:00.000Z');
  assert.equal(cancelDeadline('2030-07-10', 'America/Tortola', 48).toISOString(), '2030-07-08T04:00:00.000Z');
  assert.equal(cancelDeadline('2030-07-10', 'Europe/London', null), null);
});
await check('effectiveMode: hold only within 6 days of the deadline', async () => {
  const hold = { payment_mode: 'hold' }; const now = new Date('2030-07-01T12:00:00Z');
  assert.equal(effectiveMode(hold, new Date('2030-07-05T00:00:00Z'), now), 'hold');
  assert.equal(effectiveMode(hold, new Date('2030-07-08T00:00:00Z'), now), 'full');  // > 6 days
  assert.equal(effectiveMode(hold, new Date('2030-06-30T00:00:00Z'), now), 'full');  // deadline passed
  assert.equal(effectiveMode({ payment_mode: 'deposit' }, null, now), 'deposit');
});
await check('chargeAmountCents by mode', async () => {
  assert.equal(chargeAmountCents('full', {}, 30000, 30000), 30000);
  assert.equal(chargeAmountCents('hold', {}, 30000, 25000), 25000);
  assert.equal(chargeAmountCents('deposit', { deposit_kind: 'percent', deposit_value: 20 }, 30050, 30050), 6010);
  assert.equal(chargeAmountCents('deposit', { deposit_kind: 'fixed', deposit_value: 50 }, 30000, 30000), 5000);
  assert.equal(chargeAmountCents('deposit', { deposit_kind: 'fixed', deposit_value: 500 }, 30000, 30000), 30000); // capped
});
await check('guestCancelDecision table', async () => {
  const now = new Date('2030-07-01T00:00:00Z'); const later = new Date('2030-07-05T00:00:00Z'); const earlier = new Date('2030-06-30T00:00:00Z');
  const flex = { refundable: true, cancel_cutoff_hours: 48 }; const saver = { refundable: false };
  assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: null }, null, now), 'as_today');
  assert.equal(guestCancelDecision({ status: 'pending_payment', rate_plan_terms: saver }, null, now), 'release');
  assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: flex }, later, now), 'refund');
  assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: flex }, earlier, now), 'refuse');
  assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: saver }, null, now), 'refuse');
  assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: { ...flex, pay_at_hotel: true } }, later, now), 'refund');
});
await check('validatePlan rules', async () => {
  const ok = { name: 'Flex', adjustment_pct: 0, refundable: true, cancel_cutoff_hours: 48, payment_mode: 'full', status: 'active' };
  assert.equal(validatePlan(ok), null);
  assert.match(validatePlan({ ...ok, payment_mode: 'hold', refundable: false, cancel_cutoff_hours: null }), /hold/);
  assert.match(validatePlan({ ...ok, cancel_cutoff_hours: null }), /cancel_cutoff_hours/);
  assert.match(validatePlan({ ...ok, refundable: false }), /cancel_cutoff_hours/); // must be null when non-refundable
  assert.match(validatePlan({ ...ok, payment_mode: 'deposit' }), /deposit/);
  assert.match(validatePlan({ ...ok, payment_mode: 'deposit', deposit_kind: 'percent', deposit_value: 120 }), /deposit_value/);
  assert.equal(validatePlan({ ...ok, payment_mode: 'deposit', deposit_kind: 'fixed', deposit_value: 50 }), null);
  assert.match(validatePlan({ ...ok, adjustment_pct: -101 }), /adjustment_pct/);
  assert.match(validatePlan({ ...ok, name: '' }), /name/);
  assert.match(validatePlan({ ...ok, status: 'deleted' }), /status/);
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node -r dotenv/config scripts/check-rate-plans.js`
Expected: crashes with `Cannot find module '../src/lib/ratePlans'`.

- [ ] **Step 3: Implement `src/lib/ratePlans.js`**

`applyAdjustment`: work in cents — `Math.round(toCents(rate) * (100 + Number(pct)) / 100) / 100` (reuse `toCents` from `src/lib/folio.js`).
`cancelDeadline`: local midnight via the Intl offset trick, then subtract hours:

```js
function zonedMidnightUtc(dateStr, tz) {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(guess).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}
```

`guestCancelDecision`: no terms → `as_today`; `pending_payment` → `release`; `refundable && now < deadline` → `refund`; else `refuse`. `validatePlan` error strings name the offending field. Validation limits: `name` 1–100 chars; `adjustment_pct` finite, −100…1000; `cancel_cutoff_hours` integer 0…8760; `deposit_value` > 0, ≤ 100 for percent, ≤ 99999999.99 for fixed; `sort_order` integer.

- [ ] **Step 4: Run — expect pass**

Run: `node -r dotenv/config scripts/check-rate-plans.js`
Expected: every line `ok`, `all passed`.

- [ ] **Step 5: Commit** — `git add src/lib/ratePlans.js scripts/check-rate-plans.js && git commit -m "Rate plans: pure pricing, deadline and policy rules"`

---

### Task 2: Migration, `expired` treated as ended, `room_booking_url` setting

**Files:**
- Create: `src/db/migrate-2026-10-30-room-rate-plans.sql`
- Modify: `src/db/schema.sql` (property ~line 37, after `room_type_rate` ~205, booking ~233–246, `review_candidate` ~656)
- Modify: `src/controllers/folio.js:88`, `src/controllers/guests.js:133-134`, `src/controllers/restaurantOrders.js:262`
- Modify: `src/controllers/property.js` (`REVIEW_REQUEST_FIELDS`, serializer ~657, `updateEmailBranding` ~758–816)
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Produces: table `rate_plan` (spec §1 DDL verbatim, plus CHECKs below); booking columns `rate_plan_id`, `rate_plan_terms JSONB`, `payment_due_at TIMESTAMPTZ`, `stripe_payment_intent_id VARCHAR(255)`; `property.room_booking_url TEXT`; branding API field `room_booking_url`; guest stats field `expired`.

- [ ] **Step 1: Write the migration**

Contents, in order:
1. `CREATE TABLE IF NOT EXISTS rate_plan (...)` exactly as spec §1, with CHECKs: `payment_mode IN ('full','deposit','hold')`; `status IN ('active','archived')`; `refundable = (cancel_cutoff_hours IS NOT NULL)`; `(payment_mode = 'deposit') = (deposit_kind IS NOT NULL AND deposit_value IS NOT NULL)`; `deposit_kind IS NULL OR deposit_kind IN ('percent','fixed')`; `NOT (payment_mode = 'hold' AND NOT refundable)`; `adjustment_pct >= -100`. Plus the index.
2. `ALTER TABLE booking ADD COLUMN IF NOT EXISTS` × 4 (spec §3) and `CREATE INDEX IF NOT EXISTS idx_booking_pending_due ON booking(payment_due_at) WHERE status = 'pending_payment'`.
3. `ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_no_overlap;` then re-add with `WHERE (status NOT IN ('cancelled','expired'))`.
4. `ALTER TABLE property ADD COLUMN IF NOT EXISTS room_booking_url TEXT;`
5. `CREATE OR REPLACE VIEW review_candidate` — copy the full current definition from `schema.sql`, changing only the rooms branch to `NOT IN ('cancelled', 'no_show', 'expired', 'pending_payment')`.

Mirror all five in `schema.sql` (the booking constraint inline, comment `-- may contain {id} (room booking id)` on `room_booking_url`). Apply to the local DB.

- [ ] **Step 2: Add failing HTTP/DB checks** (start the HTTP section: throwaway property with `api_key_enabled = true`, timezone `Europe/London`, currency `GBP`; a room type at `base_rate 100`, two active rooms, `room_availability` rows for 2030-07-01..2030-07-31; a guest; cleanup in `finally` deleting payment, booking_extra, booking, room_availability, rate_plan, room, room_type, guest, property for the fixture property). Staff calls go straight to controllers with `{ property_id: P, params, query, body }` (no `auth_method`), API-key calls through `app.listen(0)` with `X-Api-Key`.

```js
await check('expired booking frees the room for an overlapping booking', async () => {
  const a = await insertBooking({ room: R1, check_in: '2030-07-02', check_out: '2030-07-04', status: 'expired' });
  const b = await insertBooking({ room: R1, check_in: '2030-07-03', check_out: '2030-07-05', status: 'confirmed' }); // must not throw 23P01
  assert.ok(a && b);
});
await check('folio refuses payment on an expired booking', async () => {
  const r = await staff(folioCtrl.createFolioPaymentIntent, { params: { id: expiredId } });
  assert.equal(r.status, 409); assert.match(r.body.error, /expired/);
});
await check('guest stats count expired', async () => {
  const r = await staff(guestsCtrl.getGuestStats, { params: { id: G } });
  assert.equal(Number(r.body.expired), 1);
});
await check('room_booking_url round-trips through branding settings', async () => {
  assert.equal((await staff(propertyCtrl.updateEmailBranding, { body: { room_booking_url: 'not a url' } })).status, 400);
  const r = await staff(propertyCtrl.updateEmailBranding, { body: { room_booking_url: 'https://hotel.test/stay/{id}' } });
  assert.equal(r.body.room_booking_url, 'https://hotel.test/stay/{id}');
});
```

(Script helpers defined here and reused by every later task: `one(sql, params)`, `api(method, path, body)` → `{ status, body }` over HTTP with `X-Api-Key`, `staff(handler, req)` → `{ status, body }` calling a controller directly like `call` in `scripts/check-marina-http.js:673`, and `insertBooking` — a small SQL helper; use the real exported names for the guest-stats and branding handlers — look them up in `src/controllers/guests.js` / `property.js` exports. The folio check needs `stripe_secret_key` set on the fixture property to reach line 88.)

- [ ] **Step 3: Run — expect the folio, stats and branding checks to FAIL**

Run: `node -r dotenv/config scripts/check-rate-plans.js`

- [ ] **Step 4: Implement**
- `folio.js:88`: `if (['cancelled', 'expired'].includes(booking.status)) return res.status(409).json({ error: \`Booking is ${booking.status}\` });`
- `guests.js`: add `COUNT(*) FILTER (WHERE b.status = 'expired') AS expired`.
- `restaurantOrders.js:262`: `NOT IN ('cancelled', 'expired')`.
- `property.js`: add `room_booking_url` to `REVIEW_REQUEST_FIELDS`, the serializer, and `updateEmailBranding` (same trim/null/`validateCancelUrl` handling as `cancel_url`, its own SET clause).

- [ ] **Step 5: Run — expect pass.** Same command; all `ok`.

- [ ] **Step 6: Commit** — `git add src/db scripts/check-rate-plans.js src/controllers/{folio,guests,restaurantOrders,property}.js && git commit -m "Rate plans: schema, expired status, room_booking_url setting"`

---

### Task 3: Rate plan management endpoints

**Files:**
- Create: `src/controllers/ratePlans.js`
- Modify: `src/routes/roomTypes.js`
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Consumes: `validatePlan` (Task 1).
- Produces: `listRatePlans`, `createRatePlan`, `updateRatePlan` handlers; routes `GET /api/room-types/:id/rate-plans` (`authenticateOrApiKey`), `POST` and `PUT /:plan_id` (`authenticate`). Response rows are the `rate_plan` row as pg returns it.

- [ ] **Step 1: Failing checks**

```js
await check('staff create Saver and Flex; api key lists active only', async () => {
  const saver = await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Saver', adjustment_pct: -12, refundable: false, payment_mode: 'full', sort_order: 1 } });
  assert.equal(saver.status, 201);
  const flex = await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Flex', refundable: true, cancel_cutoff_hours: 48, payment_mode: 'hold', sort_order: 2 } });
  assert.equal(flex.status, 201);
  const old = await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Old', refundable: false, payment_mode: 'full' } });
  await staff(rp.updateRatePlan, { params: { id: RT, plan_id: old.body.id }, body: { status: 'archived' } });
  const listed = await api('GET', `/api/room-types/${RT}/rate-plans`);
  assert.deepEqual(listed.body.map((p) => p.name), ['Saver', 'Flex']);
});
await check('invalid plans are 400; other property room type is 404', async () => {
  assert.equal((await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Bad', refundable: false, payment_mode: 'hold' } })).status, 400);
  assert.equal((await staff(rp.updateRatePlan, { params: { id: RT, plan_id: SAVER }, body: { payment_mode: 'deposit' } })).status, 400); // merged plan lacks deposit fields
  assert.equal((await staff(rp.createRatePlan, { params: { id: OTHER_RT }, body: { name: 'X', refundable: false, payment_mode: 'full' } })).status, 404);
});
```

(`OTHER_RT` = a room type on a second throwaway property.)

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement.** Create defaults: `adjustment_pct 0`, `sort_order 0`, `status 'active'`, nullable fields null. Update = load row (404 if not this property + room type), shallow-merge body over it, `validatePlan(merged)`, write all columns. List orders by `sort_order, name`; API key adds `AND status = 'active'`.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "Rate plans: management endpoints"`

---

### Task 4: Room booking emails

**Files:**
- Modify: `src/lib/resend.js` (add + export two functions)
- Create: `src/lib/roomBookingEmails.js`
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Produces:
  - `resend.sendRoomPayRequest({ to, name, propertyName, branding, stay, planName, amountDue, currency, payBy, payUrl, idempotencyKey }) -> Promise<string>`
  - `resend.sendRoomConfirmation({ to, name, propertyName, branding, stay, planName, amountPaid, balanceDue, currency, cancelLine, manageUrl, idempotencyKey }) -> Promise<string>` (`manageUrl` may be null → no link)
  - `stay` = `{ room_type_name, check_in, check_out, nights }`
  - `roomBookingEmails.cancelTermsLine(terms, deadline: Date|null, timezone) -> string`
  - `roomBookingEmails.bookingUrl(template: string|null, bookingId) -> string|null` (`{id}` replaced; null template → null)
  - `roomBookingEmails.sendPayRequest(bookingId) -> Promise<void>` and `sendConfirmation(bookingId) -> Promise<void>`: load booking + guest + room type + property (`name, email_branding, room_booking_url, timezone, currency`) + folio, build args, call `resend.*`; log and swallow errors (never throw). Idempotency keys `room-pay-request-<id>`, `room-confirmation-<id>`.

- [ ] **Step 1: Failing checks**

```js
await check('cancelTermsLine wording', async () => {
  assert.equal(cancelTermsLine({ refundable: false }, null, 'Europe/London'), 'Non-refundable.');
  assert.match(cancelTermsLine({ refundable: true }, new Date('2030-07-07T23:00:00Z'), 'Europe/London'), /^Free cancellation until .*8 Jul.* 2030/);
});
await check('bookingUrl fills {id}', async () => {
  assert.equal(bookingUrl('https://h.test/stay/{id}', 'abc'), 'https://h.test/stay/abc');
  assert.equal(bookingUrl(null, 'abc'), null);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Follow `sendReviewRequest`'s skeleton (`brandingHeaderHtml`, `escapeHtml`, same `from`). Subjects: `Complete your booking at ${propertyName}` and `Your stay at ${propertyName} is confirmed`. Pay request body: stay line, plan, amount due now, `Please pay by ${payBy}`, CTA button "Pay now" → `payUrl`. Confirmation: stay line, plan, paid, balance due at the hotel (omit when 0), `cancelLine`, "Manage booking" button when `manageUrl`. `payBy` and the deadline are formatted with `Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' })`.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "Rate plans: pay-request and confirmation emails"`

---

### Task 5: Creating bookings with a plan

**Files:**
- Modify: `src/controllers/bookings.js` (`createBooking` 125–313, `updateBooking` 315–363)
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Consumes: `applyAdjustment`, `termsSnapshot`, `PAY_WINDOW_MINUTES` (Task 1); `roomEmails.sendPayRequest/sendConfirmation` (Task 4; `const roomEmails = require('../lib/roomBookingEmails')`, called through the object).
- Produces: booking rows with `rate_plan_id`, `rate_plan_terms`, `payment_due_at`, `status` as spec §5; `POST /api/bookings` body fields `rate_plan_id`, `pay_at_hotel`.

- [ ] **Step 1: Failing checks** (spy `roomEmails.sendPayRequest` / `sendConfirmation` by swapping the module functions for recorders)

```js
await check('no plan on a room type without plans: exactly today', async () => {
  const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: PLAIN_RT, check_in: '2030-07-02', check_out: '2030-07-04' });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'confirmed'); assert.equal(r.body.rate_plan_id, null);
  assert.equal(r.body.total_price, '200.00');
});
await check('api key cannot skip payment', async () => {
  assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, check_in: '2030-07-06', check_out: '2030-07-07' })).status, 400);
  assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, pay_at_hotel: true, check_in: '2030-07-06', check_out: '2030-07-07' })).status, 403);
});
await check('api key Saver booking: pending_payment, 30 min, adjusted price, snapshot', async () => {
  const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, check_in: '2030-07-06', check_out: '2030-07-08' });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'pending_payment'); assert.equal(r.body.total_price, '176.00');
  const row = await one('SELECT payment_due_at - now() AS left, rate_plan_terms FROM booking WHERE id = $1', [r.body.id]);
  assert.ok(row.left.minutes >= 29); assert.equal(row.rate_plan_terms.name, 'Saver'); assert.equal(row.rate_plan_terms.pay_at_hotel, false);
});
await check('plan from another room type is 400', async () => { /* rate_plan_id of OTHER plan on PLAIN_RT -> 400 */ });
await check('staff plan booking: 24 h and a pay-request email; pay_at_hotel confirms with a confirmation email', async () => {
  const pending = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: FLEX, check_in: '2030-07-10', check_out: '2030-07-11' } });
  assert.equal(pending.body.status, 'pending_payment'); assert.equal(sent.payRequest.at(-1), pending.body.id);
  const pah = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: FLEX, pay_at_hotel: true, check_in: '2030-07-12', check_out: '2030-07-13' } });
  assert.equal(pah.body.status, 'confirmed'); assert.equal(sent.confirmation.at(-1), pah.body.id);
});
await check('preconditions: no Stripe keys / no room_booking_url are 409', async () => { /* clear keys -> api plan booking 409 /Online payment/; restore keys, clear room_booking_url -> staff plan booking 409 /room booking page/ */ });
await check('PUT cannot set system statuses', async () => {
  assert.equal((await staff(bookings.updateBooking, { params: { id: SOME }, body: { status: 'expired' } })).status, 400);
  assert.equal((await staff(bookings.updateBooking, { params: { id: SOME }, body: { status: 'pending_payment' } })).status, 400);
});
```

Fixture for this task onward: property has `stripe_secret_key 'sk_test_check'`, `stripe_publishable_key 'pk_test_check'`, `room_booking_url 'https://hotel.test/stay/{id}'`; `PLAIN_RT` is a second room type (base 100, own rooms + availability) with no plans.

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement in `createBooking`** — validation order and messages per spec §5 (`pay_at_hotel` must be boolean if present → 400; with API key → 403 `pay_at_hotel is staff-only`; without `rate_plan_id` → 400). After the room type is resolved: load the plan (`active`, this property, `room_type_id = rateTypeId`) → 400 `Rate plan not found for this room type`; or on the API-key rail, any active plan for the type → 400 `rate_plan_id is required for this room type`. Load the property row (`stripe_secret_key, stripe_publishable_key, room_booking_url`) once for the 409 preconditions. Price each night through `applyAdjustment` when there is a plan. If the plan needs a card and the total is 0, treat as pay-at-hotel. INSERT gains `status, rate_plan_id, rate_plan_terms, payment_due_at` (`now() + make_interval(mins => $n)`). After COMMIT, fire-and-forget: confirmed with a plan → `roomEmails.sendConfirmation`; staff `pending_payment` → `roomEmails.sendPayRequest`.
- [ ] **Step 4: Implement in `updateBooking`** — reject `status` `pending_payment`/`expired` with 400 `status <x> is set by the system`. (Confirm-by-hand comes in Task 7.)
- [ ] **Step 5: Run — expect pass.**
- [ ] **Step 6: Commit** — `git commit -m "Rate plans: create bookings on a plan"`

---

### Task 6: Search returns plans

**Files:**
- Modify: `src/controllers/availability.js` (`searchAvailability` 64–114)
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Consumes: `applyAdjustment`, `cancelDeadline`, `effectiveMode` (Task 1).
- Produces: each search row gains `plans: [{ id, name, from_rate: number, refundable, cancel_deadline: ISO|null, payment_mode, deposit: {kind, value: number}|null }]`.

- [ ] **Step 1: Failing check**

```js
await check('search lists plans per room type; plain type has none', async () => {
  await pool.query('REFRESH MATERIALIZED VIEW room_type_availability');
  const r = await api('GET', '/api/availability/search?check_in=2030-07-20&check_out=2030-07-22&guests=1');
  const rt = r.body.find((x) => x.room_type_id === RT); const plain = r.body.find((x) => x.room_type_id === PLAIN_RT);
  const byName = Object.fromEntries(rt.plans.map((p) => [p.name, p]));
  assert.deepEqual([byName.Saver.from_rate, byName.Saver.refundable], [88, false]);
  assert.deepEqual([byName.Flex.from_rate, byName.Flex.refundable], [100, true]);
  assert.ok(rt.plans.findIndex((p) => p.name === 'Saver') < rt.plans.findIndex((p) => p.name === 'Flex')); // sort_order
  assert.equal(byName.Flex.cancel_deadline, '2030-07-17T23:00:00.000Z');
  assert.equal(byName.Flex.payment_mode, 'full'); // hold, but deadline > 6 days away
  assert.deepEqual(plain.plans, []);
  assert.ok('from_rate' in rt && 'min_available' in rt); // existing fields untouched
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — one extra query for active plans of the returned room types (`ORDER BY sort_order, name`), plus the property `timezone`; attach per row. Existing SELECT and ordering untouched.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "Rate plans: search returns plans"`

---

### Task 7: Card step — payment-intent, confirm-payment, confirm by hand

**Files:**
- Create: `src/lib/roomPayments.js`
- Modify: `src/controllers/bookings.js` (two new handlers; `updateBooking` pending→confirmed branch)
- Modify: `src/routes/bookings.js`
- Modify: `scripts/fake-stripe.js` (add `paymentIntents.update(id, params)` that merges params; `amount_received` set to `amount` when a test flips status to `succeeded` — tests do this themselves)
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Consumes: `effectiveMode`, `chargeAmountCents`, `cancelDeadline` (Task 1); `computeFolio`, `toCents`, `fromCents` (`src/lib/folio.js`); `roomEmails.sendConfirmation` (Task 4); `publishBookingStatusChanged` (`src/lib/ably.js`); `fetchJoinedBooking` (export it from `bookings.js` or move to `roomPayments.js` — implementer's choice, one copy).
- Produces (`src/lib/roomPayments.js`):
  - `paymentIntentFor(bookingId, propertyId) -> { status: int, body }` — body `{ client_secret, publishable_key, amount: 'NN.NN', mode }`, or the confirmed booking when the balance is 0.
  - `confirmPaid(bookingId, propertyId) -> { status: int, body }`
  - `confirmPaidLocked(client, booking, pi|null) -> void` (inside a caller's transaction with the booking row locked: status → confirmed, `payment_due_at` null, insert the completed payment row if `pi?.status === 'succeeded'`; `null` = nothing to charge)
  - `settleByHand(bookingId, propertyId) -> { status: int, body }`
  - `releaseAvailability(client, booking) -> void` and `refreshAvailabilityView() -> Promise<void>` (lifted from `cancelBooking` so Tasks 8–9 share them)
- Routes: `POST /api/bookings/:id/payment-intent` and `POST /api/bookings/:id/confirm-payment`, both `authenticateOrApiKey`.

- [ ] **Step 1: Failing checks** (swap `marinaStripe.stripeFor = () => fakeStripe` at the top of the script)

```js
await check('payment-intent: Saver full charge, idempotent', async () => {
  const b = await apiBooking(SAVER, '2030-07-14', '2030-07-16');           // 176.00
  const p1 = await api('POST', `/api/bookings/${b.id}/payment-intent`);
  const p2 = await api('POST', `/api/bookings/${b.id}/payment-intent`);
  assert.equal(p1.body.amount, '176.00'); assert.equal(p1.body.mode, 'full');
  assert.equal(p1.body.client_secret, p2.body.client_secret);
  assert.equal(fakeStripe.store.get(piOf(b.id)).capture_method, 'automatic');
});
await check('payment-intent updates amount after an extra is added', async () => {
  const b = await apiBooking(SAVER, '2030-07-17', '2030-07-18');           // 88.00
  await api('POST', `/api/bookings/${b.id}/payment-intent`);
  await api('POST', `/api/extras/booking/${b.id}`, { extra_id: EXTRA_25 }); // 25.00 extra fixture
  const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
  assert.equal(p.body.amount, '113.00'); assert.equal(fakeStripe.store.get(piOf(b.id)).amount, 11300);
});
await check('deposit plan charges the deposit; confirm records a completed payment', async () => {
  const b = await apiBooking(DEPOSIT20, '2030-07-24', '2030-07-26');       // 200.00, 20%
  const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
  assert.equal(p.body.amount, '40.00');
  Object.assign(fakeStripe.store.get(piOf(b.id)), { status: 'succeeded', amount_received: 4000 });
  const c = await api('POST', `/api/bookings/${b.id}/confirm-payment`);
  assert.equal(c.status, 200); assert.equal(c.body.status, 'confirmed');
  assert.equal((await one("SELECT amount, status FROM payment WHERE booking_id = $1", [b.id])).amount, '40.00');
  assert.equal((await api('POST', `/api/bookings/${b.id}/confirm-payment`)).status, 200); // idempotent, still one payment row
  assert.equal(Number((await one('SELECT count(*) FROM payment WHERE booking_id = $1', [b.id])).count), 1);
});
await check('hold within 6 days uses manual capture and no payment row', async () => {
  const b = await apiBookingNear(FLEX_HOLD /* cutoff 48h */, 4 /* days from today */);
  const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
  assert.equal(p.body.mode, 'hold'); assert.equal(fakeStripe.store.get(piOf(b.id)).capture_method, 'manual');
  fakeStripe.store.get(piOf(b.id)).status = 'requires_capture';
  assert.equal((await api('POST', `/api/bookings/${b.id}/confirm-payment`)).body.status, 'confirmed');
  assert.equal(Number((await one('SELECT count(*) FROM payment WHERE booking_id = $1', [b.id])).count), 0);
});
await check('confirm-payment before the card succeeds is 409', async () => { /* PI requires_payment_method -> 409, booking still pending_payment */ });
await check('staff confirm by hand cancels the PI and marks pay_at_hotel', async () => {
  const b = await apiBooking(SAVER, '2030-07-27', '2030-07-28');
  await api('POST', `/api/bookings/${b.id}/payment-intent`);
  const r = await staff(bookings.updateBooking, { params: { id: b.id }, body: { status: 'confirmed' } });
  assert.equal(r.body.status, 'confirmed'); assert.equal(fakeStripe.store.get(piOf(b.id)).status, 'canceled');
  assert.equal((await one('SELECT rate_plan_terms FROM booking WHERE id = $1', [b.id])).rate_plan_terms.pay_at_hotel, true);
});
```

Helpers added here and reused by Tasks 8–9: `piOf(id)` reads `booking.stripe_payment_intent_id`; `apiBooking(plan, in, out)` = API-key create returning the body; `apiBookingNear(plan, days)` books one night `days` from today; `paidBooking(plan, in, out)` = `apiBooking` → payment-intent → flip PI to `succeeded` with `amount_received` → confirm-payment (`paidBookingNear` likewise). `FLEX_HOLD` is Task 3's Flex (hold, 48 h). Add fixtures: `DEPOSIT20` (refundable, 48 h, deposit percent 20), `FLEX_FULL` (refundable, 48 h, full), a 25.00 `extra` (`EXTRA_25`), and extend the fixture `room_availability` rows to cover today … today + 10 days for both RT rooms.

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `roomPayments.js`** per spec §6–§7. `paymentIntentFor`: 404 unknown; 409 `Booking is not awaiting payment` unless `pending_payment`; 409 when Stripe keys are missing; amount from `computeFolio` (`charges_total`, `balance`); balance 0 → `confirmPaidLocked` without a PI; mode = `terms.mode_used ?? effectiveMode(...)`, persisted into `rate_plan_terms.mode_used` (`jsonb_set`) along with `stripe_payment_intent_id`; existing PI → `retrieve`, `update({ amount })` if different and still `requires_payment_method`/`requires_confirmation`; new PI → `create({ amount, currency: lower(property currency), capture_method, payment_method_types: ['card'], metadata: { property_id, booking_id } }, { idempotencyKey: 'room-booking-<id>' })`; Stripe throw → 502 `{ error: 'Card payment could not be set up; please try again', details }`. `confirmPaid`: lock with `SELECT ... FOR UPDATE`; already `confirmed` → 200 joined booking; other status → 409; no PI → 409 `No payment started`; PI `succeeded`/`requires_capture` → `confirmPaidLocked`, COMMIT, publish, `roomEmails.sendConfirmation`; else 409 `{ error: 'Payment not completed', details: pi.status }`. `settleByHand`: lock; if a PI exists, retrieve — paid/held → same as `confirmPaid`; otherwise cancel it (ignore an already-canceled error); set confirmed, clear `payment_due_at`, `rate_plan_terms.pay_at_hotel = true`; publish; confirmation email.
- [ ] **Step 4: Wire** the two handlers in `bookings.js` (thin: call through, `res.status(r.status).json(r.body)`) and routes; in `updateBooking`, when the current status is `pending_payment` and `status === 'confirmed'`, return `roomPayments.settleByHand(...)` instead of the generic update.
- [ ] **Step 5: Run — expect pass.**
- [ ] **Step 6: Commit** — `git commit -m "Rate plans: card payment for room bookings"`

---

### Task 8: Cancellation policy

**Files:**
- Modify: `src/controllers/bookings.js` (`cancelBooking` 365–409)
- Modify: `src/lib/roomPayments.js`
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Consumes: `guestCancelDecision`, `cancelDeadline` (Task 1); `releaseAvailability`, `refreshAvailabilityView` (Task 7).
- Produces: `roomPayments.stripeForCancel(booking, { refund: boolean }) -> Promise<{ refundedPaymentIds: uuid[] }>` — cancels an open/uncaptured PI; if `refund`, refunds every `completed` card payment with a `stripe_payment_intent_id` (idempotency `room-refund-<payment id>`); on a `pending_payment` booking whose PI already `succeeded`, refunds that PI. Throws on Stripe failure.

- [ ] **Step 1: Failing checks**

```js
await check('guest cancels Flex before the deadline: refunded', async () => {
  const b = await paidBooking(FLEX_FULL, '2030-07-29', '2030-07-30');    // confirmed, completed card payment
  const r = await api('DELETE', `/api/bookings/${b.id}`);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'cancelled');
  assert.equal(fakeStripe.store.get(piOf(b.id)).refunded, true);
  assert.equal((await one('SELECT status FROM payment WHERE booking_id = $1', [b.id])).status, 'refunded');
});
await check('guest cannot cancel Saver or late Flex online', async () => {
  const s = await paidBooking(SAVER, '2030-07-30', '2030-07-31');
  const r = await api('DELETE', `/api/bookings/${s.id}`);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'This booking can no longer be cancelled online. Please contact the hotel.');
  assert.equal(r.body.details, 'non-refundable');
  /* late Flex: paidBookingNear(FLEX_FULL, 1 day) -> 409, details mentions the deadline */
});
await check('staff cancel never refunds', async () => {
  const s = await paidBooking(SAVER, '2030-07-25', '2030-07-26');
  const r = await staff(bookings.cancelBooking, { params: { id: s.id } });
  assert.equal(r.body.status, 'cancelled'); assert.equal(fakeStripe.store.get(piOf(s.id)).refunded, undefined);
});
await check('cancelling pending_payment refunds a just-succeeded PI', async () => {
  const b = await apiBooking(SAVER, '2030-07-21', '2030-07-22');
  await api('POST', `/api/bookings/${b.id}/payment-intent`);
  fakeStripe.store.get(piOf(b.id)).status = 'succeeded';
  assert.equal((await api('DELETE', `/api/bookings/${b.id}`)).status, 200);
  assert.equal(fakeStripe.store.get(piOf(b.id)).refunded, true);
});
await check('Stripe failure leaves the booking untouched', async () => { /* make fake refunds.create throw once -> 502, booking still confirmed */ });
await check('no-plan booking cancels exactly as today', async () => { /* PLAIN_RT booking via api key -> 200 cancelled, availability restored */ });
```

Add a `failNextRefund` flag to `fake-stripe.js` for the 502 check.

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `cancelBooking`: inside the transaction `SELECT b.*, p.timezone FROM booking b JOIN property p ... FOR UPDATE`; missing or already `cancelled`/`expired` → 404 as today. No terms → today's path. Decision = API key ? `guestCancelDecision` : staff. `refuse` → ROLLBACK, 409 with `details` = `'non-refundable'` or `Free cancellation ended <deadline ISO>`. Otherwise `stripeForCancel` (refund = decision `refund`; staff → `false`) — on throw ROLLBACK, 502 `{ error: 'Payment provider error; booking not cancelled', details }`. Then status `cancelled`, mark `refundedPaymentIds` `refunded`, `releaseAvailability`, COMMIT, refresh, publish (as today).
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "Rate plans: cancellation policy"`

---

### Task 9: Expiry and hold-capture jobs

**Files:**
- Modify: `src/lib/roomPayments.js`
- Modify: `src/server.js`
- Modify: `scripts/check-rate-plans.js`

**Interfaces:**
- Consumes: `confirmPaidLocked`, `releaseAvailability`, `refreshAvailabilityView` (Task 7); `cancelDeadline` (Task 1).
- Produces: `expireOnce() -> Promise<{ expired: int, confirmed: int }>`, `captureHoldsOnce() -> Promise<{ captured: int, failed: int }>`, `startRoomPaymentJobs() -> void` (both every 60 s, `.unref()`, errors logged per row like `src/lib/marinaLifecycle.js` `sweepOnce`).

- [ ] **Step 1: Failing checks**

```js
await check('expiry: unpaid booking expires and frees the room', async () => {
  const b = await apiBooking(SAVER, '2030-07-03', '2030-07-04');
  await pool.query("UPDATE booking SET payment_due_at = now() - interval '1 minute' WHERE id = $1", [b.id]);
  await roomPayments.expireOnce();
  assert.equal((await one('SELECT status FROM booking WHERE id = $1', [b.id])).status, 'expired');
  assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_id: b.room_id, rate_plan_id: SAVER, check_in: '2030-07-03', check_out: '2030-07-04' })).status, 201);
});
await check('expiry confirms a paid-but-unconfirmed booking', async () => {
  const b = await apiBooking(SAVER, '2030-07-05', '2030-07-06');
  await api('POST', `/api/bookings/${b.id}/payment-intent`);
  Object.assign(fakeStripe.store.get(piOf(b.id)), { status: 'succeeded', amount_received: 8800 });
  await pool.query("UPDATE booking SET payment_due_at = now() - interval '1 minute' WHERE id = $1", [b.id]);
  await roomPayments.expireOnce();
  assert.equal((await one('SELECT status FROM booking WHERE id = $1', [b.id])).status, 'confirmed');
});
await check('hold captured once the deadline passes; failure marked, not retried', async () => {
  const pastDeadline = (id) => pool.query("UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{cancel_cutoff_hours}', '500') WHERE id = $1", [id]); // snapshot is what's enforced
  const b = await heldBooking(FLEX_HOLD);                      // confirmed, PI requires_capture
  await pastDeadline(b.id);
  await roomPayments.captureHoldsOnce();
  assert.equal(fakeStripe.store.get(piOf(b.id)).status, 'succeeded');
  assert.equal((await one("SELECT count(*) FROM payment WHERE booking_id = $1 AND status = 'completed'", [b.id])).count, '1');
  const c = await heldBooking(FLEX_HOLD); await pastDeadline(c.id); fakeStripe.failNextCapture = true;
  assert.deepEqual(await roomPayments.captureHoldsOnce(), { captured: 0, failed: 1 });
  assert.deepEqual(await roomPayments.captureHoldsOnce(), { captured: 0, failed: 0 }); // not retried
});
```

(`heldBooking` = `apiBookingNear(FLEX_HOLD, 4)` → payment-intent → flip to `requires_capture` → confirm-payment.)

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** `expireOnce`: `pending_payment AND payment_due_at < now()`, `LIMIT 200`, each row in its own transaction with `FOR UPDATE` and a status re-check; PI paid/held → `confirmPaidLocked` (+ publish + confirmation email); else cancel the PI (ignore already-canceled), `status = 'expired'`, `payment_due_at = NULL`, `releaseAvailability`; one `refreshAvailabilityView` after the loop if anything expired. `captureHoldsOnce`: `confirmed` bookings with `rate_plan_terms->>'mode_used' = 'hold'`, a PI, `NOT rate_plan_terms ? 'capture_failed'`, and no completed payment for that PI; compute the deadline in JS (join property timezone); due → `capture` → insert completed payment (`amount_received`); on throw → `jsonb_set(rate_plan_terms, '{capture_failed}', to_jsonb(now()))` and log. Call `startRoomPaymentJobs()` in `src/server.js` next to `startMarinaHoldExpiryJob()`.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** — `git commit -m "Rate plans: expiry and hold-capture jobs"`

---

### Task 10: API docs

**Files:**
- Modify: `src/docs/swagger.js`

- [ ] **Step 1:** Document: rate-plan routes and schema (Task 3); `POST /api/bookings` `rate_plan_id`/`pay_at_hotel` and the 400/403/409s; booking status enum (all six) on GET/PUT and the PUT 400 for system statuses; `payment-intent` and `confirm-payment` (request/response/409/502); DELETE 409 refusal and 502; search `plans`; branding `room_booking_url`; guest stats `expired`.
- [ ] **Step 2: Verify** — `node -e "require('./src/docs/swagger.js')"` exits 0, and `node -r dotenv/config scripts/check-rate-plans.js` still prints `all passed`.
- [ ] **Step 3: Commit** — `git commit -m "Rate plans: API docs"`
