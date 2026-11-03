// Table sessions list (GET /api/restaurant-table-sessions?restaurant_id=, the
// list_restaurant_table_sessions MCP tool): open sessions by default with
// table_number and payment_status, status=closed filter, and another
// property's sessions stay hidden. Local DB only.
//   node -r dotenv/config scripts/check-table-sessions-list.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const ctrl = require('../src/controllers/restaurantTableSessions');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name) VALUES ('Table Sessions Check') RETURNING id`)).id;
  const Q = (await one(`INSERT INTO property (name) VALUES ('Table Sessions Other') RETURNING id`)).id;
  const call = async (req) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await ctrl.getOpenSession({ property_id: P, auth_method: 'bearer', params: {}, query: {}, body: {}, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    const R = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Grill', 90) RETURNING id`, [P])).id;
    const table = async (n) => (await one(`INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats) VALUES ($1, $2, $3, 4) RETURNING id`, [P, R, n])).id;
    const [t1, t2, t3] = [await table('1'), await table('2'), await table('3')];
    const session = (t, status, opened) => one(
      `INSERT INTO restaurant_table_session (property_id, restaurant_id, table_id, status, opened_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::varchar = 'closed' THEN now() END) RETURNING id`, [P, R, t, status, opened]);
    const s2 = (await session(t2, 'open', '2026-11-03T19:00:00Z')).id;
    const s1 = (await session(t1, 'open', '2026-11-03T20:00:00Z')).id;
    const s3 = (await session(t3, 'closed', '2026-11-03T18:00:00Z')).id;

    await check('open sessions by default, oldest first, with table_number and payment_status', async () => {
      const r = await call({ query: { restaurant_id: R } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.map((s) => [s.id, s.table_number, s.payment_status]), [[s2, '2', 'unpaid'], [s1, '1', 'unpaid']]);
    });

    await check('status=closed lists closed sessions', async () => {
      assert.deepEqual((await call({ query: { restaurant_id: R, status: 'closed' } })).body.map((s) => s.id), [s3]);
    });

    await check("another property sees none of them", async () => {
      assert.deepEqual((await call({ property_id: Q, query: { restaurant_id: R } })).body, []);
    });

    await check('neither table_id nor restaurant_id is a 400', async () => {
      assert.equal((await call({})).status, 400);
    });
  } finally {
    await pool.query('DELETE FROM restaurant_table_session WHERE property_id = ANY($1)', [[P, Q]]);
    await pool.query('DELETE FROM restaurant_table WHERE property_id = ANY($1)', [[P, Q]]);
    await pool.query('DELETE FROM restaurant WHERE property_id = ANY($1)', [[P, Q]]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [[P, Q]]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
