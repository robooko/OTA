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

    // ── Task 6: minibar ──────────────────────────────────────────────────────
    const minibar = require('../src/lib/minibar');
    const { computeFolio } = require('../src/lib/folio');
    const apiKeys = require('../src/lib/apiKeys');
    const plan = async (name) => (await one(
      `INSERT INTO rate_plan (property_id, room_type_id, name, refundable, cancel_cutoff_hours, payment_mode) VALUES ($1, $2, $3, true, 48, 'full') RETURNING id`,
      [P, RT, name])).id;
    const FLEX = await plan('Flex'); const SAVER = await plan('Saver');
    const mkItem = async (name, price) => (await call(ctrl.createMinibarItem, { property_id: P, user: admin, body: { name, price } })).body.id;
    const putList = (body, property = P) => call(ctrl.putMinibarList, { property_id: property, user: admin, body });
    let PROSECCO, CHOC;
    await check('minibar catalogue and lists validate', async () => {
      assert.equal((await call(ctrl.createMinibarItem, { property_id: P, user: admin, body: { name: 'X', price: -1 } })).statusCode, 400);
      PROSECCO = await mkItem('Prosecco', 30); CHOC = await mkItem('Chocolate', 4);
      assert.equal((await call(ctrl.listMinibarItems, { property_id: P, user: staffA })).body.length, 2);
      assert.equal((await putList({ room_type_id: RT, rate_plan_id: null, items: [{ minibar_item_id: PROSECCO, quantity: 0, included: false }] })).statusCode, 400);
      assert.equal((await putList({ room_type_id: RT, rate_plan_id: null, items: [{ minibar_item_id: PROSECCO, quantity: 1, included: 'no' }] })).statusCode, 400);
      const foreignItem = (await one(`INSERT INTO minibar_item (property_id, name, price) VALUES ($1, 'Foreign', 1) RETURNING id`, [R])).id;
      assert.equal((await putList({ room_type_id: RT, rate_plan_id: null, items: [{ minibar_item_id: foreignItem, quantity: 1, included: true }] })).statusCode, 400);
      assert.equal((await putList({ room_type_id: rtR, rate_plan_id: null, items: [] })).statusCode, 400); // other property's room type
      const r = await putList({ room_type_id: RT, rate_plan_id: null, items: [
        { minibar_item_id: PROSECCO, quantity: 1, included: false }, { minibar_item_id: CHOC, quantity: 2, included: true }] });
      assert.equal(r.statusCode, 200); assert.equal(r.body.length, 2);
      assert.equal((await putList({ room_type_id: RT, rate_plan_id: FLEX, items: [{ minibar_item_id: PROSECCO, quantity: 1, included: true }] })).statusCode, 200);
    });
    await check('resolveList: a plan list replaces the room type list; no plan list falls back', async () => {
      const base = await minibar.resolveList(pool, RT, null);
      assert.deepEqual(base.map((i) => [i.name, i.included, i.quantity]), [['Chocolate', true, 2], ['Prosecco', false, 1]]);
      assert.deepEqual((await minibar.resolveList(pool, RT, FLEX)).map((i) => [i.name, i.included]), [['Prosecco', true]]);
      assert.equal((await minibar.resolveList(pool, RT, SAVER)).length, 2);
    });
    const room107 = (await one(`INSERT INTO room (property_id, room_type_id, room_number, floor) VALUES ($1, $2, '107', 1) RETURNING id`, [P, RT])).id;
    const room108 = (await one(`INSERT INTO room (property_id, room_type_id, room_number, floor) VALUES ($1, $2, '108', 1) RETURNING id`, [P, RT])).id;
    const BS = await book(room107, addDays(D, -2), D, 'checked_in', { rate_plan_id: SAVER });
    const BF = await book(room108, addDays(D, -2), D, 'checked_in', { rate_plan_id: FLEX });
    await board();
    const J107 = await jobId(room107, 'checkout'); const J108 = await jobId(room108, 'checkout');
    const minibarLines = async (bookingId) => (await computeFolio(bookingId, P)).items.filter((i) => i.type === 'minibar');
    const record = (id, items) => call(ctrl.recordMinibar, { property_id: P, user: staffA, params: { id }, body: { items } });
    await check('board shows the minibar list for the booking\'s plan', async () => {
      const row = jobFor(await board(), room108)[0];
      assert.deepEqual(row.minibar.map((i) => i.name), ['Prosecco']);
      assert.equal(jobFor(await board(), room107)[0].minibar.length, 2);
    });
    await check('charged items go on the folio, included never do', async () => {
      const r = await record(J107, [{ minibar_item_id: PROSECCO, quantity: 2 }, { minibar_item_id: CHOC, quantity: 5 }]);
      assert.equal(r.statusCode, 200);
      const lines = await minibarLines(BS);
      assert.equal(lines.length, 1); assert.equal(lines[0].description, 'Prosecco × 2'); assert.equal(lines[0].amount, '60.00');
      assert.ok(published.some((e) => e.event === 'minibar-recorded' && e.payload.id === J107));
    });
    await check('re-recording a job replaces its usage', async () => {
      await record(J107, [{ minibar_item_id: PROSECCO, quantity: 1 }]);
      const lines = await minibarLines(BS);
      assert.equal(lines.length, 1); assert.equal(lines[0].amount, '30.00'); assert.equal(lines[0].description, 'Prosecco');
    });
    await check('included on the plan: no folio charge at any quantity', async () => {
      await record(J108, [{ minibar_item_id: PROSECCO, quantity: 3 }]);
      assert.equal((await minibarLines(BF)).length, 0);
      assert.equal((await one('SELECT count(*)::int AS n FROM minibar_usage WHERE booking_id = $1', [BF])).n, 1); // still counted for restock
    });
    await check('a charge found after checkout raises the balance', async () => {
      await pool.query(`UPDATE booking SET status = 'checked_out' WHERE id = $1`, [BS]);
      const before = Number((await computeFolio(BS, P)).balance);
      await record(J107, [{ minibar_item_id: PROSECCO, quantity: 3 }]);
      assert.equal(Number((await computeFolio(BS, P)).balance), before + 60);
    });
    await check('minibar recording refusals', async () => {
      assert.equal((await record(J103, [{ minibar_item_id: PROSECCO, quantity: 1 }])).statusCode, 400); // arrival job: no guest yet
      assert.equal((await record(J107, [{ minibar_item_id: PROSECCO, quantity: -1 }])).statusCode, 400);
      assert.equal((await record(J107, [{ minibar_item_id: crypto.randomUUID(), quantity: 1 }])).statusCode, 400);
      assert.equal((await record(J107, 'lots')).statusCode, 400);
    });
    const app = require('../src/app');
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const KEY = `hk_key_${run}`;
      await apiKeys.create(pool, { property_id: P }, { key: KEY });
      await check('public minibar list over the property key', async () => {
        const r = await fetch(`${base}/api/housekeeping/minibar/list?room_type_id=${RT}&rate_plan_id=${FLEX}`, { headers: { 'x-api-key': KEY } });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.deepEqual(body.map((i) => [i.name, i.included, i.price]), [['Prosecco', true, '30.00']]);
        const none = await fetch(`${base}/api/housekeeping/minibar/list?room_type_id=${RT}`);
        assert.equal(none.status, 401);
        const bad = await fetch(`${base}/api/housekeeping/minibar/list?room_type_id=nope`, { headers: { 'x-api-key': KEY } });
        assert.equal(bad.status, 400);
      });
    } finally {
      server.close();
    }

    // ── Task 7: guest cleanliness rating ─────────────────────────────────────
    const ratings = require('../src/lib/cleanlinessRatings');
    const resend = require('../src/lib/resend');
    const sent = [];
    let failSend = false;
    resend.sendCleanlinessRequest = async (args) => { if (failSend) throw new Error('resend down'); sent.push(args); return 'email_1'; };
    const NOW = new Date('2031-03-11T12:00:00Z'); // 2031-03-12 in Auckland
    const G2 = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Opted', 'Out', $2) RETURNING id`, [P, `out-${run}@example.com`])).id;
    await pool.query('INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, $2)', [P, `out-${run}@example.com`]);
    const room109 = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, '109') RETURNING id`, [P, RT])).id;
    const BO = await book(room109, addDays(D, -2), D, 'checked_out', { guest: G2 });
    const BOld = await book(room109, addDays(D, -9), addDays(D, -5), 'checked_out');
    const ours = (rows) => rows.filter((r) => props.includes(r.property_id)).map((r) => r.booking_id).sort();
    await check('claimDue: recent checkouts on housekeeping properties, opt-outs and old stays left out', async () => {
      const claimed = ours(await ratings.claimDue(pool, NOW));
      assert.deepEqual(claimed, [B6, BS].sort());
      assert.ok(!claimed.includes(BO)); assert.ok(!claimed.includes(BOld)); assert.ok(!claimed.includes(BR));
      assert.deepEqual(ours(await ratings.claimDue(pool, NOW)), []); // claimed once
      const row = await one('SELECT * FROM cleanliness_rating WHERE booking_id = $1', [B6]);
      assert.equal(row.email, `ada-${run}@example.com`); assert.ok(row.token.length >= 32);
    });
    await check('runOnce sends each claim once, retries failures up to 3 attempts', async () => {
      failSend = true;
      await ratings.runOnce(NOW);
      assert.equal((await one('SELECT attempts, status FROM cleanliness_rating WHERE booking_id = $1', [B6])).attempts, 1);
      failSend = false;
      await ratings.runOnce(NOW);
      const mine = sent.filter((s) => s.to === `ada-${run}@example.com`);
      assert.equal(mine.length, 2); // B6 and BS
      const row = await one('SELECT * FROM cleanliness_rating WHERE booking_id = $1', [B6]);
      assert.equal(row.status, 'sent'); assert.ok(row.sent_at);
      assert.equal(mine.find((s) => s.formUrl.endsWith(row.token)).optOutUrl, `${mine.find((s) => s.formUrl.endsWith(row.token)).formUrl}/opt-out`);
      assert.match(mine[0].propertyName, /HK Board/);
      await ratings.runOnce(NOW);
      assert.equal(sent.filter((s) => s.to === `ada-${run}@example.com`).length, 2);
      // A row that keeps failing stops at 3.
      await pool.query(`UPDATE cleanliness_rating SET status = 'pending', attempts = 2 WHERE booking_id = $1`, [BS]);
      failSend = true; await ratings.runOnce(NOW); failSend = false;
      assert.deepEqual(await one('SELECT attempts, status FROM cleanliness_rating WHERE booking_id = $1', [BS]), { attempts: 3, status: 'failed' });
    });
    {
      const server7 = require('../src/app').listen(0);
      const base7 = `http://127.0.0.1:${server7.address().port}`;
      try {
        const { token } = await one('SELECT token FROM cleanliness_rating WHERE booking_id = $1', [B6]);
        const post = (body) => fetch(`${base7}/api/cleanliness/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        await check('guest form: shows, validates, stores, overwrites', async () => {
          const g = await fetch(`${base7}/api/cleanliness/${token}`);
          assert.equal(g.status, 200); assert.match(await g.text(), /HK Board/);
          assert.equal((await post('rating=7')).status, 400);
          assert.equal((await post('rating=4&comment=great')).status, 200);
          let row = await one('SELECT rating, comment, rated_at FROM cleanliness_rating WHERE booking_id = $1', [B6]);
          assert.equal(row.rating, 4); assert.equal(row.comment, 'great'); assert.ok(row.rated_at);
          await post('rating=2');
          row = await one('SELECT rating, comment FROM cleanliness_rating WHERE booking_id = $1', [B6]);
          assert.equal(row.rating, 2); assert.equal(row.comment, null);
          assert.equal((await fetch(`${base7}/api/cleanliness/nope`)).status, 404);
          assert.equal((await post('rating=3&comment=' + 'x'.repeat(2001))).status, 400);
        });
        await check('guest form escapes the property name', async () => {
          await pool.query(`UPDATE property SET name = $2 WHERE id = $1`, [P, `HK Board <b>${run}</b>`]);
          const html = await (await fetch(`${base7}/api/cleanliness/${token}`)).text();
          assert.ok(!html.includes('<b>')); assert.ok(html.includes('&lt;b&gt;'));
          await pool.query(`UPDATE property SET name = $2 WHERE id = $1`, [P, `HK Board ${run}`]);
        });
        await check('opt-out link records the opt-out', async () => {
          assert.equal((await fetch(`${base7}/api/cleanliness/${token}/opt-out`)).status, 200);
          assert.ok(await one('SELECT 1 FROM review_request_opt_out WHERE property_id = $1 AND email = $2', [P, `ada-${run}@example.com`]));
        });
      } finally {
        server7.close();
      }
    }

    // ── Task 8: reports, swagger ─────────────────────────────────────────────
    {
      const DT = '2031-05-01';
      const T = await newProperty('HK Reports', ['rooms', 'housekeeping']);
      const rtT = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [T])).id;
      const T1 = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'T1') RETURNING id`, [T, rtT])).id;
      const T2 = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'T2') RETURNING id`, [T, rtT])).id;
      const gT = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'T', 'Guest', $2) RETURNING id`, [T, `t-${run}@example.com`])).id;
      const BT1 = await book(T1, DT, addDays(DT, 2), 'checked_out', { property: T, guest: gT });
      const BT2 = await book(T2, DT, addDays(DT, 3), 'checked_out', { property: T, guest: gT });
      const job = async (roomId, date, kind, bookingId = null) => (await one(
        `INSERT INTO hk_job (property_id, room_id, date, kind, booking_id, status) VALUES ($1, $2, $3, $4, $5, 'done') RETURNING id`, [T, roomId, date, kind, bookingId])).id;
      const attempt = async (jobId, who, from, to) => (await one(
        `INSERT INTO hk_clean (job_id, cleaner_id, cleaner_name, started_at, finished_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [jobId, who.id, `Name ${who.id}`, `${DT}T${from}:00Z`, `${DT}T${to}:00Z`])).id;
      const inspectRow = (jobId, cleanId, passed, score, at) => pool.query(
        `INSERT INTO hk_inspection (job_id, clean_id, inspector_id, passed, score, created_at) VALUES ($1, $2, 'insp', $3, $4, $5)`,
        [jobId, cleanId, passed, score, `${DT}T${at}:00Z`]);
      const J1 = await job(T1, DT, 'checkout');
      await inspectRow(J1, await attempt(J1, staffA, '10:00', '10:30'), false, 3, '10:45');
      await inspectRow(J1, await attempt(J1, staffA, '11:00', '11:20'), true, 4.5, '11:30');
      const J2 = await job(T2, DT, 'checkout');
      await inspectRow(J2, await attempt(J2, staffA, '10:00', '10:40'), true, 5, '10:50');
      const J3 = await job(T2, addDays(DT, 1), 'stayover', BT2);
      await attempt(J3, staffB, '09:00', '09:10');
      for (const [b, r] of [[BT1, 4], [BT2, 2]]) {
        await pool.query(`INSERT INTO cleanliness_rating (property_id, booking_id, email, token, status, rating, rated_at) VALUES ($1, $2, 'x@example.com', $3, 'sent', $4, now())`,
          [T, b, crypto.randomBytes(32).toString('hex'), r]);
      }
      const report = async (query) => call(ctrl.reports, { property_id: T, user: admin, query });
      await check('reports: per cleaner', async () => {
        const r = await report({ from: DT, to: addDays(DT, 5) });
        assert.equal(r.statusCode, 200);
        const a = r.body.cleaners.find((c) => c.id === staffA.id); const b = r.body.cleaners.find((c) => c.id === staffB.id);
        assert.deepEqual(a, { id: staffA.id, name: `Name ${staffA.id}`, jobs_done: 2, avg_minutes: 30, median_minutes: 30, avg_inspection_score: 4.17, first_time_pass_rate: 0.5, avg_guest_score: 3 });
        assert.deepEqual(b, { id: staffB.id, name: `Name ${staffB.id}`, jobs_done: 1, avg_minutes: 10, median_minutes: 10, avg_inspection_score: null, first_time_pass_rate: null, avg_guest_score: 2 });
      });
      await check('reports: per room', async () => {
        const r = await report({ from: DT, to: addDays(DT, 5) });
        const t1 = r.body.rooms.find((x) => x.id === T1); const t2 = r.body.rooms.find((x) => x.id === T2);
        assert.deepEqual(t1, { id: T1, room_number: 'T1', jobs_done: 1, avg_minutes: 25, median_minutes: 25, avg_inspection_score: 3.75, first_time_pass_rate: 0, avg_guest_score: 4 });
        assert.deepEqual(t2, { id: T2, room_number: 'T2', jobs_done: 2, avg_minutes: 25, median_minutes: 25, avg_inspection_score: 5, first_time_pass_rate: 1, avg_guest_score: 2 });
      });
      await check('reports: range and validation', async () => {
        assert.equal((await report({ from: DT })).statusCode, 400);
        assert.equal((await report({ from: addDays(DT, 2), to: DT })).statusCode, 400);
        const later = await report({ from: addDays(DT, 1), to: addDays(DT, 2) }); // only the stayover
        assert.deepEqual(later.body.cleaners.map((c) => c.id), [staffB.id]);
      });
      await check('swagger documents the housekeeping and cleanliness paths', async () => {
        delete require.cache[require.resolve('../src/docs/swagger')];
        const spec = require('../src/docs/swagger');
        for (const p of ['/api/housekeeping/board', '/api/housekeeping/jobs/{id}/inspections', '/api/housekeeping/minibar/list', '/api/housekeeping/reports', '/api/cleanliness/{token}']) {
          assert.ok(spec.paths[p], `missing ${p}`);
        }
        assert.match(JSON.stringify(spec.paths['/api/bookings/{id}']), /Room not ready/);
        assert.match(JSON.stringify(spec.paths['/api/housekeeping/jobs/{id}/inspections']), /Missing permission/);
      });
    }

    // ── Final review fixes ───────────────────────────────────────────────────
    {
      const TODAY = await hk.propertyToday(pool, P);
      const mkRoom = async (n) => (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3) RETURNING id`, [P, RT, n])).id;
      await check('desk checking out after the clean is done leaves the room alone', async () => {
        const rm = await mkRoom('110');
        const b = await book(rm, addDays(TODAY, -1), TODAY, 'checked_in');
        await board(TODAY);
        const j = await jobId(rm, 'checkout', TODAY);
        await act(ctrl.startJob, staffA, j);
        await act(ctrl.finishJob, staffA, j, { sheets_changed: true, towels_changed: true });
        const before = await roomStatus(rm); // clean (inspection required at P)
        await pool.query(`UPDATE booking SET status = 'checked_out' WHERE id = $1`, [b]);
        await hk.onCheckedOut(P, rm, b);
        assert.equal(await roomStatus(rm), before);
      });
      await check('an early departure gets a checkout job today and a dirty room', async () => {
        const rm = await mkRoom('111');
        const b = await book(rm, addDays(TODAY, -1), addDays(TODAY, 3), 'checked_out');
        await hk.onCheckedOut(P, rm, b);
        assert.equal(await roomStatus(rm), 'dirty');
        const j = await one('SELECT kind, booking_id, status FROM hk_job WHERE room_id = $1 AND date = $2', [rm, TODAY]);
        assert.deepEqual(j, { kind: 'checkout', booking_id: b, status: 'open' });
        assert.equal(jobFor(await board(TODAY), rm).length, 1); // and the board keeps it
      });
      await check('two simultaneous claims: exactly one wins', async () => {
        for (let i = 0; i < 5; i++) {
          const rm = await mkRoom(`12${i}`);
          await book(rm, addDays(D, -1), D, 'confirmed');
          await board();
          const j = await jobId(rm, 'checkout');
          const [a, b] = await Promise.all([act(ctrl.claimJob, staffA, j), act(ctrl.claimJob, staffB, j)]);
          assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `round ${i}`);
        }
      });
      await check('overlapping minibar recordings never double the folio', async () => {
        for (let i = 0; i < 5; i++) {
          const rm = await mkRoom(`13${i}`);
          const b = await book(rm, addDays(D, -1), D, 'checked_in', { rate_plan_id: SAVER });
          await board();
          const j = await jobId(rm, 'checkout');
          const items = [{ minibar_item_id: PROSECCO, quantity: 2 }];
          await Promise.all([record(j, items), record(j, items), record(j, items)]);
          const lines = (await computeFolio(b, P)).items.filter((x) => x.type === 'minibar');
          assert.equal(lines.length, 1, `round ${i}`); assert.equal(lines[0].amount, '60.00');
        }
      });
      await check('arrival extras still get a job when the departing booking is cancelled', async () => {
        const rm = await mkRoom('140');
        const dep = await book(rm, addDays(D, -1), D, 'confirmed');
        const arr = await book(rm, D, addDays(D, 1), 'confirmed');
        await pool.query(`INSERT INTO booking_extra (booking_id, extra_id, quantity, unit_price) VALUES ($1, $2, 1, 120)`, [arr, EX]);
        await board();
        await pool.query(`UPDATE booking SET status = 'cancelled' WHERE id = $1`, [dep]);
        const rows = jobFor(await board(), rm);
        const arrival = rows.find((r) => r.kind === 'arrival');
        assert.ok(arrival, 'arrival job'); assert.equal(arrival.status, 'open');
        assert.deepEqual(arrival.extras_to_place.map((e) => e.name), ['Red Roses']);
      });
      const server9 = require('../src/app').listen(0);
      const base9 = `http://127.0.0.1:${server9.address().port}`;
      try {
        const KEY = `hk_key_${run}`;
        const SCOPED = `hk_scoped_${run}`;
        await apiKeys.create(pool, { property_id: P }, { key: SCOPED, name: 'Website', permissions: [] });
        const hdr = (k) => ({ 'x-api-key': k, 'content-type': 'application/json' });
        const hit = (k, method, url, body) => fetch(`${base9}/api/housekeeping${url}`, { method, headers: hdr(k), body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
        await check('cleaning flow refuses API keys (it records who did the work)', async () => {
          for (const [method, url] of [['POST', `/jobs/${J101}/claim`], ['DELETE', `/jobs/${J101}/claim`], ['POST', `/jobs/${J101}/start`], ['POST', `/jobs/${J101}/finish`],
            ['POST', `/jobs/${J101}/inspections`], ['PUT', `/jobs/${J107}/minibar`], ['POST', `/booking-extras/${BE3}/placed`], ['POST', '/photos']]) {
            assert.equal((await hit(KEY, method, url)).status, 401, `${method} ${url}`);
          }
        });
        await check('a full key reaches setup and reads; a scoped key does not', async () => {
          const reads = ['/board?date=' + D, '/reports?from=2031-01-01&to=2031-02-01', '/settings', '/check-items', '/minibar/items'];
          for (const url of reads) {
            assert.equal((await hit(KEY, 'GET', url)).status, 200, `full GET ${url}`);
            assert.equal((await hit(SCOPED, 'GET', url)).status, 403, `scoped GET ${url}`);
          }
          const s = await hit(KEY, 'PUT', '/settings', { linen_every_days: 4 });
          assert.equal(s.status, 200);
          assert.equal((await hit(SCOPED, 'PUT', '/settings', { linen_every_days: 4 })).status, 403);
          const rs = await hit(KEY, 'PUT', `/rooms/${room['104']}/status`, { housekeeping_status: 'ready' });
          assert.equal(rs.status, 200);
          assert.equal((await hit(SCOPED, 'PUT', `/rooms/${room['104']}/status`, { housekeeping_status: 'ready' })).status, 403);
          const ov = await hit(KEY, 'PUT', '/overrides', { room_id: room['104'], date: addDays(D, 1), action: 'clean' });
          assert.equal(ov.status, 200); assert.equal((await ov.json()).created_by, null);
          assert.equal((await hit(SCOPED, 'GET', `/minibar/list?room_type_id=${RT}`)).status, 200); // booking site
          assert.equal((await hit(KEY, 'GET', `/minibar/list?room_type_id=${RT}`)).status, 200);
        });
        await check('ably-token: subscribe-only on the property housekeeping channel; 503 without Ably; scoped key refused', async () => {
          const minted = [];
          const real = ably.createSubscribeTokenRequest;
          ably.createSubscribeTokenRequest = async (channels) => { minted.push(channels); return { keyName: 'k', capability: 'x' }; };
          try {
            const r = await call(ctrl.ablyToken, { property_id: P, user: staffA });
            assert.equal(r.statusCode, 200);
            assert.deepEqual(r.body, { tokenRequest: { keyName: 'k', capability: 'x' }, channel: `property:${P}:housekeeping` });
            assert.deepEqual(minted, [`property:${P}:housekeeping`]);
            ably.createSubscribeTokenRequest = async () => null; // no ABLY_API_KEY
            assert.equal((await call(ctrl.ablyToken, { property_id: P, user: staffA })).statusCode, 503);
          } finally {
            ably.createSubscribeTokenRequest = real;
          }
          assert.equal((await hit(SCOPED, 'GET', '/ably-token')).status, 403);
          assert.equal((await fetch(`${base9}/api/housekeeping/ably-token`)).status, 401);
        });
        await check('MCP tools map to the housekeeping endpoints', async () => {
          const calls = [];
          const tools = require('../mcp-server/tools').createTools(async (method, path, opts) => { calls.push([method, path, opts]); return {}; });
          const t = (name) => { const x = tools.find((y) => y.name === name); assert.ok(x, `missing tool ${name}`); return x; };
          await t('get_housekeeping_board').run({ date: D });
          await t('get_housekeeping_settings').run({});
          await t('update_housekeeping_settings').run({ inspection_required: true, service_every_days: null });
          await t('set_room_housekeeping_status').run({ room_id: 'r1', housekeeping_status: 'dirty' });
          await t('set_housekeeping_override').run({ room_id: 'r1', date: D, action: 'skip' });
          await t('delete_housekeeping_override').run({ room_id: 'r1', date: D });
          await t('list_inspection_checklist').run({});
          await t('create_inspection_checklist_item').run({ name: 'Floor', pass_mark: 4 });
          await t('update_inspection_checklist_item').run({ id: 'c1', status: 'archived' });
          await t('list_minibar_items').run({});
          await t('create_minibar_item').run({ name: 'Prosecco', price: 30 });
          await t('update_minibar_item').run({ id: 'm1', price: 32 });
          await t('get_minibar_list').run({ room_type_id: 'rt1', rate_plan_id: 'rp1' });
          await t('set_minibar_list').run({ room_type_id: 'rt1', rate_plan_id: null, items: [{ minibar_item_id: 'm1', quantity: 1, included: true }] });
          await t('get_housekeeping_report').run({ from: '2031-01-01', to: '2031-02-01' });
          await t('create_extra').run({ name: 'Roses', price: 120, place_in_room: true });
          assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), [
            'GET /api/housekeeping/board', 'GET /api/housekeeping/settings', 'PUT /api/housekeeping/settings',
            'PUT /api/housekeeping/rooms/r1/status', 'PUT /api/housekeeping/overrides', `DELETE /api/housekeeping/overrides/r1/${D}`,
            'GET /api/housekeeping/check-items', 'POST /api/housekeeping/check-items', 'PUT /api/housekeeping/check-items/c1',
            'GET /api/housekeeping/minibar/items', 'POST /api/housekeeping/minibar/items', 'PUT /api/housekeeping/minibar/items/m1',
            'GET /api/housekeeping/minibar/list', 'PUT /api/housekeeping/minibar/lists', 'GET /api/housekeeping/reports', 'POST /api/extras',
          ]);
          assert.deepEqual(calls[0][2].query, { date: D });
          assert.deepEqual(calls[2][2].body, { inspection_required: true, service_every_days: null });
          assert.deepEqual(calls[3][2].body, { housekeeping_status: 'dirty' });
          assert.deepEqual(calls[8][2].body, { status: 'archived' });
          assert.deepEqual(calls[12][2].query, { room_type_id: 'rt1', rate_plan_id: 'rp1' });
          assert.equal(calls[13][2].body.rate_plan_id, null);
          assert.deepEqual(calls[14][2].query, { from: '2031-01-01', to: '2031-02-01' });
          assert.equal(calls[15][2].body.place_in_room, true);
        });
        await check('MCP endpoint: tools listed, board read end to end over a full key', async () => {
          process.env.PORT = String(server9.address().port); // routes/mcp.js loops back to localhost:PORT
          const rpc = (k, method, params) => fetch(`${base9}/api/mcp`, {
            method: 'POST', headers: { 'X-Api-Key': k, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }).then((r) => r.text());
          const list = await rpc(KEY, 'tools/list', {});
          for (const n of ['get_housekeeping_board', 'set_minibar_list', 'get_housekeeping_report']) assert.ok(list.includes(`"${n}"`), `tools/list missing ${n}`);
          const call = await rpc(KEY, 'tools/call', { name: 'get_housekeeping_board', arguments: { date: D } });
          assert.ok(call.includes(room['101']), 'board came back through MCP');
          assert.ok(!call.includes('"isError":true'), call.slice(0, 300));
        });
      } finally {
        server9.close();
      }
    }
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
