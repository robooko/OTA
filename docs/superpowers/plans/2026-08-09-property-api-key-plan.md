# Per-Property API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single shared `API_KEY` env var on `POST /api/guests`, `POST /api/bookings`, `GET /api/guests/lookup`, and `POST /api/restaurant/:restaurant_id/reservations` with a per-`property` API key looked up in the database, plus a new Clerk-authenticated, admin-only endpoint to view and rotate that key — per `docs/superpowers/specs/2026-08-09-property-api-key-design.md`.

**Architecture:** A new `api_key` column on `property` (unique, plaintext). `authenticateOrApiKey` in `src/middleware/auth.js` changes from comparing `X-Api-Key` against `process.env.API_KEY` to looking up the property that owns that key — the key itself now determines `req.property_id`, closing the "any property_id you like" gap. A new route/controller pair (`src/routes/property.js`, `src/controllers/property.js`) lets an org admin (Clerk `authenticate` + `requireRole('admin')`) view or rotate their property's key. `middleware/apiKey.js` (`requireApiKey`, used by `beachClub`/`equipment`/`golf`/`proshop`/`roomService`/`spa`/`tours`) is untouched — none of those tables carry a `property_id`, so per-property keys don't apply there.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL (pgcrypto enabled), `@clerk/backend`, Node's built-in `crypto`.

## Global Constraints

- **No automated test framework** exists in this project (no jest/mocha, no `test` script). Every "verify" step is a **manual check**: a `curl` command (or `node -e` DB query) against a running `npm run dev` server, with the exact expected output.
- **Two databases:** local Postgres (`hotel_booking` on `localhost:5432`, `DATABASE_URL`) and the live Render/Neon database backing `https://ota-u6ii.onrender.com` (`DATABASE_URL_LIVE` in the local `.env` — a direct connection string to the same DB Render's own `DATABASE_URL` points at, for running one-off scripts from this machine).
- **Confirm with the user before**: running the migration against the live database (it's a schema change on production), and before `git push origin main` (triggers a live Render redeploy). Per this project's established practice.
- Today's date: **2026-08-09**.
- **`.env`'s `CLERK_SECRET_KEY` / `PUBLIC_CLERK_PUBLISHABLE_KEY` are currently the DEV Clerk instance's keys** (`sk_test_.../pk_test_...`, `valid-oriole-82.clerk.accounts.dev`). The LIVE instance's secret key is saved under the differently-named `old-CLERK_SECRET_KEY` in the same `.env` file — `process.env` won't expose a hyphenated name, so read it with `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`.
- **Test identities** (already provisioned, real Clerk data — do not create new ones):
  - Local/dev: property **"Robs"** (`a3e548af-a71d-46c0-ba61-f1f702e495be`), Clerk org `org_3HgaHm8lBYjrFnHmIjIebQjtDx2`, Clerk user `robooko7@gmail.com` → dev user id `user_3C7aK7SeaIKBPlgtuekEpSWhifn`, role `org:admin`.
  - Live: property **"FORGE"** (`b7a4c969-5e82-4c26-a587-17d2ab74858e`), Clerk org `org_3HgczASlL7aWmKNREJPFxhrKkNd`, same email → live user id `user_3CLBg0yYT3odh00x09a2KnPiGr3`, role `org:admin`.
- Clerk session tokens expire in **~60 seconds** — mint a fresh one immediately before use; don't reuse one across steps separated by a long pause.
- The local dev server (`npm run dev` under `nodemon`, watching `*.*`) should already be running in the background. Before any local verification block, confirm it's actually responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`. If it doesn't, start it (`npm run dev`, background) and wait for `Server running on port 3000` in its output — `nodemon` does NOT auto-restart a crashed child process, only on file changes, so a dead server needs a fresh start, not just a wait.
- **Scope:** only `authenticateOrApiKey`'s four routes (listed in Goal). `middleware/apiKey.js` / `requireApiKey` (`beachClub`, `equipment`, `golf`, `proshop`, `roomService`, `spa`, `tours`) is out of scope — do not touch it, do not add `property_id` to its tables.

---

### Task 1: Add `property.api_key`, backfill existing properties (local)

**Files:**
- Create: `src/db/migrate-2026-08-09-property-api-key.sql`
- Modify: `src/db/schema.sql:9-15` (the `property` table)

**Interfaces:**
- Produces: `property.api_key` (`TEXT`, `UNIQUE`, nullable at the schema level but non-null on every actual row after this task) — Task 2's middleware and Task 3's controller both query this column directly.

- [ ] **Step 1: Write the migration file**

Create `src/db/migrate-2026-08-09-property-api-key.sql`:

```sql
-- One-time migration: add property.api_key, a per-property secret used by
-- authenticateOrApiKey (src/middleware/auth.js) to replace the single
-- shared API_KEY env var. Idempotent-safe via IF NOT EXISTS. Backfills
-- every existing property with a random key so nothing is left without
-- one before the middleware cutover in a later step. Run ONCE directly
-- against an already-populated database (NOT part of the normal reset
-- pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS api_key TEXT UNIQUE;
UPDATE property SET api_key = 'prop_' || encode(gen_random_bytes(32), 'hex') WHERE api_key IS NULL;
```

- [ ] **Step 2: Update `schema.sql` to match**

In `src/db/schema.sql`, replace:

```sql
-- Properties (tenants)
CREATE TABLE IF NOT EXISTS property (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  status        VARCHAR(20)  DEFAULT 'active',
  clerk_org_id  VARCHAR(255) UNIQUE,
  created_at    TIMESTAMPTZ  DEFAULT now()
);
```

with:

```sql
-- Properties (tenants)
CREATE TABLE IF NOT EXISTS property (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  status        VARCHAR(20)  DEFAULT 'active',
  clerk_org_id  VARCHAR(255) UNIQUE,
  api_key       TEXT UNIQUE,
  created_at    TIMESTAMPTZ  DEFAULT now()
);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-09-property-api-key.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`, no errors.

- [ ] **Step 4: Verify — every property has a unique, non-null key**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows } = await pool.query('SELECT id, name, api_key FROM property ORDER BY name');
  console.log(JSON.stringify(rows, null, 2));
  const nullCount = rows.filter(r => !r.api_key).length;
  const distinctCount = new Set(rows.map(r => r.api_key)).size;
  console.log('null keys:', nullCount, '| distinct keys:', distinctCount, '/', rows.length);
  await pool.end();
})();
"
```
Expected: `null keys: 0`, `distinct keys: N / N` (matches total row count — no duplicates), every `api_key` starting with `prop_`. Note the key printed for `"Robs"` — you'll need it in Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-09-property-api-key.sql
git commit -m "Add property.api_key, backfill existing properties"
```

---

### Task 2: Switch `authenticateOrApiKey` from the shared env key to per-property lookup

**Files:**
- Modify: `src/middleware/auth.js` (the `authenticateOrApiKey` function, and its now-unused `isValidUuid` import)

**Interfaces:**
- Consumes: `pool` from `src/db/index.js` (already imported in this file), `property.api_key` from Task 1.
- Produces: `authenticateOrApiKey(req, res, next)` — unchanged signature/export name, but on the API-key path it now sets `req.property_id` from a DB lookup by key instead of trusting `req.body`/`req.query`. The JWT (`Authorization: Bearer`) path is completely unchanged.

- [ ] **Step 1: Replace the function**

In `src/middleware/auth.js`, replace:

```js
const { createClerkClient, verifyToken } = require('@clerk/backend');
const pool = require('../db');
const { isValidUuid } = require('./validate');
```

with:

```js
const { createClerkClient, verifyToken } = require('@clerk/backend');
const pool = require('../db');
```

Then replace:

```js
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
```

with:

```js
async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1', [key]);
    if (!rows.length) return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
    req.property_id = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 2: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`. `nodemon` picks up the file change automatically — no manual restart needed. If it doesn't respond, start it: `npm run dev` (background), wait for `Server running on port 3000`.

- [ ] **Step 3: Get Robs's `api_key` for testing**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
"
```
Save the printed value as `PROP_KEY` for the next steps.

- [ ] **Step 4: Verify — correct per-property key creates a guest scoped to that property, `property_id` in the body is ignored**

```bash
PROP_KEY="<value from Step 3>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests \
  -H "Content-Type: application/json" -H "X-Api-Key: $PROP_KEY" \
  -d '{"first_name":"PerProp","last_name":"Guest","email":"perprop.guest@example.com","property_id":"e1000000-0000-0000-0000-000000000004"}'
```
Expected: `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"` (Robs — from the key, NOT `...0004` which was in the body). Save the returned `id` as `PROP_GUEST_ID`.

- [ ] **Step 5: Verify — same key creates a booking (needs a room; Robs has none seeded, so expect the booking-specific 404, which still proves the key resolved the right property)**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "X-Api-Key: $PROP_KEY" \
  -d "{\"guest_id\":\"$PROP_GUEST_ID\",\"room_id\":\"00000000-0000-0000-0000-000000000000\",\"check_in\":\"2026-09-01\",\"check_out\":\"2026-09-02\"}"
```
Expected: `404 {"error":"Room not found"}` (or similarly-worded room-not-found error — confirms the guest lookup by `$PROP_GUEST_ID AND property_id = <Robs's id>` succeeded, i.e. `req.property_id` was set correctly; the room 404 is expected since Robs has 0 rooms).

- [ ] **Step 6: Verify — the old shared `API_KEY` no longer works (full replacement, not additive)**

```bash
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests \
  -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" \
  -d '{"first_name":"Should","last_name":"Fail","email":"should.fail@example.com","property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"}'
```
Expected: `401 {"error":"Missing or invalid Authorization header or X-Api-Key"}` — the shared key isn't a value in `property.api_key`, so the DB lookup finds nothing.

- [ ] **Step 7: Verify — wrong/missing key and no-auth-at-all still 401 correctly**

```bash
echo "--- wrong key ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: not-a-real-key" -d '{"first_name":"No","last_name":"Match","email":"no.match@example.com"}'

echo "--- no auth at all ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -d '{"first_name":"No","last_name":"Auth","email":"no.auth@example.com"}'
```
Expected both: `401 {"error":"Missing or invalid Authorization header or X-Api-Key"}`.

- [ ] **Step 8: Verify — `requireApiKey`-gated routes (out of scope) are unaffected**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa -H "X-Api-Key: $OLD_SHARED_KEY"
```
Expected: this route doesn't even have a `GET /`, so you'll get Express's default 404 for an unmatched route — that's fine, the point is it doesn't 401 on the key itself. To actually confirm `requireApiKey` still accepts the old shared key, use a route that has one:
```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" -d '{}'
```
Expected: NOT a `401` about the key (you should get a `400` for missing required fields, e.g. `name` — proving the key itself was accepted by the untouched `requireApiKey` middleware, confirming this task didn't affect it).

- [ ] **Step 9: Commit**

```bash
git add src/middleware/auth.js
git commit -m "Switch authenticateOrApiKey to per-property api_key lookup"
```

---

### Task 3: Add `GET /api/property/api-key` and `POST /api/property/api-key/rotate`

**Files:**
- Create: `src/controllers/property.js`
- Create: `src/routes/property.js`
- Modify: `src/app.js:8-23` (route imports) and `src/app.js:33-49` (route mounting)

**Interfaces:**
- Consumes: `pool` from `src/db/index.js`, `authenticate` and `requireRole` from `src/middleware/auth.js` (both already exported), Node's built-in `crypto`.
- Produces: `GET /api/property/api-key` → `{ api_key: string }`; `POST /api/property/api-key/rotate` → `{ api_key: string }` (the new value). Nothing else in this plan depends on these exports.

- [ ] **Step 1: Write the controller**

Create `src/controllers/property.js`:

```js
const crypto = require('crypto');
const pool = require('../db');

function generateApiKey() {
  return 'prop_' + crypto.randomBytes(32).toString('hex');
}

async function getApiKey(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT api_key FROM property WHERE id = $1', [req.property_id]);
    res.json({ api_key: rows[0].api_key });
  } catch (err) {
    next(err);
  }
}

async function rotateApiKey(req, res, next) {
  try {
    const api_key = generateApiKey();
    const { rows } = await pool.query(
      'UPDATE property SET api_key = $1 WHERE id = $2 RETURNING api_key',
      [api_key, req.property_id]
    );
    res.json({ api_key: rows[0].api_key });
  } catch (err) {
    next(err);
  }
}

module.exports = { getApiKey, rotateApiKey };
```

- [ ] **Step 2: Write the route**

Create `src/routes/property.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);

module.exports = router;
```

- [ ] **Step 3: Mount it in `app.js`**

In `src/app.js`, replace:

```js
const proshopRoutes = require('./routes/proshop');

const app = express();
```

with:

```js
const proshopRoutes = require('./routes/proshop');
const propertyRoutes = require('./routes/property');

const app = express();
```

Then replace:

```js
app.use('/api/proshop', proshopRoutes);

app.use(errorHandler);
```

with:

```js
app.use('/api/proshop', proshopRoutes);
app.use('/api/property', propertyRoutes);

app.use(errorHandler);
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`. `nodemon` restarts automatically on the file changes above.

- [ ] **Step 5: Verify — no token at all is rejected**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/property/api-key
```
Expected: `401 {"error":"Missing or invalid Authorization header"}`.

- [ ] **Step 6: Mint a real Clerk session token for Robs's admin (self-service — no human hand-off needed)**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
client.signInTokens.createSignInToken({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn', expiresInSeconds: 3600 })
  .then(t => console.log(t.url))
  .catch(e => console.error('ERR:', e.message));
"
```
This prints a URL like `https://valid-oriole-82.accounts.dev/sign-in?__clerk_ticket=...`.

1. Use your browser automation tool (e.g. chrome-devtools MCP, Playwright MCP) to open a new page and navigate to that exact URL.
2. Take a page snapshot. If it shows a "Choose an organization" screen listing "Robs", click that org's button. (If it redirects straight through instead, the org was already active — proceed either way.)
3. Evaluate this JavaScript on the page to get a fresh token:
```js
async () => {
  await window.Clerk.load();
  const token = await window.Clerk.session.getToken({ skipCache: true });
  return { token, userId: window.Clerk.user?.id, orgId: window.Clerk.organization?.id };
}
```
This is a real, valid, org-scoped session token. **It expires in ~60 seconds** — capture it and run the next steps immediately, back-to-back. If a step below unexpectedly 401s where success was expected, mint a fresh token (repeat this step) and retry before treating it as a real failure.

- [ ] **Step 7: Verify — `GET /api/property/api-key` returns Robs's key**

```bash
CLERK_TOKEN="<the token from Step 6>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/property/api-key -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `200`, `{"api_key":"prop_..."}` — matches the value from Task 2 Step 3 (Robs's key hasn't been rotated yet). Save it as `OLD_ROTATE_KEY`.

- [ ] **Step 8: Verify — `POST /api/property/api-key/rotate` returns a new key, and the old one stops working**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/property/api-key/rotate -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `200`, `{"api_key":"prop_..."}` — a **different** value from `OLD_ROTATE_KEY`. Save it as `NEW_ROTATE_KEY`.

```bash
echo "--- old key should now fail ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $OLD_ROTATE_KEY" -d '{"first_name":"Old","last_name":"Key","email":"old.key@example.com"}'

echo "--- new key should work ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $NEW_ROTATE_KEY" -d '{"first_name":"New","last_name":"Key","email":"new.key@example.com"}'
```
Expected: old key → `401`; new key → `201` with `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"`.

- [ ] **Step 9: Verify — a non-admin role is rejected with 403**

Robs currently has only one member (`org:admin`), so a real non-admin token isn't available without inviting a second member — out of scope to set up here. Instead, confirm by reading the code: `requireRole('admin')` (`src/middleware/auth.js`) returns `403 {"error":"Insufficient permissions"}` whenever `req.user.role !== 'admin'`, and `req.user.role` is set by `mapClerkRole`, which maps anything other than Clerk's `admin` org role to `"staff"`. Note in your task report that this specific case (403 for a real non-admin token) was verified by code inspection, not a live request — this is a real gap in end-to-end coverage if left there long-term, but is not blocking for this task.

- [ ] **Step 10: Commit**

```bash
git add src/controllers/property.js src/routes/property.js src/app.js
git commit -m "Add GET/POST /api/property/api-key (view + rotate, admin-only)"
```

---

### Task 4: Update Swagger docs

**Files:**
- Modify: `src/docs/swagger.js:13-30` (`tags`)
- Modify: `src/docs/swagger.js:161-163` (insert new paths after `/api/auth/me`)
- Modify: `src/docs/swagger.js:188` (`/api/guests` POST `property_id` description)
- Modify: `src/docs/swagger.js:198` (`/api/guests/lookup` GET `property_id` description)
- Modify: `src/docs/swagger.js:247` (`/api/bookings` POST `property_id` description)
- Modify: `src/docs/swagger.js:284` (`/api/restaurant/{restaurant_id}/reservations` POST `property_id` description)

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (documentation only, doesn't affect runtime behavior).
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Add the `Property` tag**

Replace:

```js
  tags: [
    { name: 'Auth' },
    { name: 'Guests' },
```

with:

```js
  tags: [
    { name: 'Auth' },
    { name: 'Property' },
    { name: 'Guests' },
```

- [ ] **Step 2: Document the two new paths**

Replace:

```js
    // ── Auth ────────────────────────────────────────────────────────────────
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Get the current property and role, resolved from the Clerk session token', responses: { 200: { description: 'Object with property_id and role', content: { 'application/json': { schema: { type: 'object', properties: { property_id: { type: 'string', format: 'uuid' }, role: { type: 'string', enum: ['admin', 'staff'] } } } } } } } },
    },

    // ── Guests ──────────────────────────────────────────────────────────────
```

with:

```js
    // ── Auth ────────────────────────────────────────────────────────────────
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Get the current property and role, resolved from the Clerk session token', responses: { 200: { description: 'Object with property_id and role', content: { 'application/json': { schema: { type: 'object', properties: { property_id: { type: 'string', format: 'uuid' }, role: { type: 'string', enum: ['admin', 'staff'] } } } } } } } },
    },

    // ── Property ────────────────────────────────────────────────────────────
    '/api/property/api-key': {
      get: { tags: ['Property'], summary: "Get the current property's API key (admin only)", responses: { 200: { description: 'API key', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/rotate': {
      post: { tags: ['Property'], summary: "Rotate the current property's API key (admin only) — the old key stops working immediately", responses: { 200: { description: 'New API key', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },

    // ── Guests ──────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Update the `/api/guests` POST `property_id` description**

Replace:

```js
                  property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Guest created' } },
      },
    },
    '/api/guests/lookup': {
```

with:

```js
                  property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Guest created' } },
      },
    },
    '/api/guests/lookup': {
```

- [ ] **Step 4: Update the `/api/guests/lookup` GET `property_id` description**

Replace:

```js
    '/api/guests/lookup': {
      get: { tags: ['Guests'], summary: 'Look up guest by email', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } }, { name: 'property_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' }], responses: { 200: { description: 'Guest found' }, 404: { description: 'Guest not found' } } },
    },
```

with:

```js
    '/api/guests/lookup': {
      get: { tags: ['Guests'], summary: 'Look up guest by email', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } }, { name: 'property_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' }], responses: { 200: { description: 'Guest found' }, 404: { description: 'Guest not found' } } },
    },
```

- [ ] **Step 5: Update the `/api/bookings` POST `property_id` description**

Replace (this is one long line — find it by the unique `guest_id, check_in, check_out` required-fields fragment):

```js
      post: { tags: ['Bookings'], summary: 'Create booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid', description: 'Exactly one of room_id or room_type_id is required.' }, room_type_id: { type: 'string', format: 'uuid', description: 'Alternative to room_id: books the first available room of this type. Exactly one of room_id or room_type_id is required.' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } }, property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room (or room type) not available' } } },
```

with:

```js
      post: { tags: ['Bookings'], summary: 'Create booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid', description: 'Exactly one of room_id or room_type_id is required.' }, room_type_id: { type: 'string', format: 'uuid', description: 'Alternative to room_id: books the first available room of this type. Exactly one of room_id or room_type_id is required.' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } }, property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room (or room type) not available' } } },
```

- [ ] **Step 6: Update the `/api/restaurant/{restaurant_id}/reservations` POST `property_id` description**

Replace (find by the unique `reservation_date, start_time, contact_name, party_size` required-fields fragment):

```js
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
```

with:

```js
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
```

- [ ] **Step 7: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log('tags include Property:', j.tags.some(t => t.name === 'Property'));
  console.log('has GET /api/property/api-key:', !!j.paths['/api/property/api-key']?.get);
  console.log('has POST /api/property/api-key/rotate:', !!j.paths['/api/property/api-key/rotate']?.post);
  console.log('guests POST property_id desc:', j.paths['/api/guests'].post.requestBody.content['application/json'].schema.properties.property_id.description);
  console.log('bookings POST property_id desc:', j.paths['/api/bookings'].post.requestBody.content['application/json'].schema.properties.property_id.description);
});
"
```
Expected: `tags include Property: true`; both `has ...` lines `true`; both description lines start with `Ignored.`.

- [ ] **Step 8: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document per-property API keys in Swagger"
```

---

### Task 5: Migrate and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-4's commits and `src/db/migrate-2026-08-09-property-api-key.sql`.

- [ ] **Step 1: Confirm with the user before altering the live schema**

Per Global Constraints — this runs `ALTER TABLE` against production.

- [ ] **Step 2: Apply the migration to the live database**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-09-property-api-key.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify every live property has a key**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const { rows } = await pool.query('SELECT id, name, api_key FROM property ORDER BY name');
  const nullCount = rows.filter(r => !r.api_key).length;
  const distinctCount = new Set(rows.map(r => r.api_key)).size;
  console.log('rows:', rows.length, '| null keys:', nullCount, '| distinct keys:', distinctCount);
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `null keys: 0`, `distinct keys:` equal to `rows:`.

- [ ] **Step 4: Confirm with the user before pushing**

Per Global Constraints — this triggers a live Render redeploy of actual code (unlike Step 2's data-only migration).

- [ ] **Step 5: Push**

```bash
git push origin main
```

- [ ] **Step 6: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log(j.paths['/api/property/api-key'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually prints `READY`.

- [ ] **Step 7: Mint a live Clerk session token for FORGE's admin**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const dotenv = require('dotenv');
const parsed = dotenv.parse(fs.readFileSync('.env'));
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: parsed['old-CLERK_SECRET_KEY'] });
client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })
  .then(t => console.log(t.url))
  .catch(e => console.error('ERR:', e.message));
"
```
Same self-service flow as Task 3 Step 6 (browser tool → navigate → pick "FORGE" if prompted → evaluate the same `window.Clerk.session.getToken({ skipCache: true })` snippet). Capture as `LIVE_CLERK_TOKEN` and use it immediately (~60 second expiry).

- [ ] **Step 8: Verify live — view and rotate FORGE's key**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/property/api-key -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
```
Expected: `200`, `{"api_key":"prop_..."}`. Save as `LIVE_OLD_KEY`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/property/api-key/rotate -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
```
Expected: `200`, a different `{"api_key":"prop_..."}`. Save as `LIVE_NEW_KEY`.

- [ ] **Step 9: Verify live — old key rejected, new key works end-to-end on `POST /api/guests`**

```bash
echo "--- old live key should now fail ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $LIVE_OLD_KEY" -d '{"first_name":"Old","last_name":"LiveKey","email":"old.livekey@example.com"}'

echo "--- new live key should work ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $LIVE_NEW_KEY" -d '{"first_name":"New","last_name":"LiveKey","email":"new.livekey@example.com"}'
```
Expected: old key → `401`; new key → `201` with `"property_id":"b7a4c969-5e82-4c26-a587-17d2ab74858e"` (FORGE).

- [ ] **Step 10: No further action** — this task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
