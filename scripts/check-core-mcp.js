// MCP backfill: guests, bookings, payments, folio, property settings,
// restaurant orders and the marina catalogue. The staff routes take a full
// API key and refuse a scoped one, each tool maps to its endpoint, and
// bookings and marina setup run end to end through /api/mcp. Fixtures live under a
// throwaway property, deleted at the end (pass or fail). Local DB only.
//   node -r dotenv/config scripts/check-core-mcp.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const run = crypto.randomBytes(4).toString('hex');
  let P;
  const server = require('../src/app').listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PORT = String(server.address().port); // routes/mcp.js loops back to localhost:PORT

  try {
    P = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ($1, $2, $3) RETURNING id`,
      [`Core MCP ${run}`, `org_coremcp_${run}`, `core-mcp-${run}`])).id;
    const KEY = `core_full_${run}`;
    const SCOPED = `core_scoped_${run}`;
    await apiKeys.create(pool, { property_id: P }, { key: KEY, name: 'Full' });
    await apiKeys.create(pool, { property_id: P }, { key: SCOPED, name: 'Website', permissions: [] });
    const RT = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P])).id;
    const ROOM = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'C1') RETURNING id`, [P, RT])).id;
    for (const d of ['2031-03-01', '2031-03-02']) {
      await pool.query(`INSERT INTO room_availability (property_id, room_id, date, is_available) VALUES ($1, $2, $3, true)`, [P, ROOM, d]);
    }
    const G = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Ada', 'Guest', $2) RETURNING id`, [P, `ada-${run}@example.com`])).id;
    const B = (await one(`INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price) VALUES ($1, $2, $3, '2031-01-01', '2031-01-03', 200) RETURNING id`, [P, G, ROOM])).id;

    const hit = (k, method, url, body) => fetch(`${base}${url}`, {
      method, headers: { 'x-api-key': k, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });

    await check('a full key reaches the staff routes; a scoped key gets 403', async () => {
      const reads = ['/api/guests', `/api/guests/${G}`, `/api/guests/${G}/summary`, `/api/bookings/${B}/folio`, `/api/payments/booking/${B}`];
      for (const url of reads) {
        assert.equal((await hit(KEY, 'GET', url)).status, 200, `full GET ${url}`);
        assert.equal((await hit(SCOPED, 'GET', url)).status, 403, `scoped GET ${url}`);
      }
      for (const [method, url, body] of [['PUT', `/api/guests/${G}`, { phone: '+1 555' }], ['PUT', `/api/bookings/${B}`, { guests: 2 }],
        ['POST', `/api/bookings/${B}/folio/adjustments`, { description: 'Late checkout', amount: 25 }], ['POST', '/api/payments', { booking_id: B, amount: 10 }]]) {
        assert.equal((await hit(SCOPED, method, url, body)).status, 403, `scoped ${method} ${url}`);
        assert.ok((await hit(KEY, method, url, body)).ok, `full ${method} ${url}`);
      }
      assert.equal((await hit(KEY, 'DELETE', `/api/guests/${G}`)).status, 401, 'guest delete stays staff-only');
    });

    await check('MCP tools map to their endpoints', async () => {
      const calls = [];
      const tools = require('../mcp-server/tools').createTools(async (method, path, opts) => { calls.push([method, path, opts]); return {}; });
      const t = (name) => { const x = tools.find((y) => y.name === name); assert.ok(x, `missing tool ${name}`); return x; };
      await t('list_guests').run({});
      await t('get_guest').run({ id: 'g1' });
      await t('get_guest_summary').run({ id: 'g1' });
      await t('create_guest').run({ first_name: 'A', last_name: 'B', email: 'a@b.c' });
      await t('update_guest').run({ id: 'g1', member_until: null });
      await t('create_booking').run({ guest_id: 'g1', room_type_id: 'rt1', check_in: '2031-03-01', check_out: '2031-03-03' });
      await t('update_booking').run({ id: 'b1', status: 'checked_in', force: true });
      await t('get_booking_folio').run({ id: 'b1' });
      await t('add_folio_adjustment').run({ id: 'b1', description: 'Comp', amount: -20 });
      await t('remove_folio_adjustment').run({ id: 'b1', adjustment_id: 'a1' });
      await t('list_booking_payments').run({ booking_id: 'b1' });
      await t('record_payment').run({ booking_id: 'b1', amount: 50, method: 'cash', status: 'completed' });
      await t('update_payment').run({ id: 'p1', status: 'refunded' });
      assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), [
        'GET /api/guests', 'GET /api/guests/g1', 'GET /api/guests/g1/summary', 'POST /api/guests', 'PUT /api/guests/g1',
        'POST /api/bookings', 'PUT /api/bookings/b1', 'GET /api/bookings/b1/folio', 'POST /api/bookings/b1/folio/adjustments',
        'DELETE /api/bookings/b1/folio/adjustments/a1', 'GET /api/payments/booking/b1', 'POST /api/payments', 'PUT /api/payments/p1',
      ]);
      assert.deepEqual(calls[4][2].body, { member_until: null });
      assert.deepEqual(calls[6][2].body, { status: 'checked_in', force: true });
      assert.deepEqual(calls[8][2].body, { description: 'Comp', amount: -20 });
      assert.deepEqual(calls[11][2].body, { booking_id: 'b1', amount: 50, method: 'cash', status: 'completed' });
    });

    await check('MCP endpoint: create_booking then record_payment end to end over a full key', async () => {
      const rpc = (name, args) => fetch(`${base}/api/mcp`, {
        method: 'POST', headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }).then((r) => r.text());
      const made = await rpc('create_booking', { guest_id: G, room_type_id: RT, check_in: '2031-03-01', check_out: '2031-03-03' });
      assert.ok(!made.includes('"isError":true'), made.slice(0, 400));
      const booking = await one(`SELECT id, room_id, total_price FROM booking WHERE property_id = $1 AND check_in = '2031-03-01'`, [P]);
      assert.equal(booking.room_id, ROOM);
      assert.equal(Number(booking.total_price), 200);
      const paid = await rpc('record_payment', { booking_id: booking.id, amount: 200, method: 'cash', status: 'completed' });
      assert.ok(!paid.includes('"isError":true'), paid.slice(0, 400));
      const folio = await rpc('get_booking_folio', { id: booking.id });
      assert.ok(/\\"balance\\":\\"?0(\.00)?\\"?/.test(folio), folio.slice(0, 600));
    });

    await check('property settings and order reads: full key in, scoped key 403', async () => {
      for (const url of ['/api/property/reminders', '/api/property/stripe/status', '/api/property/vercel/status']) {
        assert.equal((await hit(KEY, 'GET', url)).status, 200, `full GET ${url}`);
        assert.equal((await hit(SCOPED, 'GET', url)).status, 403, `scoped GET ${url}`);
      }
      assert.equal((await hit(SCOPED, 'PUT', '/api/property/reminders', { reminder_hours_before: 12 })).status, 403);
      const r = await hit(KEY, 'PUT', '/api/property/reminders', { reminder_hours_before: 12 });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).reminder_hours_before, 12);
      const missing = `/api/restaurant-orders/${crypto.randomUUID()}`;
      assert.equal((await hit(KEY, 'GET', missing)).status, 404, 'full key passes auth');
      assert.equal((await hit(SCOPED, 'GET', missing)).status, 403);
    });

    await check('marina catalogue tools over MCP: create, list and update a pontoon and a season', async () => {
      const rpc = (name, args) => fetch(`${base}/api/mcp`, {
        method: 'POST', headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }).then((r) => r.text());
      const M = (await one(`INSERT INTO marina (property_id, name, slug) VALUES ($1, 'Core Marina', $2) RETURNING id`, [P, `core-marina-${run}`])).id;
      const ok = (text) => { assert.ok(!text.includes('"isError":true'), text.slice(0, 400)); return text; };
      ok(await rpc('create_marina_pontoon', { marina_id: M, name: 'A' }));
      const pontoon = await one('SELECT id FROM marina_pontoon WHERE marina_id = $1', [M]);
      ok(await rpc('update_marina_pontoon', { marina_id: M, id: pontoon.id, sort_order: 3 }));
      assert.equal((await one('SELECT sort_order FROM marina_pontoon WHERE id = $1', [pontoon.id])).sort_order, 3);
      ok(await rpc('create_marina_season', { marina_id: M, name: 'Summer', valid_from: '2031-06-01', valid_to: '2031-08-31', repeats_yearly: true }));
      assert.ok(ok(await rpc('list_marina_seasons', { marina_id: M })).includes('Summer'));
      ok(await rpc('create_marina_berth', { marina_id: M, label: 'A1', pontoon_id: pontoon.id, length_m: 12 }));
      assert.equal((await one('SELECT label FROM marina_berth WHERE marina_id = $1', [M])).label, 'A1');
      const bad = await rpc('create_marina_season', { marina_id: M, name: 'Odd', valid_from: '2031-09-01', valid_to: '2031-08-01' });
      assert.ok(bad.includes('"isError":true'), 'API validation reaches the agent');
    });
  } finally {
    server.close();
    if (P) {
      const q = (sql) => pool.query(sql, [P]).catch((e) => console.log('cleanup:', e.message));
      await q('DELETE FROM payment WHERE property_id = $1');
      await q('DELETE FROM folio_adjustment WHERE property_id = $1');
      await q('DELETE FROM booking WHERE property_id = $1');
      await q('DELETE FROM room_availability WHERE room_id IN (SELECT id FROM room WHERE property_id = $1)');
      await q('DELETE FROM room WHERE property_id = $1');
      await q('DELETE FROM room_type WHERE property_id = $1');
      await q('DELETE FROM guest WHERE property_id = $1');
      await q('DELETE FROM marina WHERE property_id = $1'); // children cascade
      await q('DELETE FROM api_key WHERE property_id = $1');
      await q('DELETE FROM property WHERE id = $1');
    }
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
