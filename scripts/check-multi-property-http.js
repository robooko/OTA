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
const apiKeys = require('../src/lib/apiKeys');
const app = require('../src/app');
const { SITE_AMBIGUOUS } = require('../src/lib/propertyResolver');
const orgCtrl = require('../src/controllers/organization');
const orgKeys = require('../src/controllers/apiKeys').organization;

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
  const A2 = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Harbour', $1, 'harbour') RETURNING id`, [ORG])).id;
  await apiKeys.create(pool, { property_id: A2 }, { key: PROP_KEY });
  await apiKeys.create(pool, { clerk_org_id: ORG }, { key: ORG_KEY });
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
    const mcp = (headers, name = 'get_property', args = {}, key = ORG_KEY, method = 'tools/call') => fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Api-Key': key, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name, arguments: args } : {} }),
    });
    // The tool's JSON result (or error text) out of the MCP response.
    const tool = async (...a) => {
      const r = await mcp(...a);
      const text = await r.text();
      assert.equal(r.status, 200, text);
      const msg = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text);
      const out = msg.result.content[0].text;
      return msg.result.isError ? { error: out } : JSON.parse(out);
    };
    await check('mcp: org key + slug -> tool calls land on that hotel', async () => {
      const r = await mcp({ 'X-Property-Slug': 'harbour' });
      const text = await r.text();
      assert.equal(r.status, 200, text);
      assert.ok(text.includes(A2), text);
      assert.ok(!text.includes('"isError":true'), text);
    });
    await check('mcp: org key, no selector -> connects; a hotel tool without property_id says which is needed', async () => {
      assert.equal((await tool({})).error, SITE_AMBIGUOUS);
      assert.equal((await tool({}, 'get_property', { property_id: A1 })).id, A1);
      assert.equal((await tool({ 'X-Property-Slug': 'harbour' }, 'get_property', { property_id: A1 })).id, A1, 'property_id beats the header');
      assert.match((await tool({}, 'get_property', { property_id: crypto.randomUUID() })).error, /not found/i);
    });
    await check('mcp: bad key -> 401 before any tool runs', async () => {
      assert.equal((await mcp({}, 'get_property', {}, 'nope')).status, 401);
    });
    await check('mcp: tools/list gives hotel tools a property_id, org tools none', async () => {
      const r = await mcp({}, null, null, ORG_KEY, 'tools/list');
      const text = await r.text();
      const { tools } = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result;
      const by = Object.fromEntries(tools.map((t) => [t.name, t]));
      assert.ok(by.create_room_type.inputSchema.properties.property_id);
      assert.ok(!by.list_properties.inputSchema.properties?.property_id);
      assert.ok(!by.create_property.inputSchema.properties?.property_id);
    });
    await check('mcp: an agent lists, creates and sets up a hotel with the org key alone', async () => {
      const before = await tool({}, 'list_properties');
      assert.deepEqual(before.map((p) => p.slug).sort(), ['harbour', 'seaview']);
      const made = await tool({}, 'create_property', { name: 'Lagoon', slug: 'lagoon' });
      assert.equal(made.name, 'Lagoon');
      const rt = await tool({}, 'create_room_type', { property_id: made.id, name: 'Lagoon Suite', max_occupancy: 2, base_rate: 300 });
      assert.equal((await one('SELECT property_id FROM room_type WHERE id = $1', [rt.id])).property_id, made.id);
      assert.deepEqual((await tool({}, 'list_room_types', { property_id: A1 })).map((t) => t.id).filter((id) => id === rt.id), [], 'other hotel untouched');
      assert.equal((await tool({}, 'list_properties')).length, 3);
      assert.match((await tool({}, 'list_properties', {}, PROP_KEY)).error, /organization API key/);
    });

    await check('site: GET /api/site/properties lists the org\'s hotels, no secrets', async () => {
      const r = await api('GET', '/api/site/properties');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.map((p) => p.slug).sort(), ['harbour', 'lagoon', 'seaview'], 'Lagoon from the MCP check');
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
    await check('organization properties: org key lists; create needs properties.manage; property key 403', async () => {
      assert.equal((await api('GET', '/api/organization/properties')).status, 200);
      assert.equal((await api('GET', '/api/organization/properties', { key: PROP_KEY })).status, 403);
      assert.equal((await api('GET', '/api/organization/properties', { key: null })).status, 401);
      const SCOPED = `org_scoped_${run}`; const MANAGER = `org_mgr_${run}`;
      await apiKeys.create(pool, { clerk_org_id: ORG }, { key: SCOPED, name: 'Site', permissions: [] });
      await apiKeys.create(pool, { clerk_org_id: ORG }, { key: MANAGER, name: 'Agent', permissions: ['properties.manage'] });
      assert.equal((await api('POST', '/api/organization/properties', { key: SCOPED, body: { name: 'No' } })).status, 403);
      assert.equal((await api('POST', '/api/organization/properties', { key: PROP_KEY, body: { name: 'No' } })).status, 403);
      assert.equal((await api('POST', '/api/organization/properties', { key: MANAGER, body: { name: 'Reef' } })).status, 201);
      assert.equal((await api('GET', '/api/organization/api-keys')).status, 401, 'key management stays bearer-only');
    });
    await check('org controller: list and create properties', async () => {
      const list = await call(orgCtrl.listProperties, { clerk_org_id: ORG });
      assert.equal(list.body.length, 4, 'Seaview, Harbour + Lagoon, Reef from the checks above');
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
      const rotated = await call(orgKeys.rotateLegacy, { clerk_org_id: fresh }); // before any GET
      assert.match(rotated.body.api_key, /^org_[0-9a-f]{64}$/);
      const got = await call(orgKeys.getLegacy, { clerk_org_id: fresh });
      assert.deepEqual(got.body, { api_key: rotated.body.api_key, api_key_enabled: true });
      assert.equal((await call(orgKeys.disableLegacy, { clerk_org_id: fresh })).body.api_key_enabled, false);
      assert.equal((await call(orgKeys.enableLegacy, { clerk_org_id: fresh })).body.api_key_enabled, true);
      const again = await call(orgKeys.rotateLegacy, { clerk_org_id: fresh });
      assert.notEqual(again.body.api_key, rotated.body.api_key);
    });
  } finally {
    await pool.query('DELETE FROM property_website WHERE property_id IN (SELECT id FROM property WHERE clerk_org_id = ANY($1))', [cleanupOrgs]);
    await pool.query('DELETE FROM room_type WHERE property_id IN (SELECT id FROM property WHERE clerk_org_id = ANY($1))', [cleanupOrgs]);
    await pool.query('DELETE FROM property_token_ledger WHERE property_id IN (SELECT id FROM property WHERE clerk_org_id = ANY($1))', [cleanupOrgs]);
    await pool.query('DELETE FROM property WHERE clerk_org_id = ANY($1)', [cleanupOrgs]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = ANY($1)', [cleanupOrgs]);
    server.close();
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
