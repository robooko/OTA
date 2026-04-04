const pool = require('../db');

async function listPayments(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM payment WHERE booking_id = $1 ORDER BY paid_at DESC NULLS LAST',
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createPayment(req, res, next) {
  try {
    const { booking_id, amount, method, status } = req.body;
    if (!booking_id || amount == null) {
      return res.status(400).json({ error: 'booking_id and amount are required' });
    }

    // Verify booking exists
    const bookingCheck = await pool.query('SELECT id FROM booking WHERE id = $1', [booking_id]);
    if (!bookingCheck.rows.length) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO payment (booking_id, amount, method, status, paid_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        booking_id,
        amount,
        method || null,
        status || 'pending',
        status === 'completed' ? new Date() : null,
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
       WHERE id = $4 RETURNING *`,
      [status, method, paidAt ?? null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listPayments, createPayment, updatePayment };
