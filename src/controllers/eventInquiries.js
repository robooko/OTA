const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewInquiry } = require('../lib/ably');

async function listInquiries(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM event_inquiry WHERE property_id = $1 ORDER BY created_at DESC',
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createInquiry(req, res, next) {
  try {
    const { name, email, phone, event_date, guests, event_type, format, message } = req.body;
    if (!name || !email || !event_date) {
      return res.status(400).json({ error: 'name, email, and event_date are required' });
    }
    if (!isValidDate(event_date)) return res.status(400).json({ error: 'Invalid date format' });

    const { rows } = await pool.query(
      `INSERT INTO event_inquiry (property_id, name, email, phone, event_date, guests, event_type, format, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, name, email, phone || null, event_date, guests || null, event_type || null, format || null, message || null]
    );

    publishNewInquiry(req.property_id, rows[0]).catch((err) => console.error('Ably publish failed:', err.message));

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateInquiry(req, res, next) {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      `UPDATE event_inquiry SET status = COALESCE($1, status) WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Inquiry not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { listInquiries, createInquiry, updateInquiry };
