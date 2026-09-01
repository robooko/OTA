// Shared outbound-reply path for event inquiries. Staff replies
// (createReply), AI draft approval and AI auto-send all go through
// sendOutboundReply, so the four side effects -- Resend send, message row,
// new->contacted flip, Ably publish -- can't drift apart between callers.
//
// Deliberately knows nothing about req/Clerk: the caller resolves who is
// sending and passes it in as `sender`, which keeps this importable from
// src/lib/aiReplyPipeline.js without a lib -> controller dependency.
const pool = require('../db');
const { sendReply } = require('./resend');
const { publishNewReply, publishInquiryUpdated, publishNewReplyForSpa, publishInquiryUpdatedForSpa } = require('./ably');

// Inquiry joined to its property, including the property's AI-reply
// settings. propertyId is optional: request handlers pass req.property_id
// for tenant scoping; the pipeline (already holding a trusted id) omits it.
async function loadInquiryWithProperty(inquiryId, propertyId = null) {
  const { rows } = await pool.query(
    `SELECT ei.*, p.name AS property_name, p.currency,
            p.ai_reply_mode, p.ai_reply_instructions, p.ai_reply_auto_send_min_score,
            p.fallback_email, p.email_branding
     FROM event_inquiry ei
     JOIN property p ON p.id = ei.property_id
     WHERE ei.id = $1 AND ($2::uuid IS NULL OR ei.property_id = $2)`,
    [inquiryId, propertyId]
  );
  return rows[0] ?? null;
}

// sender: { user_id, name, avatar_url } for a Clerk-authenticated staff
// member, or null (API-key/MCP caller, or an AI auto-send) -- the row is
// then stored unattributed, as replies always have been on that rail.
// aiDraftId: links the message back to the AI draft it came from, if any.
// Returns { message, inquiry } where inquiry reflects any status flip.
async function sendOutboundReply({ inquiry, body, sender = null, aiDraftId = null }) {
  const { rows: priorMessages } = await pool.query(
    'SELECT direction, body, sent_by_name, created_at FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
    [inquiry.id]
  );

  // Send first, persist second: a Resend failure here means nothing was
  // sent and nothing is recorded, so the caller can simply retry.
  // Branding: the enquiry's own per-request value wins, else the property's
  // Settings -> Branding default -- same precedence as spa booking emails.
  const branding = inquiry.branding ?? inquiry.email_branding ?? undefined;
  const emailId = await sendReply(inquiry, inquiry.property_name, body, priorMessages, branding);

  const { rows } = await pool.query(
    `INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id, sent_by_user_id, sent_by_name, sent_by_avatar_url, ai_draft_id)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7) RETURNING *`,
    [inquiry.id, body, emailId, sender?.user_id ?? null, sender?.name ?? null, sender?.avatar_url ?? null, aiDraftId]
  );
  const message = rows[0];

  // The returned inquiry keeps the shape createReply always responded with:
  // the bare updated row after a status flip, otherwise the loaded row --
  // minus the property's AI settings and email branding, which are joined
  // in for the pipeline/send and have no business in a reply response.
  const { ai_reply_mode, ai_reply_instructions, ai_reply_auto_send_min_score, email_branding, ...publicInquiry } = inquiry;
  let updatedInquiry = publicInquiry;
  if (inquiry.status === 'new') {
    const { rows: statusRows } = await pool.query(
      `UPDATE event_inquiry SET status = 'contacted' WHERE id = $1 RETURNING *`,
      [inquiry.id]
    );
    updatedInquiry = statusRows[0];
    publishInquiryUpdated(inquiry.property_id, updatedInquiry).catch((err) => console.error('Ably publish failed:', err.message));
    if (inquiry.spa_id) {
      publishInquiryUpdatedForSpa(inquiry.spa_id, updatedInquiry).catch((err) => console.error('Ably publish failed:', err.message));
    }
  }

  // Same payload shape as the inbound-webhook publish, so feed clients
  // handle staff, AI and guest replies identically -- the message row
  // carries direction, sender attribution and ai_draft_id.
  publishNewReply(inquiry.property_id, { inquiry_id: inquiry.id, name: inquiry.name, message })
    .catch((err) => console.error('Ably publish failed:', err.message));
  if (inquiry.spa_id) {
    publishNewReplyForSpa(inquiry.spa_id, { inquiry_id: inquiry.id, name: inquiry.name, message })
      .catch((err) => console.error('Ably publish failed:', err.message));
  }

  return { message, inquiry: updatedInquiry };
}

module.exports = { loadInquiryWithProperty, sendOutboundReply };
