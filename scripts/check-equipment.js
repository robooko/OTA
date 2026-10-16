// Equipment hire time-window checks. Pure helpers are asserted directly; HTTP
// checks run the real app on an ephemeral port with fixtures under a
// throwaway property, deleted at the end (pass or fail). Local DB only, with
// migrate-2026-10-16-equipment-hours.sql applied.
//   node -r dotenv/config scripts/check-equipment.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const { hireWindow, peakUse, fitsHours, startTimes } = require('../src/lib/equipmentWindows');
const app = require('../src/app');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Task 1: pure helpers ----
  const h = (start, dur, qty = 1) => ({ rate_type: 'per_hour', start_time: start, duration: dur, quantity: qty });
  await check('hireWindow: timed, whole-day, legacy', async () => {
    assert.deepEqual(hireWindow(h('10:00', 1.5)), { start: 600, end: 690 });
    assert.deepEqual(hireWindow({ rate_type: 'per_hour', start_time: '10:00:00', duration: null }), { start: 600, end: 660 });
    assert.deepEqual(hireWindow({ rate_type: 'per_hour', start_time: null, duration: 2 }), { start: 0, end: 1440 });
    assert.deepEqual(hireWindow({ rate_type: 'per_day', start_time: '10:00', duration: 1 }), { start: 0, end: 1440 });
  });
  await check('peakUse: back-to-back do not stack; overlap does', async () => {
    assert.equal(peakUse([h('10:00', 1), h('11:00', 1)], { start: 600, end: 720 }), 1);
    assert.equal(peakUse([h('10:00', 1), h('10:30', 1)], { start: 600, end: 720 }), 2);
    assert.equal(peakUse([h('10:00', 1, 3)], { start: 660, end: 720 }), 0);
    assert.equal(peakUse([{ rate_type: 'per_day', quantity: 2 }, h('10:00', 1)], { start: 600, end: 660 }), 3);
  });
  await check('fitsHours', async () => {
    const item = { open_time: '09:00:00', close_time: '19:00:00' };
    assert.equal(fitsHours(item, { start: 540, end: 600 }), true);
    assert.equal(fitsHours(item, { start: 480, end: 540 }), false);
    assert.equal(fitsHours(item, { start: 1080, end: 1200 }), false);
    assert.equal(fitsHours({ open_time: null, close_time: null }, { start: 1380, end: 1500 }), false);
  });
  await check('startTimes: 2h on a 09-13 quantity-1 item with 10-11 taken', async () => {
    const item = { quantity: 1, open_time: '09:00', close_time: '13:00', slot_interval_minutes: 60 };
    assert.deepEqual(startTimes(item, [h('10:00', 1)], 2), [{ start_time: '11:00', available_quantity: 1 }]);
  });
  await check('startTimes: now = 12:00 drops 10:00 and 11:00', async () => {
    const item = { quantity: 1, open_time: '10:00', close_time: '14:00', slot_interval_minutes: 60 };
    assert.deepEqual(startTimes(item, [], 1, 1, 720).map((s) => s.start_time), ['12:00', '13:00']);
  });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `equipment_check_${tag}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, api_key) VALUES ('Equipment Check', $1) RETURNING id`, [KEY])).id;
  const api = async (method, path, body, key = KEY) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, text };
  };

  try {
    // ---- HTTP checks ----
  } finally {
    const props = [P];
    await pool.query('DELETE FROM equipment_hire WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM equipment WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    server.close();
  }

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
