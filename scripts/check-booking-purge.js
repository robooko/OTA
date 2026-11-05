// Checks POST /api/bookings/purge (hard-delete test bookings) against the
// local DB. Throwaway properties, deleted afterwards.
//   node -r dotenv/config scripts/check-booking-purge.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { createBooking, purgeBookings } = require('../src/controllers/bookings');

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const props = [];
function call(fn, property_id, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params: {}, query: {}, headers: {}, auth_method: 'clerk' }, res,
      (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const D = addDays(new Date().toISOString().slice(0, 10), 5);

async function setup() {
  const P = (await one(`INSERT INTO property (name, overbooking_enabled, oversell_max_pct) VALUES ('Purge check', true, 100) RETURNING id`)).id;
  props.push(P);
  const T = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P])).id;
  const R = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, '1') RETURNING id`, [P, T])).id;
  await pool.query(`INSERT INTO room_availability (property_id, room_id, date) VALUES ($1, $2, $3), ($1, $2, $4)`, [P, R, D, addDays(D, 1)]);
  await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, manual_allowance) VALUES ($1, $2, $3, 5)`, [P, T, D]);
  const book = async (d = D) => {
    const g = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'P', 'Urge', $2) RETURNING id`,
      [P, `purge-${Math.random()}@example.com`])).id;
    const r = await call(createBooking, P, { guest_id: g, room_type_id: T, check_in: d, check_out: addDays(d, 1) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  return { P, R, book };
}

(async () => {
  try {
    const { P, R, book } = await setup();
    const a = await book();            // gets the room
    const b = await book();            // oversold, waiting
    assert.equal(a.room_id, R); assert.equal(b.room_id, null);
    await pool.query(`INSERT INTO payment (property_id, booking_id, amount, method, status) VALUES ($1, $2, 100, 'cash', 'paid')`, [P, a.id]);
    await pool.query(`INSERT INTO folio_adjustment (property_id, booking_id, description, amount) VALUES ($1, $2, 'x', 5)`, [P, a.id]);
    const job = (await one(`INSERT INTO hk_job (property_id, room_id, date, kind, booking_id) VALUES ($1, $2, $3, 'checkout', $4) RETURNING id`, [P, R, D, a.id])).id;

    assert.equal((await call(purgeBookings, P, { booking_ids: [a.id] })).status, 400, 'confirm required');
    assert.equal((await call(purgeBookings, P, { booking_ids: ['nope'], confirm: true })).status, 400, 'uuids only');

    const c = await book(addDays(D, 1));
    await pool.query(`UPDATE booking SET stripe_payment_intent_id = 'pi_test' WHERE id = $1`, [c.id]);
    const refused = await call(purgeBookings, P, { booking_ids: [a.id, c.id], confirm: true });
    assert.equal(refused.status, 409); assert.deepEqual(refused.body.details, [c.id]);
    assert.ok(await one('SELECT 1 FROM booking WHERE id = $1', [a.id]), 'refusal deletes nothing');

    const other = (await one(`INSERT INTO property (name) VALUES ('Purge other') RETURNING id`)).id; props.push(other);
    const r = await call(purgeBookings, other, { booking_ids: [a.id], confirm: true });
    assert.deepEqual(r.body, { deleted: 0, unknown: [a.id] }, 'other property cannot purge');

    const ok = await call(purgeBookings, P, { booking_ids: [a.id], confirm: true });
    assert.deepEqual(ok.body, { deleted: 1, unknown: [] });
    for (const t of ['booking WHERE id', 'payment WHERE booking_id', 'folio_adjustment WHERE booking_id', 'booking_night WHERE booking_id']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${t} = $1`, [a.id])).rowCount, 0, `${t} gone`);
    }
    assert.equal((await one('SELECT booking_id FROM hk_job WHERE id = $1', [job])).booking_id, null, 'hk_job kept, unlinked');
    assert.equal((await one('SELECT room_id FROM booking_night WHERE booking_id = $1', [b.id])).room_id, R, 'waiting booking got the freed room');
    // A channel booking (e.g. imported backtest data): refused without force, deleted with it.
    const ch = (await one(`INSERT INTO channel (property_id, adapter, name) VALUES ($1, 'test', 'Test') RETURNING id`, [P])).id;
    await pool.query(`UPDATE booking SET channel_id = $2, channel_ref = 'x1' WHERE id = $1`, [b.id, ch]);
    assert.equal((await call(purgeBookings, P, { booking_ids: [b.id], confirm: true })).status, 409, 'channel booking needs force');
    assert.deepEqual((await call(purgeBookings, P, { booking_ids: [b.id], confirm: true, force: true })).body, { deleted: 1, unknown: [] });
    assert.equal((await call(purgeBookings, P, { booking_ids: [c.id], confirm: true, force: true })).status, 409, 'force never deletes card-paid');
    console.log('ok   booking purge');
  } finally {
    for (const P of props) {
      for (const t of ['hk_job', 'folio_adjustment', 'payment', 'booking_night', 'booking', 'guest', 'channel', 'room_availability', 'room_type_oversell', 'room', 'room_type']) {
        await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]).catch((e) => console.error(t, e.message));
      }
      await pool.query('DELETE FROM property WHERE id = $1', [P]).catch((e) => console.error('property', e.message));
    }
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
