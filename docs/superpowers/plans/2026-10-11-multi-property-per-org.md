# Multi-property per Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Clerk org owns several hotels. Staff pick a hotel with `X-Property-Id`. One website build routes to each hotel with an org API key plus `X-Property-Id` / `X-Property-Slug` / `X-Site-Host`.

**Architecture:** All hotel selection moves into one module, `src/lib/propertyResolver.js`, which provides `hostKey`, `resolveSiteProperty` and `resolveStaffProperty`. Each takes `db`, so the checks can run them inside a rolled-back transaction. `src/middleware/auth.js`, `searchAvailability` and `mcp.js` become thin callers of it. New org-level routes (`/api/organization/*` for staff, `/api/site/*` for the org key) sit on two new middlewares, `authenticateOrg` and `authenticateOrgKey`.

**Tech Stack:** Node.js (CommonJS), Express, `pg`, `@clerk/backend`. Checks are plain `node:assert` scripts under `scripts/`.

**Spec:** `docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md`

**Deviation from spec, file placement only:** The spec puts `hostKey` in `src/lib/siteHost.js` and the resolvers in `auth.js`. This plan puts all three in `src/lib/propertyResolver.js` instead. `auth.js` throws at require time without `CLERK_SECRET_KEY`, and `controllers/availability.js` and the check scripts must not pull in Clerk. The behaviour is unchanged.

## Global Constraints

- No new npm dependencies.
- Error bodies are `{ error: "<message>" }`, using these exact strings:
  - `Property not found` (404)
  - `X-Property-Id is required: this organization has multiple properties` (400, staff)
  - `X-Property-Id, X-Property-Slug or X-Site-Host is required: this organization has multiple properties` (400, org key)
  - `X-Property-Slug is required: this host serves multiple properties` (400, org key)
  - `This organization has no active properties` (403, staff)
  - `This endpoint requires an organization API key` (403)
  - `That slug is already used by another property in this organization` (409)
  - `Missing or invalid Authorization header or X-Api-Key` (401, unchanged)
- Selector precedence for the org key: `X-Property-Id` > `X-Property-Slug` > `X-Site-Host`. A per-property key ignores all three.
- Header values that are absent or `''` count as "not sent".
- `slug` matches `^[a-z0-9-]{1,60}$`, or is `null` to clear it.
- Org keys are `'org_' + crypto.randomBytes(32).toString('hex')`.
- Only properties with `status = 'active'` are selectable, and only active `property_website` rows route.
- Checks run against the **local** DB only. Run every command in Tasks 1-5 in the **Bash tool (Git Bash), not PowerShell**: the plan uses `VAR= cmd`, `/tmp` and `diff <(...)`. Every migration run uses `DATABASE_URL_LIVE= node scripts/run-migration.js …`. In bash that passes an empty-but-set variable, which dotenv leaves alone. **Never translate it to PowerShell's `$env:DATABASE_URL_LIVE=''`**: on Windows that deletes the variable, `run-migration.js`'s `require('dotenv').config()` reloads the live URL from `.env`, and the migration hits live. If a run ever prints `DATABASE_URL_LIVE: ok`, stop and tell the user. **Nothing in Tasks 1-5 touches live.**
- Commit directly on `main`. Stage explicit paths only, never `git add -A`/`.`: the tree holds unrelated uncommitted marina work and stray files. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two simultaneous first logins for a brand-new org** should produce exactly one property, not two followed by a permanent 400. Task 2 pins this with a real two-connection concurrency check.
2. **A website forwarding an unset env var as an empty header** (`X-Property-Slug: ''`) should be treated as "not sent", not as a 404. Task 1 pins this.
3. **An uppercase UUID in `X-Property-Id`** should still match. Task 1 pins it for the org key and Task 2 for staff.
4. **An MCP client on the org key with no selector** should get the clear 400 message, not an opaque tool error, and with a selector its tool calls should land on that hotel. Task 3 pins this over HTTP.
5. **Existing live hotels whose `property.status` is NULL or not `'active'`** would be locked out (403) after deploy, even though nobody archived them. The column defaults to `'active'` and no code writes it, but a manual edit could have. Rollout step R1 counts these on live before anything ships.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/propertyResolver.js` | `hostKey`, `siteSelectors`, `resolveSiteProperty`, `resolveStaffProperty`, error-message constants |
| Create `src/db/migrate-2026-10-11-multi-property-per-org.sql` | `property.slug`, `property_org_slug_key`, `organization` table |
| Create `src/db/migrate-2026-10-11-property-org-not-unique.sql` | Drop `property_clerk_org_id_key` |
| Modify `src/db/schema.sql` | Mirror both migrations |
| Modify `src/middleware/auth.js` | `authenticateOrg`, `authenticate`, `authenticateOrApiKey`, `authenticateOrgKey` as resolver callers |
| Modify `src/controllers/availability.js` | `searchAvailability` key lookup → `resolveSiteProperty` |
| Modify `src/routes/mcp.js` | Forward `X-Property-Id: req.property_id` |
| Modify `src/middleware/validate.js` | `isValidSlug`, `SLUG_TAKEN`, `isSlugConflict` |
| Modify `src/controllers/property.js` | `slug` on GET/PUT `/me` |
| Create `src/controllers/organization.js` | Org properties, org API key, site property list |
| Create `src/routes/organization.js` | `/api/organization/*` on `authenticateOrg` |
| Create `src/routes/site.js` | `/api/site/*` on `authenticateOrgKey` |
| Modify `src/app.js` | Mount the two new routers |
| Modify `src/docs/swagger.js` | New paths, headers, `slug` |
| Create `scripts/check-multi-property.js` | Resolver checks: rolled-back transaction, plus one committed concurrency case |
| Create `scripts/check-multi-property-http.js` | Real app on an ephemeral port; org-key HTTP behaviour and org controllers |

---

### Task 1: Schema, `hostKey`, and website-key resolution

**Files:**
- Create: `src/db/migrate-2026-10-11-multi-property-per-org.sql`
- Modify: `src/db/schema.sql` (property table, around lines 9-83)
- Create: `src/lib/propertyResolver.js`
- Test: `scripts/check-multi-property.js`

**Interfaces:**
- Produces:
  - `hostKey(input: string|null|undefined) → string|null`
  - `siteSelectors(req) → { key, propertyId, slug, host }`, each a `string|undefined`
  - `resolveSiteProperty(db = pool, { key, propertyId, slug, host }) → Promise<null | { propertyId: string, clerkOrgId?: string } | { status: number, error: string }>`
  - Exported constants `PROPERTY_NOT_FOUND`, `STAFF_AMBIGUOUS`, `SITE_AMBIGUOUS`, `HOST_AMBIGUOUS`, `NO_ACTIVE`
  - Table `organization(clerk_org_id PK, api_key UNIQUE, api_key_enabled, created_at)`
  - Column `property.slug`

- [ ] **Step 1: Write the migration**

`src/db/migrate-2026-10-11-multi-property-per-org.sql`:

```sql
-- One-time migration: groundwork for several properties per Clerk org --
-- see docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.
-- Purely additive and safe under the old code. Dropping the UNIQUE on
-- property.clerk_org_id is a separate migration
-- (migrate-2026-10-11-property-org-not-unique.sql) that runs only once the
-- locked auto-create is live.
--
-- Idempotent-safe via IF NOT EXISTS.

-- Path segment a group website routes on (mygroup.com/seaview). Unique
-- within an org; NULL until set. The leading clerk_org_id also serves the
-- org's property lookups.
ALTER TABLE property ADD COLUMN IF NOT EXISTS slug VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS property_org_slug_key ON property(clerk_org_id, slug);

-- Org-level website key: one website build serving every hotel in the org.
-- Org name/members/roles stay in Clerk.
CREATE TABLE IF NOT EXISTS organization (
  clerk_org_id     VARCHAR(255) PRIMARY KEY,
  api_key          TEXT UNIQUE,
  api_key_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);
```

- [ ] **Step 2: Mirror it in `schema.sql`**

In the `CREATE TABLE IF NOT EXISTS property (` block, directly after the `clerk_org_id     VARCHAR(255) UNIQUE,` line, add:

```sql
  slug             VARCHAR(60), -- path segment a group website routes on; unique per org (property_org_slug_key)
```

Directly after the closing `);` of the `property` table (above the `-- Every token_balance change, as a receipt` comment that heads `property_token_ledger`), add:

```sql
-- See migrate-2026-10-11-multi-property-per-org.sql.
CREATE UNIQUE INDEX IF NOT EXISTS property_org_slug_key ON property(clerk_org_id, slug);

-- Org-level website key (one build, every hotel in the org). Name/members/
-- roles stay in Clerk.
CREATE TABLE IF NOT EXISTS organization (
  clerk_org_id     VARCHAR(255) PRIMARY KEY,
  api_key          TEXT UNIQUE,
  api_key_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);
```

- [ ] **Step 3: Apply it locally only**

Run (Bash tool): `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-10-11-multi-property-per-org.sql`
Expected:
```
DATABASE_URL: ok
DATABASE_URL_LIVE: not set, skipped
```

- [ ] **Step 4: Write the failing check**

`scripts/check-multi-property.js`:

```js
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
  hostKey, resolveSiteProperty,
  SITE_AMBIGUOUS, HOST_AMBIGUOUS,
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

  // ---- Task 2: concurrent auto-create goes here (before BEGIN) ----

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

    // ---- Task 2: staff resolution checks go here ----
  } finally {
    await db.query('ROLLBACK');
    await db.end();
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 5: Run it to verify it fails**

Run: `node -r dotenv/config scripts/check-multi-property.js`
Expected: crash with `Cannot find module '../src/lib/propertyResolver'`.

- [ ] **Step 6: Write `src/lib/propertyResolver.js`**

```js
const pool = require('../db');

// Turns the hotel selectors a caller sends into one property_id. Staff
// (Clerk org) and website keys (per-property or org-level) both land here --
// see docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.
// Every function takes `db` (default pool) so
// scripts/check-multi-property.js can run it inside a rolled-back transaction.

const PROPERTY_NOT_FOUND = 'Property not found';
const STAFF_AMBIGUOUS = 'X-Property-Id is required: this organization has multiple properties';
const SITE_AMBIGUOUS = 'X-Property-Id, X-Property-Slug or X-Site-Host is required: this organization has multiple properties';
const HOST_AMBIGUOUS = 'X-Property-Slug is required: this host serves multiple properties';
const NO_ACTIVE = 'This organization has no active properties';

const notFound = () => ({ status: 404, error: PROPERTY_NOT_FOUND });

// Bare host ("Seaview-Hotel.com:443") or full URL -> "seaview-hotel.com".
// URL does lowercasing, punycode, and drops port/userinfo/path/query. The
// only host normaliser -- property_website.url and X-Site-Host both go
// through it, so the two sides can't drift.
function hostKey(input) {
  if (!input) return null;
  try {
    const s = String(input).trim();
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/\.$/, '').replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

// Absent and '' both mean "not sent" -- a website forwarding an unset env
// var shouldn't turn into a 404.
const given = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));

function siteSelectors(req) {
  return {
    key: req.headers['x-api-key'],
    propertyId: req.headers['x-property-id'],
    slug: req.headers['x-property-slug'],
    host: req.headers['x-site-host'],
  };
}

// X-Api-Key -> property. A per-property key is its hotel, full stop (routing
// headers ignored). An org key picks among the org's active hotels:
// X-Property-Id > X-Property-Slug > X-Site-Host > "the only one". null means
// the key matched nothing (caller's 401).
async function resolveSiteProperty(db = pool, sel = {}) {
  const key = given(sel.key);
  const propertyId = given(sel.propertyId);
  const slug = given(sel.slug);
  const host = given(sel.host);
  if (!key) return null;

  const own = await db.query('SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true', [key]);
  if (own.rows.length) return { propertyId: own.rows[0].id };

  const org = await db.query('SELECT clerk_org_id FROM organization WHERE api_key = $1 AND api_key_enabled = true', [key]);
  if (!org.rows.length) return null;
  const clerkOrgId = org.rows[0].clerk_org_id;

  const { rows: props } = await db.query(
    "SELECT id, slug FROM property WHERE clerk_org_id = $1 AND status = 'active'",
    [clerkOrgId]
  );
  const pick = (id) => (id ? { propertyId: id, clerkOrgId } : notFound());

  if (propertyId) return pick(props.find((p) => p.id === propertyId.toLowerCase())?.id);
  if (slug) return pick(props.find((p) => p.slug === slug)?.id);
  if (host) {
    const want = hostKey(host);
    if (!want || !props.length) return notFound();
    const { rows: sites } = await db.query(
      "SELECT property_id, url FROM property_website WHERE property_id = ANY($1::uuid[]) AND status = 'active'",
      [props.map((p) => p.id)]
    );
    const ids = [...new Set(sites.filter((s) => hostKey(s.url) === want).map((s) => s.property_id))];
    // A group domain (mygroup.com/seaview, /harbour) legitimately serves
    // several hotels; the slug picks between them.
    if (ids.length > 1) return { status: 400, error: HOST_AMBIGUOUS };
    return pick(ids[0]);
  }
  if (props.length === 1) return pick(props[0].id);
  return props.length ? { status: 400, error: SITE_AMBIGUOUS } : notFound();
}

module.exports = {
  PROPERTY_NOT_FOUND, STAFF_AMBIGUOUS, SITE_AMBIGUOUS, HOST_AMBIGUOUS, NO_ACTIVE,
  hostKey, siteSelectors, resolveSiteProperty,
};
```

- [ ] **Step 7: Run it to verify it passes**

Run: `node -r dotenv/config scripts/check-multi-property.js`
Expected: every line `ok`, ending in `all passed`.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrate-2026-10-11-multi-property-per-org.sql src/db/schema.sql src/lib/propertyResolver.js scripts/check-multi-property.js
git commit -m "Multi-property: property.slug, organization key table, website-key resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Staff resolution with locked auto-create, and dropping the UNIQUE

**Files:**
- Modify: `src/lib/propertyResolver.js`
- Create: `src/db/migrate-2026-10-11-property-org-not-unique.sql`
- Modify: `src/db/schema.sql:13`
- Test: `scripts/check-multi-property.js`

**Interfaces:**
- Consumes: `PROPERTY_NOT_FOUND`, `STAFF_AMBIGUOUS`, `NO_ACTIVE` from Task 1
- Produces: `resolveStaffProperty(db = pool, orgId: string, requestedId: string|undefined, fetchOrgName: () => Promise<string>) → Promise<{ propertyId: string, createdId?: string } | { status: number, error: string, createdId?: string }>`. `fetchOrgName` is called only when the org has no property rows at all. `createdId` is present **only** when this call inserted the org's first hotel, **including on an error result**: a brand-new org whose first request carries a stale `X-Property-Id` still gets its 404, but the hotel was created. The caller runs `grantStarter(createdId)` whenever `createdId` is present, before acting on the error.

- [ ] **Step 1: Add the failing checks**

In `scripts/check-multi-property.js`, change the import to:

```js
const {
  hostKey, resolveSiteProperty, resolveStaffProperty,
  SITE_AMBIGUOUS, HOST_AMBIGUOUS, STAFF_AMBIGUOUS, NO_ACTIVE,
} = require('../src/lib/propertyResolver');
```

Replace the line `  // ---- Task 2: concurrent auto-create goes here (before BEGIN) ----` with:

```js
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
```

Replace the line `    // ---- Task 2: staff resolution checks go here ----` with:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node -r dotenv/config scripts/check-multi-property.js`
Expected: `FAIL concurrent first requests…` with `TypeError: resolveStaffProperty is not a function`, and `FAIL` on every `staff:` check. The Task 1 checks still pass.

- [ ] **Step 3: Implement `resolveStaffProperty`**

In `src/lib/propertyResolver.js`, add the following above `module.exports`:

```js
// Clerk org -> property. X-Property-Id when the org has several hotels,
// implied when it has one. An org with no property rows at all gets one
// auto-created under an advisory lock: since property.clerk_org_id stopped
// being UNIQUE, nothing else stops two concurrent first requests creating
// two hotels (and a permanent 400). An org whose rows are all inactive gets
// a 403, never a fresh hotel. `createdId` rides on the result -- errors
// included -- only when this call inserted the hotel, so the caller can
// grant starter tokens exactly once (outside any transaction this may run in).
async function resolveStaffProperty(db = pool, orgId, requestedId, fetchOrgName) {
  const select = (q) => q.query('SELECT id, status FROM property WHERE clerk_org_id = $1', [orgId]);
  let { rows } = await select(db);
  let made = {};

  if (!rows.length) {
    const name = String(await fetchOrgName()).slice(0, 100); // network call stays outside the lock
    // On the pool, take a dedicated client for our own transaction. Handed a
    // client (the check script's), it's already in one -- just lock in it.
    const owns = db === pool;
    const client = owns ? await pool.connect() : db;
    try {
      if (owns) await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('property-autocreate:' || $1))", [orgId]);
      ({ rows } = await select(client));
      if (!rows.length) {
        ({ rows } = await client.query(
          'INSERT INTO property (name, clerk_org_id) VALUES ($1, $2) RETURNING id, status',
          [name, orgId]
        ));
        made = { createdId: rows[0].id };
      }
      if (owns) await client.query('COMMIT');
    } catch (err) {
      if (owns) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (owns) client.release();
    }
  }

  const active = rows.filter((r) => r.status === 'active');
  if (!active.length) return { status: 403, error: NO_ACTIVE, ...made };
  const wanted = given(requestedId);
  if (wanted) {
    const id = wanted.toLowerCase();
    return active.some((r) => r.id === id) ? { propertyId: id, ...made } : { ...notFound(), ...made };
  }
  if (active.length === 1) return { propertyId: active[0].id, ...made };
  return { status: 400, error: STAFF_AMBIGUOUS, ...made };
}
```

Add `resolveStaffProperty` to `module.exports`.

- [ ] **Step 4: Run it to verify it passes**

Run: `node -r dotenv/config scripts/check-multi-property.js`
Expected: every line `ok`, including both concurrent lines, ending in `all passed`.

- [ ] **Step 5: Write migration 2 and mirror it**

`src/db/migrate-2026-10-11-property-org-not-unique.sql`:

```sql
-- One-time migration: a Clerk org may own several properties -- see
-- docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.
-- Run ONLY after the code with the locked auto-create
-- (src/lib/propertyResolver.js resolveStaffProperty) is live: until then
-- this UNIQUE is what stops two concurrent first requests creating two
-- properties for one org. property_org_slug_key (clerk_org_id, slug) keeps
-- the org's lookups indexed.
--
-- Idempotent-safe via IF EXISTS.

ALTER TABLE property DROP CONSTRAINT IF EXISTS property_clerk_org_id_key;
```

In `src/db/schema.sql`, replace

```sql
  clerk_org_id     VARCHAR(255) UNIQUE,
```

with

```sql
  clerk_org_id     VARCHAR(255), -- several properties per org; see migrate-2026-10-11-property-org-not-unique.sql
```

- [ ] **Step 6: Apply migration 2 locally only**

The HTTP checks in Tasks 3-4 need two hotels in one org.

Run (Bash tool): `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-10-11-property-org-not-unique.sql`
Expected: `DATABASE_URL: ok`, `DATABASE_URL_LIVE: not set, skipped`.

Re-run `node -r dotenv/config scripts/check-multi-property.js`. Expected: `all passed`. The concurrent case now runs with no UNIQUE constraint behind it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/propertyResolver.js src/db/migrate-2026-10-11-property-org-not-unique.sql src/db/schema.sql scripts/check-multi-property.js
git commit -m "Multi-property: staff resolution with locked auto-create; migration dropping UNIQUE(clerk_org_id)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire auth, availability search and MCP to the resolver

**Files:**
- Modify: `src/middleware/auth.js` (whole file)
- Modify: `src/controllers/availability.js:1-2,68-72`
- Modify: `src/routes/mcp.js:10-12`
- Test: `scripts/check-multi-property-http.js`

**Interfaces:**
- Consumes: `resolveStaffProperty`, `resolveSiteProperty`, `siteSelectors` (Tasks 1-2)
- Produces (from `auth.js`): `authenticateOrg` (sets `req.clerk_org_id`, `req.user`, `req.auth_method = 'bearer'`, with no property), `authenticateOrgKey` (sets `req.clerk_org_id`, `req.auth_method = 'api_key'`, with no property), plus the unchanged names `authenticate`, `authenticateOrApiKey`, `requireRole`, `requireRoleOrApiKey`. On the org key, `authenticateOrApiKey` also sets `req.clerk_org_id`.

- [ ] **Step 1: Write the failing HTTP check**

`scripts/check-multi-property-http.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node -r dotenv/config scripts/check-multi-property-http.js`
Expected: `FAIL` on every org-key case (the old `authenticateOrApiKey` returns 401 for an `org_` key) and on the MCP case. The two per-property/unknown-key fallback cases pass.

Also capture a key-rail regression baseline before touching auth: `node -r dotenv/config scripts/check-marina-http.js > /tmp/marina-before.txt 2>&1; tail -1 /tmp/marina-before.txt`. Note the last line (`all passed` or `N FAILED`).

- [ ] **Step 3: Rewrite `src/middleware/auth.js`**

```js
const { createClerkClient, verifyToken } = require('@clerk/backend');
const pool = require('../db');
const { apiKeyRateLimiter } = require('./rateLimiter');
const { grantStarter } = require('../lib/tokens');
const { resolveStaffProperty, resolveSiteProperty, siteSelectors } = require('../lib/propertyResolver');

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY is required');
}

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const BAD_KEY = 'Missing or invalid Authorization header or X-Api-Key';

function mapClerkRole(orgRole) {
  return orgRole === 'admin' ? 'admin' : 'staff';
}

// Clerk bearer -> org + user, no property. For routes that span the org's
// hotels (listing/creating them, the org API key).
async function authenticateOrg(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);

  let claims;
  try {
    claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
  } catch (err) {
    console.error('Clerk token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Clerk's v2 session tokens nest active-organization info under a short
  // `o` claim ({ id, rol, slg }), not flat org_id/org_role claims -- this
  // is confirmed against this project's real Clerk instance, not assumed.
  const orgId = claims.o?.id;
  if (!orgId) {
    return res.status(401).json({ error: 'An organization context is required' });
  }

  req.clerk_org_id = orgId;
  req.user = { id: claims.sub, role: mapClerkRole(claims.o.rol) };
  req.auth_method = 'bearer'; // staff rail -- bypasses session join codes
  next();
}

// authenticateOrg + the hotel: X-Property-Id when the org has several,
// implied when it has one, auto-created (under a lock) when it has none.
function authenticate(req, res, next) {
  authenticateOrg(req, res, async () => {
    try {
      const orgId = req.clerk_org_id;
      const r = await resolveStaffProperty(pool, orgId, req.headers['x-property-id'], async () =>
        (await clerkClient.organizations.getOrganization({ organizationId: orgId })).name);
      // Free starter tokens so the metered features work before anyone is
      // asked for a card -- before the error check, since a brand-new org's
      // first request can create its hotel and still 404 on a stale
      // X-Property-Id. Not fatal: a failed grant just means zero balance.
      if (r.createdId) {
        await grantStarter(r.createdId).catch((err) => console.error(`Starter token grant failed for property ${r.createdId}:`, err.message));
      }
      if (r.error) return res.status(r.status).json({ error: r.error });
      req.property_id = r.propertyId;
      next();
    } catch (err) {
      next(err);
    }
  });
}

// Bearer -> authenticate. X-Api-Key -> a per-property key's own hotel, or an
// org key + X-Property-Id / X-Property-Slug / X-Site-Host (see
// lib/propertyResolver.js).
async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  if (!req.headers['x-api-key']) {
    return res.status(401).json({ error: BAD_KEY });
  }

  return apiKeyRateLimiter(req, res, async () => {
    try {
      const r = await resolveSiteProperty(pool, siteSelectors(req));
      if (!r) return res.status(401).json({ error: BAD_KEY });
      if (r.error) return res.status(r.status).json({ error: r.error });
      req.property_id = r.propertyId;
      if (r.clerkOrgId) req.clerk_org_id = r.clerkOrgId;
      req.auth_method = 'api_key'; // untrusted guest-proxy rail -- join codes enforced
      next();
    } catch (err) {
      next(err);
    }
  });
}

// Org API key only, no property: /api/site/* (the group website's hotel
// list). A per-property key is told why it isn't enough.
async function authenticateOrgKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: BAD_KEY });

  return apiKeyRateLimiter(req, res, async () => {
    try {
      const org = await pool.query('SELECT clerk_org_id FROM organization WHERE api_key = $1 AND api_key_enabled = true', [key]);
      if (org.rows.length) {
        req.clerk_org_id = org.rows[0].clerk_org_id;
        req.auth_method = 'api_key';
        return next();
      }
      const prop = await pool.query('SELECT 1 FROM property WHERE api_key = $1 AND api_key_enabled = true', [key]);
      if (prop.rows.length) return res.status(403).json({ error: 'This endpoint requires an organization API key' });
      return res.status(401).json({ error: BAD_KEY });
    } catch (err) {
      next(err);
    }
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Same role gate, but an api-key caller passes it: the key is already
// property-scoped and every other property-wide write it can reach (PUT
// /api/property/me -- currency, timezone, tax, enabled_modules) trusts it
// the same way. Use this instead of requireRole on a route that has been
// widened to authenticateOrApiKey, so staff sessions keep the role rule
// they had rather than silently losing it.
function requireRoleOrApiKey(...roles) {
  const guard = requireRole(...roles);
  return (req, res, next) => {
    if (req.auth_method === 'api_key') return next();
    return guard(req, res, next);
  };
}

module.exports = { authenticate, authenticateOrg, authenticateOrApiKey, authenticateOrgKey, requireRole, requireRoleOrApiKey };
```

- [ ] **Step 4: Route `searchAvailability` through the resolver**

In `src/controllers/availability.js`, after `const { isValidDate, isValidUuid } = require('../middleware/validate');` add:

```js
const { resolveSiteProperty, siteSelectors } = require('../lib/propertyResolver');
```

Replace:

```js
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true', [apiKey]);
      if (rows.length) property_id = rows[0].id;
    }
```

with:

```js
    // A key picks the hotel (a per-property key, or an org key +
    // X-Property-Id / X-Property-Slug / X-Site-Host); a key that matches
    // nothing falls back to the public ?property_id= as before.
    if (req.headers['x-api-key']) {
      const site = await resolveSiteProperty(pool, siteSelectors(req));
      if (site?.error) return res.status(site.status).json({ error: site.error });
      if (site) property_id = site.propertyId;
    }
```

- [ ] **Step 5: Forward the resolved hotel from MCP**

In `src/routes/mcp.js`, after `if (req.headers.authorization) forwardHeaders['Authorization'] = req.headers.authorization;` add:

```js
    // The hotel the outer request resolved to, so a multi-hotel org's tool
    // calls land on the same one (a per-property key ignores it).
    forwardHeaders['X-Property-Id'] = req.property_id;
```

- [ ] **Step 6: Run both checks to verify they pass**

Run: `node -r dotenv/config scripts/check-multi-property-http.js`
Expected: every line `ok`, ending in `all passed`.

Run: `node -r dotenv/config scripts/check-multi-property.js`
Expected: `all passed`.

Key-rail regression: `node -r dotenv/config scripts/check-marina-http.js > /tmp/marina-after.txt 2>&1; diff <(grep -E '^(ok|FAIL)' /tmp/marina-before.txt) <(grep -E '^(ok|FAIL)' /tmp/marina-after.txt)`
Expected: no diff. Any `ok` that became `FAIL` is a regression from this task.

- [ ] **Step 7: Commit**

```bash
git add src/middleware/auth.js src/controllers/availability.js src/routes/mcp.js scripts/check-multi-property-http.js
git commit -m "Multi-property: auth, availability search and MCP resolve the hotel through propertyResolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Slug on `/me`, organization routes, site route

**Files:**
- Modify: `src/middleware/validate.js`
- Modify: `src/controllers/property.js` (`getCurrentProperty`, `updateCurrentProperty`)
- Create: `src/controllers/organization.js`
- Create: `src/routes/organization.js`
- Create: `src/routes/site.js`
- Modify: `src/app.js` (requires near line 25, mounts near line 80)
- Test: `scripts/check-multi-property-http.js`

**Interfaces:**
- Consumes: `authenticateOrg`, `authenticateOrgKey`, `requireRole` (Task 3); `grantStarter(propertyId)` from `src/lib/tokens.js`
- Produces:
  - `isValidSlug(str) → boolean`, `SLUG_TAKEN: string`, `isSlugConflict(err) → boolean` (from `validate.js`)
  - The organization controller exports `listProperties`, `createProperty`, `getApiKey`, `rotateApiKey`, `disableApiKey`, `enableApiKey` and `listSiteProperties`. Each is `(req, res, next)` and reads `req.clerk_org_id`.

- [ ] **Step 1: Add the failing checks**

In `scripts/check-multi-property-http.js`, add after `const { SITE_AMBIGUOUS } = require('../src/lib/propertyResolver');`:

```js
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
```

Replace the line `    // ---- Task 4 ----` with:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node -r dotenv/config scripts/check-multi-property-http.js`
Expected: crash with `Cannot find module '../src/controllers/organization'`.

- [ ] **Step 3: Slug helpers in `src/middleware/validate.js`**

Add above `module.exports`:

```js
// property.slug -- the path segment a group website routes on (/seaview).
// Unique per org (property_org_slug_key).
function isValidSlug(str) {
  return typeof str === 'string' && /^[a-z0-9-]{1,60}$/.test(str);
}
const SLUG_TAKEN = 'That slug is already used by another property in this organization';
function isSlugConflict(err) {
  return err?.code === '23505' && err.constraint === 'property_org_slug_key';
}
```

Add `isValidSlug, SLUG_TAKEN, isSlugConflict` to its `module.exports` object.

- [ ] **Step 4: `slug` on GET/PUT `/api/property/me`**

In `src/controllers/property.js`:

Change the validate import to also pull `isValidSlug, SLUG_TAKEN, isSlugConflict`:

```js
const { isValidCurrencyCode, isValidTimezone, isValidUrl, isValidDate, isValidUuid, validateBranding, validateCancelUrl, isValidSlug, SLUG_TAKEN, isSlugConflict } = require('../middleware/validate');
```

In `getCurrentProperty`, change the selected columns from `'SELECT id, clerk_org_id, name, currency, …'` to start `'SELECT id, clerk_org_id, name, slug, currency, …'` and leave the rest of the list as-is.

In `updateCurrentProperty`:
- Change the destructure to `const { currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions, enabled_modules, sidon_marina_id, slug } = req.body;`
- After the `sidon_marina_id` validation block, add:

```js
    // Path segment a group website routes on; null clears it.
    if (slug !== undefined && slug !== null && !isValidSlug(slug)) {
      return res.status(400).json({ error: 'slug must be 1-60 lowercase letters, digits or hyphens, or null' });
    }
```

- In the UPDATE, after the `sidon_marina_key = …` line, add a comma and the line:

```sql
         slug                = CASE WHEN $15::boolean THEN $14::text ELSE slug END
```

  so the previous line becomes `… ELSE sidon_marina_key END,`
- In `RETURNING`, add `slug` after `name`: `RETURNING id, name, slug, currency, …`
- Append `slug ?? null, slug !== undefined` to the params array, after `sidon_marina_id ?? null, sidon_marina_id !== undefined`.
- Replace the `catch (err) { next(err); }` of this function with:

```js
  } catch (err) {
    if (isSlugConflict(err)) return res.status(409).json({ error: SLUG_TAKEN });
    next(err);
  }
```

- [ ] **Step 5: `src/controllers/organization.js`**

```js
const crypto = require('crypto');
const pool = require('../db');
const { grantStarter } = require('../lib/tokens');
const { isValidSlug, SLUG_TAKEN, isSlugConflict } = require('../middleware/validate');

// Org-level routes: req.clerk_org_id comes from authenticateOrg (staff) or
// authenticateOrgKey (website) -- no req.property_id here. See
// docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.

function generateOrgApiKey() {
  return 'org_' + crypto.randomBytes(32).toString('hex');
}

async function listProperties(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, slug, status FROM property WHERE clerk_org_id = $1 ORDER BY name',
      [req.clerk_org_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createProperty(req, res, next) {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'name is required (at most 100 characters)' });
    const slug = req.body.slug ?? null;
    if (slug !== null && !isValidSlug(slug)) {
      return res.status(400).json({ error: 'slug must be 1-60 lowercase letters, digits or hyphens, or null' });
    }
    const { rows } = await pool.query(
      `INSERT INTO property (name, clerk_org_id, slug) VALUES ($1, $2, $3)
       RETURNING id, name, slug, status, currency, timezone`,
      [name, req.clerk_org_id, slug]
    );
    // Same starter grant a first-login hotel gets. Not fatal.
    await grantStarter(rows[0].id).catch((err) => console.error(`Starter token grant failed for property ${rows[0].id}:`, err.message));
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isSlugConflict(err)) return res.status(409).json({ error: SLUG_TAKEN });
    next(err);
  }
}

// The organization row exists only for its key; every key route creates it
// on demand so none depends on call order.
async function ensureOrg(orgId) {
  await pool.query(
    'INSERT INTO organization (clerk_org_id, api_key) VALUES ($1, $2) ON CONFLICT (clerk_org_id) DO NOTHING',
    [orgId, generateOrgApiKey()]
  );
}

async function getApiKey(req, res, next) {
  try {
    await ensureOrg(req.clerk_org_id);
    const { rows } = await pool.query('SELECT api_key, api_key_enabled FROM organization WHERE clerk_org_id = $1', [req.clerk_org_id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function rotateApiKey(req, res, next) {
  try {
    await ensureOrg(req.clerk_org_id);
    const { rows } = await pool.query(
      'UPDATE organization SET api_key = $1 WHERE clerk_org_id = $2 RETURNING api_key',
      [generateOrgApiKey(), req.clerk_org_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function setApiKeyEnabled(req, res, next, enabled) {
  try {
    await ensureOrg(req.clerk_org_id);
    const { rows } = await pool.query(
      'UPDATE organization SET api_key_enabled = $1 WHERE clerk_org_id = $2 RETURNING api_key, api_key_enabled',
      [enabled, req.clerk_org_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}
const disableApiKey = (req, res, next) => setApiKeyEnabled(req, res, next, false);
const enableApiKey = (req, res, next) => setApiKeyEnabled(req, res, next, true);

// The group website's hotel list. Public-safe fields only -- no keys,
// Stripe, Vercel or Sidon columns.
async function listSiteProperties(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.slug, p.currency, p.timezone,
              COALESCE(array_agg(w.url ORDER BY w.created_at) FILTER (WHERE w.id IS NOT NULL), '{}') AS websites
       FROM property p
       LEFT JOIN property_website w ON w.property_id = p.id AND w.status = 'active'
       WHERE p.clerk_org_id = $1 AND p.status = 'active'
       GROUP BY p.id
       ORDER BY p.name`,
      [req.clerk_org_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { listProperties, createProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey, listSiteProperties };
```

- [ ] **Step 6: Routes and mounting**

`src/routes/organization.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/organization');
const { authenticateOrg, requireRole } = require('../middleware/auth');

// Staff routes spanning the org's hotels -- no X-Property-Id needed.
router.get('/properties', authenticateOrg, ctrl.listProperties);
router.post('/properties', authenticateOrg, requireRole('admin'), ctrl.createProperty);

router.get('/api-key', authenticateOrg, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticateOrg, requireRole('admin'), ctrl.rotateApiKey);
router.post('/api-key/disable', authenticateOrg, requireRole('admin'), ctrl.disableApiKey);
router.post('/api-key/enable', authenticateOrg, requireRole('admin'), ctrl.enableApiKey);

module.exports = router;
```

`src/routes/site.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/organization');
const { authenticateOrgKey } = require('../middleware/auth');

// The org's website build (org API key only).
router.get('/properties', authenticateOrgKey, ctrl.listSiteProperties);

module.exports = router;
```

In `src/app.js`, next to `const propertyRoutes = require('./routes/property');` add:

```js
const organizationRoutes = require('./routes/organization');
const siteRoutes = require('./routes/site');
```

After `app.use('/api/property', propertyRoutes);` add:

```js
app.use('/api/organization', organizationRoutes);
app.use('/api/site', siteRoutes);
```

- [ ] **Step 7: Run both checks to verify they pass**

Run: `node -r dotenv/config scripts/check-multi-property-http.js`
Expected: every line `ok`, ending in `all passed`.

Run: `node -r dotenv/config scripts/check-multi-property.js`
Expected: `all passed`.

- [ ] **Step 8: Commit**

```bash
git add src/middleware/validate.js src/controllers/property.js src/controllers/organization.js src/routes/organization.js src/routes/site.js src/app.js scripts/check-multi-property-http.js
git commit -m "Multi-property: slug on /me, /api/organization properties and key, /api/site/properties

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Swagger

**Files:**
- Modify: `src/docs/swagger.js` (tags ~line 14, `components.securitySchemes` ~line 38, `/api/property/me` ~line 178, the paths list)

**Interfaces:**
- Consumes: the routes from Tasks 3-4

- [ ] **Step 1: Add the `Organization` tag**

In `tags`, after `{ name: 'Property' },` add `{ name: 'Organization' },`.

- [ ] **Step 2: Describe the selectors on the existing schemes**

Append the following sentence to the `bearerAuth.description` string:

```
 If the organization has several properties, send X-Property-Id to pick one (required then; optional with a single property).
```

Change `apiKeyAuth` to carry a `description` (keep its existing fields):

```js
        description: 'A per-property key (prop_...) selects its own property. An organization key (org_...) selects among the org\'s properties with X-Property-Id, X-Property-Slug or X-Site-Host (that precedence); optional when the org has one property.',
```

- [ ] **Step 3: `slug` on `/api/property/me`**

In the `get` 200 schema `properties`, after `name: { type: 'string' },` add:

```js
slug: { type: 'string', nullable: true, description: 'Path segment a group website routes on (X-Property-Slug)' },
```

In the `put` request body `properties`, add:

```js
slug: { type: 'string', nullable: true, pattern: '^[a-z0-9-]{1,60}$', description: 'Unique within the organization; null clears it' },
```

and add `409: { description: 'slug already used by another property in this organization' }` to its `responses`.

- [ ] **Step 4: New paths**

Directly after the `'/api/property/api-key/enable'` entry, add:

```js
    // ── Organization (several properties per Clerk org) ─────────────────────
    '/api/organization/properties': {
      get: { tags: ['Organization'], summary: "List the organization's properties (no X-Property-Id needed)", security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of { id, name, slug, status }' } } },
      post: { tags: ['Organization'], summary: 'Create another property in the organization (admin only); grants starter tokens', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 100 }, slug: { type: 'string', nullable: true, pattern: '^[a-z0-9-]{1,60}$' } } } } } }, responses: { 201: { description: '{ id, name, slug, status, currency, timezone }' }, 400: { description: 'Invalid name or slug' }, 403: { description: 'Insufficient permissions' }, 409: { description: 'slug already used in this organization' } } },
    },
    '/api/organization/api-key': {
      get: { tags: ['Organization'], summary: "Get the organization's website API key (admin only) -- created on first call", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ api_key, api_key_enabled }' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/organization/api-key/rotate': {
      post: { tags: ['Organization'], summary: "Rotate the organization's API key (admin only) -- the old key stops working immediately", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ api_key }' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/organization/api-key/disable': {
      post: { tags: ['Organization'], summary: "Disable the organization's API key without rotating it (admin only)", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ api_key, api_key_enabled: false }' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/organization/api-key/enable': {
      post: { tags: ['Organization'], summary: "Re-enable the organization's API key (admin only)", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ api_key, api_key_enabled: true }' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/site/properties': {
      get: { tags: ['Organization'], summary: "The organization's active properties for a group website (organization API key only)", security: [{ apiKeyAuth: [] }], responses: { 200: { description: 'Array of { id, name, slug, currency, timezone, websites: [url] }' }, 401: { description: 'Missing or invalid key' }, 403: { description: 'A per-property key was used' } } },
    },
```

- [ ] **Step 5: Verify the spec still loads and serves**

Run: `node -e "const s=require('./src/docs/swagger');console.log(Object.keys(s.paths).filter(p=>/organization|site\//.test(p)))"`
Expected: the six new paths are printed (`swagger.js` exports the spec object directly, `module.exports = swaggerSpec`).

Run: `node -r dotenv/config scripts/check-multi-property-http.js`
Expected: `all passed`.

- [ ] **Step 6: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Multi-property: Swagger for organization/site routes, selectors and slug

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rollout (live, outside the tasks: STOP and get the user's go-ahead before each step)

Pushing `main` also ships the **unpushed marina commits** already on it (spec'd for a dark deploy). Raise that with the user before step R3.

- **R1. Pre-flight on live:**

  ```sql
  SELECT conname FROM pg_constraint WHERE conrelid = 'property'::regclass AND contype = 'u';  -- expect property_clerk_org_id_key
  SELECT count(*) FROM property WHERE status IS DISTINCT FROM 'active';                       -- Review Focus 5: expect 0
  ```

  If the count is non-zero, list those rows and ask the user before going on. Any NULL or non-`active` hotel would get a 403 after deploy.
- **R2.** Run `node scripts/run-migration.js src/db/migrate-2026-10-11-multi-property-per-org.sql` (local + live). This is additive and safe under the old code.
- **R3.** Deploy the OTA code (push `main`).
- **R4.** Run `node scripts/run-migration.js src/db/migrate-2026-10-11-property-org-not-unique.sql` (local + live), only once R3 is serving.
- **R5/R6 (other repos):** dashboard hotel switcher + `X-Property-Id`; website build on the org key + `X-Site-Host` / `X-Property-Slug`.
