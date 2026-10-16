const pool = require('../db');

// Loads an appointment with everything the payment endpoints need, scoped
// the way every spa route is: through the therapist's spa and the
// requester's property. Cross-property ids read as not-found.
async function loadAppointmentForPayment(appointmentId, spaId, propertyId) {
  const { rows } = await pool.query(
    // sa.price is the price frozen at booking (regulars' rate or standard).
    `SELECT sa.*, p.stripe_secret_key, p.currency
     FROM spa_appointment sa
     JOIN spa_therapist st ON st.id = sa.therapist_id
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

// Bills the appointment by Stripe invoice (emailed, hosted pay page) instead
// of a tap. Nothing new is stored: the Stripe customer is found by email and
// the invoice by its spa_appointment_id metadata, both via list endpoints
// (strongly consistent, unlike search). Call again to re-check -- a paid
// invoice settles the appointment, an open one is returned as-is.
async function createAppointmentInvoice(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });
    if (appt.payment_status === 'paid') return res.status(409).json({ error: 'Appointment already paid' });
    if (!appt.contact_email) return res.status(409).json({ error: 'Appointment has no contact email to invoice' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const amount = treatmentPriceCents(appt.price);
    if (amount <= 0) return res.status(409).json({ error: 'Nothing to pay on this appointment' });

    // Stripe matches email case-sensitively, so always store and look up lowercase.
    const email = appt.contact_email.trim().toLowerCase();
    const { data: customers } = await stripe.customers.list({ email, limit: 1 });
    const customer = customers[0] ?? await stripe.customers.create({ email, name: appt.contact_name });

    // ponytail: scans the customer's latest 100 invoices; a regular with more
    // than that would need invoices.search or a stored stripe_invoice_id.
    const { data: invoices } = await stripe.invoices.list({ customer: customer.id, limit: 100 });
    const live = invoices.find(i => i.metadata?.spa_appointment_id === appt.id && ['draft', 'open', 'paid'].includes(i.status));

    if (live?.status === 'paid') {
      if (live.amount_paid !== amount) {
        return res.status(409).json({ error: 'Invoice was paid for a different amount', invoice_id: live.id });
      }
      await pool.query(`UPDATE spa_appointment SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [appt.id]);
      return res.json({ already_paid: true, invoice_id: live.id });
    }

    let invoice = live;
    if (!invoice) {
      invoice = await stripe.invoices.create({
        customer: customer.id,
        collection_method: 'send_invoice',
        days_until_due: 7,
        currency: appt.currency.toLowerCase(),
        metadata: { spa_appointment_id: appt.id, spa_id: req.params.spa_id },
      });
      await stripe.invoiceItems.create({
        customer: customer.id,
        invoice: invoice.id,
        amount,
        currency: appt.currency.toLowerCase(),
        description: `Spa appointment ${appt.appointment_date} ${appt.start_time.slice(0, 5)}`,
      });
    }
    // A draft left by a crash between create and send is picked up here too.
    if (invoice.status === 'draft') {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id);
      invoice = await stripe.invoices.sendInvoice(invoice.id);
    }
    res.json({ invoice_id: invoice.id, status: invoice.status, amount_due: invoice.amount_due, hosted_invoice_url: invoice.hosted_invoice_url });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { loadAppointmentForPayment, treatmentPriceCents, createAppointmentPaymentIntent, confirmAppointmentPayment, createAppointmentInvoice };
