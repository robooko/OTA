// Multi-property resolution checks against the local DB. Fixtures live in
// one rolled-back transaction, so nothing persists -- except the concurrent
// auto-create case, which needs two real connections and deletes its own
// rows. The transaction drops property_clerk_org_id_key (rolled back with
// everything else), which holds an exclusive lock on `property` until the
// end: stop a local dev server first. Never point this at the live DB.
//   node -r dotenv/config scripts/check-multi-property.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const {
  hostKey, resolveSiteProperty, resolveStaffProperty,
  SITE_AMBIGUOUS, HOST_AMBIGUOUS, STAFF_AMBIGUOUS, NO_ACTIVE,
} = require('../src/lib/propertyResolver');

(async () => {
  let failed = 0;
  const pure = (name, fn) => {
    try { fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  pure('hostKey normalises scheme, case, www., port, userinfo, path, trailing dot, IDN', () => {
    assert.equal(hostKey('HTTPS://WWW.Seaview-Hotel.com/a?b#c'), 'seaview-hotel.com');
    assert.equal(hostKey('WWW.SEAVIEW-HOTEL.COM:443'), 'seaview-hotel.com');
    assert.equal(hostKey('x.com:8443'), 'x.com');
    assert.equal(hostKey('user:pw@x.com'), 'x.com');
    assert.equal(hostKey('X.COM.'), 'x.com');
    assert.equal(hostKey('bücher.de'), 'xn--bcher-kva.de');
    assert.equal(hostKey('not a host'), null);
    assert.equal(hostKey(''), null);
    assert.equal(hostKey(undefined), null);
    assert.equal(hostKey(null), null);
  });

  // Committed on purpose: two real connections racing the first request for
  // a brand-new org. Without the advisory lock this either makes two
  // properties (UNIQUE dropped) or throws 23505 (UNIQUE still there).
  {
    const orgF = `org_chkF_${crypto.randomBytes(4).toString('hex')}`;
    try {
      const slowName = async () => { await new Promise((r) => setTimeout(r, 50)); return 'Racing Org'; };
      const [r1, r2] = await Promise.all([
        resolveStaffProperty(pool, orgF, undefined, slowName),
        resolveStaffProperty(pool, orgF, undefined, slowName),
      ]);
      pure('concurrent first requests for a new org create exactly one property', () => {
        assert.ok(r1.propertyId && r1.propertyId === r2.propertyId, JSON.stringify([r1, r2]));
        assert.equal([r1, r2].filter((r) => r.createdId).length, 1);
      });
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM property WHERE clerk_org_id = $1', [orgF]);
      pure('...and only one row exists', () => assert.equal(rows[0].n, 1));
    } catch (e) {
      pure('concurrent first requests for a new org create exactly one property', () => { throw e; });
    } finally {
      await pool.query('DELETE FROM property WHERE clerk_org_id = $1', [orgF]);
    }
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    await db.query('ALTER TABLE property DROP CONSTRAINT IF EXISTS property_clerk_org_id_key');

    const run = crypto.randomBytes(4).toString('hex');
    const ORG = { A: `org_chkA_${run}`, B: `org_chkB_${run}`, C: `org_chkC_${run}`, D: `org_chkD_${run}` };
    const prop = async (org, name, slug, { status = 'active', key = null } = {}) =>
      (await one(`INSERT INTO property (name, clerk_org_id, slug, status, api_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [name, org, slug, status, key])).id;
    const site = (propertyId, url, status = 'active') =>
      db.query(`INSERT INTO property_website (property_id, url, status) VALUES ($1, $2, $3)`, [propertyId, url, status]);
    const orgKey = async (org, enabled = true) =>
      (await one(`INSERT INTO organization (clerk_org_id, api_key, api_key_enabled) VALUES ($1, $2, $3) RETURNING api_key`,
        [org, `org_check_${org}`, enabled])).api_key;

    const A1_KEY = `prop_check_A1_${run}`;
    const A1 = await prop(ORG.A, 'Seaview', 'seaview', { key: A1_KEY });
    const A2 = await prop(ORG.A, 'Harbour', 'harbour');
    const A3 = await prop(ORG.A, 'Closed', 'closed', { status: 'inactive' });
    const B1 = await prop(ORG.B, 'Other Seaview', 'seaview');
    const C1 = await prop(ORG.C, 'Solo', null);
    await prop(ORG.D, 'Gone', null, { status: 'inactive' });
    await site(A1, 'HTTPS://WWW.Seaview-Hotel.com/');
    await site(A1, 'https://mygroup.com/seaview');
    await site(A2, 'https://mygroup.com/harbour');
    await site(A2, 'https://old-harbour.com', 'inactive');
    await site(B1, 'https://seaview-hotel.com');
    const KA = await orgKey(ORG.A);
    const KB = await orgKey(ORG.B);
    const KC = await orgKey(ORG.C);
    const KD = await orgKey(ORG.D);
    const KOFF = await orgKey(`org_chkOff_${run}`, false);

    const site$ = (sel) => resolveSiteProperty(db, sel);
    const is = (r, id) => assert.equal(r?.propertyId, id, JSON.stringify(r));
    const err = (r, status, error) => assert.deepEqual(r, { status, error });
    const NF = (r) => err(r, 404, 'Property not found');

    await check('org key + X-Property-Id (any case) selects within the org', async () => {
      is(await site$({ key: KA, propertyId: A2 }), A2);
      is(await site$({ key: KA, propertyId: A2.toUpperCase() }), A2);
      NF(await site$({ key: KA, propertyId: B1 }));
      NF(await site$({ key: KA, propertyId: A3 }));
      NF(await site$({ key: KA, propertyId: 'not-a-uuid' }));
    });
    await check('org key + X-Property-Slug', async () => {
      is(await site$({ key: KA, slug: 'harbour' }), A2);
      is(await site$({ key: KB, slug: 'seaview' }), B1);
      NF(await site$({ key: KA, slug: 'nope' }));
      NF(await site$({ key: KA, slug: 'closed' }));
    });
    await check('org key + X-Site-Host resolves inside the org only', async () => {
      is(await site$({ key: KA, host: 'seaview-hotel.com' }), A1);
      is(await site$({ key: KA, host: 'WWW.SEAVIEW-HOTEL.COM:443' }), A1);
      is(await site$({ key: KB, host: 'seaview-hotel.com' }), B1);
      NF(await site$({ key: KA, host: 'old-harbour.com' }));
      NF(await site$({ key: KA, host: 'nobody.example' }));
      NF(await site$({ key: KA, host: 'not a host' }));
    });
    await check('a host shared by two hotels needs the slug', async () => {
      err(await site$({ key: KA, host: 'mygroup.com' }), 400, HOST_AMBIGUOUS);
    });
    await check('precedence: X-Property-Id > slug > host', async () => {
      is(await site$({ key: KA, slug: 'harbour', host: 'seaview-hotel.com' }), A2);
      is(await site$({ key: KA, propertyId: A1, slug: 'harbour' }), A1);
    });
    await check('no selector: one active hotel is implied; several is a 400; none is a 404', async () => {
      err(await site$({ key: KA }), 400, SITE_AMBIGUOUS);
      is(await site$({ key: KC }), C1);
      NF(await site$({ key: KD }));
    });
    await check('empty-string headers count as not sent', async () => {
      is(await site$({ key: KC, propertyId: '', slug: '', host: '' }), C1);
      err(await site$({ key: KA, slug: '' }), 400, SITE_AMBIGUOUS);
    });
    await check('org key result carries clerkOrgId', async () => {
      assert.equal((await site$({ key: KA, slug: 'harbour' })).clerkOrgId, ORG.A);
    });
    await check('per-property key ignores routing headers', async () => {
      const r = await site$({ key: A1_KEY, slug: 'harbour', host: 'mygroup.com', propertyId: A2 });
      assert.deepEqual(r, { propertyId: A1 });
    });
    await check('disabled, unknown or missing key -> null', async () => {
      assert.equal(await site$({ key: KOFF }), null);
      assert.equal(await site$({ key: 'nope' }), null);
      assert.equal(await site$({ key: '' }), null);
      assert.equal(await site$({}), null);
    });
    await check('slug is unique per org, not globally', async () => {
      // A1 and B1 already share 'seaview' across orgs. The failing INSERT
      // aborts the transaction, so it gets its own savepoint to roll back to.
      await db.query('SAVEPOINT dup');
      await assert.rejects(prop(ORG.A, 'Dup', 'harbour'), (e) => e.code === '23505' && e.constraint === 'property_org_slug_key');
      await db.query('ROLLBACK TO SAVEPOINT dup');
    });

    let nameCalls = 0;
    const orgName = async () => { nameCalls++; return 'N'.repeat(150); };
    const staff = (org, requested) => resolveStaffProperty(db, org, requested, orgName);

    await check('staff: several hotels and no header -> 400', async () => {
      err(await staff(ORG.A), 400, STAFF_AMBIGUOUS);
    });
    await check('staff: X-Property-Id (any case) selects within the org', async () => {
      assert.deepEqual(await staff(ORG.A, A2), { propertyId: A2 });
      assert.deepEqual(await staff(ORG.A, A2.toUpperCase()), { propertyId: A2 });
      NF(await staff(ORG.A, B1));
      NF(await staff(ORG.A, A3));
      NF(await staff(ORG.A, 'not-a-uuid'));
    });
    await check('staff: one hotel and no header -> that hotel', async () => {
      assert.deepEqual(await staff(ORG.C), { propertyId: C1 });
      assert.deepEqual(await staff(ORG.C, ''), { propertyId: C1 });
    });
    await check('staff: only inactive hotels -> 403, never auto-creates', async () => {
      nameCalls = 0;
      err(await staff(ORG.D), 403, NO_ACTIVE);
      assert.equal(nameCalls, 0);
      const { n } = await one('SELECT count(*)::int AS n FROM property WHERE clerk_org_id = $1', [ORG.D]);
      assert.equal(n, 1);
    });
    await check('staff: a brand-new org gets exactly one auto-created hotel', async () => {
      nameCalls = 0;
      const orgE = `org_chkE_${run}`;
      const first = await staff(orgE);
      assert.ok(first.propertyId);
      assert.equal(first.createdId, first.propertyId);
      const second = await staff(orgE);
      assert.deepEqual(second, { propertyId: first.propertyId });
      assert.equal(nameCalls, 1);
      const row = await one('SELECT name, status FROM property WHERE id = $1', [first.propertyId]);
      assert.equal(row.name.length, 100);
      assert.equal(row.status, 'active');
    });
    await check('staff: new org + stale X-Property-Id -> 404, but reports the created hotel', async () => {
      const orgG = `org_chkG_${run}`;
      const r = await staff(orgG, B1);
      assert.equal(r.status, 404);
      assert.equal(r.error, 'Property not found');
      assert.ok(r.createdId);
      assert.deepEqual(await staff(orgG), { propertyId: r.createdId });
    });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
