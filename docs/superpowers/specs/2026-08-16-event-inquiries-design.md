# Event Inquiries module

## Context

A companion session proposed a starting schema/controller for capturing
event inquiries (weddings, conferences, parties) submitted from a
property's external marketing site. Sanity-checked against this
codebase's established conventions before building: the original
proposal was missing a `property_id` index (every other property-scoped
table has one), date validation on `event_date` (every other
date-accepting create endpoint validates with `isValidDate`), and any
way to ever change `status` after creation (no `updateInquiry`/`PUT`
route, despite the column existing) — this spec fixes all three.

Separately, the user wants inquiries to notify staff in near-real-time.
There is no email infrastructure anywhere in this codebase, and adding
one is a bigger decision deferred for later ("simple first" — confirmed
with the user). Instead, an `ABLY_API_KEY` was already added to
`ota-table-bookings/.env` for realtime pub/sub — this spec wires OTA up
as the publisher, since it's the one place every inquiry passes through
regardless of source (external site via `X-Api-Key`, or staff via the
admin app).

## Goals

- `event_inquiry` table, property-scoped like everything else in this
  schema.
- `GET/POST /api/event-inquiries` reachable the same way every other
  guest-originating resource is: `authenticateOrApiKey`, so an external
  marketing site can submit inquiries with just the property's API key,
  and staff can list them via Clerk.
- `PUT /api/event-inquiries/:id` to update `status` — `authenticate`-only,
  since changing status is a staff action, not something an external
  site does.
- On successful creation, publish a `new-inquiry` event to a
  per-property Ably channel so the admin app can show it live.
- A minimal `GET /api/property/me` so the frontend can resolve its own
  `property_id` when minting an Ably subscribe token (see below) —
  otherwise there's no existing way to look this up.

## Non-goals

- No email notifications — deferred, per the user's "simple first"
  decision. `event_inquiry` already has `email`/`phone` captured, so
  adding email later doesn't require a schema change.
- No global any-page notification badge — the companion frontend spec
  scopes the live toast/refresh to the inquiries page itself.
- No `converted_to_booking_id` or similar link to an eventual real
  booking/event record — noted as a future direction in conversation,
  not decided or scoped now.
- No change to `event_date`'s `NOT NULL` — flagged as a possible
  product question (an early-stage "just exploring" inquiry might not
  have a firm date) but not changed without the user deciding it's
  actually needed; shipping as originally proposed.

## Data model

```sql
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

No existing data — new table, no backfill.

## API & behavior

```
GET  /api/event-inquiries        authenticateOrApiKey, scoped to req.property_id
POST /api/event-inquiries        authenticateOrApiKey, scoped, validates event_date, publishes to Ably
PUT  /api/event-inquiries/:id    authenticate, scoped, updates status
```

`src/controllers/eventInquiries.js` (camelCase file name, matching
`beachClub.js`/`restaurantOrders.js`/`roomTypes.js`'s existing
precedent for multi-word module names):

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

    // Best-effort -- an Ably publish failure must not fail the inquiry
    // itself (the row is already committed; the realtime nudge is a
    // nice-to-have, not the source of truth).
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

`src/routes/eventInquiries.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/eventInquiries');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticate, ctrl.updateInquiry);

module.exports = router;
```

Registered in `src/app.js` (hyphenated-plural path, matching the
existing `/api/beach-club`/`/api/room-types` precedent):

```js
const eventInquiryRoutes = require('./routes/eventInquiries');
// ...
app.use('/api/event-inquiries', eventInquiryRoutes);
```

`src/docs/swagger.js` gets a new `Event Inquiries` tag and paths for
all three routes, matching every other module's documentation.

## Ably publishing

New file `src/lib/ably.js` — the one place that knows how to talk to
Ably, so the controller doesn't import the SDK directly:

```js
const Ably = require('ably');

const client = process.env.ABLY_API_KEY ? new Ably.Rest({ key: process.env.ABLY_API_KEY }) : null;

async function publishNewInquiry(propertyId, inquiry) {
  if (!client) return; // no key configured (e.g. local dev without one set) -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-inquiry', inquiry);
}

module.exports = { publishNewInquiry };
```

Channel naming: `property:{property_id}:inquiries` — scoped per
property (internal UUID, the same id space used everywhere else in
this app), so one property's staff never receive another's events.

`ABLY_API_KEY` added to `OTA/.env`, same value already present in
`ota-table-bookings/.env` (confirmed with the user rather than
assuming — a single Ably key commonly carries both publish and
subscribe capability; if this key turns out to be scoped too narrowly
for server-side publish, that surfaces immediately as an Ably auth
error in `publishNewInquiry`, not a silent failure, since it's awaited
and logged).

The `ably` package needs adding to `package.json` (`npm install ably`).

## New endpoint: `GET /api/property/me`

The frontend's Ably token-minting endpoint (companion spec) needs to
resolve the signed-in staff member's `property_id` before it can scope
a token to the right channel — there's currently no way to look this
up; every existing `property.js` route manages the API key, not the
property's own identity. Adding one small read-only endpoint, same
file/pattern as the existing four:

`src/routes/property.js` gains:
```js
router.get('/me', authenticate, ctrl.getCurrentProperty);
```

`src/controllers/property.js` gains:
```js
async function getCurrentProperty(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id, name FROM property WHERE id = $1', [req.property_id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```
(and adds `getCurrentProperty` to the `module.exports` object alongside
the existing four exports).

This keeps the Ably channel naming in one consistent id space —
`property.id`, the same internal UUID `req.property_id` already
resolves to everywhere in this app — rather than introducing a second
identifier (Clerk's `org_id`) into channel names, which would require
either a middleware change (`authenticateOrApiKey`'s `X-Api-Key`
branch has no Clerk org context to draw from at all) or a second
Postgres lookup at publish time. `GET /api/property/me` is
`authenticate`-only (Clerk), since minting a subscribe token is
inherently a staff/admin-app action — an external site has no reason
to open a realtime connection.

## Non-goals reiterated for the Ably piece

- No retry/queue if a publish fails — logged and dropped, matching the
  "best-effort, not the source of truth" framing above. The inquiry
  itself is always safely in Postgres regardless.
- No token-minting endpoint *for Ably* in OTA — that lives in the
  frontend's own Astro server code (companion spec), since the raw
  `ABLY_API_KEY` should never reach a browser from either repo.
  `GET /api/property/me` above is a plain identity lookup, unrelated to
  Ably itself — it just supplies the id the frontend needs before it
  can call Ably's own token-request API using its own key.

## Testing approach

No automated test framework — manual `curl` checks against a running
`npm start`, plus a manual Ably dashboard/log check for the publish:

1. `POST /api/event-inquiries` with no auth → `401`. With a valid
   `X-Api-Key` → `201`, `property_id` matches the key's property.
2. `POST` with a malformed `event_date` (e.g. `"soon"`) → `400`, not a
   500 from Postgres.
3. `GET /api/event-inquiries` with the same property's Clerk token →
   includes the row from Step 1. With a different property's token →
   does not.
4. `PUT /api/event-inquiries/:id` with `{"status":"contacted"}` using
   the owning property's Clerk token → `200`, `status` updated. With a
   different property's token against the same id → `404`. With the
   old shared `X-Api-Key` model or no auth at all → confirm it's
   `authenticate`-only, not reachable via API key (that's the one
   intentional asymmetry vs. `GET`/`POST` on this module — worth an
   explicit check since it's easy to copy-paste the wrong middleware).
5. Confirm a publish actually happened for Step 1's create — check the
   Ably dashboard's channel log for `property:{property_id}:inquiries`,
   or use `ably channels:log` CLI against the same channel, and confirm
   the payload matches the created row.
6. Temporarily unset `ABLY_API_KEY` (or point it at an invalid value),
   confirm `POST /api/event-inquiries` still succeeds (`201`) and only
   logs the publish failure server-side — proves the best-effort
   framing actually holds.
7. `GET /api/property/me` with no auth → `401`. With a valid Clerk
   token → `200`, `id` matches `req.property_id` (cross-check against
   the `property_id` seen in Step 1's created inquiry).
