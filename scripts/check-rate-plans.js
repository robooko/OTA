// Room rate plans (Saver/Flex) checks. Pure helpers are asserted directly;
// HTTP checks run the real app on an ephemeral port with fixtures under
// throwaway properties, deleted at the end (pass or fail). Stripe is the
// in-memory fake. Local DB only, with
// migrate-2026-10-30-room-rate-plans.sql applied.
//   node -r dotenv/config scripts/check-rate-plans.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const {
  applyAdjustment, cancelDeadline, effectiveMode, chargeAmountCents, guestCancelDecision, validatePlan,
} = require('../src/lib/ratePlans');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Task 1: pure rules ----
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
    assert.equal(effectiveMode(hold, new Date('2030-07-08T00:00:00Z'), now), 'full'); // > 6 days
    assert.equal(effectiveMode(hold, new Date('2030-06-30T00:00:00Z'), now), 'full'); // deadline passed
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

  // ---- HTTP checks (Tasks 2+) ----
  const app = require('../src/app');
  const folioCtrl = require('../src/controllers/folio');
  const guestsCtrl = require('../src/controllers/guests');
  const propertyCtrl = require('../src/controllers/property');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `rate_plans_check_${tag}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(
    `INSERT INTO property (name, api_key, api_key_enabled, timezone, currency, stripe_secret_key, stripe_publishable_key, room_booking_url)
     VALUES ('Rate Plan Check', $1, true, 'Europe/London', 'GBP', 'sk_test_check', 'pk_test_check', 'https://hotel.test/stay/{id}') RETURNING id`, [KEY])).id;
  const Q = (await one(`INSERT INTO property (name, api_key, api_key_enabled) VALUES ('Rate Plan Check Other', $1, true) RETURNING id`, [`${KEY}_other`])).id;

  const api = async (method, path, body) => {
    const r = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  // Staff = a controller called directly, as a signed-in (non-API-key) request.
  const staff = async (fn, req) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body: {}, headers: {}, get: () => undefined, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  const roomType = async (prop, name) => (await one(
    'INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, $2, 2, 100) RETURNING id', [prop, name])).id;
  const room = async (prop, rt, number) => (await one(
    'INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3) RETURNING id', [prop, rt, number])).id;
  const RT = await roomType(P, 'Double');
  const PLAIN_RT = await roomType(P, 'Single');
  const OTHER_RT = await roomType(Q, 'Elsewhere');
  const R1 = await room(P, RT, 'D1'); const R2 = await room(P, RT, 'D2');
  const R3 = await room(P, PLAIN_RT, 'S1'); const R4 = await room(P, PLAIN_RT, 'S2');
  // July 2030 plus the next 10 days, every room.
  await pool.query(
    `INSERT INTO room_availability (property_id, room_id, date)
     SELECT $1, r, d::date FROM unnest($2::uuid[]) r,
       (SELECT generate_series('2030-07-01'::date, '2030-07-31'::date, '1 day') d
        UNION SELECT generate_series(current_date, current_date + 10, '1 day')) days
     ON CONFLICT DO NOTHING`, [P, [R1, R2, R3, R4]]);
  const G = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Ana', 'Guest', $2) RETURNING id`, [P, `ana-${tag}@example.test`])).id;
  const insertBooking = async ({ room: r, check_in, check_out, status }) => (await one(
    `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status)
     VALUES ($1, $2, $3, $4, $5, 100, $6) RETURNING id`, [P, G, r, check_in, check_out, status])).id;

  try {
    // ---- Task 2: schema, expired status, room_booking_url ----
    let expiredId;
    await check('expired booking frees the room for an overlapping booking', async () => {
      expiredId = await insertBooking({ room: R1, check_in: '2030-07-02', check_out: '2030-07-04', status: 'expired' });
      const b = await insertBooking({ room: R1, check_in: '2030-07-03', check_out: '2030-07-05', status: 'confirmed' }); // must not throw 23P01
      assert.ok(expiredId && b);
    });
    await check('folio refuses payment on an expired booking', async () => {
      const r = await staff(folioCtrl.createFolioPaymentIntent, { params: { id: expiredId } });
      assert.equal(r.status, 409); assert.match(r.body.error, /expired/);
    });
    await check('guest stats count expired', async () => {
      const r = await staff(guestsCtrl.getGuestSummary, { params: { id: G } });
      assert.equal(Number(r.body.expired), 1);
    });
    await check('room_booking_url round-trips through branding settings', async () => {
      const bad = await staff(propertyCtrl.updateEmailBranding, { body: { room_booking_url: 'not a url' } });
      assert.equal(bad.status, 400); assert.match(bad.body.error, /room_booking_url/);
      const r = await staff(propertyCtrl.updateEmailBranding, { body: { room_booking_url: 'https://hotel.test/stay/{id}' } });
      assert.equal(r.body.room_booking_url, 'https://hotel.test/stay/{id}');
      assert.equal((await staff(propertyCtrl.getEmailBranding, {})).body.room_booking_url, 'https://hotel.test/stay/{id}');
    });

    // ---- Task 3: rate plan management ----
    const rp = require('../src/controllers/ratePlans');
    let SAVER; let FLEX;
    await check('staff create Saver and Flex; api key lists active only', async () => {
      const saver = await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Saver', adjustment_pct: -12, refundable: false, payment_mode: 'full', sort_order: 1 } });
      assert.equal(saver.status, 201); SAVER = saver.body.id;
      const flex = await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Flex', refundable: true, cancel_cutoff_hours: 48, payment_mode: 'hold', sort_order: 2 } });
      assert.equal(flex.status, 201); FLEX = flex.body.id;
      const old = await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Old', refundable: false, payment_mode: 'full' } });
      assert.equal((await staff(rp.updateRatePlan, { params: { id: RT, plan_id: old.body.id }, body: { status: 'archived' } })).body.status, 'archived');
      const listed = await api('GET', `/api/room-types/${RT}/rate-plans`);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.map((p) => p.name), ['Saver', 'Flex']);
      assert.equal((await staff(rp.listRatePlans, { params: { id: RT } })).body.length, 3); // staff see archived too
    });
    await check('invalid plans are 400; other property room type is 404', async () => {
      assert.equal((await staff(rp.createRatePlan, { params: { id: RT }, body: { name: 'Bad', refundable: false, payment_mode: 'hold' } })).status, 400);
      assert.equal((await staff(rp.updateRatePlan, { params: { id: RT, plan_id: SAVER }, body: { payment_mode: 'deposit' } })).status, 400); // merged plan lacks deposit fields
      assert.equal((await staff(rp.createRatePlan, { params: { id: OTHER_RT }, body: { name: 'X', refundable: false, payment_mode: 'full' } })).status, 404);
      assert.equal((await staff(rp.updateRatePlan, { params: { id: RT, plan_id: crypto.randomUUID() }, body: { name: 'Y' } })).status, 404);
    });
  } finally {
    const props = [P, Q];
    await pool.query('DELETE FROM payment WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM booking_extra WHERE booking_id IN (SELECT id FROM booking WHERE property_id = ANY($1))', [props]);
    await pool.query('DELETE FROM booking WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_availability WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM rate_plan WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM extra WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_type WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM guest WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    await pool.query('REFRESH MATERIALIZED VIEW room_type_availability').catch(() => {});
    server.close();
  }

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
