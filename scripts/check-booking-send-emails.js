// Checks booking.send_emails: set on create/update, and false silences the
// pay link / confirmation, review request and cleanliness rating. Local DB,
// throwaway property.
//   node -r dotenv/config scripts/check-booking-send-emails.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { createBooking, updateBooking } = require('../src/controllers/bookings');
const roomEmails = require('../src/lib/roomBookingEmails');
const reviewRequester = require('../src/lib/reviewRequester');
const cleanliness = require('../src/lib/cleanlinessRatings');

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
function call(fn, property_id, { body = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query: {}, headers: {}, auth_method: 'clerk' }, res,
      (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = new Date().toISOString().slice(0, 10);
const D = addDays(today, 5);

let P;
(async () => {
  try {
    P = (await one(`INSERT INTO property (name, timezone, review_request_enabled, review_url, review_request_delay_mins, enabled_modules)
                    VALUES ('Send emails check', 'UTC', true, 'https://example.com/review', 0, '["rooms","housekeeping"]'::jsonb) RETURNING id`)).id;
    const T = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P])).id;
    const R = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, '1') RETURNING id`, [P, T])).id;
    await pool.query(`INSERT INTO room_availability (property_id, room_id, date) VALUES ($1, $2, $3)`, [P, R, D]);
    const guest = async (email) => (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'E', 'Mail', $2) RETURNING id`, [P, email])).id;
    const quiet = await guest('quiet-check@example.com');
    const loud = await guest('loud-check@example.com');

    // API
    const stay = { guest_id: quiet, room_type_id: T, check_in: D, check_out: addDays(D, 1), source: 'phone' };
    assert.equal((await call(createBooking, P, { body: { ...stay, send_emails: 'no' } })).status, 400, 'non-boolean refused');
    const made = await call(createBooking, P, { body: { ...stay, send_emails: false } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.send_emails, false);
    const id = { id: made.body.id };
    assert.equal((await call(updateBooking, P, { body: { send_emails: 1 }, params: id })).status, 400);
    assert.equal((await call(updateBooking, P, { body: { guests: 2 }, params: id })).body.send_emails, false, 'omitted = unchanged');
    assert.equal((await call(updateBooking, P, { body: { send_emails: true }, params: id })).body.send_emails, true);
    await call(updateBooking, P, { body: { send_emails: false }, params: id });

    // pay link / confirmation: no email context for a silenced booking
    await pool.query(`UPDATE booking SET rate_plan_terms = '{"name":"Flex","refundable":false}' WHERE property_id = $1`, [P]);
    assert.equal(await roomEmails.loadEmailContext(made.body.id), null, 'silenced: no pay link / confirmation');
    await call(updateBooking, P, { body: { send_emails: true }, params: id });
    assert.ok(await roomEmails.loadEmailContext(made.body.id), 'back on: emails load');
    await pool.query(`DELETE FROM booking_night WHERE property_id = $1`, [P]);
    await pool.query(`DELETE FROM booking WHERE property_id = $1`, [P]);

    // review request + cleanliness rating: a stay that checked out yesterday
    const past = (g, send) => pool.query(
      `INSERT INTO booking (property_id, guest_id, room_type_id, check_in, check_out, total_price, status, send_emails)
       VALUES ($1, $2, $3, $4, $5, 100, 'checked_out', $6)`, [P, g, T, addDays(today, -2), addDays(today, -1), send]);
    await past(quiet, false);
    await past(loud, true);
    const emails = (rows) => rows.filter((r) => r.property_id === P).map((r) => r.email).sort();
    assert.deepEqual(emails(await reviewRequester.claimDue(pool, new Date())), ['loud-check@example.com'], 'review request skips silenced booking');
    assert.deepEqual(emails(await cleanliness.claimDue(pool, new Date())), ['loud-check@example.com'], 'cleanliness rating skips silenced booking');
    console.log('ok   booking send_emails');
  } finally {
    if (P) {
      for (const t of ['review_request', 'cleanliness_rating', 'booking_night', 'booking', 'guest', 'room_availability', 'room', 'room_type']) {
        await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]).catch((e) => console.error(t, e.message));
      }
      await pool.query('DELETE FROM property WHERE id = $1', [P]).catch((e) => console.error('property', e.message));
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
