// Multi-room room bookings checks (docs/superpowers/specs/2026-11-07-multi-room-bookings-design.md).
// Pure helpers are asserted directly; HTTP checks run the real app on an
// ephemeral port with fixtures under throwaway properties, deleted at the end
// (pass or fail). Stripe is the in-memory fake. Local DB only, with
// migrate-2026-11-07-multi-room-bookings.sql applied.
//   node -r dotenv/config scripts/check-multi-room-bookings.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');
const marinaStripe = require('../src/lib/marinaStripe');
const fakeStripe = require('./fake-stripe');
marinaStripe.stripeFor = () => fakeStripe;
require.cache[require.resolve('stripe')] = { id: 'stripe', filename: require.resolve('stripe'), loaded: true, exports: () => fakeStripe };
const ratePlans = require('../src/lib/ratePlans');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Task 1: pure ----
  await check('sameTerms compares payment/cancel terms, numeric-safe', async () => {
    const a = { payment_mode: 'deposit', refundable: true, cancel_cutoff_hours: 48, deposit_kind: 'percent', deposit_value: '20.00', adjustment_pct: -10 };
    assert.equal(ratePlans.sameTerms(a, { ...a, deposit_value: 20, adjustment_pct: 0 }), true);
    assert.equal(ratePlans.sameTerms(a, { ...a, cancel_cutoff_hours: 24 }), false);
    assert.equal(ratePlans.sameTerms(a, { ...a, payment_mode: 'full', deposit_kind: null, deposit_value: null }), false);
  });

  // ---- HTTP ----
  const app = require('../src/app');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `multi_room_check_${tag}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(
    `INSERT INTO property (name, timezone, currency, stripe_secret_key, stripe_publishable_key, room_booking_url)
     VALUES ('Multi Room Check', 'Europe/London', 'GBP', 'sk_test_check', 'pk_test_check', 'https://hotel.test/stay/{id}') RETURNING id`)).id;
  await apiKeys.create(pool, { property_id: P }, { key: KEY });
  const props = [P];

  const api = async (method, path, body, key = KEY) => {
    const r = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(key && { 'X-Api-Key': key }) }, body: body ? JSON.stringify(body) : undefined,
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
  const rp = require('../src/controllers/ratePlans');
  const roomType = async (name, occ, rate) => (await one(
    'INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, $2, $3, $4) RETURNING id', [P, name, occ, rate])).id;

  try {
    // ---- Task 1: same-name rate plans share terms ----
    const TA = await roomType('Guard A', 2, 100);
    const TB = await roomType('Guard B', 2, 100);
    await check('same-name plan with different terms is 409; adjustment may differ', async () => {
      const a = await staff(rp.createRatePlan, { params: { id: TA }, body: { name: 'Saver', refundable: false, payment_mode: 'full' } });
      assert.equal(a.status, 201);
      const clash = await staff(rp.createRatePlan, { params: { id: TB }, body: { name: 'saver', refundable: true, cancel_cutoff_hours: 48, payment_mode: 'hold' } });
      assert.equal(clash.status, 409); assert.match(clash.body.error, /saver/i);
      const ok = await staff(rp.createRatePlan, { params: { id: TB }, body: { name: 'Saver', refundable: false, payment_mode: 'full', adjustment_pct: -5 } });
      assert.equal(ok.status, 201);
      const upd = await staff(rp.updateRatePlan, { params: { id: TB, plan_id: ok.body.id }, body: { payment_mode: 'deposit', deposit_kind: 'percent', deposit_value: 20 } });
      assert.equal(upd.status, 409);
      const arch = await staff(rp.updateRatePlan, { params: { id: TB, plan_id: ok.body.id }, body: { status: 'archived', payment_mode: 'deposit', deposit_kind: 'percent', deposit_value: 20 } });
      assert.equal(arch.status, 200);
    });
    await pool.query('DELETE FROM rate_plan WHERE property_id = $1', [P]);
  } finally {
    await pool.query('DELETE FROM payment WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM booking_extra WHERE booking_id IN (SELECT id FROM booking WHERE property_id = ANY($1))', [props]);
    await pool.query('DELETE FROM booking WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_availability WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_type_rate WHERE property_id = ANY($1)', [props]);
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
