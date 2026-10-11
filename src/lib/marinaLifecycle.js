const pool = require('../db');
const marinaStripe = require('./marinaStripe');
const q = require('./marinaQueries');
const { toCents } = require('./folio');
const { pickTemplate } = require('./marinaContracts');
const { nightsBetween } = require('./marinaPricing');
const { publishMarinaBooking, publishMarinaGuestUpdate } = require('./ably');
const { sendGuestEmail } = require('./marinaEmails');

// Every marina booking status change goes through here: row lock, re-check
// the expected status (and, for guest holds, that the hold hasn't lapsed),
// Stripe with an idempotency key, update, commit -- then publish and email
// outside the transaction. Callers map { ok:false, status, error } to HTTP.

const LIVE = ['hold', 'pending', 'confirmed'];
const fail = (status, error) => ({ ok: false, status, error });

async function withLockedBooking(id, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT mb.*, p.stripe_secret_key, m.response_window_hours, m.auto_confirm,
              (mb.hold_expires_at IS NOT NULL AND mb.hold_expires_at <= now()) AS lapsed
       FROM marina_booking mb
       JOIN property p ON p.id = mb.property_id
       JOIN marina m ON m.id = mb.marina_id
       WHERE mb.id = $1 FOR UPDATE OF mb`, [id]);
    if (!row) { await client.query('ROLLBACK'); return fail(404, 'Booking not found'); }
    const result = await fn(client, row);
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    if (result.ok && result.booking) {
      const after = await q.joinedBooking(pool, id);
      // Through module.exports so the publish/email step can be filled in
      // (and stubbed) without reordering this file.
      module.exports.afterChange(row, after);
      // Keeps flags like expired / paymentFailed for the caller.
      return { ...result, ok: true, booking: after };
    }
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setRow(client, id, fields) {
  const cols = Object.keys(fields);
  const { rows: [r] } = await client.query(
    `UPDATE marina_booking SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
    [...Object.values(fields), id]);
  return r;
}

// hold -> pending. Guest rows start the staff response window; staff rows
// never expire.
async function toPending(client, row, extra = {}) {
  const { rows: [r] } = await client.query(
    `UPDATE marina_booking SET status = 'pending', confirm_token_hash = NULL, updated_at = now(),
            hold_expires_at = CASE WHEN source = 'guest' THEN now() + make_interval(hours => $2) END
            ${Object.keys(extra).map((c, i) => `, ${c} = $${i + 3}`).join('')}
     WHERE id = $1 RETURNING *`,
    [row.id, row.response_window_hours, ...Object.values(extra)]);
  return r;
}

const stripeOf = (row) => marinaStripe.stripeFor(row.stripe_secret_key);

// The PI must be this booking's, for its exact amount and currency, and
// authorised but not captured. Stripe reports currency in lower case.
function piMatches(pi, row) {
  return pi.id === row.stripe_payment_intent_id
    && pi.metadata?.marina_booking_id === row.id
    && pi.amount === toCents(row.total_price)
    && String(pi.currency).toLowerCase() === String(row.currency).toLowerCase()
    && pi.status === 'requires_capture';
}

// One rule for confirm-payment and the sweep: a hold whose card is
// authorised becomes pending, even if the 30 minutes just ran out (the
// guest did everything right; cancelling would strand the authorisation).
// Returns the updated row, or null when the card isn't (validly) held.
async function promoteHeldBooking(client, row) {
  if (row.status !== 'hold' || !row.stripe_payment_intent_id || !row.stripe_secret_key) return null;
  const pi = await stripeOf(row).paymentIntents.retrieve(row.stripe_payment_intent_id);
  if (!piMatches(pi, row)) return null;
  return toPending(client, row, { payment_status: 'held', payment_error: null });
}

// Cancels an uncaptured PI. true = released (or nothing to release). On
// failure the error is kept on the row for staff and the sweep's retry.
async function releasePi(client, row) {
  if (!row.stripe_payment_intent_id || !['none', 'held'].includes(row.payment_status)) return true;
  // Key cleared since the hold was made: let the booking end (the berth
  // must free up) and leave the release to the retry once a key is back.
  if (!row.stripe_secret_key) {
    await setRow(client, row.id, { payment_error: 'Stripe key not configured; card hold not released' });
    return false;
  }
  const stripe = stripeOf(row);
  try {
    await stripe.paymentIntents.cancel(row.stripe_payment_intent_id, {}, { idempotencyKey: `marina-cancel-${row.id}` });
    return true;
  } catch (err) {
    const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id).catch(() => null);
    if (pi?.status === 'canceled') return true;
    await setRow(client, row.id, { payment_error: err.message });
    return false;
  }
}

async function confirmBooking(id) {
  return withLockedBooking(id, async (client, row) => {
    if (row.status !== 'pending') return fail(409, `Booking is ${row.status}`);
    if (row.lapsed) {
      const released = await releasePi(client, row);
      await setRow(client, id, { status: 'cancelled', cancel_reason: 'expired', hold_expires_at: null,
        ...(row.stripe_payment_intent_id && released ? { payment_status: 'released', payment_error: null } : {}) });
      return { ok: true, booking: true, expired: true };
    }
    let payment = {};
    if (row.stripe_payment_intent_id) {
      if (row.payment_status !== 'held') return fail(409, 'The card hold is not in place');
      try {
        await stripeOf(row).paymentIntents.capture(row.stripe_payment_intent_id, {}, { idempotencyKey: `marina-capture-${row.id}` });
      } catch (err) {
        // Stays pending with the reason recorded -- committed, not rolled
        // back, so staff see it.
        await setRow(client, id, { payment_error: err.message });
        return { ok: true, booking: true, paymentFailed: err.message };
      }
      payment = { payment_status: 'captured', payment_error: null };
    }
    return { ok: true, booking: await setRow(client, id, { status: 'confirmed', hold_expires_at: null, ...payment }) };
  });
}

async function declineBooking(id, { reason } = {}) {
  return withLockedBooking(id, async (client, row) => {
    if (row.status !== 'pending') return fail(409, `Booking is ${row.status}`);
    const released = await releasePi(client, row);
    return { ok: true, booking: await setRow(client, id, { status: 'declined', cancel_reason: reason ?? null, hold_expires_at: null,
      ...(row.stripe_payment_intent_id && released ? { payment_status: 'released', payment_error: null } : {}) }) };
  });
}

// by: 'guest' (hold/pending only), 'staff' (any live status). A captured
// payment is refunded only when staff ask (refund: true), else kept.
async function cancelBooking(id, { by, refund = false, reason = null } = {}) {
  return withLockedBooking(id, async (client, row) => {
    const allowed = by === 'staff' ? LIVE : ['hold', 'pending'];
    if (!allowed.includes(row.status)) return fail(409, `Booking is ${row.status}`);
    let payment = {};
    if (row.payment_status === 'captured') {
      if (refund) {
        try {
          await stripeOf(row).refunds.create({ payment_intent: row.stripe_payment_intent_id }, { idempotencyKey: `marina-refund-${row.id}` });
          payment = { payment_status: 'refunded', payment_error: null };
        } catch (err) {
          await setRow(client, id, { payment_error: err.message });
          return { ok: true, booking: true, paymentFailed: err.message };
        }
      }
    } else if (row.stripe_payment_intent_id && await releasePi(client, row)) {
      payment = { payment_status: 'released', payment_error: null };
    }
    return { ok: true, booking: await setRow(client, id, { status: 'cancelled', cancel_reason: reason, hold_expires_at: null, ...payment }) };
  });
}

// Ends an open-ended (or shortens a) confirmed stay.
async function endBooking(id, departure) {
  return withLockedBooking(id, async (client, row) => {
    if (row.status !== 'confirmed') return fail(409, `Booking is ${row.status}`);
    if (departure <= row.arrival) return fail(400, 'departure must be after arrival');
    return { ok: true, booking: await setRow(client, id, { departure }) };
  });
}

// Which guest email a transition sends, by source (spec "Emails"):
// guest rows get every one; staff rows with an email get the outcomes;
// imports get none.
function emailKind(before, after) {
  if (after.source === 'import' || !after.contact_email) return null;
  const from = before?.status ?? null;
  const to = after.status;
  if (from === to) return null;
  if (to === 'pending' && after.source === 'guest') return 'pending';
  if (to === 'confirmed') return 'confirmed';
  if (to === 'declined') return 'declined';
  if (to === 'cancelled' && from !== 'hold') return after.cancel_reason === 'expired' ? 'expired' : 'cancelled';
  return null;
}

// Publish + email after commit. Never throws. `before` is null for a new
// row. Holds are invisible to staff, so a hold reaching pending is the
// staff feed's "new-booking".
function afterChange(before, after) {
  // Staff never see holds -- so neither a hold nor a hold that lapsed or
  // was abandoned (cancelled straight from hold) reaches their feed.
  const visible = after.status !== 'hold' && !(before?.status === 'hold' && after.status === 'cancelled');
  const isNew = !before || before.status === 'hold';
  if (visible) {
    publishMarinaBooking(after.property_id, isNew ? 'new-booking' : 'booking-status-changed', after)
      .catch((err) => console.error('Ably publish failed:', err.message));
  }
  if (before && before.status !== after.status) {
    publishMarinaGuestUpdate(after.id, after.status).catch((err) => console.error('Ably publish failed:', err.message));
  }
  if (!before && after.status === 'hold' && after._confirmToken) {
    const confirmUrl = `${process.env.OTA_API_BASE_URL}/api/marina/confirm-booking/${after.id}/${after._confirmToken}`;
    sendGuestEmail(after, 'received', { confirmUrl });
    return;
  }
  const kind = emailKind(before, after);
  if (kind) sendGuestEmail(after, kind);
}

// Lapsed guest holds and unanswered pending requests. Each row is handled
// under its own row lock, so the sweep and a staff confirm can't both win:
// whichever locks second re-checks the status the first one left.
async function sweepOnce() {
  const { rows } = await pool.query(
    `SELECT id FROM marina_booking
     WHERE source = 'guest' AND status IN ('hold', 'pending') AND hold_expires_at < now()
     ORDER BY hold_expires_at LIMIT 200`);
  let cancelled = 0;
  let promoted = 0;
  for (const { id } of rows) {
    try {
      const r = await sweepRow(id);
      if (r === 'cancelled') cancelled++;
      if (r === 'promoted') {
        promoted++;
        module.exports.maybeAutoConfirm(id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
      }
    } catch (err) {
      console.error(`Marina sweep failed for ${id}:`, err.message);
    }
  }
  await retryReleases();
  return { cancelled, promoted };
}

async function sweepRow(id) {
  let outcome = null;
  await withLockedBooking(id, async (client, row) => {
    if (!(row.source === 'guest' && ['hold', 'pending'].includes(row.status) && row.lapsed)) return fail(409, 'changed');
    // No webhook: a guest who authorised the card and closed the tab is
    // caught here instead.
    if (row.status === 'hold') {
      const promotedRow = await promoteHeldBooking(client, row);
      if (promotedRow) { outcome = 'promoted'; return { ok: true, booking: promotedRow }; }
    }
    const released = await releasePi(client, row);
    await setRow(client, id, { status: 'cancelled', cancel_reason: 'expired', hold_expires_at: null,
      ...(row.stripe_payment_intent_id && released ? { payment_status: 'released', payment_error: null } : {}) });
    outcome = 'cancelled';
    return { ok: true, booking: true };
  });
  return outcome;
}

// Bookings that ended but whose card release failed (payment_error kept):
// try again each pass until Stripe accepts it.
async function retryReleases() {
  const { rows } = await pool.query(
    `SELECT id FROM marina_booking
     WHERE status IN ('cancelled', 'declined') AND stripe_payment_intent_id IS NOT NULL
       AND payment_status IN ('none', 'held') AND payment_error IS NOT NULL
     ORDER BY updated_at LIMIT 50`);
  for (const { id } of rows) {
    await withLockedBooking(id, async (client, row) => {
      // Still failing: keep the error (setRow also bumps updated_at, so
      // this row goes to the back of the queue) but publish nothing.
      if (!(await releasePi(client, row))) return { ok: true };
      return { ok: true, booking: await setRow(client, id, { payment_status: 'released', payment_error: null }) };
    }).catch((err) => console.error(`Marina release retry failed for ${id}:`, err.message));
  }
}

// Opt-in per marina. Runs when a booking reaches pending, after a document
// is verified, and after the contract is agreed. Confirms only when every
// mandatory requirement has a verified document, the applicable contract
// (if any) is agreed, and -- only if there's a PaymentIntent -- the card is
// held. Extracted document data plays no part.
async function maybeAutoConfirm(id) {
  const { rows: [b] } = await pool.query(
    `SELECT mb.id, mb.status, mb.arrival, mb.departure, mb.marina_id, mb.stripe_payment_intent_id, mb.payment_status, m.auto_confirm
     FROM marina_booking mb JOIN marina m ON m.id = mb.marina_id WHERE mb.id = $1`, [id]);
  if (!b || !b.auto_confirm || b.status !== 'pending') return null;
  if (b.stripe_payment_intent_id && b.payment_status !== 'held') return null;
  const { rows: [{ missing }] } = await pool.query(
    `SELECT count(*)::int AS missing FROM marina_doc_requirement r
     WHERE r.marina_id = $1 AND r.status = 'active' AND r.mandatory
       AND NOT EXISTS (SELECT 1 FROM marina_document d WHERE d.booking_id = $2 AND d.requirement_id = r.id AND d.status = 'verified')`,
    [b.marina_id, id]);
  if (missing) return null;
  if (b.departure) {
    const { rows: templates } = await pool.query("SELECT id, min_nights FROM marina_contract_template WHERE marina_id = $1 AND status = 'active'", [b.marina_id]);
    const t = pickTemplate(templates, nightsBetween(b.arrival, b.departure));
    if (t) {
      const { rowCount } = await pool.query('SELECT 1 FROM marina_contract_signature WHERE booking_id = $1', [id]);
      if (!rowCount) return null;
    }
  }
  // confirmBooking re-checks status under the row lock and captures first.
  const r = await confirmBooking(id);
  return r.ok && r.booking.status === 'confirmed' ? r.booking : null;
}

function startMarinaHoldExpiryJob() {
  const run = () => sweepOnce()
    .then(({ cancelled, promoted }) => { if (cancelled || promoted) console.log(`Marina holds: cancelled ${cancelled}, promoted ${promoted}`); })
    .catch((err) => console.error('Marina hold sweep failed:', err.message));
  run();
  setInterval(run, 60 * 1000).unref();
}

module.exports = {
  promoteHeldBooking, piMatches, maybeAutoConfirm, sweepOnce, startMarinaHoldExpiryJob, withLockedBooking, setRow, toPending, confirmBooking, declineBooking, cancelBooking, endBooking, afterChange, LIVE, fail };
