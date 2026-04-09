const pool = require('../db');

async function listGuests(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM guest ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getGuest(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM guest WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createGuest(req, res, next) {
  try {
    const { first_name, last_name, email, phone } = req.body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'first_name, last_name, and email are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO guest (first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [first_name, last_name, email, phone || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
}

async function lookupGuest(req, res, next) {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const { rows } = await pool.query('SELECT * FROM guest WHERE email = $1', [email]);
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateGuest(req, res, next) {
  try {
    const { first_name, last_name, email, phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE guest SET
         first_name = COALESCE($1, first_name),
         last_name  = COALESCE($2, last_name),
         email      = COALESCE($3, email),
         phone      = COALESCE($4, phone)
       WHERE id = $5 RETURNING *`,
      [first_name, last_name, email, phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
}

async function deleteGuest(req, res, next) {
  try {
    const { rows } = await pool.query('DELETE FROM guest WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { listGuests, getGuest, lookupGuest, createGuest, updateGuest, deleteGuest };
