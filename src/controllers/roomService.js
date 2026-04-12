const pool = require('../db');

// ── Menu items ────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category } = req.query;
    let query = `SELECT * FROM room_service_item WHERE status = 'active'`;
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
      `INSERT INTO room_service_item (name, description, category, price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, category || null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { name, description, category, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE room_service_item SET
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

// ── Orders ────────────────────────────────────────────────────────────────────

async function listOrders(req, res, next) {
  try {
    const { booking_id, guest_id, status, skip, take } = req.query;
    let query = `
      SELECT o.*,
             json_agg(json_build_object(
               'id', oi.id,
               'item_id', oi.item_id,
               'item_name', oi.item_name,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price,
               'total', (oi.quantity * oi.unit_price)
             )) AS items
      FROM room_service_order o
      LEFT JOIN room_service_order_item oi ON oi.order_id = o.id
      WHERE 1=1
    `;
    const params = [];
    if (booking_id) { params.push(booking_id); query += ` AND o.booking_id = $${params.length}`; }
    if (guest_id)   { params.push(guest_id);   query += ` AND o.guest_id = $${params.length}`; }
    if (status)     { params.push(status);     query += ` AND o.status = $${params.length}`; }
    query += ' GROUP BY o.id ORDER BY o.created_at DESC';
    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getOrder(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT o.*,
              json_agg(json_build_object(
                'id', oi.id,
                'item_id', oi.item_id,
                'item_name', oi.item_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'total', (oi.quantity * oi.unit_price)
              )) AS items
       FROM room_service_order o
       LEFT JOIN room_service_order_item oi ON oi.order_id = o.id
       WHERE o.id = $1
       GROUP BY o.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createOrder(req, res, next) {
  try {
    const { booking_id, guest_id, items, notes, scheduled_for } = req.body;
    if (!booking_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'booking_id and items array are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validate booking exists
      const { rows: bookings } = await client.query(
        `SELECT id FROM booking WHERE id = $1 AND status NOT IN ('cancelled')`,
        [booking_id]
      );
      if (!bookings.length) return res.status(404).json({ error: 'Booking not found or cancelled' });

      // Lock in item prices from DB
      let total = 0;
      const resolvedItems = [];
      for (const item of items) {
        const { item_id, quantity = 1 } = item;
        const { rows: found } = await client.query(
          `SELECT id, name, price FROM room_service_item WHERE id = $1 AND status = 'active'`,
          [item_id]
        );
        if (!found.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: `Item ${item_id} not found` });
        }
        const unit_price = parseFloat(found[0].price);
        total += unit_price * quantity;
        resolvedItems.push({ item_id, item_name: found[0].name, quantity, unit_price });
      }

      // Create order
      const { rows: order } = await client.query(
        `INSERT INTO room_service_order (booking_id, guest_id, notes, scheduled_for, total_price)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [booking_id, guest_id || null, notes || null, scheduled_for || null, total]
      );

      // Insert line items
      for (const li of resolvedItems) {
        await client.query(
          `INSERT INTO room_service_order_item (order_id, item_id, item_name, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [order[0].id, li.item_id, li.item_name, li.quantity, li.unit_price]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ ...order[0], items: resolvedItems });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { status } = req.body;
    const valid = ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE room_service_order SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { listItems, createItem, updateItem, listOrders, getOrder, createOrder, updateOrderStatus };
