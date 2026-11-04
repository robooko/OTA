// Checks POST /api/bookings/cancel-scores and the cancel_score field on
// booking list/detail/live payloads, through the controllers against the
// local DB. Creates throwaway properties and deletes them afterwards.
//   node -r dotenv/config scripts/check-cancel-scores.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { addCancelScores, listBookings, getBooking } = require('../src/controllers/bookings');
const { fetchJoinedBooking } = require('../src/lib/roomPayments');

function call(fn, property_id, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query }, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

(async () => {
  const props = [];
  try {
    for (const n of ['Score Check A', 'Score Check B']) props.push((await one('INSERT INTO property (name) VALUES ($1) RETURNING id', [n])).id);
    const [A, B] = props;
    const booking = async (P) => {
      const rt = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P])).id;
      const room = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, '1') RETURNING id`, [P, rt])).id;
      const g = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'S', 'Core', $2) RETURNING id`, [P, `score-${P}@example.com`])).id;
      return (await one(`INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price) VALUES ($1, $2, $3, '2030-01-01', '2030-01-03', 200) RETURNING id`, [P, g, room])).id;
    };
    const bA = await booking(A);
    const bB = await booking(B);

    assert.equal((await call(getBooking, A, { params: { id: bA } })).body.cancel_score, null, 'unscored = null');

    const bad = [[], [{ booking_id: 'x', score: 0.5, model: 'm' }], [{ booking_id: bA, score: 1.5, model: 'm' }],
      [{ booking_id: bA, score: '0.5', model: 'm' }], [{ booking_id: bA, score: 0.5, model: ' ' }]];
    for (const scores of bad) assert.equal((await call(addCancelScores, A, { body: { scores } })).status, 400, JSON.stringify(scores));
    assert.equal((await call(addCancelScores, A, { body: { scores: Array(501).fill({ booking_id: bA, score: 0.1, model: 'm' }) } })).status, 400, '501 refused');

    const r1 = await call(addCancelScores, A, { body: { scores: [{ booking_id: bA, score: 0.2, model: 'v1' }, { booking_id: bB, score: 0.9, model: 'v1' }] } });
    assert.equal(r1.status, 200); assert.equal(r1.body.saved, 1); assert.deepEqual(r1.body.unknown, [bB], "other property's booking skipped");
    await pool.query(`UPDATE booking_cancel_score SET scored_at = now() - interval '1 day' WHERE booking_id = $1`, [bA]);
    await call(addCancelScores, A, { body: { scores: [{ booking_id: bA, score: 0.8765, model: 'v2' }] } });

    const detail = (await call(getBooking, A, { params: { id: bA } })).body.cancel_score;
    assert.equal(detail.score, 0.877, 'latest, 3 decimals'); assert.equal(detail.model, 'v2');
    const listed = (await call(listBookings, A)).body.data.find((b) => b.id === bA);
    assert.equal(listed.cancel_score.model, 'v2');
    assert.equal((await fetchJoinedBooking(bA)).cancel_score.model, 'v2', 'live payload');
    assert.equal((await one('SELECT count(*)::int AS n FROM booking_cancel_score WHERE booking_id = $1', [bA])).n, 2, 'history kept');
    assert.equal((await call(getBooking, B, { params: { id: bB } })).body.cancel_score, null, 'B untouched');
    console.log('ok   cancel scores');
  } finally {
    if (props.length) {
      for (const t of ['booking', 'guest', 'room', 'room_type']) await pool.query(`DELETE FROM ${t} WHERE property_id = ANY($1)`, [props]);
      await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
