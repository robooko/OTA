// Permissions checks: the vocabulary, staff grants, api_key rows, the
// migration's idempotency, and (from the second section on) the real auth
// middleware over HTTP on throwaway routes. Fixtures are committed under a
// throwaway org and deleted at the end (pass or fail) -- api_key and
// staff_permission rows cascade from the property. Local DB only, with
// migrate-2026-10-31-permissions.sql applied.
//   node -r dotenv/config scripts/check-permissions.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const express = require('express');
const pool = require('../src/db');
const { PERMISSIONS, unknownPermissions, getGrant, setGrant } = require('../src/lib/permissions');
const apiKeys = require('../src/lib/apiKeys');
const { resolveSiteProperty } = require('../src/lib/propertyResolver');
const { authenticateOrApiKey, authenticateOrgKey, requirePermission, requireRoleOrApiKey } = require('../src/middleware/auth');
const authCtrl = require('../src/controllers/auth');
const apiKeysCtrl = require('../src/controllers/apiKeys');
const staffCtrl = require('../src/controllers/staff');

// Drives a controller directly (bearer routes can't be reached over HTTP
// without a real Clerk token).
const call = async (fn, req) => {
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  let error;
  await fn({ params: {}, query: {}, body: {}, headers: {}, ...req }, res, (e) => { error = e; });
  if (error) throw error;
  return res;
};
// Drives a middleware directly: resolves { next: true } or { status, body }.
const mw = (fn, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
  fn({ headers: {}, ...req }, res, (err) => (err ? reject(err) : resolve({ next: true })));
});

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

  const run = crypto.randomBytes(4).toString('hex');
  const ORG = `org_permchk_${run}`;
  const FRESH_ORG = `org_permfresh_${run}`;
  const ORG_D = `org_permD_${run}`;
  const P = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Perm Check', $1, 'perm') RETURNING id`, [ORG])).id;
  const P2 = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Perm Check Two', $1, 'perm-two') RETURNING id`, [ORG])).id;

  try {
    // ── Vocabulary and grants ───────────────────────────────────────────────
    await check('vocabulary lists the housekeeping names', () => {
      assert.deepEqual(PERMISSIONS, ['housekeeping.inspect', 'housekeeping.manage']);
    });
    await check('unknownPermissions: names not in the list, or null for a non-list', () => {
      assert.deepEqual(unknownPermissions(['housekeeping.inspect']), []);
      assert.deepEqual(unknownPermissions(['housekeeping.inspect', 'nope.x']), ['nope.x']);
      assert.deepEqual(unknownPermissions([]), []);
      assert.equal(unknownPermissions('housekeeping.inspect'), null);
      assert.equal(unknownPermissions([1]), null);
      assert.equal(unknownPermissions(undefined), null);
    });
    await check('grant round trip: none → set → replaced', async () => {
      assert.deepEqual(await getGrant(pool, P, 'user_a'), []);
      await setGrant(pool, P, 'user_a', ['housekeeping.inspect'], 'user_admin');
      const row = await setGrant(pool, P, 'user_a', ['housekeeping.manage'], 'user_admin');
      assert.deepEqual(row.permissions, ['housekeeping.manage']);
      assert.equal(row.updated_by, 'user_admin');
      assert.deepEqual(await getGrant(pool, P, 'user_a'), ['housekeeping.manage']);
      assert.deepEqual(await getGrant(pool, P2, 'user_a'), []);
    });

    // ── Key rows ────────────────────────────────────────────────────────────
    await check('ensureDefault creates a full prop_ key once', async () => {
      const d = await apiKeys.ensureDefault(pool, { property_id: P });
      assert.equal(d.name, 'Default');
      assert.equal(d.permissions, null);
      assert.equal(d.enabled, true);
      assert.match(d.key, /^prop_[0-9a-f]{64}$/);
      assert.equal((await apiKeys.ensureDefault(pool, { property_id: P })).id, d.id);
    });
    await check('ensureDefault for an org creates the organization row and an org_ key', async () => {
      const o = await apiKeys.ensureDefault(pool, { clerk_org_id: ORG });
      assert.match(o.key, /^org_[0-9a-f]{64}$/);
      assert.equal(o.clerk_org_id, ORG);
      assert.equal((await one('SELECT count(*)::int n FROM organization WHERE clerk_org_id = $1', [ORG])).n, 1);
    });
    await check('create / findByKey / update / list / remove', async () => {
      const d = await apiKeys.ensureDefault(pool, { property_id: P });
      const s = await apiKeys.create(pool, { property_id: P }, { name: 'Site', permissions: ['housekeeping.inspect'], created_by: 'user_admin' });
      assert.equal(s.name, 'Site');
      assert.deepEqual(s.permissions, ['housekeeping.inspect']);
      assert.equal(s.created_by, 'user_admin');
      assert.equal((await apiKeys.findByKey(pool, s.key)).id, s.id);
      assert.equal(await apiKeys.findByKey(pool, 'prop_nope'), null);
      const off = await apiKeys.update(pool, { property_id: P }, s.id, { enabled: false });
      assert.equal(off.enabled, false);
      assert.equal(await apiKeys.findByKey(pool, s.key), null); // disabled = not found
      assert.equal(await apiKeys.update(pool, { clerk_org_id: ORG }, s.id, { name: 'x' }), null); // wrong owner
      const renamed = await apiKeys.update(pool, { property_id: P }, s.id, { name: 'Website', permissions: null, enabled: true });
      assert.deepEqual([renamed.name, renamed.permissions, renamed.enabled], ['Website', null, true]);
      assert.deepEqual((await apiKeys.list(pool, { property_id: P })).map((k) => k.id), [d.id, s.id]);
      assert.equal(await apiKeys.remove(pool, { property_id: P }, s.id), true);
      assert.equal(await apiKeys.remove(pool, { property_id: P }, s.id), false);
      assert.throws(() => apiKeys.generateKey({}), /owner/);
    });
    await check('create with an explicit key and enabled=false (fixture use)', async () => {
      const k = await apiKeys.create(pool, { property_id: P2 }, { key: `prop_fixture_${run}`, enabled: false });
      assert.equal(k.key, `prop_fixture_${run}`);
      assert.equal(await apiKeys.findByKey(pool, k.key), null);
      await apiKeys.remove(pool, { property_id: P2 }, k.id);
    });
    await check('migration re-run after a rotation adds no second Default', async () => {
      // P2 has a stale legacy column value AND a live api_key row.
      await pool.query('UPDATE property SET api_key = $1 WHERE id = $2', [`prop_legacy_${run}`, P2]);
      await apiKeys.create(pool, { property_id: P2 }, { key: `prop_live_${run}` });
      await pool.query(fs.readFileSync('src/db/migrate-2026-10-31-permissions.sql', 'utf8'));
      const rows = await apiKeys.list(pool, { property_id: P2 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].key, `prop_live_${run}`);
    });
    await check('migration copies a legacy key for an owner with no row yet', async () => {
      const P3 = (await one(`INSERT INTO property (name, clerk_org_id, slug, api_key, api_key_enabled) VALUES ('Perm Legacy', $1, 'perm-legacy', $2, false) RETURNING id`, [ORG, `prop_copyme_${run}`])).id;
      await pool.query(fs.readFileSync('src/db/migrate-2026-10-31-permissions.sql', 'utf8'));
      const rows = await apiKeys.list(pool, { property_id: P3 });
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].name, rows[0].key, rows[0].enabled, rows[0].permissions], ['Default', `prop_copyme_${run}`, false, null]);
    });

    // ── Resolver and middleware over HTTP ───────────────────────────────────
    // No gated route exists in the product yet, so the real middleware is
    // mounted on throwaway routes.
    const P_B = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Perm Check B', $1, 'perm-b') RETURNING id`, [ORG])).id;
    const own = { property_id: P };
    const FULL = await apiKeys.create(pool, own, { name: 'Full' });
    const SCOPED = await apiKeys.create(pool, own, { name: 'Scoped', permissions: ['housekeeping.inspect'] });
    const EMPTY = await apiKeys.create(pool, own, { name: 'Empty', permissions: [] });
    const OFF = await apiKeys.create(pool, own, { name: 'Off', enabled: false });
    const ORG_FULL = await apiKeys.create(pool, { clerk_org_id: ORG }, { name: 'Org full' });
    const ORG_OFF = await apiKeys.create(pool, { clerk_org_id: ORG }, { name: 'Org off', enabled: false });

    const test = express();
    test.get('/gated', authenticateOrApiKey, requirePermission('housekeeping.inspect'), (req, res) => res.json({ ok: true, key: req.api_key.id, property_id: req.property_id }));
    test.get('/admin-gated', authenticateOrApiKey, requireRoleOrApiKey('admin'), (req, res) => res.json({ ok: true }));
    test.get('/org-only', authenticateOrgKey, (req, res) => res.json({ org: req.clerk_org_id, key: req.api_key.id }));
    const server = test.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, key, headers = {}) => {
      const r = await fetch(base + path, { headers: { 'X-Api-Key': key, ...headers } });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const MISSING = { error: 'Missing permission', permission: 'housekeeping.inspect' };
    const SCOPED_ERR = { error: 'This key is scoped; this route needs a full key or a named permission' };

    try {
      await check('resolveSiteProperty returns the key on both paths', async () => {
        const a = await resolveSiteProperty(pool, { key: FULL.key });
        assert.deepEqual(a, { propertyId: P, apiKey: { id: FULL.id, permissions: null } });
        const b = await resolveSiteProperty(pool, { key: ORG_FULL.key, propertyId: P_B });
        assert.deepEqual(b, { propertyId: P_B, clerkOrgId: ORG, apiKey: { id: ORG_FULL.id, permissions: null } });
        assert.equal(await resolveSiteProperty(pool, { key: OFF.key }), null);
        assert.equal(await resolveSiteProperty(pool, { key: ORG_OFF.key, propertyId: P }), null);
      });
      await check('gated route: full and scoped keys pass, empty list / disabled / unknown do not', async () => {
        const f = await get('/gated', FULL.key);
        assert.deepEqual([f.status, f.body.key, f.body.property_id], [200, FULL.id, P]);
        assert.equal((await get('/gated', SCOPED.key)).status, 200);
        const e = await get('/gated', EMPTY.key);
        assert.deepEqual([e.status, e.body], [403, MISSING]);
        assert.equal((await get('/gated', OFF.key)).status, 401);
        assert.equal((await get('/gated', 'prop_nope')).status, 401);
        const o = await get('/gated', ORG_FULL.key, { 'X-Property-Id': P });
        assert.deepEqual([o.status, o.body.key], [200, ORG_FULL.id]);
      });
      await check('admin-gated route: only a full key passes', async () => {
        assert.equal((await get('/admin-gated', FULL.key)).status, 200);
        const s = await get('/admin-gated', SCOPED.key);
        assert.deepEqual([s.status, s.body], [403, SCOPED_ERR]);
        assert.deepEqual((await get('/admin-gated', EMPTY.key)).body, SCOPED_ERR);
      });
      await check('a key copied in by the migration keeps doing everything', async () => {
        const P4 = (await one(`INSERT INTO property (name, clerk_org_id, slug, api_key, api_key_enabled) VALUES ('Perm Legacy Live', $1, 'perm-legacy-live', $2, true) RETURNING id`, [ORG, `prop_legacylive_${run}`])).id;
        await pool.query(fs.readFileSync('src/db/migrate-2026-10-31-permissions.sql', 'utf8'));
        const g = await get('/gated', `prop_legacylive_${run}`);
        assert.deepEqual([g.status, g.body.property_id], [200, P4]);
        assert.equal((await get('/admin-gated', `prop_legacylive_${run}`)).status, 200);
      });
      await check('org-only route: org key passes with req.api_key, disabled 401, property key 403', async () => {
        const o = await get('/org-only', ORG_FULL.key);
        assert.deepEqual([o.status, o.body], [200, { org: ORG, key: ORG_FULL.id }]);
        assert.equal((await get('/org-only', ORG_OFF.key)).status, 401);
        const p = await get('/org-only', FULL.key);
        assert.deepEqual([p.status, p.body.error], [403, 'This endpoint requires an organization API key']);
      });
      await check('staff rail: admin always, staff by grant at that property only', async () => {
        const gate = requirePermission('housekeeping.inspect');
        const staff = (property_id, id = 'user_s') => ({ auth_method: 'bearer', property_id, user: { id, role: 'staff' } });
        assert.deepEqual(await mw(gate, { auth_method: 'bearer', property_id: P, user: { id: 'user_adm', role: 'admin' } }), { next: true });
        assert.deepEqual(await mw(gate, staff(P)), { status: 403, body: MISSING });
        await setGrant(pool, P, 'user_s', ['housekeeping.inspect'], 'user_adm');
        assert.deepEqual(await mw(gate, staff(P)), { next: true });
        assert.deepEqual(await mw(gate, staff(P_B)), { status: 403, body: MISSING });
        assert.deepEqual(await mw(gate, staff(undefined)), { status: 403, body: MISSING });
        assert.deepEqual(await mw(requirePermission('housekeeping.manage'), staff(P)), { status: 403, body: { ...MISSING, permission: 'housekeeping.manage' } });
      });
      await check('requirePermission refuses an unknown name at definition time', () => {
        assert.throws(() => requirePermission('nope.x'), /nope\.x/);
      });
      await check('/api/auth/me carries the grant; empty for admins', async () => {
        const s = await call(authCtrl.me, { property_id: P, user: { id: 'user_s', role: 'staff' } });
        assert.deepEqual(s.body, { property_id: P, role: 'staff', permissions: ['housekeeping.inspect'] });
        const a = await call(authCtrl.me, { property_id: P, user: { id: 'user_adm', role: 'admin' } });
        assert.deepEqual(a.body, { property_id: P, role: 'admin', permissions: [] });
      });
    } finally {
      server.close();
    }

    // ── Key management and staff grants (controllers driven directly) ───────
    const P_C = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Perm Check C', $1, 'perm-c') RETURNING id`, [ORG])).id;
    const admin = { property_id: P_C, clerk_org_id: ORG, user: { id: 'user_adm', role: 'admin' } };
    const org = { clerk_org_id: FRESH_ORG, user: { id: 'user_adm', role: 'admin' } };

    await check('legacy property GET never mints a key: null until rotate, as before', async () => {
      const none = await call(apiKeysCtrl.property.getLegacy, admin);
      assert.deepEqual(none.body, { api_key: null, api_key_enabled: true });
      assert.deepEqual(await apiKeys.list(pool, { property_id: P_C }), []);
      assert.equal((await call(apiKeysCtrl.property.disableLegacy, admin)).statusCode, 404);
      assert.equal((await call(apiKeysCtrl.property.enableLegacy, admin)).statusCode, 404);
      assert.deepEqual(await apiKeys.list(pool, { property_id: P_C }), []);
    });
    await check('legacy property endpoints act on the Default row with the old shapes', async () => {
      const first = await call(apiKeysCtrl.property.rotateLegacy, admin); // mints
      assert.deepEqual(Object.keys(first.body), ['api_key']);
      const g = await call(apiKeysCtrl.property.getLegacy, admin);
      assert.match(g.body.api_key, /^prop_[0-9a-f]{64}$/);
      assert.deepEqual(g.body, { api_key: first.body.api_key, api_key_enabled: true });
      const r = await call(apiKeysCtrl.property.rotateLegacy, admin);
      assert.notEqual(r.body.api_key, g.body.api_key);
      assert.equal(await apiKeys.findByKey(pool, g.body.api_key), null); // old value dead
      assert.equal((await apiKeys.findByKey(pool, r.body.api_key)).name, 'Default');
      const d = await call(apiKeysCtrl.property.disableLegacy, admin);
      assert.deepEqual(d.body, { api_key: r.body.api_key, api_key_enabled: false });
      assert.equal(await apiKeys.findByKey(pool, r.body.api_key), null);
      const e = await call(apiKeysCtrl.property.enableLegacy, admin);
      assert.deepEqual(e.body, { api_key: r.body.api_key, api_key_enabled: true });
    });
    await check('legacy org endpoints create the organization row and an org_ Default', async () => {
      const g = await call(apiKeysCtrl.organization.getLegacy, org);
      assert.match(g.body.api_key, /^org_[0-9a-f]{64}$/);
      assert.equal((await call(apiKeysCtrl.organization.getLegacy, org)).body.api_key, g.body.api_key);
      assert.notEqual((await call(apiKeysCtrl.organization.rotateLegacy, org)).body.api_key, g.body.api_key);
    });
    await check('create: 201 with created_by; Default reserved; bad name / permissions are 400', async () => {
      const c = await call(apiKeysCtrl.property.create, { ...admin, body: { name: 'Website', permissions: ['housekeeping.inspect'] } });
      assert.equal(c.statusCode, 201);
      assert.deepEqual([c.body.name, c.body.permissions, c.body.created_by, c.body.enabled, c.body.property_id], ['Website', ['housekeeping.inspect'], 'user_adm', true, P_C]);
      const full = await call(apiKeysCtrl.property.create, { ...admin, body: { name: 'Agent' } });
      assert.equal(full.body.permissions, null);
      for (const body of [{ name: 'Default' }, { name: '' }, { name: 'x'.repeat(101) }, { name: 7 }, {}, { name: 'Bad', permissions: 'housekeeping.inspect' }, { name: 'Bad', permissions: [1] }]) {
        const r = await call(apiKeysCtrl.property.create, { ...admin, body });
        assert.equal(r.statusCode, 400, JSON.stringify([body, r.body]));
      }
      assert.deepEqual((await call(apiKeysCtrl.property.create, { ...admin, body: { name: 'Bad', permissions: ['nope.x', 'housekeeping.inspect'] } })).body, { error: 'Unknown permissions: nope.x' });
    });
    await check('update / list / remove, owner-scoped', async () => {
      const keys = (await call(apiKeysCtrl.property.list, admin)).body;
      assert.deepEqual(keys.map((k) => k.name), ['Default', 'Website', 'Agent']);
      const site = keys[1];
      const u = await call(apiKeysCtrl.property.update, { ...admin, params: { id: site.id }, body: { permissions: null, enabled: false } });
      assert.deepEqual([u.statusCode, u.body.permissions, u.body.enabled, u.body.name], [200, null, false, 'Website']);
      const n = await call(apiKeysCtrl.property.update, { ...admin, params: { id: site.id }, body: { name: 'Site', permissions: ['housekeeping.manage'] } });
      assert.deepEqual([n.body.name, n.body.permissions, n.body.enabled], ['Site', ['housekeeping.manage'], false]);
      assert.equal((await call(apiKeysCtrl.property.update, { ...admin, params: { id: site.id }, body: { permissions: ['nope.x'] } })).statusCode, 400);
      assert.equal((await call(apiKeysCtrl.property.update, { ...admin, params: { id: site.id }, body: { name: 'Default' } })).statusCode, 400);
      assert.equal((await call(apiKeysCtrl.property.update, { ...admin, params: { id: site.id }, body: { enabled: 'yes' } })).statusCode, 400);
      assert.equal((await call(apiKeysCtrl.organization.update, { ...org, params: { id: site.id }, body: { name: 'x' } })).statusCode, 404); // wrong owner
      assert.equal((await call(apiKeysCtrl.property.update, { ...admin, params: { id: 'not-a-uuid' }, body: { name: 'x' } })).statusCode, 404);
      assert.equal((await call(apiKeysCtrl.property.remove, { ...admin, params: { id: site.id } })).statusCode, 204);
      assert.equal((await call(apiKeysCtrl.property.remove, { ...admin, params: { id: site.id } })).statusCode, 404);
      assert.equal((await call(apiKeysCtrl.property.list, admin)).body.length, 2);
    });
    await check('deleting Default: GET is null again and rotate mints a fresh one', async () => {
      const d = (await call(apiKeysCtrl.property.list, admin)).body.find((k) => k.name === 'Default');
      assert.equal((await call(apiKeysCtrl.property.remove, { ...admin, params: { id: d.id } })).statusCode, 204);
      assert.deepEqual((await call(apiKeysCtrl.property.getLegacy, admin)).body, { api_key: null, api_key_enabled: true });
      const r = await call(apiKeysCtrl.property.rotateLegacy, admin);
      assert.match(r.body.api_key, /^prop_[0-9a-f]{64}$/);
      assert.notEqual(r.body.api_key, d.key);
    });
    // Review #2: two tabs restoring at once must not end up with two Default rows.
    await check('concurrent first calls create exactly one Default row', async () => {
      const P_D = (await one(`INSERT INTO property (name, clerk_org_id, slug) VALUES ('Perm Check D', $1, 'perm-d') RETURNING id`, [ORG])).id;
      const rows = await Promise.all(Array.from({ length: 6 }, () => apiKeys.ensureDefault(pool, { property_id: P_D })));
      assert.equal(new Set(rows.map((r) => r.id)).size, 1, JSON.stringify(rows.map((r) => r.id)));
      assert.equal((await apiKeys.list(pool, { property_id: P_D })).length, 1);
      const orgRows = await Promise.all(Array.from({ length: 6 }, () => apiKeys.ensureDefault(pool, { clerk_org_id: ORG_D })));
      assert.equal(new Set(orgRows.map((r) => r.id)).size, 1);
      await assert.rejects(apiKeys.create(pool, { property_id: P_D }, {}), /duplicate|unique/i); // a second Default is refused by the DB
    });
    await check('staff grant PUT validates before Clerk is called', async () => {
      const put = (clerk_user_id, body) => call(staffCtrl.setStaffPermissions, { ...admin, params: { clerk_user_id }, body });
      assert.deepEqual((await put('user_x', { permissions: ['nope.x'] })).body, { error: 'Unknown permissions: nope.x' });
      assert.equal((await put('user_x', {})).statusCode, 400);
      assert.equal((await put('user_x', { permissions: 'housekeeping.inspect' })).statusCode, 400);
      assert.equal((await put('user_x', { permissions: [null] })).statusCode, 400);
    });
  } finally {
    await pool.query('DELETE FROM property WHERE clerk_org_id = $1', [ORG]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = ANY($1)', [[ORG, FRESH_ORG, ORG_D]]);
    await pool.end();
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
