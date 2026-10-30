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
const marinaStripe = require('../src/lib/marinaStripe');
const fakeStripe = require('./fake-stripe');
marinaStripe.stripeFor = () => fakeStripe;
require.cache[require.resolve('stripe')] = { id: 'stripe', filename: require.resolve('stripe'), loaded: true, exports: () => fakeStripe };
const { toStripeAmount, fromStripeAmount } = require('../src/lib/stripeAmount');
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

  await check('Stripe amounts: zero-decimal currencies are whole units', async () => {
    assert.equal(toStripeAmount(15300000, 'XPF'), 153000);
    assert.equal(toStripeAmount(15300000, 'xpf'), 153000);
    assert.equal(toStripeAmount(500000, 'jpy'), 5000);
    assert.equal(toStripeAmount(12345, 'GBP'), 12345);
    assert.equal(toStripeAmount(10000, 'ugx'), 10000); // Stripe takes UGX/ISK as two-decimal
    assert.equal(fromStripeAmount(153000, 'xpf'), 15300000);
    assert.equal(fromStripeAmount(12345, 'gbp'), 12345);
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

    // ---- Task 4: room booking emails ----
    const roomEmails = require('../src/lib/roomBookingEmails');
    const resend = require('../src/lib/resend');
    await check('cancelTermsLine wording', async () => {
      assert.equal(roomEmails.cancelTermsLine({ refundable: false }, null, 'Europe/London'), 'Non-refundable.');
      assert.match(roomEmails.cancelTermsLine({ refundable: true }, new Date('2030-07-07T23:00:00Z'), 'Europe/London'), /^Free cancellation until .*8 Jul.* 2030/);
    });
    await check('bookingUrl fills {id}', async () => {
      assert.equal(roomEmails.bookingUrl('https://h.test/stay/{id}', 'abc'), 'https://h.test/stay/abc');
      assert.equal(roomEmails.bookingUrl(null, 'abc'), null);
    });
    await check('sendConfirmation assembles the guest, plan, money and link', async () => {
      const id = await insertBooking({ room: R2, check_in: '2030-07-28', check_out: '2030-07-29', status: 'confirmed' });
      await pool.query(`UPDATE booking SET rate_plan_terms = '{"name":"Flex","refundable":true,"cancel_cutoff_hours":48,"payment_mode":"full","pay_at_hotel":true}' WHERE id = $1`, [id]);
      const real = resend.sendRoomConfirmation; const calls = [];
      resend.sendRoomConfirmation = async (args) => { calls.push(args); return 'em_1'; };
      try { await roomEmails.sendConfirmation(id); } finally { resend.sendRoomConfirmation = real; }
      assert.equal(calls.length, 1);
      const a = calls[0];
      assert.equal(a.to, `ana-${tag}@example.test`); assert.equal(a.planName, 'Flex');
      assert.equal(a.amountPaid, '0.00'); assert.equal(a.balanceDue, '100.00'); assert.equal(a.currency, 'GBP');
      assert.equal(a.manageUrl, `https://hotel.test/stay/${id}`);
      assert.match(a.cancelLine, /^Free cancellation until .*26 Jul.* 2030/);
      assert.equal(a.stay.nights, 1); assert.equal(a.stay.room_type_name, 'Double');
      await pool.query('DELETE FROM booking WHERE id = $1', [id]);
    });

    // ---- Task 5: creating bookings on a plan ----
    const bookings = require('../src/controllers/bookings');
    // Record guest emails instead of sending them, for the rest of the run.
    const sent = { payRequest: [], confirmation: [] };
    roomEmails.sendPayRequest = async (id) => { sent.payRequest.push(id); };
    roomEmails.sendConfirmation = async (id) => { sent.confirmation.push(id); };
    const dueInSecs = async (id) => Number((await one('SELECT EXTRACT(EPOCH FROM payment_due_at - now())::int AS s FROM booking WHERE id = $1', [id])).s);

    await check('no plan on a room type without plans: exactly today', async () => {
      const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: PLAIN_RT, check_in: '2030-07-02', check_out: '2030-07-04' });
      assert.equal(r.status, 201); assert.equal(r.body.status, 'confirmed'); assert.equal(r.body.rate_plan_id, null);
      assert.equal(r.body.total_price, '200.00'); assert.equal(r.body.rate_plan_terms, null); assert.equal(r.body.payment_due_at, null);
    });
    await check('api key cannot skip payment', async () => {
      const missing = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, check_in: '2030-07-06', check_out: '2030-07-07' });
      assert.equal(missing.status, 400); assert.match(missing.body.error, /rate_plan_id is required/);
      assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, pay_at_hotel: true, check_in: '2030-07-06', check_out: '2030-07-07' })).status, 403);
      assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_id: R1, check_in: '2030-07-06', check_out: '2030-07-07' })).status, 400); // by room too
    });
    await check('pay_at_hotel needs a plan and a boolean', async () => {
      assert.equal((await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: PLAIN_RT, pay_at_hotel: true, check_in: '2030-07-06', check_out: '2030-07-07' } })).status, 400);
      assert.equal((await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, pay_at_hotel: 'yes', check_in: '2030-07-06', check_out: '2030-07-07' } })).status, 400);
    });
    await check('api key Saver booking: pending_payment, 30 min, adjusted price, snapshot', async () => {
      const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, check_in: '2030-07-06', check_out: '2030-07-08' });
      assert.equal(r.status, 201); assert.equal(r.body.status, 'pending_payment'); assert.equal(r.body.total_price, '176.00');
      const secs = await dueInSecs(r.body.id); assert.ok(secs > 1700 && secs <= 1800, `due in ${secs}s`);
      assert.equal(r.body.rate_plan_id, SAVER);
      assert.deepEqual(r.body.rate_plan_terms, { name: 'Saver', adjustment_pct: -12, refundable: false, cancel_cutoff_hours: null, payment_mode: 'full', deposit_kind: null, deposit_value: null, pay_at_hotel: false });
      assert.ok(!sent.payRequest.includes(r.body.id)); // the website takes the card itself
    });
    await check('plan from another room type is 400', async () => {
      const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: PLAIN_RT, rate_plan_id: SAVER, check_in: '2030-07-06', check_out: '2030-07-07' });
      assert.equal(r.status, 400); assert.match(r.body.error, /Rate plan not found/);
      assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_id: R3, rate_plan_id: SAVER, check_in: '2030-07-06', check_out: '2030-07-07' })).status, 400);
    });
    await check('staff plan booking: 24 h and a pay-request email; pay_at_hotel confirms with a confirmation email', async () => {
      const pending = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: FLEX, check_in: '2030-07-10', check_out: '2030-07-11' } });
      assert.equal(pending.status, 201); assert.equal(pending.body.status, 'pending_payment'); assert.equal(pending.body.total_price, '100.00');
      const secs = await dueInSecs(pending.body.id); assert.ok(secs > 86300 && secs <= 86400, `due in ${secs}s`);
      assert.equal(sent.payRequest.at(-1), pending.body.id);
      const pah = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: FLEX, pay_at_hotel: true, check_in: '2030-07-12', check_out: '2030-07-13' } });
      assert.equal(pah.body.status, 'confirmed'); assert.equal(pah.body.payment_due_at, null); assert.equal(pah.body.rate_plan_terms.pay_at_hotel, true);
      assert.equal(sent.confirmation.at(-1), pah.body.id);
    });
    await check('preconditions: no Stripe keys / no room_booking_url are 409', async () => {
      await pool.query('UPDATE property SET stripe_secret_key = NULL WHERE id = $1', [P]);
      try {
        const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, check_in: '2030-07-14', check_out: '2030-07-15' });
        assert.equal(r.status, 409); assert.match(r.body.error, /Online payment is not set up/);
        const pah = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, pay_at_hotel: true, check_in: '2030-07-14', check_out: '2030-07-15' } });
        assert.equal(pah.status, 201); // pay at hotel needs no card
        await pool.query('DELETE FROM booking WHERE id = $1', [pah.body.id]);
        await pool.query('UPDATE room_availability SET is_available = true WHERE room_id = $1 AND date >= $2 AND date < $3', [pah.body.room_id, '2030-07-14', '2030-07-15']);
      } finally {
        await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check' WHERE id = $1", [P]);
      }
      await pool.query('UPDATE property SET room_booking_url = NULL WHERE id = $1', [P]);
      try {
        const r = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, check_in: '2030-07-14', check_out: '2030-07-15' } });
        assert.equal(r.status, 409); assert.match(r.body.error, /room booking page/);
      } finally {
        await pool.query("UPDATE property SET room_booking_url = 'https://hotel.test/stay/{id}' WHERE id = $1", [P]);
      }
    });
    await check('PUT cannot set system statuses', async () => {
      const id = await insertBooking({ room: R2, check_in: '2030-07-30', check_out: '2030-07-31', status: 'confirmed' });
      assert.equal((await staff(bookings.updateBooking, { params: { id }, body: { status: 'expired' } })).status, 400);
      assert.equal((await staff(bookings.updateBooking, { params: { id }, body: { status: 'pending_payment' } })).status, 400);
      await pool.query('DELETE FROM booking WHERE id = $1', [id]);
    });

    // ---- Task 6: search returns plans ----
    await check('search lists plans per room type; plain type has none', async () => {
      await pool.query('REFRESH MATERIALIZED VIEW room_type_availability');
      const r = await api('GET', '/api/availability/search?check_in=2030-07-20&check_out=2030-07-22&guests=1');
      assert.equal(r.status, 200);
      const rt = r.body.find((x) => x.room_type_id === RT); const plain = r.body.find((x) => x.room_type_id === PLAIN_RT);
      const byName = Object.fromEntries(rt.plans.map((p) => [p.name, p]));
      assert.deepEqual([byName.Saver.from_rate, byName.Saver.refundable], [88, false]);
      assert.deepEqual([byName.Flex.from_rate, byName.Flex.refundable], [100, true]);
      assert.ok(rt.plans.findIndex((p) => p.name === 'Saver') < rt.plans.findIndex((p) => p.name === 'Flex')); // sort_order
      assert.equal(byName.Saver.cancel_deadline, null);
      assert.equal(byName.Flex.cancel_deadline, '2030-07-17T23:00:00.000Z');
      assert.equal(byName.Flex.payment_mode, 'full'); // hold, but deadline > 6 days away
      assert.equal(byName.Saver.deposit, null);
      assert.ok(!('Old' in byName)); // archived
      assert.deepEqual(plain.plans, []);
      assert.ok('from_rate' in rt && 'min_available' in rt); // existing fields untouched
    });

    // ---- Task 7: card step ----
    const roomPayments = require('../src/lib/roomPayments');
    const plan = async (body) => (await staff(rp.createRatePlan, { params: { id: RT }, body: { sort_order: 5, ...body } })).body.id;
    const DEPOSIT20 = await plan({ name: 'Deposit', refundable: true, cancel_cutoff_hours: 48, payment_mode: 'deposit', deposit_kind: 'percent', deposit_value: 20 });
    const FLEX_FULL = await plan({ name: 'Flex Full', refundable: true, cancel_cutoff_hours: 48, payment_mode: 'full' });
    const FLEX_HOLD = FLEX;
    const EXTRA_25 = (await one("INSERT INTO extra (property_id, name, price) VALUES ($1, 'Breakfast', 25) RETURNING id", [P])).id;
    const piOf = async (id) => (await one('SELECT stripe_payment_intent_id FROM booking WHERE id = $1', [id])).stripe_payment_intent_id;
    const pi = async (id) => fakeStripe.store.get(await piOf(id));
    const dayFromToday = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const apiBooking = async (planId, check_in, check_out) => {
      const r = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT, rate_plan_id: planId, check_in, check_out });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body;
    };
    const apiBookingNear = (planId, days) => apiBooking(planId, dayFromToday(days), dayFromToday(days + 1));
    const succeed = async (id) => { const p = await pi(id); Object.assign(p, { status: 'succeeded', amount_received: p.amount }); };
    const paidBooking = async (planId, check_in, check_out) => {
      const b = await apiBooking(planId, check_in, check_out);
      assert.equal((await api('POST', `/api/bookings/${b.id}/payment-intent`)).status, 200);
      await succeed(b.id);
      const c = await api('POST', `/api/bookings/${b.id}/confirm-payment`);
      assert.equal(c.body.status, 'confirmed');
      return c.body;
    };
    const paymentRows = async (id) => (await pool.query('SELECT amount, status FROM payment WHERE booking_id = $1', [id])).rows;

    await check('payment-intent: Saver full charge, idempotent', async () => {
      const b = await apiBooking(SAVER, '2030-07-14', '2030-07-16'); // 176.00
      const p1 = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      const p2 = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(p1.status, 200); assert.equal(p1.body.amount, '176.00'); assert.equal(p1.body.mode, 'full');
      assert.equal(p1.body.publishable_key, 'pk_test_check');
      assert.equal(p1.body.client_secret, p2.body.client_secret);
      assert.equal((await pi(b.id)).capture_method, 'automatic'); assert.equal((await pi(b.id)).currency, 'gbp');
    });
    await check('payment-intent updates amount after an extra is added', async () => {
      const b = await apiBooking(SAVER, '2030-07-17', '2030-07-18'); // 88.00
      assert.equal((await api('POST', `/api/bookings/${b.id}/payment-intent`)).body.amount, '88.00');
      assert.equal((await api('POST', `/api/extras/booking/${b.id}`, { extra_id: EXTRA_25 })).status, 201);
      const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(p.body.amount, '113.00'); assert.equal((await pi(b.id)).amount, 11300);
    });
    await check('deposit plan charges the deposit; confirm records a completed payment', async () => {
      const b = await apiBooking(DEPOSIT20, '2030-07-24', '2030-07-26'); // 200.00, 20%
      const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(p.body.amount, '40.00'); assert.equal(p.body.mode, 'deposit');
      await succeed(b.id);
      const c = await api('POST', `/api/bookings/${b.id}/confirm-payment`);
      assert.equal(c.status, 200); assert.equal(c.body.status, 'confirmed'); assert.equal(c.body.payment_due_at, null);
      assert.deepEqual(await paymentRows(b.id), [{ amount: '40.00', status: 'completed' }]);
      assert.equal((await api('POST', `/api/bookings/${b.id}/confirm-payment`)).status, 200); // idempotent
      assert.equal((await paymentRows(b.id)).length, 1);
      assert.ok(sent.confirmation.includes(b.id));
    });
    await check('hold within 6 days uses manual capture and no payment row', async () => {
      const b = await apiBookingNear(FLEX_HOLD, 4);
      const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(p.body.mode, 'hold'); assert.equal((await pi(b.id)).capture_method, 'manual');
      (await pi(b.id)).status = 'requires_capture';
      assert.equal((await api('POST', `/api/bookings/${b.id}/confirm-payment`)).body.status, 'confirmed');
      assert.equal((await paymentRows(b.id)).length, 0);
      assert.equal((await one('SELECT rate_plan_terms FROM booking WHERE id = $1', [b.id])).rate_plan_terms.mode_used, 'hold');
    });
    await check('confirm-payment before the card succeeds is 409', async () => {
      const b = await apiBooking(SAVER, '2030-07-19', '2030-07-20');
      const none = await api('POST', `/api/bookings/${b.id}/confirm-payment`);
      assert.equal(none.status, 409); assert.match(none.body.error, /No payment started/);
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      const r = await api('POST', `/api/bookings/${b.id}/confirm-payment`);
      assert.equal(r.status, 409); assert.equal(r.body.details, 'requires_payment_method');
      assert.equal((await one('SELECT status FROM booking WHERE id = $1', [b.id])).status, 'pending_payment');
    });
    await check('payment-intent on a confirmed booking is 409', async () => {
      const id = await insertBooking({ room: R2, check_in: '2030-07-30', check_out: '2030-07-31', status: 'confirmed' });
      assert.equal((await api('POST', `/api/bookings/${id}/payment-intent`)).status, 409);
      await pool.query('DELETE FROM booking WHERE id = $1', [id]);
    });
    await check('staff confirm by hand cancels the PI and marks pay_at_hotel', async () => {
      const b = await apiBooking(SAVER, '2030-07-27', '2030-07-28');
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal((await staff(bookings.updateBooking, { params: { id: b.id }, body: { status: 'checked_in' } })).status, 409); // confirm or DELETE first
      assert.equal((await staff(bookings.updateBooking, { params: { id: b.id }, body: { status: 'cancelled' } })).status, 409);
      const r = await staff(bookings.updateBooking, { params: { id: b.id }, body: { status: 'confirmed' } });
      assert.equal(r.status, 200); assert.equal(r.body.status, 'confirmed'); assert.equal(r.body.payment_due_at, null);
      assert.equal((await pi(b.id)).status, 'canceled');
      assert.equal((await one('SELECT rate_plan_terms FROM booking WHERE id = $1', [b.id])).rate_plan_terms.pay_at_hotel, true);
      assert.ok(sent.confirmation.includes(b.id));
    });

    // ---- Task 8: cancellation policy ----
    const paidBookingNear = (planId, days) => paidBooking(planId, dayFromToday(days), dayFromToday(days + 1));
    const statusOf = async (id) => (await one('SELECT status FROM booking WHERE id = $1', [id])).status;
    const REFUSAL = 'This booking can no longer be cancelled online. Please contact the hotel.';
    await check('guest cancels Flex before the deadline: refunded', async () => {
      const b = await paidBooking(FLEX_FULL, '2030-07-29', '2030-07-30');
      const r = await api('DELETE', `/api/bookings/${b.id}`);
      assert.equal(r.status, 200); assert.equal(r.body.status, 'cancelled');
      assert.equal((await pi(b.id)).refunded, true);
      assert.deepEqual((await paymentRows(b.id)).map((p) => p.status), ['refunded']);
    });
    await check('guest cannot cancel Saver or late Flex online', async () => {
      const s = await paidBooking(SAVER, '2030-07-30', '2030-07-31');
      const r = await api('DELETE', `/api/bookings/${s.id}`);
      assert.equal(r.status, 409); assert.equal(r.body.error, REFUSAL); assert.equal(r.body.details, 'non-refundable');
      assert.equal(await statusOf(s.id), 'confirmed');
      const late = await paidBookingNear(FLEX_FULL, 1); // deadline (48 h before tomorrow's midnight) has passed
      const l = await api('DELETE', `/api/bookings/${late.id}`);
      assert.equal(l.status, 409); assert.equal(l.body.error, REFUSAL); assert.match(l.body.details, /^Free cancellation ended /);
      assert.equal((await pi(late.id)).refunded, undefined);
    });
    await check('staff cancel never refunds; an uncaptured hold is released', async () => {
      const s = await paidBooking(SAVER, '2030-07-25', '2030-07-26');
      const r = await staff(bookings.cancelBooking, { params: { id: s.id } });
      assert.equal(r.status, 200); assert.equal(r.body.status, 'cancelled');
      assert.equal((await pi(s.id)).refunded, undefined);
      assert.deepEqual((await paymentRows(s.id)).map((p) => p.status), ['completed']);
      const h = await apiBookingNear(FLEX_HOLD, 6);
      assert.equal((await api('POST', `/api/bookings/${h.id}/payment-intent`)).body.mode, 'hold');
      (await pi(h.id)).status = 'requires_capture';
      await api('POST', `/api/bookings/${h.id}/confirm-payment`);
      assert.equal((await staff(bookings.cancelBooking, { params: { id: h.id } })).body.status, 'cancelled');
      assert.equal((await pi(h.id)).status, 'canceled');
    });
    await check('cancelling pending_payment releases an open PI and refunds a just-succeeded one', async () => {
      const open = await apiBooking(SAVER, '2030-07-22', '2030-07-23');
      await api('POST', `/api/bookings/${open.id}/payment-intent`);
      assert.equal((await api('DELETE', `/api/bookings/${open.id}`)).status, 200);
      assert.equal((await pi(open.id)).status, 'canceled');
      const b = await apiBooking(SAVER, '2030-07-21', '2030-07-22');
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      await succeed(b.id);
      const r = await api('DELETE', `/api/bookings/${b.id}`);
      assert.equal(r.status, 200); assert.equal(r.body.status, 'cancelled');
      assert.equal((await pi(b.id)).refunded, true);
    });
    await check('Stripe failure leaves the booking untouched', async () => {
      const b = await paidBooking(FLEX_FULL, '2030-07-23', '2030-07-24');
      fakeStripe.failNextRefund = true;
      const r = await api('DELETE', `/api/bookings/${b.id}`);
      assert.equal(r.status, 502);
      assert.equal(await statusOf(b.id), 'confirmed');
      assert.deepEqual((await paymentRows(b.id)).map((p) => p.status), ['completed']);
    });
    await check('no-plan booking cancels exactly as today', async () => {
      const b = (await api('POST', '/api/bookings', { guest_id: G, room_type_id: PLAIN_RT, check_in: '2030-07-08', check_out: '2030-07-09' })).body;
      const r = await api('DELETE', `/api/bookings/${b.id}`);
      assert.equal(r.status, 200); assert.equal(r.body.status, 'cancelled');
      assert.equal((await one('SELECT is_available FROM room_availability WHERE room_id = $1 AND date = $2', [b.room_id, '2030-07-08'])).is_available, true);
      assert.equal((await api('DELETE', `/api/bookings/${b.id}`)).status, 404); // already cancelled
    });

    // ---- Task 9: expiry and hold-capture jobs ----
    const overdue = (id) => pool.query("UPDATE booking SET payment_due_at = now() - interval '1 minute' WHERE id = $1", [id]);
    await check('expiry: unpaid booking expires and frees the room', async () => {
      const b = await apiBooking(SAVER, '2030-07-03', '2030-07-04');
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      await overdue(b.id);
      const out = await roomPayments.expireOnce();
      assert.equal(out.expired, 1);
      assert.equal(await statusOf(b.id), 'expired');
      assert.equal((await pi(b.id)).status, 'canceled');
      const again = await api('POST', '/api/bookings', { guest_id: G, room_id: b.room_id, rate_plan_id: SAVER, check_in: '2030-07-03', check_out: '2030-07-04' });
      assert.equal(again.status, 201);
    });
    await check('expiry confirms a paid-but-unconfirmed booking', async () => {
      const b = await apiBooking(SAVER, '2030-07-05', '2030-07-06');
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      await succeed(b.id);
      await overdue(b.id);
      assert.deepEqual(await roomPayments.expireOnce(), { expired: 0, confirmed: 1 });
      assert.equal(await statusOf(b.id), 'confirmed');
      assert.deepEqual((await paymentRows(b.id)).map((p) => p.amount), ['88.00']);
    });
    await check('hold captured once the deadline passes; failure marked, not retried', async () => {
      const heldBooking = async (days) => {
        const h = await apiBookingNear(FLEX_HOLD, days);
        assert.equal((await api('POST', `/api/bookings/${h.id}/payment-intent`)).body.mode, 'hold');
        (await pi(h.id)).status = 'requires_capture';
        assert.equal((await api('POST', `/api/bookings/${h.id}/confirm-payment`)).body.status, 'confirmed');
        return h;
      };
      // The snapshot is what's enforced: a long cutoff puts the deadline in the past.
      const pastDeadline = (id) => pool.query("UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{cancel_cutoff_hours}', '500') WHERE id = $1", [id]);
      const b = await heldBooking(3);
      assert.deepEqual(await roomPayments.captureHoldsOnce(), { captured: 0, failed: 0 }); // deadline still ahead
      await pastDeadline(b.id);
      assert.deepEqual(await roomPayments.captureHoldsOnce(), { captured: 1, failed: 0 });
      assert.equal((await pi(b.id)).status, 'succeeded');
      assert.deepEqual(await paymentRows(b.id), [{ amount: '100.00', status: 'completed' }]);
      const c = await heldBooking(5); await pastDeadline(c.id); fakeStripe.failNextCapture = true;
      assert.deepEqual(await roomPayments.captureHoldsOnce(), { captured: 0, failed: 1 });
      assert.deepEqual(await roomPayments.captureHoldsOnce(), { captured: 0, failed: 0 }); // not retried
      assert.ok((await one('SELECT rate_plan_terms FROM booking WHERE id = $1', [c.id])).rate_plan_terms.capture_failed);
    });

    // ---- Final review fixes ----
    await check('extras need a positive whole quantity (a guest cannot zero the bill)', async () => {
      const b = await apiBooking(SAVER, '2030-07-09', '2030-07-10'); // 88.00
      for (const quantity of [-4, 0, 1.5, '-1', 'abc']) {
        assert.equal((await api('POST', `/api/extras/booking/${b.id}`, { extra_id: EXTRA_25, quantity })).status, 400, `quantity ${quantity}`);
      }
      const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(p.body.amount, '88.00'); assert.equal(await statusOf(b.id), 'pending_payment');
    });
    await check('expiry settles a booking paid at the desk instead of expiring it', async () => {
      const s = await staff(bookings.createBooking, { body: { guest_id: G, room_type_id: RT, rate_plan_id: SAVER, check_in: '2030-07-15', check_out: '2030-07-16' } });
      await pool.query(`INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at) VALUES ($1, $2, 88, 'card', 'completed', now())`, [P, s.body.id]);
      await overdue(s.body.id);
      assert.deepEqual(await roomPayments.expireOnce(), { expired: 0, confirmed: 1 });
      assert.equal(await statusOf(s.body.id), 'confirmed');
      assert.equal((await one('SELECT rate_plan_terms FROM booking WHERE id = $1', [s.body.id])).rate_plan_terms.pay_at_hotel, true);
    });
    await check('zero balance cancels the open card form before confirming', async () => {
      const b = await apiBooking(SAVER, '2030-07-18', '2030-07-19');
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      await pool.query(`INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at) VALUES ($1, $2, 88, 'cash', 'completed', now())`, [P, b.id]);
      const r = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(r.status, 200); assert.equal(r.body.status, 'confirmed');
      assert.equal((await pi(b.id)).status, 'canceled');
    });
    await check('payment-intent on an already-paid PI confirms instead of re-serving the form', async () => {
      const b = await apiBooking(SAVER, '2030-07-20', '2030-07-21');
      await api('POST', `/api/bookings/${b.id}/payment-intent`);
      await succeed(b.id);
      const r = await api('POST', `/api/bookings/${b.id}/payment-intent`);
      assert.equal(r.status, 200); assert.equal(r.body.status, 'confirmed');
      assert.equal((await paymentRows(b.id)).length, 1);
    });
    await check('overlapping capture sweeps record one payment', async () => {
      const h = await apiBookingNear(FLEX_HOLD, 7);
      assert.equal((await api('POST', `/api/bookings/${h.id}/payment-intent`)).body.mode, 'hold');
      (await pi(h.id)).status = 'requires_capture';
      await api('POST', `/api/bookings/${h.id}/confirm-payment`);
      await pool.query("UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{cancel_cutoff_hours}', '500') WHERE id = $1", [h.id]);
      await Promise.all([roomPayments.captureHoldsOnce(), roomPayments.captureHoldsOnce()]);
      assert.equal((await paymentRows(h.id)).length, 1);
    });
    await check('a due hold is captured even behind 200 not-yet-due holds', async () => {
      // 202 confirmed holds far ahead (deadline not reached), inserted first.
      await pool.query(
        `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status, stripe_payment_intent_id, rate_plan_terms)
         SELECT $1, $2, r, d::date, d::date + 1, 100, 'confirmed', 'pi_not_due',
                '{"refundable":true,"cancel_cutoff_hours":48,"payment_mode":"hold","mode_used":"hold"}'
         FROM unnest($3::uuid[]) r, generate_series('2031-01-01'::date, '2031-04-11'::date, '1 day') d`,
        [P, G, [R3, R4]]);
      const h = await apiBookingNear(FLEX_HOLD, 8);
      (await api('POST', `/api/bookings/${h.id}/payment-intent`));
      (await pi(h.id)).status = 'requires_capture';
      await api('POST', `/api/bookings/${h.id}/confirm-payment`);
      await pool.query("UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{cancel_cutoff_hours}', '500') WHERE id = $1", [h.id]);
      await roomPayments.captureHoldsOnce();
      assert.equal((await pi(h.id)).status, 'succeeded');
      await pool.query("DELETE FROM booking WHERE stripe_payment_intent_id = 'pi_not_due' AND property_id = $1", [P]);
    });

    // ---- Zero-decimal currencies (XPF) ----
    await check('XPF: room payment, hold capture and folio charge whole francs', async () => {
      await pool.query("UPDATE property SET currency = 'XPF' WHERE id = $1", [P]);
      try {
        const b = await apiBooking(SAVER, '2030-07-31', '2030-08-01'); // 88 XPF
        const p = await api('POST', `/api/bookings/${b.id}/payment-intent`);
        assert.equal(p.body.amount, '88.00');
        assert.equal((await pi(b.id)).amount, 88); assert.equal((await pi(b.id)).currency, 'xpf');
        await succeed(b.id);
        assert.equal((await api('POST', `/api/bookings/${b.id}/confirm-payment`)).body.status, 'confirmed');
        assert.deepEqual(await paymentRows(b.id), [{ amount: '88.00', status: 'completed' }]);

        const h = await apiBookingNear(FLEX_HOLD, 6); // 100 XPF hold
        assert.equal((await api('POST', `/api/bookings/${h.id}/payment-intent`)).body.mode, 'hold');
        assert.equal((await pi(h.id)).amount, 100);
        (await pi(h.id)).status = 'requires_capture';
        await api('POST', `/api/bookings/${h.id}/confirm-payment`);
        await pool.query("UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{cancel_cutoff_hours}', '500') WHERE id = $1", [h.id]);
        await roomPayments.captureHoldsOnce();
        assert.deepEqual(await paymentRows(h.id), [{ amount: '100.00', status: 'completed' }]);

        const f = await insertBooking({ room: R3, check_in: '2030-07-20', check_out: '2030-07-21', status: 'confirmed' }); // 100 XPF
        const fp = await staff(folioCtrl.createFolioPaymentIntent, { params: { id: f } });
        assert.equal(fp.status, 200, JSON.stringify(fp.body));
        const fpi = fakeStripe.store.get(fp.body.payment_intent_id);
        assert.equal(fpi.amount, 100); assert.equal(fpi.currency, 'xpf'); assert.equal(fp.body.amount, 100); // response amount = the Stripe amount
        fpi.status = 'succeeded';
        const fc = await staff(folioCtrl.confirmFolioPayment, { params: { id: f }, body: { stripe_payment_intent_id: fpi.id } });
        assert.equal(fc.status, 200, JSON.stringify(fc.body)); assert.equal(fc.body.amount, '100.00');

        // Spa Tap to Pay: 4,500 XPF treatment
        const spaCtrl = require('../src/controllers/spaPayments');
        const spaId = (await one("INSERT INTO spa (property_id, name) VALUES ($1, 'Spa') RETURNING id", [P])).id;
        const th = (await one("INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Tia') RETURNING id", [P, spaId])).id;
        const tr = (await one("INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Massage', 60, 4500) RETURNING id", [P, spaId])).id;
        const ap = (await one(
          `INSERT INTO spa_appointment (property_id, treatment_id, therapist_id, appointment_date, start_time, end_time, contact_name, price)
           VALUES ($1, $2, $3, '2030-07-15', '10:00', '11:00', 'Ana', 4500) RETURNING id`, [P, tr, th])).id;
        const sp = await staff(spaCtrl.createAppointmentPaymentIntent, { params: { id: ap, spa_id: spaId } });
        assert.equal(sp.status, 200, JSON.stringify(sp.body));
        const spi = fakeStripe.store.get(sp.body.payment_intent_id);
        assert.equal(spi.amount, 4500); assert.equal(spi.currency, 'xpf'); assert.equal(sp.body.amount, 4500);
        spi.status = 'succeeded';
        assert.equal((await staff(spaCtrl.confirmAppointmentPayment, { params: { id: ap, spa_id: spaId }, body: { stripe_payment_intent_id: spi.id } })).status, 200);
      } finally {
        await pool.query("UPDATE property SET currency = 'GBP' WHERE id = $1", [P]);
      }
    });
  } finally {
    const props = [P, Q];
    await pool.query('DELETE FROM payment WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM booking_extra WHERE booking_id IN (SELECT id FROM booking WHERE property_id = ANY($1))', [props]);
    await pool.query('DELETE FROM booking WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_availability WHERE property_id = ANY($1)', [props]);
    for (const t of ['spa_appointment', 'spa_treatment', 'spa_therapist', 'spa']) await pool.query(`DELETE FROM ${t} WHERE property_id = ANY($1)`, [props]);
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
