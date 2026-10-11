// HTTP-level multi-property checks: the real app on an ephemeral port, real
// connections. Fixtures are committed under a throwaway org and deleted at
// the end (pass or fail). Clerk bearer routes can't be driven here -- staff
// resolution is covered by check-multi-property.js. Local DB only, with
// migrate-2026-10-11-property-org-not-unique.sql applied.
//   node -r dotenv/config scripts/check-multi-property-http.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const app = require('../src/app');
const { SITE_AMBIGUOUS } = require('../src/lib/propertyResolver');
const orgCtrl = require('../src/controllers/organization');

// Drives a controller directly (bearer routes can't be reached over HTTP
// without a real Clerk token).
const call = async (fn, req) => {
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let error;
  await fn({ params: {}, query: {}, body: {}, ...req }, res, (e) => { error = e; });
  if (error) throw error;
  return res;
};

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  process.env.PORT = String(port); // routes/mcp.js loops back to localhost:PORT
  const base = `http://127.0.0.1:${port}`;
  const run = crypto.randomBytes(4).toString('hex');
  const ORG = `org_httpchk_${run}`;
  const ORG_KEY = `org_check_${run}`;
  const PROP_KEY = `prop_check_${run}`;
  const HOST = `seaview-check-${run}.com`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

  const A1 = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Seaview', $1, 'seaview') RETURNING id`, [ORG])).id;
  const A2 = (await one(`INSERT INTO property (name, clerk_org_id, slug, api_key) VALUES ('Harbour', $1, 'harbour', $2) RETURNING id`, [ORG, PROP_KEY])).id;
  await pool.query('INSERT INTO organization (clerk_org_id, api_key) VALUES ($1, $2)', [ORG, ORG_KEY]);
  await pool.query('INSERT INTO property_website (property_id, url) VALUES ($1, $2)', [A1, `https://www.${HOST}/`]);
  const cleanupOrgs = [ORG];

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const api = async (method, path, { key = ORG_KEY, headers = {}, body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(key ? { 'X-Api-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, text };
  };
  const search = '/api/availability/search?check_in=2030-01-01&check_out=2030-01-02&guests=1';

  try {
    // ---- Task 3 ----
    await check('per-property key: GET /me is its own hotel, routing headers ignored', async () => {
      const r = await api('GET', '/api/property/me', { key: PROP_KEY, headers: { 'X-Property-Slug': 'seaview' } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.id, A2);
    });
    await check('org key + X-Property-Slug', async () => {
      const r = await api('GET', '/api/property/me', { headers: { 'X-Property-Slug': 'harbour' } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.id, A2);
    });
    await check('org key + X-Site-Host', async () => {
      const r = await api('GET', '/api/property/me', { headers: { 'X-Site-Host': `WWW.${HOST.toUpperCase()}` } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.id, A1);
    });
    await check('org key + X-Property-Id', async () => {
      const r = await api('GET', '/api/property/me', { headers: { 'X-Property-Id': A1 } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.id, A1);
    });
    await check('org key, no selector -> 400; unknown slug -> 404; unknown key -> 401', async () => {
      const none = await api('GET', '/api/property/me');
      assert.equal(none.status, 400);
      assert.equal(none.body.error, SITE_AMBIGUOUS);
      assert.equal((await api('GET', '/api/property/me', { headers: { 'X-Property-Slug': 'nope' } })).status, 404);
      assert.equal((await api('GET', '/api/property/me', { key: 'nope' })).status, 401);
    });
    await check('search: org key + slug -> 200', async () => {
      const r = await api('GET', search, { headers: { 'X-Property-Slug': 'harbour' } });
      assert.equal(r.status, 200, r.text);
      assert.ok(Array.isArray(r.body));
    });
    await check('search: org key, no selector -> 400', async () => {
      const r = await api('GET', search);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, SITE_AMBIGUOUS);
    });
    await check('search: unrecognised key still falls back to ?property_id', async () => {
      const r = await api('GET', `${search}&property_id=${A1}`, { key: 'nope' });
      assert.equal(r.status, 200, r.text);
    });
    const mcp = (headers) => fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Api-Key': ORG_KEY, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_property', arguments: {} } }),
    });
    await check('mcp: org key + slug -> tool calls land on that hotel', async () => {
      const r = await mcp({ 'X-Property-Slug': 'harbour' });
      const text = await r.text();
      assert.equal(r.status, 200, text);
      assert.ok(text.includes(A2), text);
      assert.ok(!text.includes('"isError":true'), text);
    });
    await check('mcp: org key, no selector -> clear 400', async () => {
      const r = await mcp({});
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, SITE_AMBIGUOUS);
    });

    await check('site: GET /api/site/properties lists the org\'s hotels, no secrets', async () => {
      const r = await api('GET', '/api/site/properties');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.map((p) => p.slug).sort(), ['harbour', 'seaview']);
      const seaview = r.body.find((p) => p.id === A1);
      assert.deepEqual(seaview.websites, [`https://www.${HOST}/`]);
      assert.deepEqual(Object.keys(seaview).sort(), ['currency', 'id', 'name', 'slug', 'timezone', 'websites']);
      assert.ok(!r.text.includes(PROP_KEY));
    });
    await check('site: per-property key -> 403, bad or missing key -> 401', async () => {
      const prop = await api('GET', '/api/site/properties', { key: PROP_KEY });
      assert.equal(prop.status, 403);
      assert.equal(prop.body.error, 'This endpoint requires an organization API key');
      assert.equal((await api('GET', '/api/site/properties', { key: 'nope' })).status, 401);
      assert.equal((await api('GET', '/api/site/properties', { key: null })).status, 401);
    });
    await check('PUT /me slug: validated, 409 on clash in org, null clears; GET /me returns it', async () => {
      const as1 = { headers: { 'X-Property-Id': A1 } };
      assert.equal((await api('PUT', '/api/property/me', { ...as1, body: { slug: 'Bad Slug' } })).status, 400);
      const clash = await api('PUT', '/api/property/me', { ...as1, body: { slug: 'harbour' } });
      assert.equal(clash.status, 409);
      assert.equal(clash.body.error, 'That slug is already used by another property in this organization');
      assert.equal((await api('PUT', '/api/property/me', { ...as1, body: { slug: 'seaview-2' } })).body.slug, 'seaview-2');
      assert.equal((await api('GET', '/api/property/me', as1)).body.slug, 'seaview-2');
      assert.equal((await api('PUT', '/api/property/me', { ...as1, body: { currency: 'EUR' } })).body.slug, 'seaview-2'); // omitted = unchanged
      assert.equal((await api('PUT', '/api/property/me', { ...as1, body: { slug: null } })).body.slug, null);
    });
    await check('organization routes require a bearer', async () => {
      assert.equal((await api('GET', '/api/organization/properties', { key: ORG_KEY })).status, 401);
    });
    await check('org controller: list and create properties', async () => {
      const list = await call(orgCtrl.listProperties, { clerk_org_id: ORG });
      assert.equal(list.body.length, 2);
      assert.deepEqual(Object.keys(list.body[0]).sort(), ['id', 'name', 'slug', 'status']);
      assert.equal((await call(orgCtrl.createProperty, { clerk_org_id: ORG, body: { name: '  ' } })).statusCode, 400);
      assert.equal((await call(orgCtrl.createProperty, { clerk_org_id: ORG, body: { name: 'x'.repeat(101) } })).statusCode, 400);
      assert.equal((await call(orgCtrl.createProperty, { clerk_org_id: ORG, body: { name: 'Bay', slug: 'B A Y' } })).statusCode, 400);
      const clash = await call(orgCtrl.createProperty, { clerk_org_id: ORG, body: { name: 'Bay', slug: 'harbour' } });
      assert.equal(clash.statusCode, 409);
      const made = await call(orgCtrl.createProperty, { clerk_org_id: ORG, body: { name: ' Bay ', slug: 'bay' } });
      assert.equal(made.statusCode, 201);
      assert.deepEqual(Object.keys(made.body).sort(), ['currency', 'id', 'name', 'slug', 'status', 'timezone']);
      assert.equal(made.body.name, 'Bay');
      assert.equal(made.body.status, 'active');
    });
    await check('org controller: api-key routes work in any order and toggle', async () => {
      const fresh = `org_httpchk_new_${run}`;
      cleanupOrgs.push(fresh);
      const rotated = await call(orgCtrl.rotateApiKey, { clerk_org_id: fresh }); // before any GET
      assert.match(rotated.body.api_key, /^org_[0-9a-f]{64}$/);
      const got = await call(orgCtrl.getApiKey, { clerk_org_id: fresh });
      assert.deepEqual(got.body, { api_key: rotated.body.api_key, api_key_enabled: true });
      assert.equal((await call(orgCtrl.disableApiKey, { clerk_org_id: fresh })).body.api_key_enabled, false);
      assert.equal((await call(orgCtrl.enableApiKey, { clerk_org_id: fresh })).body.api_key_enabled, true);
      const again = await call(orgCtrl.rotateApiKey, { clerk_org_id: fresh });
      assert.notEqual(again.body.api_key, rotated.body.api_key);
    });
  } finally {
    await pool.query('DELETE FROM property_website WHERE property_id IN (SELECT id FROM property WHERE clerk_org_id = ANY($1))', [cleanupOrgs]);
    await pool.query('DELETE FROM property_token_ledger WHERE property_id IN (SELECT id FROM property WHERE clerk_org_id = ANY($1))', [cleanupOrgs]);
    await pool.query('DELETE FROM property WHERE clerk_org_id = ANY($1)', [cleanupOrgs]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = ANY($1)', [cleanupOrgs]);
    server.close();
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
