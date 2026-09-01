const pool = require('../db');
const { isValidDate, isValidTime, validateBranding, validateCancelUrl } = require('../middleware/validate');
const {
  publishNewAppointment,
  publishAppointmentStatusChanged,
  publishNewSpaBookingForProperty,
  publishSpaBookingStatusChangedForProperty,
  publishNewSpaBookingForSpa,
  publishSpaBookingStatusChangedForSpa,
  client: ablyClient,
} = require('../lib/ably');
const { sendAppointmentConfirmation, sendAppointmentCancellation } = require('../lib/resend');

// Steps a 'YYYY-MM-DD' string forward by whole days via UTC epoch math --
// `new Date(str); d.setDate(d.getDate() + 1)` looks equivalent but
// setDate() operates in the Node process's LOCAL timezone, so the date
// this actually produces depends on where the server happens to be
// running. This is deterministic regardless of process.env.TZ.
function addDaysUTC(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

// Same helper as restaurant.js's addMinutesToTime -- not shared between the
// two controllers, matching this file's existing preference for local
// self-contained helpers over a cross-controller util module.
function addMinutesToTime(timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
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
    const { name, description, phone, slot_interval_minutes, contact_email, address } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa (property_id, name, description, phone, slot_interval_minutes, contact_email, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, name, description ?? null, phone ?? null, slot_interval_minutes ?? 15, contact_email ?? null, address ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateSpa(req, res, next) {
  try {
    const { name, description, phone, status, slot_interval_minutes, contact_email, address } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa SET
         name                  = COALESCE($1, name),
         description           = COALESCE($2, description),
         phone                 = COALESCE($3, phone),
         status                = COALESCE($4, status),
         slot_interval_minutes = COALESCE($5, slot_interval_minutes),
         contact_email         = COALESCE($6, contact_email),
         address               = COALESCE($7, address)
       WHERE id = $8 AND property_id = $9 RETURNING *`,
      [name, description, phone, status, slot_interval_minutes, contact_email, address, req.params.id, req.property_id]
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
    const { name, status, clerk_user_id } = req.body;
    // clerk_user_id is genuinely nullable (unlinking a user), unlike
    // name/status -- COALESCE can't distinguish "not sent" from "clear it",
    // so it's only touched when the key is present in the body at all.
    const hasClerkUserId = Object.prototype.hasOwnProperty.call(req.body, 'clerk_user_id');
    const { rows } = await pool.query(
      `UPDATE spa_therapist SET
         name          = COALESCE($1, name),
         status        = COALESCE($2, status),
         clerk_user_id = CASE WHEN $3 THEN $4 ELSE clerk_user_id END
       WHERE id = $5 AND spa_id = $6 AND property_id = $7 RETURNING *`,
      [name, status, hasClerkUserId, clerk_user_id ?? null, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Therapist hours ──────────────────────────────────────────────────────────
// Weekly working hours per therapist, mirrors restaurant's service_period /
// setServicePeriods. Drives computed availability below; a therapist with no
// rows here has none (a slot-driven spa like Pirates Bight is fine to leave
// entirely without hours -- searchAvailability just returns nothing for it).

async function listTherapistHours(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const therapistRes = await pool.query(
      'SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3',
      [id, spa_id, req.property_id]
    );
    if (!therapistRes.rows.length) return res.status(404).json({ error: 'Therapist not found' });

    const { rows } = await pool.query(
      'SELECT id, day_of_week, start_time, end_time FROM spa_therapist_hours WHERE therapist_id = $1 ORDER BY day_of_week, start_time',
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

function hoursOverlap(a, b) {
  return a.start_time < b.end_time && b.start_time < a.end_time;
}

async function setTherapistHours(req, res, next) {
  const { spa_id, id } = req.params;
  const { hours } = req.body;

  if (!Array.isArray(hours)) {
    return res.status(400).json({ error: 'hours must be an array' });
  }
  for (const h of hours) {
    if (!Number.isInteger(h.day_of_week) || h.day_of_week < 1 || h.day_of_week > 7) {
      return res.status(400).json({ error: 'Each entry requires day_of_week between 1 (Mon) and 7 (Sun)' });
    }
    if (!h.start_time || !h.end_time || !isValidTime(h.start_time) || !isValidTime(h.end_time)) {
      return res.status(400).json({ error: 'Invalid time format, use HH:MM' });
    }
    if (h.start_time >= h.end_time) {
      return res.status(400).json({ error: "Each entry's start_time must be before its end_time" });
    }
  }
  // Overlapping windows on the same day would double-count candidate times
  // in searchSpaAvailability below.
  for (const day of new Set(hours.map((h) => h.day_of_week))) {
    const dayHours = hours.filter((h) => h.day_of_week === day);
    for (let i = 0; i < dayHours.length; i++) {
      for (let j = i + 1; j < dayHours.length; j++) {
        if (hoursOverlap(dayHours[i], dayHours[j])) {
          return res.status(400).json({ error: `Overlapping hours on day ${day}` });
        }
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const therapistRes = await client.query(
      'SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3',
      [id, spa_id, req.property_id]
    );
    if (!therapistRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Therapist not found' });
    }

    await client.query('DELETE FROM spa_therapist_hours WHERE therapist_id = $1', [id]);

    const inserted = [];
    for (const h of hours) {
      const { rows } = await client.query(
        `INSERT INTO spa_therapist_hours (property_id, therapist_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, day_of_week, start_time, end_time`,
        [req.property_id, id, h.day_of_week, h.start_time, h.end_time]
      );
      inserted.push(rows[0]);
    }

    await client.query('COMMIT');
    res.json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// ── Therapist time off ───────────────────────────────────────────────────────
// Whole-day closures per therapist. Partial-day blocks aren't a supported
// case here -- edit hours for that week, or book a placeholder appointment.

async function listTherapistTimeOff(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { from, to } = req.query;

    const therapistRes = await pool.query(
      'SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3',
      [id, spa_id, req.property_id]
    );
    if (!therapistRes.rows.length) return res.status(404).json({ error: 'Therapist not found' });

    let query = 'SELECT id, start_date, end_date, reason FROM spa_therapist_time_off WHERE therapist_id = $1';
    const params = [id];
    if (from) { params.push(from); query += ` AND end_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND start_date <= $${params.length}`; }
    query += ' ORDER BY start_date';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTherapistTimeOff(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { start_date, end_date, reason } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });
    if (!isValidDate(start_date) || !isValidDate(end_date)) return res.status(400).json({ error: 'Invalid date format' });
    if (start_date > end_date) return res.status(400).json({ error: 'start_date must be before or equal to end_date' });

    const therapistRes = await pool.query(
      'SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3',
      [id, spa_id, req.property_id]
    );
    if (!therapistRes.rows.length) return res.status(404).json({ error: 'Therapist not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_therapist_time_off (property_id, therapist_id, start_date, end_date, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, start_date, end_date, reason`,
      [req.property_id, id, start_date, end_date, reason ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function deleteTherapistTimeOff(req, res, next) {
  try {
    const { spa_id, id, offId } = req.params;
    const { rows } = await pool.query(
      `DELETE FROM spa_therapist_time_off tof
       USING spa_therapist st
       WHERE tof.therapist_id = st.id
         AND tof.id = $1
         AND st.id = $2
         AND st.spa_id = $3
         AND st.property_id = $4
       RETURNING tof.id`,
      [offId, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Time off not found' });
    res.status(204).end();
  } catch (err) { next(err); }
}

// ── Computed availability ────────────────────────────────────────────────────
// A spa is either hours-driven (has spa_therapist_hours rows) or slot-driven
// (Pirates Bight today); mixing the two on one therapist is unsupported and
// not validated against, matching how this project generally trusts
// staff-side configuration. Legacy spa_slot rows are not consulted here.

const MAX_AVAILABILITY_DAYS = 31;

// Shared core of GET /:spa_id/availability -- also called directly (no HTTP
// hop) by the AI reply pipeline's check_availability tool (see
// aiReplyTools.js), so the two paths can never drift apart on what
// "available" means. Caller is responsible for validating spa_id/
// treatment_id/therapist_id belong to the property first (searchSpaAvailability
// does this for the route; aiReplyTools.js does its own lookup).
async function findSpaAvailability(spaId, from, to, treatmentId, therapistId = null) {
    const { rows } = await pool.query(
      `WITH r AS (
         SELECT s.slot_interval_minutes, tr.duration_mins, p.timezone
         FROM spa s
         JOIN spa_treatment tr ON tr.id = $4
         JOIN property p ON p.id = s.property_id
         WHERE s.id = $1
       ),
       candidate_dates AS (
         SELECT gs::date AS avail_date FROM generate_series($2::date, $3::date, '1 day') AS gs
       ),
       candidate AS (
         SELECT
           cd.avail_date,
           t.id AS therapist_id,
           t.name AS therapist_name,
           generate_series(
             DATE '2000-01-01' + h.start_time,
             DATE '2000-01-01' + h.end_time - (r.duration_mins || ' minutes')::interval,
             (r.slot_interval_minutes || ' minutes')::interval
           )::time AS start_time
         FROM candidate_dates cd
         CROSS JOIN r
         JOIN spa_therapist_hours h ON h.day_of_week = EXTRACT(ISODOW FROM cd.avail_date)::int
         JOIN spa_therapist t ON t.id = h.therapist_id
         WHERE t.spa_id = $1
           AND t.status = 'active'
           AND ($5::uuid IS NULL OR t.id = $5)
           AND NOT EXISTS (
             SELECT 1 FROM spa_therapist_time_off tof
             WHERE tof.therapist_id = t.id AND cd.avail_date BETWEEN tof.start_date AND tof.end_date
           )
       )
       SELECT to_char(c.avail_date, 'YYYY-MM-DD') AS avail_date, c.start_time, c.therapist_id, c.therapist_name
       FROM candidate c
       CROSS JOIN r
       WHERE NOT EXISTS (
         SELECT 1 FROM spa_appointment sa
         WHERE sa.therapist_id = c.therapist_id
           AND sa.appointment_date = c.avail_date
           AND sa.status != 'cancelled'
           AND sa.start_time < c.start_time + (r.duration_mins || ' minutes')::interval
           AND sa.end_time   > c.start_time
       )
       AND (
         c.avail_date > (now() AT TIME ZONE r.timezone)::date
         OR c.start_time > (now() AT TIME ZONE r.timezone)::time
       )
       ORDER BY c.avail_date, c.start_time, c.therapist_name`,
      [spaId, from, to, treatmentId, therapistId]
    );

    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.avail_date)) byDate.set(row.avail_date, new Map());
      const slotsByTime = byDate.get(row.avail_date);
      const time = row.start_time.slice(0, 5);
      if (!slotsByTime.has(time)) slotsByTime.set(time, []);
      slotsByTime.get(time).push({ id: row.therapist_id, name: row.therapist_name });
    }

    return [...byDate.entries()].map(([date, slotsByTime]) => ({
      date,
      slots: [...slotsByTime.entries()].map(([time, therapists]) => ({ time, therapists })),
    }));
}

async function searchSpaAvailability(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { from, to, treatment_id, therapist_id } = req.query;

    if (!from || !to || !treatment_id) {
      return res.status(400).json({ error: 'from, to, and treatment_id are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });
    if (from > to) return res.status(400).json({ error: 'from must be before or equal to to' });
    if (addDaysUTC(from, MAX_AVAILABILITY_DAYS) < to) {
      return res.status(400).json({ error: `Range cannot exceed ${MAX_AVAILABILITY_DAYS} days` });
    }

    const treatmentRes = await pool.query(
      "SELECT duration_mins FROM spa_treatment WHERE id = $1 AND spa_id = $2 AND property_id = $3 AND status = 'active'",
      [treatment_id, spa_id, req.property_id]
    );
    if (!treatmentRes.rows.length) return res.status(404).json({ error: 'Treatment not found' });

    if (therapist_id) {
      const therapistRes = await pool.query(
        "SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3 AND status = 'active'",
        [therapist_id, spa_id, req.property_id]
      );
      if (!therapistRes.rows.length) return res.status(404).json({ error: 'Therapist not found' });
    }

    const result = await findSpaAvailability(spa_id, from, to, treatment_id, therapist_id ?? null);
    res.json(result);
  } catch (err) { next(err); }
}

// ── Slots (legacy, slot-based flow) ─────────────────────────────────────────

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

// Shapes a joined spa_appointment row (sa.* -- which now includes
// appointment_date/start_time/end_time directly -- plus therapist_name,
// treatment_name, duration_mins, price) into the LiveSpaBooking contract
// hotal-ui's feed expects. start_time is built as a plain
// 'YYYY-MM-DDTHH:MM:SS' string, deliberately not UTC-normalized -- neither
// column carries a timezone, so this is treated as the property's own local
// wall-clock time and the client renders it as-is (new Date() with no offset
// parses as the *viewer's* local time, so an unconverted string round-trips
// through toLocaleString unchanged).
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
    therapist_id: row.therapist_id,
    start_time: `${row.appointment_date instanceof Date ? row.appointment_date.toISOString().slice(0, 10) : row.appointment_date}T${row.start_time}`,
    duration_minutes: row.duration_mins,
    price: row.price,
    status: row.status,
    created_at: row.created_at,
  };
}

// Everything sendAppointmentConfirmation/sendAppointmentCancellation need,
// plus what toLiveSpaBooking needs -- one query so the post-commit Ably
// publish and confirmation/cancellation email never make redundant round
// trips. Not used by the list/get endpoints below, which stay lean (no
// spa/property fields) since nothing else needs them.
async function getFullAppointmentForEmail(appointmentId) {
  const { rows } = await pool.query(
    `SELECT sa.*,
            st.name AS therapist_name,
            tr.name AS treatment_name, tr.duration_mins, tr.price,
            s.contact_email AS spa_contact_email, s.address AS spa_address, s.phone AS spa_phone,
            p.name AS property_name, p.currency AS property_currency
     FROM spa_appointment sa
     JOIN spa_therapist st ON st.id = sa.therapist_id
     JOIN spa_treatment tr ON tr.id = sa.treatment_id
     JOIN spa s ON s.id = st.spa_id
     JOIN property p ON p.id = sa.property_id
     WHERE sa.id = $1`,
    [appointmentId]
  );
  return rows[0] || null;
}

// Fire-and-forget publish + (optional) email after a commit, shared by
// createAppointment and updateAppointment's cancellation path. Never throws
// -- every failure is caught and logged, matching the existing Ably
// .catch() convention in this file.
async function publishAndEmailAfterCreate(spaId, propertyId, appointmentId, rawInsertedRow, branding, cancelUrl) {
  publishNewAppointment(spaId, rawInsertedRow).catch((err) => console.error('Ably publish failed:', err.message));

  const full = await getFullAppointmentForEmail(appointmentId).catch((err) => {
    console.error('Failed to load full appointment for Ably/email:', err.message);
    return null;
  });
  if (!full) return;

  publishNewSpaBookingForProperty(propertyId, toLiveSpaBooking(full))
    .catch((err) => console.error('Ably publish failed:', err.message));
  publishNewSpaBookingForSpa(spaId, toLiveSpaBooking(full))
    .catch((err) => console.error('Ably publish failed:', err.message));

  if (full.contact_email) {
    // A literal `{id}` in cancel_url resolves to the new appointment's id
    // here -- the caller can't know it when supplying the URL (this email
    // sends during creation), and the unguessable UUID lets the link work
    // for guests with no account.
    const resolvedCancelUrl = cancelUrl ? cancelUrl.replace('{id}', appointmentId) : cancelUrl;
    sendAppointmentConfirmation(full, full.property_name, branding, resolvedCancelUrl)
      .then((emailId) => pool.query('UPDATE spa_appointment SET confirmation_resend_email_id = $1 WHERE id = $2', [emailId, appointmentId]))
      .catch((err) => console.error('Confirmation email failed:', err.message));
  }
}

async function listAppointmentsForProperty(req, res, next) {
  try {
    const { cursor, limit, spa_id, therapist_id } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `
      SELECT sa.*, st.name AS therapist_name, tr.name AS treatment_name, tr.duration_mins, tr.price
      FROM spa_appointment sa
      JOIN spa_therapist st ON st.id = sa.therapist_id
      JOIN spa_treatment tr ON tr.id = sa.treatment_id
      WHERE sa.property_id = $1
    `;
    const params = [req.property_id];
    // Optional -- the spa dashboard's own feed scopes to one spa; the
    // property dashboard omits this to show bookings across every spa.
    if (spa_id) { params.push(spa_id); query += ` AND st.spa_id = $${params.length}`; }
    // Optional -- a therapist linked to their own login sees just their own
    // appointments on the spa dashboard.
    if (therapist_id) { params.push(therapist_id); query += ` AND sa.therapist_id = $${params.length}`; }
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
    const { date, status, guest_id, clerk_user_id, therapist_id } = req.query;
    let query = `
      SELECT sa.*, st.name AS therapist_name, tr.name AS treatment_name, tr.price
      FROM spa_appointment sa
      JOIN spa_therapist st ON st.id = sa.therapist_id
      JOIN spa_treatment tr ON tr.id = sa.treatment_id
      WHERE st.spa_id = $1 AND sa.property_id = $2
    `;
    const params = [spa_id, req.property_id];
    if (date) { params.push(date); query += ` AND sa.appointment_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND sa.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND sa.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND sa.clerk_user_id = $${params.length}`; }
    if (therapist_id) { params.push(therapist_id); query += ` AND sa.therapist_id = $${params.length}`; }
    query += ' ORDER BY sa.appointment_date, sa.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// Subscribe-only token for the app's live schedule -- mirrors
// restaurantOrders.getAblyToken. The channel is the one
// publishNewAppointment / publishAppointmentStatusChanged already use.
async function getSpaAblyToken(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { rows } = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    if (!ablyClient) return res.status(503).json({ error: 'Realtime notifications are not configured' });

    const channel = `spa:${spa_id}:appointments`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}

async function getAppointment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { rows } = await pool.query(
      `SELECT sa.*, st.name AS therapist_name, tr.name AS treatment_name, tr.price
       FROM spa_appointment sa
       JOIN spa_therapist st ON st.id = sa.therapist_id
       JOIN spa_treatment tr ON tr.id = sa.treatment_id
       WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
      [id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// Legacy path: booking against a pre-generated spa_slot row. Unchanged
// beyond also populating the five direct columns from the slot, so every
// appointment -- slot-based or computed -- has them.
async function createAppointmentFromSlot(req, res, next) {
  const { spa_id } = req.params;
  const { slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, branding, cancel_url } = req.body;

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
    const slot = slotRes.rows[0];
    if (slot.status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is not available' }); }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

    const conflictRes = await client.query(
      `SELECT id FROM spa_appointment WHERE slot_id = $1 AND status != 'cancelled'`, [slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot already booked' }); }

    const treatmentRes = await client.query('SELECT duration_mins FROM spa_treatment WHERE id = $1', [slot.treatment_id]);
    const endTime = addMinutesToTime(slot.slot_time, treatmentRes.rows[0].duration_mins);

    const { rows } = await client.query(
      `INSERT INTO spa_appointment
         (property_id, slot_id, treatment_id, therapist_id, appointment_date, start_time, end_time,
          guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        req.property_id, slot_id, slot.treatment_id, slot.therapist_id, slot.slot_date, slot.slot_time, endTime,
        guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null,
      ]
    );

    await client.query('COMMIT');
    await publishAndEmailAfterCreate(spa_id, req.property_id, rows[0].id, rows[0], branding, cancel_url);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// Checks whether therapistId is bookable for a treatment of durationMins
// starting at date/time: within a working-hours window, not on a time-off
// day, has no overlapping non-cancelled appointment, and isn't already in
// the past in the property's own timezone. Called inside the same
// transaction/connection that will lock the therapist row, so this read is
// consistent with that lock.
async function isTherapistFree(client, therapistId, date, time, durationMins, timezone) {
  const { rows } = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM spa_therapist_hours h
         WHERE h.therapist_id = $1
           AND h.day_of_week = EXTRACT(ISODOW FROM $2::date)::int
           AND h.start_time <= $3::time
           AND h.end_time   >= $3::time + ($4 || ' minutes')::interval
       ) AS within_hours,
       EXISTS (
         SELECT 1 FROM spa_therapist_time_off t
         WHERE t.therapist_id = $1 AND $2::date BETWEEN t.start_date AND t.end_date
       ) AS has_time_off,
       EXISTS (
         SELECT 1 FROM spa_appointment sa
         WHERE sa.therapist_id = $1
           AND sa.appointment_date = $2::date
           AND sa.status != 'cancelled'
           AND sa.start_time < $3::time + ($4 || ' minutes')::interval
           AND sa.end_time   > $3::time
       ) AS has_overlap,
       (
         $2::date < (now() AT TIME ZONE $5)::date
         OR ($2::date = (now() AT TIME ZONE $5)::date AND $3::time <= (now() AT TIME ZONE $5)::time)
       ) AS is_past`,
    [therapistId, date, time, durationMins, timezone]
  );
  const r = rows[0];
  return r.within_hours && !r.has_time_off && !r.has_overlap && !r.is_past;
}

// Core of the computed-availability booking path, shared by the HTTP handler
// below and the AI reply pipeline (booking-on-approval). Books against
// working hours rather than a pre-generated slot. therapist_id is optional --
// when omitted, picks the free therapist with the lowest name (deterministic,
// no cleverness). Returns { ok: true, appointment } or { ok: false, code }
// with code one of 'treatment_not_found' | 'guest_not_found' |
// 'therapist_not_found' | 'unavailable'.
async function bookFromAvailability({ property_id, spa_id, treatment_id, therapist_id = null, date, time, guest_id = null, clerk_user_id = null, contact_name, contact_email = null, contact_phone = null, notes = null, branding, cancel_url }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const treatmentRes = await client.query(
      "SELECT id, duration_mins FROM spa_treatment WHERE id = $1 AND spa_id = $2 AND property_id = $3 AND status = 'active'",
      [treatment_id, spa_id, property_id]
    );
    if (!treatmentRes.rows.length) { await client.query('ROLLBACK'); return { ok: false, code: 'treatment_not_found' }; }
    const durationMins = treatmentRes.rows[0].duration_mins;

    const propertyRes = await client.query(
      `SELECT p.timezone FROM property p JOIN spa s ON s.property_id = p.id WHERE s.id = $1`,
      [spa_id]
    );
    const timezone = propertyRes.rows[0].timezone;

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return { ok: false, code: 'guest_not_found' }; }
    }

    let chosenTherapistId = null;
    if (therapist_id) {
      // FOR UPDATE serialises concurrent bookings for this barber -- the
      // same role the UNIQUE constraint on spa_slot played for the legacy
      // flow.
      const tRes = await client.query(
        "SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3 AND status = 'active' FOR UPDATE",
        [therapist_id, spa_id, property_id]
      );
      if (!tRes.rows.length) { await client.query('ROLLBACK'); return { ok: false, code: 'therapist_not_found' }; }
      if (await isTherapistFree(client, therapist_id, date, time, durationMins, timezone)) {
        chosenTherapistId = therapist_id;
      }
    } else {
      const allRes = await client.query(
        "SELECT id FROM spa_therapist WHERE spa_id = $1 AND property_id = $2 AND status = 'active' ORDER BY name FOR UPDATE",
        [spa_id, property_id]
      );
      for (const t of allRes.rows) {
        if (await isTherapistFree(client, t.id, date, time, durationMins, timezone)) {
          chosenTherapistId = t.id;
          break;
        }
      }
    }

    if (!chosenTherapistId) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'unavailable' };
    }

    const endTime = addMinutesToTime(time, durationMins);
    const { rows } = await client.query(
      `INSERT INTO spa_appointment
         (property_id, treatment_id, therapist_id, appointment_date, start_time, end_time,
          guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        property_id, treatment_id, chosenTherapistId, date, time, endTime,
        guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null,
      ]
    );

    await client.query('COMMIT');
    await publishAndEmailAfterCreate(spa_id, property_id, rows[0].id, rows[0], branding, cancel_url);
    return { ok: true, appointment: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const BOOK_FAILURE_HTTP = {
  treatment_not_found: [404, 'Treatment not found'],
  guest_not_found: [404, 'Guest not found'],
  therapist_not_found: [404, 'Therapist not found'],
  unavailable: [409, 'Time is not available'],
};

async function createAppointmentFromAvailability(req, res, next) {
  const { spa_id } = req.params;
  const { treatment_id, therapist_id, date, time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, branding, cancel_url } = req.body;

  if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });
  if (!isValidTime(time)) return res.status(400).json({ error: 'Invalid time format, use HH:MM' });

  try {
    const result = await bookFromAvailability({
      property_id: req.property_id, spa_id, treatment_id, therapist_id, date, time,
      guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, branding, cancel_url,
    });
    if (!result.ok) {
      const [status, error] = BOOK_FAILURE_HTTP[result.code];
      return res.status(status).json({ error });
    }
    res.status(201).json(result.appointment);
  } catch (err) {
    next(err);
  }
}

async function createAppointment(req, res, next) {
  const { slot_id, treatment_id, date, time, contact_name, branding, cancel_url } = req.body;

  if (slot_id && treatment_id) {
    return res.status(400).json({ error: 'Provide either slot_id or treatment_id, not both' });
  }
  if (!contact_name) return res.status(400).json({ error: 'contact_name is required' });

  const brandingError = validateBranding(branding);
  if (brandingError) return res.status(400).json({ error: brandingError });

  const cancelUrlError = validateCancelUrl(cancel_url);
  if (cancelUrlError) return res.status(400).json({ error: cancelUrlError });

  if (slot_id) return createAppointmentFromSlot(req, res, next);

  if (!treatment_id || !date || !time) {
    return res.status(400).json({ error: 'treatment_id, date, and time are required (or slot_id for the legacy flow)' });
  }
  return createAppointmentFromAvailability(req, res, next);
}

async function updateAppointment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { status, notes, branding } = req.body;

    const brandingError = validateBranding(branding);
    if (brandingError) return res.status(400).json({ error: brandingError });

    const beforeRes = await pool.query(
      `SELECT sa.status FROM spa_appointment sa
       JOIN spa_therapist st ON st.id = sa.therapist_id
       WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
      [id, spa_id, req.property_id]
    );
    if (!beforeRes.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    const statusBefore = beforeRes.rows[0].status;

    const { rows } = await pool.query(
      `UPDATE spa_appointment sa SET
         status = COALESCE($1, sa.status),
         notes  = COALESCE($2, sa.notes)
       FROM spa_therapist st
       WHERE sa.therapist_id = st.id
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
      const full = await getFullAppointmentForEmail(rows[0].id).catch((err) => {
        console.error('Failed to load full appointment for Ably/email:', err.message);
        return null;
      });
      if (full) {
        publishSpaBookingStatusChangedForProperty(req.property_id, toLiveSpaBooking(full))
          .catch((err) => console.error('Ably publish failed:', err.message));
        publishSpaBookingStatusChangedForSpa(spa_id, toLiveSpaBooking(full))
          .catch((err) => console.error('Ably publish failed:', err.message));

        if (rows[0].status === 'cancelled' && full.contact_email) {
          sendAppointmentCancellation(full, full.property_name, branding)
            .catch((err) => console.error('Cancellation email failed:', err.message));
        }
      }
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listSpas, getSpa, createSpa, updateSpa,
  listTreatments, createTreatment, updateTreatment,
  listTherapists, createTherapist, updateTherapist,
  listTherapistHours, setTherapistHours,
  listTherapistTimeOff, createTherapistTimeOff, deleteTherapistTimeOff,
  searchSpaAvailability,
  findSpaAvailability,
  bookFromAvailability,
  listSlots, bulkCreateSlots, searchSlots, updateSlot,
  listAppointments, getAppointment, createAppointment, updateAppointment,
  getSpaAblyToken,
  listAppointmentsForProperty,
};
