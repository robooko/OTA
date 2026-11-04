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
