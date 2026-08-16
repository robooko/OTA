# Event Inquiry Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-way email replying to event inquiries — a new `event_inquiry_message` table, `GET/POST /api/event-inquiries/:id/replies` for staff to read/send replies via Resend, and an unauthenticated, Svix-verified `POST /api/event-inquiries/webhooks/resend-inbound` that stores a guest's email reply and publishes it live — per `docs/superpowers/specs/2026-08-16-event-inquiry-replies-design.md`.

**Architecture:** `src/lib/resend.js` (new, mirrors `src/lib/ably.js`'s guarded-singleton shape) wraps `resend.emails.send`, `resend.webhooks.verify`, and `resend.emails.receiving.get` — no controller talks to the Resend SDK directly. `createReply` sends via Resend, stores the outbound message, and auto-flips `event_inquiry.status` from `new` to `contacted`. The inbound webhook route is registered directly in `app.js` with its own `express.raw()` middleware, before the global `express.json()`, because Svix signature verification needs the exact raw request bytes. A partial unique index on `event_inquiry_message.resend_email_id` makes inbound webhook retries idempotent (insert collides instead of duplicating).

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL, `resend` (new dependency, also handles Svix-format webhook verification internally — no separate `svix` package needed).

**Spec:** `docs/superpowers/specs/2026-08-16-event-inquiry-replies-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl`/CLI checks against a running `npm start` server, matching every prior plan in this repo.
- **Confirm with the user before**: pushing to `origin/main` (triggers a live Render redeploy), adding `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET` to the live Render environment, and any change to the live Resend account (creating the receiving domain, adding its DNS record, creating the webhook).
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
- **Robs's email inquiry to reply to**: use an existing `event_inquiry` row (e.g. the one from the earlier Event Inquiries plan's own verification, `robooko7@gmail.com`) so a real reply email actually lands somewhere checkable — fetch its id via `SELECT id, email, status FROM event_inquiry WHERE property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be' ORDER BY created_at DESC LIMIT 5`.
- `RESEND_API_KEY`: the same value already sitting in `ota-table-bookings/.env` gets copied into `OTA/.env` for local dev (confirmed with the user during brainstorming — Resend is never called from the frontend, so it's relocating, not duplicating). Read it directly from that file rather than asking the user to retype it.
- The `resend` CLI is already installed locally (`npm i -g resend-cli`, binary name `resend`) and can read `RESEND_API_KEY` from the environment per-command (`RESEND_API_KEY=... resend domains list --json`) without persisting login.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3` should print `200`. No auto-restart — kill and restart `npm start` (as a background task) after any controller/route/`app.js`/`.env` change.
- **Scope:** exactly `event_inquiry_message`, the two `/replies` routes, the inbound webhook route, `src/lib/resend.js`, and one new `src/lib/ably.js` export (`publishNewReply`, added in Task 4 for the webhook handler to call). No change to any other module.

---

### Task 1: Migration — create `event_inquiry_message`

**Files:**
- Create: `src/db/migrate-2026-08-16-event-inquiry-messages.sql`
- Modify: `src/db/schema.sql`

**Interfaces:**
- Produces: `event_inquiry_message` table (`id`, `event_inquiry_id`, `direction`, `body`, `resend_email_id`, `created_at`) — Task 3 and Task 4's controllers query it directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-16-event-inquiry-messages.sql`:

```sql
-- One-time migration: creates event_inquiry_message, a new table, so
-- there's no backfill concern -- CREATE TABLE IF NOT EXISTS is
-- inherently idempotent-safe.

CREATE TABLE IF NOT EXISTS event_inquiry_message (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_inquiry_id  UUID NOT NULL REFERENCES event_inquiry(id),
  direction         VARCHAR(10) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body              TEXT NOT NULL,
  resend_email_id   TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_message_inquiry ON event_inquiry_message(event_inquiry_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_inquiry_message_resend_id
  ON event_inquiry_message(resend_email_id) WHERE resend_email_id IS NOT NULL;
```

- [ ] **Step 2: Add to `schema.sql`**

Append near the end of the file, after the Event Inquiries section (match wherever that section's `CREATE INDEX idx_event_inquiry_property` line currently sits):

```sql
-- ── Event Inquiry Messages ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_inquiry_message (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_inquiry_id  UUID NOT NULL REFERENCES event_inquiry(id),
  direction         VARCHAR(10) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body              TEXT NOT NULL,
  resend_email_id   TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_message_inquiry ON event_inquiry_message(event_inquiry_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_inquiry_message_resend_id
  ON event_inquiry_message(resend_email_id) WHERE resend_email_id IS NOT NULL;
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-event-inquiry-messages.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify the table, check constraint, and dedupe index**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'event_inquiry_message' ORDER BY ordinal_position\");
  console.log(JSON.stringify(cols.rows, null, 2));

  const { rows: inq } = await pool.query(\"SELECT id FROM event_inquiry LIMIT 1\");
  const inquiryId = inq[0].id;

  try {
    await pool.query(\"INSERT INTO event_inquiry_message (event_inquiry_id, direction, body) VALUES (\$1, 'sideways', 'test')\", [inquiryId]);
    console.log('UNEXPECTED: invalid direction accepted');
  } catch (e) {
    console.log('Expected rejection (bad direction):', e.message);
  }

  await pool.query(\"INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id) VALUES (\$1, 'inbound', 'first', 'dedupe-test-id')\", [inquiryId]);
  try {
    await pool.query(\"INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id) VALUES (\$1, 'inbound', 'second', 'dedupe-test-id')\", [inquiryId]);
    console.log('UNEXPECTED: duplicate resend_email_id accepted');
  } catch (e) {
    console.log('Expected rejection (dedupe):', e.message);
  }

  await pool.query(\"DELETE FROM event_inquiry_message WHERE resend_email_id = 'dedupe-test-id'\");
  await pool.end();
})();
"
```
Expected: columns match the spec's shape, `event_inquiry_id`/`direction`/`body` all `is_nullable: 'NO'`. Both rejections print (bad `direction` value, duplicate `resend_email_id`).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-16-event-inquiry-messages.sql
git commit -m "Add event_inquiry_message table"
```

---

### Task 2: `src/lib/resend.js`

**Files:**
- Create: `src/lib/resend.js`
- Modify: `package.json`, `package-lock.json` (add `resend` dependency)
- Modify: `.env` (add `RESEND_API_KEY`)

**Interfaces:**
- Produces: `sendReply(inquiry, propertyName, body) -> Promise<string>` (resolves to the Resend email id), `verifyInboundWebhook(payload, headers) -> { type, data, created_at }` (throws on invalid signature), `getReceivedEmail(emailId) -> Promise<{ text, html, ... }>`. Task 3 and Task 4 both import from here.

- [ ] **Step 1: Install `resend`**

```bash
cd "c:\Users\robert\source\repos\OTA" && npm install resend
```
Expected: `package.json`'s `dependencies` gains a `"resend": "^x.x.x"` entry, `package-lock.json` updates.

- [ ] **Step 2: Add `RESEND_API_KEY` to `.env`**

Read the exact value from `c:\Users\robert\source\repos\ota-table-bookings\.env`'s `RESEND_API_KEY` line and add the identical line to `c:\Users\robert\source\repos\OTA\.env`. Do not commit `.env` (already gitignored) — this step only touches the local file.

- [ ] **Step 3: Create `src/lib/resend.js`**

```js
const { Resend } = require('resend');

let client = null;
if (process.env.RESEND_API_KEY) {
  client = new Resend(process.env.RESEND_API_KEY);
}

async function sendReply(inquiry, propertyName, body) {
  if (!client) throw new Error('Resend not configured');
  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <inquiries@hotal.forge-build.co.uk>`,
    to: inquiry.email,
    reply_to: `inquiry+${inquiry.id}@replies.hotal.forge-build.co.uk`,
    subject: 'Re: Your event inquiry',
    text: body,
  });
  if (error) throw new Error(error.message);
  return data.id;
}

function verifyInboundWebhook(payload, headers) {
  if (!client) throw new Error('Resend not configured');
  return client.webhooks.verify({
    payload,
    headers: {
      id: headers['svix-id'],
      timestamp: headers['svix-timestamp'],
      signature: headers['svix-signature'],
    },
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  });
}

async function getReceivedEmail(emailId) {
  const { data, error } = await client.emails.receiving.get(emailId);
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { sendReply, verifyInboundWebhook, getReceivedEmail };
```

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/resend.js package.json package-lock.json
git commit -m "Add Resend client wrapper (send, webhook verify, receiving)"
```

Note: `.env` is intentionally not staged.

---

### Task 3: Reply routes — list and send

**Files:**
- Modify: `src/controllers/eventInquiries.js`
- Modify: `src/routes/eventInquiries.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate` from `src/middleware/auth.js`, `sendReply` from `src/lib/resend.js` (Task 2), `event_inquiry_message` table (Task 1).
- Produces: `GET/POST /api/event-inquiries/:id/replies`. `POST` response shape `{ message, inquiry }` — Task 2 of the companion frontend plan depends on this exact shape.

- [ ] **Step 1: Add `listReplies` and `createReply` to the controller**

In `src/controllers/eventInquiries.js`, replace:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewInquiry } = require('../lib/ably');
```

with:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewInquiry } = require('../lib/ably');
const { sendReply } = require('../lib/resend');
```

Then replace:

```js
module.exports = { listInquiries, createInquiry, updateInquiry };
```

with:

```js
async function listReplies(req, res, next) {
  try {
    const { rows: inquiryRows } = await pool.query(
      'SELECT id FROM event_inquiry WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!inquiryRows.length) return res.status(404).json({ error: 'Inquiry not found' });

    const { rows } = await pool.query(
      'SELECT * FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createReply(req, res, next) {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });

    const { rows: inquiryRows } = await pool.query(
      `SELECT ei.*, p.name AS property_name FROM event_inquiry ei
       JOIN property p ON p.id = ei.property_id
       WHERE ei.id = $1 AND ei.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!inquiryRows.length) return res.status(404).json({ error: 'Inquiry not found' });
    const inquiry = inquiryRows[0];

    const emailId = await sendReply(inquiry, inquiry.property_name, body);

    const { rows } = await pool.query(
      `INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id)
       VALUES ($1, 'outbound', $2, $3) RETURNING *`,
      [inquiry.id, body, emailId]
    );

    let updatedInquiry = inquiry;
    if (inquiry.status === 'new') {
      const { rows: statusRows } = await pool.query(
        `UPDATE event_inquiry SET status = 'contacted' WHERE id = $1 RETURNING *`,
        [inquiry.id]
      );
      updatedInquiry = statusRows[0];
    }

    res.status(201).json({ message: rows[0], inquiry: updatedInquiry });
  } catch (err) { next(err); }
}

module.exports = { listInquiries, createInquiry, updateInquiry, listReplies, createReply };
```

- [ ] **Step 2: Add the routes**

In `src/routes/eventInquiries.js`, replace:

```js
router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticate, ctrl.updateInquiry);

module.exports = router;
```

with:

```js
router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticate, ctrl.updateInquiry);

router.get('/:id/replies', authenticate, ctrl.listReplies);
router.post('/:id/replies', authenticate, ctrl.createReply);

module.exports = router;
```

- [ ] **Step 3: Update Swagger**

In `src/docs/swagger.js`, replace:

```js
    '/api/event-inquiries/{id}': {
      put: { tags: ['Event Inquiries'], summary: 'Update an inquiry\'s status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },

    // ── Golf ─────────────────────────────────────────────────────────────────
```

with:

```js
    '/api/event-inquiries/{id}': {
      put: { tags: ['Event Inquiries'], summary: 'Update an inquiry\'s status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/event-inquiries/{id}/replies': {
      get: { tags: ['Event Inquiries'], summary: 'List an inquiry\'s reply thread', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of messages, oldest first' }, 404: { description: 'Not found' } } },
      post: { tags: ['Event Inquiries'], summary: 'Send a reply email to the guest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' } } } } } }, responses: { 201: { description: 'Sent' }, 400: { description: 'Missing body' }, 404: { description: 'Not found' } } },
    },

    // ── Golf ─────────────────────────────────────────────────────────────────
```

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify `POST /api/event-inquiries/:id/replies` — auth, send, status auto-update**

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

cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id, status FROM event_inquiry WHERE property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be' ORDER BY created_at DESC LIMIT 1\")
  .then(r => { console.log(JSON.stringify(r.rows[0])); pool.end(); });
" > /tmp/inquiry.json
INQUIRY_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/inquiry.json'))?.id ?? '')" 2>/dev/null || true)
cat /tmp/inquiry.json

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries/$INQUIRY_ID/replies -H "Content-Type: application/json" -d '{"body":"test"}'

echo "--- missing body ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries/$INQUIRY_ID/replies -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{}'

echo "--- valid reply ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries/$INQUIRY_ID/replies -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"body":"Thanks for reaching out, we would love to host your event."}'
```
Expected: no auth → `401`. Missing `body` → `400 {"error":"body is required"}`. Valid → `201`, response has `message.direction: "outbound"` and `message.body` matching what was sent, and `inquiry.status` is `"contacted"` if the inquiry's prior status was `"new"` (check against the value printed from `/tmp/inquiry.json`). Confirm the email actually arrives at `robooko7@gmail.com`'s inbox (or spam folder) within a minute or two.

- [ ] **Step 6: Verify `GET /api/event-inquiries/:id/replies` and cross-property 404**

```bash
CLERK_TOKEN=$(cat /tmp/tok.txt)
INQUIRY_ID="<from Step 5>"

echo "--- own inquiry ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/event-inquiries/$INQUIRY_ID/replies -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/event-inquiries/$INQUIRY_ID/replies

echo "--- nonexistent id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/event-inquiries/00000000-0000-0000-0000-000000000000/replies -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- real inquiry belonging to a different property ---"
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"INSERT INTO event_inquiry (property_id, name, email, event_date) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Inquiry', 'foreign@example.com', '2026-11-01') RETURNING id\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_inquiry_id.txt
FOREIGN_INQUIRY_ID=$(cat /tmp/foreign_inquiry_id.txt)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/event-inquiries/$FOREIGN_INQUIRY_ID/replies -H "Authorization: Bearer $CLERK_TOKEN"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries/$FOREIGN_INQUIRY_ID/replies -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"body":"should not send"}'
```
Expected: own inquiry → `200`, includes Step 5's message, oldest first (only one so far). No auth → `401`. Nonexistent id → `404`. Foreign inquiry (real row, different `property_id`, Robs's own token) → both `GET` and `POST` → `404`, proving `req.property_id` scoping holds on both new routes, not just the existing ones.

- [ ] **Step 7: Verify a missing `RESEND_API_KEY` fails loudly, not silently**

Temporarily comment out `RESEND_API_KEY` in `.env`, restart the server, then:
```bash
CLERK_TOKEN=$(cat /tmp/tok.txt)
INQUIRY_ID="<from Step 5>"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries/$INQUIRY_ID/replies -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"body":"should fail"}'
```
Expected: `500` (not `201`) — confirms `sendReply` throwing on an unconfigured client actually surfaces as an error, per the spec's explicit "no reasonable degraded mode" design (unlike Ably's best-effort no-op). Restore `RESEND_API_KEY` in `.env` and restart the server before continuing.

- [ ] **Step 8: Commit**

```bash
rm -f /tmp/tok.txt /tmp/inquiry.json /tmp/foreign_inquiry_id.txt
git add src/controllers/eventInquiries.js src/routes/eventInquiries.js src/docs/swagger.js
git commit -m "Add reply thread routes (list + send via Resend)"
```

---

### Task 4: Inbound webhook

**Files:**
- Modify: `src/controllers/eventInquiries.js`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `verifyInboundWebhook`, `getReceivedEmail` from `src/lib/resend.js` (Task 2), `publishNewReply`-shaped Ably call — **not added in this plan**; the spec's `handleResendInboundWebhook` publishes via `publishNewReply`, but no such function exists yet in `src/lib/ably.js`. Adding it here rather than deferring, since the webhook handler needs it to compile.
- Produces: `POST /api/event-inquiries/webhooks/resend-inbound` (unauthenticated, Svix-verified).

- [ ] **Step 1: Add `publishNewReply` to `src/lib/ably.js`**

Replace:

```js
async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}

module.exports = { publishNewInquiry, publishNewOrder, publishOrderStatusChanged, client };
```

with:

```js
async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}

async function publishNewReply(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-reply', payload);
}

module.exports = { publishNewInquiry, publishNewOrder, publishOrderStatusChanged, publishNewReply, client };
```

(Reuses the existing `property:{id}:inquiries` channel — same audience as `new-inquiry`, not a new channel.)

- [ ] **Step 2: Add `handleResendInboundWebhook` to the controller**

In `src/controllers/eventInquiries.js`, replace:

```js
const { publishNewInquiry } = require('../lib/ably');
const { sendReply } = require('../lib/resend');
```

with:

```js
const { publishNewInquiry, publishNewReply } = require('../lib/ably');
const { sendReply, verifyInboundWebhook, getReceivedEmail } = require('../lib/resend');
```

Then replace:

```js
module.exports = { listInquiries, createInquiry, updateInquiry, listReplies, createReply };
```

with:

```js
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function handleResendInboundWebhook(req, res, next) {
  try {
    const payload = req.body.toString(); // raw Buffer, from express.raw() -- see app.js
    let event;
    try {
      event = verifyInboundWebhook(payload, req.headers);
    } catch {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (event.type !== 'email.received') return res.status(200).end();

    const toAddress = event.data.to?.[0] ?? '';
    const match = toAddress.match(/^inquiry\+([0-9a-f-]{36})@/i);
    if (!match) return res.status(200).end();

    const inquiryId = match[1];
    const { rows: inquiryRows } = await pool.query('SELECT * FROM event_inquiry WHERE id = $1', [inquiryId]);
    if (!inquiryRows.length) return res.status(200).end();
    const inquiry = inquiryRows[0];

    const email = await getReceivedEmail(event.data.email_id);
    const text = email.text ?? stripHtml(email.html ?? '');

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id)
         VALUES ($1, 'inbound', $2, $3) RETURNING *`,
        [inquiry.id, text, event.data.email_id]
      ));
    } catch (err) {
      if (err.code === '23505') return res.status(200).end();
      throw err;
    }

    publishNewReply(inquiry.property_id, { inquiry_id: inquiry.id, name: inquiry.name, message: rows[0] })
      .catch((err) => console.error('Ably publish failed:', err.message));

    res.status(200).end();
  } catch (err) { next(err); }
}

module.exports = { listInquiries, createInquiry, updateInquiry, listReplies, createReply, handleResendInboundWebhook };
```

- [ ] **Step 3: Register the raw-body webhook route in `app.js`, before `express.json()`**

Replace:

```js
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
```

with:

```js
const { handleResendInboundWebhook } = require('./controllers/eventInquiries');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Must come before express.json() -- Svix verification needs the raw
// body, and this scopes that requirement to exactly this one path.
app.post(
  '/api/event-inquiries/webhooks/resend-inbound',
  express.raw({ type: 'application/json' }),
  handleResendInboundWebhook
);

app.use(express.json());
```

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify signature rejection with a fabricated payload**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/event-inquiries/webhooks/resend-inbound \
  -H "Content-Type: application/json" \
  -H "svix-id: msg_fake" \
  -H "svix-timestamp: 1614265330" \
  -H "svix-signature: v1,not-a-real-signature=" \
  -d '{"type":"email.received","data":{"email_id":"fake","to":["inquiry+00000000-0000-0000-0000-000000000000@replies.hotal.forge-build.co.uk"]}}'
```
Expected: `400 {"error":"Invalid signature"}` — confirms verification is actually enforced, not silently bypassed.

- [ ] **Step 6: Verify a correctly-signed payload with an unrecognized `to` address is a no-op**

This needs a genuinely valid signature, which requires `RESEND_WEBHOOK_SECRET` to be set to a real value first. Since the receiving domain/webhook doesn't exist in Resend yet (Task 5), generate a locally-signed test payload using the same `resend` package's webhook-signing test helper, or defer this specific check to Task 5's live verification once the webhook is real — do not fabricate a signature by hand for a "valid" case, since getting the Svix signing algorithm subtly wrong would produce a false pass. Skip to Task 5 for full round-trip inbound verification.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ably.js src/controllers/eventInquiries.js src/app.js
git commit -m "Add inbound reply webhook (Resend -> event_inquiry_message)"
```

---

### Task 5: Resend account setup, push, and live verification

**Files:** none (Resend account configuration, migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-4's commits and `src/db/migrate-2026-08-16-event-inquiry-messages.sql`.

- [ ] **Step 1: Confirm with the user before making any Resend account changes**

Per Global Constraints — creating the receiving domain, adding its DNS record, and creating the webhook all modify the live Resend account. This also needs the account (whichever holds `hotal.forge-build.co.uk`, the `RESEND_HOTAL_API_KEY` account per the mid-implementation domain switch — see the spec's Context) upgraded to a paid plan first: the free tier caps at 1 domain, already used by `hotal.forge-build.co.uk` itself (sending-only) — confirmed live via `resend domains create` returning a 403 `domain limit` error for a second domain on this account. Resend's Pro plan ($20/mo) raises the cap to 10 domains and is the cheapest tier that allows a second domain at all. Confirm the account has been upgraded before Step 2.

- [ ] **Step 2: Create the receiving domain**

```bash
RESEND_API_KEY=$(grep '^RESEND_API_KEY=' "c:\Users\robert\source\repos\ota-table-bookings\.env" | cut -d= -f2)
RESEND_API_KEY=$RESEND_API_KEY resend domains create --name replies.hotal.forge-build.co.uk --receiving --json
```
(`--domain` is not a valid flag for this CLI — it's `--name`, and receiving must be explicitly requested with `--receiving` or it defaults to sending-only, per `resend domains create --help`.)

Expected: a domain object with `id` and the MX record details to add. Report the exact MX record (host/value/priority) to the user so they can add it wherever `hotal.forge-build.co.uk`'s DNS is managed (this tool has no DNS provider access).

- [ ] **Step 3: Wait for the user to confirm the DNS record is added, then verify**

```bash
RESEND_API_KEY=$RESEND_API_KEY resend domains list --json
```
Expected: `replies.hotal.forge-build.co.uk` present with `capabilities.receiving: "enabled"` (may take time to propagate — re-check rather than assuming failure on the first try; DNS propagation can take up to a few hours).

- [ ] **Step 4: Create the webhook**

```bash
RESEND_API_KEY=$RESEND_API_KEY resend webhooks create \
  --url https://ota-u6ii.onrender.com/api/event-inquiries/webhooks/resend-inbound \
  --events email.received \
  --json
```
Expected: a webhook object including its signing secret (`whsec_...`). Save this value — it's shown once.

- [ ] **Step 5: Add `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` to `OTA/.env` and confirm with the user before adding both to the live Render environment**

Per Global Constraints. Add both to the Render service's environment variables via the Render dashboard (manual — no direct Render API access here); ask the user to confirm before continuing.

- [ ] **Step 6: Apply the migration to the live database**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-event-inquiry-messages.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 7: Push**

```bash
git push origin main
```

- [ ] **Step 8: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log(j.paths['/api/event-inquiries/{id}/replies'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 9: Full round-trip live verification**

Needs a live Clerk admin token for FORGE (browser-based sign-in-ticket flow — mint via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key, navigate to `https://accounts.hotal.forge-build.co.uk/sign-in?__clerk_ticket=<ticket>&redirect_url=https://accounts.hotal.forge-build.co.uk/user` — the query param is `__clerk_ticket`, not `ticket`; a plain `?ticket=` silently leaves the page on the sign-in screen with no session, confirmed the hard way — then poll for `window.Clerk.session` to appear (loads asynchronously, 1-2s) before evaluating `window.Clerk.session.getToken({ skipCache: true })`; also set a realistic `userAgent` on the browser context, since Clerk's Account Portal returned 403s under Playwright's default one) and a real, checkable inbox to reply from. Resend also rejects `to` addresses on placeholder domains (e.g. `example.com`) with a clear error — use a real deliverable address.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"

# Find or create a live inquiry to reply to, using a real inbox you can check.
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/event-inquiries \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" \
  -d '{"name":"Reply Loop Test","email":"<a real inbox you can check>","event_date":"2026-12-20"}'
# Save the returned id as LIVE_INQUIRY_ID

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/event-inquiries/$LIVE_INQUIRY_ID/replies \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" \
  -d '{"body":"Live round-trip test reply."}'
```
Expected: `201`, `inquiry.status` is `"contacted"`. Confirm the reply email actually arrives at the real inbox used above.

From that inbox, reply to the email (plain reply, using the client's normal reply button — this exercises the `Reply-To` routing for real). Then:

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/event-inquiries/$LIVE_INQUIRY_ID/replies \
  -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
```
Expected: a second message with `direction: "inbound"` and a `body` matching the guest reply's text. If it doesn't appear within a minute or two, check the Resend dashboard's webhook delivery log for `https://ota-u6ii.onrender.com/api/event-inquiries/webhooks/resend-inbound` for delivery failures before assuming the code is wrong.

- [ ] **Step 10: Verify webhook retry dedupe**

From the Resend dashboard, find the delivery for the inbound reply just processed (Webhooks → the endpoint → its recent deliveries) and use its "Resend" / replay action to redeliver the same event.

```bash
curl -s https://ota-u6ii.onrender.com/api/event-inquiries/$LIVE_INQUIRY_ID/replies -H "Authorization: Bearer $LIVE_CLERK_TOKEN" | node -e "
let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{ const rows = JSON.parse(d); console.log('message count:', rows.length); });
"
```
Expected: message count unchanged from Step 9 (still exactly 2: one outbound, one inbound) — the replayed delivery collided on `resend_email_id` and was silently dropped, not duplicated.

- [ ] **Step 11: Verify an inbound reply to a `closed` inquiry doesn't reopen it**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT https://ota-u6ii.onrender.com/api/event-inquiries/$LIVE_INQUIRY_ID \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"status":"closed"}'
```
Reply to the same guest email thread again from the test inbox, wait for the webhook to process (check the Resend delivery log if it doesn't show up within a minute or two), then:
```bash
curl -s https://ota-u6ii.onrender.com/api/event-inquiries/$LIVE_INQUIRY_ID/replies -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
curl -s https://ota-u6ii.onrender.com/api/event-inquiries -H "Authorization: Bearer $LIVE_CLERK_TOKEN" | node -e "
let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{ const rows = JSON.parse(d); const row = rows.find(r => r.id === '$LIVE_INQUIRY_ID'); console.log('status:', row?.status); });
"
```
Expected: a third message (`direction: "inbound"`) is stored, but `status` is still `"closed"` — confirms the inbound path never touches `status`, matching the spec's non-goal.

- [ ] **Step 12: No further action**

This task is account setup + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from the relevant step.
