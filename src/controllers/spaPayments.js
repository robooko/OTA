const pool = require('../db');
const { toStripeAmount, fromStripeAmount } = require('../lib/stripeAmount');
const { computeEntityFolio } = require('../lib/entityFolio');
const { recordSpaPayment } = require('../lib/spaLedger');
const { toCents } = require('../lib/folio');

// Every flow here charges what the appointment still owes -- its folio
// balance (lib/entityFolio.js): the frozen price plus added charges minus
// payments already recorded, a deposit included -- and records what Stripe
// or the desk took as a payment row (lib/spaLedger.js), which also re-derives
// payment_status. See docs/superpowers/plans/2026-11-12-entity-charges-2-spa.md.

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

// Cents the appointment still owes.
async function owedCents(appt) {
  return toCents((await computeEntityFolio('spa_appointment', appt.id, appt.property_id)).balance);
}

function nothingOwed(res, appt) {
  return res.status(409).json({ error: appt.payment_status === 'paid' ? 'Appointment already paid' : 'Nothing to pay on this appointment' });
}

// A card payment on an appointment, keyed by its Stripe object (pi_ or in_).
function recordCard(appt, stripeRef, stripeAmount, currency) {
  return recordSpaPayment(appt.id, appt.property_id, { method: 'card', stripeRef, cents: fromStripeAmount(stripeAmount, currency) });
}

async function isRecorded(appointmentId, stripeRef) {
  const { rows } = await pool.query('SELECT 1 FROM payment WHERE spa_appointment_id = $1 AND stripe_payment_intent_id = $2', [appointmentId, stripeRef]);
  return rows.length > 0;
}

async function createAppointmentPaymentIntent(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const existing = appt.stripe_payment_intent_id ? await stripe.paymentIntents.retrieve(appt.stripe_payment_intent_id) : null;
    // Crash-window recovery: the tap landed but the app died before
    // confirm-payment. Record that charge (once -- it is keyed by the
    // intent) and charge only what is left, never the whole price again.
    if (existing?.status === 'succeeded') await recordCard(appt, existing.id, existing.amount, existing.currency);

    const owed = await owedCents(appt);
    if (owed <= 0) {
      if (existing?.status === 'succeeded') return res.json({ already_paid: true, payment_intent_id: existing.id });
      return nothingOwed(res, appt);
    }
    const stripeAmount = toStripeAmount(owed, appt.currency);

    // Idempotency: a retry (e.g. a failed tap) reuses the pending intent
    // rather than minting a second charge -- same rules as
    // createSessionPaymentIntent, minus its online-channel logic (spa
    // payments are Terminal-only). One still waiting for a card follows the
    // balance if a charge or payment changed it since.
    if (existing && ['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
      const intent = existing.amount !== stripeAmount && existing.status === 'requires_payment_method'
        ? await stripe.paymentIntents.update(existing.id, { amount: stripeAmount })
        : existing;
      return res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount: intent.amount });
    }
    // none, succeeded (recorded above) or canceled -> mint a fresh intent

    const intent = await stripe.paymentIntents.create({
      amount: stripeAmount,
      currency: appt.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { spa_appointment_id: appt.id, spa_id: req.params.spa_id },
    });
    await pool.query(`UPDATE spa_appointment SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, appt.id]);
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount: stripeAmount });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function confirmAppointmentPayment(req, res, next) {
  try {
    const { stripe_payment_intent_id, paid_with } = req.body ?? {};
    if (paid_with !== undefined) return recordCashPayment(req, res, next);
    if (!stripe_payment_intent_id) return res.status(400).json({ error: 'stripe_payment_intent_id is required' });

    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    // Prevents attaching an unrelated charge to this booking.
    if (stripe_payment_intent_id !== appt.stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this appointment' });
    }

    const stripe = require('stripe')(appt.stripe_secret_key);
    const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
    if (intent.status !== 'succeeded') return res.status(409).json({ error: 'Payment has not succeeded' });

    // Recorded at what Stripe took; payment_status follows the balance. A
    // retry finds the intent already recorded and just returns the row.
    const recorded = await recordCard(appt, intent.id, intent.amount, intent.currency);
    if (!recorded) return res.status(409).json({ error: 'Nothing to record on this payment' });
    res.json(recorded.appointment);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Cash taken at the spa desk (staff bearer or a full api key only). Nothing
// on Stripe may still be able to charge for it: an untouched terminal intent
// is cancelled and a pending bill line removed; a succeeded or mid-flight
// tap, or a sent invoice, is a 409 for staff to sort out first.
async function recordCashPayment(req, res, next) {
  try {
    const { paid_with, stripe_payment_intent_id } = req.body;
    if (paid_with !== 'cash') return res.status(400).json({ error: "paid_with must be 'cash'" });
    if (stripe_payment_intent_id) return res.status(400).json({ error: 'Send stripe_payment_intent_id or paid_with, not both' });
    const staff = req.auth_method === 'api_key' ? req.api_key?.permissions === null : ['admin', 'staff'].includes(req.user?.role);
    if (!staff) return res.status(403).json({ error: 'Only staff can record a cash payment' });

    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });
    if ((await owedCents(appt)) <= 0) return nothingOwed(res, appt);

    if (appt.stripe_secret_key) {
      const stripe = require('stripe')(appt.stripe_secret_key);
      if (appt.stripe_payment_intent_id) {
        const intent = await stripe.paymentIntents.retrieve(appt.stripe_payment_intent_id);
        if (intent.status === 'requires_payment_method') await stripe.paymentIntents.cancel(intent.id);
        // A succeeded tap already on record (a deposit) is part of the
        // balance; one not yet recorded must be confirmed first.
        else if (intent.status === 'succeeded' && await isRecorded(appt.id, intent.id)) { /* nothing to undo */ }
        else if (intent.status !== 'canceled') {
          return res.status(409).json({
            error: intent.status === 'succeeded' ? 'Appointment was already paid by card' : 'A card payment is in progress on this appointment',
            payment_intent_id: intent.id,
          });
        }
      }
      const customer = appt.contact_email ? await findCustomer(stripe, appt.contact_email) : null;
      if (customer) {
        const { pendingItem, invoice } = await findAppointmentBilling(stripe, customer.id, appt.id);
        if (invoice) return res.status(409).json({ error: 'Appointment is on a Stripe invoice -- void it in Stripe first', invoice_id: invoice.id });
        if (pendingItem) await stripe.invoiceItems.del(pendingItem.id);
      }
    }

    // Takes whatever is owed under the row lock; null = someone else just did.
    const recorded = await recordSpaPayment(appt.id, appt.property_id, { method: 'cash' });
    if (!recorded) return res.status(409).json({ error: 'Appointment already paid' });
    res.json(recorded.appointment);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Stripe matches email case-sensitively, so always store and look up lowercase.
async function findCustomer(stripe, email) {
  const { data } = await stripe.customers.list({ email: email.trim().toLowerCase(), limit: 1 });
  return data[0] ?? null;
}

// Where an appointment stands in Stripe: a pending line on the guest's open
// bill, and/or a live invoice carrying it -- either its own (invoice
// metadata) or a bill it was swept into (item metadata).
// ponytail: scans the customer's latest 100 items and invoices; a regular with
// more than that would need invoices.search or a stored stripe_invoice_id.
async function findAppointmentBilling(stripe, customerId, appointmentId) {
  const [{ data: items }, { data: invoices }] = await Promise.all([
    stripe.invoiceItems.list({ customer: customerId, limit: 100 }),
    stripe.invoices.list({ customer: customerId, limit: 100 }),
  ]);
  const mine = items.filter(i => i.metadata?.spa_appointment_id === appointmentId);
  const onInvoice = new Set(mine.map(i => i.invoice).filter(Boolean));
  return {
    pendingItem: mine.find(i => !i.invoice) ?? null,
    invoice: invoices.find(i => ['draft', 'open', 'paid'].includes(i.status)
      && (i.metadata?.spa_appointment_id === appointmentId || onInvoice.has(i.id))) ?? null,
  };
}

// Records each line of a paid invoice as a card payment on its appointment,
// keyed by the invoice id so a re-check never records it twice. Returns the
// ids now paid in full, and the ids that still owe or weren't found.
async function settlePaidInvoice(stripe, invoice, propertyId) {
  const settled = [];
  const mismatched = [];
  for await (const item of stripe.invoiceItems.list({ invoice: invoice.id, limit: 100 })) {
    // Single-appointment invoices sent before bills existed carry the id on the invoice, not the item.
    const id = item.metadata?.spa_appointment_id ?? invoice.metadata?.spa_appointment_id;
    if (!id) continue;
    const recorded = await recordSpaPayment(id, propertyId, { method: 'card', stripeRef: invoice.id, cents: fromStripeAmount(item.amount, invoice.currency) });
    (recorded?.appointment?.payment_status === 'paid' ? settled : mismatched).push(id);
  }
  return { settled, mismatched };
}

function invoiceSummary(invoice) {
  return { invoice_id: invoice.id, status: invoice.status, amount_due: invoice.amount_due, hosted_invoice_url: invoice.hosted_invoice_url };
}

// Bills the appointment by Stripe invoice (emailed, hosted pay page) instead
// of a tap. Nothing new is stored: the Stripe customer is found by email and
// the invoice by metadata, both via list endpoints (strongly consistent,
// unlike search). Call again to re-check -- a paid invoice settles the
// appointment, an open one is returned as-is.
async function createAppointmentInvoice(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });
    const owed = await owedCents(appt);
    if (owed <= 0) return nothingOwed(res, appt);
    if (!appt.contact_email) return res.status(409).json({ error: 'Appointment has no contact email to invoice' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const amount = toStripeAmount(owed, appt.currency);

    const email = appt.contact_email.trim().toLowerCase();
    const customer = await findCustomer(stripe, email) ?? await stripe.customers.create({ email, name: appt.contact_name });
    const { pendingItem, invoice: live } = await findAppointmentBilling(stripe, customer.id, appt.id);
    if (pendingItem) {
      return res.status(409).json({ error: "Appointment is on the guest's open bill -- invoice the bill instead", invoice_item_id: pendingItem.id });
    }

    if (live?.status === 'paid') {
      const { settled } = await settlePaidInvoice(stripe, live, req.property_id);
      if (!settled.includes(String(appt.id))) {
        return res.status(409).json({ error: 'Invoice was paid but a balance remains', invoice_id: live.id });
      }
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
        metadata: { spa_appointment_id: appt.id, spa_id: req.params.spa_id },
      });
    }
    // A draft left by a crash between create and send is picked up here too.
    if (invoice.status === 'draft') {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id);
      invoice = await stripe.invoices.sendInvoice(invoice.id);
    }
    res.json(invoiceSummary(invoice));
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Puts the appointment on the guest's open bill: a pending Stripe invoice
// item on their customer, swept into one invoice by invoiceGuestBill.
// Idempotent -- adding the same appointment twice returns the same line.
async function addAppointmentToBill(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (appt.status === 'cancelled') return res.status(409).json({ error: 'Appointment is cancelled' });
    const owed = await owedCents(appt);
    if (owed <= 0) return nothingOwed(res, appt);
    if (!appt.contact_email) return res.status(409).json({ error: 'Appointment has no contact email to bill' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const amount = toStripeAmount(owed, appt.currency);

    const email = appt.contact_email.trim().toLowerCase();
    const customer = await findCustomer(stripe, email) ?? await stripe.customers.create({ email, name: appt.contact_name });
    const { pendingItem, invoice } = await findAppointmentBilling(stripe, customer.id, appt.id);
    if (invoice) return res.status(409).json({ error: 'Appointment is already invoiced', invoice_id: invoice.id });

    const item = pendingItem ?? await stripe.invoiceItems.create({
      customer: customer.id,
      amount,
      currency: appt.currency.toLowerCase(),
      description: `Spa appointment ${appt.appointment_date} ${appt.start_time.slice(0, 5)}`,
      metadata: { spa_appointment_id: appt.id, spa_id: req.params.spa_id },
    });
    res.status(pendingItem ? 200 : 201).json({ invoice_item_id: item.id, amount: item.amount, email });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Invoices everything on a guest's open bill as one emailed Stripe invoice.
// Lines whose appointment was since cancelled or paid by tap are dropped, and
// repriced ones corrected, before sending. Call again to re-check: paid bills
// settle their appointments, and a bill a crash left as a draft is finalized
// and sent.
async function invoiceGuestBill(req, res, next) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ error: 'email is required' });

    const { rows: [spa] } = await pool.query(
      `SELECT p.stripe_secret_key, p.currency FROM spa s JOIN property p ON p.id = s.property_id
       WHERE s.id::text = $1 AND s.property_id = $2`,
      [req.params.spa_id, req.property_id]
    );
    if (!spa) return res.status(404).json({ error: 'Spa not found' });
    if (!spa.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    const stripe = require('stripe')(spa.stripe_secret_key);
    const customer = await findCustomer(stripe, email);
    if (!customer) return res.status(404).json({ error: 'No bill for this email' });

    // ponytail: latest 100 of each, same ceiling as findAppointmentBilling.
    const [{ data: pending }, { data: invoices }] = await Promise.all([
      stripe.invoiceItems.list({ customer: customer.id, pending: true, limit: 100 }),
      stripe.invoices.list({ customer: customer.id, limit: 100 }),
    ]);

    // spa_settled marks a paid bill already reconciled, so re-checks stay cheap.
    const settled = [];
    for (const inv of invoices.filter(i => i.status === 'paid' && i.metadata?.spa_bill && !i.metadata.spa_settled)) {
      const result = await settlePaidInvoice(stripe, inv, req.property_id);
      settled.push(...result.settled);
      if (!result.mismatched.length) await stripe.invoices.update(inv.id, { metadata: { spa_settled: 'true' } });
    }

    // Each line is repriced to what its appointment still owes; one that is
    // gone, cancelled or owes nothing comes off the bill.
    let toBill = 0;
    for (const item of pending.filter(i => i.metadata?.spa_appointment_id)) {
      const folio = await computeEntityFolio('spa_appointment', item.metadata.spa_appointment_id, req.property_id);
      const owed = folio && folio.status !== 'cancelled' ? toStripeAmount(toCents(folio.balance), spa.currency) : 0;
      if (owed <= 0) {
        await stripe.invoiceItems.del(item.id);
        continue;
      }
      if (owed !== item.amount) await stripe.invoiceItems.update(item.id, { amount: owed });
      toBill++;
    }

    let invoice = invoices.find(i => i.status === 'draft' && i.metadata?.spa_bill) ?? null;
    if (!invoice && toBill) {
      // ponytail: 'include' sweeps every pending item on the customer; fine while
      // spa is the only module leaving pending items, filter here once another does.
      invoice = await stripe.invoices.create({
        customer: customer.id,
        collection_method: 'send_invoice',
        days_until_due: 7,
        currency: spa.currency.toLowerCase(),
        pending_invoice_items_behavior: 'include',
        metadata: { spa_bill: 'true', spa_id: req.params.spa_id },
      });
    }
    if (invoice?.status === 'draft') {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id);
      invoice = await stripe.invoices.sendInvoice(invoice.id);
    }

    res.json({
      invoice: invoice ? invoiceSummary(invoice) : null,
      open_bills: invoices.filter(i => i.status === 'open' && i.metadata?.spa_bill && i.id !== invoice?.id).map(invoiceSummary),
      settled_appointment_ids: settled,
    });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// What the spa has billed: lines waiting on a guest's open bill (not sent
// yet) and invoices sent, newest first -- bills and single-appointment
// invoices alike, both tagged spa_id. Read-only; settling stays with the
// POST endpoints.
// ponytail: latest 100 invoices/pending items across the property's Stripe
// account; filter by created or paginate once a spa outgrows that.
async function listBills(req, res, next) {
  try {
    const { rows: [spa] } = await pool.query(
      `SELECT p.stripe_secret_key FROM spa s JOIN property p ON p.id = s.property_id
       WHERE s.id::text = $1 AND s.property_id = $2`,
      [req.params.spa_id, req.property_id]
    );
    if (!spa) return res.status(404).json({ error: 'Spa not found' });
    if (!spa.stripe_secret_key) return res.json({ pending: [], invoices: [] });

    const stripe = require('stripe')(spa.stripe_secret_key);
    const [{ data: items }, { data: invoices }] = await Promise.all([
      stripe.invoiceItems.list({ pending: true, limit: 100, expand: ['data.customer'] }),
      stripe.invoices.list({ limit: 100 }),
    ]);
    const mine = (o) => o.metadata?.spa_id === req.params.spa_id;
    const pending = items.filter(mine);
    // What each unsent line is for, so the dashboard can show a bill's contents.
    const { rows: appts } = await pool.query(
      `SELECT sa.id::text AS id, to_char(sa.appointment_date, 'YYYY-MM-DD') AS appointment_date,
              to_char(sa.start_time, 'HH24:MI') AS start_time, tr.name AS treatment_name, st.name AS therapist_name
       FROM spa_appointment sa
       JOIN spa_therapist st ON st.id = sa.therapist_id
       LEFT JOIN spa_treatment tr ON tr.id = sa.treatment_id
       WHERE sa.id::text = ANY($1::text[]) AND sa.property_id = $2`,
      [pending.map(i => i.metadata.spa_appointment_id), req.property_id]
    );
    const apptById = new Map(appts.map(a => [a.id, a]));
    res.json({
      // Staff "View in Stripe" links: the customer page lists unsent lines.
      stripe_dashboard_url: spa.stripe_secret_key.includes('_test_') ? 'https://dashboard.stripe.com/test' : 'https://dashboard.stripe.com',
      pending: pending.map(i => {
        const a = apptById.get(i.metadata.spa_appointment_id);
        return {
          invoice_item_id: i.id,
          appointment_id: i.metadata.spa_appointment_id,
          customer_id: i.customer?.id ?? null,
          email: i.customer?.email ?? null,
          description: i.description,
          treatment_name: a?.treatment_name ?? null,
          therapist_name: a?.therapist_name ?? null,
          appointment_date: a?.appointment_date ?? null,
          start_time: a?.start_time ?? null,
          amount: i.amount,
          currency: i.currency,
        };
      }),
      invoices: invoices.filter(i => mine(i) && i.status !== 'draft').map(i => ({
        ...invoiceSummary(i),
        number: i.number,
        email: i.customer_email,
        amount_paid: i.amount_paid,
        currency: i.currency,
        created: new Date(i.created * 1000).toISOString(),
        bill: !!i.metadata.spa_bill,
      })),
    });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Undoes addAppointmentToBill: takes the appointment's unsent line off its
// guest's bill. 404 when it isn't on one.
async function removeAppointmentFromBill(req, res, next) {
  try {
    const appt = await loadAppointmentForPayment(req.params.id, req.params.spa_id, req.property_id);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (!appt.contact_email) return res.status(404).json({ error: 'Appointment is not on a bill' });

    const stripe = require('stripe')(appt.stripe_secret_key);
    const customer = await findCustomer(stripe, appt.contact_email);
    const { pendingItem } = customer ? await findAppointmentBilling(stripe, customer.id, appt.id) : {};
    if (!pendingItem) return res.status(404).json({ error: 'Appointment is not on a bill' });

    await stripe.invoiceItems.del(pendingItem.id);
    res.json({ removed: pendingItem.id, email: customer.email });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Takes one unsent line off a guest's bill (deletes the pending invoice item).
async function removeBillLine(req, res, next) {
  try {
    const { rows: [spa] } = await pool.query(
      `SELECT p.stripe_secret_key FROM spa s JOIN property p ON p.id = s.property_id
       WHERE s.id::text = $1 AND s.property_id = $2`,
      [req.params.spa_id, req.property_id]
    );
    if (!spa) return res.status(404).json({ error: 'Spa not found' });
    if (!spa.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    const stripe = require('stripe')(spa.stripe_secret_key);
    const item = await stripe.invoiceItems.retrieve(req.params.item_id).catch(() => null);
    if (!item || item.metadata?.spa_id !== req.params.spa_id) return res.status(404).json({ error: 'Bill line not found' });
    if (item.invoice) return res.status(409).json({ error: 'Bill line is already invoiced' });

    await stripe.invoiceItems.del(item.id);
    res.json({ removed: item.id, appointment_id: item.metadata.spa_appointment_id ?? null });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { loadAppointmentForPayment, treatmentPriceCents, settlePaidInvoice, createAppointmentPaymentIntent, confirmAppointmentPayment, createAppointmentInvoice, addAppointmentToBill, invoiceGuestBill, listBills, removeBillLine, removeAppointmentFromBill };
