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
  async status() {
    const { updateBooking } = require('../src/controllers/bookings');
    const P = await property('OB Status', { overbooking_enabled: true, oversell_max_pct: 100 });
    const A = await roomType(P);
    const r1 = await room(P, A, '1');
    const d = addDays(TODAY, 3);
    await open(P, [r1], addDays(TODAY, -2), 15);
    const put = (id, body) => call(updateBooking, P, { params: { id }, body });

    // cancelling through PUT releases the nights (and hands the room on)
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1)`, [P, A, d]);
    const b = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    const w = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    assert.equal(w.body.room_id, null);
    assert.equal((await put(b.body.id, { status: 'cancelled' })).status, 200);
    assert.deepEqual(await nightsOf(b.body.id), [], 'PUT cancelled releases nights');
    assert.deepEqual((await nightsOf(w.body.id)).map((n) => n.room_id), [r1], 'and the room goes to the waiting booking');

    // a booking that no longer holds rooms can't be put back into a holding status
    const back = await put(b.body.id, { status: 'confirmed' });
    assert.equal(back.status, 409, 'cancelled -> confirmed refused');
    const o = await book(P, { room_type_id: A, check_in: addDays(TODAY, 6), check_out: addDays(TODAY, 7) });
    await pool.query(`UPDATE booking SET status = 'checked_out' WHERE id = $1`, [o.body.id]);
    assert.equal((await put(o.body.id, { status: 'checked_in' })).status, 409, 'checked_out -> checked_in refused');

    // checking in to a room keeps the guest there for later waiting nights when it's free
    const T = TODAY;
    const Q = await property('OB Status CheckIn', { overbooking_enabled: true, oversell_max_pct: 100 });
    const QA = await roomType(Q);
    const q1 = await room(Q, QA, '1');
    await open(Q, [q1], T, 5);
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1), ($1, $2, $4, 1)`, [Q, QA, T, addDays(T, 1)]);
    const full = await call(require('../src/controllers/bookings').createBooking, Q, { body: { guest_id: await guest(Q), room_type_id: QA, check_in: T, check_out: addDays(T, 2) }, extra: { auth_method: 'clerk' } });
    const wq = await call(require('../src/controllers/bookings').createBooking, Q, { body: { guest_id: await guest(Q), room_type_id: QA, check_in: T, check_out: addDays(T, 2) }, extra: { auth_method: 'clerk' } });
    assert.equal(wq.body.room_id, null);
    // the first guest leaves without the room being handed on (as if staff cleared it by hand)
    await pool.query('DELETE FROM booking_night WHERE booking_id = $1', [full.body.id]);
    await pool.query(`UPDATE booking SET status = 'cancelled' WHERE id = $1`, [full.body.id]);
    await pool.query('UPDATE room_availability SET is_available = true WHERE room_id = $1', [q1]);
    const ci = await call(updateBooking, Q, { params: { id: wq.body.id }, body: { status: 'checked_in', room_id: q1 } });
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    assert.deepEqual((await nightsOf(wq.body.id)).map((n) => n.room_id), [q1, q1], 'check-in keeps the room for later free nights');
  },

  async blocks() {
    const { upsertRoomAvailability } = require('../src/controllers/availability');
    const { cancelBooking } = require('../src/controllers/bookings');
    const { typeCounts } = require('../src/lib/roomNights');
    const P = await property('OB Blocks', { overbooking_enabled: true, oversell_max_pct: 100 });
    const A = await roomType(P);
    const r1 = await room(P, A, '1');
    const d = addDays(TODAY, 6);
    await open(P, [r1], TODAY, 15);
    const setFlag = (date, is_available) => call(upsertRoomAvailability, P, { params: { room_id: r1 }, body: { dates: [{ date, is_available }] } });

    // a staff block on a booked night survives the booking leaving
    const b = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    assert.equal(b.body.room_id, r1);
    assert.equal((await setFlag(d, false)).status, 200);
    assert.equal((await call(cancelBooking, P, { params: { id: b.body.id }, extra: { auth_method: 'clerk', query: {} } })).status, 200);
    assert.equal((await one('SELECT is_available FROM room_availability WHERE room_id = $1 AND date = $2', [r1, d])).is_available, false, 'staff block survives the booking leaving');
    assert.equal((await typeCounts(pool, P, A, [d])).get(`${A}|${d}`).blocked, 1);

    // unblocking a room places a booking waiting for that type
    const d2 = addDays(d, 3);
    await setFlag(d2, false);
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1)`, [P, A, d2]);
    const w = await book(P, { room_type_id: A, check_in: d2, check_out: addDays(d2, 1) });
    assert.equal(w.status, 201, JSON.stringify(w.body)); assert.equal(w.body.room_id, null);
    assert.equal((await setFlag(d2, true)).status, 200);
    assert.deepEqual((await nightsOf(w.body.id)).map((n) => n.room_id), [r1], 'unblock places a waiting booking');
  },

  async endpoints() {
    const ob = require('../src/controllers/overbooking');
    const { requirePermission } = require('../src/middleware/auth');
    const gate = requirePermission('overbooking.manage');
    const mw = (fn, req) => new Promise((resolve) => {
      const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
      fn(req, res, () => resolve({ next: true }));
    });
    const P = await property('OB Endpoints');
    const key = (permissions) => ({ auth_method: 'api_key', property_id: P, api_key: { id: 'k', permissions } });
    assert.equal((await mw(gate, key(['housekeeping.manage']))).status, 403, 'scoped key without permission -> 403');
    assert.deepEqual(await mw(gate, key(['overbooking.manage'])), { next: true }, 'scoped key with overbooking.manage passes');
    assert.deepEqual(await mw(gate, key(null)), { next: true }, 'full key passes');

    // settings
    assert.equal((await call(ob.putSettings, P, { body: { max_pct: 120 } })).status, 400);
    assert.equal((await call(ob.putSettings, P, { body: { room_lock_days: -1 } })).status, 400);
    const st = await call(ob.putSettings, P, { body: { enabled: true, max_pct: 50, room_lock_days: 2 } });
    assert.deepEqual(st.body, { enabled: true, max_pct: 50, room_lock_days: 2 });

    const A = await roomType(P);
    const [r1, r2] = [await room(P, A, '1'), await room(P, A, '2')];
    const d = addDays(TODAY, 5);
    await open(P, [r1, r2], TODAY, 10);

    // model post replaces range
    const post = (allowances) => call(ob.postAllowances, P, { body: { model: 'safe-95', from: d, to: addDays(d, 2), allowances } });
    assert.equal((await post([{ room_type_id: A, date: d, allowance: 2 }, { room_type_id: A, date: addDays(d, 1), allowance: 1 }])).body.saved, 2);
    assert.equal((await call(ob.putManual, P, { params: { room_type_id: A, date: addDays(d, 1) }, body: { manual_allowance: 3 } })).status, 200);
    await post([{ room_type_id: A, date: d, allowance: 1 }]);
    const rows = async () => (await pool.query(`SELECT date::text, model_allowance, manual_allowance, model FROM room_type_oversell WHERE room_type_id = $1 ORDER BY date`, [A])).rows;
    assert.deepEqual(await rows(), [
      { date: d, model_allowance: 1, manual_allowance: null, model: 'safe-95' },
      { date: addDays(d, 1), model_allowance: 0, manual_allowance: 3, model: 'safe-95' },
    ], 'model post replaces range, keeps manual');
    // manual null hands back to model
    await call(ob.putManual, P, { params: { room_type_id: A, date: addDays(d, 1) }, body: { manual_allowance: null } });
    assert.equal((await rows())[1].manual_allowance, null, 'manual null hands back to model');
    assert.equal((await call(ob.putManual, P, { params: { room_type_id: A, date: d }, body: { manual_allowance: -1 } })).status, 400);
    assert.equal((await post([{ room_type_id: A, date: addDays(d, 5), allowance: 1 }])).status, 400, 'date outside range -> 400');
    assert.equal((await post([{ room_type_id: A, date: d, allowance: 1.5 }])).status, 400, 'non-integer -> 400');

    // other property's room type -> 400
    const Q = await property('OB Endpoints Other');
    const QA = await roomType(Q);
    const bad = await post([{ room_type_id: QA, date: d, allowance: 1 }]);
    assert.equal(bad.status, 400); assert.deepEqual(bad.body.details, [QA], "other property's room type -> 400");

    // overview: cap 50% of 2 = 1, model 1 on d
    const ov = await call(ob.getOverview, P, { query: { from: d, to: addDays(d, 1) } });
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    assert.deepEqual(ov.body, [{ room_type_id: A, date: d, rooms: 2, sold: 0, model_allowance: 1, manual_allowance: null, cap: 1, effective_allowance: 1, sellable: 3, unplaced: 0 }]);
    assert.equal((await call(ob.getOverview, P, { query: { from: d, to: addDays(d, 500) } })).status, 400, 'range capped');

    // arrivals lists unplaced guest and free rooms
    await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    const u = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    assert.equal(u.body.room_id, null);
    const arr = (await call(ob.getArrivals, P, { query: { date: d } })).body;
    assert.deepEqual(arr.unplaced_arrivals.map((b) => b.id), [u.body.id], 'arrivals lists unplaced guest');
    assert.deepEqual(arr.unplaced_in_house, []);
    assert.deepEqual(arr.free_rooms, [], 'no free rooms that night');
    const arr2 = (await call(ob.getArrivals, P, { query: { date: addDays(d, 1) } })).body;
    assert.deepEqual(arr2.free_rooms, [{ room_type_id: A, rooms: [{ id: r1, room_number: '1' }, { id: r2, room_number: '2' }] }], 'free rooms by type');
  },

  async readers() {
    const { listBookings, getBooking } = require('../src/controllers/bookings');
    const { fetchJoinedBooking } = require('../src/lib/roomPayments');
    const { computeFolio } = require('../src/lib/folio');
    const P = await property('OB Readers', { overbooking_enabled: true, oversell_max_pct: 100 });
    const A = await roomType(P);
    const r1 = await room(P, A, '1');
    const d = addDays(TODAY, 4);
    await open(P, [r1], TODAY, 10);
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1)`, [P, A, d]);
    await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    const o = await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    assert.equal(o.body.room_id, null); assert.equal(o.body.room_type_id, A, 'create response carries sold type');
    const listed = (await call(listBookings, P)).body.data.find((b) => b.id === o.body.id);
    assert.ok(listed, 'oversold booking visible in list');
    assert.equal(listed.room_type_id, A); assert.equal(listed.room_number, null);
    assert.deepEqual(listed.nights, [{ night: d, room_id: null, room_number: null }]);
    const detail = (await call(getBooking, P, { params: { id: o.body.id } })).body;
    assert.equal(detail.id, o.body.id, 'visible in detail'); assert.equal(detail.room_pick, false);
    assert.equal((await fetchJoinedBooking(o.body.id)).room_type_name, 'Std', 'live payload has sold type');
    const folio = await computeFolio(o.body.id, P);
    assert.ok(folio, 'folio works with no room'); assert.equal(Number(folio.balance), 100);

    // emails render with no room (the context loader the confirmation uses)
    await pool.query(`UPDATE booking SET rate_plan_terms = '{"refundable":true,"cancel_cutoff_hours":48,"payment_mode":"hold","mode_used":"hold","pay_at_hotel":true}' WHERE id = $1`, [o.body.id]);
    const ctx = await require('../src/lib/roomBookingEmails').loadEmailContext(o.body.id);
    assert.equal(ctx?.b.room_type_name, 'Std', 'emails render with no room');
  },

  async housekeeping() {
    const hk = require('../src/lib/housekeeping');
    const P = await property('OB HK', { overbooking_enabled: true, oversell_max_pct: 100, enabled_modules: JSON.stringify(['housekeeping']) });
    const A = await roomType(P);
    const [r1, r2] = [await room(P, A, '1'), await room(P, A, '2')];
    const D = addDays(TODAY, 2);
    // split stay: r1 on D-1, r2 on D (moved on D), leaves D+1
    const s = await rawBooking(P, A, r2, addDays(D, -1), addDays(D, 1));
    await hold(P, s, addDays(D, -1), r1); await hold(P, s, D, r2);
    // an unplaced booking on D (oversold, waiting)
    const u = await rawBooking(P, A, null, D, addDays(D, 1));
    await hold(P, u, D, null);
    await hk.ensureJobs(pool, P, D); // ensureJobs survives unplaced bookings
    const jobs = (await pool.query(`SELECT r.room_number, j.kind FROM hk_job j JOIN room r ON r.id = j.room_id WHERE j.property_id = $1 AND j.date = $2 ORDER BY 1, 2`, [P, D])).rows;
    assert.deepEqual(jobs.map((j) => `${j.room_number}:${j.kind}`), ['1:checkout'], 'split stay makes a checkout of the old room on the move day');
    await pool.query('DELETE FROM hk_job WHERE property_id = $1', [P]);
  },

  async channels() {
    const { desiredAri } = require('../src/lib/channels/desired');
    const P = await property('OB Channels', { overbooking_enabled: true, oversell_max_pct: 100 });
    const A = await roomType(P);
    const r1 = await room(P, A, '1');
    const d = addDays(TODAY, 3);
    await open(P, [r1], TODAY, 10);
    const ch = await one(`INSERT INTO channel (property_id, adapter, name, horizon_days) VALUES ($1, 'test', 'OB', 10) RETURNING *`, [P]);
    await pool.query(`INSERT INTO channel_mapping (property_id, channel_id, room_type_id, room_code, rate_code) VALUES ($1, $2, $3, 'STD', 'BAR')`, [P, ch.id, A]);
    const avail = async () => (await desiredAri(pool, ch, TODAY)).find((x) => x.date === d).available;
    assert.equal(await avail(), 1, 'one free room');
    assert.equal((await book(P, { room_type_id: A, check_in: d, check_out: addDays(d, 1) })).body.room_id, r1);
    assert.equal(await avail(), 0, 'sold out, no allowance');
    await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1, $2, $3, 1)`, [P, A, d]);
    assert.equal(await avail(), 1, 'channel push includes allowance');
    await pool.query('DELETE FROM channel WHERE property_id = $1', [P]);
  },

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
    await pool.query(`INSERT INTO room_availability (property_id, room_id, date) SELECT $1, id, $2 FROM room WHERE property_id = $1`, [P, N]); // seeded horizon
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
    await pool.query(`UPDATE room_availability SET is_available = false WHERE room_id = ANY($1) AND date = $2`, [[r1, r2], N]);
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

    // An upgrade counts where the guest sleeps: overbooking off, an A guest moved
    // into the only D room leaves D with nothing to sell and frees an A room.
    const { moveBooking } = require('../src/controllers/bookings');
    const Q = await property('OB Counts Upgrade');
    const QA = await roomType(Q, 'Std', 100);
    const QD = await roomType(Q, 'Deluxe', 200);
    const [qa1, qd1] = [await room(Q, QA, '1'), await room(Q, QD, '9')];
    const u = addDays(TODAY, 8);
    await open(Q, [qa1, qd1], TODAY, 20);
    const g0 = await guest(Q);
    const ub = await call(require('../src/controllers/bookings').createBooking, Q, { body: { guest_id: g0, room_type_id: QA, check_in: u, check_out: addDays(u, 1) }, extra: { auth_method: 'clerk' } });
    assert.equal((await call(moveBooking, Q, { params: { id: ub.body.id }, body: { room_id: qd1 } })).status, 200);
    const qc = await typeCounts(pool, Q, null, [u]);
    assert.equal(qc.get(`${QD}|${u}`).sellable, 0, 'upgraded-into type has nothing left to sell');
    assert.equal(qc.get(`${QA}|${u}`).sellable, 1, 'the upgraded guest frees their sold type');

    // Beyond the seeded availability horizon nothing is sellable (no oversell into the void).
    const far = addDays(TODAY, 40);
    assert.equal((await typeCounts(pool, Q, QA, [far])).get(`${QA}|${far}`).sellable, 0, 'nothing sellable past the horizon');
  },


  async migration() {
    const P = await property('OB Migration');
    const A = await roomType(P);
    const [r1, r2] = [await room(P, A, '1'), await room(P, A, '2')];
    const g = await guest(P);
    const nightsOf2 = async (b) => (await pool.query(`SELECT night::text, room_id FROM booking_night WHERE booking_id = $1 ORDER BY night`, [b])).rows;
    // Old code (between migration A and the deploy) never writes room_type_id or booking_night.
    const oldInsert = async (roomId, cin, cout, status = 'confirmed') => (await one(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status)
       VALUES ($1, $2, $3, $4, $5, 300, $6) RETURNING id, room_type_id`, [P, g, roomId, cin, cout, status]));
    const b0 = await oldInsert(r1, '2030-01-01', '2030-01-04');
    assert.equal(b0.room_type_id, A, 'old-code insert gets its sold type from the room');

    // A backfilled booking the old code then cancels: its nights must go.
    const bc = await oldInsert(r2, '2030-02-01', '2030-02-03');
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
    assert.equal((await nightsOf2(bc.id)).length, 2);
    await pool.query(`UPDATE booking SET status = 'cancelled' WHERE id = $1`, [bc.id]);
    // A backfilled booking the old code moves (channel modify): rebuilt on the new room and dates.
    const bm = await oldInsert(r1, '2030-03-01', '2030-03-03');
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
    await pool.query(`UPDATE booking SET room_id = $2, check_in = '2030-03-02', check_out = '2030-03-04' WHERE id = $1`, [bm.id, r2]);
    // A booking new code has placed (a logged move) is left alone.
    const bn = await oldInsert(r1, '2030-04-01', '2030-04-02');
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
    await pool.query(`UPDATE booking_night SET room_id = $2 WHERE booking_id = $1`, [bn.id, r2]);
    await pool.query(`INSERT INTO booking_room_move (property_id, booking_id, night_from, night_to, to_room_id, reason) VALUES ($1, $2, '2030-04-01', '2030-04-02', $3, 'move')`, [P, bn.id, r2]);
    // A long-gone checked_out booking keeps only past nights.
    const bo = await oldInsert(r2, addDays(TODAY, -2), addDays(TODAY, 2), 'checked_out');

    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
    await runSql('src/db/migrate-2026-11-05-overbooking-b.sql'); // idempotent
    assert.equal((await nightsOf2(b0.id)).length, 3, 'nights backfilled');
    assert.deepEqual(await nightsOf2(bc.id), [], 'old-code cancel: stale nights removed');
    assert.deepEqual(await nightsOf2(bm.id), [{ night: '2030-03-02', room_id: r2 }, { night: '2030-03-03', room_id: r2 }], 'old-code modify: nights rebuilt');
    assert.deepEqual(await nightsOf2(bn.id), [{ night: '2030-04-01', room_id: r2 }], 'new-code placement kept');
    assert.deepEqual((await nightsOf2(bo.id)).map((n) => n.night), [addDays(TODAY, -2), addDays(TODAY, -1)], 'checked_out keeps past nights only');
    // Deploy-to-B gap: new code cancels a booking that has no night rows yet -> the room's flags reopen.
    const bw = await oldInsert(r1, '2030-05-01', '2030-05-03');
    await open(P, [r1], '2030-05-01', 2);
    await pool.query(`UPDATE room_availability SET is_available = false WHERE room_id = $1 AND date >= '2030-05-01' AND date < '2030-05-03'`, [r1]);
    const { releaseNights } = require('../src/lib/roomNights');
    const c = await pool.connect();
    try { await c.query('BEGIN'); await releaseNights(c, await one('SELECT * FROM booking WHERE id = $1', [bw.id])); await c.query('COMMIT'); } finally { c.release(); }
    assert.equal((await one(`SELECT count(*)::int AS n FROM room_availability WHERE room_id = $1 AND date >= '2030-05-01' AND date < '2030-05-03' AND is_available`, [r1])).n, 2, 'release of a booking with no night rows reopens its room');
    const p = await one('SELECT overbooking_enabled, oversell_max_pct, room_lock_days FROM property WHERE id = $1', [P]);
    assert.deepEqual({ ...p, oversell_max_pct: Number(p.oversell_max_pct) }, { overbooking_enabled: false, oversell_max_pct: 0, room_lock_days: 1 });
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
      for (const t of ['hk_job', 'booking_room_move', 'booking_night', 'room_type_oversell', 'payment', 'booking', 'channel', 'guest', 'room_availability', 'room', 'room_type']) {
        await pool.query(`DELETE FROM ${t} WHERE property_id = ANY($1)`, [props]);
      }
      await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    }
    await require('../src/lib/channels/sync')._flush().catch(() => {}); // a debounced sync must not outlive the pool
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
