const pool = require('../db');
const { computeEntityFolio, findEntity } = require('./entityFolio');
const { toCents, fromCents } = require('./folio');

// What a spa appointment has paid lives in payment rows (payment.spa_appointment_id);
// spa_appointment.payment_status / paid_at / payment_method are kept for their
// existing readers (the room folio, the spa feed, the bill routes) and are
// derived from the folio here after every write. See
// docs/superpowers/plans/2026-11-12-entity-charges-2-spa.md.

// paid = something was paid and nothing is owed. Returns the updated row, or
// null when the appointment isn't in this property.
async function syncSpaPaymentStatus(db, appointmentId, propertyId) {
  const folio = await computeEntityFolio('spa_appointment', appointmentId, propertyId, db);
  if (!folio) return null;
  const completed = folio.payments.filter((p) => p.status === 'completed');
  const paid = completed.length > 0 && toCents(folio.balance) <= 0;
  // folio.payments is newest first. spa_appointment.payment_method only takes
  // card or cash: a website's payment was a card, a desk 'bank_transfer' is neither.
  const newest = completed[0]?.method;
  const method = !paid ? null : newest === 'cash' ? 'cash' : ['card', 'website'].includes(newest) ? 'card' : null;
  const { rows } = await db.query(
    `UPDATE spa_appointment SET
       payment_status = CASE WHEN $3 THEN 'paid' ELSE 'unpaid' END,
       paid_at        = CASE WHEN $3 THEN COALESCE(paid_at, now()) END,
       payment_method = $4
     WHERE id = $1 AND property_id = $2 RETURNING *`,
    [appointmentId, propertyId, paid, method]
  );
  return rows[0] ?? null;
}

// Records a completed payment against an appointment, under a row lock so two
// desks can't both take the same balance. cents undefined = whatever is owed
// under the lock (nothing owed -> null). stripeRef (a PaymentIntent or Invoice
// id) already recorded on this appointment records nothing: { recorded: false }.
// null for an unknown / malformed / other-property id.
async function recordSpaPayment(appointmentId, propertyId, { method, stripeRef = null, cents = undefined }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await findEntity('spa_appointment', appointmentId, propertyId, client))) { await client.query('ROLLBACK'); return null; }
    await client.query('SELECT 1 FROM spa_appointment WHERE id = $1 FOR UPDATE', [appointmentId]);

    let recorded = false;
    const seen = stripeRef && (await client.query(
      'SELECT 1 FROM payment WHERE spa_appointment_id = $1 AND stripe_payment_intent_id = $2', [appointmentId, stripeRef]
    )).rows.length;
    if (!seen) {
      const owed = toCents((await computeEntityFolio('spa_appointment', appointmentId, propertyId, client)).balance);
      const amount = cents ?? owed;
      if (amount <= 0) { await client.query('ROLLBACK'); return null; }
      await client.query(
        `INSERT INTO payment (property_id, spa_appointment_id, amount, method, status, stripe_payment_intent_id, paid_at)
         VALUES ($1, $2, $3, $4, 'completed', $5, now())`,
        [propertyId, appointmentId, fromCents(amount), method, stripeRef]
      );
      recorded = true;
    }
    const appointment = await syncSpaPaymentStatus(client, appointmentId, propertyId);
    await client.query('COMMIT');
    return { appointment, recorded };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { syncSpaPaymentStatus, recordSpaPayment };
