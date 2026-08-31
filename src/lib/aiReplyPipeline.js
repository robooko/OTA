// Orchestrates AI-drafted replies for event inquiries: decides whether to
// generate, persists drafts, and sends them (auto or on approval) through the
// shared outbound path. Owns every DB write to event_inquiry_ai_draft.
//
// Import graph (no cycles): this -> db, ably, aiReplies (SDK only),
// inquiryReplies (send path). Controllers import this; it never imports them.
const pool = require('../db');
const { publishAiDraftReady, publishAiDraftUpdated } = require('./ably');
const { isConfigured, generateInquiryReply, AiReplyError, MODEL } = require('./aiReplies');
const { loadInquiryWithProperty, sendOutboundReply } = require('./inquiryReplies');

// Hard cap on unreviewed sends per inquiry. Defends against an auto-responder
// on the guest's side (out-of-office bouncing our reply back, each bounce
// re-triggering a draft) and against a guest who keeps asking things the
// model can't resolve -- after this many, every further draft waits for a
// human regardless of score.
const MAX_AUTO_SENT_PER_INQUIRY = 3;

// Thrown when a send is attempted on a draft that isn't pending -- already
// sent, rejected, superseded, or claimed by a concurrent approve. Controllers
// map it to 409.
class DraftNotPendingError extends Error {
  constructor(draftId) {
    super('Draft is not pending');
    this.name = 'DraftNotPendingError';
    this.draftId = draftId;
  }
}

function publishReady(inquiry, draft) {
  publishAiDraftReady(inquiry.property_id, { inquiry_id: inquiry.id, name: inquiry.name, draft })
    .catch((err) => console.error('Ably publish failed:', err.message));
}

function publishUpdated(propertyId, inquiryId, draft) {
  publishAiDraftUpdated(propertyId, { inquiry_id: inquiryId, draft })
    .catch((err) => console.error('Ably publish failed:', err.message));
}

// A pending draft is stale the moment anything newer happens on the thread:
// a fresh draft, or a human reply. Marks them superseded and tells the feed.
async function supersedePendingDrafts(inquiryId, { exceptDraftId = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE event_inquiry_ai_draft SET status = 'superseded'
     WHERE event_inquiry_id = $1 AND status = 'pending' AND ($2::uuid IS NULL OR id <> $2)
     RETURNING *`,
    [inquiryId, exceptDraftId]
  );
  for (const draft of rows) publishUpdated(draft.property_id, inquiryId, draft);
  return rows;
}

// Generates and stores one draft for an inquiry (loaded via
// loadInquiryWithProperty, so it carries property_name and the AI settings).
// Never sends. Generation failures become a 'failed' row rather than an
// exception: the queue then shows "needs a human" with the error, which is
// the useful outcome for staff, and the caller (webhook, createInquiry, or
// the manual endpoint) doesn't have to care why the model didn't answer.
async function generateDraft({ inquiry, triggerType, triggerMessageId = null }) {
  await supersedePendingDrafts(inquiry.id);

  const [{ rows: thread }, { rows: restaurantRows }, { rows: spaRows }] = await Promise.all([
    pool.query(
      'SELECT direction, body, created_at FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
      [inquiry.id]
    ),
    inquiry.restaurant_id
      ? pool.query('SELECT name, description FROM restaurant WHERE id = $1', [inquiry.restaurant_id])
      : Promise.resolve({ rows: [] }),
    inquiry.spa_id
      ? pool.query('SELECT name, description FROM spa WHERE id = $1', [inquiry.spa_id])
      : Promise.resolve({ rows: [] }),
  ]);

  let draftRow;
  try {
    const result = await generateInquiryReply({
      property: { name: inquiry.property_name, ai_reply_instructions: inquiry.ai_reply_instructions },
      inquiry,
      restaurant: restaurantRows[0] ?? null,
      spa: spaRows[0] ?? null,
      thread,
      triggerType,
    });
    ({ rows: [draftRow] } = await pool.query(
      `INSERT INTO event_inquiry_ai_draft
         (property_id, event_inquiry_id, trigger_type, trigger_message_id, body, quality_score,
          requires_human, requires_human_reason, summary, status, model,
          input_tokens, output_tokens, cache_read_input_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13) RETURNING *`,
      [inquiry.property_id, inquiry.id, triggerType, triggerMessageId, result.body, result.quality_score,
        result.requires_human, result.requires_human_reason, result.summary, result.model,
        result.usage.input_tokens, result.usage.output_tokens, result.usage.cache_read_input_tokens]
    ));
  } catch (err) {
    if (!(err instanceof AiReplyError)) throw err; // a DB error is a real 500, not a model failure
    console.error(`AI draft generation failed for inquiry ${inquiry.id} (${err.kind}):`, err.message);
    ({ rows: [draftRow] } = await pool.query(
      `INSERT INTO event_inquiry_ai_draft
         (property_id, event_inquiry_id, trigger_type, trigger_message_id, body, quality_score,
          requires_human, requires_human_reason, summary, status, model, error)
       VALUES ($1, $2, $3, $4, '', 0, true, $5, NULL, 'failed', $6, $7) RETURNING *`,
      [inquiry.property_id, inquiry.id, triggerType, triggerMessageId,
        err.kind === 'refusal' ? 'The model declined to draft this reply' : 'Draft generation failed',
        MODEL, err.message]
    ));
  }

  publishReady(inquiry, draftRow);
  return draftRow;
}

// Sends a pending draft to the guest. body may differ from draft.body when
// the approver edited it. sender is the reviewing staff member (null for an
// auto-send). auto marks the draft as sent without review.
//
// The pending -> sending claim is what makes this safe under concurrency and
// partial failure:
//   - two approvals race: exactly one UPDATE matches, the other gets 409.
//   - Resend fails: nothing was sent, draft goes back to pending (retryable).
//   - Resend succeeds but the finalising UPDATE fails: the draft stays in
//     'sending' with error set -- visible as stuck, never re-approvable, so
//     the guest can't be emailed twice.
async function sendDraft({ draft, inquiry, body, sender = null, auto = false }) {
  const { rows: claimed } = await pool.query(
    `UPDATE event_inquiry_ai_draft SET status = 'sending', error = NULL
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [draft.id]
  );
  if (!claimed.length) throw new DraftNotPendingError(draft.id);

  let sent;
  try {
    sent = await sendOutboundReply({ inquiry, body, sender, aiDraftId: draft.id });
  } catch (err) {
    await pool.query(
      `UPDATE event_inquiry_ai_draft SET status = 'pending', error = $2 WHERE id = $1`,
      [draft.id, `Send failed: ${err.message}`]
    ).catch((dbErr) => console.error('Failed to release draft claim:', dbErr.message));
    throw err;
  }

  let finalDraft;
  try {
    ({ rows: [finalDraft] } = await pool.query(
      `UPDATE event_inquiry_ai_draft SET
         status = 'sent', auto_sent = $2, sent_message_id = $3,
         sent_body = CASE WHEN $4::text IS DISTINCT FROM body THEN $4::text ELSE NULL END,
         reviewed_by_user_id = $5, reviewed_by_name = $6, reviewed_at = now(), error = NULL
       WHERE id = $1 RETURNING *`,
      [draft.id, auto, sent.message.id, body, sender?.user_id ?? null, sender?.name ?? null]
    ));
  } catch (err) {
    await pool.query(
      `UPDATE event_inquiry_ai_draft SET error = $2 WHERE id = $1`,
      [draft.id, `Sent (message ${sent.message.id}) but failed to record: ${err.message}`]
    ).catch((dbErr) => console.error('Failed to record draft send error:', dbErr.message));
    throw err;
  }

  publishUpdated(inquiry.property_id, inquiry.id, finalDraft);
  return { draft: finalDraft, message: sent.message, inquiry: sent.inquiry };
}

// Fire-and-forget entry point for the two automatic triggers (new inquiry,
// inbound guest reply). Everything that can legitimately mean "do nothing"
// returns quietly; only unexpected errors propagate to the caller's .catch.
async function runAiReply({ inquiryId, triggerType, triggerMessageId = null }) {
  if (!isConfigured()) {
    console.warn(`AI reply skipped for inquiry ${inquiryId}: ANTHROPIC_API_KEY is not set`);
    return null;
  }
  const inquiry = await loadInquiryWithProperty(inquiryId);
  if (!inquiry) return null;
  if (inquiry.ai_reply_mode === 'off') return null;
  // A closed inquiry is a settled conversation -- a late guest email is for
  // a human to notice, not for the model to reopen.
  if (inquiry.status === 'closed') return null;

  const draft = await generateDraft({ inquiry, triggerType, triggerMessageId });

  if (draft.status !== 'pending' || inquiry.ai_reply_mode !== 'auto') return draft;
  if (draft.requires_human || draft.quality_score < inquiry.ai_reply_auto_send_min_score) return draft;

  const { rows: [{ count }] } = await pool.query(
    'SELECT count(*)::int AS count FROM event_inquiry_ai_draft WHERE event_inquiry_id = $1 AND auto_sent',
    [inquiry.id]
  );
  if (count >= MAX_AUTO_SENT_PER_INQUIRY) {
    console.warn(`AI auto-send cap reached for inquiry ${inquiry.id}; draft ${draft.id} left pending`);
    return draft;
  }

  try {
    const { draft: sentDraft } = await sendDraft({ draft, inquiry, body: draft.body, sender: null, auto: true });
    return sentDraft;
  } catch (err) {
    if (err instanceof DraftNotPendingError) return draft; // superseded/handled between generate and send
    // Send failures are already recorded on the row (back to pending with
    // error), so staff can still approve it by hand. Log and stop.
    console.error(`AI auto-send failed for draft ${draft.id}:`, err.message);
    return draft;
  }
}

module.exports = {
  runAiReply, generateDraft, sendDraft, supersedePendingDrafts,
  DraftNotPendingError, MAX_AUTO_SENT_PER_INQUIRY,
};
