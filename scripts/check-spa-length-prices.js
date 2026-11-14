// Spa treatments priced by boat length (length_prices) and the boat on an
// appointment, driving the controller directly. Fixtures live under a
// throwaway property and are deleted at the end. Local DB only.
//   node -r dotenv/config scripts/check-spa-length-prices.js
delete process.env.ABLY_API_KEY;
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const spa = require('../src/controllers/spa');
const { dueNow } = require('../src/lib/amountDue');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name, currency) VALUES ('Length Prices Check', 'FJD') RETURNING id`)).id;
  const S = (await one("INSERT INTO spa (property_id, name) VALUES ($1, 'Boatyard') RETURNING id", [P])).id;
  const call = async (fn, params, body) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await spa[fn]({ property_id: P, params: { spa_id: S, ...params }, query: {}, body, headers: {}, get: () => undefined, auth_method: 'bearer', user: { role: 'staff' } }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    const lift = (await one("INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Travel lift') RETURNING id", [P, S])).id;
    for (let d = 1; d <= 7; d++) {
      await pool.query("INSERT INTO spa_therapist_hours (property_id, therapist_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, '07:00', '17:00')", [P, lift, d]);
    }
    const date = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    let tr;

    await check('create: bands stored ascending, price defaults to the first band', async () => {
      const r = await call('createTreatment', {}, { name: 'Haul-out', duration_mins: 60, length_prices: [
        { max_length_m: 20, price: 1763 }, { max_length_m: 7.99, price: 338 }, { max_length_m: 8.99, price: 361 },
      ] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      tr = r.body.id;
      assert.deepEqual(r.body.length_prices.map((b) => b.max_length_m), [7.99, 8.99, 20]);
      assert.equal(Number(r.body.price), 338);
    });

    await check('create/update: bad bands are 400', async () => {
      assert.equal((await call('createTreatment', {}, { name: 'X', duration_mins: 60, length_prices: [] })).status, 400);
      assert.equal((await call('createTreatment', {}, { name: 'X', duration_mins: 60, length_prices: [{ max_length_m: -1, price: 5 }] })).status, 400);
      assert.equal((await call('createTreatment', {}, { name: 'X', duration_mins: 60, length_prices: [{ max_length_m: 8, price: 5 }, { max_length_m: 8, price: 6 }] })).status, 400);
      assert.equal((await call('updateTreatment', { id: tr }, { length_prices: 'cheap' })).status, 400);
    });

    const book = (time, extra) => call('createAppointment', {}, { treatment_id: tr, therapist_id: lift, date, time, contact_name: 'Skipper', ...extra });

    await check('booking prices by the band the length fits (max inclusive) and stores the boat', async () => {
      const a = await book('08:00', { boat_name: 'Wanderer', boat_length_m: 7.99 });
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(Number(a.body.price), 338);
      assert.equal(a.body.boat_name, 'Wanderer');
      assert.equal(Number(a.body.boat_length_m), 7.99);
      const b = await book('09:00', { boat_length_m: 8.5 });
      assert.equal(Number(b.body.price), 361);
      const c = await book('10:00', { boat_length_m: 20 });
      assert.equal(Number(c.body.price), 1763);
    });

    await check('no length is 400 boat_length_required; past the last band is 409 boat_too_long', async () => {
      const a = await book('11:00');
      assert.equal(a.status, 400); assert.equal(a.body.code, 'boat_length_required');
      const b = await book('11:00', { boat_length_m: 20.01 });
      assert.equal(b.status, 409); assert.equal(b.body.code, 'boat_too_long');
      const c = await book('11:00', { boat_length_m: '12' });
      assert.equal(c.status, 400);
      const d = await book('11:00', { boat_length_m: 9, boat_name: 'x'.repeat(101) });
      assert.equal(d.status, 400);
    });

    await check('amount due prices the band too', async () => {
      const due = await dueNow(pool, 'spa_appointment', P, { spa_id: S, treatment_id: tr, date, boat_length_m: '8.2' });
      assert.equal(Number(due.price), 361, JSON.stringify(due));
      const none = await dueNow(pool, 'spa_appointment', P, { spa_id: S, treatment_id: tr, date });
      assert.equal(none.status, 400); assert.equal(none.error, 'boat_length_required');
    });

    await check('a plain treatment ignores the boat; null clears the bands', async () => {
      const plain = (await call('createTreatment', {}, { name: 'Waterblast', duration_mins: 60, price: 73 })).body.id;
      const a = await call('createAppointment', {}, { treatment_id: plain, therapist_id: lift, date, time: '13:00', contact_name: 'Skipper', boat_length_m: 30 });
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(Number(a.body.price), 73);
      const u = await call('updateTreatment', { id: tr }, { length_prices: null });
      assert.equal(u.body.length_prices, null);
      const b = await book('14:00');
      assert.equal(b.status, 201); assert.equal(Number(b.body.price), 338);
    });
  } finally {
    for (const t of ['payment', 'spa_appointment', 'spa_therapist_hours', 'spa_treatment', 'spa_therapist', 'spa']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
