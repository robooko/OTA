const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Equipment ─────────────────────────────────────────────────────────────────

async function listEquipment(req, res, next) {
  try {
    const { type } = req.query;
    let query = "SELECT * FROM equipment WHERE status = 'active'";
    const params = [];
    if (type) { params.push(type); query += ` AND type = $${params.length}`; }
    query += ' ORDER BY name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createEquipment(req, res, next) {
  try {
    const { name, type, description, quantity, price_per_day, price_per_hour } = req.body;
    if (!name || !type || !quantity) {
      return res.status(400).json({ error: 'name, type, and quantity are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO equipment (name, type, description, quantity, price_per_day, price_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, type, description ?? null, quantity, price_per_day ?? null, price_per_hour ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateEquipment(req, res, next) {
  try {
    const { name, type, description, quantity, price_per_day, price_per_hour, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE equipment SET
         name           = COALESCE($1, name),
         type           = COALESCE($2, type),
         description    = COALESCE($3, description),
         quantity       = COALESCE($4, quantity),
         price_per_day  = COALESCE($5, price_per_day),
         price_per_hour = COALESCE($6, price_per_hour),
         status         = COALESCE($7, status)
       WHERE id = $8 RETURNING *`,
      [name, type, description, quantity, price_per_day, price_per_hour, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Search availability ───────────────────────────────────────────────────────

async function searchEquipment(req, res, next) {
  try {
    const { date, type, quantity } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT e.*,
             e.quantity - COALESCE(SUM(eh.quantity) FILTER (WHERE eh.status != 'cancelled'), 0) AS available_quantity
      FROM equipment e
      LEFT JOIN equipment_hire eh ON eh.equipment_id = e.id AND eh.hire_date = $1
      WHERE e.status = 'active'
    `;
    const params = [date];
    if (type) { params.push(type); query += ` AND e.type = $${params.length}`; }
    query += ' GROUP BY e.id';
    if (quantity) { query += ` HAVING e.quantity - COALESCE(SUM(eh.quantity) FILTER (WHERE eh.status != 'cancelled'), 0) >= ${parseInt(quantity, 10)}`; }
    query += ' ORDER BY e.type, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Hire bookings ─────────────────────────────────────────────────────────────

async function listHires(req, res, next) {
  try {
    const { date, status, guest_id, golf_booking_id } = req.query;
    let query = `
      SELECT eh.*, e.name AS equipment_name, e.type, e.price_per_day, e.price_per_hour
      FROM equipment_hire eh
      JOIN equipment e ON e.id = eh.equipment_id
      WHERE 1=1
    `;
    const params = [];
    if (date)            { params.push(date);            query += ` AND eh.hire_date = $${params.length}`; }
    if (status)          { params.push(status);          query += ` AND eh.status = $${params.length}`; }
    if (guest_id)        { params.push(guest_id);        query += ` AND eh.guest_id = $${params.length}`; }
    if (golf_booking_id) { params.push(golf_booking_id); query += ` AND eh.golf_booking_id = $${params.length}`; }
    query += ' ORDER BY eh.hire_date, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createHire(req, res, next) {
  const { equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, quantity, notes, golf_booking_id } = req.body;
  if (!equipment_id || !contact_name || !hire_date || !quantity) {
    return res.status(400).json({ error: 'equipment_id, contact_name, hire_date, and quantity are required' });
  }
  if (!isValidDate(hire_date)) return res.status(400).json({ error: 'Invalid date format' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eqRes = await client.query('SELECT * FROM equipment WHERE id = $1', [equipment_id]);
    if (!eqRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
    if (eqRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Equipment not available' }); }

    const hiredRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS hired FROM equipment_hire
       WHERE equipment_id = $1 AND hire_date = $2 AND status != 'cancelled'`,
      [equipment_id, hire_date]
    );
    const hired = parseInt(hiredRes.rows[0].hired, 10);
    const available = eqRes.rows[0].quantity - hired;
    if (quantity > available) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${available} available on this date` });
    }

    const eq = eqRes.rows[0];
    const total_price = (parseFloat(eq.price_per_day || 0) * quantity).toFixed(2);

    const { rows } = await client.query(
      `INSERT INTO equipment_hire (equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, quantity, notes, golf_booking_id, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [equipment_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, hire_date, quantity, notes ?? null, golf_booking_id ?? null, total_price]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function updateHire(req, res, next) {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE equipment_hire SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Hire not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listEquipment, createEquipment, updateEquipment,
  searchEquipment,
  listHires, createHire, updateHire,
};
