const pool = require('../db');
const { publishNewOrder, publishOrderStatusChanged, client: ablyClient } = require('../lib/ably');

// ── Menu items ────────────────────────────────────────────────────────────────

async function listMenuItems(req, res, next) {
  try {
    const { category, restaurant_id } = req.query;
    let query = `SELECT * FROM restaurant_menu_item WHERE status = 'active' AND property_id = $1`;
    const params = [req.property_id];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (restaurant_id) { params.push(restaurant_id); query += ` AND restaurant_id = $${params.length}`; }
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createMenuItem(req, res, next) {
  try {
    const { name, description, category, price, restaurant_id, allergens } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (allergens !== undefined && !Array.isArray(allergens)) {
      return res.status(400).json({ error: 'allergens must be an array of strings' });
    }

    if (restaurant_id) {
      const restaurantRes = await pool.query('SELECT id FROM restaurant WHERE id = $1 AND property_id = $2', [
        restaurant_id,
        req.property_id,
      ]);
      if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO restaurant_menu_item (property_id, restaurant_id, name, description, category, price, allergens)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, restaurant_id || null, name, description || null, category || null, price, allergens ?? []]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateMenuItem(req, res, next) {
  try {
    const { name, description, category, price, status, restaurant_id, allergens } = req.body;
    if (allergens !== undefined && !Array.isArray(allergens)) {
      return res.status(400).json({ error: 'allergens must be an array of strings' });
    }

    if (restaurant_id) {
      const restaurantRes = await pool.query('SELECT id FROM restaurant WHERE id = $1 AND property_id = $2', [
        restaurant_id,
        req.property_id,
      ]);
      if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    }

    const { rows } = await pool.query(
      `UPDATE restaurant_menu_item SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         category      = COALESCE($3, category),
         price         = COALESCE($4, price),
         status        = COALESCE($5, status),
         restaurant_id = COALESCE($6, restaurant_id),
         allergens     = COALESCE($7, allergens)
       WHERE id = $8 AND property_id = $9 RETURNING *`,
      [name, description, category, price, status, restaurant_id, allergens ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Orders ────────────────────────────────────────────────────────────────────

async function listOrders(req, res, next) {
  try {
    const { restaurant_id, booking_id, table_id, guest_id, status, skip, take } = req.query;
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
      FROM restaurant_order o
      LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
      WHERE o.property_id = $1
    `;
    const params = [req.property_id];
    if (restaurant_id) { params.push(restaurant_id); query += ` AND o.restaurant_id = $${params.length}`; }
    if (booking_id) { params.push(booking_id); query += ` AND o.booking_id = $${params.length}`; }
    if (table_id)   { params.push(table_id);   query += ` AND o.table_id = $${params.length}`; }
    if (guest_id)   { params.push(guest_id);   query += ` AND o.guest_id = $${params.length}`; }
    if (status)     { params.push(status);     query += ` AND o.status = $${params.length}`; }
    query += ' GROUP BY o.id ORDER BY o.created_at DESC';

    const countParams = [req.property_id, restaurant_id, booking_id, table_id, guest_id, status].filter(Boolean);
    const [{ rows: countRows }] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT o.id) AS total FROM restaurant_order o WHERE o.property_id = $1
        ${restaurant_id ? ` AND o.restaurant_id = $${[restaurant_id].length + 1}` : ''}
        ${booking_id ? ` AND o.booking_id = $${[restaurant_id, booking_id].filter(Boolean).length + 1}` : ''}
        ${table_id   ? ` AND o.table_id = $${[restaurant_id, booking_id, table_id].filter(Boolean).length + 1}` : ''}
        ${guest_id   ? ` AND o.guest_id = $${[restaurant_id, booking_id, table_id, guest_id].filter(Boolean).length + 1}` : ''}
        ${status     ? ` AND o.status = $${[restaurant_id, booking_id, table_id, guest_id, status].filter(Boolean).length + 1}` : ''}
      `, countParams)
    ]);

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
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
       FROM restaurant_order o
       LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
       WHERE o.id = $1 AND o.property_id = $2
       GROUP BY o.id`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createOrder(req, res, next) {
  try {
    const { restaurant_id, booking_id, table_id, guest_id, items, notes, scheduled_for } = req.body;
    if (!restaurant_id || (!booking_id && !table_id) || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id, either booking_id or table_id, and an items array, are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: restaurants } = await client.query(
        'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
        [restaurant_id, req.property_id]
      );
      if (!restaurants.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restaurant not found' }); }

      if (booking_id) {
        const { rows: bookings } = await client.query(
          `SELECT id FROM booking WHERE id = $1 AND property_id = $2 AND status NOT IN ('cancelled')`,
          [booking_id, req.property_id]
        );
        if (!bookings.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found or cancelled' }); }
      }

      if (table_id) {
        const { rows: tables } = await client.query(
          `SELECT id FROM restaurant_table WHERE id = $1 AND property_id = $2 AND status = 'active'`,
          [table_id, req.property_id]
        );
        if (!tables.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Table not found' }); }
      }

      // Lock in item prices from DB
      let total = 0;
      const resolvedItems = [];
      for (const item of items) {
        const { item_id, quantity = 1 } = item;
        const { rows: found } = await client.query(
          `SELECT id, name, price FROM restaurant_menu_item WHERE id = $1 AND property_id = $2 AND status = 'active'`,
          [item_id, req.property_id]
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
        `INSERT INTO restaurant_order (property_id, restaurant_id, booking_id, table_id, guest_id, notes, scheduled_for, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.property_id, restaurant_id, booking_id || null, table_id || null, guest_id || null, notes || null, scheduled_for || null, total]
      );

      // Insert line items
      for (const li of resolvedItems) {
        await client.query(
          `INSERT INTO restaurant_order_item (order_id, item_id, item_name, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [order[0].id, li.item_id, li.item_name, li.quantity, li.unit_price]
        );
      }

      await client.query('COMMIT');
      publishNewOrder(restaurant_id, { ...order[0], items: resolvedItems }).catch((err) => console.error('Ably publish failed:', err.message));
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
      `UPDATE restaurant_order SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    publishOrderStatusChanged(rows[0].restaurant_id, { id: rows[0].id, status: rows[0].status, restaurant_id: rows[0].restaurant_id }).catch((err) => console.error('Ably publish failed:', err.message));
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function getAblyToken(req, res, next) {
  try {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });

    const { rows } = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const channel = `restaurant:${restaurant_id}:orders`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}

module.exports = { listMenuItems, createMenuItem, updateMenuItem, listOrders, getOrder, createOrder, updateOrderStatus, getAblyToken };
