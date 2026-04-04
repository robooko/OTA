const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Restaurants ───────────────────────────────────────────────────────────────

async function listRestaurants(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM restaurant ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
}

async function getRestaurant(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM restaurant WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createRestaurant(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name, description ?? null, phone ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         phone       = COALESCE($3, phone)
       WHERE id = $4 RETURNING *`,
      [name, description, phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tables ────────────────────────────────────────────────────────────────────

async function listTables(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM restaurant_table WHERE restaurant_id = $1 ORDER BY table_number',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTable(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { table_number, seats, location } = req.body;
    if (!table_number || !seats) return res.status(400).json({ error: 'table_number and seats are required' });
    const { rows } = await pool.query(
      `INSERT INTO restaurant_table (restaurant_id, table_number, seats, location) VALUES ($1, $2, $3, $4) RETURNING *`,
      [restaurant_id, table_number, seats, location ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTable(req, res, next) {
  try {
    const { restaurant_id, id } = req.params;
    const { table_number, seats, location, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant_table SET
         table_number = COALESCE($1, table_number),
         seats        = COALESCE($2, seats),
         location     = COALESCE($3, location),
         status       = COALESCE($4, status)
       WHERE id = $5 AND restaurant_id = $6 RETURNING *`,
      [table_number, seats, location, status, id, restaurant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Table not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Time slots ────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, from, to } = req.query;
    let query = 'SELECT * FROM time_slot WHERE restaurant_id = $1';
    const params = [restaurant_id];

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
    const { restaurant_id } = req.params;
    const { slot_date, slot_time, available_seats } = req.body;
    if (!slot_date || !slot_time || !available_seats) {
      return res.status(400).json({ error: 'slot_date, slot_time, and available_seats are required' });
    }
    if (!isValidDate(slot_date)) return res.status(400).json({ error: 'Invalid date format' });
    const { rows } = await pool.query(
      `INSERT INTO time_slot (restaurant_id, slot_date, slot_time, available_seats) VALUES ($1, $2, $3, $4) RETURNING *`,
      [restaurant_id, slot_date, slot_time, available_seats]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function bulkCreateSlots(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { from, to, times, available_seats } = req.body;

    if (!from || !to || !Array.isArray(times) || !times.length || !available_seats) {
      return res.status(400).json({ error: 'from, to, times array, and available_seats are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });
    if (from > to) return res.status(400).json({ error: 'from must be before or equal to to' });

    const rows = [];
    const d = new Date(from);
    const end = new Date(to);

    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows: inserted } = await pool.query(
          `INSERT INTO time_slot (restaurant_id, slot_date, slot_time, available_seats)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (restaurant_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [restaurant_id, date, time, available_seats]
        );
        if (inserted.length) rows.push(inserted[0]);
      }
      d.setDate(d.getDate() + 1);
    }

    res.status(201).json({ created: rows.length, slots: rows });
  } catch (err) { next(err); }
}

// ── Search available slots ────────────────────────────────────────────────────

async function searchSlots(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, party_size } = req.query;
    if (!date || !party_size) return res.status(400).json({ error: 'date and party_size are required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    const { rows } = await pool.query(
      `SELECT ts.*,
              COUNT(rt.id) FILTER (WHERE rt.status = 'active') AS total_tables,
              COUNT(rt.id) FILTER (WHERE rt.status = 'active' AND rt.seats >= $3
                AND NOT EXISTS (
                  SELECT 1 FROM restaurant_reservation rr
                  WHERE rr.table_id = rt.id
                    AND rr.time_slot_id = ts.id
                    AND rr.status != 'cancelled'
                )
              ) AS available_tables
       FROM time_slot ts
       CROSS JOIN restaurant_table rt
       WHERE ts.restaurant_id = $1
         AND rt.restaurant_id = $1
         AND ts.slot_date = $2
         AND ts.available_seats >= $3
       GROUP BY ts.id
       HAVING COUNT(rt.id) FILTER (WHERE rt.status = 'active' AND rt.seats >= $3
                AND NOT EXISTS (
                  SELECT 1 FROM restaurant_reservation rr
                  WHERE rr.table_id = rt.id
                    AND rr.time_slot_id = ts.id
                    AND rr.status != 'cancelled'
                )
              ) > 0
       ORDER BY ts.slot_time`,
      [restaurant_id, date, parseInt(party_size, 10)]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Reservations ──────────────────────────────────────────────────────────────

async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT rr.*, ts.slot_date, ts.slot_time, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN time_slot ts ON ts.id = rr.time_slot_id
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE ts.restaurant_id = $1
    `;
    const params = [restaurant_id];
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
  const { restaurant_id } = req.params;
  const { table_id, time_slot_id, guest_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;

  if (!table_id || !time_slot_id || !contact_name || !party_size) {
    return res.status(400).json({ error: 'table_id, time_slot_id, contact_name, and party_size are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tableRes = await client.query(
      'SELECT * FROM restaurant_table WHERE id = $1 AND restaurant_id = $2', [table_id, restaurant_id]
    );
    if (!tableRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Table not found' }); }
    if (tableRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table is not active' }); }
    if (tableRes.rows[0].seats < party_size) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table does not have enough seats' }); }

    const slotRes = await client.query(
      'SELECT * FROM time_slot WHERE id = $1 AND restaurant_id = $2', [time_slot_id, restaurant_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Time slot not found' }); }
    if (slotRes.rows[0].available_seats < party_size) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Not enough available seats in this slot' }); }

    const conflictRes = await client.query(
      `SELECT id FROM restaurant_reservation WHERE table_id = $1 AND time_slot_id = $2 AND status != 'cancelled'`,
      [table_id, time_slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table already reserved for this time slot' }); }

    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, time_slot_id, guest_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [table_id, time_slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
    );

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
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  listSlots, createSlot, bulkCreateSlots, searchSlots,
  listReservations, getReservation, createReservation, updateReservation,
};
