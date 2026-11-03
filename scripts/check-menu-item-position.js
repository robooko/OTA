// Menu item display order: new items go last, reorder sets positions, the list
// follows category then position, and other properties' items are untouched.
// Local DB only, with migrate-2026-11-03-menu-item-position.sql applied.
//   node -r dotenv/config scripts/check-menu-item-position.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const ctrl = require('../src/controllers/restaurantOrders');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name) VALUES ('Menu Order Check') RETURNING id`)).id;
  const Q = (await one(`INSERT INTO property (name) VALUES ('Menu Order Other') RETURNING id`)).id;
  const call = async (fn, req) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body: {}, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };
  const create = async (name, category) => (await call(ctrl.createMenuItem, { body: { name, category, price: 5 } })).body;
  const names = async () => (await call(ctrl.listMenuItems, {})).body.map((i) => i.name);

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    const c = await create('C', 'Mains');
    const a = await create('A', 'Mains');
    const b = await create('B', 'Mains');
    const d = await create('D', 'Drinks');
    const other = (await one(`INSERT INTO restaurant_menu_item (property_id, name, price, position) VALUES ($1, 'X', 1, 7) RETURNING id`, [Q])).id;

    await check('new items go to the end, list is category then position', async () => {
      assert.ok(a.position > c.position && b.position > a.position);
      assert.deepEqual(await names(), ['D', 'C', 'A', 'B']);
    });

    await check('reorder one category', async () => {
      const r = await call(ctrl.reorderMenuItems, { body: { ids: [b.id, c.id, a.id, other] } });
      assert.equal(r.body.reordered, 3);
      assert.deepEqual(await names(), ['D', 'B', 'C', 'A']);
    });

    await check("another property's item is untouched", async () => {
      assert.equal((await one('SELECT position FROM restaurant_menu_item WHERE id = $1', [other])).position, 7);
    });

    await check('bad ids are a 400', async () => {
      assert.equal((await call(ctrl.reorderMenuItems, { body: { ids: [] } })).status, 400);
      assert.equal((await call(ctrl.reorderMenuItems, { body: { ids: ['nope'] } })).status, 400);
      assert.equal((await call(ctrl.reorderMenuItems, { body: {} })).status, 400);
    });
  } finally {
    await pool.query('DELETE FROM restaurant_menu_item WHERE property_id = ANY($1)', [[P, Q]]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [[P, Q]]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
