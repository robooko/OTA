# Permissions for users and API keys — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named permissions that a route can require, granted to staff per property and carried by API keys, with several named keys per property and per org, and nothing anyone holds today getting narrower.

**Architecture:** One vocabulary (`src/lib/permissions.js`) and one middleware (`requirePermission`) serve both rails. Keys move from two columns to an `api_key` table (existing values copied in as full keys named `Default`); the legacy columns stay until a later cleanup so the migrate-then-push window can't break live traffic. Staff grants are a `(property_id, clerk_user_id) -> text[]` table, managed by admins through two endpoints and surfaced on `/api/auth/me`.

**Tech Stack:** Node (Express), pg, `@clerk/backend` 3.16 (`clerkClient.organizations.getOrganizationMembershipList`), `node:assert/strict` check scripts in `scripts/` against the local Postgres (`DATABASE_URL` in `.env`).

**Spec:** `docs/superpowers/specs/2026-10-31-permissions-design.md`

## Global constraints

- Permission names are lowercase dotted `<module>.<action>`; known names: `housekeeping.inspect`, `housekeeping.manage`. Unknown names on a grant or key → 400.
- Refusals are exactly `403 { error: 'Missing permission', permission: name }` and `403 { error: 'This key is scoped; this route needs a full key or a named permission' }`.
- `api_key.permissions IS NULL` means full key. `[]` is a scoped key that lists nothing.
- The key name `Default` is reserved for the legacy endpoints' row; `POST` with that name → 400.
- Key values: property `prop_` + 64 hex, org `org_` + 64 hex (as today).
- Legacy columns `property.api_key`, `property.api_key_enabled`, `organization.api_key`, `organization.api_key_enabled` stay; no new code reads or writes them.
- Live migration runs on production **before** `git push` (main auto-deploys). Ask Robert for the OK first.
- Commit directly on `main` after each task (Robert's preference). No subagents for implementation.

## Review focus

Inputs the spec implies but doesn't spell out; each has its test pinned to the owning task.

1. A disabled key, property or org, is a 401 on the site rail, not a key with no permissions. (Task 2)
2. A key with `permissions: []` is scoped: it fails `requirePermission` and `requireRoleOrApiKey`; only `NULL` is full. (Task 2)
3. A grant at property A says nothing at property B of the same org. (Task 2)
4. Re-running the migration after a key rotation must not resurrect the stale legacy value as a second `Default` row. (Task 1)
5. `permissions` in a body that isn't an array of strings, or a `name` that is blank or over 100 chars, is a 400, not a 500. (Task 3)

---

### Task 1: Data layer — tables, migration, permission vocabulary, key helpers

**Files:**
- Create: `src/db/migrate-2026-10-31-permissions.sql`
- Modify: `src/db/schema.sql` (after the `organization` table, ~line 126; deprecate comments on lines 15–16 and 102–103)
- Create: `src/lib/permissions.js`
- Create: `src/lib/apiKeys.js`
- Create: `scripts/check-permissions.js`

**Interfaces:**
- Produces `src/lib/permissions.js`:
  - `PERMISSIONS: string[]` — `['housekeeping.inspect', 'housekeeping.manage']`
  - `unknownPermissions(list: unknown): string[] | null` — `null` when `list` is not an array of strings; otherwise the entries not in `PERMISSIONS` (empty array = all valid)
  - `getGrant(db, propertyId, clerkUserId): Promise<string[]>` — `[]` when no row
  - `setGrant(db, propertyId, clerkUserId, permissions, updatedBy): Promise<row>` — upsert, returns the row
- Produces `src/lib/apiKeys.js` (owner is `{ property_id }` or `{ clerk_org_id }`):
  - `generateKey(owner): string`
  - `create(db, owner, { name = 'Default', permissions = null, enabled = true, created_by = null, key = generateKey(owner) }): Promise<row>` — for an org owner, first `INSERT INTO organization (clerk_org_id) ... ON CONFLICT DO NOTHING`
  - `findByKey(db, key): Promise<row | null>` — enabled rows only; row has `id, property_id, clerk_org_id, permissions`
  - `ensureDefault(db, owner): Promise<row>` — the row named `Default`, created full and enabled if missing
  - `list(db, owner): Promise<row[]>` — oldest first
  - `update(db, owner, id, { name?, permissions?, enabled?, key? }): Promise<row | null>` — `null` when no row for that owner
  - `remove(db, owner, id): Promise<boolean>`
  - Row shape everywhere: `{ id, property_id, clerk_org_id, name, key, permissions, enabled, created_at, created_by }`

- [ ] **Step 1: Write the migration** `src/db/migrate-2026-10-31-permissions.sql`, idempotent, header comment in the style of `migrate-2026-10-31-website-competitors.sql`:

```sql
CREATE TABLE IF NOT EXISTS api_key (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID REFERENCES property(id) ON DELETE CASCADE,
  clerk_org_id  VARCHAR(255) REFERENCES organization(clerk_org_id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL DEFAULT 'Default',
  key           TEXT NOT NULL UNIQUE,
  permissions   TEXT[],                      -- NULL = everything (full key)
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    VARCHAR(100),                -- clerk user id; NULL for migrated rows
  CHECK ((property_id IS NULL) <> (clerk_org_id IS NULL))
);
-- Copy only for owners with no key row yet, so a re-run after a rotation
-- can't resurrect the stale legacy value as a second Default row.
INSERT INTO api_key (property_id, name, key, enabled)
SELECT p.id, 'Default', p.api_key, p.api_key_enabled FROM property p
WHERE p.api_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_key k WHERE k.property_id = p.id);
INSERT INTO api_key (clerk_org_id, name, key, enabled)
SELECT o.clerk_org_id, 'Default', o.api_key, o.api_key_enabled FROM organization o
WHERE o.api_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_key k WHERE k.clerk_org_id = o.clerk_org_id);

CREATE TABLE IF NOT EXISTS staff_permission (
  property_id    UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  clerk_user_id  VARCHAR(100) NOT NULL,
  permissions    TEXT[] NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     VARCHAR(100),
  PRIMARY KEY (property_id, clerk_user_id)
);
```

- [ ] **Step 2: Mirror both tables into `src/db/schema.sql`** after the `organization` table, with a two-line comment pointing at the spec. Change the comments on `property.api_key`/`api_key_enabled` and `organization.api_key`/`api_key_enabled` to `-- DEPRECATED: keys live in api_key; column kept until the cleanup migration`.

- [ ] **Step 3: Apply the migration locally twice**

Run: `node -r dotenv/config -e "const fs=require('fs');const p=require('./src/db');(async()=>{const s=fs.readFileSync('src/db/migrate-2026-10-31-permissions.sql','utf8');await p.query(s);await p.query(s);const r=await p.query('select count(*)::int n from api_key');console.log(r.rows[0]);await p.end()})()"`
Expected: prints `{ n: <number of local properties and orgs with a legacy key> }` and no error on the second run.

- [ ] **Step 4: Write `src/lib/permissions.js`** with the four exports above. `setGrant` is one `INSERT ... ON CONFLICT (property_id, clerk_user_id) DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now(), updated_by = EXCLUDED.updated_by RETURNING *`.

- [ ] **Step 5: Write `src/lib/apiKeys.js`** with the exports above. One private `ownerCol(owner)` returns `['property_id', id]` or `['clerk_org_id', id]` and throws on anything else; every query's WHERE is built from it. `generateKey` uses `crypto.randomBytes(32).toString('hex')` with prefix `prop_` or `org_`.

- [ ] **Step 6: Write the first part of `scripts/check-permissions.js`**, following `scripts/check-multi-property-http.js`: refuses remote DBs, deletes `RESEND_API_KEY`/`ABLY_API_KEY`, commits throwaway fixtures under `org_permchk_<hex>` and deletes the property and organization rows in `finally` (cascades clear keys and grants). Cases:

```js
check('unknownPermissions', () => {
  assert.deepEqual(unknownPermissions(['housekeeping.inspect']), []);
  assert.deepEqual(unknownPermissions(['housekeeping.inspect', 'nope.x']), ['nope.x']);
  assert.equal(unknownPermissions('housekeeping.inspect'), null);
  assert.equal(unknownPermissions([1]), null);
});
check('grant round trip', async () => {
  assert.deepEqual(await getGrant(pool, P, 'user_a'), []);
  await setGrant(pool, P, 'user_a', ['housekeeping.inspect'], 'user_admin');
  await setGrant(pool, P, 'user_a', ['housekeeping.manage'], 'user_admin');   // upsert replaces
  assert.deepEqual(await getGrant(pool, P, 'user_a'), ['housekeeping.manage']);
});
check('create / findByKey / ensureDefault / list / update / remove', async () => {
  const d = await ensureDefault(pool, { property_id: P });
  assert.equal(d.name, 'Default'); assert.equal(d.permissions, null); assert.match(d.key, /^prop_[0-9a-f]{64}$/);
  assert.equal((await ensureDefault(pool, { property_id: P })).id, d.id);
  const o = await ensureDefault(pool, { clerk_org_id: ORG });             // creates the organization row too
  assert.match(o.key, /^org_[0-9a-f]{64}$/);
  const s = await create(pool, { property_id: P }, { name: 'Site', permissions: ['housekeeping.inspect'], created_by: 'user_admin' });
  assert.equal((await findByKey(pool, s.key)).id, s.id);
  assert.equal(await findByKey(pool, 'prop_nope'), null);
  await update(pool, { property_id: P }, s.id, { enabled: false });
  assert.equal(await findByKey(pool, s.key), null);                        // disabled = not found
  assert.equal(await update(pool, { clerk_org_id: ORG }, s.id, { name: 'x' }), null); // wrong owner
  assert.deepEqual((await list(pool, { property_id: P })).map((k) => k.id), [d.id, s.id]);
  assert.equal(await remove(pool, { property_id: P }, s.id), true);
  assert.equal(await remove(pool, { property_id: P }, s.id), false);
});
check('migration re-run after rotation adds no second Default', async () => {
  // P2 has a legacy column value AND an api_key row with a different key.
  await pool.query('UPDATE property SET api_key = $1 WHERE id = $2', [`prop_legacy_${run}`, P2]);
  await create(pool, { property_id: P2 }, { key: `prop_live_${run}` });
  await pool.query(fs.readFileSync('src/db/migrate-2026-10-31-permissions.sql', 'utf8'));
  assert.equal((await list(pool, { property_id: P2 })).length, 1);
});
```

- [ ] **Step 7: Run the check**

Run: `node -r dotenv/config scripts/check-permissions.js`
Expected: every line `ok`, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrate-2026-10-31-permissions.sql src/db/schema.sql src/lib/permissions.js src/lib/apiKeys.js scripts/check-permissions.js
git commit -m "Permissions: api_key and staff_permission tables, vocabulary, key helpers"
```

---

### Task 2: Resolver and middleware — keys read from the table, `requirePermission`, scoped keys, `/api/auth/me`

**Files:**
- Modify: `src/lib/propertyResolver.js:50-60` (`resolveSiteProperty`)
- Modify: `src/middleware/auth.js` (`authenticateOrApiKey`, `authenticateOrgKey`, `requireRoleOrApiKey`, new `requirePermission`, export `clerkClient`)
- Modify: `src/controllers/auth.js` (`me`)
- Modify: `scripts/check-permissions.js` (second part)
- Modify fixtures that insert legacy key columns, so every check still authenticates: `scripts/check-multi-property.js:79-86`, `scripts/check-multi-property-http.js:41-42`, `scripts/check-courses.js:59-60`, `scripts/check-equipment.js:58`, `scripts/check-marina-http.js:48`, `scripts/check-sailor-documents-http.js:37`, `scripts/check-rate-plans.js:103-105`, `scripts/check-voice-http.js:135`, `scripts/import-sidon-marina.js:473`, `scripts/check-import-sidon.js:345-355`, `scripts/seed-marina-demo.js:84-87`

**Interfaces:**
- Consumes: `apiKeys.findByKey`, `apiKeys.create`, `apiKeys.ensureDefault`, `permissions.PERMISSIONS`, `permissions.getGrant` (Task 1).
- Produces:
  - `resolveSiteProperty` success results gain `apiKey: { id, permissions }` (both property-key and org-key paths; error results unchanged).
  - `req.api_key = { id, permissions }` on every api-key-authenticated request (`authenticateOrApiKey`, `authenticateOrgKey`).
  - `requirePermission(name): middleware` in `src/middleware/auth.js`; throws at definition time if `name` is not in `PERMISSIONS`.
  - `hasPermission(req, name): Promise<boolean>` exported for reuse.
  - `clerkClient` exported from `src/middleware/auth.js` (Task 3 uses it).
  - `GET /api/auth/me` → `{ property_id, role, permissions }`.

- [ ] **Step 1: Extend `scripts/check-permissions.js`** with a tiny express app that mounts the real middleware on test routes (no gated route exists in the product yet):

```js
const test = express();
test.get('/gated', authenticateOrApiKey, requirePermission('housekeeping.inspect'), (req, res) => res.json({ ok: true, key: req.api_key.id }));
test.get('/admin-gated', authenticateOrApiKey, requireRoleOrApiKey('admin'), (req, res) => res.json({ ok: true }));
test.get('/org-only', authenticateOrgKey, (req, res) => res.json({ org: req.clerk_org_id, key: req.api_key.id }));
```

Fixtures: property `P` (in `ORG`), property `P_B` (in `ORG`), keys `FULL` (permissions null), `SCOPED` (`['housekeeping.inspect']`), `EMPTY` (`[]`), `OFF` (enabled false), org keys `ORG_FULL`, `ORG_OFF` (enabled false). Cases, each via `fetch` with `X-Api-Key`:

```js
// gated route
FULL   → 200, body.key === FULL.id
SCOPED → 200
EMPTY  → 403 { error: 'Missing permission', permission: 'housekeeping.inspect' }
OFF    → 401
'prop_nope' → 401
ORG_FULL + X-Property-Id: P → 200           // org key path also carries req.api_key
// admin-gated route
FULL   → 200
SCOPED → 403 { error: 'This key is scoped; this route needs a full key or a named permission' }
EMPTY  → 403 (same body)
// org-only route
ORG_FULL → 200, body.org === ORG
ORG_OFF  → 401
FULL (a property key) → 403 'This endpoint requires an organization API key'
// staff rail, middleware called directly with a fake req/res (bearer can't be driven)
admin, no grant                               → next() called
staff, grant ['housekeeping.inspect'] at P    → next() called
same staff, req.property_id = P_B             → 403 Missing permission
staff, no grant                               → 403 Missing permission
staff, no property_id (org route)             → 403 Missing permission
// definition-time guard
assert.throws(() => requirePermission('nope.x'))
// me
call(authCtrl.me, { property_id: P, user: { id: 'user_a', role: 'staff' } }).body → { property_id: P, role: 'staff', permissions: ['housekeeping.inspect'] }
call(authCtrl.me, { property_id: P, user: { id: 'user_adm', role: 'admin' } }).body.permissions → []
```

- [ ] **Step 2: Run the check to see it fail**

Run: `node -r dotenv/config scripts/check-permissions.js`
Expected: the new cases FAIL (`requirePermission is not a function`, 401s where 200 expected).

- [ ] **Step 3: Change `resolveSiteProperty`** to one `findByKey(db, key)` call: a `property_id` row returns `{ propertyId, apiKey }`; a `clerk_org_id` row continues into the existing org routing with `clerkOrgId` and adds `apiKey` to the `pick` result. Delete the two legacy-column queries.

- [ ] **Step 4: Change `src/middleware/auth.js`**
  - `authenticateOrApiKey`: after `r` resolves, `req.api_key = r.apiKey`.
  - `authenticateOrgKey`: replace both queries with `findByKey`; `clerk_org_id` row → set `req.clerk_org_id`, `req.api_key`, `req.auth_method`; `property_id` row → the existing 403; null → 401.
  - `requireRoleOrApiKey`: `if (req.auth_method === 'api_key') return req.api_key.permissions === null ? next() : res.status(403).json({ error: SCOPED_KEY })`.
  - Add `hasPermission(req, name)` and `requirePermission(name)` per the spec's table; grants read with `getGrant(pool, req.property_id, req.user.id)`.
  - Export `clerkClient`, `hasPermission`, `requirePermission`.

- [ ] **Step 5: Change `me` in `src/controllers/auth.js`** to add `permissions`: `[]` for admins, else `await getGrant(pool, req.property_id, req.user.id)`.

- [ ] **Step 6: Update the fixture scripts.** Each `INSERT INTO property (... api_key[, api_key_enabled] ...)` drops those columns and is followed by `await apiKeys.create(db, { property_id: id }, { key, enabled })`; each `INSERT INTO organization (clerk_org_id, api_key ...)` becomes `apiKeys.create(db, { clerk_org_id }, { key, enabled })` (which creates the org row). Specifics:
  - `check-multi-property.js`: `prop()` creates the key row when `key` is given; `orgKey()` returns `(await apiKeys.create(db, { clerk_org_id: org }, { key: \`org_check_${org}\`, enabled })).key`.
  - `check-multi-property-http.js:41-42`: same two changes with `pool`.
  - `import-sidon-marina.js:473`: insert the property without key columns, then `apiKeys.create(db, { property_id }, {})` for the Default key. `check-import-sidon.js:345-355`: read `key`/`enabled` from `api_key WHERE property_id = $1 AND name = 'Default'` instead of the property columns.
  - `seed-marina-demo.js:84-87`: drop `api_key_enabled` from `put`, replace the `UPDATE ... COALESCE` with `(await apiKeys.ensureDefault(db, { property_id: P })).key`.
  - The remaining six: one `create` call each after the property insert.

- [ ] **Step 7: Run the checks**

Run: `node -r dotenv/config scripts/check-permissions.js && node -r dotenv/config scripts/check-multi-property.js && node -r dotenv/config scripts/check-multi-property-http.js && node -r dotenv/config scripts/check-courses.js && node -r dotenv/config scripts/check-equipment.js && node -r dotenv/config scripts/check-rate-plans.js`
Expected: all `ok`, exit 0 for each. (`check-marina-http`, `check-sailor-documents-http`, `check-voice-http`, `check-import-sidon` need external services; run any whose env is present and note the rest as not run.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/propertyResolver.js src/middleware/auth.js src/controllers/auth.js scripts/
git commit -m "Permissions: keys resolve from api_key, requirePermission, scoped keys, grants on /api/auth/me"
```

---

### Task 3: Endpoints — key management for property and org, staff grants

**Files:**
- Create: `src/controllers/apiKeys.js`
- Create: `src/controllers/staff.js`
- Modify: `src/routes/property.js:15-18`, `src/routes/organization.js`
- Modify: `src/controllers/property.js` (delete `generateApiKey`, `getApiKey`, `rotateApiKey`, `disableApiKey`, `enableApiKey` and the `crypto` require if now unused), `src/controllers/organization.js` (delete `generateOrgApiKey`, `ensureOrg`, `getApiKey`, `rotateApiKey`, `setApiKeyEnabled`, `disableApiKey`, `enableApiKey`)
- Modify: `scripts/check-multi-property-http.js:170-180` (legacy org handlers now live on `apiKeys.organization`)
- Modify: `scripts/check-permissions.js` (third part)

**Interfaces:**
- Consumes: `apiKeys.*` and `permissions.*` (Task 1), `clerkClient` (Task 2).
- Produces `src/controllers/apiKeys.js`: `forOwner(ownerOf: (req) => owner)` → `{ getLegacy, rotateLegacy, disableLegacy, enableLegacy, list, create, update, remove }`; exports `property = forOwner(req => ({ property_id: req.property_id }))` and `organization = forOwner(req => ({ clerk_org_id: req.clerk_org_id }))`.
  - Legacy handlers keep today's shapes: `getLegacy` → `{ api_key, api_key_enabled }`; `rotateLegacy` → `{ api_key }`; `disableLegacy`/`enableLegacy` → `{ api_key, api_key_enabled }`. All act on `ensureDefault`.
  - `list` → 200 `row[]`; `create` → 201 row (`name` required, 1–100 chars, not `Default`; `permissions` omitted/null = full; unknown names → 400 `{ error: 'Unknown permissions: nope.x' }`); `update` → 200 row or 404; `remove` → 204 or 404.
- Produces `src/controllers/staff.js`: `listStaff` (GET `/api/property/staff`) → `[{ clerk_user_id, first_name, last_name, email, role, permissions }]`, roles normalised `org:admin` → `admin`, anything else → `staff`, paginated through Clerk with `limit: 500` and `offset` until `data.length >= totalCount`. `setStaffPermissions` (PUT `/api/property/staff/:clerk_user_id/permissions`) → validates body (`permissions` array of known names, else 400), then `getOrganizationMembershipList({ organizationId: req.clerk_org_id, userId: [id], limit: 1 })` → 404 `{ error: 'User is not a member of this organization' }` when empty, else `setGrant` and 200 the row.
- Routes (all `authenticate`/`authenticateOrg` + `requireRole('admin')`):
  - `/api/property/api-key`, `/rotate`, `/disable`, `/enable` → `apiKeys.property.*Legacy` (paths unchanged)
  - `GET/POST /api/property/api-keys`, `PUT/DELETE /api/property/api-keys/:id`
  - `GET /api/property/staff`, `PUT /api/property/staff/:clerk_user_id/permissions`
  - the same key routes under `/api/organization/...` with `authenticateOrg` → `apiKeys.organization.*`

- [ ] **Step 1: Extend `scripts/check-permissions.js`** using the `call(fn, req)` helper from `check-multi-property-http.js`, `req = { property_id: P, clerk_org_id: ORG, user: { id: 'user_adm', role: 'admin' }, params, body }`:

```js
// legacy, property
const g = await call(apiKeysCtrl.property.getLegacy, req);     assert.match(g.body.api_key, /^prop_/); assert.equal(g.body.api_key_enabled, true);
const r = await call(apiKeysCtrl.property.rotateLegacy, req);  assert.notEqual(r.body.api_key, g.body.api_key);
assert.equal(await findByKey(pool, g.body.api_key), null);     // old value dead
assert.equal((await call(apiKeysCtrl.property.disableLegacy, req)).body.api_key_enabled, false);
assert.equal((await call(apiKeysCtrl.property.enableLegacy, req)).body.api_key_enabled, true);
// legacy, org (creates the organization row)
assert.match((await call(apiKeysCtrl.organization.getLegacy, { clerk_org_id: `org_fresh_${run}` })).body.api_key, /^org_/);
// crud
const c = await call(apiKeysCtrl.property.create, { ...req, body: { name: 'Website', permissions: ['housekeeping.inspect'] } });
assert.equal(c.statusCode, 201); assert.equal(c.body.created_by, 'user_adm'); assert.deepEqual(c.body.permissions, ['housekeeping.inspect']);
assert.equal((await call(apiKeysCtrl.property.create, { ...req, body: { name: 'Default' } })).statusCode, 400);
assert.equal((await call(apiKeysCtrl.property.create, { ...req, body: { name: '' } })).statusCode, 400);
assert.equal((await call(apiKeysCtrl.property.create, { ...req, body: { name: 'x'.repeat(101) } })).statusCode, 400);
assert.equal((await call(apiKeysCtrl.property.create, { ...req, body: { name: 'Bad', permissions: 'housekeeping.inspect' } })).statusCode, 400);
assert.deepEqual((await call(apiKeysCtrl.property.create, { ...req, body: { name: 'Bad', permissions: ['nope.x'] } })).body, { error: 'Unknown permissions: nope.x' });
const u = await call(apiKeysCtrl.property.update, { ...req, params: { id: c.body.id }, body: { permissions: null, enabled: false } });
assert.equal(u.body.permissions, null); assert.equal(u.body.enabled, false);
assert.equal((await call(apiKeysCtrl.organization.update, { ...req, params: { id: c.body.id }, body: { name: 'x' } })).statusCode, 404); // wrong owner
assert.equal((await call(apiKeysCtrl.property.list, req)).body.length, 2);                      // Default + Website
assert.equal((await call(apiKeysCtrl.property.remove, { ...req, params: { id: c.body.id } })).statusCode, 204);
assert.equal((await call(apiKeysCtrl.property.remove, { ...req, params: { id: c.body.id } })).statusCode, 404);
// deleting Default: the legacy GET makes a fresh one
const d = (await call(apiKeysCtrl.property.list, req)).body[0];
await call(apiKeysCtrl.property.remove, { ...req, params: { id: d.id } });
assert.notEqual((await call(apiKeysCtrl.property.getLegacy, req)).body.api_key, d.key);
// staff: validation runs before Clerk is called
assert.equal((await call(staffCtrl.setStaffPermissions, { ...req, params: { clerk_user_id: 'user_x' }, body: { permissions: ['nope.x'] } })).statusCode, 400);
assert.equal((await call(staffCtrl.setStaffPermissions, { ...req, params: { clerk_user_id: 'user_x' }, body: {} })).statusCode, 400);
```

`listStaff` and the membership 404 need a real Clerk org; they are checked by hand against the dev dashboard, not here.

- [ ] **Step 2: Run the check to see it fail**

Run: `node -r dotenv/config scripts/check-permissions.js`
Expected: FAIL, `Cannot find module '../src/controllers/apiKeys'`.

- [ ] **Step 3: Write `src/controllers/apiKeys.js`** per the interface. Validation in one `parseBody(body, { requireName })` returning `{ error } | { name, permissions }`.

- [ ] **Step 4: Write `src/controllers/staff.js`** per the interface, using `clerkClient` from `../middleware/auth`.

- [ ] **Step 5: Rewire the routes** and delete the superseded handlers and helpers from `controllers/property.js` and `controllers/organization.js`. Update `scripts/check-multi-property-http.js:170-180` to call `apiKeysCtrl.organization.rotateLegacy` / `getLegacy` / `disableLegacy` / `enableLegacy`.

- [ ] **Step 6: Run the checks and boot the server**

Run: `node -r dotenv/config scripts/check-permissions.js && node -r dotenv/config scripts/check-multi-property-http.js`
Expected: all `ok`.
Run: `node -r dotenv/config -e "require('./src/app'); console.log('app loads')"`
Expected: `app loads` (catches a bad route reference at require time).

- [ ] **Step 7: Commit**

```bash
git add src/controllers/apiKeys.js src/controllers/staff.js src/controllers/property.js src/controllers/organization.js src/routes/property.js src/routes/organization.js scripts/check-permissions.js scripts/check-multi-property-http.js
git commit -m "Permissions: named API keys per property and org, staff grants endpoints"
```

---

### Task 4: Swagger

**Files:**
- Modify: `src/docs/swagger.js` (`/api/auth/me` at ~line 210; key paths at ~219–247; add new paths beside them)

**Interfaces:**
- Consumes: response shapes from Tasks 2 and 3.

- [ ] **Step 1: Document**
  - `/api/auth/me`: add `permissions: { type: 'array', items: { type: 'string' } }` with description "Granted at this property; empty for admins, who pass every check".
  - Component schema `ApiKey` `{ id, name, key, permissions (nullable array, null = full key), enabled, created_at, created_by }` and `Permission` `{ type: 'string', enum: PERMISSIONS }` imported from `src/lib/permissions.js`.
  - Paths `/api/property/api-keys` (GET, POST), `/api/property/api-keys/{id}` (PUT, DELETE), the two `/api/organization/api-keys` twins, `/api/property/staff` (GET), `/api/property/staff/{clerk_user_id}/permissions` (PUT). Each 403 `Insufficient permissions`; POST/PUT 400 `Unknown permissions / invalid body`; `Default` reserved noted on POST.
  - A `description` on the `Property` key paths: "A key with `permissions: null` does everything (the only kind that existed before 2026-10-31). A key with a list passes only routes requiring one of those names and fails admin-gated routes with 403."

- [ ] **Step 2: Verify the spec still builds**

Run: `node -r dotenv/config -e "const s=require('./src/docs/swagger');console.log(Object.keys(s.paths).filter(p=>/api-keys|staff/.test(p)).join('\n'))"`
Expected: the six new paths listed.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Permissions: swagger for keys, staff grants and /api/auth/me permissions"
```

---

### Task 5: Live migration, push, memory

- [ ] **Step 1: Ask Robert for the OK to run `src/db/migrate-2026-10-31-permissions.sql` on live.** Do not push before this.

- [ ] **Step 2: Run it on live** with the usual `psql "$LIVE_DATABASE_URL" -f src/db/migrate-2026-10-31-permissions.sql`, then `SELECT count(*) FROM api_key` and compare with `SELECT count(*) FROM property WHERE api_key IS NOT NULL` + `SELECT count(*) FROM organization WHERE api_key IS NOT NULL`.
Expected: equal counts.

- [ ] **Step 3: Push** `git push origin main`, then once Render deploys hit `GET /api/property/me` with a known live key to confirm it still resolves.

- [ ] **Step 3b: Close the deploy window.** Between the live migration and the deploy finishing, old code still writes keys to the legacy columns only, so a rotate, disable, or first org-key creation made in that window is invisible to the new code. Don't touch keys in the dashboard during the window. After the deploy is live, re-run the migration once (idempotent; it picks up any owner created in the window), then run the divergence query and act on any row it returns (re-apply the change via the new endpoints):

```sql
SELECT 'property' AS owner, p.id::text AS id, p.api_key AS legacy_key, p.api_key_enabled AS legacy_enabled, k.key, k.enabled
FROM property p JOIN api_key k ON k.property_id = p.id AND k.name = 'Default'
WHERE p.api_key IS NOT NULL AND (p.api_key <> k.key OR p.api_key_enabled <> k.enabled)
UNION ALL
SELECT 'organization', o.clerk_org_id, o.api_key, o.api_key_enabled, k.key, k.enabled
FROM organization o JOIN api_key k ON k.clerk_org_id = o.clerk_org_id AND k.name = 'Default'
WHERE o.api_key IS NOT NULL AND (o.api_key <> k.key OR o.api_key_enabled <> k.enabled);
```

Rolling back past this deploy is unsafe once any key has been changed through the new code: old code would read the stale legacy columns. Note both in the memory file.

- [ ] **Step 4: Save a project memory** `project_permissions_state.md`: live date, legacy columns still present, cleanup migration outstanding, housekeeping gates to wire.
