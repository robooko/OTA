const pool = require('../db');

async function listPayments(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM payment WHERE booking_id = $1 AND property_id = $2 ORDER BY paid_at DESC NULLS LAST',
      [req.params.booking_id, req.property_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createPayment(req, res, next) {
  try {
    const { booking_id, amount, method, status, stripe_payment_intent_id } = req.body;
    if (!booking_id || amount == null) {
      return res.status(400).json({ error: 'booking_id and amount are required' });
    }
    // The Stripe id a website took this on (its own account): a record, never
    // refunded by OTA (room cancels refund method 'card' rows only). One id
    // may pay several bookings, so it is not unique.
    if (stripe_payment_intent_id !== undefined && (typeof stripe_payment_intent_id !== 'string' || !stripe_payment_intent_id || stripe_payment_intent_id.length > 255)) {
      return res.status(400).json({ error: 'stripe_payment_intent_id must be a string of 1-255 characters' });
    }
    // Only on a website payment: a 'card' row with an intent id is one a room
    // cancel refunds with the property's own Stripe key.
    if (stripe_payment_intent_id !== undefined && method !== 'website') {
      return res.status(400).json({ error: "stripe_payment_intent_id is only accepted with method 'website'" });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Verify booking exists and belongs to the caller's property
    const bookingCheck = await pool.query(
      'SELECT id FROM booking WHERE id = $1 AND property_id = $2', [booking_id, req.property_id]
    );
    if (!bookingCheck.rows.length) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.property_id,
        booking_id,
        amount,
        method || null,
        status || 'pending',
        status === 'completed' ? new Date() : null,
        stripe_payment_intent_id ?? null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'Invalid booking_id' });
    next(err);
  }
}

async function updatePayment(req, res, next) {
  try {
    const { status, method } = req.body;
    const paidAt = status === 'completed' ? new Date() : undefined;

    const { rows } = await pool.query(
      `UPDATE payment SET
         status  = COALESCE($1, status),
         method  = COALESCE($2, method),
         paid_at = COALESCE($3, paid_at)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [status, method, paidAt ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listPayments, createPayment, updatePayment };
