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
const apiKeys = require('../src/lib/apiKeys');
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
  const P = (await one(`INSERT INTO property (name) VALUES ('Equipment Check') RETURNING id`)).id;
  await apiKeys.create(pool, { property_id: P }, { key: KEY });
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
    // ---- Task 2: equipment validation and hours ----
    let kayak;
    await check('create equipment: validation', async () => {
      const base = { name: 'Kayak', type: 'kayak', quantity: 1, price_per_hour: 15 };
      for (const bad of [{ quantity: 0 }, { quantity: 3e9 }, { price_per_day: -1 }, { price_per_day: 1e9 },
                         { open_time: '09:00' }, { open_time: '19:00', close_time: '09:00' },
                         { open_time: '25:00', close_time: '26:00' }, { slot_interval_minutes: 2 }]) {
        assert.equal((await api('POST', '/api/equipment', { ...base, ...bad })).status, 400, JSON.stringify(bad));
      }
      const r = await api('POST', '/api/equipment', { ...base, open_time: '09:00', close_time: '19:00', slot_interval_minutes: 30 });
      assert.equal(r.status, 201, r.text); kayak = r.body;
      assert.equal(kayak.open_time, '09:00:00'); assert.equal(kayak.slot_interval_minutes, 30);
    });
    await check('update equipment: clear hours with null; half-set rejected; absent keeps', async () => {
      assert.equal((await api('PUT', `/api/equipment/${kayak.id}`, { close_time: '08:00' })).status, 400);
      assert.equal((await api('PUT', `/api/equipment/${kayak.id}`, { name: 'Kayak 2' })).body.open_time, '09:00:00');
      const r = await api('PUT', `/api/equipment/${kayak.id}`, { open_time: null, close_time: null });
      assert.equal(r.status, 200, r.text); assert.equal(r.body.open_time, null); assert.equal(r.body.close_time, null);
      assert.equal((await api('PUT', `/api/equipment/${kayak.id}`, { open_time: '09:00', close_time: '19:00' })).status, 200);
    });
    await check('update equipment: non-UUID id is 404', async () => {
      assert.equal((await api('PUT', '/api/equipment/abc', { name: 'x' })).status, 404);
    });

    // ---- Task 3: window-aware hires ----
    const item = async (body) => (await api('POST', '/api/equipment', { type: 'kayak', price_per_hour: 10, price_per_day: 50, ...body })).body;
    const single = await item({ name: 'Single', quantity: 1 });
    const two = await item({ name: 'Two', quantity: 2, open_time: '09:00', close_time: '19:00' });
    const D = '2030-07-01';
    const hire = (eq, start, dur, extra = {}) => api('POST', '/api/equipment/hires', {
      equipment_id: eq.id, contact_name: 'Ana', hire_date: D, quantity: 1, rate_type: 'per_hour', start_time: start, duration: dur, ...extra,
    });
    await check('quantity 1: back-to-back ok, overlap 409', async () => {
      assert.equal((await hire(single, '10:00', 1)).status, 201);
      assert.equal((await hire(single, '11:00', 1)).status, 201);
      const r = await hire(single, '10:30', 1);
      assert.equal(r.status, 409); assert.equal(r.body.error, 'Only 0 available from 10:30 to 11:30');
    });
    await check('quantity 2: 10-11 + 11-12 then 10-12 fits (peak 2); another 10-12 is 409', async () => {
      for (const [s, d] of [['10:00', 1], ['11:00', 1], ['10:00', 2]]) assert.equal((await hire(two, s, d)).status, 201, `${s} ${d}`);
      assert.equal((await hire(two, '10:00', 2)).status, 409);
    });
    await check('per-day blocks timed and vice versa', async () => {
      const a = await item({ name: 'DayFirst', quantity: 1 });
      assert.equal((await hire(a, null, 1, { rate_type: 'per_day' })).status, 201);
      const r = await hire(a, '10:00', 1);
      assert.equal(r.status, 409); assert.equal(r.body.error, 'Only 0 available from 10:00 to 11:00');
      const b = await item({ name: 'TimedFirst', quantity: 1 });
      assert.equal((await hire(b, '10:00', 1)).status, 201);
      const r2 = await hire(b, null, 1, { rate_type: 'per_day' });
      assert.equal(r2.status, 409); assert.equal(r2.body.error, 'Only 0 available on this date');
    });
    await check('hours and midnight', async () => {
      const r = await hire(two, '08:00', 1, { hire_date: '2030-07-02' });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'Hire must be between 09:00 and 19:00');
      assert.equal((await hire(two, '18:30', 1, { hire_date: '2030-07-02' })).status, 400);
      assert.equal((await hire(single, '23:00', 2, { hire_date: '2030-07-02' })).status, 400);
    });
    await check('validation and bad ids are 400', async () => {
      for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { duration: -1 }, { duration: 0.7 }, { start_time: '25:00' },
                         { rate_type: 'per_week' }, { equipment_id: 'abc' }, { rate_type: 'per_day', start_time: null, duration: 1000 }]) {
        assert.equal((await hire(single, '10:00', 1, { hire_date: '2030-07-03', ...bad })).status, 400, JSON.stringify(bad));
      }
    });
    await check('cancel frees the window; reinstating into a full window is 409', async () => {
      const a = (await hire(single, '14:00', 1, { hire_date: '2030-07-04' })).body;
      assert.equal((await api('PUT', `/api/equipment/hires/${a.id}`, { status: 'cancelled' })).status, 200);
      assert.equal((await hire(single, '14:00', 1, { hire_date: '2030-07-04' })).status, 201);
      const r = await api('PUT', `/api/equipment/hires/${a.id}`, { status: 'confirmed' });
      assert.equal(r.status, 409); assert.equal(r.body.error, 'Only 0 available from 14:00 to 15:00');
      assert.equal((await api('PUT', '/api/equipment/hires/abc', { status: 'confirmed' })).status, 404);
    });
    await check('reinstating a hire on an inactive item is 409', async () => {
      const eq = await item({ name: 'Retired', quantity: 1 });
      const a = (await hire(eq, '10:00', 1)).body;
      await api('PUT', `/api/equipment/hires/${a.id}`, { status: 'cancelled' });
      await api('PUT', `/api/equipment/${eq.id}`, { status: 'inactive' });
      const r = await api('PUT', `/api/equipment/hires/${a.id}`, { status: 'confirmed' });
      assert.equal(r.status, 409); assert.equal(r.body.error, 'Equipment not available');
    });
    await check('a hire waits for the item lock and sees the hire committed under it (409)', async () => {
      // Plays the first of two racing hires by hand: lock the item, take the
      // last unit, and commit only after the API hire has started.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM equipment WHERE id = $1 FOR UPDATE', [single.id]);
        await c.query(`INSERT INTO equipment_hire (property_id, equipment_id, contact_name, hire_date, quantity, rate_type, start_time, duration)
                       VALUES ($1, $2, 'Racer', '2030-07-05', 1, 'per_hour', '16:00', 1)`, [P, single.id]);
        const pending = hire(single, '16:00', 1, { hire_date: '2030-07-05' });
        await new Promise((r) => setTimeout(r, 300));
        await c.query('COMMIT');
        assert.equal((await pending).status, 409);
      } finally { c.release(); }
    });
    await check('a timed hire today that has started is 400', async () => {
      const { today, mins } = await one(`SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today,
        extract(hour FROM now() AT TIME ZONE timezone)*60 + extract(minute FROM now() AT TIME ZONE timezone) AS mins FROM property WHERE id = $1`, [P]);
      if (Number(mins) === 0) return; // ponytail: skips in the first minute after local midnight
      const r = await hire(single, '00:00', 0.5, { hire_date: today });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'That time has passed');
    });

    // ---- Task 4: search ----
    const hourly = await item({ name: 'Hourly', type: 'sup', quantity: 2, open_time: '09:00', close_time: '13:00' });
    const daily = (await api('POST', '/api/equipment', { name: 'Daily', type: 'sup', quantity: 1, price_per_day: 40 })).body;
    await hire(hourly, '10:00', 1, { hire_date: '2030-08-01' });
    await check('search with start_time: window availability, leaves out per-day-only and out-of-hours', async () => {
      let r = await api('GET', '/api/equipment/search?date=2030-08-01&type=sup&start_time=10:00&duration=1');
      assert.equal(r.status, 200, r.text);
      assert.ok(!r.body.some((e) => e.id === daily.id));
      assert.equal(r.body.find((e) => e.id === hourly.id).available_quantity, 1);
      r = await api('GET', '/api/equipment/search?date=2030-08-01&type=sup&start_time=12:00&duration=2');
      assert.ok(!r.body.some((e) => e.id === hourly.id));
    });
    await check('search without start_time: start_times for duration, ending by close', async () => {
      const r = await api('GET', '/api/equipment/search?date=2030-08-01&type=sup&duration=2&quantity=2');
      const e = r.body.find((x) => x.id === hourly.id);
      assert.deepEqual(e.start_times.map((s) => s.start_time), ['11:00']);
      assert.ok(!r.body.some((x) => x.id === daily.id)); // qty 1 < 2
      const all = await api('GET', '/api/equipment/search?date=2030-08-01&type=sup');
      assert.equal(all.body.find((x) => x.id === daily.id).start_times, undefined);
      assert.equal(all.body.find((x) => x.id === hourly.id).available_quantity, 1);
    });
    await check('search validation', async () => {
      for (const q of ['start_time=25:00', 'duration=0', 'duration=0.7', 'quantity=abc']) {
        assert.equal((await api('GET', `/api/equipment/search?date=2030-08-01&${q}`)).status, 400, q);
      }
    });

    // ---- Final review fixes ----
    await check('final: malformed opening hours are 400; HH:MM:SS accepted', async () => {
      const base = { name: 'Hrs', type: 'kayak', quantity: 1 };
      assert.equal((await api('POST', '/api/equipment', { ...base, open_time: '09:00junk', close_time: '17:00' })).status, 400);
      assert.equal((await api('POST', '/api/equipment', { ...base, open_time: '09:00:99', close_time: '17:00' })).status, 400);
      assert.equal((await api('POST', '/api/equipment', { ...base, open_time: '09:00:00', close_time: '17:00' })).status, 201);
    });
    await check('final: per-day duration that rounds out of NUMERIC(5,2) or to 0 is 400', async () => {
      for (const duration of [999.996, 0.001]) {
        assert.equal((await hire(single, null, duration, { rate_type: 'per_day', hire_date: '2030-09-01' })).status, 400, String(duration));
      }
    });
    await check('final: rate_type null means per_day; HH:MM:SS start_time accepted', async () => {
      const r = await hire(single, null, 1, { rate_type: null, hire_date: '2030-09-02' });
      assert.equal(r.status, 201, r.text); assert.equal(r.body.rate_type, 'per_day');
      assert.equal((await hire(single, '10:00:00', 1, { hire_date: '2030-09-03' })).status, 201);
    });
    await check('final: blank or zero quantity in search is ignored', async () => {
      for (const q of ['', '0']) assert.equal((await api('GET', `/api/equipment/search?date=2030-08-01&quantity=${q}`)).status, 200, `quantity=${q}`);
    });
    await check('final: item with both prices stays in search when per-day fits but no start time does', async () => {
      const both = await item({ name: 'Both', type: 'both', quantity: 1, open_time: '09:00', close_time: '10:00' });
      const r = await api('GET', '/api/equipment/search?date=2030-08-01&type=both&duration=2&quantity=1');
      const e = r.body.find((x) => x.id === both.id);
      assert.ok(e, r.text); assert.deepEqual(e.start_times, []);
    });

    // ---- Task 5: MCP tools ----
    await check('MCP tools carry the hours fields and search time window', async () => {
      process.env.PORT = String(server.address().port); // routes/mcp.js loops back to localhost:PORT
      const r = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const text = await r.text();
      assert.equal(r.status, 200, text);
      const { result } = JSON.parse(text.startsWith('{') ? text : text.match(/^data: (.*)$/m)[1]);
      const props = (n) => Object.keys(result.tools.find((t) => t.name === n).inputSchema.properties);
      for (const n of ['create_equipment', 'update_equipment']) {
        for (const f of ['open_time', 'close_time', 'slot_interval_minutes']) assert.ok(props(n).includes(f), `${n} missing ${f}`);
      }
      for (const f of ['start_time', 'duration']) assert.ok(props('search_equipment').includes(f), `search_equipment missing ${f}`);
    });
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
