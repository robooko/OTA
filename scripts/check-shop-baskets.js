// Checks abandoned shop baskets against the local DB. Every fixture lives
// inside one transaction that is rolled back, so nothing persists. Never
// point this at the live DB.
//   node -r dotenv/config scripts/check-shop-baskets.js
// No key, no client: a stub that fails to apply errors instead of emailing.
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
const { Client } = require('pg');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const prop = await one(`INSERT INTO property (name, timezone) VALUES ('Basket Check Hotel', 'Europe/London') RETURNING id`);
    const P = prop.id;

    await check('property defaults', async () => {
      const r = await one('SELECT basket_reminder_enabled, basket_reminder_delay_mins FROM property WHERE id = $1', [P]);
      assert.equal(r.basket_reminder_enabled, false);
      assert.equal(r.basket_reminder_delay_mins, 60);
    });

    const { upsertBasket, listOpenBaskets, closeBasketsForPaidOrder, linkBasketToOrder, getOpenBasketFor } = require('../src/lib/shopBaskets');
    const shop = await one(`INSERT INTO shop (property_id, name) VALUES ($1, 'Basket Shop') RETURNING id`, [P]);
    const mkItem = (name, price, status = 'active') => one(
      `INSERT INTO proshop_item (property_id, shop_id, name, price, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [P, shop.id, name, price, status]);
    const itemA = await mkItem('Cap', 10);
    const itemB = await mkItem('Old tee', 5, 'inactive');
    const guest = (items, extra = {}) => ({ shop_id: shop.id, clerk_user_id: 'user_1', contact_email: 'g@x.com', contact_name: 'G', items, ...extra });

    await check('upsert creates one open basket per guest', async () => {
      await upsertBasket(db, P, guest([{ item_id: itemA.id, quantity: 1 }]));
      await upsertBasket(db, P, guest([{ item_id: itemA.id, quantity: 3 }]));
      const rows = (await db.query(`SELECT * FROM shop_basket WHERE property_id = $1 AND status = 'open'`, [P])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].items.length, 1);
      assert.equal(rows[0].items[0].quantity, 3);
    });

    await check('upsert reprices and drops inactive', async () => {
      const mix = [{ item_id: itemA.id, quantity: 2 }, { item_id: itemB.id, quantity: 1 }];
      let b = await upsertBasket(db, P, guest(mix));
      assert.equal(b.items.length, 1);
      assert.equal(b.items_subtotal, '20.00');
      await db.query('UPDATE proshop_item SET price = 12 WHERE id = $1', [itemA.id]);
      b = await upsertBasket(db, P, guest(mix));
      assert.equal(b.items_subtotal, '24.00');
    });

    await check('empty items expires', async () => {
      const b = await upsertBasket(db, P, guest([]));
      assert.equal(b.status, 'expired');
    });

    await check('reminder_due_at', async () => {
      await upsertBasket(db, P, guest([{ item_id: itemA.id, quantity: 1 }]));
      await db.query('UPDATE property SET basket_reminder_enabled = true, basket_reminder_delay_mins = 60 WHERE id = $1', [P]);
      const on = (await listOpenBaskets(db, P, 5))[0];
      assert.equal(on.reminder_due_at.getTime(), on.updated_at.getTime() + 60 * 60000);
      await db.query('UPDATE property SET basket_reminder_enabled = false WHERE id = $1', [P]);
      assert.equal((await listOpenBaskets(db, P, 5))[0].reminder_due_at, null);
    });

    const mkOrder = (ref, email, clerk) => one(
      `INSERT INTO proshop_order (property_id, shop_id, reference, clerk_user_id, contact_name, contact_email, items_subtotal, total_price, status, payment_status)
       VALUES ($1,$2,$3,$4,'G',$5,10,10,'paid','paid') RETURNING *`, [P, shop.id, ref, clerk, email]);
    const cart = [{ item_id: itemA.id, quantity: 1 }];

    await check('paid order with clerk id recovers reminded basket', async () => {
      const b = await upsertBasket(db, P, guest(cart, { clerk_user_id: 'u_rec', contact_email: 'rec@x.com' }));
      await db.query('UPDATE shop_basket SET reminder_sent_at = now() WHERE id = $1', [b.id]);
      const order = await mkOrder('BCK001', 'rec@x.com', 'u_rec');
      await linkBasketToOrder(db, order);
      const closed = await closeBasketsForPaidOrder(db, order);
      assert.equal(closed.length, 1);
      assert.equal(closed[0].status, 'recovered');
      assert.equal(closed[0].order_id, order.id);
    });

    await check('paid order without reminder marks bought', async () => {
      await upsertBasket(db, P, guest(cart, { clerk_user_id: 'u_b', contact_email: 'b@x.com' }));
      const order = await mkOrder('BCK002', 'b@x.com', 'u_b');
      const closed = await closeBasketsForPaidOrder(db, order);
      assert.equal(closed[0].status, 'bought');
    });

    await check('paid order matches by email when no clerk id', async () => {
      await upsertBasket(db, P, guest(cart, { clerk_user_id: 'u_e', contact_email: 'sam@x.com' }));
      const order = await mkOrder('BCK003', ' Sam@X.com ', null);
      const closed = await closeBasketsForPaidOrder(db, order);
      assert.equal(closed.length, 1);
      assert.equal(closed[0].status, 'bought');
    });

    await check("other guest's basket untouched", async () => {
      await upsertBasket(db, P, guest(cart, { clerk_user_id: 'u_o', contact_email: 'other@x.com' }));
      const order = await mkOrder('BCK004', 'someone@x.com', 'u_else');
      assert.equal((await closeBasketsForPaidOrder(db, order)).length, 0);
      assert.equal((await getOpenBasketFor(db, P, shop.id, 'u_o')).status, 'open');
    });

    // New check() blocks for later tasks go above this line.
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
