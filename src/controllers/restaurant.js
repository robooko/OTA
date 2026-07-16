const pool = require('../db');
const { isValidDate, isValidTime } = require('../middleware/validate');

function addMinutesToTime(timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

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
    const { name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes } = req.body;
    if (!name || !service_start || !service_end || !default_duration_minutes) {
      return res.status(400).json({ error: 'name, service_start, service_end, and default_duration_minutes are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, description ?? null, phone ?? null, service_start, service_end, slot_interval_minutes ?? 15, default_duration_minutes]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         phone                    = COALESCE($3, phone),
         service_start            = COALESCE($4, service_start),
         service_end              = COALESCE($5, service_end),
         slot_interval_minutes    = COALESCE($6, slot_interval_minutes),
         default_duration_minutes = COALESCE($7, default_duration_minutes)
       WHERE id = $8 RETURNING *`,
      [name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, req.params.id]
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

// ── Availability search ─────────────────────────────────────────────────────

async function searchAvailability(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { from, to, party_size, location } = req.query;

    if (!from || !to || !party_size) {
      return res.status(400).json({ error: 'from, to, and party_size are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });
    if (from > to) return res.status(400).json({ error: 'from must be before or equal to to' });
    const partySize = parseInt(party_size, 10);
    if (!Number.isInteger(partySize) || partySize <= 0) {
      return res.status(400).json({ error: 'party_size must be a positive integer' });
    }

    const restaurantRes = await pool.query('SELECT id FROM restaurant WHERE id = $1', [restaurant_id]);
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      `WITH r AS (
         SELECT service_start, service_end, slot_interval_minutes, default_duration_minutes
         FROM restaurant WHERE id = $1
       ),
       candidate_times AS (
         SELECT generate_series(
           DATE '2000-01-01' + r.service_start,
           DATE '2000-01-01' + r.service_end - (r.default_duration_minutes || ' minutes')::interval,
           (r.slot_interval_minutes || ' minutes')::interval
         )::time AS start_time
         FROM r
       ),
       candidate_dates AS (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS reservation_date
       )
       SELECT
         to_char(cd.reservation_date, 'YYYY-MM-DD') AS reservation_date,
         ct.start_time,
         rt.location,
         COUNT(rt.id) AS available_tables
       FROM candidate_dates cd
       CROSS JOIN candidate_times ct
       CROSS JOIN restaurant_table rt
       WHERE rt.restaurant_id = $1
         AND rt.status = 'active'
         AND rt.seats >= $4
         AND ($5::varchar IS NULL OR rt.location = $5)
         AND NOT EXISTS (
           SELECT 1 FROM restaurant_reservation rr
           CROSS JOIN r
           WHERE rr.table_id = rt.id
             AND rr.reservation_date = cd.reservation_date
             AND rr.status != 'cancelled'
             AND rr.start_time < ct.start_time + (r.default_duration_minutes || ' minutes')::interval
             AND rr.end_time   > ct.start_time
         )
       GROUP BY cd.reservation_date, ct.start_time, rt.location
       HAVING COUNT(rt.id) > 0
       ORDER BY cd.reservation_date, ct.start_time, rt.location`,
      [restaurant_id, from, to, partySize, location ?? null]
    );

    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.reservation_date)) byDate.set(row.reservation_date, []);
      byDate.get(row.reservation_date).push({
        time: row.start_time.slice(0, 5),
        location: row.location,
        available_tables: parseInt(row.available_tables, 10),
      });
    }
    res.json([...byDate.entries()].map(([date, slots]) => ({ date, slots })));
  } catch (err) { next(err); }
}

// ── Reservations ──────────────────────────────────────────────────────────────

async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id, clerk_user_id } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rt.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND rr.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY rr.reservation_date, rr.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getReservation(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location
       FROM restaurant_reservation rr
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
  const { reservation_date, start_time, location, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;

  if (!reservation_date || !start_time || !contact_name || !party_size) {
    return res.status(400).json({ error: 'reservation_date, start_time, contact_name, and party_size are required' });
  }
  if (!isValidDate(reservation_date)) return res.status(400).json({ error: 'Invalid date format' });
  if (!isValidTime(start_time)) return res.status(400).json({ error: 'Invalid start_time format, use HH:MM' });
  if (!Number.isInteger(party_size) || party_size <= 0) {
    return res.status(400).json({ error: 'party_size must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const restaurantRes = await client.query('SELECT * FROM restaurant WHERE id = $1', [restaurant_id]);
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantRes.rows[0];
    const serviceStart = restaurant.service_start.slice(0, 5);
    const serviceEnd = restaurant.service_end.slice(0, 5);
    const end_time = addMinutesToTime(start_time, restaurant.default_duration_minutes);

    if (start_time < serviceStart || end_time > serviceEnd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'start_time is outside service hours' });
    }

    const { rows: candidates } = await client.query(
      `SELECT id FROM restaurant_table
       WHERE restaurant_id = $1
         AND status = 'active'
         AND seats >= $2
         AND ($3::varchar IS NULL OR location = $3)
       ORDER BY seats ASC
       FOR UPDATE SKIP LOCKED`,
      [restaurant_id, party_size, location ?? null]
    );

    let assignedTableId = null;
    for (const table of candidates) {
      const overlapRes = await client.query(
        `SELECT id FROM restaurant_reservation
         WHERE table_id = $1
           AND reservation_date = $2
           AND status != 'cancelled'
           AND start_time < $4
           AND end_time   > $3`,
        [table.id, reservation_date, start_time, end_time]
      );
      if (!overlapRes.rows.length) { assignedTableId = table.id; break; }
    }

    if (!assignedTableId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No tables available for this time' });
    }

    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, reservation_date, start_time, end_time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
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
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  searchAvailability,
  listReservations, getReservation, createReservation, updateReservation,
};
