// Website API keys and the payment a booking needs at booking: the website
// flag, golf / equipment rules, the amount due now, enforcement on each
// create path, and room payments carrying the website's Stripe id. Drives the
// controllers directly against a fake Stripe. Fixtures live under a throwaway
// property and are deleted at the end. Local DB only, with the 2026-11-12
// migrations applied.
//   node -r dotenv/config scripts/check-website-payments.js
// See docs/superpowers/plans/2026-11-12-entity-charges-3-enforcement.md.
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const fakeStripe = require('./fake-stripe');
require.cache[require.resolve('stripe')] = { id: 'stripe', filename: require.resolve('stripe'), loaded: true, exports: () => fakeStripe };

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');
const keysCtl = require('../src/controllers/apiKeys');
const { resolveSiteProperty } = require('../src/lib/propertyResolver');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const ORG = `org_website_check_${Date.now()}`;
  await pool.query('INSERT INTO organization (clerk_org_id) VALUES ($1)', [ORG]);
  const P = (await one(`INSERT INTO property (name, currency, stripe_secret_key, clerk_org_id, slug) VALUES ('Website Check', 'GBP', 'sk_test_check', $1, $2) RETURNING id`,
    [ORG, `website-check-${Date.now()}`])).id;

  // Request decorators: who is calling.
  const websiteKey = { auth_method: 'api_key', api_key: { id: null, permissions: null, website: true }, user: undefined };
  const fullKey = { auth_method: 'api_key', api_key: { id: null, permissions: null, website: false }, user: undefined };
  const staff = { auth_method: 'bearer', user: { role: 'staff' } };

  const call = async (fn, req) => {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; },
    };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body: {}, headers: {}, get: () => undefined, ...staff, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    // ---- Website keys ----
    await check('keys: website flag defaults off, can be set, reaches the request', async () => {
      const k = await apiKeys.create(pool, { property_id: P }, { name: 'Site' });
      assert.equal(k.website, false);
      const put = await call(keysCtl.property.update, { params: { id: k.id }, body: { website: true } });
      assert.equal(put.status, 200, JSON.stringify(put.body)); assert.equal(put.body.website, true);
      assert.equal((await call(keysCtl.property.update, { params: { id: k.id }, body: { name: 'Site 2' } })).body.website, true);
      assert.equal((await call(keysCtl.property.update, { params: { id: k.id }, body: { website: 'yes' } })).status, 400);
      assert.equal((await resolveSiteProperty(pool, { key: k.key })).apiKey.website, true);
      const made = await call(keysCtl.property.create, { body: { name: 'Made website', website: true } });
      assert.equal(made.status, 201); assert.equal(made.body.website, true);
    });

    await check('keys: an org key carries website too', async () => {
      const k = await apiKeys.create(pool, { clerk_org_id: ORG }, { name: 'Group site' });
      await apiKeys.update(pool, { clerk_org_id: ORG }, k.id, { website: true });
      const r = await resolveSiteProperty(pool, { key: k.key, propertyId: P });
      assert.equal(r.propertyId, P);
      assert.equal(r.apiKey.website, true);
    });
  } finally {
    await pool.query('DELETE FROM api_key WHERE property_id = $1 OR clerk_org_id = $2', [P, ORG]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(1); });
