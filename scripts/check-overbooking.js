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

const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = new Date().toISOString().slice(0, 10); // throwaway properties default to UTC
// Seed open availability rows (the seeder's job) for rooms over [from, from + days).
async function open(P, rooms, from, days) {
  for (const r of rooms) for (let i = 0; i < days; i++) {
    await pool.query(`INSERT INTO room_availability (property_id, room_id, date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [P, r, addDays(from, i)]);
  }
}
const nightsOf = async (b) => (await pool.query(
  `SELECT night::text, room_id FROM booking_night WHERE booking_id = $1 ORDER BY night`, [b])).rows;
async function book(P, body) {
  const { createBooking } = require('../src/controllers/bookings');
  return call(createBooking, P, { body: { guest_id: await guest(P), ...body }, extra: { auth_method: 'clerk' } });
}

const sections = {
  async move() {
    const ctrl = require('../src/controllers/bookings');
    const P = await property('OB Move', { overbooking_enabled: true, oversell_max_pct: 100 });
    const A = await roomType(P, 'Std', 100);
    const D = await roomType(P, 'Deluxe', 200);
    const [a1, a2, d1] = [await room(P, A, '1'), await room(P, A, '2'), await room(P, D, '9')];
    await open(P, [a1, a2, d1], addDays(TODAY, -2), 30);
    const d = addDays(TODAY, 10);

    // move upgrade logs reason, keeps price and sold type, frees the old room
    const b = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 2) });
    const mv = await call(ctrl.moveBooking, P, { params: { id: b.body.id }, body: { room_id: d1, from: d } });
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    assert.deepEqual((await nightsOf(b.body.id)).map((n) => n.room_id), [d1, d1]);
    assert.equal((await one(`SELECT reason FROM booking_room_move WHERE booking_id = $1 ORDER BY moved_at DESC LIMIT 1`, [b.body.id])).reason, 'upgrade', 'move upgrade logs reason');
    const after = await one('SELECT total_price, room_type_id, room_id FROM booking WHERE id = $1', [b.body.id]);
    assert.equal(Number(after.total_price), 200, 'move keeps price'); assert.equal(after.room_type_id, A); assert.equal(after.room_id, d1);
    assert.equal((await one(`SELECT is_available FROM room_availability WHERE room_id = $1 AND date = $2`, [a1, d])).is_available, true, 'old room reopened');
    assert.equal((await call(ctrl.moveBooking, P, { params: { id: b.body.id }, body: { room_id: d1, reason: 'nope' } })).status, 400);

    // check-in without room -> 409 room_required; with room_id places tonight only
    const T = TODAY;
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 2), ($1, $2, $4, 2)`, [P, A, T, addDays(T, 1)]);
    const x1 = await book(P, { room_type_id: A, check_in: T, check_out: addDays(T, 2) });                 // a1
    const x2 = await book(P, { room_type_id: A, check_in: addDays(T, 1), check_out: addDays(T, 2) });    // a2 tomorrow
    const w = await book(P, { room_type_id: A, check_in: T, check_out: addDays(T, 2) });                  // no room both nights? a2 free tonight only
    assert.equal(x1.body.room_id, a1); assert.equal(x2.body.room_id, a2); assert.equal(w.body.room_id, null);
    const noRoom = await call(ctrl.updateBooking, P, { params: { id: w.body.id }, body: { status: 'checked_in' } });
    assert.equal(noRoom.status, 409); assert.equal(noRoom.body.error, 'room_required', 'check-in without room -> 409 room_required');
    const ci = await call(ctrl.updateBooking, P, { params: { id: w.body.id }, body: { status: 'checked_in', room_id: a2 } });
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    assert.deepEqual((await nightsOf(w.body.id)).map((n) => n.room_id), [a2, null], 'check-in with room_id for tonight only');

    // walk frees nights and assigns waiting; walk refused on checked_in
    const wd = addDays(TODAY, 20);
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1)`, [P, D, wd]);
    const k1 = await book(P, { room_type_id: D, check_in: wd, check_out: addDays(wd, 1) });
    const k2 = await book(P, { room_type_id: D, check_in: wd, check_out: addDays(wd, 1) });
    assert.equal(k2.body.room_id, null);
    const walked = await call(ctrl.walkBooking, P, { params: { id: k1.body.id }, body: { note: 'sent to Hotel Sol' } });
    assert.equal(walked.status, 200, JSON.stringify(walked.body));
    const k1row = await one('SELECT status, metadata FROM booking WHERE id = $1', [k1.body.id]);
    assert.equal(k1row.status, 'walked'); assert.equal(k1row.metadata.walk_note, 'sent to Hotel Sol');
    assert.deepEqual(await nightsOf(k1.body.id), []);
    assert.deepEqual((await nightsOf(k2.body.id)).map((n) => n.room_id), [d1], 'walk frees nights and assigns waiting');
    assert.equal((await call(ctrl.walkBooking, P, { params: { id: w.body.id }, body: {} })).status, 409, 'walk refused on checked_in');
    assert.equal((await call(ctrl.updateBooking, P, { params: { id: k2.body.id }, body: { status: 'walked' } })).status, 400, 'walked only via /walk');
    assert.equal((await call(ctrl.cancelBooking, P, { params: { id: k1.body.id }, extra: { auth_method: 'clerk', query: {} } })).status, 404, 'walked booking cannot be cancelled');
  },

  async release() {
    const { cancelBooking, updateBooking } = require('../src/controllers/bookings');
    const P = await property('OB Release', { overbooking_enabled: true, oversell_max_pct: 100 });
    const A = await roomType(P);
    const r1 = await room(P, A, '1');
    const d = addDays(TODAY, 10);
    await open(P, [r1], addDays(TODAY, -3), 30);
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1), ($1, $2, $4, 1)`, [P, A, d, addDays(d, 1)]);

    // cancel frees room and assigns waiting
    const b1 = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 2) });
    const b2 = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 2) });
    assert.equal(b1.body.room_id, r1); assert.equal(b2.body.room_id, null);
    assert.equal((await call(cancelBooking, P, { params: { id: b1.body.id }, extra: { auth_method: 'clerk', query: {} } })).status, 200);
    assert.deepEqual(await nightsOf(b1.body.id), [], 'cancelled holds nothing');
    assert.deepEqual((await nightsOf(b2.body.id)).map((n) => n.room_id), [r1, r1], 'cancel frees room and assigns waiting');
    assert.equal((await one(`SELECT room_id FROM booking WHERE id = $1`, [b2.body.id])).room_id, r1, 'current room synced');
    assert.equal((await one(`SELECT count(*)::int AS n FROM booking_room_move WHERE booking_id = $1 AND reason = 'assign'`, [b2.body.id])).n, 1);

    // early check-out frees future nights only
    const cin = addDays(TODAY, -1);
    const e = await book(P, { room_type_id: A, check_in: addDays(TODAY, 20), check_out: addDays(TODAY, 21) }); // placeholder guest/booking
    await pool.query(`DELETE FROM booking_night WHERE booking_id = $1`, [e.body.id]);
    await pool.query(`UPDATE booking SET check_in = $2, check_out = $3, status = 'checked_in' WHERE id = $1`, [e.body.id, cin, addDays(TODAY, 2)]);
    for (let i = 0; i < 3; i++) await hold(P, e.body.id, addDays(cin, i), r1);
    await pool.query(`UPDATE room_availability SET is_available = false WHERE room_id = $1 AND date >= $2 AND date < $3`, [r1, cin, addDays(TODAY, 2)]);
    const out = await call(updateBooking, P, { params: { id: e.body.id }, body: { status: 'checked_out', force: true } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual((await nightsOf(e.body.id)).map((n) => n.night), [cin], 'early check-out frees future nights only');
    assert.equal((await one(`SELECT is_available FROM room_availability WHERE room_id = $1 AND date = $2`, [r1, TODAY])).is_available, true, 'flag reopened');

    // expire releases
    const x = await book(P, { room_type_id: A, check_in: addDays(TODAY, 25), check_out: addDays(TODAY, 26) });
    await pool.query(`UPDATE booking SET status = 'pending_payment', payment_due_at = now() - interval '1 minute' WHERE id = $1`, [x.body.id]);
    await require('../src/lib/roomPayments').expireOnce();
    assert.equal((await one(`SELECT status FROM booking WHERE id = $1`, [x.body.id])).status, 'expired');
    assert.deepEqual(await nightsOf(x.body.id), [], 'expire releases');
  },

  async hold() {
    const P = await property('OB Hold', { overbooking_enabled: true, oversell_max_pct: 50 });
    const A = await roomType(P);
    const [r1, r2] = [await room(P, A, '1'), await room(P, A, '2')];
    const d = addDays(TODAY, 10);
    await open(P, [r1, r2], TODAY, 20);

    // type booking auto-assigns
    const b1 = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 2) });
    assert.equal(b1.status, 201, JSON.stringify(b1.body));
    assert.equal(b1.body.room_id, r1); assert.equal(b1.body.room_pick, false); assert.equal(b1.body.room_type_id, A);
    assert.deepEqual((await nightsOf(b1.body.id)).map((n) => n.room_id), [r1, r1], 'type booking auto-assigns');
    assert.equal((await one(`SELECT count(*)::int AS n FROM room_availability WHERE room_id = $1 AND NOT is_available`, [r1])).n, 2, 'flags closed');

    // pick bumps auto-assigned
    const b2 = await book(P, { room_id: r1, check_in: d, check_out: addDays(d, 2) });
    assert.equal(b2.status, 201, JSON.stringify(b2.body));
    assert.equal(b2.body.room_pick, true);
    assert.deepEqual((await nightsOf(b1.body.id)).map((n) => n.room_id), [r2, r2], 'bumped holder re-placed');
    assert.equal((await one(`SELECT reason FROM booking_room_move WHERE booking_id = $1 ORDER BY moved_at DESC, reason LIMIT 1`, [b1.body.id])).reason, 'bump');

    // both rooms taken now; allowance: cap 50% of 2 = 1, model 1 => one oversold booking, then 409
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1), ($1, $2, $4, 1)`, [P, A, d, addDays(d, 1)]);
    const b3 = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 2) });
    assert.equal(b3.status, 201, JSON.stringify(b3.body));
    assert.equal(b3.body.room_id, null, 'oversold booking has no room');
    assert.deepEqual((await nightsOf(b3.body.id)).map((n) => n.room_id), [null, null]);
    assert.equal((await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 2) })).status, 409, 'past allowance => 409');

    // pick refused over a picked booking
    assert.equal((await book(P, { room_id: r1, check_in: d, check_out: addDays(d, 1) })).status, 409, 'pick refused over picked');

    // pick refused inside cutoff (holder arrives tomorrow, lock 1 day)
    const near = await book(P, { room_type_id: A, check_in: addDays(TODAY, 1), check_out: addDays(TODAY, 2) });
    assert.equal(near.body.room_id, r1);
    const refused = await book(P, { room_id: r1, check_in: addDays(TODAY, 1), check_out: addDays(TODAY, 2) });
    assert.equal(refused.status, 409, 'pick refused inside cutoff');
    assert.deepEqual((await nightsOf(near.body.id)).map((n) => n.room_id), [r1], 'holder unchanged');

    // pick refused over checked-in
    const inHouse = await book(P, { room_type_id: A, check_in: addDays(TODAY, 5), check_out: addDays(TODAY, 6) });
    await pool.query(`UPDATE booking SET status = 'checked_in' WHERE id = $1`, [inHouse.body.id]);
    assert.equal((await book(P, { room_id: inHouse.body.room_id, check_in: addDays(TODAY, 5), check_out: addDays(TODAY, 6) })).status, 409, 'pick refused over checked-in');

    // type booking priced at type rate; a pick uses the room's override
    const pd = addDays(TODAY, 15);
    await pool.query(`UPDATE room_availability SET override_rate = 500 WHERE room_id = $1 AND date = $2`, [r1, pd]);
    const typed = await book(P, { room_type_id: A, check_in: pd, check_out: addDays(pd, 1) });
    assert.equal(typed.body.room_id, r1); assert.equal(Number(typed.body.total_price), 100, 'type booking priced at type rate');
    const picked = await book(P, { room_id: r1, check_in: pd, check_out: addDays(pd, 1) });
    assert.equal(picked.status, 201); assert.equal(Number(picked.body.total_price), 500, 'pick priced at room override');

    // race: two concurrent bookings for last slot
    const Q = await property('OB Race');
    const QA = await roomType(Q);
    const q1 = await room(Q, QA, '1');
    await open(Q, [q1], TODAY, 20);
    const [g1, g2] = [await guest(Q), await guest(Q)];
    const { createBooking } = require('../src/controllers/bookings');
    const race = await Promise.all([g1, g2].map((guest_id) => call(createBooking, Q,
      { body: { guest_id, room_type_id: QA, check_in: d, check_out: addDays(d, 1) }, extra: { auth_method: 'clerk' } })));
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409], 'race: two concurrent bookings for last slot');
  },

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
