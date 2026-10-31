// Beach club checks: property keys only, every row scoped to its property,
// a cancelled bed can be rebooked (and un-cancelling onto a rebooked bed is
// refused), and the MCP tools end to end. Fixtures live under two throwaway
// properties, deleted at the end (pass or fail). Local DB only, with
// migrate-2026-10-31-beach-club-property-scoping.sql applied.
//   node -r dotenv/config scripts/check-beach-club.js
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
  const run = crypto.randomBytes(4).toString('hex');
  const props = [];
  const server = require('../src/app').listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PORT = String(server.address().port); // routes/mcp.js loops back to localhost:PORT

  try {
    const keys = [];
    for (const n of [0, 1]) {
      const id = (await pool.query(`INSERT INTO property (name, clerk_org_id, slug) VALUES ($1, $2, $3) RETURNING id`,
        [`Beach ${n} ${run}`, `org_beach_${n}_${run}`, `beach-${n}-${run}`])).rows[0].id;
      props.push(id);
      keys.push(`beach_${n}_${run}`);
      await apiKeys.create(pool, { property_id: id }, { key: keys[n], name: 'Default' });
    }
    const [A, B] = keys;
    const call = async (key, method, url, body) => {
      const r = await fetch(`${base}/api/beach-club${url}`, {
        method, headers: { ...(key ? { 'x-api-key': key } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: r.status === 204 ? null : await r.json() };
    };
    let bedA;

    await check('no key is 401; the old global API_KEY is not a key here', async () => {
      assert.equal((await call(null, 'GET', '/beds')).status, 401);
      if (process.env.API_KEY) assert.equal((await call(process.env.API_KEY, 'POST', '/beds', { bed_number: 'X' })).status, 401);
    });

    await check('beds belong to their property; the same number is fine at another', async () => {
      const a = await call(A, 'POST', '/beds', { bed_number: '1', zone: 'front' });
      assert.equal(a.status, 201);
      bedA = a.body.id;
      assert.equal((await call(B, 'POST', '/beds', { bed_number: '1' })).status, 201);
      assert.equal((await call(A, 'POST', '/beds', { bed_number: '1' })).status, 409);
      const listA = (await call(A, 'GET', '/beds')).body;
      assert.deepEqual(listA.map((b) => b.id), [bedA]);
      assert.equal((await call(B, 'PUT', `/beds/${bedA}`, { zone: 'stolen' })).status, 404);
      assert.equal((await call(A, 'PUT', `/beds/${bedA}`, { status: 'broken' })).status, 400);
    });

    await check("bookings can't cross properties", async () => {
      assert.equal((await call(B, 'POST', '/bookings', { bed_id: bedA, contact_name: 'Eve', date: '2031-07-01' })).status, 404);
      const otherGuest = (await pool.query(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'B', 'Guest', $2) RETURNING id`, [props[1], `b-${run}@example.com`])).rows[0].id;
      assert.equal((await call(A, 'POST', '/bookings', { bed_id: bedA, contact_name: 'Ann', date: '2031-07-01', guest_id: otherGuest })).status, 404);
    });

    await check('one live booking per bed per day; a cancelled bed can be rebooked; un-cancelling onto it is 409', async () => {
      const first = await call(A, 'POST', '/bookings', { bed_id: bedA, contact_name: 'Ann', date: '2031-07-02' });
      assert.equal(first.status, 201);
      assert.equal((await call(A, 'POST', '/bookings', { bed_id: bedA, contact_name: 'Bob', date: '2031-07-02' })).status, 409);
      assert.equal((await call(A, 'GET', '/beds/search?date=2031-07-02')).body.length, 0);
      assert.equal((await call(A, 'PUT', `/bookings/${first.body.id}`, { status: 'cancelled' })).status, 200);
      assert.equal((await call(A, 'GET', '/beds/search?date=2031-07-02')).body.length, 1);
      assert.equal((await call(A, 'POST', '/bookings', { bed_id: bedA, contact_name: 'Bob', date: '2031-07-02' })).status, 201);
      assert.equal((await call(A, 'PUT', `/bookings/${first.body.id}`, { status: 'confirmed' })).status, 409);
      assert.equal((await call(B, 'PUT', `/bookings/${first.body.id}`, { notes: 'x' })).status, 404);
      assert.equal((await call(B, 'GET', '/bookings')).body.length, 0);
      assert.equal((await call(A, 'GET', '/bookings?date=2031-07-02&status=confirmed')).body[0].contact_name, 'Bob');
    });

    await check('MCP: create a bed and book it end to end over the property key', async () => {
      const rpc = (name, args) => fetch(`${base}/api/mcp`, {
        method: 'POST', headers: { 'X-Api-Key': A, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }).then((r) => r.text());
      const made = await rpc('create_beach_bed', { bed_number: '2', zone: 'back' });
      assert.ok(!made.includes('"isError":true'), made.slice(0, 400));
      const bed = (await pool.query(`SELECT id FROM beach_bed WHERE property_id = $1 AND bed_number = '2'`, [props[0]])).rows[0];
      const booked = await rpc('create_beach_booking', { bed_id: bed.id, contact_name: 'Cy', date: '2031-07-03' });
      assert.ok(!booked.includes('"isError":true'), booked.slice(0, 400));
      const again = await rpc('create_beach_booking', { bed_id: bed.id, contact_name: 'Di', date: '2031-07-03' });
      assert.ok(again.includes('"isError":true') && again.includes('already booked'), again.slice(0, 400));
      assert.ok((await rpc('list_beach_bookings', { date: '2031-07-03' })).includes('Cy'));
    });
  } finally {
    server.close();
    if (props.length) {
      const q = (sql) => pool.query(sql, [props]).catch((e) => console.log('cleanup:', e.message));
      await q('DELETE FROM beach_booking WHERE property_id = ANY($1)');
      await q('DELETE FROM beach_bed WHERE property_id = ANY($1)');
      await q('DELETE FROM guest WHERE property_id = ANY($1)');
      await q('DELETE FROM api_key WHERE property_id = ANY($1)');
      await q('DELETE FROM property WHERE id = ANY($1)');
    }
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
