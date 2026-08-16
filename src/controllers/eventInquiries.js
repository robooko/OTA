const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewInquiry } = require('../lib/ably');
const { sendReply } = require('../lib/resend');

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

async function listReplies(req, res, next) {
  try {
    const { rows: inquiryRows } = await pool.query(
      'SELECT id FROM event_inquiry WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!inquiryRows.length) return res.status(404).json({ error: 'Inquiry not found' });

    const { rows } = await pool.query(
      'SELECT * FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createReply(req, res, next) {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });

    const { rows: inquiryRows } = await pool.query(
      `SELECT ei.*, p.name AS property_name FROM event_inquiry ei
       JOIN property p ON p.id = ei.property_id
       WHERE ei.id = $1 AND ei.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!inquiryRows.length) return res.status(404).json({ error: 'Inquiry not found' });
    const inquiry = inquiryRows[0];

    const emailId = await sendReply(inquiry, inquiry.property_name, body);

    const { rows } = await pool.query(
      `INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id)
       VALUES ($1, 'outbound', $2, $3) RETURNING *`,
      [inquiry.id, body, emailId]
    );

    let updatedInquiry = inquiry;
    if (inquiry.status === 'new') {
      const { rows: statusRows } = await pool.query(
        `UPDATE event_inquiry SET status = 'contacted' WHERE id = $1 RETURNING *`,
        [inquiry.id]
      );
      updatedInquiry = statusRows[0];
    }

    res.status(201).json({ message: rows[0], inquiry: updatedInquiry });
  } catch (err) { next(err); }
}

module.exports = { listInquiries, createInquiry, updateInquiry, listReplies, createReply };
