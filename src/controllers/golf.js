const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewGolfBookingForProperty, publishGolfBookingStatusChangedForProperty } = require('../lib/ably');

// Steps a 'YYYY-MM-DD' string forward by whole days via UTC epoch math --
// `new Date(str); d.setDate(d.getDate() + 1)` looks equivalent but
// setDate() operates in the Node process's LOCAL timezone, so the date
// this actually produces depends on where the server happens to be
// running. This is deterministic regardless of process.env.TZ.
function addDaysUTC(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

// ── Courses ───────────────────────────────────────────────────────────────────

async function listCourses(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM golf_course WHERE status = 'active' AND property_id = $1",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player } = req.body;
    if (!name || !holes || price_per_player == null) {
      return res.status(400).json({ error: 'name, holes, and price_per_player are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO golf_course (property_id, name, description, holes, price_per_player) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, name, description ?? null, holes, price_per_player]
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
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [name, description, holes, price_per_player, status, req.params.id, req.property_id]
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

    const courseRes = await pool.query('SELECT id FROM golf_course WHERE id = $1 AND property_id = $2', [course_id, req.property_id]);
    if (!courseRes.rows.length) return res.status(404).json({ error: 'Course not found' });

    const created = [];
    let date = from;
    while (date <= to) {
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (course_id, tee_date, tee_time) DO NOTHING
           RETURNING *`,
          [req.property_id, course_id, date, time, max_players]
        );
        if (rows.length) created.push(rows[0]);
      }
      date = addDaysUTC(date, 1);
    }
    res.status(201).json({ created: created.length, tee_times: created });
  } catch (err) { next(err); }
}

async function searchTeeTimes(req, res, next) {
  try {
    const { date, from, to, course_id, players } = req.query;

    // Support single date or date range
    const start = from || date;
    const end = to || date;
    if (!start) return res.status(400).json({ error: 'date or from/to is required' });
    if (!isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT tt.*, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS booked_players,
             tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS available_spots
      FROM tee_time tt
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking gb ON gb.tee_time_id = tt.id
      WHERE tt.tee_date >= $1
        AND tt.tee_date <= $2
        AND tt.status = 'active'
        AND gc.status = 'active'
        AND tt.property_id = $3
    `;
    const params = [start, end, req.property_id];
    if (course_id) { params.push(course_id); query += ` AND tt.course_id = $${params.length}`; }
    query += ' GROUP BY tt.id, gc.id';
    if (players) { query += ` HAVING tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) >= ${parseInt(players, 10)}`; }
    query += ' ORDER BY tt.tee_date, tt.tee_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

// Same JOIN as listBookings (including proshop_items) -- used everywhere a
// booking gets published to a live feed or reshaped for one.
async function fetchJoinedBooking(id) {
  const { rows } = await pool.query(
    `SELECT gb.*, tt.tee_date, tt.tee_time, gc.name AS course_name, gc.holes, gc.price_per_player,
            COALESCE(json_agg(json_build_object(
              'id', gbi.id, 'item_id', gbi.item_id, 'item_name', gbi.item_name,
              'quantity', gbi.quantity, 'unit_price', gbi.unit_price,
              'total', (gbi.quantity * gbi.unit_price)
            )) FILTER (WHERE gbi.id IS NOT NULL), '[]') AS proshop_items
     FROM golf_booking gb
     JOIN tee_time tt ON tt.id = gb.tee_time_id
     JOIN golf_course gc ON gc.id = tt.course_id
     LEFT JOIN golf_booking_item gbi ON gbi.booking_id = gb.id
     WHERE gb.id = $1
     GROUP BY gb.id, tt.tee_date, tt.tee_time, gc.name, gc.holes, gc.price_per_player`,
    [id]
  );
  return rows[0];
}

// golf_booking stores one 'contact_name' field (same convention as spa/
// equipment/beach-club/tours bookings) -- but @forgebuild/hotal-ui's
// <live-golf-bookings-feed> expects split first_name/last_name (modeled on
// the guest table shape used by room bookings). Split on the first space
// rather than adding a name column just to satisfy this one feed.
function splitContactName(name) {
  const trimmed = (name || '').trim();
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx === -1
    ? { first_name: trimmed, last_name: '' }
    : { first_name: trimmed.slice(0, spaceIdx), last_name: trimmed.slice(spaceIdx + 1) };
}

// Shapes a joined golf_booking row (see fetchJoinedBooking) into the
// GolfBooking contract hotal-ui's feed expects. tee_time is built as a plain
// 'YYYY-MM-DDTHH:MM:SS' string, deliberately not UTC-normalized -- tee times
// have no stored timezone, so this is treated as the property's own local
// wall-clock time and the client renders it as-is (same reasoning as spa's
// toLiveSpaBooking start_time).
function toGolfBooking(row) {
  const { first_name, last_name } = splitContactName(row.contact_name);
  return {
    id: row.id,
    first_name,
    last_name,
    email: row.contact_email,
    phone: row.contact_phone,
    course_name: row.course_name,
    tee_time: `${row.tee_date instanceof Date ? row.tee_date.toISOString().slice(0, 10) : row.tee_date}T${row.tee_time}`,
    players: row.players,
    holes: row.holes,
    price: row.total_price,
    items: row.proshop_items ?? [],
    status: row.status,
    created_at: row.created_at,
  };
}

async function listBookingsForProperty(req, res, next) {
  try {
    const { cursor, limit } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `
      SELECT gb.*, tt.tee_date, tt.tee_time, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(json_agg(json_build_object(
               'id', gbi.id, 'item_id', gbi.item_id, 'item_name', gbi.item_name,
               'quantity', gbi.quantity, 'unit_price', gbi.unit_price,
               'total', (gbi.quantity * gbi.unit_price)
             )) FILTER (WHERE gbi.id IS NOT NULL), '[]') AS proshop_items
      FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking_item gbi ON gbi.booking_id = gb.id
      WHERE gb.property_id = $1
    `;
    const params = [req.property_id];
    if (cursor) { params.push(cursor); query += ` AND gb.created_at < $${params.length}`; }
    query += ' GROUP BY gb.id, tt.tee_date, tt.tee_time, gc.name, gc.holes, gc.price_per_player';
    params.push(take);
    query += ` ORDER BY gb.created_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(query, params);
    res.json(rows.map(toGolfBooking));
  } catch (err) { next(err); }
}

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id, skip, take } = req.query;
    let query = `
      SELECT gb.*, tt.tee_date, tt.tee_time, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(json_agg(json_build_object(
               'id', gbi.id, 'item_id', gbi.item_id, 'item_name', gbi.item_name,
               'quantity', gbi.quantity, 'unit_price', gbi.unit_price,
               'total', (gbi.quantity * gbi.unit_price)
             )) FILTER (WHERE gbi.id IS NOT NULL), '[]') AS proshop_items
      FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking_item gbi ON gbi.booking_id = gb.id
      WHERE gb.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND tt.tee_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND gb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND gb.guest_id = $${params.length}`; }
    query += ' GROUP BY gb.id, tt.tee_date, tt.tee_time, gc.name, gc.holes, gc.price_per_player';
    query += ' ORDER BY tt.tee_date, tt.tee_time';

    const countParams = [req.property_id, date, status, guest_id].filter(Boolean);
    const { rows: countRows } = await pool.query(`SELECT COUNT(DISTINCT gb.id) AS total FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      WHERE gb.property_id = $1
      ${date     ? ` AND tt.tee_date = $${[req.property_id, date].filter(Boolean).length}` : ''}
      ${status   ? ` AND gb.status = $${[req.property_id, date, status].filter(Boolean).length}` : ''}
      ${guest_id ? ` AND gb.guest_id = $${countParams.length}` : ''}
    `, countParams);

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
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
       JOIN golf_course gc ON gc.id = tt.course_id WHERE tt.id = $1 AND tt.property_id = $2`,
      [tee_time_id, req.property_id]
    );
    if (!ttRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tee time not found' }); }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

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
      `INSERT INTO golf_booking (property_id, tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, tee_time_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, players, total_price.toFixed(2), notes ?? null]
    );

    await client.query('COMMIT');

    const full = await fetchJoinedBooking(rows[0].id);
    if (full) {
      publishNewGolfBookingForProperty(req.property_id, toGolfBooking(full))
        .catch((err) => console.error('Ably publish failed:', err.message));
    }

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
    const { status, notes, contact_name, contact_email, contact_phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE golf_booking SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    // live-golf-bookings-feed's upsert replaces the whole list item for an
    // id on every event (same as live-spa-bookings-feed/live-dining-orders-
    // feed) -- only mirror explicit status changes (the cancel button), same
    // scope as spa's property-wide publish.
    if (status !== undefined) {
      const full = await fetchJoinedBooking(rows[0].id);
      if (full) {
        publishGolfBookingStatusChangedForProperty(req.property_id, toGolfBooking(full))
          .catch((err) => console.error('Ably publish failed:', err.message));
      }
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listCourses, createCourse, updateCourse,
  bulkCreateTeeTimes, searchTeeTimes,
  listBookings, createBooking, updateBooking,
  listBookingsForProperty,
};
