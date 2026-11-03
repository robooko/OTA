// Menu item display order: new items go last, reorder sets positions, the list
// follows category then position, and other properties' items are untouched.
// Category order: a restaurant's menu_category_order leads the list, and a
// rename keeps the category's place. Sold out: listed, not orderable.
// Local DB only, with migrate-2026-11-03-menu-item-position.sql,
// migrate-2026-11-03-restaurant-menu-category-order.sql and
// migrate-2026-11-03-menu-item-sold-out.sql applied.
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

    // A restaurant's own menu, so its category order applies.
    const R = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Grill', 90) RETURNING id`, [P])).id;
    for (const [name, category] of [['Fries', 'Sides'], ['Ribeye', 'Steaks'], ['Spritz', 'Cocktails'], ['Pie', null]]) {
      await call(ctrl.createMenuItem, { body: { name, category, price: 5, restaurant_id: R } });
    }
    const menu = async () => (await call(ctrl.listMenuItems, { query: { restaurant_id: R } })).body.map((i) => i.name);

    await check('no category order yet: categories by name, uncategorised last', async () => {
      assert.deepEqual(await menu(), ['Spritz', 'Fries', 'Ribeye', 'Pie']);
    });

    await check('category order leads, unlisted categories follow by name', async () => {
      const r = await call(ctrl.reorderMenuCategories, { body: { restaurant_id: R, categories: ['Steaks', 'Sides'] } });
      assert.deepEqual(r.body.menu_category_order, ['Steaks', 'Sides']);
      assert.deepEqual(await menu(), ['Ribeye', 'Fries', 'Spritz', 'Pie']);
    });

    await check('renaming a category keeps its place', async () => {
      await call(ctrl.renameMenuCategory, { body: { restaurant_id: R, from: 'Steaks', to: 'Grill' } });
      assert.deepEqual((await one('SELECT menu_category_order FROM restaurant WHERE id = $1', [R])).menu_category_order, ['Grill', 'Sides']);
      assert.deepEqual(await menu(), ['Ribeye', 'Fries', 'Spritz', 'Pie']);
    });

    await check('bad category reorders are a 400/404', async () => {
      assert.equal((await call(ctrl.reorderMenuCategories, { body: { categories: [] } })).status, 400);
      assert.equal((await call(ctrl.reorderMenuCategories, { body: { restaurant_id: R, categories: [''] } })).status, 400);
      assert.equal((await call(ctrl.reorderMenuCategories, { body: { restaurant_id: R } })).status, 400);
      assert.equal((await call(ctrl.reorderMenuCategories, { property_id: Q, body: { restaurant_id: R, categories: [] } })).status, 404);
    });

    await check('a sold-out item stays listed but cannot be ordered', async () => {
      const soup = (await call(ctrl.createMenuItem, { body: { name: 'Soup', price: 5, restaurant_id: R } })).body;
      assert.equal(soup.sold_out, false);
      assert.equal((await call(ctrl.updateMenuItem, { params: { id: soup.id }, body: { sold_out: 'yes' } })).status, 400);
      assert.equal((await call(ctrl.updateMenuItem, { params: { id: soup.id }, body: { sold_out: true } })).body.sold_out, true);
      assert.equal((await call(ctrl.updateMenuItem, { params: { id: soup.id }, body: { price: 6 } })).body.sold_out, true);
      assert.ok((await menu()).includes('Soup'));
      const r = await call(ctrl.createOrder, { body: { restaurant_id: R, items: [{ item_id: soup.id }] } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'Soup is sold out');
    });
  } finally {
    await pool.query('DELETE FROM restaurant_menu_item WHERE property_id = ANY($1)', [[P, Q]]);
    await pool.query('DELETE FROM restaurant WHERE property_id = ANY($1)', [[P, Q]]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [[P, Q]]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
