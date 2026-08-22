const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const {
  publishNewAppointment,
  publishAppointmentStatusChanged,
  publishNewSpaBookingForProperty,
  publishSpaBookingStatusChangedForProperty,
} = require('../lib/ably');

// Steps a 'YYYY-MM-DD' string forward by whole days via UTC epoch math --
// `new Date(str); d.setDate(d.getDate() + 1)` looks equivalent but
// setDate() operates in the Node process's LOCAL timezone, so the date
// this actually produces depends on where the server happens to be
// running. This is deterministic regardless of process.env.TZ.
function addDaysUTC(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

// ── Spas ──────────────────────────────────────────────────────────────────────

async function listSpas(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa WHERE status = 'active' AND property_id = $1 ORDER BY name",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function getSpa(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa WHERE id = $1 AND property_id = $2', [req.params.id, req.property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createSpa(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa (property_id, name, description, phone) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.property_id, name, description ?? null, phone ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateSpa(req, res, next) {
  try {
    const { name, description, phone, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         phone       = COALESCE($3, phone),
         status      = COALESCE($4, status)
       WHERE id = $5 AND property_id = $6 RETURNING *`,
      [name, description, phone, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Treatments ────────────────────────────────────────────────────────────────

async function listTreatments(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_treatment WHERE spa_id = $1 AND property_id = $2 AND status = 'active' ORDER BY name",
      [req.params.spa_id, req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTreatment(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name, description, duration_mins, price } = req.body;
    if (!name || duration_mins == null || price == null) {
      return res.status(400).json({ error: 'name, duration_mins, and price are required' });
    }

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_treatment (property_id, spa_id, name, description, duration_mins, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, spa_id, name, description ?? null, duration_mins, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTreatment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, description, duration_mins, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_treatment SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         duration_mins = COALESCE($3, duration_mins),
         price         = COALESCE($4, price),
         status        = COALESCE($5, status)
       WHERE id = $6 AND spa_id = $7 AND property_id = $8 RETURNING *`,
      [name, description, duration_mins, price, status, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Treatment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Therapists ────────────────────────────────────────────────────────────────

async function listTherapists(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_therapist WHERE spa_id = $1 AND property_id = $2 AND status = 'active' ORDER BY name",
      [req.params.spa_id, req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTherapist(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, $3) RETURNING *`, [req.property_id, spa_id, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTherapist(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_therapist SET
         name   = COALESCE($1, name),
         status = COALESCE($2, status)
       WHERE id = $3 AND spa_id = $4 AND property_id = $5 RETURNING *`,
      [name, status, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Slots ─────────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, from, to, therapist_id, treatment_id } = req.query;
    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1 AND ss.property_id = $2
    `;
    const params = [spa_id, req.property_id];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (from) { params.push(from); query += ` AND ss.slot_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND ss.slot_date <= $${params.length}`; }
    if (therapist_id) { params.push(therapist_id); query += ` AND ss.therapist_id = $${params.length}`; }
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function bulkCreateSlots(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { therapist_id, treatment_id, from, to, times } = req.body;
    if (!therapist_id || !treatment_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'therapist_id, treatment_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

    const therapistRes = await pool.query('SELECT spa_id FROM spa_therapist WHERE id = $1', [therapist_id]);
    if (!therapistRes.rows.length || therapistRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'therapist_id does not belong to this spa' });
    }
    const treatmentRes = await pool.query('SELECT spa_id FROM spa_treatment WHERE id = $1', [treatment_id]);
    if (!treatmentRes.rows.length || treatmentRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'treatment_id does not belong to this spa' });
    }

    const created = [];
    let date = from;
    while (date <= to) {
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO spa_slot (property_id, therapist_id, treatment_id, slot_date, slot_time)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (therapist_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [req.property_id, therapist_id, treatment_id, date, time]
        );
        if (rows.length) created.push(rows[0]);
      }
      date = addDaysUTC(date, 1);
    }
    res.status(201).json({ created: created.length, slots: created });
  } catch (err) { next(err); }
}

async function searchSlots(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, treatment_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
        AND ss.property_id = $2
        AND ss.slot_date = $3
        AND ss.status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM spa_appointment sa
          WHERE sa.slot_id = ss.id AND sa.status != 'cancelled'
        )
    `;
    const params = [spa_id, req.property_id, date];
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_time, st.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function updateSlot(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ error: 'status is required' });
    }
    const { rows } = await pool.query(
      `UPDATE spa_slot ss SET status = $1
       FROM spa_therapist st
       WHERE ss.therapist_id = st.id
         AND ss.id = $2
         AND st.spa_id = $3
         AND ss.property_id = $4
       RETURNING ss.*`,
      [status, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Slot not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Appointments ──────────────────────────────────────────────────────────────

// spa_appointment stores one 'contact_name' field (same convention as golf/
// equipment/beach-club/tours bookings) -- but @forgebuild/hotal-ui's
// <live-spa-bookings-feed> expects split first_name/last_name (modeled on
// the guest table shape used by room bookings). Split on the first space
// rather than adding a name column just to satisfy this one feed.
function splitContactName(name) {
  const trimmed = (name || '').trim();
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx === -1
    ? { first_name: trimmed, last_name: '' }
    : { first_name: trimmed.slice(0, spaceIdx), last_name: trimmed.slice(spaceIdx + 1) };
}

// Shapes a joined spa_appointment row (sa.*, ss.slot_date, ss.slot_time,
// st.name AS therapist_name, tr.name AS treatment_name, tr.duration_mins,
// tr.price) into the LiveSpaBooking contract hotal-ui's feed expects.
// start_time is built as a plain 'YYYY-MM-DDTHH:MM:SS' string, deliberately
// not UTC-normalized -- slots have no stored timezone, so this is treated as
// the property's own local wall-clock time and the client renders it as-is
// (new Date() with no offset parses as the *viewer's* local time, so an
// unconverted string round-trips through toLocaleString unchanged).
function toLiveSpaBooking(row) {
  const { first_name, last_name } = splitContactName(row.contact_name);
  return {
    id: row.id,
    first_name,
    last_name,
    email: row.contact_email,
    phone: row.contact_phone,
    treatment_name: row.treatment_name,
    therapist_name: row.therapist_name,
    start_time: `${row.slot_date instanceof Date ? row.slot_date.toISOString().slice(0, 10) : row.slot_date}T${row.slot_time}`,
    duration_minutes: row.duration_mins,
    price: row.price,
    status: row.status,
    created_at: row.created_at,
  };
}

async function listAppointmentsForProperty(req, res, next) {
  try {
    const { cursor, limit } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `
      SELECT sa.*, ss.slot_date, ss.slot_time,
             st.name AS therapist_name, tr.name AS treatment_name, tr.duration_mins, tr.price
      FROM spa_appointment sa
      JOIN spa_slot ss ON ss.id = sa.slot_id
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE sa.property_id = $1
    `;
    const params = [req.property_id];
    if (cursor) { params.push(cursor); query += ` AND sa.created_at < $${params.length}`; }
    params.push(take);
    query += ` ORDER BY sa.created_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(query, params);
    res.json(rows.map(toLiveSpaBooking));
  } catch (err) { next(err); }
}

async function listAppointments(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, status, guest_id, clerk_user_id } = req.query;
    let query = `
      SELECT sa.*, ss.slot_date, ss.slot_time,
             st.name AS therapist_name, tr.name AS treatment_name, tr.price
      FROM spa_appointment sa
      JOIN spa_slot ss ON ss.id = sa.slot_id
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1 AND sa.property_id = $2
    `;
    const params = [spa_id, req.property_id];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND sa.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND sa.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND sa.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getAppointment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { rows } = await pool.query(
      `SELECT sa.*, ss.slot_date, ss.slot_time,
              st.name AS therapist_name, tr.name AS treatment_name, tr.price
       FROM spa_appointment sa
       JOIN spa_slot ss ON ss.id = sa.slot_id
       JOIN spa_therapist st ON st.id = ss.therapist_id
       JOIN spa_treatment tr ON tr.id = ss.treatment_id
       WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
      [id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createAppointment(req, res, next) {
  const { spa_id } = req.params;
  const { slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!slot_id || !contact_name) return res.status(400).json({ error: 'slot_id and contact_name are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ss.* FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE ss.id = $1 AND st.spa_id = $2 AND ss.property_id = $3`,
      [slot_id, spa_id, req.property_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slotRes.rows[0].status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is not available' }); }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

    const conflictRes = await client.query(
      `SELECT id FROM spa_appointment WHERE slot_id = $1 AND status != 'cancelled'`, [slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot already booked' }); }

    const { rows } = await client.query(
      `INSERT INTO spa_appointment (property_id, slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.property_id, slot_id, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null]
    );

    await client.query('COMMIT');

    publishNewAppointment(spa_id, rows[0]).catch((err) => console.error('Ably publish failed:', err.message));

    const { rows: full } = await pool.query(
      `SELECT sa.*, ss.slot_date, ss.slot_time,
              st.name AS therapist_name, tr.name AS treatment_name, tr.duration_mins, tr.price
       FROM spa_appointment sa
       JOIN spa_slot ss ON ss.id = sa.slot_id
       JOIN spa_therapist st ON st.id = ss.therapist_id
       JOIN spa_treatment tr ON tr.id = ss.treatment_id
       WHERE sa.id = $1`,
      [rows[0].id]
    );
    if (full.length) {
      publishNewSpaBookingForProperty(req.property_id, toLiveSpaBooking(full[0]))
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

async function updateAppointment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { status, notes } = req.body;

    const beforeRes = await pool.query(
      `SELECT sa.status FROM spa_appointment sa
       JOIN spa_slot ss ON ss.id = sa.slot_id
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
      [id, spa_id, req.property_id]
    );
    if (!beforeRes.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    const statusBefore = beforeRes.rows[0].status;

    const { rows } = await pool.query(
      `UPDATE spa_appointment sa SET
         status = COALESCE($1, sa.status),
         notes  = COALESCE($2, sa.notes)
       FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE sa.slot_id = ss.id
         AND sa.id = $3
         AND st.spa_id = $4
         AND sa.property_id = $5
       RETURNING sa.*`,
      [status, notes, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });

    if (rows[0].status !== statusBefore) {
      publishAppointmentStatusChanged(spa_id, { id: rows[0].id, status: rows[0].status, spa_id })
        .catch((err) => console.error('Ably publish failed:', err.message));

      // live-spa-bookings-feed's upsert replaces the whole list item for an
      // id on every event (same as live-dining-orders-feed) -- a bare
      // {id, status} patch would blank out treatment/therapist/price/etc.
      // on every status change, so re-fetch the joined shape first.
      const { rows: full } = await pool.query(
        `SELECT sa.*, ss.slot_date, ss.slot_time,
                st.name AS therapist_name, tr.name AS treatment_name, tr.duration_mins, tr.price
         FROM spa_appointment sa
         JOIN spa_slot ss ON ss.id = sa.slot_id
         JOIN spa_therapist st ON st.id = ss.therapist_id
         JOIN spa_treatment tr ON tr.id = ss.treatment_id
         WHERE sa.id = $1`,
        [rows[0].id]
      );
      if (full.length) {
        publishSpaBookingStatusChangedForProperty(req.property_id, toLiveSpaBooking(full[0]))
          .catch((err) => console.error('Ably publish failed:', err.message));
      }
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listSpas, getSpa, createSpa, updateSpa,
  listTreatments, createTreatment, updateTreatment,
  listTherapists, createTherapist, updateTherapist,
  listSlots, bulkCreateSlots, searchSlots, updateSlot,
  listAppointments, getAppointment, createAppointment, updateAppointment,
  listAppointmentsForProperty,
};
