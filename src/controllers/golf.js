const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Courses ───────────────────────────────────────────────────────────────────

async function listCourses(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM golf_course WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player } = req.body;
    if (!name || !holes || !price_per_player) {
      return res.status(400).json({ error: 'name, holes, and price_per_player are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO golf_course (name, description, holes, price_per_player) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description ?? null, holes, price_per_player]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE golf_course SET
         name             = COALESCE($1, name),
         description      = COALESCE($2, description),
         holes            = COALESCE($3, holes),
         price_per_player = COALESCE($4, price_per_player),
         status           = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [name, description, holes, price_per_player, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Course not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tee times ─────────────────────────────────────────────────────────────────

async function bulkCreateTeeTimes(req, res, next) {
  try {
    const { course_id, from, to, times, max_players } = req.body;
    if (!course_id || !from || !to || !Array.isArray(times) || !times.length || !max_players) {
      return res.status(400).json({ error: 'course_id, from, to, times array, and max_players are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tee_time (course_id, tee_date, tee_time, max_players)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (course_id, tee_date, tee_time) DO NOTHING
           RETURNING *`,
          [course_id, date, time, max_players]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, tee_times: created });
  } catch (err) { next(err); }
}

async function searchTeeTimes(req, res, next) {
  try {
    const { date, course_id, players } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT tt.*, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS booked_players,
             tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS available_spots
      FROM tee_time tt
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking gb ON gb.tee_time_id = tt.id
      WHERE tt.tee_date = $1
        AND tt.status = 'active'
        AND gc.status = 'active'
    `;
    const params = [date];
    if (course_id) { params.push(course_id); query += ` AND tt.course_id = $${params.length}`; }
    query += ' GROUP BY tt.id, gc.id';
    if (players) { query += ` HAVING tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) >= ${parseInt(players, 10)}`; }
    query += ' ORDER BY tt.tee_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT gb.*, tt.tee_date, tt.tee_time, gc.name AS course_name, gc.holes, gc.price_per_player
      FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      JOIN golf_course gc ON gc.id = tt.course_id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND tt.tee_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND gb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND gb.guest_id = $${params.length}`; }
    query += ' ORDER BY tt.tee_date, tt.tee_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, notes } = req.body;
  if (!tee_time_id || !contact_name || !players) {
    return res.status(400).json({ error: 'tee_time_id, contact_name, and players are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ttRes = await client.query(
      `SELECT tt.*, gc.price_per_player FROM tee_time tt
       JOIN golf_course gc ON gc.id = tt.course_id WHERE tt.id = $1`, [tee_time_id]
    );
    if (!ttRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tee time not found' }); }

    const tt = ttRes.rows[0];
    const bookedRes = await client.query(
      `SELECT COALESCE(SUM(players), 0) AS booked FROM golf_booking WHERE tee_time_id = $1 AND status != 'cancelled'`,
      [tee_time_id]
    );
    const booked = parseInt(bookedRes.rows[0].booked, 10);
    const available = tt.max_players - booked;
    if (players > available) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${available} spots remaining` });
    }

    const total_price = parseFloat(tt.price_per_player) * players;
    const { rows } = await client.query(
      `INSERT INTO golf_booking (tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tee_time_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, players, total_price.toFixed(2), notes ?? null]
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
      `UPDATE golf_booking SET
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
  listCourses, createCourse, updateCourse,
  bulkCreateTeeTimes, searchTeeTimes,
  listBookings, createBooking, updateBooking,
};
