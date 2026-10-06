// Checks the per-visit review-request claim against the local DB. Every
// fixture lives inside one transaction that is rolled back, so nothing
// persists. Never point this at the live DB.
//   node -r dotenv/config scripts/check-review-requests.js
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { claimDue, claimRetries } = require('../src/lib/reviewRequester');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const T = (s) => new Date(s); // all fixture instants in UTC; property is Europe/London (BST in July)

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const prop = await one(`INSERT INTO property (name, timezone, review_request_enabled, review_url, review_request_delay_mins, review_request_cooldown_days, enabled_modules)
      VALUES ('Review Check Hotel', 'Europe/London', true, 'https://g.page/r/test/review', 0, 90, NULL) RETURNING id`);
    const P = prop.id;
    const rt = await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P]);
    const room = await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'RC1') RETURNING id`, [P, rt.id]);
    const restaurant = await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Grill', 90) RETURNING id`, [P]);
    const table = await one(`INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats) VALUES ($1, $2, 'T1', 4) RETURNING id`, [P, restaurant.id]);
    const tour = await one(`INSERT INTO tour (property_id, name, duration_mins, max_group_size, price) VALUES ($1, 'Boat', 120, 10, 50) RETURNING id`, [P]);

    const guest = (email) => one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Jo', 'Guest', $2) RETURNING id`, [P, email]);
    const stay = (guestId, cin, cout, status = 'confirmed') => one(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status) VALUES ($1, $2, $3, $4, $5, 300, $6) RETURNING id`,
      [P, guestId, room.id, cin, cout, status]);
    const dinner = (email, date, start, end, status = 'confirmed') => one(
      `INSERT INTO restaurant_reservation (property_id, table_id, reservation_date, start_time, end_time, contact_name, contact_email, party_size, status)
       VALUES ($1, $2, $3, $4, $5, 'Jo', $6, 2, $7) RETURNING id`, [P, table.id, date, start, end, email, status]);
    const tourBooking = async (email, date, time) => {
      const slot = await one(`INSERT INTO tour_slot (property_id, tour_id, slot_date, slot_time) VALUES ($1, $2, $3, $4) RETURNING id`, [P, tour.id, date, time]);
      return one(`INSERT INTO tour_booking (property_id, slot_id, contact_name, contact_email, group_size, total_price) VALUES ($1, $2, 'Sam', $3, 2, 100) RETURNING id`, [P, slot.id, email]);
    };
    const mine = (rows) => rows.filter((r) => r.property_id === P);

    // Jo: 3-night stay 10-13 July, dinners on the 10th and 11th.
    const jo = await guest('jo@example.com');
    const joStay = await stay(jo.id, '2026-07-10', '2026-07-13');
    await dinner('Jo@Example.com ', '2026-07-10', '19:00', '21:00');
    await dinner('jo@example.com', '2026-07-11', '19:00', '21:00');

    await check('mid-stay: nothing (check-out still to come)', async () => {
      assert.deepEqual(mine(await claimDue(db, T('2026-07-11T21:30:00Z'))), []);
    });

    await check('after check-out: one request, triggered by the stay', async () => {
      const rows = mine(await claimDue(db, T('2026-07-13T12:00:00Z'))); // 13:00 BST, check-out 11:00 BST
      assert.equal(rows.length, 1);
      assert.equal(rows[0].email, 'jo@example.com');
      assert.equal(rows[0].module, 'rooms');
      assert.equal(rows[0].booking_id, joStay.id);
      assert.equal(rows[0].contact_name, 'Jo');
    });

    await check('email normalised: the mixed-case dinner did not make a second guest', async () => {
      const { rows } = await db.query('SELECT count(*)::int n FROM review_request WHERE property_id = $1', [P]);
      assert.equal(rows[0].n, 1);
    });

    await check('second sweep: nothing (cooldown)', async () => {
      assert.deepEqual(mine(await claimDue(db, T('2026-07-13T12:15:00Z'))), []);
    });

    await check('non-staying guest: asked after their last booking', async () => {
      await tourBooking('sam@example.com', '2026-07-20', '10:00'); // ends 12:00 BST = 11:00Z
      assert.deepEqual(mine(await claimDue(db, T('2026-07-20T10:30:00Z'))), [], 'tour not over yet');
      const rows = mine(await claimDue(db, T('2026-07-20T11:05:00Z')));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].module, 'tours');
    });

    await check('timezone: London 21:00 is 20:00Z in July', async () => {
      await dinner('tz@example.com', '2026-07-22', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-22T19:55:00Z'))), [], '20:55 BST, dinner not over');
      assert.equal(mine(await claimDue(db, T('2026-07-22T20:05:00Z'))).length, 1);
    });

    await check('cancelled booking: nothing', async () => {
      await dinner('cancel@example.com', '2026-07-23', '19:00', '21:00', 'cancelled');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-23T22:00:00Z'))), []);
    });

    await check('opted out: nothing', async () => {
      await db.query(`INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, 'out@example.com')`, [P]);
      await dinner('out@example.com', '2026-07-24', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-24T22:00:00Z'))), []);
    });

    await check('2-day floor: an older booking is never backfilled', async () => {
      await dinner('old@example.com', '2026-07-01', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-24T22:00:00Z'))), []);
    });

    await check('module switched off: ignored', async () => {
      await db.query(`UPDATE property SET enabled_modules = '["rooms"]'::jsonb WHERE id = $1`, [P]);
      await dinner('off@example.com', '2026-07-25', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-25T22:00:00Z'))), []);
      await db.query(`UPDATE property SET enabled_modules = NULL WHERE id = $1`, [P]);
    });

    await check('delay respected', async () => {
      await db.query(`UPDATE property SET review_request_delay_mins = 120 WHERE id = $1`, [P]);
      await dinner('delay@example.com', '2026-07-26', '19:00', '21:00'); // ends 20:00Z
      // Filtered to this guest: switching 'restaurant_reservations' back on in
      // the previous check makes off@example.com due too.
      const delayed = (rows) => mine(rows).filter((r) => r.email === 'delay@example.com');
      assert.deepEqual(delayed(await claimDue(db, T('2026-07-26T21:00:00Z'))), [], 'only 60 min after');
      assert.equal(delayed(await claimDue(db, T('2026-07-26T22:01:00Z'))).length, 1);
      await db.query(`UPDATE property SET review_request_delay_mins = 0 WHERE id = $1`, [P]);
    });

    await check('retry: a released request is reclaimed until 3 attempts', async () => {
      await dinner('retry@example.com', '2026-07-27', '19:00', '21:00');
      const [r] = mine(await claimDue(db, T('2026-07-27T21:00:00Z')));
      assert.ok(r);
      for (const attempt of [2, 3]) {
        await db.query('UPDATE review_request SET sent_at = NULL WHERE id = $1', [r.id]); // a failed send
        const again = mine(await claimRetries(db, T('2026-07-27T21:15:00Z')));
        assert.deepEqual(again.map((x) => x.id), [r.id], `attempt ${attempt}`);
      }
      await db.query('UPDATE review_request SET sent_at = NULL WHERE id = $1', [r.id]);
      assert.deepEqual(mine(await claimRetries(db, T('2026-07-27T21:30:00Z'))), [], 'gives up after 3');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-27T21:30:00Z'))), [], 'and is not claimed afresh');
    });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
