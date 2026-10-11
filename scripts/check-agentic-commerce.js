// Checks agentic commerce (Stripe ACS): settings validation, feed building,
// and session -> order recording. DB fixtures live inside one transaction
// that is rolled back, so nothing persists. Never point this at the live DB.
//   node -r dotenv/config scripts/check-agentic-commerce.js
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { mergeAgenticCommerce } = require('../src/controllers/property');
const feed = require('../src/lib/agenticFeed');

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
    const FULL = { sanity_project_id: 'a26xzsqt', sanity_dataset: 'production', site_url: 'https://willy-t-bvi.vercel.app', brand: 'Willy T' };

    await check('settings: full config can be enabled; site_url trailing slash stripped', async () => {
      const { value, error } = mergeAgenticCommerce(null, { ...FULL, site_url: 'https://willy-t-bvi.vercel.app/', enabled: true });
      assert.equal(error, undefined);
      assert.deepEqual(value, { ...FULL, enabled: true });
    });
    await check('settings: enabling with a field missing is rejected', async () => {
      assert.match(mergeAgenticCommerce(null, { ...FULL, brand: undefined, enabled: true }).error, /brand/);
    });
    await check('settings: omitted fields keep their stored value', async () => {
      const { value } = mergeAgenticCommerce({ ...FULL, enabled: true }, { brand: 'Willy-T' });
      assert.deepEqual(value, { ...FULL, brand: 'Willy-T', enabled: true });
    });
    await check('settings: bad values are rejected', async () => {
      assert.ok(mergeAgenticCommerce(null, { sanity_project_id: 'A26/x' }).error);
      assert.ok(mergeAgenticCommerce(null, { sanity_dataset: 'prod data' }).error);
      assert.ok(mergeAgenticCommerce(null, { site_url: 'javascript:alert(1)' }).error);
      assert.ok(mergeAgenticCommerce(null, { brand: '   ' }).error);
      assert.ok(mergeAgenticCommerce(null, { brand: 'x'.repeat(71) }).error);
      assert.ok(mergeAgenticCommerce(null, { enabled: 'yes' }).error);
    });

    const CFG = { sanity_project_id: 'a26xzsqt', sanity_dataset: 'production', site_url: 'https://willy-t-bvi.vercel.app', brand: 'Willy T' };
    const IMG = { asset: { _ref: 'image-abc123-800x800-webp' } };
    const item = (o) => ({ id: '11111111-2222-3333-4444-555555555555', name: 'Burgee', price: '20.00', category: 'Flags', product_group: null, variant_label: null, stock_quantity: null, ...o });
    const doc = (o) => ({ name: 'Burgee', slug: 'burgee', description: 'Flag of the bar', features: [], image: IMG, ...o });

    await check('feed: id strips dashes; standalone item row', async () => {
      const { product } = feed.buildFeeds({ items: [item()], docs: [doc()], settings: { shopShippingCost: 20 }, config: CFG, currency: 'USD' });
      assert.equal(product.length, 1);
      const r = product[0];
      assert.equal(r.id, '11111111222233334444555555555555');
      assert.equal(r.mpn, r.id);
      assert.equal(r.link, 'https://willy-t-bvi.vercel.app/shop/burgee/');
      assert.equal(r.image_link, 'https://cdn.sanity.io/images/a26xzsqt/production/abc123-800x800.webp?w=1200&fm=jpg');
      assert.equal(r.price, '20.00 USD');
      assert.equal(r.brand, 'Willy T');
      assert.equal(r.product_category, 'Flags');
      assert.equal(r.item_group_id, '');
      assert.equal(r.shipping, 'US:ALL:Delivery::20.00 USD');
      assert.equal(r.disable_checkout, '');
    });
    await check('feed: name join ignores case and whitespace', async () => {
      const { product } = feed.buildFeeds({ items: [item({ name: '  BURGEE ' })], docs: [doc()], settings: null, config: CFG, currency: 'USD' });
      assert.equal(product.length, 1);
    });
    await check('feed: size variant borrows same-colour sibling doc; no doc anywhere = skipped', async () => {
      const g = 'Rash Guard Long Sleeve UPF 50+';
      const items = [
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: `${g} — Grey — L`, product_group: g, variant_label: 'Grey — L' }),
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000002', name: `${g} — White — L`, product_group: g, variant_label: 'White — L' }),
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000003', name: `${g} — White — S`, product_group: g, variant_label: 'White — S' }),
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000004', name: 'Mystery Mug' }),
      ];
      const docs = [doc({ name: `${g} — Grey — L`, slug: 'grey' }), doc({ name: `${g} — White — L`, slug: 'white' })];
      const { product, skipped } = feed.buildFeeds({ items, docs, settings: null, config: CFG, currency: 'USD' });
      assert.equal(product.find((r) => r.title.endsWith('White — S')).link, 'https://willy-t-bvi.vercel.app/shop/white/');
      assert.deepEqual(skipped, ['Mystery Mug']);
      assert.equal(product[0].item_group_id, g);
      assert.equal(product[0].custom_variant_option_name_1, 'Variant');
      assert.equal(product[0].custom_variant_option_value_1, 'Grey — L');
    });
    await check('feed: stock -- untracked, tracked, sold out; inventory feed = tracked only', async () => {
      const items = [
        item({ id: 'bbbbbbbb-0000-0000-0000-000000000001', name: 'A', stock_quantity: null }),
        item({ id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'B', stock_quantity: 5 }),
        item({ id: 'bbbbbbbb-0000-0000-0000-000000000003', name: 'C', stock_quantity: 0 }),
      ];
      const docs = ['A', 'B', 'C'].map((n) => doc({ name: n, slug: n.toLowerCase() }));
      const { product, inventory, pricing } = feed.buildFeeds({ items, docs, settings: null, config: CFG, currency: 'USD' });
      const [a, b, c] = product;
      assert.deepEqual([a.inventory_not_tracked, a.inventory_quantity, a.availability], ['true', '', 'in_stock']);
      assert.deepEqual([b.inventory_not_tracked, b.inventory_quantity, b.availability], ['false', '5', 'in_stock']);
      assert.deepEqual([c.inventory_not_tracked, c.inventory_quantity, c.availability], ['false', '0', 'out_of_stock']);
      assert.deepEqual(inventory.map((r) => r.inventory_quantity), ['5', '0']);
      assert.equal(pricing.length, 3);
    });
    await check('feed: shipping overrides per state; no cost = discovery only', async () => {
      assert.equal(feed.shippingEntries({ shopShippingCost: 20, shopShippingCostByState: [{ state: 'AK', cost: 45 }] }, 'USD'),
        'US:ALL:Delivery::20.00 USD,US:AK:Delivery::45.00 USD');
      assert.equal(feed.shippingEntries({ shopShippingCost: 0 }, 'USD'), 'US:ALL:Delivery::0.00 USD');
      const { product } = feed.buildFeeds({ items: [item()], docs: [doc()], settings: {}, config: CFG, currency: 'USD' });
      assert.equal(product[0].shipping, '');
      assert.equal(product[0].disable_checkout, 'true');
    });
    await check('feed: description joins features without doubled full stops; falls back to name', async () => {
      const { product } = feed.buildFeeds({ items: [item()], docs: [doc({ description: 'Flag of the bar.', features: ['Machine washable.', ' 12 x 18 in '] })], settings: null, config: CFG, currency: 'USD' });
      assert.equal(product[0].description, 'Flag of the bar. Machine washable. 12 x 18 in');
      const bare = feed.buildFeeds({ items: [item()], docs: [doc({ description: null, features: null })], settings: null, config: CFG, currency: 'USD' });
      assert.equal(bare.product[0].description, 'Burgee');
    });
    await check('feed: CSV quotes commas, quotes and newlines', async () => {
      const csv = feed.toCsv([{ id: 'x', title: 'Soft "vintage" fit, UPF 50+', description: 'line1\nline2' }], ['id', 'title', 'description']);
      assert.equal(csv, 'id,title,description\r\nx,"Soft ""vintage"" fit, UPF 50+","line1\nline2"\r\n');
    });

    await check('sync: first run uploads product (replace) then pricing + inventory (upsert)', async () => {
      const prop = await one(`INSERT INTO property (name, currency, timezone, stripe_secret_key, agentic_commerce)
        VALUES ('Feed Check', 'USD', 'America/Tortola', 'sk_test_fake', $1) RETURNING *`, [{ ...CFG, enabled: true }]);
      await db.query(`INSERT INTO proshop_item (property_id, name, price, stock_quantity) VALUES ($1, 'Burgee', 20, 3), ($1, 'Unknown', 9, NULL)`, [prop.id]);
      const calls = [];
      const stripe = { v2: { commerce: { productCatalog: { imports: { create: async (p) => { calls.push(p); return { id: `imp_${calls.length}`, status: 'awaiting_upload', status_details: { awaiting_upload: { upload_url: { url: 'https://upload.test/x' } } } }; } } } } } };
      const puts = [];
      const realFetch = global.fetch;
      global.fetch = async (url, opts) => { puts.push(opts.body); return { ok: true, status: 200 }; };
      try {
        const out = await feed.syncProperty(prop, { db, stripe, fetchSanity: async () => ({ docs: [doc()], settings: { shopShippingCost: 20 } }), now: 1_000 });
        assert.deepEqual(out.map(([t]) => t), ['product', 'pricing', 'inventory']);
        assert.deepEqual(calls.map((c) => [c.feed_type, c.mode]), [['product', 'replace'], ['pricing', 'upsert'], ['inventory', 'upsert']]);
        assert.match(puts[0], /^id,title,/);
        assert.equal(puts[0].trim().split('\r\n').length, 2); // header + Burgee; 'Unknown' has no doc
        const again = await feed.syncProperty(prop, { db, stripe, fetchSanity: async () => ({ docs: [doc()], settings: { shopShippingCost: 20 } }), now: 2_000 });
        assert.deepEqual(again.map(([t]) => t), ['pricing', 'inventory']); // product only every 24 h
      } finally { global.fetch = realFetch; }
    });
    await check('sync: no Sanity docs = refuse (a replace upload would empty the catalog)', async () => {
      const prop = await one(`INSERT INTO property (name, currency, timezone, stripe_secret_key, agentic_commerce)
        VALUES ('Feed Check 2', 'USD', 'America/Tortola', 'sk_test_fake', $1) RETURNING *`, [{ ...CFG, enabled: true }]);
      await db.query(`INSERT INTO proshop_item (property_id, name, price) VALUES ($1, 'Burgee', 20)`, [prop.id]);
      const stripe = { v2: { commerce: { productCatalog: { imports: { create: async () => { throw new Error('must not upload'); } } } } } };
      await assert.rejects(feed.syncProperty(prop, { db, stripe, fetchSanity: async () => ({ docs: [], settings: null }), now: 1_000 }), /no products/);
    });

    // ── later tasks append checks above this line ──
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
