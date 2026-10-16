const pool = require('../db');
const { isValidDate, isValidUuid, isValidTime } = require('../middleware/validate');
const { toMinutes, fmt, hireWindow, peakUse, fitsHours, startTimes } = require('../lib/equipmentWindows');

// ── Equipment ─────────────────────────────────────────────────────────────────

async function listEquipment(req, res, next) {
  try {
    const { type } = req.query;
    let query = "SELECT * FROM equipment WHERE status = 'active'";
    const params = [];
    if (type) { params.push(type); query += ` AND type = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND property_id = $${params.length}`;
    query += ' ORDER BY name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

const MAX_INT = 2147483647;
const MAX_MONEY = 99999999.99;
const isPrice = (v) => v == null || (typeof v === 'number' && v >= 0 && v <= MAX_MONEY);
const isHour = (v) => typeof v === 'string' && isValidTime(v.slice(0, 5));

// Validates a full equipment row (body for create, body merged over the
// stored row for update). Returns an error message or null.
function equipmentError(e) {
  if (!e.name || !e.type) return 'name, type, and quantity are required';
  if (!Number.isInteger(e.quantity) || e.quantity < 1 || e.quantity > MAX_INT) return 'quantity must be a positive integer';
  if (!isPrice(e.price_per_day) || !isPrice(e.price_per_hour)) return 'Prices must be non-negative numbers';
  if ((e.open_time == null) !== (e.close_time == null)) return 'open_time and close_time must both be set or both be null';
  if (e.open_time != null) {
    if (!isHour(e.open_time) || !isHour(e.close_time)) return 'open_time and close_time must be HH:MM';
    if (toMinutes(e.close_time) <= toMinutes(e.open_time)) return 'close_time must be after open_time';
  }
  if (!Number.isInteger(e.slot_interval_minutes) || e.slot_interval_minutes < 5 || e.slot_interval_minutes > 240) {
    return 'slot_interval_minutes must be an integer from 5 to 240';
  }
  return null;
}

const EQUIPMENT_FIELDS = ['name', 'type', 'description', 'quantity', 'price_per_day', 'price_per_hour', 'status', 'open_time', 'close_time', 'slot_interval_minutes'];
const NUMERIC_FIELDS = new Set(['quantity', 'price_per_day', 'price_per_hour', 'slot_interval_minutes']);
// Form posts send numbers as strings; the old SQL-side cast accepted them.
const fieldValue = (f, v) => (NUMERIC_FIELDS.has(f) && typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

async function createEquipment(req, res, next) {
  try {
    const e = { status: 'active', slot_interval_minutes: 60 };
    for (const f of EQUIPMENT_FIELDS) if (req.body[f] != null) e[f] = fieldValue(f, req.body[f]);
    const error = equipmentError(e);
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(
      `INSERT INTO equipment (property_id, name, type, description, quantity, price_per_day, price_per_hour, open_time, close_time, slot_interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.property_id, e.name, e.type, e.description ?? null, e.quantity, e.price_per_day ?? null, e.price_per_hour ?? null,
       e.open_time ?? null, e.close_time ?? null, e.slot_interval_minutes]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// Locks the row, merges the body over it, validates the result, writes it.
// An explicit null clears open_time / close_time; other fields keep their
// stored value when null or absent.
async function updateEquipment(req, res, next) {
  if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Equipment not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      'SELECT * FROM equipment WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]);
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }

    const e = { ...row, price_per_day: row.price_per_day == null ? null : Number(row.price_per_day),
                price_per_hour: row.price_per_hour == null ? null : Number(row.price_per_hour) };
    for (const f of EQUIPMENT_FIELDS) {
      if (f === 'open_time' || f === 'close_time') { if (f in req.body) e[f] = req.body[f]; }
      else if (req.body[f] != null) e[f] = fieldValue(f, req.body[f]);
    }
    const error = equipmentError(e);
    if (error) { await client.query('ROLLBACK'); return res.status(400).json({ error }); }

    const { rows } = await client.query(
      `UPDATE equipment SET name = $1, type = $2, description = $3, quantity = $4, price_per_day = $5,
         price_per_hour = $6, status = $7, open_time = $8, close_time = $9, slot_interval_minutes = $10
       WHERE id = $11 RETURNING *`,
      [e.name, e.type, e.description, e.quantity, e.price_per_day, e.price_per_hour, e.status,
       e.open_time, e.close_time, e.slot_interval_minutes, row.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
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
      LEFT JOIN equipment_hire eh ON eh.equipment_id = e.id AND eh.hire_date = $1 AND eh.property_id = $2
      WHERE e.status = 'active' AND e.property_id = $2
    `;
    const params = [date, req.property_id];
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
    const { date, status, guest_id, golf_booking_id, equipment_id } = req.query;
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
    if (equipment_id)    { params.push(equipment_id);    query += ` AND eh.equipment_id = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND eh.property_id = $${params.length}`;
    query += ' ORDER BY eh.hire_date, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// "Today" and minutes past midnight now, in the property's timezone.
async function propertyNow(db, propertyId) {
  const { rows: [r] } = await db.query(
    `SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today,
            extract(hour FROM now() AT TIME ZONE timezone) * 60 + extract(minute FROM now() AT TIME ZONE timezone) AS now_minutes
     FROM property WHERE id = $1`, [propertyId]);
  return { today: r.today, nowMinutes: Number(r.now_minutes) };
}

// Non-cancelled hires on date for the given items, grouped by equipment_id.
async function dayHires(db, propertyId, date, equipmentIds, excludeHireId = null) {
  const { rows } = await db.query(
    `SELECT equipment_id, rate_type, start_time, duration, quantity FROM equipment_hire
     WHERE property_id = $1 AND hire_date = $2 AND equipment_id = ANY($3) AND status != 'cancelled'
       AND ($4::uuid IS NULL OR id != $4)`,
    [propertyId, date, equipmentIds, excludeHireId]);
  const byItem = new Map(equipmentIds.map((id) => [id, []]));
  for (const r of rows) byItem.get(r.equipment_id).push(r);
  return byItem;
}

// 409 message when quantity doesn't fit in window, else null.
function shortfall(item, hires, window, quantity) {
  const available = item.quantity - peakUse(hires, window);
  if (quantity <= available) return null;
  return window.start === 0 && window.end === 1440
    ? `Only ${available} available on this date`
    : `Only ${available} available from ${fmt(window.start)} to ${fmt(window.end)}`;
}

function hoursError(item) {
  return item.open_time && item.close_time
    ? `Hire must be between ${item.open_time.slice(0, 5)} and ${item.close_time.slice(0, 5)}`
    : 'Hire must end by 24:00';
}

async function createHire(req, res, next) {
  const { equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, start_time, notes, golf_booking_id, rate_type = 'per_day' } = req.body;
  if (!equipment_id || !contact_name || !hire_date || req.body.quantity == null) {
    return res.status(400).json({ error: 'equipment_id, contact_name, hire_date, and quantity are required' });
  }
  if (!isValidDate(hire_date)) return res.status(400).json({ error: 'Invalid date format' });
  for (const id of [equipment_id, guest_id, golf_booking_id]) {
    if (id != null && !isValidUuid(id)) return res.status(400).json({ error: 'Invalid id' });
  }
  const quantity = Number(req.body.quantity);
  const duration = Number(req.body.duration ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_INT) return res.status(400).json({ error: 'quantity must be a positive integer' });
  if (!['per_day', 'per_hour'].includes(rate_type)) return res.status(400).json({ error: 'rate_type must be per_day or per_hour' });
  if (!(duration > 0 && duration < 1000)) return res.status(400).json({ error: 'duration must be a positive number below 1000' });
  if (rate_type === 'per_hour' && !Number.isInteger(duration * 2)) return res.status(400).json({ error: 'Hourly duration must be a multiple of 0.5' });
  if (start_time != null && !isValidTime(start_time)) return res.status(400).json({ error: 'start_time must be HH:MM' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The row lock serialises hires on one item, so two can't both take the last unit.
    const { rows: [eq] } = await client.query(
      'SELECT * FROM equipment WHERE id = $1 AND property_id = $2 FOR UPDATE', [equipment_id, req.property_id]);
    if (!eq) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
    if (eq.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Equipment not available' }); }

    const window = hireWindow({ rate_type, start_time, duration });
    if (rate_type === 'per_hour' && start_time) {
      if (!fitsHours(eq, window)) { await client.query('ROLLBACK'); return res.status(400).json({ error: hoursError(eq) }); }
      const { today, nowMinutes } = await propertyNow(client, req.property_id);
      if (hire_date === today && window.start < nowMinutes) {
        await client.query('ROLLBACK'); return res.status(400).json({ error: 'That time has passed' });
      }
    }

    const hires = (await dayHires(client, req.property_id, hire_date, [eq.id])).get(eq.id);
    const error = shortfall(eq, hires, window, quantity);
    if (error) { await client.query('ROLLBACK'); return res.status(409).json({ error }); }

    const rate = rate_type === 'per_hour' ? parseFloat(eq.price_per_hour || 0) : parseFloat(eq.price_per_day || 0);
    const total_price = (rate * quantity * duration).toFixed(2);
    if (Number(total_price) > MAX_MONEY) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Total price too large' }); }

    const { rows } = await client.query(
      `INSERT INTO equipment_hire (property_id, equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, start_time, quantity, rate_type, duration, notes, golf_booking_id, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [req.property_id, equipment_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, hire_date, start_time ?? null, quantity, rate_type, duration, notes ?? null, golf_booking_id ?? null, total_price]
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

// Reinstating a cancelled hire re-runs the availability check under the
// same equipment row lock as createHire.
async function updateHire(req, res, next) {
  if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Hire not found' });
  const { status, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [hire] } = await client.query(
      'SELECT * FROM equipment_hire WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]);
    if (!hire) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Hire not found' }); }

    if (hire.status === 'cancelled' && status != null && status !== 'cancelled') {
      const { rows: [eq] } = await client.query('SELECT * FROM equipment WHERE id = $1 FOR UPDATE', [hire.equipment_id]);
      if (eq.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Equipment not available' }); }
      const hires = (await dayHires(client, req.property_id, hire.hire_date, [eq.id], hire.id)).get(eq.id);
      const error = shortfall(eq, hires, hireWindow(hire), hire.quantity);
      if (error) { await client.query('ROLLBACK'); return res.status(409).json({ error }); }
    }

    const { rows } = await client.query(
      `UPDATE equipment_hire SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, hire.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  listEquipment, createEquipment, updateEquipment,
  searchEquipment,
  listHires, createHire, updateHire,
};
