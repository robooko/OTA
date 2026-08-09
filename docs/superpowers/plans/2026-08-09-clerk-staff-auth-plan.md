# Clerk Staff Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace this API's password/JWT staff-authentication system with Clerk — `authenticate` verifies a Clerk session token instead of our own `JWT_SECRET` token, `property` links to a Clerk Organization via a new `clerk_org_id` column, and the first authenticated request from a brand-new Organization auto-provisions its property — per `docs/superpowers/specs/2026-08-09-clerk-staff-auth-design.md`.

**Architecture:** `src/middleware/auth.js`'s `authenticate` function is rewritten to call Clerk's backend SDK instead of `jsonwebtoken`; every other file that consumes `req.property_id`/`req.user` (all already-migrated modules: guests, rooms, room types, availability, bookings, extras, restaurant) needs zero changes, since that contract is preserved exactly. `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/users`, `PUT /api/auth/users/:id` are deleted outright (confirmed hard cutover, no parallel-running period) since Clerk's own Organization membership/invites/roles supersede them entirely. `GET /api/auth/me` is kept, repurposed to a zero-query reflection of what `authenticate` already resolved.

**Tech Stack:** Node/Express, `pg`, PostgreSQL (local dev + Neon production), `@clerk/backend` (new dependency, replacing `jsonwebtoken` + `bcrypt`, both removed).

## Global Constraints

- **No `psql` CLI in this environment.** DB steps use `node -e` one-liners with the `pg` package and `.env`'s `DATABASE_URL` (local) / `DATABASE_URL_LIVE` (production).
- No automated test framework exists in this project — verification is manual `curl`/`node -e`.
- **This feature needs a real Clerk Organization and a real Clerk session token to verify end-to-end.** This is solved, not a blocker: Organizations are enabled on this project's Clerk instance, a test user (`ota-dashboard-test@example.com`) and test Organization (`OTA Test Org`, with that user as an `org:admin` member) already exist, the Clerk CLI is installed globally and reads `CLERK_SECRET_KEY` from `.env` automatically, and Task 2 Step 7 gives the exact recipe (CLI sign-in token → Playwright browser → `Clerk.session.getToken()`) to mint a fresh real token on demand. Session tokens expire in ~60 seconds — mint a fresh one immediately before use, don't reuse one across steps separated by a long pause. On Windows/Git Bash, prefix `clerk api` calls with `MSYS_NO_PATHCONV=1` — otherwise Git Bash mangles the leading `/` in endpoint paths like `/users` into a Windows path.
- Clerk claim shape, confirmed empirically against this instance's real tokens (not assumed): `@clerk/backend`'s `verifyToken` returns raw JWT claims with no renaming. Clerk's "v2" session tokens nest active-organization info under a short `o` claim: `claims.o.id` (org id), `claims.o.rol` (role, short form e.g. `"admin"` — NOT the Backend API's longer `"org:admin"` form), `claims.o.slg` (slug). Code must read `claims.o?.id`/`claims.o?.rol`, never `claims.org_id`/`claims.org_role`.
- Confirmed rollout decision: **hard cutover**. `register`/`login` are deleted outright, no fallback period, no parallel old+new auth. This was explicitly confirmed with the user, who accepted that any existing client still calling the old endpoints breaks on deploy.
- `req.property_id` and `req.user` (`{ id, role }`) must keep the exact same shape every other controller in this codebase already depends on — verified in Task 2 by confirming an untouched, already-scoped endpoint (`GET /api/restaurant`) still works end-to-end through the new `authenticate`.
- Foreign/cross-property access rules elsewhere in the codebase are unaffected by this plan — this plan only changes how a caller's own `property_id`/`role` gets resolved, not any authorization logic downstream of that.

---

### Task 1: `property.clerk_org_id` schema + migration, add `@clerk/backend`

**Files:**
- Modify: `src/db/schema.sql:9-14` (the `property` table)
- Create: `src/db/migrate-2026-08-09-property-clerk-org.sql`
- Modify: `package.json` (via `npm install`, not hand-edited)

**Interfaces:**
- Produces: `property.clerk_org_id` (nullable, `UNIQUE`) — Task 2's `authenticate` rewrite looks this column up directly. `@clerk/backend` installed and importable as `require('@clerk/backend')` — Task 2 imports `createClerkClient` and `verifyToken` from it.

- [ ] **Step 1: Add `clerk_org_id` to `schema.sql`**

In `src/db/schema.sql`, replace:
```sql
CREATE TABLE IF NOT EXISTS property (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  status     VARCHAR(20)  DEFAULT 'active',
  created_at TIMESTAMPTZ  DEFAULT now()
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS property (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  status        VARCHAR(20)  DEFAULT 'active',
  clerk_org_id  VARCHAR(255) UNIQUE,
  created_at    TIMESTAMPTZ  DEFAULT now()
);
```

- [ ] **Step 2: Write the migration file**

Create `src/db/migrate-2026-08-09-property-clerk-org.sql`:
```sql
-- One-time migration: add property.clerk_org_id, linking a property to a
-- Clerk Organization. Purely additive -- nullable, no backfill needed
-- (no existing property has a Clerk org yet). Idempotent-safe via
-- IF NOT EXISTS. Run ONCE directly against an already-populated database
-- (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS clerk_org_id VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_clerk_org_id_key'
  ) THEN
    ALTER TABLE property ADD CONSTRAINT property_clerk_org_id_key UNIQUE (clerk_org_id);
  END IF;
END $$;
```
(The `DO` block makes the `UNIQUE` constraint add idempotent — a plain `ADD CONSTRAINT` without a guard would error `constraint already exists` on a second run, unlike `ADD COLUMN IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` used elsewhere in this project's migrations.)

- [ ] **Step 3: Run the migration against the local database**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-09-property-clerk-org.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`, no errors.

- [ ] **Step 4: Verify**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'property' AND column_name = 'clerk_org_id'\");
  console.log(cols.rows);
  const constraint = await pool.query(\"SELECT conname FROM pg_constraint WHERE conname = 'property_clerk_org_id_key'\");
  console.log(constraint.rows);
  await pool.end();
})();
"
```
Expected: first query returns `[{ column_name: 'clerk_org_id', is_nullable: 'YES' }]`; second returns `[{ conname: 'property_clerk_org_id_key' }]`.

- [ ] **Step 5: Install `@clerk/backend`**

```bash
npm install @clerk/backend
```
Expected: `package.json`'s `dependencies` gains a `@clerk/backend` entry; `package-lock.json` updates; no install errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-09-property-clerk-org.sql package.json package-lock.json
git commit -m "Add property.clerk_org_id and the @clerk/backend dependency"
```

---

### Task 2: Rewrite `authenticate` to verify Clerk tokens; delete password-based auth

**Files:**
- Modify: `src/middleware/auth.js` (full rewrite of `authenticate`; `requireRole` and `authenticateOrApiKey` keep their current code unchanged)
- Modify: `src/controllers/auth.js` (delete `register`, `login`, `listUsers`, `updateUser`; rewrite `me`)
- Modify: `src/routes/auth.js` (delete 4 routes, keep only `GET /me`)
- Modify: `package.json` (via `npm uninstall`, not hand-edited)

**Interfaces:**
- Consumes: `property.clerk_org_id` (Task 1), `@clerk/backend`'s `createClerkClient`/`verifyToken` exports (Task 1).
- Produces: `req.property_id` (UUID string) and `req.user = { id: <string>, role: 'admin' | 'staff' }` — the exact same shape every other controller in this codebase (guests, rooms, room types, availability, bookings, extras, restaurant) already reads. No other file changes as a result of this task.

**Before starting this task:** you do NOT need to wait for a token to be handed to you — Step 7 below is the self-service recipe for minting one (see Global Constraints for why this is already solved). Confirm you have a Playwright browser tool available and the Clerk CLI responds (`clerk --version`) before starting; if either is missing, STOP and report NEEDS_CONTEXT.

- [ ] **Step 1: Rewrite `src/middleware/auth.js`**

Replace the entire file:
```js
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { isValidUuid } = require('./validate');

const JWT_SECRET = process.env.JWT_SECRET;

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.property_id = req.user.property_id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
  }

  const property_id = req.body.property_id || req.query.property_id;
  if (!property_id || !isValidUuid(property_id)) {
    return res.status(400).json({ error: 'property_id is required and must be a valid UUID when authenticating with X-Api-Key' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE id = $1', [property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Property not found' });
    req.property_id = property_id;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateOrApiKey, requireRole };
```
with:
```js
const { createClerkClient, verifyToken } = require('@clerk/backend');
const pool = require('../db');
const { isValidUuid } = require('./validate');

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function mapClerkRole(orgRole) {
  return orgRole === 'admin' ? 'admin' : 'staff';
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);

  let claims;
  try {
    claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Clerk's v2 session tokens nest active-organization info under a short
  // `o` claim ({ id, rol, slg }), not flat org_id/org_role claims -- this
  // is confirmed against this project's real Clerk instance, not assumed.
  const orgId = claims.o?.id;
  if (!orgId) {
    return res.status(401).json({ error: 'An organization context is required' });
  }

  try {
    const propertyRes = await pool.query('SELECT id FROM property WHERE clerk_org_id = $1', [orgId]);
    let propertyId;
    if (propertyRes.rows.length) {
      propertyId = propertyRes.rows[0].id;
    } else {
      const org = await clerkClient.organizations.getOrganization({ organizationId: orgId });
      const { rows } = await pool.query(
        'INSERT INTO property (name, clerk_org_id) VALUES ($1, $2) RETURNING id',
        [org.name, orgId]
      );
      propertyId = rows[0].id;
    }

    req.property_id = propertyId;
    req.user = { id: claims.sub, role: mapClerkRole(claims.o.rol) };
    next();
  } catch (err) {
    next(err);
  }
}

async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
  }

  const property_id = req.body.property_id || req.query.property_id;
  if (!property_id || !isValidUuid(property_id)) {
    return res.status(400).json({ error: 'property_id is required and must be a valid UUID when authenticating with X-Api-Key' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE id = $1', [property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Property not found' });
    req.property_id = property_id;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateOrApiKey, requireRole };
```
Note `authenticateOrApiKey` and `requireRole` are byte-for-byte the same as before — only `authenticate` actually changes; they're repeated in full here only because this step replaces the whole file.

- [ ] **Step 2: Rewrite `src/controllers/auth.js`**

Replace the entire file:
```js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '24h';

async function register(req, res, next) {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const validRoles = ['admin', 'staff', 'guest'];
    const assignedRole = validRoles.includes(role) ? role : 'staff';

    const existing = await pool.query('SELECT id FROM api_user WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO api_user (property_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, property_id, name, email, role, created_at`,
      [req.property_id, name, email, password_hash, assignedRole]
    );

    const token = jwt.sign(
      { id: rows[0].id, role: rows[0].role, property_id: rows[0].property_id },
      JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }
    );
    res.status(201).json({ user: rows[0], token });
  } catch (err) { next(err); }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await pool.query(
      'SELECT * FROM api_user WHERE email = $1', [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: rows[0].id, role: rows[0].role, property_id: rows[0].property_id },
      JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({
      user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role, property_id: rows[0].property_id },
      token,
    });
  } catch (err) { next(err); }
}

async function me(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, property_id, name, email, role, created_at FROM api_user WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at FROM api_user WHERE property_id = $1 ORDER BY created_at',
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function updateUser(req, res, next) {
  try {
    const { name, role } = req.body;
    const validRoles = ['admin', 'staff', 'guest'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const { rows } = await pool.query(
      `UPDATE api_user SET
         name = COALESCE($1, name),
         role = COALESCE($2, role)
       WHERE id = $3 AND property_id = $4 RETURNING id, name, email, role`,
      [name, role, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { register, login, me, listUsers, updateUser };
```
with:
```js
async function me(req, res, next) {
  try {
    res.json({ property_id: req.property_id, role: req.user.role });
  } catch (err) { next(err); }
}

module.exports = { me };
```

- [ ] **Step 3: Rewrite `src/routes/auth.js`**

Replace the entire file:
```js
const router = require('express').Router();
const ctrl = require('../controllers/auth');
const { authenticate, requireRole } = require('../middleware/auth');

router.post('/register', authenticate, requireRole('admin'), ctrl.register);
router.post('/login', ctrl.login);
router.get('/me', authenticate, ctrl.me);
router.get('/users', authenticate, requireRole('admin'), ctrl.listUsers);
router.put('/users/:id', authenticate, requireRole('admin'), ctrl.updateUser);

module.exports = router;
```
with:
```js
const router = require('express').Router();
const ctrl = require('../controllers/auth');
const { authenticate } = require('../middleware/auth');

router.get('/me', authenticate, ctrl.me);

module.exports = router;
```

- [ ] **Step 4: Remove `jsonwebtoken` and `bcrypt`**

```bash
npm uninstall jsonwebtoken bcrypt
```
Expected: both removed from `package.json`'s `dependencies` and from `node_modules`; `package-lock.json` updates; no errors. Confirm nothing else in the codebase still requires them:
```bash
grep -rln "jsonwebtoken\|bcrypt" src/
```
Expected: no output (Step 1-2's rewrites removed the only two files that used them).

- [ ] **Step 5: Start the server**

```bash
npm run dev
```
Expected: starts cleanly, no `Cannot find module` errors (this would indicate a leftover `require('jsonwebtoken')`/`require('bcrypt')` Step 4's grep should have already caught, or a Clerk SDK import typo).

- [ ] **Step 6: Verify — no Clerk token / invalid token still 401s (regression check, no real token needed yet)**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/api/auth/me
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/api/auth/me -H "Authorization: Bearer not-a-real-token"
```
Expected: both `HTTP 401`.

- [ ] **Step 7: Mint a real Clerk session token (self-service — no human hand-off needed)**

This project's Clerk instance already has a test user (`ota-dashboard-test@example.com`) who is an `org:admin` member of a test Organization (`OTA Test Org`). Organizations are enabled on this instance. Mint a fresh token:

1. Find the test user's id and create a one-time sign-in token via the Clerk CLI (already installed globally; it reads `CLERK_SECRET_KEY` from `.env` automatically when run from this project directory — no `--secret-key` flag needed, and no `clerk auth login` needed):
```bash
cd "c:\Users\robert\source\repos\OTA"
USER_ID=$(MSYS_NO_PATHCONV=1 clerk api /users --yes 2>&1 | node -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(d.find(u => u.email_addresses.some(e => e.email_address === 'ota-dashboard-test@example.com')).id);
")
echo "USER_ID=$USER_ID"
MSYS_NO_PATHCONV=1 clerk api /sign_in_tokens -X POST -d "{\"user_id\":\"$USER_ID\",\"expires_in_seconds\":3600}" --yes 2>&1
```
Note the `url` field in the response (looks like `https://accounts.<your-domain>/sign-in?__clerk_ticket=...`).

2. Use your Playwright browser tool to navigate to that exact URL.
3. Take a page snapshot. If it shows a "Choose an organization" screen listing "OTA Test Org", click that org's button. (If it instead redirects straight through, the org was already selected automatically — proceed to the next step either way.)
4. Evaluate this JavaScript on the current page to get a fresh token:
```js
async () => {
  await window.Clerk.load();
  const token = await window.Clerk.session.getToken({ skipCache: true });
  return { token, userId: window.Clerk.user?.id, orgId: window.Clerk.organization?.id };
}
```
This returns a real, valid, org-scoped session token. **It expires in ~60 seconds** — capture it into a shell variable and run the next several verify steps immediately, back-to-back, without a long pause. If a later step in this task unexpectedly gets a 401 where 200 was expected, mint a fresh token (repeat this Step 7) and retry — don't treat an expired-token 401 as a real failure without first ruling this out.

```bash
CLERK_TOKEN="<the token from the evaluate result>"
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3000/api/auth/me -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `HTTP 200` with a body like `{"property_id":"<some uuid>","role":"admin"}` (this test user is an `org:admin` member, which the token renders as the short-form role `"admin"` under its `o.rol` claim — `authenticate` should map that to `role: "admin"`). Note the returned `property_id`.

- [ ] **Step 7b: Verify — a token with no active Organization is rejected (best-effort)**

Immediately after Step 3 above (navigating to the sign-in URL), before clicking any organization, try evaluating the same `window.Clerk.session.getToken({ skipCache: true })` snippet — if a session already exists at that point but with no active organization yet, this captures a genuine no-org token. If that's not obtainable (e.g. no session exists until an org is chosen), do not fabricate a token — skip this specific curl check, note in your report that it was skipped and why, and instead confirm by reading the `authenticate` function you just wrote in `src/middleware/auth.js` that the `if (!orgId)` branch does return `401 {"error":"An organization context is required"}`. This is a real gap in end-to-end coverage if skipped; say so plainly rather than treating the code-read as equivalent.

If you did obtain one:
```bash
CLERK_TOKEN_NO_ORG="<the no-org token>"
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3000/api/auth/me -H "Authorization: Bearer $CLERK_TOKEN_NO_ORG"
```
Expected: `HTTP 401 {"error":"An organization context is required"}`.

- [ ] **Step 8: Verify — auto-provisioning is idempotent**

Run the exact same command from Step 7's last curl a second time (reuse `$CLERK_TOKEN` if it's been under ~60 seconds since it was minted; otherwise mint a fresh one per Step 7 first):
```bash
curl -s http://localhost:3000/api/auth/me -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: the same `property_id` as Step 7 (not a new one). Then confirm directly against the database that exactly one property row exists for that org:
```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id, name, clerk_org_id FROM property WHERE clerk_org_id IS NOT NULL\")
  .then(r => { console.log(r.rows); pool.end(); });
"
```
Expected: exactly one row for `OTA Test Org` (and no others, unless earlier testing in this task created more) — no duplicates.

- [ ] **Step 9: Verify — an already-scoped, untouched endpoint still works through the new `authenticate`**

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3000/api/restaurant -H "Authorization: Bearer $CLERK_TOKEN"
```
(Mint a fresh token per Step 7 first if more than ~60 seconds have passed since it was minted.)
Expected: `HTTP 200` with a JSON array (likely empty, since this is a brand-new property with no restaurants yet) — confirms `req.property_id` set by the new `authenticate` flows correctly into `src/controllers/restaurant.js`'s `listRestaurants`, a file this task does not touch.

- [ ] **Step 10: Verify — guest-facing `authenticateOrApiKey` / `X-Api-Key` path is unaffected**

```bash
KEY=$(grep -E "^API_KEY" .env | cut -d= -f2)
PROPERTY_ID=$(node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id FROM property WHERE clerk_org_id IS NULL LIMIT 1\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
")
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:3000/api/restaurant?property_id=$PROPERTY_ID" -H "X-Api-Key: $KEY"
```
This confirms the `X-Api-Key` branch of `authenticateOrApiKey` still works for a property with no Clerk org (i.e. every pre-existing property) — note `GET /api/restaurant` doesn't actually accept `property_id` as a query param (it uses `authenticate`, not `authenticateOrApiKey`, per the earlier restaurant-scoping work), so this specific curl will 401. Use an endpoint that genuinely accepts `authenticateOrApiKey` instead — `POST /api/bookings` is the real regression target:
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "http://localhost:3000/api/bookings" \
  -H "Content-Type: application/json" -H "X-Api-Key: $KEY" \
  -d "{\"property_id\":\"$PROPERTY_ID\",\"guest_id\":\"00000000-0000-0000-0000-000000000000\",\"room_id\":\"00000000-0000-0000-0000-000000000000\",\"check_in\":\"2026-09-01\",\"check_out\":\"2026-09-02\"}"
```
Expected: `HTTP 404 {"error":"Guest not found"}` — not `401`. A `404` proves `authenticateOrApiKey` accepted the `X-Api-Key` + `property_id` and got as far as the controller's own guest lookup; a `401` here would mean this task broke the guest-facing path.

- [ ] **Step 11: Stop the dev server, commit**

```bash
git add src/middleware/auth.js src/controllers/auth.js src/routes/auth.js package.json package-lock.json
git commit -m "Replace staff password/JWT auth with Clerk session verification"
```

---

### Task 3: Swagger doc updates

**Files:**
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: nothing new. Documentation only — no runtime behavior change.

- [ ] **Step 1: Remove the deleted auth paths**

In `src/docs/swagger.js`, delete these three path entries entirely (find and remove each `'/api/auth/...': { ... },` block):
```js
    '/api/auth/register': {
      post: { tags: ['Auth'], summary: 'Register a new staff/admin account for the caller\'s own property (admin only)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' }, role: { type: 'string', enum: ['admin', 'staff', 'guest'], default: 'staff' } } } } } }, responses: { 201: { description: 'User created with JWT token' } } },
    },
    '/api/auth/login': {
      post: { tags: ['Auth'], summary: 'Login and receive JWT token', security: [], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' } } } } } }, responses: { 200: { description: 'JWT token' }, 401: { description: 'Invalid credentials' } } },
    },
```
and:
```js
    '/api/auth/users': {
      get: { tags: ['Auth'], summary: 'List all users (admin only)', responses: { 200: { description: 'Array of users' }, 403: { description: 'Forbidden' } } },
    },
```
(If a `PUT /api/auth/users/:id` path entry also exists nearby, remove it too — check for a `'/api/auth/users/{id}'` key.)

- [ ] **Step 2: Update `/api/auth/me`'s documented response**

Replace:
```js
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Get current user', responses: { 200: { description: 'Current user profile' } } },
    },
```
with:
```js
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Get the current property and role, resolved from the Clerk session token', responses: { 200: { description: 'Object with property_id and role', content: { 'application/json': { schema: { type: 'object', properties: { property_id: { type: 'string', format: 'uuid' }, role: { type: 'string', enum: ['admin', 'staff'] } } } } } } } },
    },
```

- [ ] **Step 3: Update the `bearerAuth` security scheme's description**

Replace:
```js
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
```
with:
```js
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'A Clerk session token for a user with an active Organization (maps to a property). Not this API\'s own token — Clerk issues and verifies it.',
      },
```

- [ ] **Step 4: Verify**

```bash
npm run dev
```
```bash
curl -s http://localhost:3000/api/docs.json | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log(Object.keys(d.paths).filter(p => p.startsWith('/api/auth')));
console.log(d.components.securitySchemes.bearerAuth.description);
"
```
Expected: first line `[ '/api/auth/me' ]` only (register/login/users all gone); second line prints the new description text.

- [ ] **Step 5: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Update swagger docs for Clerk-based staff auth"
```

---

### Task 4: Run migration against production, deploy

**Files:** None (operational task).

**Interfaces:** None — applies Tasks 1-3's already-committed changes to production.

- [ ] **Step 1: Pause and confirm with the user before touching production**

This is a hard cutover with no fallback (per Global Constraints) — once deployed, `POST /api/auth/login` and `POST /api/auth/register` stop existing in production. Confirm explicitly with the user that any client relying on those endpoints has already switched to Clerk, or that this is acceptable to break now. Do not proceed to Step 2 without that confirmation, even if a prior conversation turn seemed to authorize it — confirm again immediately before this specific action, since this is the point of no return.

- [ ] **Step 2: Run the migration against production**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-09-property-clerk-org.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Push to `main`**

```bash
git push origin main
```
Render auto-deploys from `main` per `render.yaml`.

- [ ] **Step 4: Post-deploy smoke check**

Wait for the Render deploy to finish, then repeat Task 2's Steps 6-7 (401 without a token, 200 with a real Clerk token) against `https://ota-u6ii.onrender.com` instead of `localhost:3000` — mint a fresh token using the same self-service recipe from Task 2 Step 7 (the Clerk instance and its `OTA Test Org`/test user are the same for local and production, since `CLERK_SECRET_KEY` isn't environment-split here). Confirm the old endpoints are actually gone:
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@bonito.example.com","password":"changeme123"}'
```
Expected: `HTTP 404` (the route no longer exists — Express's default 404, not this app's JSON error handler, since there's no matching route at all).
