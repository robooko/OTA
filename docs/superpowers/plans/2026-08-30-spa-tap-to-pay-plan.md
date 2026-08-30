# Spa Tap to Pay Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Payment fields and Stripe Terminal endpoints so the waitress app can charge a spa appointment's treatment price by Tap to Pay.

**Architecture:** Mirrors the restaurant table-session Tap to Pay endpoints, scoped to a single `spa_appointment` whose amount is the joined treatment's price. Two new payment endpoints live in a new `spaPayments.js` controller; a subscribe-only Ably token endpoint joins the existing spa controller. The property-level connection-token endpoint is reused as-is.

**Tech Stack:** Node/Express, pg, `stripe`, Ably REST. No test framework in this repo — verification is `curl` against `npm run dev` (see the spec's Verification section).

**Spec:** `docs/superpowers/specs/2026-08-30-spa-tap-to-pay-backend-requirements.md`

## Global Constraints

- Every route uses `authenticateOrApiKey` and scopes by `req.property_id`; cross-property ids return 404, never 403.
- Stripe test mode only (`sk_test_…`).
- Stripe API errors map to `502 { error: "Stripe error: <message>" }` (the `err.type?.startsWith('Stripe')` pattern).
- Minor-units conversion is `Math.round(parseFloat(x) * 100)` — identical to `sessionTotalCents` in `restaurantTableSessions.js:21-28`.
- Migrations are idempotent (`IF NOT EXISTS`); `schema.sql` is updated in place to the final shape.

---

### Task 1: Migration — payment fields on `spa_appointment`

**Files:**
- Create: `src/db/migrate-2026-08-30-spa-appointment-payment.sql`
- Modify: `src/db/schema.sql` (the `spa_appointment` CREATE TABLE block, near line 416)

**Interfaces:**
- Produces: columns `payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'`, `paid_at TIMESTAMPTZ`, `stripe_payment_intent_id VARCHAR(255)` on `spa_appointment`, read by Tasks 2–3 and returned by the existing `listAppointments`/`getAppointment` (`sa.*`).

- [ ] **Step 1: Write the migration**

```sql
-- Payment tracking for spa appointments (Tap to Pay) -- see
-- docs/superpowers/specs/2026-08-30-spa-tap-to-pay-backend-requirements.md.
-- Same shape as restaurant_table_session's payment fields
-- (migrate-2026-08-23-restaurant-table-session-payment.sql). No backfill:
-- every existing appointment defaults to 'unpaid', which is true.

ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

DO $$ BEGIN
  ALTER TABLE spa_appointment
    ADD CONSTRAINT spa_appointment_payment_status CHECK (payment_status IN ('unpaid', 'paid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

(Check how the 2026-08-23 restaurant payment migration guards its CHECK constraint first — if it uses a different idempotency idiom, copy that idiom instead of the `DO $$` block.)

- [ ] **Step 2: Add the same three columns + CHECK to `spa_appointment` in `schema.sql`**

Place them after `confirmation_resend_email_id`, mirroring how `restaurant_table_session` lists its payment columns.

- [ ] **Step 3: Run the migration against the local database**

Run: `psql "$DATABASE_URL" -f src/db/migrate-2026-08-30-spa-appointment-payment.sql` (or this repo's usual migration invocation — check `package.json`/`README` for a migrate script and use that if one exists). Run it **twice** to prove idempotency.

Expected: no errors on either run; `\d spa_appointment` shows the three columns and the CHECK.

- [ ] **Step 4: Confirm existing rows default correctly**

Run: `psql "$DATABASE_URL" -c "SELECT payment_status, COUNT(*) FROM spa_appointment GROUP BY 1"`
Expected: every row `unpaid`.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate-2026-08-30-spa-appointment-payment.sql src/db/schema.sql
git commit -m "Add payment fields to spa_appointment"
```

---

### Task 2: `spaPayments.js` — create a PaymentIntent for an appointment

**Files:**
- Create: `src/controllers/spaPayments.js`
- Modify: `src/routes/spa.js` (add the route)

**Interfaces:**
- Consumes: Task 1's columns; `spa_treatment.price` (`NUMERIC(10,2)`), `property.stripe_secret_key` / `currency`.
- Produces: `POST /api/spa/:spa_id/appointments/:id/payment-intent` → `{ client_secret, payment_intent_id, amount }` | `{ already_paid: true, payment_intent_id }`; exports `createAppointmentPaymentIntent`, plus the internal helpers `loadAppointmentForPayment(appointmentId, spaId, propertyId)` and `treatmentPriceCents(price)` reused by Task 3.

- [ ] **Step 1: Create the controller with the loader, converter, and intent endpoint**

```js
const pool = require('../db');

// Loads an appointment with everything the payment endpoints need, scoped
// the way every spa route is: through the therapist's spa and the
// requester's property. Cross-property ids read as not-found.
async function loadAppointmentForPayment(appointmentId, spaId, propertyId) {
  const { rows } = await pool.query(
    `SELECT sa.*, tr.price, p.stripe_secret_key, p.currency
     FROM spa_appointment sa
     JOIN spa_therapist st ON st.id = sa.therapist_id
     JOIN spa_treatment tr ON tr.id = sa.treatment_id
     JOIN property p ON p.id = sa.property_id
     WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
    [appointmentId, spaId, propertyId]
  );
  return rows[0] ?? null;
}

// Same NUMERIC(10,2) -> minor-units conversion as sessionTotalCents.
function treatmentPriceCents(price) {
  return Math.round(parseFloat(price) * 100);
}

async function createAppointmentPaymentIntent(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });
    if (appt.payment_status === 'paid') return res.status(409).json({ error: 'Appointment already paid' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const amount = treatmentPriceCents(appt.price);
    if (amount <= 0) return res.status(409).json({ error: 'Nothing to pay on this appointment' });

    // Idempotency: a retry (e.g. a failed tap) reuses the pending intent
    // rather than minting a second charge -- same rules as
    // createSessionPaymentIntent, minus its online-channel logic (spa
    // payments are Terminal-only).
    if (appt.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(appt.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount: existing.amount });
      }
      // Crash-window recovery: the tap landed but the app died before
      // confirm-payment. Creating a fresh intent would charge twice --
      // settle with the charge that already exists instead, applying the
      // same amount check confirm-payment would.
      if (existing.status === 'succeeded') {
        if (existing.amount !== amount) {
          return res.status(409).json({ error: 'A payment already succeeded for a different amount', payment_intent_id: existing.id });
        }
        await pool.query(`UPDATE spa_appointment SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [appt.id]);
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled -> fall through and mint a fresh intent
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: appt.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { spa_appointment_id: appt.id, spa_id: req.params.spa_id },
    });
    await pool.query(`UPDATE spa_appointment SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, appt.id]);
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { loadAppointmentForPayment, treatmentPriceCents, createAppointmentPaymentIntent };
```

- [ ] **Step 2: Wire the route**

In `src/routes/spa.js`, after the existing appointment routes:

```js
const payments = require('../controllers/spaPayments');
// ...with the other appointment routes:
router.post('/:spa_id/appointments/:id/payment-intent', authenticateOrApiKey, payments.createAppointmentPaymentIntent);
```

(Keep the `require` at the top of the file with the other requires.)

- [ ] **Step 3: Verify with curl (local dev server, Bedford property key, test-mode Stripe key set on the property)**

```bash
# book something first (or reuse an existing confirmed appointment id)
curl -s -X POST "http://localhost:3000/api/spa/$SPA/appointments/$APPT/payment-intent" -H "X-Api-Key: $KEY"
```

Expected: `{client_secret: "pi_…_secret_…", payment_intent_id: "pi_…", amount: <price in pence>}`; the row's `stripe_payment_intent_id` is set. Call again → **same** `payment_intent_id`. A cancelled appointment → 409. A property without `stripe_secret_key` → 409. Another property's key → 404.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/spaPayments.js src/routes/spa.js
git commit -m "Add a Terminal PaymentIntent endpoint for spa appointments"
```

---

### Task 3: `spaPayments.js` — confirm payment

**Files:**
- Modify: `src/controllers/spaPayments.js`
- Modify: `src/routes/spa.js`

**Interfaces:**
- Consumes: Task 2's `loadAppointmentForPayment`, `treatmentPriceCents`.
- Produces: `POST /api/spa/:spa_id/appointments/:id/confirm-payment` body `{stripe_payment_intent_id}` → the updated appointment row; exports `confirmAppointmentPayment`.

- [ ] **Step 1: Add the confirm endpoint**

```js
async function confirmAppointmentPayment(req, res, next) {
  try {
    const { stripe_payment_intent_id } = req.body ?? {};
    if (!stripe_payment_intent_id) return res.status(400).json({ error: 'stripe_payment_intent_id is required' });

    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.payment_status === 'paid') return res.status(409).json({ error: 'Appointment already paid' });
    // Prevents attaching an unrelated (e.g. cheaper) charge to this booking.
    if (stripe_payment_intent_id !== appt.stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this appointment' });
    }

    const stripe = require('stripe')(appt.stripe_secret_key);
    const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (intent.status !== 'succeeded') return res.status(409).json({ error: 'Payment has not succeeded' });
    if (intent.amount !== treatmentPriceCents(appt.price)) {
      return res.status(409).json({ error: 'Payment amount does not match the treatment price' });
    }

    const { rows } = await pool.query(
      `UPDATE spa_appointment SET payment_status = 'paid', paid_at = now() WHERE id = $1 RETURNING *`,
      [appt.id]
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

Add `confirmAppointmentPayment` to `module.exports`.

- [ ] **Step 2: Wire the route**

```js
router.post('/:spa_id/appointments/:id/confirm-payment', authenticateOrApiKey, payments.confirmAppointmentPayment);
```

- [ ] **Step 3: Verify with curl**

Confirm the pending intent server-side with Stripe's test card (stand-in for a tap):

```bash
stripe_key=$(psql "$DATABASE_URL" -tA -c "SELECT stripe_secret_key FROM property WHERE name = 'Bedford Barber Co'")
curl -s "https://api.stripe.com/v1/payment_intents/$PI/confirm" -u "$stripe_key:" -d payment_method=pm_card_visa
curl -s -X POST "http://localhost:3000/api/spa/$SPA/appointments/$APPT/confirm-payment" \
  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d "{\"stripe_payment_intent_id\": \"$PI\"}"
```

Note: `pm_card_visa` may be rejected on a `card_present` intent depending on Stripe test-mode behaviour; if so, follow the restaurant spec's precedent (`2026-08-23-restaurant-tap-to-pay-backend-requirements.md`, Verification) — it confirmed the same way; check how that verification actually worked around it if it did.

Expected: 200 with `payment_status: "paid"`, `paid_at` set. Then: repeat → 409 already paid; a random intent id on an unpaid appointment → 409 mismatch, row unchanged; a never-confirmed intent → 409 not succeeded. Crash-window path: on a fresh appointment, mint an intent, confirm it via Stripe directly, then call **payment-intent** (not confirm) again → `{already_paid: true}` and the row reads paid.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/spaPayments.js src/routes/spa.js
git commit -m "Add confirm-payment for spa appointments"
```

---

### Task 4: Ably subscribe token for a spa

**Files:**
- Modify: `src/controllers/spa.js` (new `getSpaAblyToken` + export)
- Modify: `src/routes/spa.js`

**Interfaces:**
- Consumes: `lib/ably`'s exported `client` (may be null when `ABLY_API_KEY` is unset — 503 then, same as `getSessionAblyToken`).
- Produces: `GET /api/spa/:spa_id/ably-token` → `{ tokenRequest, channel: "spa:<spa_id>:appointments" }`.

- [ ] **Step 1: Add the controller function**

In `src/controllers/spa.js` — add `client: ablyClient` to the existing `require('../lib/ably')` destructure at the top, then (next to `listAppointments`):

```js
// Subscribe-only token for the app's live schedule -- mirrors
// restaurantOrders.getAblyToken. The channel is the one
// publishNewAppointment / publishAppointmentStatusChanged already use.
async function getSpaAblyToken(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { rows } = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    if (!ablyClient) return res.status(503).json({ error: 'Realtime notifications are not configured' });

    const channel = `spa:${spa_id}:appointments`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}
```

Add `getSpaAblyToken` to the `module.exports` list.

- [ ] **Step 2: Wire the route**

```js
router.get('/:spa_id/ably-token', authenticateOrApiKey, ctrl.getSpaAblyToken);
```

Place it above the `/:spa_id/appointments/:id` routes with the other `:spa_id` GETs.

- [ ] **Step 3: Verify with curl**

```bash
curl -s "http://localhost:3000/api/spa/$SPA/ably-token" -H "X-Api-Key: $KEY"
```

Expected: `{tokenRequest: {…}, channel: "spa:<id>:appointments"}`; the tokenRequest's `capability` grants only `subscribe` on that one channel. Wrong property's key → 404.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/spa.js src/routes/spa.js
git commit -m "Add a spa Ably subscribe-token endpoint"
```

---

### Task 5: Swagger

**Files:**
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: the three new routes' request/response shapes from Tasks 2–4.

- [ ] **Step 1: Document the new paths**

Add `/api/spa/{spa_id}/appointments/{id}/payment-intent`, `…/confirm-payment`, and `/api/spa/{spa_id}/ably-token`, following the exact structure the existing `/api/restaurant-table-sessions/{id}/payment-intent` and `/api/restaurant-orders/ably-token` entries use (find them near lines 614–640). Document `payment_status`/`paid_at`/`stripe_payment_intent_id` on the spa appointment schema if one is defined there.

- [ ] **Step 2: Verify the server still boots and /docs renders**

Run: `npm run dev`, open `http://localhost:3000/docs` (or wherever swagger is served — check `app.js`), confirm the three new paths appear.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document the spa payment and ably-token endpoints"
```

---

### Task 6: Full verification pass

No files. Run the spec's Verification section (items 1–9) end-to-end against local, in order, and fix anything that fails before declaring the backend done. Then run the migration against production **before** the code deploys (additive columns — old code is unaffected), per the repo's usual two-step.
