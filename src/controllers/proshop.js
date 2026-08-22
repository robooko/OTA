const pool = require('../db');
const { publishProshopItemAdded, publishProshopItemRemoved } = require('../lib/ably');

// ── Shops ─────────────────────────────────────────────────────────────────────

async function listShops(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM shop WHERE status = 'active' AND property_id = $1 ORDER BY name`,
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createShop(req, res, next) {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO shop (property_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
      [req.property_id, name, description || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateShop(req, res, next) {
  try {
    const { name, description, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE shop SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         status      = COALESCE($3, status)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [name, description, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category, shop_id } = req.query;
    let query = `SELECT * FROM proshop_item WHERE status = 'active'`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (shop_id) { params.push(shop_id); query += ` AND shop_id = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND property_id = $${params.length}`;
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price, shop_id } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

    const { rows: shops } = await pool.query(
      `SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]
    );
    if (!shops.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows } = await pool.query(
      `INSERT INTO proshop_item (property_id, shop_id, name, description, category, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, shop_id, name, description || null, category || null, price]
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
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [name, description, category, price, status, req.params.id, req.property_id]
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
       WHERE gbi.booking_id = $1 AND gbi.property_id = $2
       ORDER BY p.category, gbi.item_name`,
      [req.params.booking_id, req.property_id]
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
      `SELECT * FROM proshop_item WHERE id = $1 AND status = 'active' AND property_id = $2`,
      [item_id, req.property_id]
    );
    if (!items.length) return res.status(404).json({ error: 'Item not found' });

    const { rows: bookings } = await pool.query(
      `SELECT id FROM golf_booking WHERE id = $1 AND property_id = $2`, [booking_id, req.property_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Golf booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO golf_booking_item (property_id, booking_id, item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, booking_id, item_id, items[0].name, quantity, items[0].price]
    );
    const created = { ...rows[0], total: rows[0].quantity * rows[0].unit_price };

    publishProshopItemAdded(req.property_id, created).catch((err) => console.error('Ably publish failed:', err.message));

    res.status(201).json(created);
  } catch (err) { next(err); }
}

async function removeBookingItem(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM golf_booking_item WHERE id = $1 AND booking_id = $2 AND property_id = $3 RETURNING id`,
      [req.params.id, req.params.booking_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    publishProshopItemRemoved(req.property_id, { id: rows[0].id, booking_id: req.params.booking_id })
      .catch((err) => console.error('Ably publish failed:', err.message));

    res.status(204).end();
  } catch (err) { next(err); }
}

module.exports = { listShops, createShop, updateShop, listItems, createItem, updateItem, listBookingItems, addBookingItem, removeBookingItem };
