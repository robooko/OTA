// Housekeeping checks: pure rules, then the controllers driven directly
// (bearer routes can't be reached over HTTP without a real Clerk token),
// then the public guest form over HTTP. Fixtures live under throwaway
// properties and are deleted at the end (pass or fail). Local DB only, with
// migrate-2026-10-31-housekeeping.sql applied.
//   node -r dotenv/config scripts/check-housekeeping.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const hk = require('../src/lib/housekeeping');
const { nightIndex, stayoverDue, linenDue, scoreInspection, statusAfterFinish } = hk;
const ably = require('../src/lib/ably');
const ctrl = require('../src/controllers/housekeeping');

// Drives a controller directly; resolves the response.
const call = async (fn, req) => {
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } };
  let error;
  await fn({ params: {}, query: {}, body: {}, headers: {}, auth_method: 'bearer', ...req }, res, (e) => { error = e; });
  if (error) throw error;
  return res;
};
// Every Ably publish lands here instead.
const published = [];
ably.publishHousekeeping = async (propertyId, event, payload) => { published.push({ propertyId, event, payload }); };
hk.staffName = async (id) => `Name ${id}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

  const run = crypto.randomBytes(4).toString('hex');
  const props = [];
  const newProperty = async (name, modules, timezone = 'Europe/London') => {
    const id = (await one(
      `INSERT INTO property (name, clerk_org_id, slug, timezone, enabled_modules) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [`${name} ${run}`, `org_hkchk_${run}`, `hk-${props.length}-${run}`, timezone, modules ? JSON.stringify(modules) : null]
    )).id;
    props.push(id);
    return id;
  };

  try {
    // ── Task 1: pure rules and schema ──────────────────────────────────────
    await check('nightIndex counts days from check-in', () => {
      assert.equal(nightIndex('2030-07-01', '2030-07-03'), 2);
      assert.equal(nightIndex('2030-12-31', '2031-01-01'), 1);
    });
    await check('stayoverDue / linenDue: every n nights, never night 0, null = never', () => {
      assert.equal(stayoverDue(2, 2), true); assert.equal(stayoverDue(3, 2), false);
      assert.equal(stayoverDue(0, 1), false); assert.equal(stayoverDue(2, null), false);
      assert.equal(linenDue(4, 4), true); assert.equal(linenDue(2, 4), false);
    });
    await check('scoreInspection: pass, fail with snapshot, and refusals', () => {
      const items = [{ id: 'a', name: 'Floor', pass_mark: 4 }, { id: 'b', name: 'Bath', pass_mark: 3 }];
      assert.equal(scoreInspection(items, [{ item_id: 'a', score: 4 }, { item_id: 'b', score: 3 }]).passed, true);
      const f = scoreInspection(items, [{ item_id: 'a', score: 3, comment: 'hair' }, { item_id: 'b', score: 5 }]);
      assert.equal(f.passed, false); assert.equal(f.score, 4); assert.equal(f.rows[0].item_name, 'Floor');
      assert.equal(f.rows[0].pass_mark, 4); assert.equal(f.rows[0].comment, 'hair');
      assert.match(scoreInspection(items, [{ item_id: 'a', score: 4 }]).error, /Bath/);
      assert.match(scoreInspection(items, [{ item_id: 'a', score: 6 }, { item_id: 'b', score: 3 }]).error, /1.+5/);
      assert.match(scoreInspection(items, [{ item_id: 'a', score: 3.5 }, { item_id: 'b', score: 3 }]).error, /1.+5/);
      assert.ok(scoreInspection(items, [{ item_id: 'a', score: 4 }, { item_id: 'a', score: 4 }, { item_id: 'b', score: 3 }]).error);
      assert.ok(scoreInspection(items, [{ item_id: 'a', score: 4 }, { item_id: 'b', score: 3 }, { item_id: 'z', score: 3 }]).error);
      assert.ok(scoreInspection(items, 'nope').error);
    });
    await check('statusAfterFinish: clean only for inspected checkouts', () => {
      assert.equal(statusAfterFinish('checkout', true), 'clean');
      assert.equal(statusAfterFinish('checkout', false), 'ready');
      assert.equal(statusAfterFinish('stayover', true), 'ready');
    });
    await check('schema: room defaults to ready, migration re-runs cleanly', async () => {
      const P = await newProperty('HK Schema', ['rooms', 'housekeeping']);
      const rt = await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P]);
      const room = await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'S1') RETURNING *`, [P, rt.id]);
      assert.equal(room.housekeeping_status, 'ready');
      await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/migrate-2026-10-31-housekeeping.sql'), 'utf8'));
      const p = await one('SELECT hk_inspection_required FROM property WHERE id = $1', [P]);
      assert.equal(p.hk_inspection_required, false);
    });

    // ── Task 2: jobs, board, overrides, settings, room status ──────────────
    const D = '2031-03-10';
    const P = await newProperty('HK Board', ['rooms', 'housekeeping'], 'Pacific/Auckland');
    await pool.query('UPDATE property SET hk_service_every_days = 2, hk_linen_every_days = 4 WHERE id = $1', [P]);
    const RT = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Deluxe', 2, 100) RETURNING id`, [P])).id;
    const room = {};
    for (const n of ['101', '102', '103', '104']) room[n] = (await one(`INSERT INTO room (property_id, room_type_id, room_number, floor) VALUES ($1, $2, $3, 1) RETURNING id`, [P, RT, n])).id;
    const G = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Ada', 'Guest', $2) RETURNING id`, [P, `ada-${run}@example.com`])).id;
    const book = async (roomId, inD, outD, status, extra = {}) => (await one(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status, metadata, rate_plan_id) VALUES ($1, $2, $3, $4, $5, 300, $6, $7::jsonb, $8) RETURNING id`,
      [extra.property ?? P, extra.guest ?? G, roomId, inD, outD, status, JSON.stringify(extra.metadata ?? {}), extra.rate_plan_id ?? null])).id;
    const B1dep = await book(room['101'], addDays(D, -3), D, 'checked_in');
    const B1arr = await book(room['101'], D, addDays(D, 2), 'confirmed', { metadata: { arrival_time: '15:00' } });
    const B2 = await book(room['102'], addDays(D, -2), addDays(D, 2), 'checked_in');
    const B3 = await book(room['103'], D, addDays(D, 1), 'confirmed');
    const EX = (await one(`INSERT INTO extra (property_id, name, price, place_in_room) VALUES ($1, 'Red Roses', 120, true) RETURNING id`, [P])).id;
    const EXno = (await one(`INSERT INTO extra (property_id, name, price) VALUES ($1, 'Airport transfer', 50) RETURNING id`, [P])).id;
    const BE3 = (await one(`INSERT INTO booking_extra (booking_id, extra_id, quantity, unit_price) VALUES ($1, $2, 1, 120) RETURNING id`, [B3, EX])).id;
    await pool.query(`INSERT INTO booking_extra (booking_id, extra_id, quantity, unit_price) VALUES ($1, $2, 1, 50)`, [B3, EXno]);
    const staffA = { id: `user_a_${run}`, role: 'staff' };
    const staffB = { id: `user_b_${run}`, role: 'staff' };
    const admin = { id: `user_admin_${run}`, role: 'admin' };
    const board = async (date = D, property = P) => (await call(ctrl.board, { property_id: property, user: staffA, query: { date } })).body;
    const jobFor = (rows, roomId) => rows.filter((j) => j.room.id === roomId);

    await check('board builds checkout, stayover and arrival jobs', async () => {
      const rows = await board();
      const j101 = jobFor(rows, room['101']); const j102 = jobFor(rows, room['102']); const j103 = jobFor(rows, room['103']);
      assert.equal(j101.length, 1); assert.equal(j101[0].kind, 'checkout'); assert.equal(j101[0].linen_due, true);
      assert.equal(j101[0].booking.booking_id, B1dep); assert.equal(j101[0].arriving.booking_id, B1arr);
      assert.equal(j101[0].arriving.arrival_time, '15:00'); assert.equal(j101[0].arriving.guest_name, 'Ada Guest');
      assert.equal(j102.length, 1); assert.equal(j102[0].kind, 'stayover'); assert.equal(j102[0].linen_due, false);
      assert.equal(j102[0].booking.booking_id, B2);
      assert.equal(j103.length, 1); assert.equal(j103[0].kind, 'arrival'); assert.equal(j103[0].booking, null);
      assert.deepEqual(j103[0].extras_to_place.map((e) => e.name), ['Red Roses']);
      assert.equal(j103[0].extras_to_place[0].booking_extra_id, BE3);
      assert.equal(jobFor(rows, room['104']).length, 0);
      assert.deepEqual(rows.map((j) => j.kind), ['checkout', 'arrival', 'stayover']); // all ready: kind order
    });
    await check('stayover only on service nights', async () => {
      assert.equal(jobFor(await board(addDays(D, -1)), room['102']).length, 0); // night 1
      assert.equal(jobFor(await board(addDays(D, 1)), room['102']).length, 0);  // night 3
    });
    await check('board is idempotent', async () => {
      const before = (await one('SELECT count(*)::int AS n FROM hk_job WHERE property_id = $1', [P])).n;
      await board(); await board();
      assert.equal((await one('SELECT count(*)::int AS n FROM hk_job WHERE property_id = $1', [P])).n, before);
    });
    await check('dirty room with an arrival sorts first', async () => {
      await pool.query(`UPDATE room SET housekeeping_status = 'dirty' WHERE id = $1`, [room['103']]);
      assert.equal((await board())[0].room.id, room['103']);
      await pool.query(`UPDATE room SET housekeeping_status = 'ready' WHERE id = $1`, [room['103']]);
    });
    await check('skip override skips the stayover; clean override adds an extra job', async () => {
      assert.equal((await call(ctrl.putOverride, { property_id: P, user: staffA, body: { room_id: room['102'], date: D, action: 'skip' } })).statusCode, 200);
      assert.equal(jobFor(await board(), room['102'])[0].status, 'skipped');
      assert.equal((await call(ctrl.putOverride, { property_id: P, user: staffA, body: { room_id: room['104'], date: D, action: 'clean' } })).statusCode, 200);
      const j104 = jobFor(await board(), room['104']);
      assert.equal(j104.length, 1); assert.equal(j104[0].kind, 'extra');
      assert.equal((await call(ctrl.putOverride, { property_id: P, user: staffA, body: { room_id: room['104'], date: D, action: 'nap' } })).statusCode, 400);
      assert.equal((await call(ctrl.deleteOverride, { property_id: P, user: staffA, params: { room_id: room['102'], date: D } })).statusCode, 204);
      assert.equal(jobFor(await board(), room['102'])[0].status, 'open');
      assert.ok(published.some((e) => e.event === 'job-updated' && e.propertyId === P));
    });
    await check('a cancelled booking skips its open job on the next fetch', async () => {
      const tmpRoom = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, '199') RETURNING id`, [P, RT])).id;
      const tmp = await book(tmpRoom, addDays(D, -1), D, 'confirmed');
      assert.equal(jobFor(await board(), tmpRoom)[0].status, 'open');
      await pool.query(`UPDATE booking SET status = 'cancelled' WHERE id = $1`, [tmp]);
      assert.equal(jobFor(await board(), tmpRoom)[0].status, 'skipped');
    });
    await check('propertyToday uses the property timezone', async () => {
      assert.equal(await hk.propertyToday(pool, P), new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date()));
    });
    await check('manual room status', async () => {
      assert.equal((await call(ctrl.putRoomStatus, { property_id: P, user: staffA, params: { room_id: room['104'] }, body: { housekeeping_status: 'filthy' } })).statusCode, 400);
      const r = await call(ctrl.putRoomStatus, { property_id: P, user: staffA, params: { room_id: room['104'] }, body: { housekeeping_status: 'dirty' } });
      assert.equal(r.statusCode, 200); assert.equal(r.body.housekeeping_status, 'dirty');
      assert.ok(published.some((e) => e.event === 'room-status-changed' && e.payload.id === room['104']));
      await pool.query(`UPDATE room SET housekeeping_status = 'ready' WHERE id = $1`, [room['104']]);
      const other = await newProperty('HK Other', ['housekeeping']);
      assert.equal((await call(ctrl.putRoomStatus, { property_id: other, user: staffA, params: { room_id: room['104'] }, body: { housekeeping_status: 'dirty' } })).statusCode, 404);
    });
    await check('settings: read, validate, write', async () => {
      assert.equal((await call(ctrl.putSettings, { property_id: P, user: admin, body: { service_every_days: 0 } })).statusCode, 400);
      assert.equal((await call(ctrl.putSettings, { property_id: P, user: admin, body: { inspection_required: 'yes' } })).statusCode, 400);
      const r = await call(ctrl.putSettings, { property_id: P, user: admin, body: { linen_every_days: 3 } });
      assert.deepEqual(r.body, { inspection_required: false, service_every_days: 2, linen_every_days: 3 });
      const r2 = await call(ctrl.putSettings, { property_id: P, user: admin, body: { linen_every_days: null } });
      assert.equal(r2.body.linen_every_days, null);
      await call(ctrl.putSettings, { property_id: P, user: admin, body: { linen_every_days: 4 } });
      assert.deepEqual((await call(ctrl.getSettings, { property_id: P, user: staffA })).body, { inspection_required: false, service_every_days: 2, linen_every_days: 4 });
    });
    await check('module off (enabled_modules NULL): no jobs, empty board', async () => {
      const Q = await newProperty('HK Off', null);
      assert.equal(await hk.housekeepingEnabled(pool, Q), false);
      assert.equal(await hk.housekeepingEnabled(pool, P), true);
      const rtQ = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [Q])).id;
      const rQ = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'Q1') RETURNING id`, [Q, rtQ])).id;
      const gQ = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Q', 'Guest', $2) RETURNING id`, [Q, `q-${run}@example.com`])).id;
      await book(rQ, addDays(D, -1), D, 'checked_in', { property: Q, guest: gQ });
      assert.deepEqual(await board(D, Q), []);
      assert.equal((await one('SELECT count(*)::int AS n FROM hk_job WHERE property_id = $1', [Q])).n, 0);
    });
    await check('board rejects a bad date', async () => {
      assert.equal((await call(ctrl.board, { property_id: P, user: staffA, query: { date: '10/03/2031' } })).statusCode, 400);
    });
  } finally {
    await cleanup(props);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall ok');
  process.exit(failed ? 1 : 0);
})();

// Children first; every fixture hangs off one of the throwaway properties.
async function cleanup(props) {
  if (!props.length) return;
  const q = (sql) => pool.query(sql, [props]).catch((e) => console.log('cleanup:', e.message));
  await q('DELETE FROM cleanliness_rating WHERE property_id = ANY($1)');
  await q('DELETE FROM minibar_usage WHERE booking_id IN (SELECT id FROM booking WHERE property_id = ANY($1))');
  await q('DELETE FROM minibar_list_item WHERE room_type_id IN (SELECT id FROM room_type WHERE property_id = ANY($1))');
  await q('DELETE FROM minibar_item WHERE property_id = ANY($1)');
  await q('DELETE FROM hk_inspection_score WHERE item_id IN (SELECT id FROM hk_check_item WHERE property_id = ANY($1))');
  await q('DELETE FROM hk_job WHERE property_id = ANY($1)');
  await q('DELETE FROM hk_check_item WHERE property_id = ANY($1)');
  await q('DELETE FROM hk_override WHERE property_id = ANY($1)');
  await q('DELETE FROM review_request_opt_out WHERE property_id = ANY($1)');
  await q('DELETE FROM folio_adjustment WHERE booking_id IN (SELECT id FROM booking WHERE property_id = ANY($1))');
  await q('DELETE FROM booking_extra WHERE booking_id IN (SELECT id FROM booking WHERE property_id = ANY($1))');
  await q('DELETE FROM extra WHERE property_id = ANY($1)');
  await q('DELETE FROM booking WHERE property_id = ANY($1)');
  await q('DELETE FROM room_availability WHERE room_id IN (SELECT id FROM room WHERE property_id = ANY($1))');
  await q('DELETE FROM room WHERE property_id = ANY($1)');
  await q('DELETE FROM rate_plan WHERE property_id = ANY($1)');
  await q('DELETE FROM room_type WHERE property_id = ANY($1)');
  await q('DELETE FROM guest WHERE property_id = ANY($1)');
  await q('DELETE FROM staff_permission WHERE property_id = ANY($1)');
  await q('DELETE FROM api_key WHERE property_id = ANY($1)');
  await q('DELETE FROM property WHERE id = ANY($1)');
}
