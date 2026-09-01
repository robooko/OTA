const pool = require('../db');
const { computeFolio } = require('../lib/folio');

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

module.exports = { getFolio, addAdjustment, removeAdjustment };
