const pool = require('../db');

async function getOpenSession(req, res, next) {
  try {
    const { table_id, status } = req.query;
    if (!table_id) return res.status(400).json({ error: 'table_id is required' });

    let query = `SELECT * FROM restaurant_table_session WHERE table_id = $1 AND property_id = $2`;
    const params = [table_id, req.property_id];
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    query += ' ORDER BY opened_at DESC LIMIT 1';

    const { rows: sessions } = await pool.query(query, params);
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessions[0];

    const { rows: orders } = await pool.query(
      `SELECT o.*,
              json_agg(json_build_object(
                'id', oi.id,
                'item_id', oi.item_id,
                'item_name', oi.item_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'variant', oi.variant,
                'total', (oi.quantity * oi.unit_price)
              )) AS items
       FROM restaurant_order o
       LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
       WHERE o.table_session_id = $1
       GROUP BY o.id
       ORDER BY o.created_at`,
      [session.id]
    );

    let reservation = null;
    if (session.reservation_id) {
      const { rows: reservations } = await pool.query(
        `SELECT id, contact_name, party_size, notes FROM restaurant_reservation WHERE id = $1`,
        [session.reservation_id]
      );
      reservation = reservations[0] ?? null;
    }

    res.json({ ...session, orders, reservation });
  } catch (err) { next(err); }
}

async function closeSession(req, res, next) {
  try {
    const { rows: sessions } = await pool.query(
      `SELECT * FROM restaurant_table_session WHERE id = $1 AND property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });

    const { rows: active } = await pool.query(
      `SELECT COUNT(*) FROM restaurant_order WHERE table_session_id = $1 AND status IN ('pending', 'confirmed', 'preparing')`,
      [req.params.id]
    );
    const activeCount = parseInt(active[0].count, 10);
    if (activeCount > 0) {
      return res.status(409).json({ error: `Cannot close: ${activeCount} order(s) still active` });
    }

    const { rows } = await pool.query(
      `UPDATE restaurant_table_session SET status = 'closed', closed_at = now()
       WHERE id = $1 AND property_id = $2 RETURNING *`,
      [req.params.id, req.property_id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { getOpenSession, closeSession };
