const pool = require('../db');

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category } = req.query;
    let query = `SELECT * FROM proshop_item WHERE status = 'active'`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO proshop_item (name, description, category, price) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, category || null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { name, description, category, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE proshop_item SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         category    = COALESCE($3, category),
         price       = COALESCE($4, price),
         status      = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [name, description, category, price, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Booking items ─────────────────────────────────────────────────────────────

async function listBookingItems(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT gbi.*, p.category
       FROM golf_booking_item gbi
       LEFT JOIN proshop_item p ON p.id = gbi.item_id
       WHERE gbi.booking_id = $1
       ORDER BY p.category, gbi.item_name`,
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function addBookingItem(req, res, next) {
  try {
    const { booking_id } = req.params;
    const { item_id, quantity = 1 } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows: items } = await pool.query(
      `SELECT * FROM proshop_item WHERE id = $1 AND status = 'active'`, [item_id]
    );
    if (!items.length) return res.status(404).json({ error: 'Item not found' });

    const { rows: bookings } = await pool.query(
      `SELECT id FROM golf_booking WHERE id = $1`, [booking_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Golf booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO golf_booking_item (booking_id, item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [booking_id, item_id, items[0].name, quantity, items[0].price]
    );
    res.status(201).json({ ...rows[0], total: rows[0].quantity * rows[0].unit_price });
  } catch (err) { next(err); }
}

async function removeBookingItem(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM golf_booking_item WHERE id = $1 AND booking_id = $2 RETURNING id`,
      [req.params.id, req.params.booking_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.status(204).end();
  } catch (err) { next(err); }
}

module.exports = { listItems, createItem, updateItem, listBookingItems, addBookingItem, removeBookingItem };
