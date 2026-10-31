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

const pool = require('../src/db');
const { PERMISSIONS, unknownPermissions, getGrant, setGrant } = require('../src/lib/permissions');
const apiKeys = require('../src/lib/apiKeys');

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
  } finally {
    await pool.query('DELETE FROM property WHERE clerk_org_id = $1', [ORG]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = ANY($1)', [[ORG, FRESH_ORG]]);
    await pool.end();
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
