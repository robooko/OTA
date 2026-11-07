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

  // ---- Task 2: pure ----
  const { pickBasket } = require('../src/lib/roomQuote');
  await check('pickBasket: lowest total under stock, picks forced', async () => {
    const two = { A: { price: 100, max_occupancy: 2 }, B: { price: 150, max_occupancy: 4 } };
    assert.deepEqual(pickBasket([{ guests: 2 }, { guests: 2 }], two, { A: 1, B: 5 }), { types: ['A', 'B'], total: 250 });
    assert.deepEqual(pickBasket([{ guests: 3 }], two, { A: 1, B: 5 }), { types: ['B'], total: 150 });
    assert.equal(pickBasket([{ guests: 2 }], two, { A: 0, B: 0 }), null);
    // Greedy room-by-room would give room 0 the cheap A and room 1 the 300 C.
    const g = { A: { price: 100, max_occupancy: 4 }, B: { price: 120, max_occupancy: 2 }, C: { price: 300, max_occupancy: 4 } };
    assert.deepEqual(pickBasket([{ guests: 2 }, { guests: 4 }], g, { A: 1, B: 5, C: 5 }), { types: ['B', 'A'], total: 220 });
    assert.deepEqual(pickBasket([{ guests: 2, pick: 'B' }, { guests: 2 }], two, { A: 1, B: 5 }), { types: ['B', 'A'], total: 250 });
  });
  await check('stayPrice: type rate, else base; adjustment per night', async () => {
    assert.equal(ratePlans.stayPrice(['2030-01-01', '2030-01-02'], { '2030-01-01': 120 }, 100, {}, -10), 198);
    assert.equal(ratePlans.stayPrice(['2030-01-01'], {}, 100, { '2030-01-01': 80 }, null), 80);
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

    // ---- Task 2: quote ----
    // Std: 2 guests, 100, 1 room. Dlx: 3 guests, 150, 3 rooms. Saver -10% full; Flex hold 48h.
    const IN = '2031-03-10'; const OUT = '2031-03-12'; const N = 2;
    const STD = await roomType('Std', 2, 100);
    const DLX = await roomType('Dlx', 3, 150);
    const roomIds = [];
    for (const [t, nums] of [[STD, ['S1']], [DLX, ['D1', 'D2', 'D3']]]) {
      for (const n of nums) roomIds.push((await one('INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3) RETURNING id', [P, t, n])).id);
    }
    await pool.query(
      `INSERT INTO room_availability (property_id, room_id, date)
       SELECT $1, r, d::date FROM unnest($2::uuid[]) r, generate_series('2031-03-01'::date, '2031-03-31'::date, '1 day') d
       ON CONFLICT DO NOTHING`, [P, roomIds]);
    const plans = {};
    for (const t of [STD, DLX]) {
      plans[t] = {
        Saver: (await staff(rp.createRatePlan, { params: { id: t }, body: { name: 'Saver', adjustment_pct: -10, refundable: false, payment_mode: 'full' } })).body.id,
        Flex: (await staff(rp.createRatePlan, { params: { id: t }, body: { name: 'Flex', refundable: true, cancel_cutoff_hours: 48, payment_mode: 'hold' } })).body.id,
      };
    }
    const quote = (body, key) => api('POST', '/api/availability/quote', { check_in: IN, check_out: OUT, ...body }, key);
    let Q1;
    await check('quote: cheapest types at the cheapest rate, options priced as deltas', async () => {
      const r = await quote({ rooms: [{ adults: 2 }, { adults: 1, children: 1 }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      Q1 = r.body;
      assert.equal(Q1.available, true); assert.equal(Q1.rate, 'Saver'); assert.equal(Q1.nights, N); assert.equal(Q1.currency, 'GBP');
      assert.deepEqual(Q1.rooms.map((x) => x.room_type_id), [STD, DLX]);
      assert.deepEqual(Q1.rooms.map((x) => x.rate_plan_id), [plans[STD].Saver, plans[DLX].Saver]);
      assert.equal(Q1.rooms[1].guests, 2); assert.equal(Q1.rooms[1].children, 1);
      assert.equal(Q1.total, (90 + 135) * N);
      assert.equal(Q1.terms.payment_mode, 'full'); assert.equal(Q1.terms.name, 'Saver');
      const opt = Q1.rooms[0].options.find((o) => o.room_type_id === DLX);
      assert.equal(opt.price, 135 * N); assert.equal(opt.delta, 45 * N); assert.equal(opt.rate_plan_id, plans[DLX].Saver);
      assert.equal(Q1.rooms[1].options.length, 0); // the only Std is in room 1
      assert.deepEqual(Q1.rates.map((x) => [x.rate, x.total]), [['Saver', 450], ['Flex', 500]]);
    });
    await check('quote: a chosen rate and a picked type are honoured', async () => {
      const r = await quote({ rate: 'Flex', rooms: [{ adults: 2, room_type_id: DLX }, { adults: 2 }] });
      assert.equal(r.body.rate, 'Flex');
      assert.deepEqual(r.body.rooms.map((x) => x.room_type_id), [DLX, STD]);
      assert.deepEqual(r.body.rooms.map((x) => x.rate_plan_id), [plans[DLX].Flex, plans[STD].Flex]);
      assert.equal(r.body.total, 500);
    });
    await check('quote: too many guests / not enough rooms come back unavailable', async () => {
      const big = await quote({ rooms: [{ adults: 2 }, { adults: 5 }] });
      assert.equal(big.status, 200); assert.equal(big.body.available, false);
      assert.deepEqual(big.body.unavailable, [{ room: 1, reason: 'too_many_guests' }]);
      const many = await quote({ rooms: Array.from({ length: 5 }, () => ({ adults: 1 })) });
      assert.equal(many.body.available, false);
      assert.deepEqual(many.body.unavailable, [{ room: null, reason: 'not_enough_rooms' }]);
    });
    await check('quote: bad input is 400', async () => {
      assert.equal((await quote({ rooms: Array.from({ length: 11 }, () => ({ adults: 1 })) })).status, 400);
      assert.equal((await quote({ rooms: [] })).status, 400);
      assert.equal((await quote({ rooms: [{ adults: 0 }] })).status, 400);
      assert.equal((await api('POST', '/api/availability/quote', { check_in: OUT, check_out: IN, rooms: [{ adults: 1 }] })).status, 400);
      assert.equal((await quote({ rooms: [{ adults: 1 }] }, null)).status, 400); // no key, no property_id
      assert.equal((await api('POST', '/api/availability/quote', { property_id: P, check_in: IN, check_out: OUT, rooms: [{ adults: 1 }] }, null)).status, 200);
    });
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
