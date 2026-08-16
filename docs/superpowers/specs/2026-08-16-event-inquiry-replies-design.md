# Event Inquiry Replies module

## Context

Companion to `docs/superpowers/specs/2026-08-16-event-inquiry-replies-page-design.md`
in `ota-table-bookings`, which adds the staff-facing reply thread UI. This
spec adds two-way email replying on top of the existing `event_inquiry`
module: staff can reply to a guest's inquiry from the dashboard, the guest
can reply back by email, and both directions land in a persisted thread.

Provider is Resend, confirmed with the user. No email infrastructure exists
anywhere in this codebase today — `RESEND_API_KEY` was added to
`ota-table-bookings/.env` during setup, but it's relocating to `OTA/.env`
here, since only OTA ever talks to Resend (same reasoning as `ABLY_API_KEY`
living wherever the thing that actually calls Ably lives).

Confirmed with the user:
- Two-way threaded conversation, not a one-off transactional email.
- Reply-to addressing per inquiry (`inquiry+{id}@replies.hotal.forge-build.co.uk`)
  to route inbound mail back to the right thread — simpler and more
  reliable than relying on email client threading headers.
- A dedicated `replies.hotal.forge-build.co.uk` subdomain for inbound, under
  a separate Resend account/API key (`RESEND_HOTAL_API_KEY`'s account) from
  the one backing the root `forge-build.co.uk` domain. Revised mid-implementation:
  `hotal.forge-build.co.uk` matches the product's actual branding
  (`hotal-ui`, `accounts.hotal.forge-build.co.uk` already in use for Clerk),
  and is already verified in its own account for sending only
  (`receiving: disabled`, confirmed via `resend domains list`); Resend's own
  guidance is to use a subdomain for receiving rather than a domain that
  already has other mail flowing to it, which still applies here.
- Per-property sender name: `"{property.name} via Forge <inquiries@hotal.forge-build.co.uk>"`.
- Sending the first reply auto-flips `status` from `new` to `contacted`.
- An inbound reply publishes a realtime `new-reply` Ably event on the same
  per-property channel `new-inquiry` already uses, so the dashboard can
  notify staff live.

## Goals

- New `event_inquiry_message` table storing both directions of a thread.
- `GET/POST /api/event-inquiries/:id/replies` — list a thread / send an
  outbound reply via Resend. `authenticate`-only (Clerk), scoped to
  `req.property_id` like every other inquiry route — sending a reply is a
  staff action, never something an external site does.
- Sending an outbound reply auto-updates `event_inquiry.status` from `new`
  to `contacted`; any other status is left untouched.
- `POST /api/event-inquiries/webhooks/resend-inbound` — receives Resend's
  `email.received` webhook, verifies its signature, matches it to an
  inquiry via the reply-to plus-address, fetches the full body, stores it,
  publishes `new-reply`.
- `src/lib/resend.js` — the one place that talks to the Resend SDK
  (mirrors `src/lib/ably.js`'s shape), so no controller imports it
  directly.

## Non-goals

- No attachments in either direction — inbound attachments are silently
  dropped; outbound replies are text-only.
- No per-staff attribution on outbound messages — nothing else in this
  schema tracks which staff user performed an action (only Clerk auth for
  who's *allowed*), so this doesn't introduce that pattern.
- No HTML email templates — plain text only, avoids escaping and branding
  work nobody asked for.
- No status change on inbound reply — a guest replying to a `closed`
  inquiry does not reopen it. Status stays a manual staff decision, except
  for the one new→contacted automation above.
- No live sync of outbound replies across multiple staff sessions viewing
  the same inquiry at once — accepted limitation for v1.
- No retry/queue for a failed Ably publish on inbound reply — logged and
  dropped, same "best-effort, not the source of truth" framing as
  `publishNewInquiry`. The message itself is always safely in Postgres
  regardless of whether the realtime nudge lands.

## Data model

```sql
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

The partial unique index (only enforced when `resend_email_id IS NOT NULL`)
is the inbound-retry dedupe guard: Resend retries a webhook delivery that
didn't get a `200`, so a second delivery for the same `email_id` collides
on insert (`23505` unique_violation) instead of creating a duplicate thread
entry. No existing data — new table, no backfill.

## API & behavior

```
GET  /api/event-inquiries/:id/replies              authenticate, scoped, thread oldest→newest
POST /api/event-inquiries/:id/replies               authenticate, scoped, body: { body } -- sends via Resend
POST /api/event-inquiries/webhooks/resend-inbound   unauthenticated, Svix-verified
```

`src/controllers/eventInquiries.js` gains:

```js
const { sendReply, verifyInboundWebhook, getReceivedEmail } = require('../lib/resend');
const { publishNewReply } = require('../lib/ably');

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

async function handleResendInboundWebhook(req, res, next) {
  try {
    const payload = req.body.toString(); // raw Buffer, from express.raw() -- see app.js registration below
    let event;
    try {
      event = verifyInboundWebhook(payload, req.headers);
    } catch {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (event.type !== 'email.received') return res.status(200).end();

    const toAddress = event.data.to?.[0] ?? '';
    const match = toAddress.match(/^inquiry\+([0-9a-f-]{36})@/i);
    if (!match) return res.status(200).end(); // not a recognized reply address -- no-op, not an error

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
      if (err.code === '23505') return res.status(200).end(); // duplicate delivery, already stored
      throw err;
    }

    publishNewReply(inquiry.property_id, { inquiry_id: inquiry.id, name: inquiry.name, message: rows[0] })
      .catch((err) => console.error('Ably publish failed:', err.message));

    res.status(200).end();
  } catch (err) { next(err); }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  listInquiries, createInquiry, updateInquiry,
  listReplies, createReply, handleResendInboundWebhook,
};
```

`src/routes/eventInquiries.js` gains:

```js
router.get('/:id/replies', authenticate, ctrl.listReplies);
router.post('/:id/replies', authenticate, ctrl.createReply);
```

(The webhook route is **not** added here — see the raw-body section below
for why it's registered directly in `app.js` instead.)

## `src/lib/resend.js` (new)

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
  // Throws on an invalid/missing signature; returns the parsed, verified
  // event object ({ type, data, created_at }) on success.
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

Unlike `ably.js`'s guarded-singleton pattern (which no-ops silently when
unconfigured, since a missing Ably key degrades to "no realtime, app still
works"), a missing `RESEND_API_KEY` throws — there's no reasonable
degraded mode for "the reply couldn't be sent," so `createReply`'s
`catch (err) { next(err); }` surfaces it as a normal 500 with a logged
message, and the frontend shows an error toast (see the companion spec).

## Ably publishing addition

`src/lib/ably.js` gains one more publish function, same shape as the
other two:

```js
async function publishNewReply(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-reply', payload);
}
```

Exported alongside `publishNewInquiry`, `publishNewOrder`,
`publishOrderStatusChanged`. Reuses the existing
`property:{property_id}:inquiries` channel (not a new one) — it's the same
audience (staff watching this property's inquiries) as `new-inquiry`.

## Webhook route registration (raw body requirement)

Svix signature verification needs the exact raw request bytes. `app.js`
already runs `app.use(express.json())` globally, which parses and
re-serializes the body before any router sees it — re-stringified JSON
does not byte-for-byte match what Resend signed, so verification would
fail every time if the webhook route sat behind that global parser.

The webhook route is registered directly in `app.js`, with its own
`express.raw()` middleware, **before** the global `express.json()`:

```js
// app.js
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

// ...existing route registrations, unchanged...
app.use('/api/event-inquiries', eventInquiryRoutes);
```

## Environment / Resend account setup

New env vars, in `OTA/.env` and OTA's Render env (not
`ota-table-bookings` — Resend is never called from the frontend):
- `RESEND_API_KEY` — moved from `ota-table-bookings/.env`, the
  `hotal.forge-build.co.uk` account's key (`RESEND_HOTAL_API_KEY` in that
  repo's `.env`), not the root `forge-build.co.uk` account's key.
- `RESEND_WEBHOOK_SECRET` — from the Resend dashboard/CLI once the webhook
  (step 2 below) is created.

Manual one-time account setup, via the `resend` CLI (installed locally
this session) or the dashboard — done once this plan is approved, before
deploying. Both accounts (root and `hotal.` subdomain) are on Resend's free
tier, capped at 1 domain each, already occupied by their respective
sending-only domain — adding a receiving domain requires the Pro plan
($20/mo, 10 domains) on whichever account backs this feature; confirmed
with the user this is a known, accepted upcoming cost, not a blocker to
finishing the rest of this plan first:

1. Add `replies.hotal.forge-build.co.uk` as a receiving domain in Resend
   (`resend domains create --name replies.hotal.forge-build.co.uk --receiving`
   or via the dashboard) and add the MX record it returns to DNS.
2. Create a webhook subscribed to the `email.received` event, endpoint URL
   `https://ota-u6ii.onrender.com/api/event-inquiries/webhooks/resend-inbound`;
   copy its signing secret into `RESEND_WEBHOOK_SECRET`.
3. `npm install resend` in `OTA`.

## Testing approach

No automated test framework in this repo — manual `curl`/CLI checks
against a running `npm start`, matching the existing event-inquiries
spec's convention:

1. `POST /api/event-inquiries/:id/replies` with no auth → `401`. With the
   owning property's Clerk token and `{"body": "..."}` → `201`, response
   includes both `message` (`direction: outbound`) and `inquiry` (`status`
   now `contacted` if it was `new`). Confirm the email actually arrives at
   the inquiry's address.
2. `GET /api/event-inquiries/:id/replies` → includes the message from
   Step 1.
3. Same `GET`/`POST` with a different property's Clerk token against the
   same inquiry id → `404`, proving scoping holds on the new routes too.
4. Reply to the received email from the guest's mailbox. Confirm: the
   webhook fires (OTA logs / Resend dashboard delivery log), a new inbound
   message appears via `GET /api/event-inquiries/:id/replies`, and a
   `new-reply` event is visible on `property:{id}:inquiries` (Ably
   dashboard or `ably channels:log`).
5. Replay the same webhook delivery a second time (Resend dashboard's
   "resend" action, or a saved payload) → responds `200`, does **not**
   create a duplicate row (check the row count / the unique index holds).
6. Send a webhook whose `to` address doesn't match any inquiry (typo'd or
   unknown id) → `200`, no row inserted, no error thrown.
7. Temporarily point `RESEND_WEBHOOK_SECRET` at an invalid value → the
   webhook responds `400`, confirming signature verification is actually
   enforced and not silently bypassed.
8. Reply (by email) to an inquiry whose `status` is `closed` → message is
   stored; `status` remains `closed`, not reopened.
9. Temporarily unset `RESEND_API_KEY` → `POST /api/event-inquiries/:id/replies`
   returns a `500` with a clear server-side log, rather than silently
   pretending to send (the "no reasonable degraded mode" behavior noted
   above, unlike the Ably best-effort pattern).
