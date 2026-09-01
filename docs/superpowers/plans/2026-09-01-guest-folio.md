# Guest Folio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One bill per room booking — computed line items (room, extras, room service, manual adjustments), payments, a live balance, Stripe Tap to Pay settlement, and a soft check-out gate.

**Architecture:** The folio is never stored — `src/lib/folio.js` aggregates it from `booking`, `booking_extra`, `restaurant_order`, `folio_adjustment`, and `payment` on every read. A new `src/controllers/folio.js` exposes it under `/api/bookings/:id/folio`; the Tap to Pay flow mirrors `src/controllers/spaPayments.js` but keeps its pending state as a `payment` ledger row instead of a status column.

**Tech Stack:** Node.js/Express, `pg` (raw SQL, no ORM), `stripe` (already a dependency, per-property secret key), swagger-jsdoc-style manual spec in `src/docs/swagger.js`.

**Spec:** `docs/superpowers/specs/2026-09-01-guest-folio-design.md`

## Global Constraints

- No test framework exists in this repo — verification is by node scripts against the dev database and app-boot checks, per the spec's Verification section. Full-endpoint curl needs a Clerk session token (auth is Clerk-only); controller-level node checks stub `req.property_id` instead.
- All money math in integer cents server-side; NUMERIC values serialize as 2-dp strings.
- Errors: `{ error, details? }`; 400 validation, 404 not-found (cross-property ids read as 404), 409 conflict, 502 Stripe (`err.type?.startsWith('Stripe')`).
- Migrations are idempotent (`IF NOT EXISTS`) and mirrored into `src/db/schema.sql`.
- Commit style: short imperative subject, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Direct commits on `main`.
- The word is **folio**, never *billing* — `/api/billing` belongs to platform token billing.
- `DATABASE_URL` comes from `.env`; run SQL with `psql "$DATABASE_URL"` (or `node -e` with `pg` if psql is unavailable).

---

### Task 1: Migrations — `folio_adjustment` table and `payment.stripe_payment_intent_id`

**Files:**
- Create: `src/db/migrate-2026-09-01-folio-adjustment.sql`
- Create: `src/db/migrate-2026-09-01-payment-stripe-intent.sql`
- Modify: `src/db/schema.sql` (payment table block ~line 153–162; add folio_adjustment after the payment indexes ~line 170)

**Interfaces:**
- Produces: table `folio_adjustment(id UUID PK, property_id UUID NOT NULL FK property, booking_id UUID NOT NULL FK booking, description VARCHAR(200) NOT NULL, amount NUMERIC(10,2) NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`; column `payment.stripe_payment_intent_id VARCHAR(255)`. Tasks 2–5 read/write both.

- [ ] **Step 1: Write `src/db/migrate-2026-09-01-folio-adjustment.sql`**

```sql
-- One-time migration: folio_adjustment, manual guest-folio lines
-- (positive = charge e.g. minibar/damage, negative = credit/comp).
-- See docs/superpowers/specs/2026-09-01-guest-folio-design.md.
-- amount = 0 is rejected at the API layer, not by constraint.
-- Idempotent-safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS folio_adjustment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES booking(id),
  description VARCHAR(200)  NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folio_adjustment_booking ON folio_adjustment(booking_id);
```

- [ ] **Step 2: Write `src/db/migrate-2026-09-01-payment-stripe-intent.sql`**

```sql
-- One-time migration: Stripe payment-intent id on the payment ledger.
-- The folio Tap to Pay flow (docs/superpowers/specs/2026-09-01-guest-folio-design.md)
-- keeps its pending state as a payment row (status 'pending', method 'card')
-- carrying the intent id -- unlike spa/table-sessions, which grew a
-- parallel payment_status column.
--
-- No backfill: every existing row is a manual payment; NULL is correct.
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);
```

- [ ] **Step 3: Mirror into `src/db/schema.sql`**

In the `payment` CREATE TABLE block, add after the `status` line:

```sql
  stripe_payment_intent_id VARCHAR(255),
```

(keep `paid_at` last). After the `idx_payment_property` index line, add:

```sql
-- Folio adjustments (manual guest-bill lines; positive = charge, negative = credit)
CREATE TABLE IF NOT EXISTS folio_adjustment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES booking(id),
  description VARCHAR(200)  NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folio_adjustment_booking ON folio_adjustment(booking_id);
```

- [ ] **Step 4: Apply both migrations twice (idempotency check)**

```bash
set -a; source .env; set +a
psql "$DATABASE_URL" -f src/db/migrate-2026-09-01-folio-adjustment.sql
psql "$DATABASE_URL" -f src/db/migrate-2026-09-01-folio-adjustment.sql
psql "$DATABASE_URL" -f src/db/migrate-2026-09-01-payment-stripe-intent.sql
psql "$DATABASE_URL" -f src/db/migrate-2026-09-01-payment-stripe-intent.sql
psql "$DATABASE_URL" -c "\d folio_adjustment" -c "\d payment"
```

Expected: no errors on the second runs; `folio_adjustment` exists with the six columns; `payment` shows `stripe_payment_intent_id`.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate-2026-09-01-folio-adjustment.sql src/db/migrate-2026-09-01-payment-stripe-intent.sql src/db/schema.sql
git commit -m "Add folio_adjustment table and payment.stripe_payment_intent_id"
```

---

### Task 2: Folio computation — `src/lib/folio.js`

**Files:**
- Create: `src/lib/folio.js`

**Interfaces:**
- Consumes: Task 1's `folio_adjustment` table.
- Produces: `computeFolio(bookingId, propertyId) -> Promise<Folio|null>` (null = booking not in this property), `toCents(numericString) -> integer`, `fromCents(integer) -> '0.00' string`. Folio shape: `{ booking_id, currency, items: [{type, description, amount, source_id?, created_at?}], charges_total, payments: [payment rows], payments_total, balance }`. Tasks 3, 4, 5 and 6 all consume these exact names.

- [ ] **Step 1: Write `src/lib/folio.js`**

```js
const pool = require('../db');

// NUMERIC(10,2) string -> integer minor units; same conversion as
// treatmentPriceCents (spaPayments.js) and sessionTotalCents.
function toCents(value) {
  return Math.round(parseFloat(value) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// The guest folio, computed live -- never stored. Single source of truth
// for both GET /api/bookings/:id/folio and the check-out gate. Returns
// null when the booking doesn't exist in this property (callers 404).
async function computeFolio(bookingId, propertyId) {
  const bookingRes = await pool.query(
    `SELECT b.id, b.total_price, r.room_number, p.currency,
            (b.check_out - b.check_in) AS nights
     FROM booking b
     JOIN room r     ON r.id = b.room_id
     JOIN property p ON p.id = b.property_id
     WHERE b.id = $1 AND b.property_id = $2`,
    [bookingId, propertyId]
  );
  if (!bookingRes.rows.length) return null;
  const booking = bookingRes.rows[0];

  const [extrasRes, ordersRes, adjustmentsRes, paymentsRes] = await Promise.all([
    pool.query(
      `SELECT be.id, be.quantity, be.unit_price, e.name
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY be.created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT o.id, o.total_price, o.created_at, r.name AS restaurant_name
       FROM restaurant_order o
       JOIN restaurant r ON r.id = o.restaurant_id
       WHERE o.booking_id = $1 AND o.status <> 'cancelled'
       ORDER BY o.created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT id, description, amount, created_at
       FROM folio_adjustment
       WHERE booking_id = $1
       ORDER BY created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT * FROM payment
       WHERE booking_id = $1
       ORDER BY paid_at DESC NULLS LAST, id`,
      [bookingId]
    ),
  ]);

  const items = [
    {
      type: 'room',
      description: `Room ${booking.room_number} · ${booking.nights} night${booking.nights === 1 ? '' : 's'}`,
      amount: booking.total_price,
    },
    ...extrasRes.rows.map((e) => ({
      type: 'extra',
      source_id: e.id,
      description: e.quantity > 1 ? `${e.name} × ${e.quantity}` : e.name,
      amount: fromCents(toCents(e.unit_price) * e.quantity),
    })),
    ...ordersRes.rows.map((o) => ({
      type: 'room_service',
      source_id: o.id,
      description: `Room service · ${o.restaurant_name}`,
      amount: o.total_price,
      created_at: o.created_at,
    })),
    ...adjustmentsRes.rows.map((a) => ({
      type: 'adjustment',
      source_id: a.id,
      description: a.description,
      amount: a.amount,
      created_at: a.created_at,
    })),
  ];

  const chargesCents = items.reduce((sum, i) => sum + toCents(i.amount), 0);
  const paymentsCents = paymentsRes.rows
    .filter((p) => p.status === 'completed')
    .reduce((sum, p) => sum + toCents(p.amount), 0);

  return {
    booking_id: booking.id,
    currency: booking.currency,
    items,
    charges_total: fromCents(chargesCents),
    payments: paymentsRes.rows,
    payments_total: fromCents(paymentsCents),
    balance: fromCents(chargesCents - paymentsCents),
  };
}

module.exports = { computeFolio, toCents, fromCents };
```

- [ ] **Step 2: Verify against a real seeded booking**

```bash
set -a; source .env; set +a
node -e "
const pool = require('./src/db');
const { computeFolio } = require('./src/lib/folio');
(async () => {
  const { rows } = await pool.query('SELECT id, property_id, total_price FROM booking ORDER BY created_at DESC LIMIT 1');
  if (!rows.length) { console.log('NO BOOKINGS — seed one first'); process.exit(1); }
  const f = await computeFolio(rows[0].id, rows[0].property_id);
  console.log(JSON.stringify(f, null, 2));
  console.assert(f.items[0].type === 'room' && f.items[0].amount === rows[0].total_price, 'room line mismatch');
  const none = await computeFolio(rows[0].id, '00000000-0000-0000-0000-000000000000');
  console.assert(none === null, 'cross-property must be null');
  console.log('OK');
  process.exit(0);
})();
"
```

Expected: folio JSON with a `room` item equal to the booking's `total_price`, `balance = charges_total` when no completed payments exist, `OK` printed, and no assertion output.

- [ ] **Step 3: Commit**

```bash
git add src/lib/folio.js
git commit -m "Add computed guest-folio aggregation (lib/folio)"
```

---

### Task 3: Folio read + adjustments — `src/controllers/folio.js` (part 1) and routes

**Files:**
- Create: `src/controllers/folio.js`
- Modify: `src/routes/bookings.js`

**Interfaces:**
- Consumes: `computeFolio` from Task 2.
- Produces: controller exports `getFolio, addAdjustment, removeAdjustment` (Task 5 adds two more to the same file); routes `GET /api/bookings/:id/folio`, `POST /api/bookings/:id/folio/adjustments`, `DELETE /api/bookings/:id/folio/adjustments/:adjustment_id`, all behind `authenticate`.

- [ ] **Step 1: Write `src/controllers/folio.js`**

```js
const pool = require('../db');
const { computeFolio } = require('../lib/folio');

async function getFolio(req, res, next) {
  try {
    const folio = await computeFolio(req.params.id, req.property_id);
    if (!folio) return res.status(404).json({ error: 'Booking not found' });
    res.json(folio);
  } catch (err) {
    next(err);
  }
}

async function addAdjustment(req, res, next) {
  try {
    const { description, amount } = req.body ?? {};
    const amt = Number(amount);
    if (!description || typeof description !== 'string' || amount == null || Number.isNaN(amt) || amt === 0) {
      return res.status(400).json({ error: 'description and a non-zero amount are required' });
    }
    if (description.length > 200) {
      return res.status(400).json({ error: 'description must be 200 characters or fewer' });
    }

    const bookingRes = await pool.query(
      'SELECT id FROM booking WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!bookingRes.rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO folio_adjustment (property_id, booking_id, description, amount)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.property_id, req.params.id, description, amt.toFixed(2)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function removeAdjustment(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM folio_adjustment
       WHERE id = $1 AND booking_id = $2 AND property_id = $3
       RETURNING id`,
      [req.params.adjustment_id, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Adjustment not found on this booking' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { getFolio, addAdjustment, removeAdjustment };
```

- [ ] **Step 2: Wire routes in `src/routes/bookings.js`**

Replace the file's contents with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const folio = require('../controllers/folio');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listBookings);
router.get('/:id', authenticateOrApiKey, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticateOrApiKey, ctrl.cancelBooking);

// Guest folio (see docs/superpowers/specs/2026-09-01-guest-folio-design.md)
router.get('/:id/folio', authenticate, folio.getFolio);
router.post('/:id/folio/adjustments', authenticate, folio.addAdjustment);
router.delete('/:id/folio/adjustments/:adjustment_id', authenticate, folio.removeAdjustment);

module.exports = router;
```

- [ ] **Step 3: Verify — app boots, controller round-trip with stubbed auth**

```bash
set -a; source .env; set +a
node -e "require('./src/app'); console.log('app boots OK')"
node -e "
const pool = require('./src/db');
const folio = require('./src/controllers/folio');
function mockRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
(async () => {
  const { rows } = await pool.query('SELECT id, property_id FROM booking ORDER BY created_at DESC LIMIT 1');
  const [b] = rows;
  const next = (e) => { console.error('NEXT called:', e); process.exit(1); };

  // add adjustment
  let res = mockRes();
  await folio.addAdjustment({ params: { id: b.id }, property_id: b.property_id, body: { description: 'Minibar', amount: 12.5 } }, res, next);
  console.assert(res.code === 201 && res.body.amount === '12.50', 'add failed', res.code, res.body);
  const adjId = res.body.id;

  // folio shows it
  res = mockRes();
  await folio.getFolio({ params: { id: b.id }, property_id: b.property_id }, res, next);
  console.assert(res.body.items.some((i) => i.type === 'adjustment' && i.source_id === adjId), 'adjustment missing from folio');

  // zero amount 400
  res = mockRes();
  await folio.addAdjustment({ params: { id: b.id }, property_id: b.property_id, body: { description: 'x', amount: 0 } }, res, next);
  console.assert(res.code === 400, 'amount 0 must 400');

  // cross-property 404
  res = mockRes();
  await folio.getFolio({ params: { id: b.id }, property_id: '00000000-0000-0000-0000-000000000000' }, res, next);
  console.assert(res.code === 404, 'cross-property must 404');

  // remove
  res = mockRes();
  await folio.removeAdjustment({ params: { id: b.id, adjustment_id: adjId }, property_id: b.property_id }, res, next);
  console.assert(res.code === 204, 'delete failed');
  console.log('OK');
  process.exit(0);
})();
"
```

Expected: `app boots OK`, then `OK` with no assertion output.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/folio.js src/routes/bookings.js
git commit -m "Add folio read and manual adjustment endpoints"
```

---

### Task 4: Check-out soft gate in `updateBooking`

**Files:**
- Modify: `src/controllers/bookings.js` (updateBooking, ~line 308; require block at top)

**Interfaces:**
- Consumes: `computeFolio`, `toCents` from Task 2.
- Produces: `PUT /api/bookings/:id` with `{status: 'checked_out'}` returns `409 { error: 'Outstanding folio balance', balance }` when balance > 0, unless body has `force: true`.

- [ ] **Step 1: Add the require**

At the top of `src/controllers/bookings.js`, next to the existing requires:

```js
const { computeFolio, toCents } = require('../lib/folio');
```

- [ ] **Step 2: Add the gate**

In `updateBooking`, immediately after `const statusBefore = beforeRes.rows[0].status;` insert:

```js
    // Soft check-out gate: an outstanding folio balance blocks the
    // transition unless the caller explicitly forces it (comps/disputes
    // are the property's call). See the guest-folio spec.
    if (status === 'checked_out' && statusBefore !== 'checked_out' && req.body.force !== true) {
      const folio = await computeFolio(req.params.id, req.property_id);
      if (folio && toCents(folio.balance) > 0) {
        return res.status(409).json({ error: 'Outstanding folio balance', balance: folio.balance });
      }
    }
```

- [ ] **Step 3: Verify all three gate paths with stubbed auth**

```bash
set -a; source .env; set +a
node -e "
const pool = require('./src/db');
const bookings = require('./src/controllers/bookings');
function mockRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
(async () => {
  const { rows } = await pool.query(\"SELECT id, property_id, status, total_price FROM booking WHERE status = 'confirmed' ORDER BY created_at DESC LIMIT 1\");
  const [b] = rows;
  const next = (e) => { console.error('NEXT called:', e); process.exit(1); };

  // balance > 0 (room charge unpaid) -> 409
  let res = mockRes();
  await bookings.updateBooking({ params: { id: b.id }, property_id: b.property_id, body: { status: 'checked_out' } }, res, next);
  console.assert(res.code === 409 && res.body.error === 'Outstanding folio balance', 'gate did not fire', res.code, res.body);

  // force -> proceeds
  res = mockRes();
  await bookings.updateBooking({ params: { id: b.id }, property_id: b.property_id, body: { status: 'checked_out', force: true } }, res, next);
  console.assert(res.code === 200 && res.body.status === 'checked_out', 'force did not proceed', res.code);

  // restore original status
  await pool.query('UPDATE booking SET status = \$1 WHERE id = \$2', [b.status, b.id]);
  console.log('OK');
  process.exit(0);
})();
"
```

Expected: `OK`, no assertions. (Zero-balance pass-through is implied by the force path plus Task 5's paid-flow verification; the Ably publish inside updateBooking fires on the force transition — a console error from Ably in a local env without credentials is tolerated, not a failure.)

- [ ] **Step 4: Commit**

```bash
git add src/controllers/bookings.js
git commit -m "Gate check-out on outstanding folio balance (force to override)"
```

---

### Task 5: Tap to Pay — folio payment-intent and confirm endpoints

**Files:**
- Modify: `src/controllers/folio.js` (append two handlers + two helpers; extend module.exports)
- Modify: `src/routes/bookings.js` (two routes)

**Interfaces:**
- Consumes: `computeFolio`, `toCents`, `fromCents` (Task 2); `payment.stripe_payment_intent_id` (Task 1).
- Produces: `createFolioPaymentIntent`, `confirmFolioPayment` exports; routes `POST /api/bookings/:id/folio/payment-intent` (`{amount?}` — defaults to balance; returns `{client_secret, payment_intent_id, amount}` or `{already_paid: true, payment_intent_id}`) and `POST /api/bookings/:id/folio/confirm-payment` (`{stripe_payment_intent_id}` — returns the completed payment row).

- [ ] **Step 1: Append helpers and handlers to `src/controllers/folio.js`**

Add after `removeAdjustment` (and add `toCents, fromCents` to the existing lib require):

```js
// Booking + the property's Stripe key/currency, property-scoped the way
// loadAppointmentForPayment (spaPayments.js) is. Cross-property -> null.
async function loadBookingForPayment(bookingId, propertyId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, p.stripe_secret_key, p.currency
     FROM booking b
     JOIN property p ON p.id = b.property_id
     WHERE b.id = $1 AND b.property_id = $2`,
    [bookingId, propertyId]
  );
  return rows[0] ?? null;
}

// The booking's single in-flight card payment, if any. At most one exists
// by construction: this flow only ever inserts when none is found, and
// otherwise reuses/overwrites the row it found.
async function findPendingCardPayment(bookingId) {
  const { rows } = await pool.query(
    `SELECT * FROM payment
     WHERE booking_id = $1 AND status = 'pending' AND method = 'card'
       AND stripe_payment_intent_id IS NOT NULL`,
    [bookingId]
  );
  return rows[0] ?? null;
}

async function createFolioPaymentIntent(req, res, next) {
  try {
    const booking = await loadBookingForPayment(req.params.id, req.property_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: 'Booking is cancelled' });

    const folio = await computeFolio(req.params.id, req.property_id);
    const balanceCents = toCents(folio.balance);
    const requested = req.body?.amount;
    const amount = requested != null ? toCents(requested) : balanceCents;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(409).json({ error: 'Nothing to pay on this booking' });
    if (amount > balanceCents) return res.status(409).json({ error: 'Amount exceeds the outstanding balance', balance: folio.balance });

    const stripe = require('stripe')(booking.stripe_secret_key);

    // Idempotency: a retry (e.g. a failed tap) reuses the pending row's
    // intent rather than minting a second charge -- same rules as
    // createAppointmentPaymentIntent (spaPayments.js), with the pending
    // state held in the payment ledger row instead of a status column.
    const pending = await findPendingCardPayment(booking.id);
    if (pending) {
      const existing = await stripe.paymentIntents.retrieve(pending.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        if (existing.amount !== amount) {
          await stripe.paymentIntents.update(existing.id, { amount });
          await pool.query('UPDATE payment SET amount = $1 WHERE id = $2', [fromCents(amount), pending.id]);
        }
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount });
      }
      // Crash-window recovery: the tap landed but the app died before
      // confirm-payment. Settle with the charge that already exists,
      // recording the amount Stripe actually captured.
      if (existing.status === 'succeeded') {
        await pool.query(
          `UPDATE payment SET status = 'completed', paid_at = now(), amount = $1 WHERE id = $2`,
          [fromCents(existing.amount), pending.id]
        );
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled -> mint a fresh intent onto the same pending row
      const intent = await stripe.paymentIntents.create({
        amount,
        currency: booking.currency.toLowerCase(),
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata: { booking_id: booking.id },
      });
      await pool.query(
        'UPDATE payment SET stripe_payment_intent_id = $1, amount = $2 WHERE id = $3',
        [intent.id, fromCents(amount), pending.id]
      );
      return res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: booking.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { booking_id: booking.id },
    });
    await pool.query(
      `INSERT INTO payment (property_id, booking_id, amount, method, status, stripe_payment_intent_id)
       VALUES ($1, $2, $3, 'card', 'pending', $4)`,
      [req.property_id, booking.id, fromCents(amount), intent.id]
    );
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function confirmFolioPayment(req, res, next) {
  try {
    const { stripe_payment_intent_id } = req.body ?? {};
    if (!stripe_payment_intent_id) return res.status(400).json({ error: 'stripe_payment_intent_id is required' });

    const booking = await loadBookingForPayment(req.params.id, req.property_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    // Prevents attaching an unrelated (e.g. cheaper) charge to this booking.
    const pending = await findPendingCardPayment(booking.id);
    if (!pending || pending.stripe_payment_intent_id !== stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this booking' });
    }

    const stripe = require('stripe')(booking.stripe_secret_key);
    const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (intent.status !== 'succeeded') return res.status(409).json({ error: 'Payment has not succeeded' });
    if (intent.amount !== toCents(pending.amount)) {
      return res.status(409).json({ error: 'Payment amount does not match the pending payment' });
    }

    const { rows } = await pool.query(
      `UPDATE payment SET status = 'completed', paid_at = now() WHERE id = $1 RETURNING *`,
      [pending.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}
```

Update the lib require at the top of the file to:

```js
const { computeFolio, toCents, fromCents } = require('../lib/folio');
```

and the exports line to:

```js
module.exports = { getFolio, addAdjustment, removeAdjustment, createFolioPaymentIntent, confirmFolioPayment };
```

- [ ] **Step 2: Add the two routes**

In `src/routes/bookings.js`, after the adjustments routes:

```js
router.post('/:id/folio/payment-intent', authenticate, folio.createFolioPaymentIntent);
router.post('/:id/folio/confirm-payment', authenticate, folio.confirmFolioPayment);
```

- [ ] **Step 3: Verify guard paths (no Stripe key needed) and the manual-payment balance rule**

```bash
set -a; source .env; set +a
node -e "
const pool = require('./src/db');
const folio = require('./src/controllers/folio');
const { computeFolio } = require('./src/lib/folio');
function mockRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
(async () => {
  const { rows } = await pool.query('SELECT id, property_id FROM booking ORDER BY created_at DESC LIMIT 1');
  const [b] = rows;
  const next = (e) => { console.error('NEXT called:', e); process.exit(1); };

  // missing intent id -> 400
  let res = mockRes();
  await folio.confirmFolioPayment({ params: { id: b.id }, property_id: b.property_id, body: {} }, res, next);
  console.assert(res.code === 400, 'missing intent id must 400');

  // cross-property -> 404
  res = mockRes();
  await folio.createFolioPaymentIntent({ params: { id: b.id }, property_id: '00000000-0000-0000-0000-000000000000', body: {} }, res, next);
  console.assert(res.code === 404, 'cross-property must 404');

  // no-key or amount guards -> 409 (which one depends on the property's config)
  res = mockRes();
  await folio.createFolioPaymentIntent({ params: { id: b.id }, property_id: b.property_id, body: { amount: 99999999 } }, res, next);
  console.assert(res.code === 409, 'over-balance or no-key must 409', res.code, res.body);

  // completed manual payment reduces balance; pending does not
  const before = await computeFolio(b.id, b.property_id);
  const ins = await pool.query(
    \"INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at) VALUES (\$1, \$2, '10.00', 'cash', 'completed', now()) RETURNING id\",
    [b.property_id, b.id]
  );
  const after = await computeFolio(b.id, b.property_id);
  console.assert((parseFloat(before.balance) - parseFloat(after.balance)).toFixed(2) === '10.00', 'completed payment must reduce balance');
  await pool.query('DELETE FROM payment WHERE id = \$1', [ins.rows[0].id]);
  console.log('OK');
  process.exit(0);
})();
"
```

Expected: `OK`, no assertions. If the property has a Stripe **test** key configured, additionally exercise the live path: call `createFolioPaymentIntent` with a small amount, confirm a `payment` row appears with `status='pending'` and the intent id, then call it again and assert the same `payment_intent_id` comes back (reuse, not a second intent). Do not run this against a live-mode key.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/folio.js src/routes/bookings.js
git commit -m "Add folio Tap to Pay payment-intent and confirm endpoints"
```

---

### Task 6: Swagger documentation

**Files:**
- Modify: `src/docs/swagger.js` (tags array ~line 21; new path entries after the `/api/payments/{id}` block ~line 342)

**Interfaces:**
- Consumes: the five routes from Tasks 3 and 5.
- Produces: `Folio` tag and five documented paths.

- [ ] **Step 1: Add the tag**

In the `tags` array, after `{ name: 'Payments' },` add:

```js
    { name: 'Folio' },
```

- [ ] **Step 2: Add the path entries**

After the closing `},` of the `'/api/payments/{id}'` block, add (matching the file's single-line-per-verb style):

```js
    // ── Folio ────────────────────────────────────────────────────────────────
    '/api/bookings/{id}/folio': {
      get: { tags: ['Folio'], summary: "The booking's folio: computed line items (room, extras, room service, adjustments), payments, and balance", security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'items, charges_total, payments, payments_total, balance (completed payments only reduce the balance)' }, 404: { description: 'Booking not found' } } },
    },
    '/api/bookings/{id}/folio/adjustments': {
      post: { tags: ['Folio'], summary: 'Add a manual folio line (positive = charge, negative = credit/comp)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['description', 'amount'], properties: { description: { type: 'string', maxLength: 200 }, amount: { type: 'number', description: 'Non-zero; negative for credits' } } } } } }, responses: { 201: { description: 'Adjustment created' }, 400: { description: 'Missing description or zero amount' }, 404: { description: 'Booking not found' } } },
    },
    '/api/bookings/{id}/folio/adjustments/{adjustment_id}': {
      delete: { tags: ['Folio'], summary: 'Remove a manual folio line', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'adjustment_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Removed' }, 404: { description: 'Adjustment not found on this booking' } } },
    },
    '/api/bookings/{id}/folio/payment-intent': {
      post: { tags: ['Folio'], summary: 'Create (or reuse) a Tap to Pay PaymentIntent for the folio balance', description: "Amount defaults to the outstanding balance; must be > 0 and ≤ balance. Retries reuse the booking's pending card payment row and its intent; a succeeded-but-unconfirmed intent settles that row instead of charging twice.", security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { amount: { type: 'number', description: 'Optional partial amount; defaults to the full balance' } } } } } }, responses: { 200: { description: 'client_secret, payment_intent_id, amount — or already_paid: true after crash-window recovery' }, 404: { description: 'Booking not found' }, 409: { description: 'No Stripe key, cancelled booking, nothing to pay, or amount exceeds balance' }, 502: { description: 'Stripe API error' } } },
    },
    '/api/bookings/{id}/folio/confirm-payment': {
      post: { tags: ['Folio'], summary: "Confirm a succeeded Tap to Pay intent, completing the booking's pending card payment", security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['stripe_payment_intent_id'], properties: { stripe_payment_intent_id: { type: 'string' } } } } } }, responses: { 200: { description: 'The completed payment row' }, 400: { description: 'stripe_payment_intent_id missing' }, 404: { description: 'Booking not found' }, 409: { description: 'Intent does not match, has not succeeded, or amount mismatch' }, 502: { description: 'Stripe API error' } } },
    },
```

Also document the gate on the existing bookings PUT: find the `'/api/bookings/{id}'` block's `put:` entry and extend its `responses` with `409: { description: 'Outstanding folio balance blocks checked_out (pass force: true to override)' }` and add `force: { type: 'boolean', description: 'Override the folio-balance check-out gate' }` to its requestBody properties if it has a schema there.

- [ ] **Step 3: Verify the spec still parses**

```bash
node -e "const s = require('./src/docs/swagger'); const n = Object.keys(s.paths).filter(p => p.includes('/folio')).length; console.assert(n === 5, 'expected 5 folio paths, got ' + n); console.log('swagger OK,', Object.keys(s.paths).length, 'paths')"
```

Expected: `swagger OK, <count> paths` and no assertion. (If swagger.js exports the app-level setup rather than the spec object, boot the app instead: `node -e "require('./src/app'); console.log('OK')"`.)

- [ ] **Step 4: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document folio endpoints in Swagger"
```

---

## Final Verification (whole feature)

- [ ] Run the Task 2, 3, 4, 5 verification scripts once more from a clean shell — all `OK`.
- [ ] `node -e "require('./src/app'); console.log('boot OK')"`.
- [ ] Confirm nothing outside the planned files changed: `git status --short` shows only expected untracked leftovers (`.playwright-mcp/`, `=`, `*.bak`).
- [ ] Optional (needs a Clerk token from the dashboard app): curl `GET /api/bookings/:id/folio` end-to-end and confirm 401 without a token.
