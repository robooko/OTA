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

    // ---- Task 4 ----
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
