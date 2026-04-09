const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

async function listBookings(req, res, next) {
  try {
    const { status, guest_id, from, to } = req.query;
    let query = `
      SELECT b.*, g.first_name, g.last_name, g.email,
             r.room_number, r.floor,
             rt.id AS room_type_id, rt.name AS room_type_name,
             rt.description AS room_type_description, rt.max_occupancy, rt.base_rate
      FROM booking b
      JOIN guest g     ON g.id  = b.guest_id
      JOIN room r      ON r.id  = b.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      WHERE 1=1
    `;
    const params = [];

    if (status) { params.push(status); query += ` AND b.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND b.guest_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND b.check_in >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND b.check_out <= $${params.length}`; }

    query += ' ORDER BY b.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT b.*,
              g.first_name, g.last_name, g.email, g.phone,
              r.room_number, r.floor, r.status AS room_status,
              rt.name AS room_type_name, rt.base_rate
       FROM booking b
       JOIN guest     g  ON g.id  = b.guest_id
       JOIN room      r  ON r.id  = b.room_id
       JOIN room_type rt ON rt.id = r.room_type_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows: extras } = await pool.query(
      `SELECT be.id, be.extra_id, be.quantity, be.unit_price,
              e.name, e.description,
              (be.quantity * be.unit_price) AS total
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.id]
    );

    res.json({ ...rows[0], extras });
  } catch (err) {
    next(err);
  }
}

async function createBooking(req, res, next) {
  const { guest_id, room_id, check_in, check_out, guests } = req.body;

  if (!guest_id || !room_id || !check_in || !check_out) {
    return res.status(400).json({ error: 'guest_id, room_id, check_in, and check_out are required' });
  }
  if (!isValidDate(check_in) || !isValidDate(check_out)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
  if (check_in >= check_out) {
    return res.status(400).json({ error: 'check_in must be before check_out' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check room exists and is active
    const roomRes = await client.query(
      `SELECT r.id, r.status, rt.base_rate
       FROM room r JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1`,
      [room_id]
    );
    if (!roomRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Room not found' });
    }
    if (roomRes.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Room is not active' });
    }

    // Check availability for every night
    const availRes = await client.query(
      `SELECT date, is_available, override_rate
       FROM room_availability
       WHERE room_id = $1 AND date >= $2 AND date < $3
       ORDER BY date`,
      [room_id, check_in, check_out]
    );

    // Build set of required dates
    const required = new Set();
    const d = new Date(check_in);
    const end = new Date(check_out);
    while (d < end) {
      required.add(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }

    const availMap = {};
    for (const row of availRes.rows) {
      availMap[row.date.toISOString().slice(0, 10)] = row;
    }

    for (const date of required) {
      const entry = availMap[date];
      if (!entry || !entry.is_available) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Room not available on ${date}` });
      }
    }

    // Check no overlapping confirmed booking
    const overlapRes = await client.query(
      `SELECT id FROM booking
       WHERE room_id = $1
         AND status = 'confirmed'
         AND check_in  < $3
         AND check_out > $2`,
      [room_id, check_in, check_out]
    );
    if (overlapRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Room already booked for this period' });
    }

    // Calculate total price
    let total = 0;
    const baseRate = parseFloat(roomRes.rows[0].base_rate);
    for (const date of required) {
      const entry = availMap[date];
      total += entry && entry.override_rate != null ? parseFloat(entry.override_rate) : baseRate;
    }

    // Insert booking
    const bookingRes = await client.query(
      `INSERT INTO booking (guest_id, room_id, check_in, check_out, guests, total_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [guest_id, room_id, check_in, check_out, guests || 1, total.toFixed(2)]
    );

    // Mark availability as unavailable
    await client.query(
      `UPDATE room_availability
       SET is_available = false
       WHERE room_id = $1 AND date >= $2 AND date < $3`,
      [room_id, check_in, check_out]
    );

    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    await client.query('COMMIT');

    res.status(201).json(bookingRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function updateBooking(req, res, next) {
  try {
    const { status, guests } = req.body;
    const { rows } = await pool.query(
      `UPDATE booking SET
         status = COALESCE($1, status),
         guests = COALESCE($2, guests)
       WHERE id = $3 RETURNING *`,
      [status, guests, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function cancelBooking(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE booking SET status = 'cancelled' WHERE id = $1 AND status != 'cancelled' RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found or already cancelled' });
    }

    const { room_id, check_in, check_out } = rows[0];

    // Restore availability
    await client.query(
      `UPDATE room_availability
       SET is_available = true
       WHERE room_id = $1 AND date >= $2 AND date < $3`,
      [room_id, check_in, check_out]
    );

    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    await client.query('COMMIT');

    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = { listBookings, getBooking, createBooking, updateBooking, cancelBooking };
