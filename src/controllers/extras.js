const pool = require('../db');

// ── Extras catalogue ──────────────────────────────────────────────────────────

async function listExtras(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM extra WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createExtra(req, res, next) {
  try {
    const { name, description, price } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO extra (name, description, price) VALUES ($1, $2, $3) RETURNING *`,
      [name, description ?? null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateExtra(req, res, next) {
  try {
    const { name, description, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE extra SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         price       = COALESCE($3, price),
         status      = COALESCE($4, status)
       WHERE id = $5 RETURNING *`,
      [name, description, price, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Extra not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Booking extras ────────────────────────────────────────────────────────────

async function listBookingExtras(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT be.*, e.name, e.description
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function addBookingExtra(req, res, next) {
  try {
    const { booking_id } = req.params;
    const { extra_id, quantity } = req.body;
    if (!extra_id) return res.status(400).json({ error: 'extra_id is required' });

    const extraRes = await pool.query("SELECT * FROM extra WHERE id = $1 AND status = 'active'", [extra_id]);
    if (!extraRes.rows.length) return res.status(404).json({ error: 'Extra not found' });

    const bookingRes = await pool.query('SELECT id FROM booking WHERE id = $1', [booking_id]);
    if (!bookingRes.rows.length) return res.status(404).json({ error: 'Booking not found' });

    const unit_price = extraRes.rows[0].price;
    const qty = quantity || 1;

    const { rows } = await pool.query(
      `INSERT INTO booking_extra (booking_id, extra_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [booking_id, extra_id, qty, unit_price]
    );
    res.status(201).json({ ...rows[0], name: extraRes.rows[0].name, total: (unit_price * qty).toFixed(2) });
  } catch (err) { next(err); }
}

async function removeBookingExtra(req, res, next) {
  try {
    const { rows } = await pool.query(
      'DELETE FROM booking_extra WHERE id = $1 AND booking_id = $2 RETURNING id',
      [req.params.id, req.params.booking_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Extra not found on this booking' });
    res.status(204).end();
  } catch (err) { next(err); }
}

module.exports = {
  listExtras, createExtra, updateExtra,
  listBookingExtras, addBookingExtra, removeBookingExtra,
};
