const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Tours ─────────────────────────────────────────────────────────────────────

async function listTours(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM tour WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price } = req.body;
    if (!name || !duration_mins || !max_group_size || !price) {
      return res.status(400).json({ error: 'name, duration_mins, max_group_size, and price are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO tour (name, description, duration_mins, max_group_size, price)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, description ?? null, duration_mins, max_group_size, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE tour SET
         name           = COALESCE($1, name),
         description    = COALESCE($2, description),
         duration_mins  = COALESCE($3, duration_mins),
         max_group_size = COALESCE($4, max_group_size),
         price          = COALESCE($5, price),
         status         = COALESCE($6, status)
       WHERE id = $7 RETURNING *`,
      [name, description, duration_mins, max_group_size, price, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tour not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tour slots ────────────────────────────────────────────────────────────────

async function bulkCreateSlots(req, res, next) {
  try {
    const { tour_id, from, to, times } = req.body;
    if (!tour_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'tour_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tour_slot (tour_id, slot_date, slot_time)
           VALUES ($1, $2, $3)
           ON CONFLICT (tour_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [tour_id, date, time]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, slots: created });
  } catch (err) { next(err); }
}

async function searchSlots(req, res, next) {
  try {
    const { date, tour_id, group_size } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ts.*, t.name AS tour_name, t.description, t.duration_mins,
             t.max_group_size, t.price,
             COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) AS booked_seats,
             t.max_group_size - COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) AS available_seats
      FROM tour_slot ts
      JOIN tour t ON t.id = ts.tour_id
      LEFT JOIN tour_booking tb ON tb.slot_id = ts.id
      WHERE ts.slot_date = $1
        AND ts.status = 'active'
        AND t.status = 'active'
    `;
    const params = [date];
    if (tour_id) { params.push(tour_id); query += ` AND ts.tour_id = $${params.length}`; }
    query += ` GROUP BY ts.id, t.id`;
    if (group_size) { query += ` HAVING t.max_group_size - COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) >= ${parseInt(group_size, 10)}`; }
    query += ' ORDER BY ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT tb.*, ts.slot_date, ts.slot_time, t.name AS tour_name, t.price
      FROM tour_booking tb
      JOIN tour_slot ts ON ts.id = tb.slot_id
      JOIN tour t ON t.id = ts.tour_id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND ts.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND tb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND tb.guest_id = $${params.length}`; }
    query += ' ORDER BY ts.slot_date, ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, notes } = req.body;
  if (!slot_id || !contact_name || !group_size) {
    return res.status(400).json({ error: 'slot_id, contact_name, and group_size are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ts.*, t.max_group_size, t.price
       FROM tour_slot ts JOIN tour t ON t.id = ts.tour_id
       WHERE ts.id = $1`, [slot_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }

    const slot = slotRes.rows[0];
    const bookedRes = await client.query(
      `SELECT COALESCE(SUM(group_size), 0) AS booked FROM tour_booking WHERE slot_id = $1 AND status != 'cancelled'`,
      [slot_id]
    );
    const booked = parseInt(bookedRes.rows[0].booked, 10);
    if (booked + group_size > slot.max_group_size) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${slot.max_group_size - booked} spots remaining` });
    }

    const total_price = parseFloat(slot.price) * group_size;
    const { rows } = await client.query(
      `INSERT INTO tour_booking (slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, group_size, total_price.toFixed(2), notes ?? null]
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

async function updateBooking(req, res, next) {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE tour_booking SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listTours, createTour, updateTour,
  bulkCreateSlots, searchSlots,
  listBookings, createBooking, updateBooking,
};
