const pool = require('../db');

// Loads an appointment with everything the payment endpoints need, scoped
// the way every spa route is: through the therapist's spa and the
// requester's property. Cross-property ids read as not-found.
async function loadAppointmentForPayment(appointmentId, spaId, propertyId) {
  const { rows } = await pool.query(
    `SELECT sa.*, tr.price, p.stripe_secret_key, p.currency
     FROM spa_appointment sa
     JOIN spa_therapist st ON st.id = sa.therapist_id
     JOIN spa_treatment tr ON tr.id = sa.treatment_id
     JOIN property p ON p.id = sa.property_id
     WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
    [appointmentId, spaId, propertyId]
  );
  return rows[0] ?? null;
}

// Same NUMERIC(10,2) -> minor-units conversion as sessionTotalCents.
function treatmentPriceCents(price) {
  return Math.round(parseFloat(price) * 100);
}

async function createAppointmentPaymentIntent(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });
    if (appt.payment_status === 'paid') return res.status(409).json({ error: 'Appointment already paid' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const amount = treatmentPriceCents(appt.price);
    if (amount <= 0) return res.status(409).json({ error: 'Nothing to pay on this appointment' });

    // Idempotency: a retry (e.g. a failed tap) reuses the pending intent
    // rather than minting a second charge -- same rules as
    // createSessionPaymentIntent, minus its online-channel logic (spa
    // payments are Terminal-only).
    if (appt.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(appt.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount: existing.amount });
      }
      // Crash-window recovery: the tap landed but the app died before
      // confirm-payment. Creating a fresh intent would charge twice --
      // settle with the charge that already exists instead, applying the
      // same amount check confirm-payment would.
      if (existing.status === 'succeeded') {
        if (existing.amount !== amount) {
          return res.status(409).json({ error: 'A payment already succeeded for a different amount', payment_intent_id: existing.id });
        }
        await pool.query(`UPDATE spa_appointment SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [appt.id]);
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled -> fall through and mint a fresh intent
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: appt.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { spa_appointment_id: appt.id, spa_id: req.params.spa_id },
    });
    await pool.query(`UPDATE spa_appointment SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, appt.id]);
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function confirmAppointmentPayment(req, res, next) {
  try {
    const { stripe_payment_intent_id } = req.body ?? {};
    if (!stripe_payment_intent_id) return res.status(400).json({ error: 'stripe_payment_intent_id is required' });

    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.payment_status === 'paid') return res.status(409).json({ error: 'Appointment already paid' });
    // Prevents attaching an unrelated (e.g. cheaper) charge to this booking.
    if (stripe_payment_intent_id !== appt.stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this appointment' });
    }

    const stripe = require('stripe')(appt.stripe_secret_key);
    const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (intent.status !== 'succeeded') return res.status(409).json({ error: 'Payment has not succeeded' });
    if (intent.amount !== treatmentPriceCents(appt.price)) {
      return res.status(409).json({ error: 'Payment amount does not match the treatment price' });
    }

    const { rows } = await pool.query(
      `UPDATE spa_appointment SET payment_status = 'paid', paid_at = now() WHERE id = $1 RETURNING *`,
      [appt.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { loadAppointmentForPayment, treatmentPriceCents, createAppointmentPaymentIntent, confirmAppointmentPayment };
