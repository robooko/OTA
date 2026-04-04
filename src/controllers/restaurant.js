const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Tables ────────────────────────────────────────────────────────────────────

async function listTables(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM restaurant_table ORDER BY table_number');
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTable(req, res, next) {
  try {
    const { table_number, seats, location } = req.body;
    if (!table_number || !seats) return res.status(400).json({ error: 'table_number and seats are required' });
    const { rows } = await pool.query(
      `INSERT INTO restaurant_table (table_number, seats, location) VALUES ($1, $2, $3) RETURNING *`,
      [table_number, seats, location ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTable(req, res, next) {
  try {
    const { table_number, seats, location, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant_table SET
         table_number = COALESCE($1, table_number),
         seats        = COALESCE($2, seats),
         location     = COALESCE($3, location),
         status       = COALESCE($4, status)
       WHERE id = $5 RETURNING *`,
      [table_number, seats, location, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Table not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Time slots ────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { date, from, to } = req.query;
    let query = 'SELECT * FROM time_slot WHERE 1=1';
    const params = [];

    if (date) {
      if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });
      params.push(date); query += ` AND slot_date = $${params.length}`;
    }
    if (from) {
      if (!isValidDate(from)) return res.status(400).json({ error: 'Invalid from date' });
      params.push(from); query += ` AND slot_date >= $${params.length}`;
    }
    if (to) {
      if (!isValidDate(to)) return res.status(400).json({ error: 'Invalid to date' });
      params.push(to); query += ` AND slot_date <= $${params.length}`;
    }

    query += ' ORDER BY slot_date, slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createSlot(req, res, next) {
  try {
    const { slot_date, slot_time, available_seats } = req.body;
    if (!slot_date || !slot_time || !available_seats) {
      return res.status(400).json({ error: 'slot_date, slot_time, and available_seats are required' });
    }
    if (!isValidDate(slot_date)) return res.status(400).json({ error: 'Invalid date format' });
    const { rows } = await pool.query(
      `INSERT INTO time_slot (slot_date, slot_time, available_seats) VALUES ($1, $2, $3) RETURNING *`,
      [slot_date, slot_time, available_seats]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// ── Search available slots ────────────────────────────────────────────────────

async function searchSlots(req, res, next) {
  try {
    const { date, party_size } = req.query;
    if (!date || !party_size) return res.status(400).json({ error: 'date and party_size are required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    const { rows } = await pool.query(
      `SELECT ts.*,
              COUNT(rt.id) FILTER (WHERE rt.status = 'active') AS total_tables,
              COUNT(rt.id) FILTER (WHERE rt.status = 'active' AND rt.seats >= $2
                AND NOT EXISTS (
                  SELECT 1 FROM restaurant_reservation rr
                  WHERE rr.table_id = rt.id
                    AND rr.time_slot_id = ts.id
                    AND rr.status NOT IN ('cancelled')
                )
              ) AS available_tables
       FROM time_slot ts
       CROSS JOIN restaurant_table rt
       WHERE ts.slot_date = $1
         AND ts.available_seats >= $2
       GROUP BY ts.id
       HAVING COUNT(rt.id) FILTER (WHERE rt.status = 'active' AND rt.seats >= $2
                AND NOT EXISTS (
                  SELECT 1 FROM restaurant_reservation rr
                  WHERE rr.table_id = rt.id
                    AND rr.time_slot_id = ts.id
                    AND rr.status NOT IN ('cancelled')
                )
              ) > 0
       ORDER BY ts.slot_time`,
      [date, parseInt(party_size, 10)]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Reservations ──────────────────────────────────────────────────────────────

async function listReservations(req, res, next) {
  try {
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT rr.*, ts.slot_date, ts.slot_time, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN time_slot ts ON ts.id = rr.time_slot_id
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND ts.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    query += ' ORDER BY ts.slot_date, ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getReservation(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, ts.slot_date, ts.slot_time, rt.table_number, rt.seats, rt.location
       FROM restaurant_reservation rr
       JOIN time_slot ts ON ts.id = rr.time_slot_id
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createReservation(req, res, next) {
  const { table_id, time_slot_id, guest_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;

  if (!table_id || !time_slot_id || !contact_name || !party_size) {
    return res.status(400).json({ error: 'table_id, time_slot_id, contact_name, and party_size are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check table exists and is active
    const tableRes = await client.query(
      'SELECT * FROM restaurant_table WHERE id = $1', [table_id]
    );
    if (!tableRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Table not found' }); }
    if (tableRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table is not active' }); }
    if (tableRes.rows[0].seats < party_size) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table does not have enough seats' }); }

    // Check time slot exists and has capacity
    const slotRes = await client.query(
      'SELECT * FROM time_slot WHERE id = $1', [time_slot_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Time slot not found' }); }
    if (slotRes.rows[0].available_seats < party_size) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Not enough available seats in this slot' }); }

    // Check table not already booked for this slot
    const conflictRes = await client.query(
      `SELECT id FROM restaurant_reservation
       WHERE table_id = $1 AND time_slot_id = $2 AND status != 'cancelled'`,
      [table_id, time_slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table already reserved for this time slot' }); }

    // Create reservation
    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, time_slot_id, guest_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [table_id, time_slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
    );

    // Decrement available seats
    await client.query(
      'UPDATE time_slot SET available_seats = available_seats - $1 WHERE id = $2',
      [party_size, time_slot_id]
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

async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone)
       WHERE id = $6 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    // Restore seats if cancelled
    if (status === 'cancelled') {
      await pool.query(
        'UPDATE time_slot SET available_seats = available_seats + $1 WHERE id = $2',
        [rows[0].party_size, rows[0].time_slot_id]
      );
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listTables, createTable, updateTable,
  listSlots, createSlot, searchSlots,
  listReservations, getReservation, createReservation, updateReservation,
};
