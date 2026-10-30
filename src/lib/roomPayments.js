// Card payment for room bookings on a rate plan (Saver/Flex): the card step,
// confirmation, staff settling by hand, and the shared availability helpers.
// See docs/superpowers/specs/2026-10-30-room-rate-plans-design.md §6-§9.
//
// The booking's PaymentIntent lives on booking.stripe_payment_intent_id, not
// in a pending payment row (folio's findPendingCardPayment would reuse it);
// a payment row is written only once money is actually taken.
const pool = require('../db');
const marinaStripe = require('./marinaStripe');
const { computeFolio, toCents, fromCents } = require('./folio');
const { cancelDeadline, effectiveMode, chargeAmountCents } = require('./ratePlans');
const { publishBookingStatusChanged } = require('./ably');
const roomEmails = require('./roomBookingEmails');

// Through the module object, so the check script can swap in a fake.
const stripeOf = (secretKey) => marinaStripe.stripeFor(secretKey);

const PAID = ['succeeded', 'requires_capture'];
const OPEN = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

// Same JOINs as getBooking, minus the extras query -- used everywhere a
// booking gets published to a live feed. Consumers (hotal-ui's
// <live-room-bookings-feed>) upsert-by-replace on every event, so a payload
// missing these fields blanks out the guest name / room line rather than
// leaving it unchanged.
async function fetchJoinedBooking(id) {
  const { rows } = await pool.query(
    `SELECT b.*,
            g.first_name, g.last_name, g.email, g.phone,
            r.room_number, r.floor, r.status AS room_status,
            rt.id AS room_type_id, rt.name AS room_type_name, rt.base_rate
     FROM booking b
     JOIN guest     g  ON g.id  = b.guest_id
     JOIN room      r  ON r.id  = b.room_id
     JOIN room_type rt ON rt.id = r.room_type_id
     WHERE b.id = $1`,
    [id]
  );
  return rows[0];
}

async function releaseAvailability(client, booking) {
  await client.query(
    `UPDATE room_availability SET is_available = true
     WHERE room_id = $1 AND date >= $2 AND date < $3`,
    [booking.room_id, booking.check_in, booking.check_out]
  );
}

// After COMMIT: older Postgres rejects CONCURRENTLY inside a transaction
// block, and a failed refresh must not fail a committed change -- the
// exclusion constraint guards double-booking, not the view.
async function refreshAvailabilityView() {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
  } catch (e) {
    console.error('MV refresh failed after commit:', e.message);
  }
}

// The booking row (locked) with its property's payment settings. propertyId
// null = any property (background jobs).
async function lockBooking(client, bookingId, propertyId) {
  const { rows } = await client.query(
    `SELECT b.*, p.stripe_secret_key, p.stripe_publishable_key, p.currency, p.timezone
     FROM booking b JOIN property p ON p.id = b.property_id
     WHERE b.id = $1 AND ($2::uuid IS NULL OR b.property_id = $2)
     FOR UPDATE OF b`,
    [bookingId, propertyId]
  );
  return rows[0] ?? null;
}

function deadlineOf(b) {
  const t = b.rate_plan_terms;
  return t?.refundable ? cancelDeadline(b.check_in, b.timezone, t.cancel_cutoff_hours) : null;
}

// Inside the caller's transaction, booking row locked. pi null = nothing to
// charge. A hold (requires_capture) writes no payment row until captured.
async function confirmPaidLocked(client, b, pi) {
  await client.query(`UPDATE booking SET status = 'confirmed', payment_due_at = NULL WHERE id = $1`, [b.id]);
  if (pi?.status === 'succeeded') {
    await client.query(
      `INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at, stripe_payment_intent_id)
       VALUES ($1, $2, $3, 'card', 'completed', now(), $4)`,
      [b.property_id, b.id, fromCents(pi.amount_received ?? pi.amount), pi.id]
    );
  }
}

// After COMMIT of a change to confirmed: live feed + confirmation email.
async function afterConfirmed(bookingId, propertyId) {
  const joined = await fetchJoinedBooking(bookingId);
  publishBookingStatusChanged(propertyId, joined).catch((err) => console.error('Ably publish failed:', err.message));
  roomEmails.sendConfirmation(bookingId);
  return joined;
}

// Runs fn(client) in a transaction; fn returns { status, body, after? }.
// `after` runs once committed (side effects that must not precede COMMIT).
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query(out.status < 300 ? 'COMMIT' : 'ROLLBACK');
    if (out.status < 300 && out.after) out.body = (await out.after()) ?? out.body;
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const stripeFailure = (error, err) => ({ status: 502, body: { error, details: err.message } });

// The card step: the amount is worked out now, from the bill (room + extras).
async function paymentIntentFor(bookingId, propertyId) {
  return inTransaction(async (client) => {
    const b = await lockBooking(client, bookingId, propertyId);
    if (!b) return { status: 404, body: { error: 'Booking not found' } };
    if (b.status !== 'pending_payment') return { status: 409, body: { error: 'Booking is not awaiting payment', details: b.status } };
    if (!b.stripe_secret_key || !b.stripe_publishable_key) return { status: 409, body: { error: 'Online payment is not set up for this property' } };

    const stripe = stripeOf(b.stripe_secret_key);
    let pi = null;
    if (b.stripe_payment_intent_id) {
      try {
        pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
      } catch (err) {
        return stripeFailure('Card payment could not be set up; please try again', err);
      }
      // Already paid (a retry after confirm-payment was lost): confirm, don't
      // hand the guest a card form for a payment that went through.
      if (PAID.includes(pi.status)) {
        await confirmPaidLocked(client, b, pi);
        return { status: 200, after: () => afterConfirmed(b.id, b.property_id) };
      }
    }

    const folio = await computeFolio(b.id, b.property_id);
    const balanceCents = toCents(folio.balance);
    if (balanceCents <= 0) {
      // Settled another way (desk payment, comp): close the guest's card form
      // so it can't take a second payment.
      if (pi && OPEN.includes(pi.status)) {
        try {
          await stripe.paymentIntents.cancel(pi.id);
        } catch (err) {
          return stripeFailure('Payment provider error', err);
        }
      }
      await confirmPaidLocked(client, b, null);
      return { status: 200, after: () => afterConfirmed(b.id, b.property_id) };
    }
    const terms = b.rate_plan_terms;
    const mode = terms.mode_used ?? effectiveMode(terms, deadlineOf(b), new Date());
    const amount = chargeAmountCents(mode, terms, toCents(folio.charges_total), balanceCents);

    try {
      if (pi) {
        if (pi.amount !== amount && OPEN.includes(pi.status)) pi = await stripe.paymentIntents.update(pi.id, { amount });
      } else {
        pi = await stripe.paymentIntents.create({
          amount,
          currency: b.currency.toLowerCase(),
          capture_method: mode === 'hold' ? 'manual' : 'automatic',
          payment_method_types: ['card'],
          metadata: { property_id: b.property_id, booking_id: b.id },
        }, { idempotencyKey: `room-booking-${b.id}` });
      }
    } catch (err) {
      return stripeFailure('Card payment could not be set up; please try again', err);
    }
    await client.query(
      `UPDATE booking SET stripe_payment_intent_id = $1,
              rate_plan_terms = jsonb_set(rate_plan_terms, '{mode_used}', to_jsonb($2::text))
       WHERE id = $3`,
      [pi.id, mode, b.id]
    );
    return {
      status: 200,
      body: { client_secret: pi.client_secret, publishable_key: b.stripe_publishable_key, amount: fromCents(pi.amount), mode },
    };
  });
}

// The site calls this once Stripe has confirmed the card. Idempotent.
async function confirmPaid(bookingId, propertyId) {
  return inTransaction(async (client) => {
    const b = await lockBooking(client, bookingId, propertyId);
    if (!b) return { status: 404, body: { error: 'Booking not found' } };
    if (b.status === 'confirmed') return { status: 200, after: () => fetchJoinedBooking(b.id) };
    if (b.status !== 'pending_payment') return { status: 409, body: { error: `Booking is ${b.status}` } };
    if (!b.stripe_payment_intent_id) return { status: 409, body: { error: 'No payment started' } };
    let pi;
    try {
      pi = await stripeOf(b.stripe_secret_key).paymentIntents.retrieve(b.stripe_payment_intent_id);
    } catch (err) {
      return stripeFailure('Payment provider error', err);
    }
    if (!PAID.includes(pi.status)) return { status: 409, body: { error: 'Payment not completed', details: pi.status } };
    await confirmPaidLocked(client, b, pi);
    return { status: 200, after: () => afterConfirmed(b.id, b.property_id) };
  });
}

// Staff confirm an unpaid booking by hand (paid another way, or not chased):
// the open card payment is cancelled and the booking becomes pay-at-hotel.
// If the guest's card went through meanwhile, that payment counts instead.
async function settleByHand(bookingId, propertyId) {
  return inTransaction(async (client) => {
    const b = await lockBooking(client, bookingId, propertyId);
    if (!b) return { status: 404, body: { error: 'Booking not found' } };
    if (b.status !== 'pending_payment') return { status: 409, body: { error: `Booking is ${b.status}` } };
    if (b.stripe_payment_intent_id) {
      try {
        const stripe = stripeOf(b.stripe_secret_key);
        const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
        if (PAID.includes(pi.status)) {
          await confirmPaidLocked(client, b, pi);
          return { status: 200, after: () => afterConfirmed(b.id, b.property_id) };
        }
        if (pi.status !== 'canceled') await stripe.paymentIntents.cancel(pi.id);
      } catch (err) {
        return stripeFailure('Payment provider error; booking not confirmed', err);
      }
    }
    await client.query(
      `UPDATE booking SET status = 'confirmed', payment_due_at = NULL,
              rate_plan_terms = jsonb_set(rate_plan_terms, '{pay_at_hotel}', 'true')
       WHERE id = $1`,
      [b.id]
    );
    return { status: 200, after: () => afterConfirmed(b.id, b.property_id) };
  });
}

// Stripe side of cancelling a plan booking, before its status changes
// (rate plans spec §9). Always: an open or uncaptured card payment is
// released, and a card that went through on a never-confirmed booking is
// refunded. refund: also refund every completed card payment. Throws on any
// Stripe failure so the caller can leave the booking untouched.
async function stripeForCancel(b, { refund }) {
  const { rows: payments } = await pool.query(
    `SELECT id, stripe_payment_intent_id FROM payment
     WHERE booking_id = $1 AND status = 'completed' AND method = 'card' AND stripe_payment_intent_id IS NOT NULL`,
    [b.id]
  );
  const needsStripe = b.stripe_payment_intent_id || (refund && payments.length);
  if (!needsStripe) return { refundedPaymentIds: [] };
  if (!b.stripe_secret_key) throw new Error('No Stripe key configured for this property');
  const stripe = stripeOf(b.stripe_secret_key);

  const recorded = new Set(payments.map((p) => p.stripe_payment_intent_id));
  if (b.stripe_payment_intent_id && !recorded.has(b.stripe_payment_intent_id)) {
    const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
    if (OPEN.includes(pi.status) || pi.status === 'requires_capture') {
      await stripe.paymentIntents.cancel(pi.id);
    } else if (pi.status === 'succeeded' && b.status === 'pending_payment') {
      await stripe.refunds.create({ payment_intent: pi.id }, { idempotencyKey: `room-refund-${pi.id}` });
    }
  }
  const refundedPaymentIds = [];
  if (refund) {
    for (const p of payments) {
      await stripe.refunds.create({ payment_intent: p.stripe_payment_intent_id }, { idempotencyKey: `room-refund-${p.id}` });
      refundedPaymentIds.push(p.id);
    }
  }
  return { refundedPaymentIds };
}

// Unpaid bookings past their pay-by time expire and release the room -- unless
// the card went through and confirm-payment never arrived (tab closed), in
// which case the booking is confirmed instead. Each row under its own lock.
async function expireOnce() {
  const { rows } = await pool.query(
    `SELECT id FROM booking WHERE status = 'pending_payment' AND payment_due_at < now()
     ORDER BY payment_due_at LIMIT 200`
  );
  let expired = 0;
  let confirmed = 0;
  for (const { id } of rows) {
    try {
      const r = await inTransaction(async (client) => {
        const b = await lockBooking(client, id, null);
        if (!b || b.status !== 'pending_payment' || new Date(b.payment_due_at) > new Date()) return { status: 409 };
        if (b.stripe_payment_intent_id && b.stripe_secret_key) {
          const stripe = stripeOf(b.stripe_secret_key);
          const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
          if (PAID.includes(pi.status)) {
            await confirmPaidLocked(client, b, pi);
            return { status: 200, outcome: 'confirmed', after: () => afterConfirmed(b.id, b.property_id) };
          }
          if (pi.status !== 'canceled') await stripe.paymentIntents.cancel(pi.id);
        }
        // Paid another way (desk terminal via the folio, cash recorded by
        // staff) without a confirm: settle as pay-at-hotel, never expire.
        const { rows: [paid] } = await client.query(
          `SELECT count(*)::int AS n FROM payment WHERE booking_id = $1 AND status = 'completed'`, [b.id]
        );
        if (paid.n > 0) {
          await client.query(
            `UPDATE booking SET status = 'confirmed', payment_due_at = NULL,
                    rate_plan_terms = jsonb_set(rate_plan_terms, '{pay_at_hotel}', 'true')
             WHERE id = $1`,
            [b.id]
          );
          return { status: 200, outcome: 'confirmed', after: () => afterConfirmed(b.id, b.property_id) };
        }
        await client.query(`UPDATE booking SET status = 'expired', payment_due_at = NULL WHERE id = $1`, [b.id]);
        await releaseAvailability(client, b);
        return {
          status: 200,
          outcome: 'expired',
          after: async () => {
            const joined = await fetchJoinedBooking(b.id);
            publishBookingStatusChanged(b.property_id, joined).catch((err) => console.error('Ably publish failed:', err.message));
            return joined;
          },
        };
      });
      if (r.outcome === 'expired') expired++;
      if (r.outcome === 'confirmed') confirmed++;
    } catch (err) {
      console.error(`Room booking expiry failed for ${id}:`, err.message);
    }
  }
  if (expired) await refreshAvailabilityView();
  return { expired, confirmed };
}

// Card holds are captured once the free-cancellation deadline passes. A
// failed capture is marked (capture_failed) and left to staff: the amount
// stays on the folio and the check-out gate catches it. No retry loop.
async function captureHoldsOnce() {
  const { rows } = await pool.query(
    `SELECT b.id, b.check_in, b.rate_plan_terms, p.timezone
     FROM booking b JOIN property p ON p.id = b.property_id
     WHERE b.status IN ('confirmed', 'checked_in')
       AND b.rate_plan_terms->>'mode_used' = 'hold'
       AND b.stripe_payment_intent_id IS NOT NULL
       AND NOT (b.rate_plan_terms ? 'capture_failed')
       AND NOT EXISTS (SELECT 1 FROM payment pm
                       WHERE pm.booking_id = b.id AND pm.stripe_payment_intent_id = b.stripe_payment_intent_id)
       AND (b.check_in::timestamp AT TIME ZONE p.timezone)
           - make_interval(hours => (b.rate_plan_terms->>'cancel_cutoff_hours')::int) <= now()
     ORDER BY b.check_in
     LIMIT 200`
  );
  let captured = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const r = await inTransaction(async (client) => {
        const b = await lockBooking(client, row.id, null);
        // Re-check under the lock: an overlapping sweep (two instances during
        // a deploy, or a slow run) may have captured or marked it already.
        if (!b || !['confirmed', 'checked_in'].includes(b.status) || b.rate_plan_terms?.mode_used !== 'hold'
            || b.rate_plan_terms?.capture_failed || !b.stripe_payment_intent_id) return { status: 409 };
        const { rows: recorded } = await client.query(
          'SELECT 1 FROM payment WHERE booking_id = $1 AND stripe_payment_intent_id = $2', [b.id, b.stripe_payment_intent_id]
        );
        if (recorded.length) return { status: 409 };
        const markFailed = async (reason) => {
          console.error(`Room hold capture failed for ${b.id}: ${reason}`);
          await client.query(
            `UPDATE booking SET rate_plan_terms = jsonb_set(rate_plan_terms, '{capture_failed}', to_jsonb(now())) WHERE id = $1`, [b.id]
          );
          return { status: 200, outcome: 'failed' };
        };
        if (!b.stripe_secret_key) return markFailed('no Stripe key configured');
        const stripe = stripeOf(b.stripe_secret_key);
        let pi;
        try {
          pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
          if (pi.status === 'requires_capture') pi = await stripe.paymentIntents.capture(pi.id);
        } catch (err) {
          return markFailed(err.message);
        }
        if (pi.status !== 'succeeded') return markFailed(`payment is ${pi.status}`);
        await client.query(
          `INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at, stripe_payment_intent_id)
           VALUES ($1, $2, $3, 'card', 'completed', now(), $4)`,
          [b.property_id, b.id, fromCents(pi.amount_received ?? pi.amount), pi.id]
        );
        return { status: 200, outcome: 'captured' };
      });
      if (r.outcome === 'captured') captured++;
      if (r.outcome === 'failed') failed++;
    } catch (err) {
      console.error(`Room hold capture failed for ${row.id}:`, err.message);
    }
  }
  return { captured, failed };
}

function startRoomPaymentJobs() {
  const run = async () => {
    try {
      const e = await expireOnce();
      if (e.expired || e.confirmed) console.log(`Room bookings: expired ${e.expired}, confirmed ${e.confirmed}`);
      const c = await captureHoldsOnce();
      if (c.captured || c.failed) console.log(`Room holds: captured ${c.captured}, failed ${c.failed}`);
    } catch (err) {
      console.error('Room payment sweep failed:', err.message);
    }
  };
  run();
  setInterval(run, 60 * 1000).unref();
}

module.exports = {
  fetchJoinedBooking, releaseAvailability, refreshAvailabilityView, lockBooking, deadlineOf,
  confirmPaidLocked, afterConfirmed, paymentIntentFor, confirmPaid, settleByHand, stripeForCancel,
  expireOnce, captureHoldsOnce, startRoomPaymentJobs,
};
