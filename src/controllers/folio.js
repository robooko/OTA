const pool = require('../db');
const { computeFolio, toCents, fromCents } = require('../lib/folio');

async function getFolio(req, res, next) {
  try {
    const folio = await computeFolio(req.params.id, req.property_id);
    if (!folio) return res.status(404).json({ error: 'Booking not found' });
    res.json(folio);
  } catch (err) {
    next(err);
  }
}

async function addAdjustment(req, res, next) {
  try {
    const { description, amount } = req.body ?? {};
    const amt = Number(amount);
    if (!description || typeof description !== 'string' || amount == null || Number.isNaN(amt) || amt === 0) {
      return res.status(400).json({ error: 'description and a non-zero amount are required' });
    }
    if (description.length > 200) {
      return res.status(400).json({ error: 'description must be 200 characters or fewer' });
    }

    const bookingRes = await pool.query(
      'SELECT id FROM booking WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!bookingRes.rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO folio_adjustment (property_id, booking_id, description, amount)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.property_id, req.params.id, description, amt.toFixed(2)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function removeAdjustment(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM folio_adjustment
       WHERE id = $1 AND booking_id = $2 AND property_id = $3
       RETURNING id`,
      [req.params.adjustment_id, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Adjustment not found on this booking' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// Booking + the property's Stripe key/currency, property-scoped the way
// loadAppointmentForPayment (spaPayments.js) is. Cross-property -> null.
async function loadBookingForPayment(bookingId, propertyId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, p.stripe_secret_key, p.currency
     FROM booking b
     JOIN property p ON p.id = b.property_id
     WHERE b.id = $1 AND b.property_id = $2`,
    [bookingId, propertyId]
  );
  return rows[0] ?? null;
}

// The booking's single in-flight card payment, if any. At most one exists
// by construction: this flow only ever inserts when none is found, and
// otherwise reuses/overwrites the row it found.
async function findPendingCardPayment(bookingId) {
  const { rows } = await pool.query(
    `SELECT * FROM payment
     WHERE booking_id = $1 AND status = 'pending' AND method = 'card'
       AND stripe_payment_intent_id IS NOT NULL`,
    [bookingId]
  );
  return rows[0] ?? null;
}

async function createFolioPaymentIntent(req, res, next) {
  try {
    const booking = await loadBookingForPayment(req.params.id, req.property_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: 'Booking is cancelled' });

    const folio = await computeFolio(req.params.id, req.property_id);
    const balanceCents = toCents(folio.balance);
    const requested = req.body?.amount;
    const amount = requested != null ? toCents(requested) : balanceCents;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(409).json({ error: 'Nothing to pay on this booking' });
    if (amount > balanceCents) return res.status(409).json({ error: 'Amount exceeds the outstanding balance', balance: folio.balance });

    const stripe = require('stripe')(booking.stripe_secret_key);

    // Idempotency: a retry (e.g. a failed tap) reuses the pending row's
    // intent rather than minting a second charge -- same rules as
    // createAppointmentPaymentIntent (spaPayments.js), with the pending
    // state held in the payment ledger row instead of a status column.
    const pending = await findPendingCardPayment(booking.id);
    if (pending) {
      const existing = await stripe.paymentIntents.retrieve(pending.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        if (existing.amount !== amount) {
          await stripe.paymentIntents.update(existing.id, { amount });
          await pool.query('UPDATE payment SET amount = $1 WHERE id = $2', [fromCents(amount), pending.id]);
        }
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount });
      }
      // Crash-window recovery: the tap landed but the app died before
      // confirm-payment. Settle with the charge that already exists,
      // recording the amount Stripe actually captured.
      if (existing.status === 'succeeded') {
        await pool.query(
          `UPDATE payment SET status = 'completed', paid_at = now(), amount = $1 WHERE id = $2`,
          [fromCents(existing.amount), pending.id]
        );
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled -> mint a fresh intent onto the same pending row
      const intent = await stripe.paymentIntents.create({
        amount,
        currency: booking.currency.toLowerCase(),
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata: { booking_id: booking.id },
      });
      await pool.query(
        'UPDATE payment SET stripe_payment_intent_id = $1, amount = $2 WHERE id = $3',
        [intent.id, fromCents(amount), pending.id]
      );
      return res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: booking.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { booking_id: booking.id },
    });
    await pool.query(
      `INSERT INTO payment (property_id, booking_id, amount, method, status, stripe_payment_intent_id)
       VALUES ($1, $2, $3, 'card', 'pending', $4)`,
      [req.property_id, booking.id, fromCents(amount), intent.id]
    );
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function confirmFolioPayment(req, res, next) {
  try {
    const { stripe_payment_intent_id } = req.body ?? {};
    if (!stripe_payment_intent_id) return res.status(400).json({ error: 'stripe_payment_intent_id is required' });

    const booking = await loadBookingForPayment(req.params.id, req.property_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    // Prevents attaching an unrelated (e.g. cheaper) charge to this booking.
    const pending = await findPendingCardPayment(booking.id);
    if (!pending || pending.stripe_payment_intent_id !== stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this booking' });
    }

    const stripe = require('stripe')(booking.stripe_secret_key);
    const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (intent.status !== 'succeeded') return res.status(409).json({ error: 'Payment has not succeeded' });
    if (intent.amount !== toCents(pending.amount)) {
      return res.status(409).json({ error: 'Payment amount does not match the pending payment' });
    }

    const { rows } = await pool.query(
      `UPDATE payment SET status = 'completed', paid_at = now() WHERE id = $1 RETURNING *`,
      [pending.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { getFolio, addAdjustment, removeAdjustment, createFolioPaymentIntent, confirmFolioPayment };
