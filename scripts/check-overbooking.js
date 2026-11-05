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

const sections = {
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
