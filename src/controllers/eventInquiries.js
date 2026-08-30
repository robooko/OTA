const { createClerkClient } = require('@clerk/backend');
const EmailReplyParser = require('email-reply-parser').default;
const pool = require('../db');
const { isValidDate, isValidUuid, isValidTime } = require('../middleware/validate');
const { publishNewInquiry, publishNewReply, publishInquiryUpdated, publishAiDraftUpdated } = require('../lib/ably');
const { verifyInboundWebhook, getReceivedEmail } = require('../lib/resend');
const { loadInquiryWithProperty, sendOutboundReply } = require('../lib/inquiryReplies');
const { isConfigured: aiConfigured } = require('../lib/aiReplies');
const { runAiReply, supersedePendingDrafts, generateDraft, sendDraft, DraftNotPendingError } = require('../lib/aiReplyPipeline');

const AI_DRAFT_STATUSES = ['pending', 'sending', 'sent', 'rejected', 'superseded', 'failed'];

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function listInquiries(req, res, next) {
  try {
    // last_reply_direction drives the feed's avatar-vs-status-badge display
    // (event-inquiries-feed, hotal-ui >= 0.12.12) -- 'outbound' means staff
    // last replied, 'inbound' means the guest did, null means no replies yet.
    // sent_by_name/sent_by_avatar_url come from event_inquiry_message,
    // captured at send time (see migrate-2026-08-18-event-inquiry-message-sender.sql);
    // they're null on outbound rows sent before that migration, since there's
    // no way to know who actually sent those.
    // pending_ai_draft_id lets the feed badge rows with an AI draft awaiting
    // approval without a second request; null when nothing is waiting.
    const { rows } = await pool.query(
      `SELECT ei.*, r.name AS restaurant_name, lrm.direction AS last_reply_direction,
              lrm.sent_by_name AS last_reply_by_name, lrm.sent_by_avatar_url AS last_reply_avatar_url,
              pad.id AS pending_ai_draft_id
       FROM event_inquiry ei
       LEFT JOIN restaurant r ON r.id = ei.restaurant_id
       LEFT JOIN LATERAL (
         SELECT direction, sent_by_name, sent_by_avatar_url FROM event_inquiry_message m
         WHERE m.event_inquiry_id = ei.id
         ORDER BY m.created_at DESC LIMIT 1
       ) lrm ON true
       LEFT JOIN LATERAL (
         SELECT id FROM event_inquiry_ai_draft d
         WHERE d.event_inquiry_id = ei.id AND d.status = 'pending'
         ORDER BY d.created_at DESC LIMIT 1
       ) pad ON true
       WHERE ei.property_id = $1 ORDER BY ei.created_at DESC`,
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// Confirms restaurant_id, if given, is a real restaurant on this property --
// prevents an inquiry from being tagged with another property's restaurant.
async function validateRestaurantId(restaurant_id, property_id) {
  if (restaurant_id == null) return true;
  if (!isValidUuid(restaurant_id)) return false;
  const { rows } = await pool.query('SELECT 1 FROM restaurant WHERE id = $1 AND property_id = $2', [restaurant_id, property_id]);
  return rows.length > 0;
}

async function createInquiry(req, res, next) {
  try {
    const { name, email, phone, event_date, guests, event_type, format, message, restaurant_id } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }
    // event_date is optional -- a general enquiry ("do you do X?") has no
    // date. When given it must still be a real date.
    if (event_date != null && !isValidDate(event_date)) return res.status(400).json({ error: 'Invalid date format' });
    if (!(await validateRestaurantId(restaurant_id, req.property_id))) {
      return res.status(400).json({ error: 'restaurant_id must belong to this property' });
    }

    const { rows } = await pool.query(
      `INSERT INTO event_inquiry (property_id, restaurant_id, name, email, phone, event_date, guests, event_type, format, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.property_id, restaurant_id || null, name, email, phone || null, event_date ?? null, guests || null, event_type || null, format || null, message || null]
    );

    publishNewInquiry(req.property_id, rows[0]).catch((err) => console.error('Ably publish failed:', err.message));
    // Fire-and-forget like the Ably publish: drafting takes tens of seconds
    // and the inquiry is already safely stored, so the caller (usually the
    // property's public website) gets its 201 immediately. The pipeline
    // no-ops unless the property has opted in (ai_reply_mode != 'off').
    runAiReply({ inquiryId: rows[0].id, triggerType: 'new_inquiry' })
      .catch((err) => console.error('AI reply pipeline failed:', err.message));

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateInquiry(req, res, next) {
  try {
    const { status, restaurant_id, event_date, event_time, guests, name, email, phone } = req.body;
    if (restaurant_id !== undefined && !(await validateRestaurantId(restaurant_id, req.property_id))) {
      return res.status(400).json({ error: 'restaurant_id must belong to this property' });
    }
    if (event_date !== undefined && event_date !== null && !isValidDate(event_date)) {
      return res.status(400).json({ error: 'Invalid event_date format' });
    }
    if (event_time !== undefined && event_time !== null && !isValidTime(event_time)) {
      return res.status(400).json({ error: 'Invalid event_time format, use HH:MM' });
    }
    if (guests !== undefined && guests !== null && (!Number.isInteger(guests) || guests <= 0)) {
      return res.status(400).json({ error: 'guests must be a positive integer' });
    }
    if (name !== undefined && !name) {
      return res.status(400).json({ error: 'name cannot be empty' });
    }
    if (email !== undefined && !email) {
      return res.status(400).json({ error: 'email cannot be empty' });
    }
    const { rows } = await pool.query(
      `UPDATE event_inquiry SET
         status        = COALESCE($1, status),
         restaurant_id = COALESCE($2, restaurant_id),
         event_date    = COALESCE($3, event_date),
         event_time    = COALESCE($4, event_time),
         guests        = COALESCE($5, guests),
         name          = COALESCE($6, name),
         email         = COALESCE($7, email),
         phone         = COALESCE($8, phone)
       WHERE id = $9 AND property_id = $10 RETURNING *`,
      [status, restaurant_id, event_date, event_time, guests, name, email, phone, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Inquiry not found' });

    publishInquiryUpdated(req.property_id, rows[0]).catch((err) => console.error('Ably publish failed:', err.message));

    res.json(rows[0]);
  } catch (err) { next(err); }
}

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

    const inquiry = await loadInquiryWithProperty(req.params.id, req.property_id);
    if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });

    const sender = await resolveSender(req);
    const { message, inquiry: updatedInquiry } = await sendOutboundReply({ inquiry, body, sender });

    // A human just replied, so any AI draft still waiting for approval is
    // answering a moment that has passed -- retire it rather than leave a
    // stale draft in the queue.
    supersedePendingDrafts(inquiry.id).catch((err) => console.error('Failed to supersede AI drafts:', err.message));

    res.status(201).json({ message, inquiry: updatedInquiry });
  } catch (err) { next(err); }
}

// Who is sending, for message attribution. req.user is only set for
// Clerk-authenticated staff -- an API-key/MCP caller has no Clerk identity to
// look up, so their replies are stored unattributed rather than attempted
// against a missing user id. Best-effort: a Clerk hiccup shouldn't block a
// reply, it just means this row won't carry a sender (same as replies sent
// before sender attribution existed).
async function resolveSender(req) {
  if (!req.user) return null;
  try {
    const user = await clerkClient.users.getUser(req.user.id);
    return {
      user_id: req.user.id,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Staff',
      avatar_url: user.imageUrl,
    };
  } catch (err) {
    console.error('Failed to look up sender for reply attribution:', err.message);
    return { user_id: req.user.id, name: null, avatar_url: null };
  }
}

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

    const candidateAddresses = [
      ...(event.data.received_for ?? []),
      ...(event.data.to ?? []),
      ...(event.data.cc ?? []),
    ];
    const uuidRegex = /^inquiry\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i;
    let inquiryId = null;
    for (const addr of candidateAddresses) {
      const match = addr.match(uuidRegex);
      if (match) { inquiryId = match[1]; break; }
    }
    if (!inquiryId) {
      console.warn('Resend inbound webhook: no recognized inquiry address in', candidateAddresses);
      return res.status(200).end();
    }

    const { rows: inquiryRows } = await pool.query('SELECT * FROM event_inquiry WHERE id = $1', [inquiryId]);
    if (!inquiryRows.length) {
      console.warn('Resend inbound webhook: no matching inquiry for id', inquiryId);
      return res.status(200).end();
    }
    const inquiry = inquiryRows[0];

    const email = await getReceivedEmail(event.data.email_id);
    const text = email.text ?? stripHtml(email.html ?? '');
    // Guest replies come back with the whole quoted thread glued below the new
    // text (their client re-includes our own "Previous messages" block, which
    // would otherwise re-grow with every round trip) -- strip it down to just
    // what the guest actually typed. Heuristic-based, so fall back to the raw
    // text if parsing strips everything (e.g. an unrecognized quote format).
    const body = new EmailReplyParser().read(text).getVisibleText().trim() || text;

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id)
         VALUES ($1, 'inbound', $2, $3) RETURNING *`,
        [inquiry.id, body, event.data.email_id]
      ));
    } catch (err) {
      if (err.code === '23505') return res.status(200).end();
      throw err;
    }

    publishNewReply(inquiry.property_id, { inquiry_id: inquiry.id, name: inquiry.name, message: rows[0] })
      .catch((err) => console.error('Ably publish failed:', err.message));
    // Fire-and-forget: Resend retries deliveries that don't get a prompt
    // 200, and a retry would re-enter this handler -- the 23505 guard above
    // dedupes the row, but the model call must never sit on the webhook's
    // clock. Drafts trigger on the guest's reply; the pipeline decides
    // whether to auto-send or queue for approval.
    runAiReply({ inquiryId: inquiry.id, triggerType: 'inbound_reply', triggerMessageId: rows[0].id })
      .catch((err) => console.error('AI reply pipeline failed:', err.message));

    res.status(200).end();
  } catch (err) { next(err); }
}

// ── AI drafts ───────────────────────────────────────────────────────────────

// Approval queue across the property. Defaults to pending (what staff act
// on); ?status= any other lifecycle state for history/debugging.
async function listAiDrafts(req, res, next) {
  try {
    const status = req.query.status ?? 'pending';
    if (!AI_DRAFT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${AI_DRAFT_STATUSES.join(', ')}` });
    }
    const { rows } = await pool.query(
      `SELECT d.*, ei.name AS inquiry_name, ei.email AS inquiry_email, ei.event_date AS inquiry_event_date,
              ei.status AS inquiry_status
       FROM event_inquiry_ai_draft d
       JOIN event_inquiry ei ON ei.id = d.event_inquiry_id
       WHERE d.property_id = $1 AND d.status = $2
       ORDER BY d.created_at DESC`,
      [req.property_id, status]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function listInquiryAiDrafts(req, res, next) {
  try {
    const { rows: inquiryRows } = await pool.query(
      'SELECT id FROM event_inquiry WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!inquiryRows.length) return res.status(404).json({ error: 'Inquiry not found' });

    const { rows } = await pool.query(
      'SELECT * FROM event_inquiry_ai_draft WHERE event_inquiry_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// On-demand draft. Synchronous (tens of seconds) since the caller is waiting
// to read it. Never sends, whatever the property's mode -- a staff member
// asking for a draft is not automation -- and works even when the mode is
// 'off', which only governs the automatic triggers. Still 201 when the row
// comes back 'failed': the row is the answer ("needs a human, here's why").
async function generateAiDraft(req, res, next) {
  try {
    if (!aiConfigured()) return res.status(503).json({ error: 'AI replies are not configured on this server' });

    const inquiry = await loadInquiryWithProperty(req.params.id, req.property_id);
    if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });

    const draft = await generateDraft({ inquiry, triggerType: 'manual' });
    res.status(201).json(draft);
  } catch (err) { next(err); }
}

async function loadScopedDraft(draftId, inquiryId, propertyId) {
  const { rows } = await pool.query(
    'SELECT * FROM event_inquiry_ai_draft WHERE id = $1 AND event_inquiry_id = $2 AND property_id = $3',
    [draftId, inquiryId, propertyId]
  );
  return rows[0] ?? null;
}

// Sends a pending draft, optionally with an edited body. 409 if the draft
// has already moved on (sent, rejected, superseded) -- including the case
// where two staff approve at once and this request lost the claim.
async function approveAiDraft(req, res, next) {
  try {
    if (!isValidUuid(req.params.draftId)) return res.status(400).json({ error: 'Invalid draft id' });
    const { body } = req.body ?? {};
    if (body !== undefined && (typeof body !== 'string' || !body.trim())) {
      return res.status(400).json({ error: 'body, if provided, must be a non-empty string' });
    }

    const inquiry = await loadInquiryWithProperty(req.params.id, req.property_id);
    if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });
    const draft = await loadScopedDraft(req.params.draftId, inquiry.id, req.property_id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status !== 'pending') return res.status(409).json({ error: 'Draft is not pending' });

    const sender = await resolveSender(req);
    let result;
    try {
      result = await sendDraft({ draft, inquiry, body: body?.trim() ?? draft.body, sender, auto: false });
    } catch (err) {
      if (err instanceof DraftNotPendingError) return res.status(409).json({ error: 'Draft is not pending' });
      throw err;
    }
    res.json(result);
  } catch (err) { next(err); }
}

async function rejectAiDraft(req, res, next) {
  try {
    if (!isValidUuid(req.params.draftId)) return res.status(400).json({ error: 'Invalid draft id' });
    const { reason } = req.body ?? {};
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return res.status(400).json({ error: 'reason must be a string' });
    }

    const { rows: inquiryRows } = await pool.query(
      'SELECT id FROM event_inquiry WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!inquiryRows.length) return res.status(404).json({ error: 'Inquiry not found' });

    const sender = await resolveSender(req);
    const { rows } = await pool.query(
      `UPDATE event_inquiry_ai_draft SET
         status = 'rejected', reject_reason = $1,
         reviewed_by_user_id = $2, reviewed_by_name = $3, reviewed_at = now()
       WHERE id = $4 AND event_inquiry_id = $5 AND property_id = $6 AND status = 'pending'
       RETURNING *`,
      [reason?.trim() || null, sender?.user_id ?? null, sender?.name ?? null, req.params.draftId, req.params.id, req.property_id]
    );
    if (!rows.length) {
      // Distinguish "no such draft" from "exists but already handled".
      const existing = await loadScopedDraft(req.params.draftId, req.params.id, req.property_id);
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      return res.status(409).json({ error: 'Draft is not pending' });
    }

    publishAiDraftUpdated(req.property_id, { inquiry_id: req.params.id, draft: rows[0] })
      .catch((err) => console.error('Ably publish failed:', err.message));

    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listInquiries, createInquiry, updateInquiry, listReplies, createReply, handleResendInboundWebhook,
  listAiDrafts, listInquiryAiDrafts, generateAiDraft, approveAiDraft, rejectAiDraft,
};
