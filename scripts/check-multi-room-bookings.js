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

  // ---- Task 4: pure ----
  const { splitCents } = require('../src/lib/roomPayments');
  await check('splitCents: proportional, largest remainder, sums exactly', async () => {
    assert.deepEqual(splitCents(1000, [1, 1, 1]), [334, 333, 333]);
    assert.equal(splitCents(999, [0, 0]).reduce((a, b) => a + b, 0), 999);
    assert.deepEqual(splitCents(500, [300, 200]), [300, 200]);
    assert.deepEqual(splitCents(0, [300, 200]), [0, 0]);
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

    // ---- Task 3: multi-room create ----
    const bookingsCtrl = require('../src/controllers/bookings');
    const G = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Ana', 'Guest', $2) RETURNING id`, [P, `ana-${tag}@example.test`])).id;
    // Deleting bookings directly leaves their rooms' flags closed (= staff blocks): reopen them.
    const clear = async () => {
      await pool.query('DELETE FROM payment WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM booking_extra WHERE booking_id IN (SELECT id FROM booking WHERE property_id = $1)', [P]);
      await pool.query('DELETE FROM booking WHERE property_id = $1', [P]);
      await pool.query('UPDATE room_availability SET is_available = true WHERE property_id = $1', [P]);
    };
    const basket = (rooms, extra = {}) => ({ guest_id: G, check_in: IN, check_out: OUT, rooms, ...extra });
    const fromQuote = (q) => q.rooms.map((r) => ({ room_type_id: r.room_type_id, rate_plan_id: r.rate_plan_id, guests: r.guests }));
    await check('create: the quoted basket books as one group, pending one payment', async () => {
      const r = await api('POST', '/api/bookings', basket(fromQuote(Q1)));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const bs = r.body.bookings;
      assert.equal(bs.length, 2); assert.ok(r.body.group_id);
      assert.ok(bs.every((b) => b.group_id === r.body.group_id && b.status === 'pending_payment' && b.website_checkout));
      assert.equal(bs[0].payment_due_at, bs[1].payment_due_at);
      assert.equal(bs.reduce((a, b) => a + Number(b.total_price), 0), Q1.total);
      assert.equal(r.body.total_price, Q1.total.toFixed(2)); assert.equal(r.body.status, 'pending_payment');
      assert.deepEqual(bs.map((b) => b.room_type_id), [STD, DLX]);
    });
    await clear();
    await check('create: rooms on different rates is 400', async () => {
      const r = await api('POST', '/api/bookings', basket([
        { room_type_id: STD, rate_plan_id: plans[STD].Saver, guests: 2 }, { room_type_id: DLX, rate_plan_id: plans[DLX].Flex, guests: 2 }]));
      assert.equal(r.status, 400); assert.match(r.body.error, /one rate/);
    });
    await check('create: plan missing on a plan type (website), too many guests, both forms: 400', async () => {
      assert.equal((await api('POST', '/api/bookings', basket([{ room_type_id: DLX, rate_plan_id: plans[DLX].Saver }, { room_type_id: DLX }]))).status, 400);
      const big = await api('POST', '/api/bookings', basket([{ room_type_id: STD, rate_plan_id: plans[STD].Saver, guests: 3 }, { room_type_id: DLX, rate_plan_id: plans[DLX].Saver }]));
      assert.equal(big.status, 400); assert.match(big.body.error, /guests/);
      assert.equal((await api('POST', '/api/bookings', basket([{ room_type_id: DLX, rate_plan_id: plans[DLX].Saver }], { room_type_id: DLX }))).status, 400);
      assert.equal((await api('POST', '/api/bookings', basket(Array.from({ length: 11 }, () => ({ room_type_id: DLX }))))).status, 400);
      assert.equal((await api('POST', '/api/bookings', basket([{ room_type_id: DLX, room_id: roomIds[1] }]))).status, 400);
    });
    const countRows = async () => Number((await one(
      'SELECT (SELECT count(*) FROM booking WHERE property_id = $1) + (SELECT count(*) FROM booking_night WHERE property_id = $1) AS n', [P])).n);
    await check('create: all or nothing (2 x Std, 1 in stock) is 409 and leaves no rows', async () => {
      const r = await api('POST', '/api/bookings', basket([
        { room_type_id: STD, rate_plan_id: plans[STD].Saver }, { room_type_id: STD, rate_plan_id: plans[STD].Saver }]));
      assert.equal(r.status, 409);
      assert.equal(await countRows(), 0);
    });
    await check('create: two baskets racing for the last Std: one wins, the loser leaves nothing', async () => {
      const rooms = [{ room_type_id: DLX, rate_plan_id: plans[DLX].Saver }, { room_type_id: STD, rate_plan_id: plans[STD].Saver }];
      const rs = await Promise.all([api('POST', '/api/bookings', basket(rooms)), api('POST', '/api/bookings', basket(rooms))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], JSON.stringify(rs.map((r) => r.body)));
      assert.equal(Number((await one('SELECT count(*) AS n FROM booking WHERE property_id = $1', [P])).n), 2);
    });
    await clear();
    await check('create: staff pay-at-hotel basket is confirmed', async () => {
      const r = await staff(bookingsCtrl.createBooking, { body: basket([
        { room_type_id: DLX, rate_plan_id: plans[DLX].Saver, guests: 2 }, { room_type_id: DLX, rate_plan_id: plans[DLX].Saver, guests: 3 }],
      { pay_at_hotel: true, source: 'phone', send_emails: false }) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.bookings.every((b) => b.status === 'confirmed' && b.rate_plan_terms.pay_at_hotel));
      assert.deepEqual(r.body.bookings.map((b) => b.guests), [2, 3]);
    });
    await clear();
    await check('create: single-room request and response are unchanged', async () => {
      const r = await api('POST', '/api/bookings', { guest_id: G, check_in: IN, check_out: OUT, room_type_id: DLX, rate_plan_id: plans[DLX].Saver });
      assert.equal(r.status, 201); assert.ok(r.body.id); assert.equal(r.body.bookings, undefined); assert.equal(r.body.group_id, null);
      assert.equal(Number(r.body.total_price), 270);
    });
    await clear();

    // ---- Task 4: group payment ----
    const roomPayments = require('../src/lib/roomPayments');
    const { computeFolio, toCents } = require('../src/lib/folio');
    const { toStripeAmount } = require('../src/lib/stripeAmount');
    await pool.query(
      `INSERT INTO room_availability (property_id, room_id, date)
       SELECT $1, r, d::date FROM unnest($2::uuid[]) r, generate_series(current_date, current_date + 14, '1 day') d
       ON CONFLICT DO NOTHING`, [P, roomIds]);
    const soon = async (days) => (await one(`SELECT (current_date + $1::int)::text AS d`, [days])).d;
    // A website basket of Std + Dlx on a rate; returns the bookings.
    const webBasket = async (rate, ci = IN, co = OUT) => {
      const r = await api('POST', '/api/bookings', { guest_id: G, check_in: ci, check_out: co, rooms: [
        { room_type_id: STD, rate_plan_id: plans[STD][rate], guests: 2 }, { room_type_id: DLX, rate_plan_id: plans[DLX][rate], guests: 2 }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.bookings;
    };
    const rowsOf = async (ids) => (await pool.query('SELECT * FROM booking WHERE id = ANY($1) ORDER BY id', [ids])).rows;
    const paymentsOf = async (ids) => (await pool.query("SELECT * FROM payment WHERE booking_id = ANY($1) AND status = 'completed'", [ids])).rows;
    const sumAmt = (ps) => ps.reduce((a, p) => a + toCents(p.amount), 0);

    await check('group: one PaymentIntent for the basket total, from any room', async () => {
      const [b1, b2] = await webBasket('Saver');
      const a = await api('POST', `/api/bookings/${b2.id}/payment-intent`);
      assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(Number(a.body.amount), 450);
      const b = await api('POST', `/api/bookings/${b1.id}/payment-intent`);
      assert.equal(b.body.client_secret, a.body.client_secret);
      const rows = await rowsOf([b1.id, b2.id]);
      assert.ok(rows[0].stripe_payment_intent_id && rows[0].stripe_payment_intent_id === rows[1].stripe_payment_intent_id);
      const pi = fakeStripe.store.get(rows[0].stripe_payment_intent_id);
      assert.equal(pi.metadata.group_id, b1.group_id); assert.equal(pi.capture_method, 'automatic');
    });
    await clear();
    await check('group: confirm splits the payment so every room folio balances', async () => {
      const [b1, b2] = await webBasket('Saver');
      await api('POST', `/api/bookings/${b1.id}/payment-intent`);
      const ex = (await one("INSERT INTO extra (property_id, name, price) VALUES ($1, 'Wine', 33.33) RETURNING id", [P])).id;
      await pool.query('INSERT INTO booking_extra (booking_id, extra_id, quantity, unit_price) VALUES ($1, $2, 1, 33.33)', [b1.id, ex]);
      const again = await api('POST', `/api/bookings/${b2.id}/payment-intent`);
      assert.equal(Number(again.body.amount), 483.33);
      const pi = fakeStripe.store.get((await rowsOf([b1.id]))[0].stripe_payment_intent_id);
      pi.status = 'succeeded'; pi.amount_received = pi.amount;
      const c = await api('POST', `/api/bookings/${b1.id}/confirm-payment`);
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.ok((await rowsOf([b1.id, b2.id])).every((b) => b.status === 'confirmed'));
      const ps = await paymentsOf([b1.id, b2.id]);
      assert.equal(ps.length, 2); assert.equal(sumAmt(ps), 48333);
      for (const b of [b1, b2]) assert.equal((await computeFolio(b.id, P)).balance, '0.00');
      assert.equal((await api('POST', `/api/bookings/${b2.id}/confirm-payment`)).status, 200); // idempotent
      assert.equal((await paymentsOf([b1.id, b2.id])).length, 2);
    });
    await clear();
    await check('group: IDR basket amount round-trips', async () => {
      await pool.query("UPDATE property SET currency = 'IDR' WHERE id = $1", [P]);
      try {
        const [b1, b2] = await webBasket('Saver');
        const a = await api('POST', `/api/bookings/${b1.id}/payment-intent`);
        const pi = fakeStripe.store.get((await rowsOf([b1.id]))[0].stripe_payment_intent_id);
        assert.equal(pi.amount, toStripeAmount(45000, 'IDR')); assert.equal(Number(a.body.amount), 450);
        pi.status = 'succeeded'; pi.amount_received = pi.amount;
        assert.equal((await api('POST', `/api/bookings/${b2.id}/confirm-payment`)).status, 200);
        assert.equal(sumAmt(await paymentsOf([b1.id, b2.id])), 45000);
      } finally {
        await pool.query("UPDATE property SET currency = 'GBP' WHERE id = $1", [P]);
      }
    });
    await clear();
    await check('group: expiry expires every room once and cancels the PI once', async () => {
      const [b1, b2] = await webBasket('Saver');
      await api('POST', `/api/bookings/${b1.id}/payment-intent`);
      await pool.query("UPDATE booking SET payment_due_at = now() - interval '1 minute' WHERE id = ANY($1)", [[b1.id, b2.id]]);
      const piId = (await rowsOf([b1.id]))[0].stripe_payment_intent_id;
      const realCancel = fakeStripe.paymentIntents.cancel; let cancels = 0;
      fakeStripe.paymentIntents.cancel = async (id) => { if (id === piId) cancels++; return realCancel(id); };
      try {
        await roomPayments.expireOnce();
        await roomPayments.expireOnce();
      } finally { fakeStripe.paymentIntents.cancel = realCancel; }
      assert.ok((await rowsOf([b1.id, b2.id])).every((b) => b.status === 'expired'));
      assert.equal(cancels, 1); assert.equal(fakeStripe.store.get(piId).status, 'canceled');
      assert.equal(Number((await one('SELECT count(*) AS n FROM booking_night WHERE booking_id = ANY($1)', [[b1.id, b2.id]])).n), 0);
    });
    await clear();
    await check('group: expiry with the card paid confirms every room', async () => {
      const [b1, b2] = await webBasket('Saver');
      await api('POST', `/api/bookings/${b1.id}/payment-intent`);
      const pi = fakeStripe.store.get((await rowsOf([b1.id]))[0].stripe_payment_intent_id);
      pi.status = 'succeeded'; pi.amount_received = pi.amount;
      await pool.query("UPDATE booking SET payment_due_at = now() - interval '1 minute' WHERE id = ANY($1)", [[b1.id, b2.id]]);
      await roomPayments.expireOnce();
      assert.ok((await rowsOf([b1.id, b2.id])).every((b) => b.status === 'confirmed'));
      assert.equal(sumAmt(await paymentsOf([b1.id, b2.id])), 45000);
    });
    await clear();
    const holdBasket = async () => {
      const ci = await soon(3); const co = await soon(5);
      const [b1, b2] = await webBasket('Flex', ci, co);
      const a = await api('POST', `/api/bookings/${b1.id}/payment-intent`);
      assert.equal(a.body.mode, 'hold', JSON.stringify(a.body));
      const pi = fakeStripe.store.get((await rowsOf([b1.id]))[0].stripe_payment_intent_id);
      assert.equal(pi.capture_method, 'manual');
      pi.status = 'requires_capture';
      assert.equal((await api('POST', `/api/bookings/${b2.id}/confirm-payment`)).status, 200);
      // Free cancellation over: the capture sweep is due.
      await pool.query(`UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{cancel_cutoff_hours}', '200') WHERE id = ANY($1)`, [[b1.id, b2.id]]);
      return { b1, b2, pi };
    };
    await check('group: a held basket is captured once, split across rooms', async () => {
      const { b1, b2, pi } = await holdBasket();
      assert.equal((await paymentsOf([b1.id, b2.id])).length, 0);
      const realCapture = fakeStripe.paymentIntents.capture; let captures = 0;
      fakeStripe.paymentIntents.capture = async (id, params) => { if (id === pi.id) captures++; return realCapture(id, params); };
      try { await roomPayments.captureHoldsOnce(); await roomPayments.captureHoldsOnce(); } finally { fakeStripe.paymentIntents.capture = realCapture; }
      assert.equal(captures, 1);
      const ps = await paymentsOf([b1.id, b2.id]);
      assert.equal(ps.length, 2); assert.equal(sumAmt(ps), toCents(pi.amount_received / 100));
      assert.equal(pi.amount_received, 50000);
    });
    await clear();
    await check('group: staff confirming one unpaid room settles the whole basket', async () => {
      const [b1, b2] = await webBasket('Saver');
      const r = await staff(bookingsCtrl.updateBooking, { params: { id: b2.id }, body: { status: 'confirmed' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = await rowsOf([b1.id, b2.id]);
      assert.ok(rows.every((b) => b.status === 'confirmed' && b.rate_plan_terms.pay_at_hotel === true));
    });
    await clear();
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
