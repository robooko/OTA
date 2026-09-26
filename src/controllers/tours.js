const pool = require('../db');
const { isValidDate, isValidTime } = require('../middleware/validate');
const { seedTourSlots } = require('../lib/tourSlotSeeder');

// 400-message for an invalid timetable, null when acceptable. Both fields
// are optional; departure_times: [] clears the timetable (already-seeded
// slots stay -- deactivate them individually).
function timetableValidationError({ departure_times, departure_days }) {
  if (departure_times != null) {
    if (!Array.isArray(departure_times) || !departure_times.every(isValidTime)) {
      return 'departure_times must be an array of HH:MM times';
    }
  }
  if (departure_days != null) {
    if (!Array.isArray(departure_days) || !departure_days.length
        || !departure_days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return 'departure_days must be a non-empty array of weekdays 0-6 (0 = Sunday), or null for every day';
    }
  }
  return null;
}

// Extend the timetable out to the horizon right away (the daily sweep would
// catch it anyway) -- fire-and-forget like the tee-sheet seeder.
function seedIfScheduled(tour) {
  if (tour.status === 'active' && tour.departure_times?.length) {
    seedTourSlots(tour.id).catch((err) => console.error('Tour timetable seed failed:', err.message));
  }
}

// ── Tours ─────────────────────────────────────────────────────────────────────

async function listTours(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM tour WHERE status = 'active' AND property_id = $1 ORDER BY name",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price, departure_times, departure_days } = req.body;
    if (!name || duration_mins == null || max_group_size == null || price == null) {
      return res.status(400).json({ error: 'name, duration_mins, max_group_size, and price are required' });
    }
    const timetableError = timetableValidationError(req.body);
    if (timetableError) return res.status(400).json({ error: timetableError });
    const { rows } = await pool.query(
      `INSERT INTO tour (property_id, name, description, duration_mins, max_group_size, price, departure_times, departure_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.property_id, name, description ?? null, duration_mins, max_group_size, price, departure_times ?? null, departure_days ?? null]
    );
    seedIfScheduled(rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTour(req, res, next) {
  const { name, description, duration_mins, max_group_size, price, status, departure_times } = req.body;
  const timetableError = timetableValidationError(req.body);
  if (timetableError) return res.status(400).json({ error: timetableError });
  if (max_group_size != null && (!Number.isInteger(max_group_size) || max_group_size < 1)) {
    return res.status(400).json({ error: 'max_group_size must be a positive integer' });
  }
  // departure_days is the one field where an explicit null means something
  // (back to every day), so it can't go through COALESCE like the rest.
  const setDays = 'departure_days' in req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A capacity cut must not strand seats already sold on an upcoming
    // slot. The tour row lock conflicts with createBooking's FOR SHARE, so
    // no booking can slip in between this check and the update.
    if (max_group_size != null) {
      const { rows: [tour] } = await client.query(
        'SELECT id FROM tour WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]
      );
      if (!tour) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tour not found' }); }
      const { rows: [{ peak }] } = await client.query(
        `SELECT COALESCE(MAX(booked), 0)::int AS peak FROM (
           SELECT SUM(tb.group_size) AS booked
           FROM tour_booking tb JOIN tour_slot ts ON ts.id = tb.slot_id
           WHERE ts.tour_id = $1 AND ts.slot_date >= CURRENT_DATE AND tb.status != 'cancelled'
           GROUP BY ts.id
         ) s`, [req.params.id]
      );
      if (max_group_size < peak) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `An upcoming slot already has ${peak} seats booked -- max_group_size can't go below that` });
      }
    }
    const { rows } = await client.query(
      `UPDATE tour SET
         name            = COALESCE($1, name),
         description     = COALESCE($2, description),
         duration_mins   = COALESCE($3, duration_mins),
         max_group_size  = COALESCE($4, max_group_size),
         price           = COALESCE($5, price),
         status          = COALESCE($6, status),
         departure_times = COALESCE($7::time[], departure_times),
         departure_days  = CASE WHEN $8 THEN $9::smallint[] ELSE departure_days END
       WHERE id = $10 AND property_id = $11 RETURNING *`,
      [name, description, duration_mins, max_group_size, price, status, departure_times, setDays, req.body.departure_days ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tour not found' }); }
    await client.query('COMMIT');
    // Existing slots may carry bookings or staff edits -- a timetable change
    // only shapes slots not yet materialised.
    seedIfScheduled(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// Hard delete of a tour or a single slot, taking its slots and bookings with
// it. Refuses while any upcoming booking is still live, so a guest's seat is
// never silently dropped -- cancel those first. Past/cancelled bookings go.
async function hardDelete(req, res, next, kind) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = kind === 'tour'
      ? await client.query('SELECT id FROM tour WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id])
      : await client.query(
          `SELECT ts.id, t.departure_times FROM tour_slot ts JOIN tour t ON t.id = ts.tour_id
           WHERE ts.id = $1 AND ts.property_id = $2 FOR UPDATE OF ts`, [req.params.id, req.property_id]
        );
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: kind === 'tour' ? 'Tour not found' : 'Slot not found' });
    }
    // The timetable seeder would just recreate a deleted slot on its next sweep.
    if (kind === 'slot' && target.rows[0].departure_times?.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This tour runs on a timetable, so a deleted slot would be regenerated -- set the slot\'s status to "inactive" instead' });
    }

    const slotFilter = kind === 'tour' ? 'ts.tour_id = $1' : 'ts.id = $1';
    const { rows: live } = await client.query(
      `SELECT COUNT(*)::int AS n FROM tour_booking tb JOIN tour_slot ts ON ts.id = tb.slot_id
       WHERE ${slotFilter} AND tb.status != 'cancelled' AND ts.slot_date >= CURRENT_DATE`,
      [req.params.id]
    );
    if (live[0].n) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${live[0].n} upcoming booking(s) still active -- cancel them first` });
    }

    await client.query(
      `DELETE FROM tour_booking tb USING tour_slot ts WHERE ts.id = tb.slot_id AND ${slotFilter}`, [req.params.id]
    );
    await client.query(`DELETE FROM tour_slot ts WHERE ${slotFilter}`, [req.params.id]);
    if (kind === 'tour') await client.query('DELETE FROM tour WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

const deleteTour = (req, res, next) => hardDelete(req, res, next, 'tour');
const deleteSlot = (req, res, next) => hardDelete(req, res, next, 'slot');

// ── Tour slots ────────────────────────────────────────────────────────────────

async function bulkCreateSlots(req, res, next) {
  try {
    const { tour_id, from, to, times } = req.body;
    if (!tour_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'tour_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const tourRes = await pool.query('SELECT id FROM tour WHERE id = $1 AND property_id = $2', [tour_id, req.property_id]);
    if (!tourRes.rows.length) return res.status(404).json({ error: 'Tour not found' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tour_slot (property_id, tour_id, slot_date, slot_time)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tour_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [req.property_id, tour_id, date, time]
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
        AND ts.property_id = $2
    `;
    const params = [date, req.property_id];
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
      WHERE tb.property_id = $1
    `;
    const params = [req.property_id];
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
  if (!slot_id || !contact_name || group_size == null) {
    return res.status(400).json({ error: 'slot_id, contact_name, and group_size are required' });
  }
  if (!Number.isInteger(group_size) || group_size < 1) {
    return res.status(400).json({ error: 'group_size must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Locking the slot row serialises concurrent bookings for it, so two
    // requests can't both pass the seat check below on the same stale
    // count. FOR SHARE on the tour blocks a concurrent capacity cut
    // (updateTour) without serialising bookings across different slots.
    const slotRes = await client.query(
      `SELECT ts.*, t.max_group_size, t.price, t.status AS tour_status
       FROM tour_slot ts JOIN tour t ON t.id = ts.tour_id
       WHERE ts.id = $1 AND ts.property_id = $2
       FOR UPDATE OF ts FOR SHARE OF t`, [slot_id, req.property_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slotRes.rows[0].status !== 'active' || slotRes.rows[0].tour_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This slot is not available for booking' });
    }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

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
      `INSERT INTO tour_booking (property_id, slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, group_size, total_price.toFixed(2), notes ?? null]
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
  const { status, notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: current } = await client.query(
      'SELECT status, slot_id, group_size FROM tour_booking WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [req.params.id, req.property_id]
    );
    if (!current.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }

    // Reinstating a cancelled booking takes its seats back -- same locked
    // seat check as createBooking.
    if (current[0].status === 'cancelled' && status != null && status !== 'cancelled') {
      const { rows: [slot] } = await client.query(
        `SELECT t.max_group_size FROM tour_slot ts JOIN tour t ON t.id = ts.tour_id
         WHERE ts.id = $1 FOR UPDATE OF ts FOR SHARE OF t`, [current[0].slot_id]
      );
      const { rows: [{ booked }] } = await client.query(
        `SELECT COALESCE(SUM(group_size), 0)::int AS booked FROM tour_booking WHERE slot_id = $1 AND status != 'cancelled'`,
        [current[0].slot_id]
      );
      if (booked + current[0].group_size > slot.max_group_size) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Only ${Math.max(slot.max_group_size - booked, 0)} spots remaining` });
      }
    }

    const { rows } = await client.query(
      `UPDATE tour_booking SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
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

async function updateSlot(req, res, next) {
  try {
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ error: 'status is required' });
    }
    const { rows } = await pool.query(
      'UPDATE tour_slot SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *',
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Slot not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listTours, createTour, updateTour, deleteTour,
  bulkCreateSlots, searchSlots, updateSlot, deleteSlot,
  listBookings, createBooking, updateBooking,
};
