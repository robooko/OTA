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
