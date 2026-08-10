# MCP Server for Staff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden per-property API-key auth to cover the routes a staff-facing MCP server needs, add an instant on/off switch for a property's key, and ship a local `stdio` MCP server exposing 15 tools over the guest/booking/room lifecycle — per `docs/superpowers/specs/2026-08-10-mcp-server-design.md`.

**Architecture:** Part A (Tasks 1-2) extends the existing `authenticateOrApiKey` middleware's reach: a new `property.api_key_enabled` flag gates every API-key request, and 4 route files switch from Clerk-only `authenticate` to `authenticateOrApiKey`. Part B (Task 3) is a new `mcp-server/` directory — `apiClient.js` (fetch wrapper), `tools.js` (15 tool definitions), `index.js` (bootstraps `@modelcontextprotocol/sdk`'s `McpServer` over `StdioServerTransport`) — that talks to this same REST API using one property's API key.

**Tech Stack:** Node/Express, `pg`, `@clerk/backend` (unchanged), `@modelcontextprotocol/sdk` (new, `^1.30.0`, already installed), `zod` (new, already installed), Node's built-in `fetch`.

## Global Constraints

- **No automated test framework.** Every "verify" step is a manual check — `curl`/`node -e` for Part A (matching every prior plan in this project), and a small `node`-based MCP client script for Part B (spawns the server via `StdioClientTransport`, calls `listTools`/`callTool` — the closest thing to a test harness this project has for MCP, and the SDK confirmed installed and working via a throwaway smoke test during planning).
- **Two databases:** local Postgres (`hotel_booking`, `DATABASE_URL`) and the live Render/Neon database (`DATABASE_URL_LIVE` in local `.env`).
- **Confirm with the user before**: running the migration against the live database, and before `git push origin main` (triggers a live Render redeploy).
- Today's date: **2026-08-10**.
- **`.env`'s `CLERK_SECRET_KEY` is the DEV Clerk instance's key.** The LIVE instance's secret key is under `old-CLERK_SECRET_KEY` in the same `.env` — read via `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, not `process.env`.
- **Test identities:**
  - Local/dev: property **"Robs"** (`a3e548af-a71d-46c0-ba61-f1f702e495be`), Clerk user `robooko7@gmail.com` → dev user id `user_3C7aK7SeaIKBPlgtuekEpSWhifn`, `org:admin`. **Minting a Clerk token for this user**: `client.sessions.createSession({ userId })` + `client.sessions.getToken(session.id)` via `@clerk/backend` works directly (no browser needed) *only on the dev instance* — confirmed working this session. Tokens expire in ~60 seconds; mint immediately before use, ideally in the same shell invocation as the curl call that uses it.
  - Live: property **"FORGE"** (`b7a4c969-5e82-4c26-a587-17d2ab74858e`), same email → live user id `user_3CLBg0yYT3odh00x09a2KnPiGr3`, `org:admin`. **The `sessions.createSession` shortcut does NOT work on live** (`"Request only valid for development instances"`, confirmed this session) — live token minting needs the browser-based sign-in-ticket flow (see the per-property-API-key and restaurant-service-periods plans for the exact recipe) via a chrome-devtools or Playwright MCP tool. If neither is connected when Task 4 runs, stop and ask the user how to proceed rather than skipping live verification silently.
  - Robs's current `api_key` and FORGE's current `api_key` should be looked up fresh at execution time (`SELECT api_key FROM property WHERE id = ...`) — they've been rotated multiple times in prior sessions, any previously-recorded value is stale.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`. `nodemon` does not auto-restart a crashed process — if it's not responding, start it fresh (`npm run dev`, background).
- **Scope:** exactly the routes and tools listed in the design doc. Do not add MCP tools for restaurant/spa/golf/tours/equipment/proshop/room-service/beach-club/payments/extras, and do not add per-user/role granularity to API-key auth — both explicitly out of scope.

---

### Task 1: `property.api_key_enabled` kill switch

**Files:**
- Create: `src/db/migrate-2026-08-10-property-api-key-enabled.sql`
- Modify: `src/db/schema.sql:9-16` (the `property` table)
- Modify: `src/middleware/auth.js:70-72` (`authenticateOrApiKey`'s DB lookup)
- Modify: `src/controllers/property.js` (add `disableApiKey`, `enableApiKey`; `getApiKey` gains `api_key_enabled` in its response)
- Modify: `src/routes/property.js` (two new routes)
- Modify: `src/docs/swagger.js:166-172` (Property paths)

**Interfaces:**
- Consumes: `pool` from `src/db/index.js` (already imported in `property.js`), `requireRole`/`authenticate` from `src/middleware/auth.js` (already imported in `routes/property.js`).
- Produces: `property.api_key_enabled` column, checked by `authenticateOrApiKey` and by Task 2's `searchAvailability` change. `disableApiKey`/`enableApiKey` exported from `src/controllers/property.js` — nothing else in this plan calls them directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-10-property-api-key-enabled.sql`:

```sql
-- One-time migration: add property.api_key_enabled, an instant on/off
-- switch for a property's API key independent of rotation (disabling
-- doesn't change the key value; re-enabling restores access with the
-- same key). Checked by authenticateOrApiKey in src/middleware/auth.js.
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS api_key_enabled BOOLEAN NOT NULL DEFAULT true;
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

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

with:

```sql
-- Properties (tenants)
CREATE TABLE IF NOT EXISTS property (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) NOT NULL,
  status           VARCHAR(20)  DEFAULT 'active',
  clerk_org_id     VARCHAR(255) UNIQUE,
  api_key          TEXT UNIQUE,
  api_key_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ  DEFAULT now()
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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-10-property-api-key-enabled.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify every property defaulted to enabled**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows } = await pool.query('SELECT id, name, api_key_enabled FROM property ORDER BY name');
  console.log(JSON.stringify(rows, null, 2));
  console.log('all enabled:', rows.every(r => r.api_key_enabled === true));
  await pool.end();
})();
"
```
Expected: `all enabled: true`.

- [ ] **Step 5: Update the `authenticateOrApiKey` lookup**

In `src/middleware/auth.js`, replace:

```js
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

with:

```js
  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true', [key]);
    if (!rows.length) return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
    req.property_id = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 6: Add `disableApiKey`/`enableApiKey` and update `getApiKey`**

Replace the full contents of `src/controllers/property.js`:

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

with:

```js
const crypto = require('crypto');
const pool = require('../db');

function generateApiKey() {
  return 'prop_' + crypto.randomBytes(32).toString('hex');
}

async function getApiKey(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT api_key, api_key_enabled FROM property WHERE id = $1', [req.property_id]);
    res.json(rows[0]);
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

async function disableApiKey(req, res, next) {
  try {
    const { rows } = await pool.query(
      'UPDATE property SET api_key_enabled = false WHERE id = $1 RETURNING api_key, api_key_enabled',
      [req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function enableApiKey(req, res, next) {
  try {
    const { rows } = await pool.query(
      'UPDATE property SET api_key_enabled = true WHERE id = $1 RETURNING api_key, api_key_enabled',
      [req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { getApiKey, rotateApiKey, disableApiKey, enableApiKey };
```

- [ ] **Step 7: Wire the two new routes**

Replace the full contents of `src/routes/property.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);
router.post('/api-key/disable', authenticate, requireRole('admin'), ctrl.disableApiKey);
router.post('/api-key/enable', authenticate, requireRole('admin'), ctrl.enableApiKey);

module.exports = router;
```

- [ ] **Step 8: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 9: Mint a Robs admin token and get Robs's current key**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
cat /tmp/tok.txt
```

- [ ] **Step 10: Verify `GET /api/property/api-key` now includes `api_key_enabled`**

```bash
CLERK_TOKEN=$(cat /tmp/tok.txt)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/property/api-key -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `200 {"api_key":"prop_...","api_key_enabled":true}`.

- [ ] **Step 11: Verify disable → key stops working → enable → key works again (same value throughout)**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)

echo "--- key works before disable ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"first_name":"Pre","last_name":"Disable","email":"pre.disable@example.com"}'

node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- disable ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/property/api-key/disable -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- key rejected after disable (same message as a wrong key) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"first_name":"During","last_name":"Disable","email":"during.disable@example.com"}'
```
Expected: pre-disable → `201`; disable → `200 {"api_key":"...","api_key_enabled":false}` (same key value as Step 10); post-disable guest creation → `401 {"error":"Missing or invalid Authorization header or X-Api-Key"}`.

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- enable ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/property/api-key/enable -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- same key works again ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"first_name":"Post","last_name":"Enable","email":"post.enable@example.com"}'
```
Expected: enable → `200 {"api_key":"...","api_key_enabled":true}`; guest creation → `201` — proves the *same* `ROBS_KEY` value works again, no rotation needed.

- [ ] **Step 12: Document the two new endpoints and the `api_key_enabled` field in Swagger**

Replace:

```js
    // ── Property ────────────────────────────────────────────────────────────
    '/api/property/api-key': {
      get: { tags: ['Property'], summary: "Get the current property's API key (admin only)", responses: { 200: { description: 'API key', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/rotate': {
      post: { tags: ['Property'], summary: "Rotate the current property's API key (admin only) — the old key stops working immediately", responses: { 200: { description: 'New API key', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
```

with:

```js
    // ── Property ────────────────────────────────────────────────────────────
    '/api/property/api-key': {
      get: { tags: ['Property'], summary: "Get the current property's API key (admin only)", responses: { 200: { description: 'API key and enabled state', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' }, api_key_enabled: { type: 'boolean' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/rotate': {
      post: { tags: ['Property'], summary: "Rotate the current property's API key (admin only) — the old key stops working immediately", responses: { 200: { description: 'New API key', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/disable': {
      post: { tags: ['Property'], summary: "Disable the current property's API key without rotating it (admin only)", responses: { 200: { description: 'Current key and enabled state (false)', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' }, api_key_enabled: { type: 'boolean' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/enable': {
      post: { tags: ['Property'], summary: "Re-enable the current property's API key (admin only) — restores access using the same key value", responses: { 200: { description: 'Current key and enabled state (true)', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' }, api_key_enabled: { type: 'boolean' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
```

- [ ] **Step 13: Verify Swagger**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log('has disable:', !!j.paths['/api/property/api-key/disable']?.post);
  console.log('has enable:', !!j.paths['/api/property/api-key/enable']?.post);
  console.log('GET api-key has api_key_enabled prop:', 'api_key_enabled' in j.paths['/api/property/api-key'].get.responses[200].content['application/json'].schema.properties);
});
"
```
Expected: all three `true`.

- [ ] **Step 14: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_key.txt
git add src/db/schema.sql src/db/migrate-2026-08-10-property-api-key-enabled.sql src/middleware/auth.js src/controllers/property.js src/routes/property.js src/docs/swagger.js
git commit -m "Add property.api_key_enabled kill switch (disable/enable endpoints)"
```

---

### Task 2: Broaden `authenticateOrApiKey` to rooms, room types, bookings, availability

**Files:**
- Modify: `src/routes/rooms.js`
- Modify: `src/routes/roomTypes.js`
- Modify: `src/routes/bookings.js`
- Modify: `src/routes/availability.js`
- Modify: `src/controllers/availability.js:63-79` (`searchAvailability`)

**Interfaces:**
- Consumes: `authenticateOrApiKey` from `src/middleware/auth.js` (Task 1's version, with the `api_key_enabled` check).
- Produces: no new exports — existing routes just accept a second auth method. Task 3's MCP tools call these routes.

- [ ] **Step 1: Broaden `rooms.js`**

Replace the full contents of `src/routes/rooms.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listRooms);
router.get('/:id', authenticate, ctrl.getRoom);
router.post('/', authenticate, ctrl.createRoom);
router.put('/:id', authenticate, ctrl.updateRoom);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listRooms);
router.get('/:id', authenticate, ctrl.getRoom);
router.post('/', authenticateOrApiKey, ctrl.createRoom);
router.put('/:id', authenticateOrApiKey, ctrl.updateRoom);

module.exports = router;
```

- [ ] **Step 2: Broaden `roomTypes.js`**

Replace the full contents of `src/routes/roomTypes.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listRoomTypes);
router.get('/:id', authenticate, ctrl.getRoomType);
router.post('/', authenticate, ctrl.createRoomType);
router.put('/:id', authenticate, ctrl.updateRoomType);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listRoomTypes);
router.get('/:id', authenticate, ctrl.getRoomType);
router.post('/', authenticateOrApiKey, ctrl.createRoomType);
router.put('/:id', authenticateOrApiKey, ctrl.updateRoomType);

module.exports = router;
```

- [ ] **Step 3: Broaden `bookings.js`**

Replace the full contents of `src/routes/bookings.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticate, ctrl.cancelBooking);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listBookings);
router.get('/:id', authenticateOrApiKey, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticateOrApiKey, ctrl.cancelBooking);

module.exports = router;
```

- [ ] **Step 4: Broaden `availability.js`'s bulk-upsert route**

Replace:

```js
router.put('/rooms/:room_id', authenticate, ctrl.upsertRoomAvailability);
```

with:

```js
router.put('/rooms/:room_id', authenticateOrApiKey, ctrl.upsertRoomAvailability);
```

And update the import line — replace:

```js
const { authenticate } = require('../middleware/auth');
```

with:

```js
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');
```

- [ ] **Step 5: `searchAvailability` — resolve `property_id` from `X-Api-Key` when present**

In `src/controllers/availability.js`, replace:

```js
async function searchAvailability(req, res, next) {
  try {
    const { check_in, check_out, guests, property_id } = req.query;

    if (!check_in || !check_out || !guests || !property_id) {
      return res.status(400).json({ error: 'check_in, check_out, guests, and property_id are required' });
    }
    if (!isValidUuid(property_id)) {
      return res.status(400).json({ error: 'Invalid property_id' });
    }
```

with:

```js
async function searchAvailability(req, res, next) {
  try {
    const { check_in, check_out, guests } = req.query;
    let { property_id } = req.query;

    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true', [apiKey]);
      if (rows.length) property_id = rows[0].id;
    }

    if (!check_in || !check_out || !guests || !property_id) {
      return res.status(400).json({ error: 'check_in, check_out, guests, and property_id are required (or supply a valid X-Api-Key)' });
    }
    if (!isValidUuid(property_id)) {
      return res.status(400).json({ error: 'Invalid property_id' });
    }
```

- [ ] **Step 6: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 7: Get Robs's current key**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
cat /tmp/robs_key.txt
```

- [ ] **Step 8: Verify each newly-eligible route accepts the API key**

```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)

echo "--- list rooms ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/rooms -H "X-Api-Key: $ROBS_KEY"

echo "--- list room types ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/room-types -H "X-Api-Key: $ROBS_KEY"

echo "--- list bookings ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/bookings -H "X-Api-Key: $ROBS_KEY"

echo "--- create room type ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/room-types -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"name":"MCP Test Type","max_occupancy":2,"base_rate":100}'
```
Expected: all `200`/`201` — no `401`s. Save the created room type's `id` as `TEST_ROOM_TYPE_ID`.

- [ ] **Step 9: Verify wrong key still rejected on these same routes**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/rooms -H "X-Api-Key: not-a-real-key"
```
Expected: `401`.

- [ ] **Step 10: Verify `search_availability`'s new `X-Api-Key` path**

```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)

echo "--- with X-Api-Key, no property_id in query ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/availability/search?check_in=2026-09-01&check_out=2026-09-03&guests=2" -H "X-Api-Key: $ROBS_KEY"

echo "--- header wins over a different property_id in the query ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/availability/search?check_in=2026-09-01&check_out=2026-09-03&guests=2&property_id=e1000000-0000-0000-0000-000000000004" -H "X-Api-Key: $ROBS_KEY"

echo "--- unchanged public path: property_id only, no header ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/availability/search?check_in=2026-09-01&check_out=2026-09-03&guests=2&property_id=e1000000-0000-0000-0000-000000000004"
```
Expected: all three `200` (Robs has no bookable rooms yet, so likely an empty array `[]` for the first two, and Bonito's data — non-empty or empty depending on seeded rooms — for the third; the key point is none of the three error, and the first two use Robs's property regardless of the query param, while the third correctly falls back to the query param).

- [ ] **Step 11: Commit**

```bash
rm -f /tmp/robs_key.txt
git add src/routes/rooms.js src/routes/roomTypes.js src/routes/bookings.js src/routes/availability.js src/controllers/availability.js
git commit -m "Broaden authenticateOrApiKey to rooms, room-types, bookings, and availability search/upsert"
```

---

### Task 3: Build the MCP server

**Files:**
- Create: `mcp-server/apiClient.js`
- Create: `mcp-server/tools.js`
- Create: `mcp-server/index.js`
- Create: `mcp-server/verify.js` (manual test client — this project has no automated test framework; this is its closest equivalent for MCP, and stays in the repo as a reusable smoke test)
- Modify: `package.json` (new `"mcp"` script — dependencies already installed)

**Interfaces:**
- Consumes: Task 2's broadened routes, Task 1's `api_key_enabled` (for the disabled-key error-message test), the already-running local API.
- Produces: a runnable `mcp-server/index.js` — nothing else in this plan depends on it (it's the final deliverable).

- [ ] **Step 1: Confirm the SDK dependencies are present**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "console.log(require('./package.json').dependencies['@modelcontextprotocol/sdk'], require('./package.json').dependencies['zod'])"
```
Expected: two version strings printed (both already added to `package.json` during this plan's brainstorming/verification phase — `npm install` was already run, `node_modules` already has them). If either prints `undefined`, run `npm install @modelcontextprotocol/sdk@^1.30.0 zod` before continuing.

- [ ] **Step 2: Write `apiClient.js`**

Create `mcp-server/apiClient.js`:

```js
const BASE_URL = process.env.OTA_BASE_URL;
const API_KEY = process.env.OTA_API_KEY;

if (!BASE_URL) {
  throw new Error('OTA_BASE_URL is required');
}
if (!API_KEY) {
  throw new Error('OTA_API_KEY is required');
}

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(method, path, { query, body } = {}) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Failed to reach the OTA API: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      // non-JSON response body; leave json as null
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, json);
  }
  return json;
}

module.exports = { apiRequest, ApiError };
```

- [ ] **Step 3: Write `tools.js`**

Create `mcp-server/tools.js`:

```js
const { z } = require('zod');
const { apiRequest } = require('./apiClient');

module.exports = [
  {
    name: 'search_availability',
    description: 'Search available room types for a date range and party size',
    inputSchema: {
      check_in: z.string().describe('YYYY-MM-DD'),
      check_out: z.string().describe('YYYY-MM-DD'),
      guests: z.number().int(),
    },
    run: (args) => apiRequest('GET', '/api/availability/search', { query: args }),
  },
  {
    name: 'create_guest',
    description: 'Create a new guest',
    inputSchema: {
      first_name: z.string(),
      last_name: z.string(),
      email: z.string(),
      phone: z.string().optional(),
    },
    run: (args) => apiRequest('POST', '/api/guests', { body: args }),
  },
  {
    name: 'lookup_guest',
    description: 'Look up a guest by email',
    inputSchema: { email: z.string() },
    run: (args) => apiRequest('GET', '/api/guests/lookup', { query: args }),
  },
  {
    name: 'create_booking',
    description: 'Create a booking for a guest, either a specific room or the first available room of a room type',
    inputSchema: {
      guest_id: z.string(),
      room_id: z.string().optional(),
      room_type_id: z.string().optional(),
      check_in: z.string(),
      check_out: z.string(),
      guests: z.number().int().optional(),
      metadata: z.record(z.any()).optional(),
    },
    run: (args) => apiRequest('POST', '/api/bookings', { body: args }),
  },
  {
    name: 'list_bookings',
    description: 'List bookings, optionally filtered by status, guest, or date range',
    inputSchema: {
      status: z.string().optional(),
      guest_id: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    run: (args) => apiRequest('GET', '/api/bookings', { query: args }),
  },
  {
    name: 'get_booking',
    description: 'Get a booking by id',
    inputSchema: { id: z.string() },
    run: ({ id }) => apiRequest('GET', `/api/bookings/${id}`),
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a booking and restore its room availability',
    inputSchema: { id: z.string() },
    run: ({ id }) => apiRequest('DELETE', `/api/bookings/${id}`),
  },
  {
    name: 'list_rooms',
    description: 'List rooms, optionally filtered by room type',
    inputSchema: { room_type_id: z.string().optional() },
    run: (args) => apiRequest('GET', '/api/rooms', { query: args }),
  },
  {
    name: 'create_room',
    description: 'Create a room',
    inputSchema: {
      room_type_id: z.string(),
      room_number: z.string(),
      floor: z.number().int().optional(),
    },
    run: (args) => apiRequest('POST', '/api/rooms', { body: args }),
  },
  {
    name: 'update_room',
    description: 'Update a room',
    inputSchema: {
      id: z.string(),
      room_number: z.string().optional(),
      floor: z.number().int().optional(),
      status: z.enum(['active', 'maintenance', 'inactive']).optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/rooms/${id}`, { body }),
  },
  {
    name: 'list_room_types',
    description: 'List all room types',
    inputSchema: {},
    run: () => apiRequest('GET', '/api/room-types'),
  },
  {
    name: 'create_room_type',
    description: 'Create a room type',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      max_occupancy: z.number().int(),
      base_rate: z.number(),
    },
    run: (args) => apiRequest('POST', '/api/room-types', { body: args }),
  },
  {
    name: 'update_room_type',
    description: 'Update a room type',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      max_occupancy: z.number().int().optional(),
      base_rate: z.number().optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/room-types/${id}`, { body }),
  },
  {
    name: 'upsert_room_availability',
    description: "Bulk set a room's availability and rates for specific dates",
    inputSchema: {
      room_id: z.string(),
      dates: z.array(z.object({
        date: z.string(),
        is_available: z.boolean().optional(),
        override_rate: z.number().optional(),
        block_reason: z.string().optional(),
      })),
    },
    run: ({ room_id, dates }) => apiRequest('PUT', `/api/availability/rooms/${room_id}`, { body: { dates } }),
  },
  {
    name: 'create_restaurant_reservation',
    description: 'Create a restaurant reservation (table auto-assigned)',
    inputSchema: {
      restaurant_id: z.string(),
      reservation_date: z.string(),
      start_time: z.string(),
      location: z.string().optional(),
      guest_id: z.string().optional(),
      clerk_user_id: z.string().optional(),
      contact_name: z.string(),
      contact_email: z.string().optional(),
      contact_phone: z.string().optional(),
      party_size: z.number().int(),
      notes: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    },
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/reservations`, { body }),
  },
];
```

- [ ] **Step 4: Write `index.js`**

Create `mcp-server/index.js`:

```js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const tools = require('./tools');
const { ApiError } = require('./apiClient');

const server = new McpServer({ name: 'ota', version: '1.0.0' });

for (const tool of tools) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
    try {
      const result = await tool.run(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        return { isError: true, content: [{ type: 'text', text: 'API key is invalid, missing, or has been disabled. Contact your property admin.' }] };
      }
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
}

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('Failed to start OTA MCP server:', err);
  process.exit(1);
});
```

- [ ] **Step 5: Add the `mcp` npm script**

In `package.json`, replace:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  },
```

with:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "mcp": "node mcp-server/index.js"
  },
```

- [ ] **Step 6: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 7: Write the verification client**

Create `mcp-server/verify.js`:

```js
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const apiKey = process.env.OTA_API_KEY;
  const baseUrl = process.env.OTA_BASE_URL;
  if (!apiKey || !baseUrl) {
    console.error('Set OTA_API_KEY and OTA_BASE_URL before running this script.');
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'index.js')],
    env: { ...process.env, OTA_API_KEY: apiKey, OTA_BASE_URL: baseUrl },
  });
  const client = new Client({ name: 'ota-mcp-verify', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log('TOOL_COUNT:', tools.length);
  console.log('TOOL_NAMES:', JSON.stringify(tools.map((t) => t.name)));

  console.log('--- create_guest ---');
  const guestResult = await client.callTool({
    name: 'create_guest',
    arguments: { first_name: 'MCP', last_name: 'Verify', email: `mcp.verify.${Date.now()}@example.com` },
  });
  console.log(JSON.stringify(guestResult));
  const guest = JSON.parse(guestResult.content[0].text);

  console.log('--- search_availability (no property_id needed) ---');
  const searchResult = await client.callTool({
    name: 'search_availability',
    arguments: { check_in: '2026-09-01', check_out: '2026-09-03', guests: 2 },
  });
  console.log(JSON.stringify(searchResult));

  console.log('--- list_bookings ---');
  const listResult = await client.callTool({ name: 'list_bookings', arguments: {} });
  console.log(JSON.stringify(listResult));

  console.log('--- create_room_type with missing required field (expect isError) ---');
  const badResult = await client.callTool({
    name: 'create_room_type',
    arguments: { name: 'Bad Type', max_occupancy: 2 },
  });
  console.log(JSON.stringify(badResult));

  console.log('--- get_booking with a fake id (expect isError, Booking not found) ---');
  const notFoundResult = await client.callTool({
    name: 'get_booking',
    arguments: { id: '00000000-0000-0000-0000-000000000000' },
  });
  console.log(JSON.stringify(notFoundResult));

  console.log('GUEST_ID:', guest.id);
  process.exit(0);
}

main().catch((err) => {
  console.error('VERIFY_FAILED', err);
  process.exit(1);
});
```

- [ ] **Step 8: Run it against local**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)
OTA_API_KEY="$ROBS_KEY" OTA_BASE_URL="http://localhost:3000" node mcp-server/verify.js
```
Expected: `TOOL_COUNT: 15`; `TOOL_NAMES` lists all 15 names from Step 3's `tools.js`; `create_guest` result has no `isError` and its `content[0].text` parses to a guest object with `property_id: "a3e548af-a71d-46c0-ba61-f1f702e495be"`; `search_availability` and `list_bookings` both succeed with no `isError` (empty arrays are fine — Robs has no rooms/bookings yet, the point is no error); `create_room_type` (missing the required `base_rate`) → `isError: true`, with an SDK-generated validation message (e.g. `"MCP error -32602: Input validation error..."`) — confirmed this comes back as a normal resolved result with `isError: true`, not a thrown exception, so `verify.js`'s `await client.callTool(...)` doesn't need a try/catch around it; `get_booking` with a fake id → `isError: true`, text containing `"Booking not found"`.

- [ ] **Step 9: Verify the disabled-key error message**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)
curl -s -X POST http://localhost:3000/api/property/api-key/disable -H "Authorization: Bearer $CLERK_TOKEN" > /dev/null

ROBS_KEY=$(cat /tmp/robs_key.txt)
OTA_API_KEY="$ROBS_KEY" OTA_BASE_URL="http://localhost:3000" node -e "
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(process.cwd(), 'mcp-server', 'index.js')], env: process.env });
  const client = new Client({ name: 'disabled-key-check', version: '1.0.0' });
  await client.connect(transport);
  const result = await client.callTool({ name: 'list_rooms', arguments: {} });
  console.log(JSON.stringify(result));
  process.exit(0);
})();
"
```
Expected: `{"isError":true,"content":[{"type":"text","text":"API key is invalid, missing, or has been disabled. Contact your property admin."}]}`.

Re-enable it immediately after (so Robs's key isn't left disabled):
```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)
curl -s -X POST http://localhost:3000/api/property/api-key/enable -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `{"api_key":"...","api_key_enabled":true}`.

- [ ] **Step 10: Verify the network-failure message**

```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)
OTA_API_KEY="$ROBS_KEY" OTA_BASE_URL="http://localhost:1" node -e "
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: [path.join(process.cwd(), 'mcp-server', 'index.js')], env: process.env });
  const client = new Client({ name: 'network-fail-check', version: '1.0.0' });
  await client.connect(transport);
  const result = await client.callTool({ name: 'list_rooms', arguments: {} });
  console.log(JSON.stringify(result));
  process.exit(0);
})();
"
```
Expected: `isError: true`, text starting with `"Failed to reach the OTA API:"` (port `1` should refuse the connection immediately).

- [ ] **Step 11: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_key.txt
git add mcp-server/ package.json
git commit -m "Add local MCP server exposing the guest/booking/room lifecycle as tools"
```

---

### Task 4: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-3's commits.

- [ ] **Step 1: Confirm with the user before altering the live schema**

Per Global Constraints.

- [ ] **Step 2: Apply the migration to the live database**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-10-property-api-key-enabled.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify every live property defaulted to enabled**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const { rows } = await pool.query('SELECT id, name, api_key_enabled FROM property ORDER BY name');
  console.log('all enabled:', rows.every(r => r.api_key_enabled === true), '| count:', rows.length);
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `all enabled: true`.

- [ ] **Step 4: Confirm with the user before pushing**

Per Global Constraints — triggers a live Render redeploy.

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
    console.log(j.paths['/api/property/api-key/disable'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 7: Get FORGE's current key**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
pool.query(\"SELECT api_key FROM property WHERE id = 'b7a4c969-5e82-4c26-a587-17d2ab74858e'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full" > /tmp/forge_key.txt
cat /tmp/forge_key.txt
```

- [ ] **Step 8: Verify Part A on live — a newly-eligible route accepts the API key**

```bash
FORGE_KEY=$(cat /tmp/forge_key.txt)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/rooms -H "X-Api-Key: $FORGE_KEY"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/bookings -H "X-Api-Key: $FORGE_KEY"
```
Expected: both `200`.

- [ ] **Step 9: Verify the kill switch on live**

This needs a Clerk admin token for FORGE, which requires the browser-based sign-in-ticket flow (the dev-only `sessions.createSession` shortcut doesn't work on live — see Global Constraints). Use whichever browser automation MCP tool (chrome-devtools or Playwright) is connected at execution time, following the exact recipe from the per-property-API-key plan's Task 5 Step 7 / the restaurant-service-periods plan's Task 2 Step 7: mint a sign-in ticket via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key, navigate to it with `redirect_url` set to `https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`.

If no browser tool is connected when this step is reached, **stop and ask the user** how to proceed (wait for reconnection, have them supply a token, or skip this specific step) — per this plan's Global Constraints, rather than silently skipping.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"
FORGE_KEY=$(cat /tmp/forge_key.txt)

echo "--- disable ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/property/api-key/disable -H "Authorization: Bearer $LIVE_CLERK_TOKEN"

echo "--- key rejected ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/rooms -H "X-Api-Key: $FORGE_KEY"
```
Expected: disable → `200 {"api_key_enabled":false,...}`; rooms call → `401`.

Re-enable immediately (mint a fresh token if more than ~60s have passed):
```bash
LIVE_CLERK_TOKEN="<fresh token if needed>"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/property/api-key/enable -H "Authorization: Bearer $LIVE_CLERK_TOKEN"

FORGE_KEY=$(cat /tmp/forge_key.txt)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/rooms -H "X-Api-Key: $FORGE_KEY"
```
Expected: enable → `200 {"api_key_enabled":true,...}`; rooms call → `200` again.

- [ ] **Step 10: Verify the MCP server against live**

```bash
FORGE_KEY=$(cat /tmp/forge_key.txt)
OTA_API_KEY="$FORGE_KEY" OTA_BASE_URL="https://ota-u6ii.onrender.com" node mcp-server/verify.js
```
Expected: same shape of output as Task 3 Step 8, but the created guest's `property_id` is `b7a4c969-5e82-4c26-a587-17d2ab74858e` (FORGE) instead of Robs's id.

- [ ] **Step 11: No further action**

```bash
rm -f /tmp/forge_key.txt
```
This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
