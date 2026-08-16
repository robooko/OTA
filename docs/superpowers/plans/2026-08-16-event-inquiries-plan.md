# Event Inquiries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `event_inquiry` table and module (list/create/update, property-scoped, guest-reachable via `X-Api-Key`), publish a `new-inquiry` Ably event on every create, and add a small `GET /api/property/me` the frontend needs to resolve its own property id — per `docs/superpowers/specs/2026-08-16-event-inquiries-design.md`.

**Architecture:** New `event_inquiry` table, indexed on `property_id` like everything else in this schema. `listInquiries`/`createInquiry` use `authenticateOrApiKey` (external sites submit via the property's API key; staff can also list via Clerk); `updateInquiry` is `authenticate`-only (status changes are staff-only). `createInquiry` validates `event_date` with the existing `isValidDate` helper, then does a best-effort Ably publish (`src/lib/ably.js`, new) to `property:{property_id}:inquiries` — failures are logged, never fail the request, since the row is already safely committed. `GET /api/property/me` is a plain identity lookup added to the existing `property.js` controller/routes, giving the frontend a consistent way to resolve `property_id` without introducing Clerk's `org_id` as a second identifier anywhere.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL, `ably` (new dependency).

**Spec:** `docs/superpowers/specs/2026-08-16-event-inquiries-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm start` server, matching every prior plan.
- **Confirm with the user before**: pushing to `origin/main` (triggers a live Render redeploy) and before adding `ABLY_API_KEY` to the live Render environment.
- Today's date: **2026-08-16**.
- **Test identity:** Robs (`a3e548af-a71d-46c0-ba61-f1f702e495be`), Clerk user `robooko7@gmail.com` → dev user id `user_3C7aK7SeaIKBPlgtuekEpSWhifn`, `org:admin`. Mint a token with (no browser needed, dev-instance-only):
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
  "
  ```
  Tokens expire in ~60 seconds — mint fresh immediately before use.
- **Robs's API key**: fetch fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'` — it's been rotated multiple times in prior sessions, don't assume a previously-seen value is current.
- **ABLY_API_KEY**: the same value already sitting in `ota-table-bookings/.env` gets copied into `OTA/.env` for local dev (confirmed with the user rather than assuming — a single Ably key commonly carries both publish and subscribe capability). Read it directly from that file rather than asking the user to retype it.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3` should print `200`. No auto-restart — kill and restart `npm start` (as a background task) after any controller/route/`.env` change.
- **Scope:** exactly `event_inquiry`, the 3 event-inquiries routes, `GET /api/property/me`, and `src/lib/ably.js`. No change to any other module.

---

### Task 1: Migration — create `event_inquiry`

**Files:**
- Create: `src/db/migrate-2026-08-16-event-inquiries.sql`
- Modify: `src/db/schema.sql`

**Interfaces:**
- Produces: `event_inquiry` table (`id`, `property_id`, `name`, `email`, `phone`, `event_date`, `guests`, `event_type`, `format`, `message`, `status`, `created_at`) — Task 3's controller queries it directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-16-event-inquiries.sql`:

```sql
-- One-time migration: creates event_inquiry, a new table (not an
-- addition to an existing one), so there's no backfill concern at
-- all -- CREATE TABLE IF NOT EXISTS is inherently idempotent-safe.

CREATE TABLE IF NOT EXISTS event_inquiry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID         NOT NULL REFERENCES property(id),
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  phone        VARCHAR(30),
  event_date   DATE         NOT NULL,
  guests       INT,
  event_type   VARCHAR(50),
  format       VARCHAR(50),
  message      TEXT,
  status       VARCHAR(20)  NOT NULL DEFAULT 'new',
  created_at   TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_property ON event_inquiry(property_id);
```

- [ ] **Step 2: Add to `schema.sql`**

This is a brand new table, not a modification to an existing one, so
just append it near the end of the file (after the Pro Shop section,
before the closing indexes if any trail it — match wherever the file's
last `CREATE TABLE`/`CREATE INDEX` pair currently sits):

```sql
-- ── Event Inquiries ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_inquiry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID         NOT NULL REFERENCES property(id),
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  phone        VARCHAR(30),
  event_date   DATE         NOT NULL,
  guests       INT,
  event_type   VARCHAR(50),
  format       VARCHAR(50),
  message      TEXT,
  status       VARCHAR(20)  NOT NULL DEFAULT 'new',
  created_at   TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_property ON event_inquiry(property_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-event-inquiries.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify the table and its constraints**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'event_inquiry' ORDER BY ordinal_position\");
  console.log(JSON.stringify(cols.rows, null, 2));
  try {
    await pool.query(\"INSERT INTO event_inquiry (name, email, event_date) VALUES ('Bad Row', 'x@example.com', '2026-10-01')\");
    console.log('UNEXPECTED: insert without property_id succeeded');
  } catch (e) {
    console.log('Expected rejection:', e.message);
  }
  await pool.end();
})();
"
```
Expected: columns listed matching the spec's shape, `property_id`/`name`/`email`/`event_date` all `is_nullable: 'NO'`; the insert attempt fails on the missing `property_id`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-16-event-inquiries.sql
git commit -m "Add event_inquiry table"
```

---

### Task 2: `GET /api/property/me`

**Files:**
- Modify: `src/routes/property.js`
- Modify: `src/controllers/property.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate` from `src/middleware/auth.js` (unchanged).
- Produces: `GET /api/property/me` → `{ id, name }` — the frontend's Ably token-minting endpoint (separate repo, later plan) calls this directly.

- [ ] **Step 1: Add the route**

Replace the full contents of `src/routes/property.js`:

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

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/me', authenticate, ctrl.getCurrentProperty);

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);
router.post('/api-key/disable', authenticate, requireRole('admin'), ctrl.disableApiKey);
router.post('/api-key/enable', authenticate, requireRole('admin'), ctrl.enableApiKey);

module.exports = router;
```

- [ ] **Step 2: Add the controller function**

Replace the full contents of `src/controllers/property.js`:

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

with:

```js
const crypto = require('crypto');
const pool = require('../db');

function generateApiKey() {
  return 'prop_' + crypto.randomBytes(32).toString('hex');
}

async function getCurrentProperty(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id, name FROM property WHERE id = $1', [req.property_id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
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

module.exports = { getCurrentProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey };
```

- [ ] **Step 3: Update Swagger**

Replace:

```js
    // ── Property ────────────────────────────────────────────────────────────
    '/api/property/api-key': {
```

with:

```js
    // ── Property ────────────────────────────────────────────────────────────
    '/api/property/me': {
      get: { tags: ['Property'], summary: 'Get the current property (id, name)', responses: { 200: { description: 'Property identity', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } } } } } } },
    },
    '/api/property/api-key': {
```

- [ ] **Step 4: Restart the local server, confirm it's up**

Find and kill whatever `node src/server.js` process is currently listening on port 3000, then start it fresh with `npm start` (as a background task), then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify `GET /api/property/me`**

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
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/property/me

echo "--- with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/property/me -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401`; with token → `200`, `{"id":"a3e548af-a71d-46c0-ba61-f1f702e495be","name":"<Robs's property name>"}`.

- [ ] **Step 6: Commit**

```bash
rm -f /tmp/tok.txt
git add src/routes/property.js src/controllers/property.js src/docs/swagger.js
git commit -m "Add GET /api/property/me"
```

---

### Task 3: Event inquiries CRUD + Ably publish

**Files:**
- Create: `src/controllers/eventInquiries.js`
- Create: `src/routes/eventInquiries.js`
- Create: `src/lib/ably.js`
- Modify: `src/app.js`
- Modify: `src/docs/swagger.js`
- Modify: `package.json` (add `ably` dependency)
- Modify: `.env` (add `ABLY_API_KEY`)

**Interfaces:**
- Consumes: `authenticate`/`authenticateOrApiKey` from `src/middleware/auth.js`, `isValidDate` from `src/middleware/validate.js`, `event_inquiry` table from Task 1.
- Produces: `GET/POST /api/event-inquiries`, `PUT /api/event-inquiries/:id`; `publishNewInquiry(propertyId, inquiry)` from `src/lib/ably.js`.

- [ ] **Step 1: Install `ably`**

```bash
cd "c:\Users\robert\source\repos\OTA" && npm install ably
```
Expected: `package.json`'s `dependencies` gains an `"ably": "^x.x.x"` entry, `package-lock.json` updates.

- [ ] **Step 2: Add `ABLY_API_KEY` to `.env`**

Read the exact value from `c:\Users\robert\source\repos\ota-table-bookings\.env`'s `ABLY_API_KEY` line and add the identical line to `c:\Users\robert\source\repos\OTA\.env`. Do not commit `.env` (it's already gitignored, matching every other secret in this file) — this step only touches the local file, nothing to stage.

- [ ] **Step 3: Create `src/lib/ably.js`**

```js
const Ably = require('ably');

const client = process.env.ABLY_API_KEY ? new Ably.Rest({ key: process.env.ABLY_API_KEY }) : null;

async function publishNewInquiry(propertyId, inquiry) {
  if (!client) return; // no key configured -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-inquiry', inquiry);
}

module.exports = { publishNewInquiry };
```

- [ ] **Step 4: Create `src/controllers/eventInquiries.js`**

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewInquiry } = require('../lib/ably');

async function listInquiries(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM event_inquiry WHERE property_id = $1 ORDER BY created_at DESC',
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createInquiry(req, res, next) {
  try {
    const { name, email, phone, event_date, guests, event_type, format, message } = req.body;
    if (!name || !email || !event_date) {
      return res.status(400).json({ error: 'name, email, and event_date are required' });
    }
    if (!isValidDate(event_date)) return res.status(400).json({ error: 'Invalid date format' });

    const { rows } = await pool.query(
      `INSERT INTO event_inquiry (property_id, name, email, phone, event_date, guests, event_type, format, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, name, email, phone || null, event_date, guests || null, event_type || null, format || null, message || null]
    );

    publishNewInquiry(req.property_id, rows[0]).catch((err) => console.error('Ably publish failed:', err.message));

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateInquiry(req, res, next) {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      `UPDATE event_inquiry SET status = COALESCE($1, status) WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { listInquiries, createInquiry, updateInquiry };
```

- [ ] **Step 5: Create `src/routes/eventInquiries.js`**

```js
const router = require('express').Router();
const ctrl = require('../controllers/eventInquiries');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticate, ctrl.updateInquiry);

module.exports = router;
```

- [ ] **Step 6: Register the route in `app.js`**

Replace:

```js
const propertyRoutes = require('./routes/property');
const mcpRoutes = require('./routes/mcp');
```

with:

```js
const propertyRoutes = require('./routes/property');
const eventInquiryRoutes = require('./routes/eventInquiries');
const mcpRoutes = require('./routes/mcp');
```

Replace:

```js
app.use('/api/property', propertyRoutes);
app.use('/api/mcp', mcpRoutes);
```

with:

```js
app.use('/api/property', propertyRoutes);
app.use('/api/event-inquiries', eventInquiryRoutes);
app.use('/api/mcp', mcpRoutes);
```

- [ ] **Step 7: Update Swagger**

Replace:

```js
    { name: 'Pro Shop' },
  ],
```

with:

```js
    { name: 'Pro Shop' },
    { name: 'Event Inquiries' },
  ],
```

Then add the paths — replace:

```js
    // ── Golf ─────────────────────────────────────────────────────────────────
```

with:

```js
    // ── Event Inquiries ─────────────────────────────────────────────────────
    '/api/event-inquiries': {
      get: { tags: ['Event Inquiries'], summary: 'List event inquiries', responses: { 200: { description: 'Array of inquiries, newest first' } } },
      post: { tags: ['Event Inquiries'], summary: 'Submit an event inquiry', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'event_date'], properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, event_date: { type: 'string', format: 'date' }, guests: { type: 'integer' }, event_type: { type: 'string' }, format: { type: 'string' }, message: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' }, 400: { description: 'Missing or invalid fields' } } },
    },
    '/api/event-inquiries/{id}': {
      put: { tags: ['Event Inquiries'], summary: 'Update an inquiry\'s status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },

    // ── Golf ─────────────────────────────────────────────────────────────────
```

- [ ] **Step 8: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 9: Verify `POST /api/event-inquiries` — auth, validation, Ably publish**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_api_key.txt
ROBS_API_KEY=$(cat /tmp/robs_api_key.txt)

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries -H "Content-Type: application/json" -d '{"name":"Jane Doe","email":"jane@example.com","event_date":"2026-12-01"}'

echo "--- malformed event_date ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_API_KEY" -d '{"name":"Jane Doe","email":"jane@example.com","event_date":"soon"}'

echo "--- valid, via X-Api-Key (simulating an external site) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_API_KEY" -d '{"name":"Jane Doe","email":"jane@example.com","event_date":"2026-12-01","guests":80,"event_type":"wedding","message":"Looking to book for next December"}'
```
Expected: no auth → `401`. Malformed date → `400 {"error":"Invalid date format"}` (not a raw Postgres 500). Valid via API key → `201`, `property_id` matches Robs — save the returned `id` as `INQUIRY_ID`.

Separately, confirm the publish reached Ably: check the Ably dashboard's channel log for `property:a3e548af-a71d-46c0-ba61-f1f702e495be:inquiries`, or run `npx ably channels:log "property:a3e548af-a71d-46c0-ba61-f1f702e495be:inquiries" --api-key <key>` if the Ably CLI is available, and confirm a `new-inquiry` event with this row's data appears.

- [ ] **Step 10: Verify `GET /api/event-inquiries` — scoped, both auth modes**

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
ROBS_API_KEY=$(cat /tmp/robs_api_key.txt)

echo "--- via Clerk ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/event-inquiries -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- via X-Api-Key ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/event-inquiries -H "X-Api-Key: $ROBS_API_KEY"
```
Expected: both `200`, both include Step 9's inquiry.

- [ ] **Step 11: Verify `PUT /api/event-inquiries/:id` — Clerk-only, cross-property 404**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"INSERT INTO event_inquiry (property_id, name, email, event_date) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Inquiry', 'foreign@example.com', '2026-11-01') RETURNING id\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_inquiry_id.txt
FOREIGN_INQUIRY_ID=$(cat /tmp/foreign_inquiry_id.txt)

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
ROBS_API_KEY=$(cat /tmp/robs_api_key.txt)
INQUIRY_ID="<from Step 9>"

echo "--- update own inquiry via Clerk ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/event-inquiries/$INQUIRY_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"contacted"}'

echo "--- update via X-Api-Key (should be rejected -- authenticate-only) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/event-inquiries/$INQUIRY_ID -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_API_KEY" -d '{"status":"contacted"}'

echo "--- update a foreign inquiry via Clerk ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/event-inquiries/$FOREIGN_INQUIRY_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"contacted"}'
```
Expected: own inquiry via Clerk → `200`, `status: "contacted"`. Via `X-Api-Key` → `401` (proves `PUT` really is `authenticate`-only, the one asymmetry vs. `GET`/`POST` — this is the check the spec specifically calls out as easy to get wrong via copy-paste). Foreign inquiry → `404`.

- [ ] **Step 12: Verify the best-effort Ably framing — publish failure doesn't fail the request**

Temporarily edit `.env` to set `ABLY_API_KEY=invalid-key-value`, restart the server, then:
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
ROBS_API_KEY=$(cat /tmp/robs_api_key.txt)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_API_KEY" -d '{"name":"Ably Failure Test","email":"test@example.com","event_date":"2026-12-15"}'
```
Expected: still `201` — the create succeeds regardless of Ably's state. Check the server's console output (the running `npm start` process) for a logged `Ably publish failed: ...` line, confirming the failure was caught, not swallowed silently or left unhandled.

Restore the real `ABLY_API_KEY` value in `.env` and restart the server before continuing.

- [ ] **Step 13: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_api_key.txt /tmp/foreign_inquiry_id.txt
git add src/controllers/eventInquiries.js src/routes/eventInquiries.js src/lib/ably.js src/app.js src/docs/swagger.js package.json package-lock.json
git commit -m "Add event inquiries module with Ably publish on create"
```

Note: `.env` is intentionally not staged (gitignored, matches every other secret in this file).

---

### Task 4: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-3's commits and `src/db/migrate-2026-08-16-event-inquiries.sql`.

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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-event-inquiries.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify the table on live**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'event_inquiry'\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: all 11 columns listed.

- [ ] **Step 4: Confirm with the user before adding `ABLY_API_KEY` to the live Render environment and pushing**

Per Global Constraints — the env var change and the push are both changes to the live service; confirm before either. Add `ABLY_API_KEY` to the Render service's environment variables (same value as local/frontend) via the Render dashboard — this tool has no direct Render API access, so this step is manual; ask the user to confirm it's been added before proceeding to Step 6.

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
    console.log(j.paths['/api/event-inquiries'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 7: Verify live — auth required, create round-trip, and Ably publish reaches the live channel**

This needs a live Clerk admin token for FORGE, which requires the browser-based sign-in-ticket flow (the dev-only `sessions.createSession` shortcut doesn't work on live). Use whichever browser automation MCP tool is connected at execution time, following the same recipe used in every prior live-verification task this session (mint a sign-in ticket via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key from `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, navigate with `redirect_url=https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`).

If no browser tool is connected when this step is reached, stop and ask the user how to proceed (wait for reconnection, have them supply a token, or skip this specific step) rather than skipping silently.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/event-inquiries

echo "--- create with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/event-inquiries -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"name":"Live Verify Inquiry","email":"live-verify@example.com","event_date":"2026-12-20"}'
```
Expected: no-auth → `401`; create → `201`, `property_id` matches FORGE. Check the Ably dashboard's channel log for `property:b7a4c969-5e82-4c26-a587-17d2ab74858e:inquiries` to confirm the live publish reached Ably too.

- [ ] **Step 8: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
