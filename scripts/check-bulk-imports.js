// POST /api/bookings/import and POST /api/event-inquiries/bulk, driving the
// controllers directly. Fixtures live under a throwaway property and are
// deleted at the end. Local DB only, with migrate-2026-11-06-bulk-imports.sql.
//   node -r dotenv/config scripts/check-bulk-imports.js
delete process.env.ABLY_API_KEY;
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
// Stubbed before the controllers load: they destructure / call these.
const pipeline = require('../src/lib/aiReplyPipeline');
const aiRuns = [];
pipeline.runAiReply = async (args) => { aiRuns.push(args.inquiryId); };
const tokens = require('../src/lib/tokens');
tokens.getBalance = async () => 0;
const { importBookings } = require('../src/controllers/bookings');
const { bulkCreateInquiries } = require('../src/controllers/eventInquiries');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name, currency) VALUES ('Import Check', 'IDR') RETURNING id`)).id;
  const call = async (fn, body) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body, headers: {}, get: () => undefined, auth_method: 'api_key', api_key: { permissions: null } }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    const T = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Villa', 2, 5500000) RETURNING id`, [P])).id;
    const V1 = (await one(`INSERT INTO room (property_id, room_type_id, room_number, status) VALUES ($1, $2, 'V1', 'active') RETURNING id`, [P, T])).id;
    await require('../src/lib/availabilitySeeder').seedRoomAvailability(V1);
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const bk = (ref, extra) => ({
      external_ref: ref, room_type_id: T, check_in: day(30), check_out: day(32), total_price: 11250000,
      guest: { first_name: 'Ayu', last_name: 'Lestari', email: 'Ayu@Example.com' }, ...extra,
    });

    await check('bookings: kept price/source/booked_at; full type rejected; cancelled holds nothing; re-run is duplicate', async () => {
      const r = await call(importBookings, { bookings: [
        bk('B1', { source: 'ota', booked_at: '2026-09-01T10:00:00Z', metadata: { ota: 'Booking.com' } }),
        bk('B2'),
        bk('B3', { status: 'cancelled', source: 'corporate' }),
        bk('B4', { source: 'nope' }),
      ] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.results.map((x) => x.outcome), ['created', 'rejected', 'created', 'rejected']);
      assert.equal(r.body.results[1].reason, 'no room available');
      assert.equal(r.body.results[3].reason, 'invalid booking: source');
      const b1 = await one('SELECT * FROM booking WHERE id = $1', [r.body.results[0].booking_id]);
      assert.equal(b1.total_price, '11250000.00'); assert.equal(b1.source, 'ota'); assert.equal(b1.status, 'confirmed');
      assert.equal(b1.send_emails, false); assert.equal(b1.metadata.ota, 'Booking.com');
      assert.equal(b1.created_at.toISOString(), '2026-09-01T10:00:00.000Z');
      assert.equal((await one('SELECT count(*)::int AS n FROM booking_night WHERE booking_id = $1', [b1.id])).n, 2);
      const b3 = r.body.results[2].booking_id;
      assert.equal((await one('SELECT count(*)::int AS n FROM booking_night WHERE booking_id = $1', [b3])).n, 0);
      assert.equal((await one('SELECT count(*)::int AS n FROM guest WHERE property_id = $1', [P])).n, 1, 'one guest, matched by email');
      const again = await call(importBookings, { send_emails: true, bookings: [bk('B1')] });
      assert.equal(again.body.results[0].outcome, 'duplicate');
      assert.equal(again.body.results[0].booking_id, b1.id);
    });

    await check('bookings: send_emails top-level and per booking; no email = placeholder guest', async () => {
      const r = await call(importBookings, { send_emails: true, bookings: [
        bk('C1', { check_in: day(40), check_out: day(41) }),
        bk('C2', { check_in: day(41), check_out: day(42), send_emails: false, guest: { first_name: 'No', last_name: 'Mail' } }),
      ] });
      assert.deepEqual(r.body.counts, { created: 2 });
      const [c1, c2] = await Promise.all(r.body.results.map((x) => one('SELECT b.send_emails, g.email FROM booking b JOIN guest g ON g.id = b.guest_id WHERE b.id = $1', [x.booking_id])));
      assert.equal(c1.send_emails, true); assert.equal(c2.send_emails, false);
      assert.equal(c2.email, 'c2@import.invalid');
    });

    await check('bookings: bad bodies are 400', async () => {
      assert.equal((await call(importBookings, {})).status, 400);
      assert.equal((await call(importBookings, { bookings: [] })).status, 400);
      assert.equal((await call(importBookings, { bookings: Array(501).fill(bk('X')) })).status, 400);
      assert.equal((await call(importBookings, { send_emails: 'no', bookings: [bk('X')] })).status, 400);
    });

    await check('inquiries: send_emails false (default) skips the AI reply and the token check', async () => {
      const r = await call(bulkCreateInquiries, { inquiries: [
        { name: 'PT Sinar', email: 'events@sinar.example', event_date: day(60), guests: 80, event_type: 'conference' },
        { name: 'No email' },
      ] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.created, 1); assert.equal(r.body.results[1].status, 400);
      assert.equal(aiRuns.length, 0);
      const on = await call(bulkCreateInquiries, { send_emails: true, inquiries: [{ name: 'A', email: 'a@example.com' }] });
      assert.equal(on.status, 200); assert.equal(on.body.results[0].status, 402, 'no tokens = refused, as for the website');
      assert.equal((await call(bulkCreateInquiries, { inquiries: [] })).status, 400);
    });
  } finally {
    await pool.query('DELETE FROM event_inquiry WHERE property_id = $1', [P]);
    for (const t of ['booking_night', 'booking', 'guest', 'room_availability', 'room', 'room_type']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
