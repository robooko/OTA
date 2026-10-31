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

    // ── Task 3: claim, start, finish ────────────────────────────────────────
    const jobId = async (roomId, kind, date = D) => (await one('SELECT id FROM hk_job WHERE room_id = $1 AND date = $2 AND kind = $3', [roomId, date, kind])).id;
    const act = (fn, user, id, body = {}) => call(fn, { property_id: P, user, params: { id }, body });
    const roomStatus = async (id) => (await one('SELECT housekeeping_status FROM room WHERE id = $1', [id])).housekeeping_status;
    const J101 = await jobId(room['101'], 'checkout');
    await check('claim: someone else\'s claim is 409 unless forced', async () => {
      const a = await act(ctrl.claimJob, staffA, J101);
      assert.equal(a.statusCode, 200); assert.equal(a.body.claimed_by, staffA.id); assert.equal(a.body.claimed_by_name, `Name ${staffA.id}`);
      const b = await act(ctrl.claimJob, staffB, J101);
      assert.equal(b.statusCode, 409); assert.equal(b.body.claimed_by_name, `Name ${staffA.id}`);
      const f = await act(ctrl.claimJob, staffB, J101, { force: true });
      assert.equal(f.statusCode, 200); assert.equal(f.body.claimed_by, staffB.id);
    });
    await check('unclaim: only the claimer or an admin', async () => {
      assert.equal((await act(ctrl.unclaimJob, staffA, J101)).statusCode, 403);
      const r = await act(ctrl.unclaimJob, staffB, J101);
      assert.equal(r.statusCode, 200); assert.equal(r.body.status, 'open'); assert.equal(r.body.claimed_by, null);
    });
    await check('start: room cleaning, one attempt, claimed by the starter', async () => {
      const r = await act(ctrl.startJob, staffA, J101);
      assert.equal(r.statusCode, 200); assert.equal(r.body.status, 'in_progress'); assert.equal(r.body.claimed_by, staffA.id);
      assert.equal(r.body.attempts.length, 1); assert.equal(r.body.attempts[0].cleaner_id, staffA.id);
      assert.equal(await roomStatus(room['101']), 'cleaning');
      assert.equal((await act(ctrl.startJob, staffA, J101)).statusCode, 409); // already in progress
    });
    await check('finish: cleaner only, booleans validated', async () => {
      assert.equal((await act(ctrl.finishJob, staffB, J101, { sheets_changed: true, towels_changed: true })).statusCode, 403);
      assert.equal((await act(ctrl.finishJob, staffA, J101, { sheets_changed: 'yes', towels_changed: true })).statusCode, 400);
      assert.equal((await act(ctrl.finishJob, staffA, J101, { sheets_changed: true, towels_changed: true, comments: 'x'.repeat(2001) })).statusCode, 400);
    });
    await check('finish without inspection required: done, room ready', async () => {
      const r = await act(ctrl.finishJob, staffA, J101, { sheets_changed: true, towels_changed: false, comments: 'stain on rug' });
      assert.equal(r.statusCode, 200); assert.equal(r.body.status, 'done');
      assert.ok(r.body.attempts[0].finished_at); assert.equal(r.body.attempts[0].sheets_changed, true);
      assert.equal(r.body.attempts[0].towels_changed, false); assert.equal(r.body.attempts[0].comments, 'stain on rug');
      assert.equal(await roomStatus(room['101']), 'ready');
      assert.equal((await act(ctrl.startJob, staffA, J101)).statusCode, 409); // done
    });
    const room105 = (await one(`INSERT INTO room (property_id, room_type_id, room_number, floor) VALUES ($1, $2, '105', 1) RETURNING id`, [P, RT])).id;
    await book(room105, addDays(D, -2), D, 'checked_in');
    await board();
    const J105 = await jobId(room105, 'checkout');
    const J102 = await jobId(room['102'], 'stayover');
    await check('finish with inspection required: checkout waits at clean, stayover ready', async () => {
      await pool.query('UPDATE property SET hk_inspection_required = true WHERE id = $1', [P]);
      await act(ctrl.startJob, staffA, J105);
      assert.equal((await act(ctrl.finishJob, staffA, J105, { sheets_changed: true, towels_changed: true })).body.status, 'done');
      assert.equal(await roomStatus(room105), 'clean');
      await act(ctrl.startJob, staffB, J102);
      await act(ctrl.finishJob, staffB, J102, { sheets_changed: false, towels_changed: true });
      assert.equal(await roomStatus(room['102']), 'ready');
      assert.ok(published.some((e) => e.event === 'job-updated' && e.payload.id === J105 && e.payload.status === 'done'));
    });
    await check('unknown or foreign job is 404', async () => {
      assert.equal((await act(ctrl.claimJob, staffA, crypto.randomUUID())).statusCode, 404);
      assert.equal((await act(ctrl.startJob, staffA, 'not-a-uuid')).statusCode, 404);
    });

    // ── Task 4: checklist, photos, inspections, fail alert ───────────────────
    const { requirePermission } = require('../src/middleware/auth');
    const { setGrant } = require('../src/lib/permissions');
    const mw = (fn, req) => new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
      fn({ headers: {}, ...req }, res, (err) => (err ? reject(err) : resolve({ next: true })));
    });
    const inspect = (user, id, scores) => call(ctrl.inspectJob, { property_id: P, user, params: { id }, body: { scores } });
    const inspections = async () => (await one('SELECT count(*)::int AS n FROM hk_inspection i JOIN hk_job j ON j.id = i.job_id WHERE j.property_id = $1', [P])).n;
    let FLOOR, BATH;
    await check('checklist items: validate, create, list in order', async () => {
      assert.equal((await call(ctrl.createCheckItem, { property_id: P, user: admin, body: { name: 'Floor', pass_mark: 6 } })).statusCode, 400);
      assert.equal((await call(ctrl.createCheckItem, { property_id: P, user: admin, body: { name: ' ', pass_mark: 3 } })).statusCode, 400);
      FLOOR = (await call(ctrl.createCheckItem, { property_id: P, user: admin, body: { name: 'Vacuum/floor', pass_mark: 4, sort_order: 1 } })).body.id;
      const b = await call(ctrl.createCheckItem, { property_id: P, user: admin, body: { name: 'Bathroom', pass_mark: 3, sort_order: 2 } });
      assert.equal(b.statusCode, 201); BATH = b.body.id;
      assert.deepEqual((await call(ctrl.listCheckItems, { property_id: P, user: staffA })).body.map((i) => i.name), ['Vacuum/floor', 'Bathroom']);
    });
    await check('inspect permission: staff without a grant 403, with a grant passes', async () => {
      const gate = requirePermission('housekeeping.inspect');
      const no = await mw(gate, { user: staffB, property_id: P, auth_method: 'bearer' });
      assert.equal(no.status, 403); assert.equal(no.body.permission, 'housekeeping.inspect');
      await setGrant(pool, P, staffB.id, ['housekeeping.inspect'], admin.id);
      assert.deepEqual(await mw(gate, { user: staffB, property_id: P, auth_method: 'bearer' }), { next: true });
    });
    const J103 = await jobId(room['103'], 'arrival');
    await check('inspecting a job that is not done is 409', async () => {
      await act(ctrl.startJob, staffA, J103);
      assert.equal((await inspect(staffB, J103, [{ item_id: FLOOR, score: 5 }, { item_id: BATH, score: 5 }])).statusCode, 409);
    });
    await check('bad scores are 400 and write nothing', async () => {
      const before = await inspections();
      assert.equal((await inspect(staffB, J105, [{ item_id: FLOOR, score: 5 }])).statusCode, 400);
      assert.equal((await inspect(staffB, J105, [{ item_id: FLOOR, score: 0 }, { item_id: BATH, score: 5 }])).statusCode, 400);
      assert.equal(await inspections(), before);
    });
    await check('a cleaner cannot inspect their own clean', async () => {
      await setGrant(pool, P, staffA.id, ['housekeeping.inspect'], admin.id);
      const r = await inspect(staffA, J105, [{ item_id: FLOOR, score: 5 }, { item_id: BATH, score: 5 }]);
      assert.equal(r.statusCode, 409); assert.match(r.body.error, /own clean/);
    });
    await check('fail: job failed, room dirty, alert names the exact item', async () => {
      published.length = 0;
      const r = await inspect(staffB, J105, [
        { item_id: FLOOR, score: 3, comment: 'hair under the bed', photo_url: 'https://blob.example/p.jpg' },
        { item_id: BATH, score: 5 },
      ]);
      assert.equal(r.statusCode, 201); assert.equal(r.body.status, 'failed');
      assert.equal(await roomStatus(room105), 'dirty');
      const alert = published.find((e) => e.event === 'inspection-failed');
      assert.equal(alert.payload.cleaner_id, staffA.id);
      assert.equal(alert.payload.cleaner_name, `Name ${staffA.id}`);
      assert.deepEqual(alert.payload.failed_items, [{ item_name: 'Vacuum/floor', score: 3, pass_mark: 4, comment: 'hair under the bed', photo_url: 'https://blob.example/p.jpg' }]);
      assert.equal(alert.payload.job.id, J105);
    });
    await check('redo then pass: job passed, room ready, both inspections kept', async () => {
      assert.equal((await act(ctrl.startJob, staffA, J105)).body.attempts.length, 2);
      await act(ctrl.finishJob, staffA, J105, { sheets_changed: false, towels_changed: false });
      assert.equal(await roomStatus(room105), 'clean');
      const r = await inspect(staffB, J105, [{ item_id: FLOOR, score: 4 }, { item_id: BATH, score: 4 }]);
      assert.equal(r.statusCode, 201); assert.equal(r.body.status, 'passed');
      assert.equal(await roomStatus(room105), 'ready');
      assert.equal(r.body.inspections.length, 2);
      assert.equal(r.body.inspections[0].passed, false); assert.equal(r.body.inspections[1].passed, true);
      assert.equal(r.body.inspections[0].scores.length, 2);
    });
    await check('an admin may inspect their own clean', async () => {
      const J104 = await jobId(room['104'], 'extra');
      await act(ctrl.startJob, admin, J104);
      await act(ctrl.finishJob, admin, J104, { sheets_changed: true, towels_changed: true });
      assert.equal((await inspect(admin, J104, [{ item_id: FLOOR, score: 5 }, { item_id: BATH, score: 5 }])).statusCode, 201);
    });
    await check('photo upload: images only, stored through the seam', async () => {
      const bad = await call(ctrl.uploadPhoto, { property_id: P, user: staffB, headers: { 'content-type': 'text/plain' }, body: Buffer.from('hi') });
      assert.equal(bad.statusCode, 400);
      const empty = await call(ctrl.uploadPhoto, { property_id: P, user: staffB, headers: { 'content-type': 'image/jpeg' }, body: {} });
      assert.equal(empty.statusCode, 400);
      const saved = [];
      hk.putPhoto = async (pathname, buf, type) => { saved.push({ pathname, type, size: buf.length }); return `https://blob.example/${pathname}`; };
      const ok = await call(ctrl.uploadPhoto, { property_id: P, user: staffB, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff]) });
      assert.equal(ok.statusCode, 201); assert.match(ok.body.url, /^https:\/\/blob\.example\/housekeeping\//);
      assert.equal(saved[0].type, 'image/jpeg'); assert.ok(saved[0].pathname.startsWith(`housekeeping/${P}/`));
    });
    await check('archiving an item keeps old scores and drops it from new inspections', async () => {
      const r = await call(ctrl.updateCheckItem, { property_id: P, user: admin, params: { id: FLOOR }, body: { status: 'archived', name: 'Floors' } });
      assert.equal(r.statusCode, 200);
      const old = await one('SELECT item_name FROM hk_inspection_score WHERE item_id = $1 LIMIT 1', [FLOOR]);
      assert.equal(old.item_name, 'Vacuum/floor');
      assert.deepEqual((await call(ctrl.listCheckItems, { property_id: P, user: staffA })).body.map((i) => i.name), ['Bathroom']);
      assert.equal((await call(ctrl.updateCheckItem, { property_id: P, user: admin, params: { id: FLOOR }, body: { pass_mark: 9 } })).statusCode, 400);
    });

    // ── Task 5: booking hooks, arrival extras ────────────────────────────────
    const bookingsCtrl = require('../src/controllers/bookings');
    const extrasCtrl = require('../src/controllers/extras');
    const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    const room106 = (await one(`INSERT INTO room (property_id, room_type_id, room_number, floor) VALUES ($1, $2, '106', 1) RETURNING id`, [P, RT])).id;
    const B6 = await book(room106, D, addDays(D, 1), 'confirmed');
    const setBooking = (property, id, body) => call(bookingsCtrl.updateBooking, { property_id: property, user: staffA, params: { id }, body });
    await check('check-in into a room that is not ready is 409 unless forced', async () => {
      await pool.query(`UPDATE room SET housekeeping_status = 'dirty' WHERE id = $1`, [room106]);
      const r = await setBooking(P, B6, { status: 'checked_in' });
      assert.equal(r.statusCode, 409); assert.deepEqual(r.body, { error: 'Room not ready', housekeeping_status: 'dirty' });
      assert.equal((await setBooking(P, B6, { status: 'checked_in', force: true })).statusCode, 200);
    });
    await check('checking out makes the room dirty and builds its job', async () => {
      await pool.query(`UPDATE room SET housekeeping_status = 'ready' WHERE id = $1`, [room106]);
      assert.equal((await setBooking(P, B6, { status: 'checked_out', force: true })).statusCode, 200);
      assert.ok(await until(async () => (await roomStatus(room106)) === 'dirty'), 'room went dirty');
    });
    const R = await newProperty('HK Off Hooks', null);
    const rtR = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [R])).id;
    const roomR = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'R1') RETURNING id`, [R, rtR])).id;
    const gR = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'R', 'Guest', $2) RETURNING id`, [R, `r-${run}@example.com`])).id;
    const BR = await book(roomR, D, addDays(D, 1), 'confirmed', { property: R, guest: gR });
    await check('module off: no check-in gate, checkout leaves the room alone', async () => {
      await pool.query(`UPDATE room SET housekeeping_status = 'dirty' WHERE id = $1`, [roomR]);
      assert.equal((await setBooking(R, BR, { status: 'checked_in' })).statusCode, 200);
      await pool.query(`UPDATE room SET housekeeping_status = 'ready' WHERE id = $1`, [roomR]);
      assert.equal((await setBooking(R, BR, { status: 'checked_out', force: true })).statusCode, 200);
      await hk.onCheckedOut(R, roomR);
      assert.equal(await roomStatus(roomR), 'ready');
    });
    await check('extras: place_in_room validated and saved', async () => {
      assert.equal((await call(extrasCtrl.createExtra, { property_id: P, user: admin, body: { name: 'Prosecco', price: 40, place_in_room: 'x' } })).statusCode, 400);
      const c = await call(extrasCtrl.createExtra, { property_id: P, user: admin, body: { name: 'Prosecco', price: 40, place_in_room: true } });
      assert.equal(c.statusCode, 201); assert.equal(c.body.place_in_room, true);
      const u = await call(extrasCtrl.updateExtra, { property_id: P, user: admin, params: { id: c.body.id }, body: { place_in_room: false } });
      assert.equal(u.body.place_in_room, false);
      assert.equal((await call(extrasCtrl.updateExtra, { property_id: P, user: admin, params: { id: c.body.id }, body: { place_in_room: 1 } })).statusCode, 400);
    });
    await check('placing an extra: idempotent, shows on the board, property-scoped', async () => {
      const a = await call(ctrl.placeExtra, { property_id: P, user: staffA, params: { id: BE3 } });
      assert.equal(a.statusCode, 200); assert.ok(a.body.placed_at); assert.equal(a.body.placed_by, staffA.id);
      const b = await call(ctrl.placeExtra, { property_id: P, user: staffB, params: { id: BE3 } });
      assert.equal(b.body.placed_at.toISOString(), a.body.placed_at.toISOString()); assert.equal(b.body.placed_by, staffA.id);
      const row = jobFor(await board(), room['103'])[0];
      assert.equal(row.extras_to_place[0].placed_by, staffA.id);
      assert.equal((await call(ctrl.placeExtra, { property_id: R, user: staffA, params: { id: BE3 } })).statusCode, 404);
      assert.equal((await call(ctrl.placeExtra, { property_id: P, user: staffA, params: { id: 'nope' } })).statusCode, 404);
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
