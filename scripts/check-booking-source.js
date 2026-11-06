// Checks booking.source (web / phone / email / walk_in / agent) on create,
// update and the list filter, against the local DB. Throwaway property.
//   node -r dotenv/config scripts/check-booking-source.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { createBooking, updateBooking, listBookings } = require('../src/controllers/bookings');

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
function call(fn, property_id, { body = {}, params = {}, query = {}, auth_method = 'clerk' } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query, headers: {}, auth_method }, res,
      (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const D = addDays(new Date().toISOString().slice(0, 10), 5);

let P;
(async () => {
  try {
    P = (await one(`INSERT INTO property (name) VALUES ('Source check') RETURNING id`)).id;
    const T = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P])).id;
    for (const n of ['1', '2', '3']) {
      const R = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3) RETURNING id`, [P, T, n])).id;
      await pool.query(`INSERT INTO room_availability (property_id, room_id, date) VALUES ($1, $2, $3)`, [P, R, D]);
    }
    const G = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'S', 'Ource', 'source-check@example.com') RETURNING id`, [P])).id;
    const stay = { guest_id: G, room_type_id: T, check_in: D, check_out: addDays(D, 1) };

    assert.equal((await call(createBooking, P, { body: { ...stay, source: 'fax' } })).status, 400, 'unknown source refused');
    const phone = await call(createBooking, P, { body: { ...stay, source: 'phone' } });
    assert.equal(phone.status, 201, JSON.stringify(phone.body)); assert.equal(phone.body.source, 'phone');
    assert.equal((await call(createBooking, P, { body: stay })).status, 400, 'staff must give a source');
    const staff = await call(createBooking, P, { body: { ...stay, source: 'email' } });
    assert.equal(staff.body.source, 'email');
    const web = await call(createBooking, P, { body: stay, auth_method: 'api_key' });
    assert.equal(web.status, 201, JSON.stringify(web.body)); assert.equal(web.body.source, 'web', 'API key default: web');

    const id = { id: staff.body.id };
    assert.equal((await call(updateBooking, P, { body: { source: 'nope' }, params: id })).status, 400);
    assert.equal((await call(updateBooking, P, { body: { source: 'walk_in' }, params: id })).body.source, 'walk_in');
    assert.equal((await call(updateBooking, P, { body: { guests: 2 }, params: id })).body.source, 'walk_in', 'omitted source kept');
    assert.equal((await call(updateBooking, P, { body: { source: null }, params: id })).body.source, null, 'null clears');

    const list = await call(listBookings, P, { query: { source: 'phone' } });
    assert.equal(list.body.total, 1); assert.equal(list.body.data[0].id, phone.body.id);
    assert.equal((await call(listBookings, P, { query: { source: 'x' } })).status, 400);
    console.log('ok   booking source');
  } finally {
    if (P) {
      for (const t of ['booking_night', 'booking', 'guest', 'room_availability', 'room', 'room_type']) {
        await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]).catch((e) => console.error(t, e.message));
      }
      await pool.query('DELETE FROM property WHERE id = $1', [P]).catch((e) => console.error('property', e.message));
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
