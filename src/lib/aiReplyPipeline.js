// Orchestrates AI-drafted replies for event inquiries: decides whether to
// generate, persists drafts, and sends them (auto or on approval) through the
// shared outbound path. Owns every DB write to event_inquiry_ai_draft.
//
// Import graph (no cycles): this -> db, ably, aiReplies (SDK only),
// inquiryReplies (send path), controllers/spa (bookFromAvailability only --
// spa never imports this module or eventInquiries). eventInquiries imports
// this; it never imports eventInquiries.
const pool = require('../db');
const { publishAiDraftReady, publishAiDraftUpdated } = require('./ably');
const { isConfigured, generateInquiryReply, AiReplyError, MODEL } = require('./aiReplies');
const { loadInquiryWithProperty, sendOutboundReply } = require('./inquiryReplies');
const { bookFromAvailability } = require('../controllers/spa');
const tokens = require('./tokens');
const { sendInquiryForward } = require('./resend');

// Thrown by generateDraft when the property has no token for the model
// call. runAiReply turns it into the free fallback (forward to the venue's
// inbox); the manual endpoint maps it to 402.
class InsufficientTokensError extends Error {
  constructor(balance, cost) {
    super(`Not enough tokens for an AI reply (balance ${balance}, cost ${cost})`);
    this.name = 'InsufficientTokensError';
    this.status = 402;
    this.balance = balance;
    this.cost = cost;
  }
}

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

// Thrown when a draft's proposed booking can't be made at send time (slot
// taken since the draft was written, treatment renamed, ...). The draft is
// already back in 'pending' with the error recorded; controllers map it to
// 409 so the reviewer sees why nothing was sent.
class ProposedBookingError extends Error {
  constructor(draftId, message) {
    super(message);
    this.name = 'ProposedBookingError';
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

// Everything the model may state as fact about a spa venue -- menu with
// durations and prices, contact details, per-therapist working hours --
// loaded fresh per draft so drafts always quote the current data. This is
// what lets a property's ai_reply_instructions stay policy-and-tone only
// instead of duplicating (and drifting from) the DB.
async function loadSpaContext(spaId) {
  const [{ rows: [spa] }, { rows: treatments }, { rows: hours }] = await Promise.all([
    pool.query('SELECT name, description, phone, address FROM spa WHERE id = $1', [spaId]),
    pool.query(
      "SELECT name, duration_mins, price FROM spa_treatment WHERE spa_id = $1 AND status = 'active' ORDER BY name",
      [spaId]
    ),
    pool.query(
      `SELECT t.name AS therapist_name, h.day_of_week, h.start_time::text AS start_time, h.end_time::text AS end_time
       FROM spa_therapist t JOIN spa_therapist_hours h ON h.therapist_id = t.id
       WHERE t.spa_id = $1 AND t.status = 'active'
       ORDER BY t.name, h.day_of_week`,
      [spaId]
    ),
  ]);
  return spa ? { ...spa, treatments, hours } : null;
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
  // Charged up front so a concurrent trigger can't double-spend on the same
  // balance; refunded below if the model call itself fails.
  const spent = await tokens.spend(inquiry.property_id, 'ai_reply', inquiry.id);
  if (!spent.ok) throw new InsufficientTokensError(spent.balance, spent.cost);

  await supersedePendingDrafts(inquiry.id);

  const [{ rows: thread }, { rows: restaurantRows }, spaContext] = await Promise.all([
    pool.query(
      'SELECT direction, body, created_at FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
      [inquiry.id]
    ),
    inquiry.restaurant_id
      ? pool.query('SELECT name, description FROM restaurant WHERE id = $1', [inquiry.restaurant_id])
      : Promise.resolve({ rows: [] }),
    inquiry.spa_id ? loadSpaContext(inquiry.spa_id) : Promise.resolve(null),
  ]);

  let draftRow;
  try {
    const result = await generateInquiryReply({
      property: { name: inquiry.property_name, currency: inquiry.currency, ai_reply_instructions: inquiry.ai_reply_instructions },
      inquiry,
      restaurant: restaurantRows[0] ?? null,
      spa: spaContext,
      thread,
      triggerType,
    });
    // A proposal is only bookable against a spa diary, so it's dropped (not
    // stored) for inquiries without one -- the draft text then over-promises,
    // which the reviewer catches, rather than approve silently doing nothing.
    const proposal = inquiry.spa_id ? result.proposed_booking : null;
    ({ rows: [draftRow] } = await pool.query(
      `INSERT INTO event_inquiry_ai_draft
         (property_id, event_inquiry_id, trigger_type, trigger_message_id, body, quality_score,
          requires_human, requires_human_reason, summary, status, model,
          input_tokens, output_tokens, cache_read_input_tokens,
          proposed_treatment_name, proposed_date, proposed_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [inquiry.property_id, inquiry.id, triggerType, triggerMessageId, result.body, result.quality_score,
        result.requires_human, result.requires_human_reason, result.summary, result.model,
        result.usage.input_tokens, result.usage.output_tokens, result.usage.cache_read_input_tokens,
        proposal?.treatment_name ?? null, proposal?.date ?? null, proposal?.time ?? null]
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
    // Don't charge for a draft nobody got.
    await tokens.credit(inquiry.property_id, spent.cost, 'ai_reply_refund', { refId: draftRow.id })
      .catch((refundErr) => console.error(`Token refund failed for draft ${draftRow.id}:`, refundErr.message));
  }

  publishReady(inquiry, draftRow);
  return draftRow;
}

// Creates the spa appointment a claimed draft proposed. Treatment is matched
// by exact name (case-insensitive) against the inquiry's spa -- the model is
// told to copy the name from check_availability results verbatim, so a miss
// means the menu changed since the draft was written.
async function bookProposedSlot(claimedDraft, inquiry) {
  const { rows: [treatment] } = await pool.query(
    "SELECT id FROM spa_treatment WHERE spa_id = $1 AND status = 'active' AND lower(name) = lower($2)",
    [inquiry.spa_id, claimedDraft.proposed_treatment_name]
  );
  if (!treatment) {
    throw new ProposedBookingError(claimedDraft.id, `Proposed treatment "${claimedDraft.proposed_treatment_name}" no longer matches the menu`);
  }
  const result = await bookFromAvailability({
    property_id: inquiry.property_id,
    spa_id: inquiry.spa_id,
    treatment_id: treatment.id,
    date: claimedDraft.proposed_date_text,
    time: claimedDraft.proposed_time_text.slice(0, 5),
    contact_name: inquiry.name,
    contact_email: inquiry.email,
    contact_phone: inquiry.phone,
    notes: `Booked from AI reply (draft ${claimedDraft.id})`,
    // Supplied by the website with the enquiry (validated on the way in);
    // the confirmation email then matches a direct website booking's.
    branding: inquiry.branding ?? undefined,
    cancel_url: inquiry.cancel_url ?? undefined,
  });
  if (!result.ok) {
    const why = result.code === 'unavailable'
      ? `Proposed slot ${claimedDraft.proposed_date_text} ${claimedDraft.proposed_time_text.slice(0, 5)} is no longer available`
      : `Proposed booking failed (${result.code})`;
    throw new ProposedBookingError(claimedDraft.id, why);
  }
  await pool.query(
    'UPDATE event_inquiry_ai_draft SET booked_appointment_id = $2 WHERE id = $1',
    [claimedDraft.id, result.appointment.id]
  );
  return result.appointment;
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
     WHERE id = $1 AND status = 'pending'
     RETURNING *, proposed_date::text AS proposed_date_text, proposed_time::text AS proposed_time_text`,
    [draft.id]
  );
  if (!claimed.length) throw new DraftNotPendingError(draft.id);

  // Book the proposed slot before sending, so the reply's "you're booked in"
  // is true by the time the guest reads it. booked_appointment_id makes this
  // idempotent: a retry after a Resend failure won't book twice. Failure puts
  // the draft back to pending with the reason -- nothing was sent, and the
  // reviewer (or the next guest message) takes it from there.
  const c = claimed[0];
  if (c.proposed_treatment_name && c.proposed_date_text && c.proposed_time_text && !c.booked_appointment_id && inquiry.spa_id) {
    try {
      await bookProposedSlot(c, inquiry);
    } catch (err) {
      const reason = err instanceof ProposedBookingError ? err.message : `Booking failed: ${err.message}`;
      await pool.query(
        `UPDATE event_inquiry_ai_draft SET status = 'pending', error = $2 WHERE id = $1`,
        [draft.id, reason]
      ).catch((dbErr) => console.error('Failed to release draft claim:', dbErr.message));
      throw err;
    }
  }

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

  let draft;
  try {
    draft = await generateDraft({ inquiry, triggerType, triggerMessageId });
  } catch (err) {
    if (!(err instanceof InsufficientTokensError)) throw err;
    // Out of tokens: the free alternative is the venue's own inbox. Without
    // a fallback_email the enquiry still sits in the dashboard queue, which
    // is exactly what an 'off' property gets.
    console.warn(`AI reply skipped for inquiry ${inquiry.id}: ${err.message}`);
    if (inquiry.fallback_email) {
      let latestMessage = null;
      if (triggerMessageId) {
        const { rows } = await pool.query('SELECT body FROM event_inquiry_message WHERE id = $1', [triggerMessageId]);
        latestMessage = rows[0]?.body ?? null;
      }
      await sendInquiryForward(inquiry, inquiry.property_name, inquiry.fallback_email, latestMessage)
        .catch((sendErr) => console.error(`Fallback forward failed for inquiry ${inquiry.id}:`, sendErr.message));
    }
    return null;
  }

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
  DraftNotPendingError, ProposedBookingError, InsufficientTokensError, MAX_AUTO_SENT_PER_INQUIRY,
};
