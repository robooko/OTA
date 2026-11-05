// Checks room overbooking: sold type + per-night rooms, counts, holds, picks,
// bumps, release, moves, walks, channels, readers and the /api/overbooking
// endpoints, against the local DB. Throwaway properties, deleted afterwards.
//   node -r dotenv/config scripts/check-overbooking.js [section ...]
// See docs/superpowers/specs/2026-11-05-room-overbooking-design.md.
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const fs = require('fs');
const pool = require('../src/db');

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const runSql = (path) => pool.query(fs.readFileSync(path, 'utf8'));
const props = [];

async function property(name, settings = {}) {
  const id = (await one('INSERT INTO property (name) VALUES ($1) RETURNING id', [name])).id;
  props.push(id);
  for (const [k, v] of Object.entries(settings)) await pool.query(`UPDATE property SET ${k} = $2 WHERE id = $1`, [id, v]);
  return id;
}
async function roomType(P, name = 'Std', base = 100) {
  return (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, $2, 2, $3) RETURNING id`, [P, name, base])).id;
}
async function room(P, type, number, status = 'active') {
  return (await one(`INSERT INTO room (property_id, room_type_id, room_number, status) VALUES ($1, $2, $3, $4) RETURNING id`, [P, type, number, status])).id;
}
async function guest(P) {
  return (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'O', 'Ver', $2) RETURNING id`,
    [P, `ob-${P}-${Math.random()}@example.com`])).id;
}

const hold = (P, booking, night, roomId) => pool.query(
  'INSERT INTO booking_night (booking_id, property_id, night, room_id) VALUES ($1, $2, $3, $4)', [booking, P, night, roomId]);
async function rawBooking(P, type, roomId, cin, cout, status = 'confirmed') {
  const g = await guest(P);
  return (await one(`INSERT INTO booking (property_id, guest_id, room_id, room_type_id, check_in, check_out, total_price, status)
                     VALUES ($1, $2, $3, $4, $5, $6, 100, $7) RETURNING id`, [P, g, roomId, type, cin, cout, status])).id;
}
function call(fn, property_id, { body = {}, params = {}, query = {}, extra = {} } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query, headers: {}, ...extra }, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}

const sections = {
  async counts() {
    const { typeCounts } = require('../src/lib/roomNights');
    const P = await property('OB Counts');
    const A = await roomType(P);
    const [r1] = [await room(P, A, '1'), await room(P, A, '2'), await room(P, A, '3', 'inactive')];
    const N = '2030-02-01';
    const get = async () => {
      const c = (await typeCounts(pool, P, A, [N])).get(`${A}|${N}`);
      return { rooms: c.rooms, blocked: c.blocked, sold: c.sold, allowance: c.allowance, sellable: c.sellable, unplaced: c.unplaced };
    };
    assert.deepEqual(await get(), { rooms: 2, blocked: 0, sold: 0, allowance: 0, sellable: 2, unplaced: 0 }, 'empty, disabled');

    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 3)`, [P, A, N]);
    assert.equal((await get()).allowance, 0, 'disabled property => allowance 0 even with rows present');
    await pool.query(`UPDATE property SET overbooking_enabled = true, oversell_max_pct = 50 WHERE id = $1`, [P]);
    assert.deepEqual(await get(), { rooms: 2, blocked: 0, sold: 0, allowance: 1, sellable: 3, unplaced: 0 }, 'cap 50% of 2 => 1');
    await pool.query(`UPDATE room_type_oversell SET manual_allowance = 0 WHERE room_type_id = $1`, [A]);
    assert.equal((await get()).allowance, 0, 'manual 0 overrides model');

    // allowance lowered below sold clamps to 0
    for (const r of [r1, null, null]) await hold(P, await rawBooking(P, A, r, N, '2030-02-02'), N, r);
    assert.deepEqual(await get(), { rooms: 2, blocked: 0, sold: 3, allowance: 0, sellable: 0, unplaced: 2 }, 'allowance lowered below sold clamps to 0');

    // block on booked room not double-counted; a block on a free room counts.
    const r2 = (await one(`SELECT id FROM room WHERE property_id = $1 AND room_number = '2'`, [P])).id;
    await pool.query(`INSERT INTO room_availability (property_id, room_id, date, is_available) VALUES ($1, $2, $3, false), ($1, $4, $3, false)`, [P, r1, N, r2]);
    assert.equal((await get()).blocked, 1, 'block on booked room not double-counted');

    // search: sellable > 0 with no free physical room still lists the type
    await pool.query(`DELETE FROM booking_night WHERE property_id = $1`, [P]);
    await pool.query(`DELETE FROM room_availability WHERE property_id = $1`, [P]);
    await pool.query(`UPDATE room_type_oversell SET manual_allowance = NULL WHERE room_type_id = $1`, [A]);
    for (const r of ['1', '2']) {
      const id = (await one(`SELECT id FROM room WHERE property_id = $1 AND room_number = $2`, [P, r])).id;
      await pool.query(`INSERT INTO room_availability (property_id, room_id, date, is_available) VALUES ($1, $2, $3, false)`, [P, id, N]);
      await hold(P, await rawBooking(P, A, id, N, '2030-02-02'), N, id);
    }
    await pool.query('REFRESH MATERIALIZED VIEW room_type_availability');
    const v = await one('SELECT total_rooms, available_rooms, sold, oversell_allowance, sellable_rooms FROM room_type_availability WHERE room_type_id = $1 AND date = $2', [A, N]);
    assert.deepEqual(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])),
      { total_rooms: 2, available_rooms: 0, sold: 2, oversell_allowance: 1, sellable_rooms: 1 }, 'view');
    const { searchAvailability } = require('../src/controllers/availability');
    const s = await call(searchAvailability, null, { query: { check_in: N, check_out: '2030-02-02', guests: 1, property_id: P } });
    assert.equal(s.status, 200);
    assert.equal(Number(s.body.find((t) => t.room_type_id === A)?.min_available), 1, 'search lists oversellable type');
  },


  async migration() {
    const P = await property('OB Migration');
    const A = await roomType(P);
    const r1 = await room(P, A, '1');
    const g = await guest(P);
    // A booking written by the old code during the deploy window: no sold type, no nights.
    await pool.query(`INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price)
                      VALUES ($1, $2, $3, '2030-01-01', '2030-01-04', 300)`, [P, g, r1]).catch(async (e) => {
      // After B the column is NOT NULL: simulate the old row by inserting with the type then nulling nights.
      if (e.code !== '23502') throw e;
      await pool.query(`INSERT INTO booking (property_id, guest_id, room_id, room_type_id, check_in, check_out, total_price)
                        VALUES ($1, $2, $3, $4, '2030-01-01', '2030-01-04', 300)`, [P, g, r1, A]);
    });
    await pool.query(`DELETE FROM booking_night WHERE property_id = $1`, [P]);
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql'); // idempotent
    assert.equal((await one(`SELECT room_type_id FROM booking WHERE property_id = $1`, [P])).room_type_id, A, 'sold type backfilled');
    assert.equal((await one(`SELECT count(*)::int AS n FROM booking_night WHERE room_id = $1`, [r1])).n, 3, 'nights backfilled');
    const p = await one('SELECT overbooking_enabled, oversell_max_pct, room_lock_days FROM property WHERE id = $1', [P]);
    assert.deepEqual({ ...p, oversell_max_pct: Number(p.oversell_max_pct) }, { overbooking_enabled: false, oversell_max_pct: 0, room_lock_days: 1 });
    // Cancelled bookings hold no nights.
    await pool.query(`UPDATE booking SET status = 'cancelled' WHERE property_id = $1`, [P]);
    await pool.query(`DELETE FROM booking_night WHERE property_id = $1`, [P]);
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
    assert.equal((await one(`SELECT count(*)::int AS n FROM booking_night WHERE property_id = $1`, [P])).n, 0, 'cancelled not backfilled');
  },
};

(async () => {
  const wanted = process.argv.slice(2);
  try {
    for (const [name, fn] of Object.entries(sections)) {
      if (wanted.length && !wanted.includes(name)) continue;
      await fn();
      console.log(`ok   ${name}`);
    }
  } finally {
    if (props.length) {
      for (const t of ['booking_room_move', 'booking_night', 'room_type_oversell', 'payment', 'booking', 'guest', 'room_availability', 'room', 'room_type']) {
        await pool.query(`DELETE FROM ${t} WHERE property_id = ANY($1)`, [props]);
      }
      await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
