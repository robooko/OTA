// Channel distribution checks (spec 2026-11-04-channel-distribution-design).
// Runs the real app on an ephemeral port with fixtures under throwaway
// properties, deleted at the end (pass or fail). Local DB only, with
// migrate-2026-11-04-channels.sql applied.
//   node -r dotenv/config scripts/check-channels.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

  const app = require('../src/app');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `channels_check_${tag}`;
  const P = (await one(`INSERT INTO property (name, timezone, currency) VALUES ('Channel Check', 'Europe/London', 'EUR') RETURNING id`)).id;
  await apiKeys.create(pool, { property_id: P }, { key: KEY });
  const Q = (await one(`INSERT INTO property (name) VALUES ('Channel Check Other') RETURNING id`)).id;
  await apiKeys.create(pool, { property_id: Q }, { key: `${KEY}_other` });

  try {
    await check('schema: channel tables and booking columns exist', async () => {
      for (const t of ['channel', 'channel_mapping', 'channel_trim', 'channel_ari', 'channel_reservation_log']) {
        assert.ok((await one('SELECT to_regclass($1) AS r', [t])).r, t);
      }
      const cols = (await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'booking' AND column_name IN ('channel_id', 'channel_ref')`)).rows;
      assert.equal(cols.length, 2);
    });

    // ---- Task 2: adapters + desired grid ----
    const { ADAPTERS } = require('../src/lib/channels');
    const { desiredAri } = require('../src/lib/channels/desired');
    const { seedRoomAvailability } = require('../src/lib/availabilitySeeder');
    const { d0, d1, d2 } = await one(`SELECT CURRENT_DATE::text AS d0, (CURRENT_DATE + 1)::text AS d1, (CURRENT_DATE + 2)::text AS d2`);
    const roomType = async (name, rate) => (await one(
      'INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, $2, 2, $3) RETURNING id', [P, name, rate])).id;
    const room = async (rt, number) => {
      const id = (await one('INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3) RETURNING id', [P, rt, number])).id;
      await seedRoomAvailability(id);
      return id;
    };
    const RT = await roomType('Double', 100);
    const RT2 = await roomType('Suite', 200);
    const R101 = await room(RT, '101');
    const R102 = await room(RT, '102');
    await room(RT2, '201');
    const SAVER = (await one(
      `INSERT INTO rate_plan (property_id, room_type_id, name, adjustment_pct, refundable, payment_mode)
       VALUES ($1, $2, 'Saver', -10, false, 'full') RETURNING id`, [P, RT])).id;
    await pool.query('INSERT INTO room_type_rate (property_id, room_type_id, date, rate) VALUES ($1, $2, $3, 120)', [P, RT, d1]);
    const newChannel = async (extra = {}) => {
      const ch = await one(
        `INSERT INTO channel (property_id, adapter, name, horizon_days) VALUES ($1, 'test', 'Test', 30) RETURNING *`, [P]);
      const map = (rt, plan, room_code, rate_code) => pool.query(
        `INSERT INTO channel_mapping (property_id, channel_id, room_type_id, rate_plan_id, room_code, rate_code)
         VALUES ($1, $2, $3, $4, $5, $6)`, [P, ch.id, rt, plan, room_code, rate_code]);
      await map(RT, null, 'DBL', 'BAR');
      await map(RT, SAVER, 'DBL', 'SAVER');
      await map(RT2, null, 'STE', 'BAR');
      return Object.assign(ch, extra);
    };
    const chRow = async (id) => one('SELECT * FROM channel WHERE id = $1', [id]);
    const cell = (rows, room_code, rate_code, date) => rows.find((r) => r.room_code === room_code && r.rate_code === rate_code && r.date === date);
    let ch = await newChannel();

    await check('desired: free count, type rate, plan adjustment', async () => {
      const rows = await desiredAri(pool, ch);
      const bar0 = cell(rows, 'DBL', 'BAR', d0);
      assert.deepEqual([bar0.available, bar0.rate, bar0.stop_sell], [2, 100, false]);
      assert.equal(cell(rows, 'DBL', 'BAR', d1).rate, 120);
      assert.equal(cell(rows, 'DBL', 'SAVER', d1).rate, 108);
      assert.equal(cell(rows, 'STE', 'BAR', d0).available, 1);
      assert.equal(rows.filter((r) => r.room_code === 'DBL' && r.rate_code === 'BAR').length, 30);
      assert.equal(rows.length, 90);
    });
    await check('desired: booked night counts down, override_rate not advertised', async () => {
      await pool.query('UPDATE room_availability SET is_available = false WHERE room_id = $1 AND date = $2', [R101, d0]);
      await pool.query('UPDATE room_availability SET override_rate = 50 WHERE room_id = $1 AND date = $2', [R102, d0]);
      try {
        const bar0 = cell(await desiredAri(pool, ch), 'DBL', 'BAR', d0);
        assert.equal(bar0.available, 1);
        assert.equal(bar0.rate, 100);
      } finally {
        await pool.query('UPDATE room_availability SET is_available = true, override_rate = NULL WHERE room_id = ANY($1) AND date = $2', [[R101, R102], d0]);
      }
    });
    await check('desired: inactive rooms not counted', async () => {
      await pool.query(`UPDATE room SET status = 'inactive' WHERE id = $1`, [R102]);
      try {
        assert.equal(cell(await desiredAri(pool, ch), 'DBL', 'BAR', d1).available, 1);
      } finally {
        await pool.query(`UPDATE room SET status = 'active' WHERE id = $1`, [R102]);
      }
    });
    await check('desired: cap, overlapping caps, stop-sell, all-types trim', async () => {
      const trim = (rt, from, to, max, stop) => pool.query(
        `INSERT INTO channel_trim (property_id, channel_id, room_type_id, date_from, date_to, max_available, stop_sell)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [P, ch.id, rt, from, to, max, stop]);
      await trim(RT, d0, d0, 1, false);
      await trim(null, d0, d0, 3, false);
      await trim(RT, d1, d1, null, true);
      await trim(null, d2, d2, 0, false);
      try {
        const rows = await desiredAri(pool, ch);
        assert.equal(cell(rows, 'DBL', 'BAR', d0).available, 1);
        assert.equal(cell(rows, 'STE', 'BAR', d0).available, 1); // cap 3 > 1 room
        const s1 = cell(rows, 'DBL', 'SAVER', d1);
        assert.deepEqual([s1.available, s1.stop_sell], [0, true]);
        assert.deepEqual([cell(rows, 'STE', 'BAR', d1).available, cell(rows, 'STE', 'BAR', d1).stop_sell], [1, false]);
        assert.deepEqual([cell(rows, 'STE', 'BAR', d2).available, cell(rows, 'STE', 'BAR', d2).stop_sell], [0, false]);
      } finally {
        await pool.query('DELETE FROM channel_trim WHERE channel_id = $1', [ch.id]);
      }
    });
    await check('desired: pausing channel and closing mapping close out', async () => {
      let rows = await desiredAri(pool, { ...ch, status: 'pausing' });
      assert.ok(rows.every((r) => r.available === 0 && r.stop_sell));
      assert.equal(cell(rows, 'DBL', 'BAR', d1).rate, 120);
      await pool.query(`UPDATE channel_mapping SET status = 'closing' WHERE channel_id = $1 AND rate_code = 'SAVER'`, [ch.id]);
      try {
        rows = await desiredAri(pool, ch);
        assert.ok(rows.filter((r) => r.rate_code === 'SAVER').every((r) => r.available === 0 && r.stop_sell));
        assert.equal(cell(rows, 'DBL', 'BAR', d0).available, 2);
      } finally {
        await pool.query(`UPDATE channel_mapping SET status = 'active' WHERE channel_id = $1`, [ch.id]);
      }
    });
    await check('test adapter: ok, fail_pushes, validateConfig', async () => {
      assert.deepEqual(await ADAPTERS.test.push({ config: {} }, [{}, {}]), [{ ok: true }, { ok: true }]);
      assert.deepEqual(await ADAPTERS.test.push({ config: { fail_pushes: true } }, [{}]), [{ ok: false, error: 'test adapter: fail_pushes' }]);
      assert.equal(ADAPTERS.test.validateConfig({}).length, 0);
      assert.equal(ADAPTERS.test.validateConfig({ fail_pushes: true }).length, 0);
      assert.equal(ADAPTERS.test.validateConfig({ fail_pushes: 'yes' }).length, 1);
      assert.equal(ADAPTERS.test.validateConfig({ other: 1 }).length, 1);
    });

    // ---- Task 3: sync engine ----
    const sync = require('../src/lib/channels/sync');
    const { drift, syncChannel } = sync;
    const api = async (method, path, body, key = KEY) => {
      const r = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const G = (await one(
      `INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Dee', 'Rect', 'direct@example.com') RETURNING id`, [P])).id;
    const fresh = async () => {
      await pool.query('DELETE FROM booking WHERE property_id = $1 AND channel_id IS NOT NULL', [P]);
      await pool.query('DELETE FROM channel WHERE property_id = $1', [P]);
      ch = await newChannel();
      return ch;
    };
    const snapshot = async (id) => (await pool.query(
      `SELECT a.* FROM channel_ari a JOIN channel_mapping m ON m.id = a.mapping_id WHERE m.channel_id = $1`, [id])).rows;

    await check('sync: first sync sends the whole grid, drift then empty', async () => {
      await fresh();
      const r = await syncChannel(ch.id);
      assert.deepEqual(r, { pushed: 90, ok: 90, failed: 0 });
      assert.equal((await snapshot(ch.id)).length, 90);
      const d = await drift(pool, await chRow(ch.id));
      assert.deepEqual([d.changes.length, d.failed, d.oldest_failing_date], [0, 0, null]);
    });
    await check('sync: direct booking shows as drift for exactly its nights', async () => {
      const b = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT2, check_in: d0, check_out: d2 });
      assert.equal(b.status, 201);
      try {
        const d = await drift(pool, await chRow(ch.id));
        assert.deepEqual(d.changes.map((c) => `${c.room_code}/${c.date}`).sort(), [`STE/${d0}`, `STE/${d1}`]);
        assert.equal(d.changes[0].available, 0);
        assert.equal(d.changes[0].previous.available, 1);
        assert.equal((await syncChannel(ch.id)).pushed, 2);
      } finally {
        await api('DELETE', `/api/bookings/${b.body.id}`);
        await pool.query('DELETE FROM booking WHERE id = $1', [b.body.id]);
      }
      assert.equal((await syncChannel(ch.id)).pushed, 2);
    });
    await check('sync: rate edit shows as drift', async () => {
      const d5 = (await one(`SELECT (CURRENT_DATE + 5)::text AS d`)).d;
      const d6 = (await one(`SELECT (CURRENT_DATE + 6)::text AS d`)).d;
      assert.equal((await api('PUT', `/api/room-types/${RT}/rates`, { rates: [{ from: d5, to: d6, rate: 130 }] })).status, 200);
      const d = await drift(pool, await chRow(ch.id));
      assert.deepEqual(d.changes.map((c) => `${c.rate_code}/${c.date}/${c.rate}`).sort(), [`BAR/${d5}/130`, `SAVER/${d5}/117`]);
      await syncChannel(ch.id);
    });
    await check('sync: fail_pushes → failed counted, keeps old values; clearing it heals', async () => {
      const d5 = (await one(`SELECT (CURRENT_DATE + 5)::text AS d`)).d;
      await pool.query(`UPDATE channel SET config = '{"fail_pushes": true}' WHERE id = $1`, [ch.id]);
      await pool.query('UPDATE room_type_rate SET rate = 140 WHERE room_type_id = $1 AND date = $2', [RT, d5]);
      const r = await syncChannel(ch.id);
      assert.deepEqual(r, { pushed: 2, ok: 0, failed: 2 });
      let d = await drift(pool, await chRow(ch.id));
      assert.deepEqual([d.failed, d.oldest_failing_date, d.changes.length], [2, d5, 2]);
      assert.equal(d.changes.find((c) => c.rate_code === 'BAR').previous.rate, 130);
      assert.equal(d.changes[0].previous.error, 'test adapter: fail_pushes');
      await pool.query(`UPDATE channel SET config = '{}' WHERE id = $1`, [ch.id]);
      assert.deepEqual(await syncChannel(ch.id), { pushed: 2, ok: 2, failed: 0 });
      d = await drift(pool, await chRow(ch.id));
      assert.deepEqual([d.failed, d.changes.length], [0, 0]);
    });
    await check('sync: concurrent syncs push once', async () => {
      const d5 = (await one(`SELECT (CURRENT_DATE + 5)::text AS d`)).d;
      await pool.query('UPDATE room_type_rate SET rate = 150 WHERE room_type_id = $1 AND date = $2', [RT, d5]);
      const [a, b] = await Promise.all([syncChannel(ch.id), syncChannel(ch.id)]);
      assert.equal((a.pushed || 0) + (b.pushed || 0), 2); // the other run was skipped ('locked') or found nothing
    });
    await check('sync: pausing pushes close-out then becomes paused', async () => {
      await pool.query(`UPDATE channel SET status = 'pausing' WHERE id = $1`, [ch.id]);
      const r = await syncChannel(ch.id);
      assert.equal(r.failed, 0);
      assert.ok((await snapshot(ch.id)).every((a) => a.available === 0 && a.stop_sell));
      assert.equal((await chRow(ch.id)).status, 'paused');
      assert.deepEqual(await syncChannel(ch.id), { skipped: 'paused' });
      assert.equal((await drift(pool, await chRow(ch.id))).changes.length, 0);
    });
    await check('sync: closing mapping is closed out then removed', async () => {
      await fresh();
      await syncChannel(ch.id);
      const saver = (await one(`SELECT id FROM channel_mapping WHERE channel_id = $1 AND rate_code = 'SAVER'`, [ch.id])).id;
      await pool.query(`UPDATE channel_mapping SET status = 'closing' WHERE id = $1`, [saver]);
      assert.equal((await syncChannel(ch.id)).pushed, 30);
      assert.equal(await one('SELECT id FROM channel_mapping WHERE id = $1', [saver]), undefined);
      assert.equal((await snapshot(ch.id)).length, 60);
    });
    await check('sync: nudge after a booking', async () => {
      const b = await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT2, check_in: d1, check_out: d2 });
      assert.equal(b.status, 201);
      try {
        await sync._flush();
        assert.equal((await drift(pool, await chRow(ch.id))).changes.length, 0);
        assert.equal((await snapshot(ch.id)).find((a) => a.date === d1 && a.available === 0) !== undefined, true);
      } finally {
        await pool.query('DELETE FROM booking WHERE id = $1', [b.body.id]);
        await pool.query('UPDATE room_availability SET is_available = true WHERE property_id = $1', [P]);
      }
    });

    // ---- Task 4: shared room placement ----
    const { placeBooking, stayNights } = require('../src/lib/roomPlacement');
    await check('stayNights: [check_in, check_out)', async () => {
      assert.deepEqual(stayNights('2030-12-30', '2031-01-02'), ['2030-12-30', '2030-12-31', '2031-01-01']);
      assert.deepEqual(stayNights('2030-01-01', '2030-01-01'), []);
    });
    await check('placeBooking: skips a taken room, fails cleanly when none free', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE room_availability SET is_available = false WHERE room_id = $1 AND date = $2', [R101, d0]);
        const candidates = [{ id: R101, base_rate: '100' }, { id: R102, base_rate: '100' }];
        const insert = async (c, availMap) => {
          assert.equal(availMap[d0].is_available, true);
          return (await client.query(
            `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price) VALUES ($1, $2, $3, $4, $5, 100) RETURNING *`,
            [P, G, c.id, d0, d1])).rows[0];
        };
        let r = await placeBooking(client, { candidates, nights: [d0], insert });
        assert.equal(r.booked.room_id, R102);
        assert.equal((await client.query('SELECT is_available FROM room_availability WHERE room_id = $1 AND date = $2', [R102, d0])).rows[0].is_available, false);
        r = await placeBooking(client, { candidates, nights: [d0], insert });
        assert.deepEqual([r.booked, r.lastUnavailableDate], [null, d0]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    // ---- Task 5: inbound reservations ----
    const { receiveReservation } = require('../src/lib/channels/reservations');
    const { computeFolio } = require('../src/lib/folio');
    const day = async (n) => (await one(`SELECT (CURRENT_DATE + $1::int)::text AS d`, [n])).d;
    const [d3, d5, d6, d8] = [await day(3), await day(5), await day(6), await day(8)];
    await fresh();
    const res = (o) => ({
      channel_ref: 'R1', action: 'new', room_code: 'DBL', rate_code: 'BAR', check_in: d3, check_out: d5, guests: 2,
      total_price: 180, currency: 'EUR', guest: { first_name: 'Ana', last_name: 'Silva', email: 'ana@example.com' }, ...o,
    });
    const byRef = (ref) => one('SELECT * FROM booking WHERE channel_id = $1 AND channel_ref = $2', [ch.id, ref]);
    const nightOpen = async (bookingRoom, date) => (await one(
      'SELECT is_available FROM room_availability WHERE room_id = $1 AND date = $2', [bookingRoom, date])).is_available;
    const logOf = async (ref) => (await pool.query(
      'SELECT outcome, reason FROM channel_reservation_log WHERE channel_id = $1 AND channel_ref = $2 ORDER BY received_at, id', [ch.id, ref])).rows;

    await check('inbound: new → confirmed booking with source, hotel collect owes full stay', async () => {
      const r = await receiveReservation(ch, res());
      assert.equal(r.outcome, 'created');
      const b = await one('SELECT * FROM booking WHERE id = $1', [r.booking_id]);
      assert.deepEqual([b.status, b.channel_id, b.channel_ref, Number(b.total_price), b.guests], ['confirmed', ch.id, 'R1', 180, 2]);
      assert.equal(b.rate_plan_id, null);
      assert.equal(await nightOpen(b.room_id, d3), false);
      assert.equal(Number((await computeFolio(b.id, P)).balance), 180);
      assert.deepEqual(await logOf('R1'), [{ outcome: 'created', reason: null }]);
    });
    await check('inbound: resend is duplicate, same booking', async () => {
      const first = await byRef('R1');
      const r = await receiveReservation(ch, res());
      assert.deepEqual([r.outcome, r.booking_id], ['duplicate', first.id]);
      assert.equal((await pool.query('SELECT 1 FROM booking WHERE channel_ref = $1', ['R1'])).rows.length, 1);
    });
    await check('inbound: rate plan mapping sets rate_plan_id', async () => {
      const r = await receiveReservation(ch, res({ channel_ref: 'RP', rate_code: 'SAVER', check_in: d8, check_out: await day(9) }));
      assert.equal(r.outcome, 'created');
      assert.equal((await byRef('RP')).rate_plan_id, SAVER);
    });
    await check('inbound: channel collect → folio balance 0', async () => {
      const r = await receiveReservation(ch, res({ channel_ref: 'R2', collect: 'channel', total_price: 190 }));
      assert.equal(r.outcome, 'created');
      assert.equal(Number((await computeFolio(r.booking_id, P)).balance), 0);
      const pay = await one('SELECT * FROM payment WHERE booking_id = $1', [r.booking_id]);
      assert.deepEqual([pay.method, pay.status, Number(pay.amount)], ['channel', 'completed', 190]);
    });
    await check('inbound: last room twice → one booking, one rejected + log', async () => {
      const a = await receiveReservation(ch, res({ channel_ref: 'R3', room_code: 'STE' }));
      const b = await receiveReservation(ch, res({ channel_ref: 'R4', room_code: 'STE' }));
      assert.equal(a.outcome, 'created');
      assert.deepEqual([b.outcome, b.reason], ['rejected', 'no room available']);
      assert.equal(await byRef('R4'), undefined);
      assert.deepEqual(await logOf('R4'), [{ outcome: 'rejected', reason: 'no room available' }]);
    });
    await check('inbound: unknown code / currency mismatch / missing fields rejected', async () => {
      assert.equal((await receiveReservation(ch, res({ channel_ref: 'X1', room_code: 'NOPE' }))).reason, 'unknown room/rate code');
      assert.equal((await receiveReservation(ch, res({ channel_ref: 'X2', currency: 'USD' }))).reason, 'currency mismatch');
      assert.match((await receiveReservation(ch, res({ channel_ref: 'X3', check_in: 'bad' }))).reason, /^invalid reservation: check_in/);
      assert.match((await receiveReservation(ch, res({ channel_ref: 'X4', total_price: -1 }))).reason, /^invalid reservation: total_price/);
      assert.match((await receiveReservation(ch, res({ channel_ref: '', }))).reason, /^invalid reservation: channel_ref/);
      assert.match((await receiveReservation(ch, res({ channel_ref: 'X5', action: 'upsert' }))).reason, /^invalid reservation: action/);
      assert.match((await receiveReservation(ch, res({ channel_ref: 'X6', guest: { first_name: 'A' } }))).reason, /^invalid reservation: guest/);
      assert.equal((await pool.query(`SELECT 1 FROM booking WHERE channel_ref LIKE 'X%'`)).rows.length, 0);
    });
    await check('inbound: closing mapping code rejected', async () => {
      await pool.query(`UPDATE channel_mapping SET status = 'closing' WHERE channel_id = $1 AND rate_code = 'SAVER'`, [ch.id]);
      try {
        assert.equal((await receiveReservation(ch, res({ channel_ref: 'X7', rate_code: 'SAVER' }))).reason, 'unknown room/rate code');
      } finally {
        await pool.query(`UPDATE channel_mapping SET status = 'active' WHERE channel_id = $1`, [ch.id]);
      }
    });
    await check('inbound: missing email gets a stable placeholder', async () => {
      const r = await receiveReservation(ch, res({ channel_ref: 'R5', check_in: d6, check_out: d8, guest: { first_name: 'No', last_name: 'Mail' } }));
      assert.equal(r.outcome, 'created');
      const g = await one('SELECT g.email FROM guest g JOIN booking b ON b.guest_id = g.id WHERE b.id = $1', [r.booking_id]);
      assert.equal(g.email, `r5@channel-${ch.id}.invalid`);
    });
    await check('inbound: modify moves dates; impossible modify keeps original', async () => {
      const before = await byRef('R1');
      const r = await receiveReservation(ch, res({ action: 'modify', check_in: d5, check_out: d6, total_price: 95 }));
      assert.equal(r.outcome, 'modified');
      const after = await byRef('R1');
      assert.deepEqual([after.id, after.check_in, after.check_out, Number(after.total_price)], [before.id, d5, d6, 95]);
      assert.equal(await nightOpen(before.room_id, d3), true);
      assert.equal(await nightOpen(after.room_id, d5), false);
      const bad = await receiveReservation(ch, res({ action: 'modify', room_code: 'STE' })); // STE d3..d5 held by R3
      assert.deepEqual([bad.outcome, bad.reason], ['rejected', 'no room available']);
      const still = await byRef('R1');
      assert.deepEqual([still.room_id, still.check_in, still.check_out], [after.room_id, d5, d6]);
      assert.equal(await nightOpen(after.room_id, d5), false);
    });
    await check('inbound: modify updates the channel payment amount', async () => {
      await receiveReservation(ch, res({ channel_ref: 'R2', action: 'modify', collect: 'channel', total_price: 210 }));
      const b = await byRef('R2');
      assert.equal(Number((await one('SELECT amount FROM payment WHERE booking_id = $1', [b.id])).amount), 210);
      assert.equal(Number((await computeFolio(b.id, P)).balance), 0);
    });
    await check('inbound: cancel frees nights, refunds channel payment; repeat is duplicate', async () => {
      const b = await byRef('R2');
      const r = await receiveReservation(ch, { channel_ref: 'R2', action: 'cancel' });
      assert.equal(r.outcome, 'cancelled');
      assert.equal((await byRef('R2')).status, 'cancelled');
      assert.equal((await one('SELECT status FROM payment WHERE booking_id = $1', [b.id])).status, 'refunded');
      assert.equal(await nightOpen(b.room_id, d3), true);
      assert.equal((await receiveReservation(ch, { channel_ref: 'R2', action: 'cancel' })).outcome, 'duplicate');
    });
    await check('inbound: modify/cancel unknown ref or in-house booking rejected', async () => {
      assert.equal((await receiveReservation(ch, { channel_ref: 'ZZ', action: 'cancel' })).reason, 'unknown reservation');
      assert.equal((await receiveReservation(ch, res({ channel_ref: 'ZZ', action: 'modify' }))).reason, 'unknown reservation');
      await pool.query(`UPDATE booking SET status = 'checked_in' WHERE channel_id = $1 AND channel_ref = 'R1'`, [ch.id]);
      try {
        assert.equal((await receiveReservation(ch, { channel_ref: 'R1', action: 'cancel' })).reason, 'booking already in house');
        assert.equal((await byRef('R1')).status, 'checked_in');
      } finally {
        await pool.query(`UPDATE booking SET status = 'confirmed' WHERE channel_id = $1 AND channel_ref = 'R1'`, [ch.id]);
      }
    });
    await check('inbound: paused channel still accepts', async () => {
      await pool.query(`UPDATE channel SET status = 'paused' WHERE id = $1`, [ch.id]);
      try {
        const r = await receiveReservation(await chRow(ch.id), res({ channel_ref: 'R6', check_in: await day(10), check_out: await day(11) }));
        assert.equal(r.outcome, 'created');
      } finally {
        await pool.query(`UPDATE channel SET status = 'active' WHERE id = $1`, [ch.id]);
      }
    });
    await check('staff DELETE of a channel booking needs force', async () => {
      const id = (await byRef('R6')).id;
      const r = await api('DELETE', `/api/bookings/${id}`);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'This booking came from a channel; cancel it on the channel');
      assert.equal((await api('DELETE', `/api/bookings/${id}?force=true`)).status, 200);
    });

    // ---- Task 6: HTTP API ----
    await check('http: create channel validates adapter/config, masks secrets', async () => {
      assert.equal((await api('POST', '/api/channels', { adapter: 'nope', name: 'X' })).status, 400);
      const badCfg = await api('POST', '/api/channels', { adapter: 'test', name: 'X', config: { fail_pushes: 'yes' } });
      assert.equal(badCfg.status, 400);
      assert.match(badCfg.body.details, /fail_pushes/);
      assert.equal((await api('POST', '/api/channels', { adapter: 'test', name: 'X', horizon_days: 900 })).status, 400);
      assert.equal((await api('POST', '/api/channels', { adapter: 'test', name: 'X', collect: 'guest' })).status, 400);
      const ok = await api('POST', '/api/channels', { adapter: 'test', name: 'Web', collect: 'channel', config: { fail_pushes: false } });
      assert.equal(ok.status, 201);
      assert.deepEqual([ok.body.status, ok.body.horizon_days, ok.body.collect, ok.body.config], ['active', 365, 'channel', { fail_pushes: false }]);
      const other = await one(`INSERT INTO channel (property_id, adapter, name, config) VALUES ($1, 'other', 'Other', '{"api_key":"s3cret"}') RETURNING id`, [P]);
      const got = await api('GET', `/api/channels/${other.id}`);
      assert.deepEqual(got.body.config, { api_key: '***' });
      assert.ok((await api('GET', '/api/channels')).body.some((c) => c.id === ok.body.id));
    });
    await check('http: another property gets 404', async () => {
      assert.equal((await api('GET', `/api/channels/${ch.id}`, null, `${KEY}_other`)).status, 404);
      assert.equal((await api('POST', `/api/channels/${ch.id}/sync`, null, `${KEY}_other`)).status, 404);
      assert.ok(!(await api('GET', '/api/channels', null, `${KEY}_other`)).body.some((c) => c.id === ch.id));
    });
    await check('http: replace mappings (validation, removed → closing)', async () => {
      const QT = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Q', 2, 1) RETURNING id`, [Q])).id;
      try {
        assert.equal((await api('PUT', `/api/channels/${ch.id}/mappings`, { mappings: [{ room_type_id: QT, room_code: 'Q', rate_code: 'BAR' }] })).status, 400);
      } finally {
        await pool.query('DELETE FROM room_type WHERE id = $1', [QT]);
      }
      assert.equal((await api('PUT', `/api/channels/${ch.id}/mappings`, { mappings: [{ room_type_id: RT2, rate_plan_id: SAVER, room_code: 'S', rate_code: 'S' }] })).status, 400);
      const dup = [{ room_type_id: RT, room_code: 'DBL', rate_code: 'BAR' }, { room_type_id: RT, room_code: 'DBL', rate_code: 'BAR' }];
      assert.equal((await api('PUT', `/api/channels/${ch.id}/mappings`, { mappings: dup })).status, 400);
      const r = await api('PUT', `/api/channels/${ch.id}/mappings`, {
        mappings: [{ room_type_id: RT, room_code: 'DBL', rate_code: 'BAR' }, { room_type_id: RT2, room_code: 'STE', rate_code: 'BAR' }],
      });
      assert.equal(r.status, 200);
      const st = Object.fromEntries(r.body.map((m) => [`${m.room_code}/${m.rate_code}`, m.status]));
      assert.deepEqual(st, { 'DBL/BAR': 'active', 'DBL/SAVER': 'closing', 'STE/BAR': 'active' });
    });
    await check('http: trims CRUD and validation', async () => {
      assert.equal((await api('POST', `/api/channels/${ch.id}/trims`, { date_from: d5, date_to: d3, stop_sell: true })).status, 400);
      assert.equal((await api('POST', `/api/channels/${ch.id}/trims`, { date_from: d3, date_to: d5 })).status, 400);
      assert.equal((await api('POST', `/api/channels/${ch.id}/trims`, { date_from: d3, date_to: d5, max_available: -1 })).status, 400);
      const t = await api('POST', `/api/channels/${ch.id}/trims`, { room_type_id: RT, date_from: d3, date_to: d3, max_available: 1 });
      assert.equal(t.status, 201);
      assert.equal((await api('GET', `/api/channels/${ch.id}/trims`)).body.length, 1);
      assert.equal((await api('GET', `/api/channels/${ch.id}`)).body.trims.length, 1);
      assert.equal((await api('DELETE', `/api/channels/${ch.id}/trims/${t.body.id}`)).status, 204);
      assert.equal((await api('GET', `/api/channels/${ch.id}/trims`)).body.length, 0);
    });
    await check('http: sync then drift is empty', async () => {
      const s = await api('POST', `/api/channels/${ch.id}/sync`);
      assert.equal(s.status, 200);
      assert.equal(s.body.failed, 0);
      const d = await api('GET', `/api/channels/${ch.id}/drift`);
      assert.deepEqual([d.status, d.body.changes, d.body.total, d.body.failed], [200, [], 0, 0]);
      assert.equal((await api('GET', `/api/channels/${ch.id}/drift?from=bad`)).status, 400);
    });
    await check('http: test reservations, inbound log, bookings channel filter', async () => {
      const body = res({ channel_ref: 'H1', check_in: await day(12), check_out: await day(13) });
      const a = await api('POST', `/api/channels/${ch.id}/test-reservations`, body);
      assert.deepEqual([a.status, a.body.outcome], [201, 'created']);
      const b = await api('POST', `/api/channels/${ch.id}/test-reservations`, body);
      assert.deepEqual([b.status, b.body.outcome], [200, 'duplicate']);
      const c = await api('POST', `/api/channels/${ch.id}/test-reservations`, { ...body, channel_ref: 'H2', room_code: 'NOPE' });
      assert.deepEqual([c.status, c.body.reason], [409, 'unknown room/rate code']);
      const log = await api('GET', `/api/channels/${ch.id}/inbound?limit=2`);
      assert.deepEqual(log.body.map((l) => l.channel_ref), ['H2', 'H1']);
      const other = await one(`SELECT id FROM channel WHERE property_id = $1 AND adapter = 'other'`, [P]);
      assert.equal((await api('POST', `/api/channels/${other.id}/test-reservations`, body)).status, 404);
      assert.equal((await api('POST', '/api/bookings', { guest_id: G, room_type_id: RT2, check_in: await day(20), check_out: await day(21) })).status, 201);
      const direct = (await api('GET', '/api/bookings?channel_id=direct&take=200')).body;
      const list = direct.bookings ?? direct.data ?? direct;
      assert.ok(list.length > 0 && list.every((x) => x.channel_id === null));
      const mine = (await api('GET', `/api/bookings?channel_id=${ch.id}&take=200`)).body;
      const mineList = mine.bookings ?? mine.data ?? mine;
      assert.ok(mineList.length > 0 && mineList.every((x) => x.channel_id === ch.id));
      assert.equal((await api('GET', '/api/bookings?channel_id=nope')).status, 400);
    });
    await check('http: pause → pausing → paused; delete rules', async () => {
      assert.equal((await api('DELETE', `/api/channels/${ch.id}`)).status, 409); // active
      const p = await api('PUT', `/api/channels/${ch.id}`, { status: 'paused' });
      assert.equal(p.body.status, 'pausing');
      await api('POST', `/api/channels/${ch.id}/sync`);
      assert.equal((await api('GET', `/api/channels/${ch.id}`)).body.status, 'paused');
      assert.equal((await api('DELETE', `/api/channels/${ch.id}`)).status, 409); // has bookings
      const spare = (await api('POST', '/api/channels', { adapter: 'test', name: 'Spare' })).body;
      await api('PUT', `/api/channels/${spare.id}`, { status: 'paused' });
      await api('POST', `/api/channels/${spare.id}/sync`);
      assert.equal((await api('DELETE', `/api/channels/${spare.id}`)).status, 204);
      assert.equal((await api('GET', `/api/channels/${spare.id}`)).status, 404);
      const r = await api('PUT', `/api/channels/${ch.id}`, { status: 'active', name: 'Renamed' });
      assert.deepEqual([r.body.status, r.body.name], ['active', 'Renamed']);
    });
  } finally {
    const props = [P, Q];
    const has = async (t) => (await one('SELECT to_regclass($1) AS r', [t])).r;
    await pool.query('DELETE FROM payment WHERE property_id = ANY($1)', [props]);
    if (await has('channel_reservation_log')) await pool.query('DELETE FROM channel_reservation_log WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM booking WHERE property_id = ANY($1)', [props]);
    if (await has('channel')) await pool.query('DELETE FROM channel WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_availability WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_type_rate WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM rate_plan WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room WHERE property_id = ANY($1)', [props]);
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
