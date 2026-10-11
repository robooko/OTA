const pool = require('../db');
const marinaStripe = require('./marinaStripe');
const q = require('./marinaQueries');

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

async function confirmBooking(id) {
  return withLockedBooking(id, async (client, row) => {
    if (row.status !== 'pending') return fail(409, `Booking is ${row.status}`);
    if (row.lapsed) { await setRow(client, id, { status: 'cancelled', cancel_reason: 'expired', hold_expires_at: null }); return { ok: true, booking: true, expired: true }; }
    // (Task 9: capture the PaymentIntent here when stripe_payment_intent_id is set.)
    return { ok: true, booking: await setRow(client, id, { status: 'confirmed', hold_expires_at: null }) };
  });
}

async function declineBooking(id, { reason } = {}) {
  return withLockedBooking(id, async (client, row) => {
    if (row.status !== 'pending') return fail(409, `Booking is ${row.status}`);
    // (Task 9: release the PaymentIntent.)
    return { ok: true, booking: await setRow(client, id, { status: 'declined', cancel_reason: reason ?? null, hold_expires_at: null }) };
  });
}

// by: 'guest' (hold/pending only), 'staff' (any live status), 'sweep'
// (expired guest hold/pending; the caller has already decided).
async function cancelBooking(id, { by, refund = false, reason = null } = {}) {
  return withLockedBooking(id, async (client, row) => {
    const allowed = by === 'staff' ? LIVE : ['hold', 'pending'];
    if (!allowed.includes(row.status)) return fail(409, `Booking is ${row.status}`);
    if (by === 'sweep' && !(row.source === 'guest' && row.lapsed)) return fail(409, 'Not expired');
    // (Task 9: release a held PI, or refund a captured one when refund=true.)
    return { ok: true, booking: await setRow(client, id, { status: 'cancelled', cancel_reason: reason, hold_expires_at: null }) };
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

// Publish + email after commit. Never throws. Filled in by Task 8.
function afterChange(before, after) {}

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
      if (r === 'promoted') promoted++;
    } catch (err) {
      console.error(`Marina sweep failed for ${id}:`, err.message);
    }
  }
  return { cancelled, promoted };
}

async function sweepRow(id) {
  let outcome = null;
  await withLockedBooking(id, async (client, row) => {
    if (!(row.source === 'guest' && ['hold', 'pending'].includes(row.status) && row.lapsed)) return fail(409, 'changed');
    // (Task 9: a hold whose PI is requires_capture is promoted instead.)
    await setRow(client, id, { status: 'cancelled', cancel_reason: 'expired', hold_expires_at: null });
    outcome = 'cancelled';
    return { ok: true, booking: true };
  });
  return outcome;
}

function startMarinaHoldExpiryJob() {
  const run = () => sweepOnce()
    .then(({ cancelled, promoted }) => { if (cancelled || promoted) console.log(`Marina holds: cancelled ${cancelled}, promoted ${promoted}`); })
    .catch((err) => console.error('Marina hold sweep failed:', err.message));
  run();
  setInterval(run, 60 * 1000).unref();
}

module.exports = {
  sweepOnce, startMarinaHoldExpiryJob, withLockedBooking, setRow, toPending, confirmBooking, declineBooking, cancelBooking, endBooking, afterChange, LIVE, fail };
