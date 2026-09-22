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
const { sendAppointmentConfirmation, sendAppointmentCancellation, escapeHtml } = require('../lib/resend');
const { memberRateUntil, resolveRate } = require('../lib/spaMemberRate');

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

// spa_treatment.days_of_week: ISO day-of-week (1 = Mon .. 7 = Sun) for the
// days a treatment is offered, NULL meaning every day. Returns the cleaned
// array, null, or an error string -- the DB CHECK is the backstop, this is
// only so a bad body gets a 400 with a sentence in it rather than a
// constraint violation. An empty array is rejected on purpose: a treatment
// offered on no day at all is a delete (status = 'inactive'), not a schedule.
function normalizeDaysOfWeek(value) {
  if (value == null) return { value: null };
  if (!Array.isArray(value) || !value.length) {
    return { error: 'days_of_week must be a non-empty array of 1-7 (Mon-Sun), or null for every day' };
  }
  const days = [...new Set(value.map(Number))].sort((a, b) => a - b);
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    return { error: 'days_of_week values must be integers 1-7 (1 = Monday)' };
  }
  // All seven days is the same offer as no restriction -- stored as NULL so
  // there is one representation of "every day" for readers to handle.
  return { value: days.length === 7 ? null : days };
}

// Is a 'YYYY-MM-DD' date one of a treatment's days_of_week? UTC epoch math
// for the same reason as addDaysUTC -- getDay() would read the date in the
// server process's local timezone. Postgres does this inline via
// EXTRACT(ISODOW ...) in findSpaAvailability; this is the JS equivalent for
// the booking paths.
function isOfferedOn(daysOfWeek, dateStr) {
  if (!daysOfWeek || !daysOfWeek.length) return true;
  const [y, m, d] = dateStr.split('-').map(Number);
  const sundayFirst = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return daysOfWeek.includes(sundayFirst === 0 ? 7 : sundayFirst);
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
    const { name, description, duration_mins, price, member_price, member_duration_mins } = req.body;
    // price may be null for a regulars-only treatment, as long as it has a
    // member_price -- see lib/spaMemberRate.js.
    if (!name || duration_mins == null || (price == null && member_price == null)) {
      return res.status(400).json({ error: 'name, duration_mins, and price (or member_price) are required' });
    }
    const days = normalizeDaysOfWeek(req.body.days_of_week);
    if (days.error) return res.status(400).json({ error: days.error });

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_treatment (property_id, spa_id, name, description, duration_mins, price, member_price, member_duration_mins, days_of_week)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, spa_id, name, description ?? null, duration_mins, price ?? null, member_price ?? null, member_duration_mins ?? null, days.value]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.constraint === 'spa_treatment_has_price') return res.status(400).json({ error: 'A treatment needs a price or a member_price' });
    next(err);
  }
}

async function updateTreatment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, description, duration_mins, status } = req.body;
    // The three price fields are genuinely clearable (null = "no regulars'
    // rate", "same duration", "regulars only"), so COALESCE can't express
    // them -- present-in-body decides, same as updateTherapist's
    // clerk_user_id.
    const has = (key) => Object.prototype.hasOwnProperty.call(req.body, key);
    // days_of_week is clearable the same way (null = offered every day).
    const days = normalizeDaysOfWeek(req.body.days_of_week);
    if (days.error) return res.status(400).json({ error: days.error });
    const { rows } = await pool.query(
      `UPDATE spa_treatment SET
         name                 = COALESCE($1, name),
         description          = COALESCE($2, description),
         duration_mins        = COALESCE($3, duration_mins),
         price                = CASE WHEN $4 THEN $5::numeric ELSE price END,
         status               = COALESCE($6, status),
         member_price         = CASE WHEN $7 THEN $8::numeric ELSE member_price END,
         member_duration_mins = CASE WHEN $9 THEN $10::int ELSE member_duration_mins END,
         days_of_week         = CASE WHEN $11 THEN $12::int[] ELSE days_of_week END
       WHERE id = $13 AND spa_id = $14 AND property_id = $15 RETURNING *`,
      [
        name, description, duration_mins,
        has('price'), req.body.price ?? null,
        status,
        has('member_price'), req.body.member_price ?? null,
        has('member_duration_mins'), req.body.member_duration_mins ?? null,
        has('days_of_week'), days.value,
        id, spa_id, req.property_id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Treatment not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.constraint === 'spa_treatment_has_price') return res.status(400).json({ error: 'A treatment needs a price or a member_price' });
    next(err);
  }
}

// GET ?email= -- the last appointment date that email gets the regulars'
// rate for ({ member_until: 'YYYY-MM-DD' | null }). Property-wide (a visit
// to any of the property's spas counts); spa_id only scopes the route.
// Callers pass an email they've verified themselves -- see
// lib/spaMemberRate.js.
async function getMemberRate(req, res, next) {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [req.params.spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json({ member_until: await memberRateUntil(pool, req.property_id, email) });
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

    let query = 'SELECT id, start_date, end_date, start_time, end_time, reason FROM spa_therapist_time_off WHERE therapist_id = $1';
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
    const { start_date, end_date, start_time, end_time, reason } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });
    if (!isValidDate(start_date) || !isValidDate(end_date)) return res.status(400).json({ error: 'Invalid date format' });
    if (start_date > end_date) return res.status(400).json({ error: 'start_date must be before or equal to end_date' });
    // Both given (a specific window each day in the range) or neither (the
    // whole day) -- never one without the other, matching the table's own
    // CHECK constraint, but rejected here with a real error instead of a
    // raw constraint-violation 500.
    if (!!start_time !== !!end_time) return res.status(400).json({ error: 'start_time and end_time must be given together' });
    if (start_time && (!isValidTime(start_time) || !isValidTime(end_time))) return res.status(400).json({ error: 'Invalid time format, use HH:MM' });
    if (start_time && start_time >= end_time) return res.status(400).json({ error: 'start_time must be before end_time' });

    const therapistRes = await pool.query(
      'SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3',
      [id, spa_id, req.property_id]
    );
    if (!therapistRes.rows.length) return res.status(404).json({ error: 'Therapist not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_therapist_time_off (property_id, therapist_id, start_date, end_date, start_time, end_time, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, start_date, end_date, start_time, end_time, reason`,
      [req.property_id, id, start_date, end_date, start_time || null, end_time || null, reason ?? null]
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
//
// memberUntil (from lib/spaMemberRate.js's memberRateUntil, or null) picks
// the duration per date: dates it covers use the treatment's
// member_duration_mins when it has a regulars' rate, others the standard
// duration -- and a regulars-only treatment (price NULL) has no availability
// at all on dates it doesn't cover.
async function findSpaAvailability(spaId, from, to, treatmentId, therapistId = null, memberUntil = null) {
    const { rows } = await pool.query(
      `WITH r AS (
         SELECT s.slot_interval_minutes, tr.duration_mins, tr.price, tr.member_price, tr.member_duration_mins, tr.days_of_week, p.timezone
         FROM spa s
         JOIN spa_treatment tr ON tr.id = $4
         JOIN property p ON p.id = s.property_id
         WHERE s.id = $1
       ),
       candidate_dates AS (
         SELECT d.avail_date,
                CASE WHEN d.member THEN COALESCE(r.member_duration_mins, r.duration_mins) ELSE r.duration_mins END AS duration_mins
         FROM (
           SELECT gs::date AS avail_date, (r.member_price IS NOT NULL AND gs::date <= $6::date) AS member
           FROM generate_series($2::date, $3::date, '1 day') AS gs
           CROSS JOIN r
         ) d
         CROSS JOIN r
         WHERE (d.member OR r.price IS NOT NULL)
           -- Days the treatment itself is offered on; NULL = every day.
           AND (r.days_of_week IS NULL OR EXTRACT(ISODOW FROM d.avail_date)::int = ANY(r.days_of_week))
       ),
       candidate AS (
         SELECT
           cd.avail_date,
           cd.duration_mins,
           t.id AS therapist_id,
           t.name AS therapist_name,
           generate_series(
             DATE '2000-01-01' + h.start_time,
             DATE '2000-01-01' + h.end_time - (cd.duration_mins || ' minutes')::interval,
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
             -- Whole-day rows only (start_time IS NULL) -- a partial-day row
             -- doesn't rule the therapist out of the date entirely, it just
             -- blocks its own window, checked per-candidate-time below.
             SELECT 1 FROM spa_therapist_time_off tof
             WHERE tof.therapist_id = t.id AND cd.avail_date BETWEEN tof.start_date AND tof.end_date
               AND tof.start_time IS NULL
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
           AND sa.start_time < c.start_time + (c.duration_mins || ' minutes')::interval
           AND sa.end_time   > c.start_time
       )
       AND NOT EXISTS (
         SELECT 1 FROM spa_therapist_time_off tof
         WHERE tof.therapist_id = c.therapist_id
           AND c.avail_date BETWEEN tof.start_date AND tof.end_date
           AND tof.start_time IS NOT NULL
           AND tof.start_time < c.start_time + (c.duration_mins || ' minutes')::interval
           AND tof.end_time   > c.start_time
       )
       AND (
         c.avail_date > (now() AT TIME ZONE r.timezone)::date
         OR c.start_time > (now() AT TIME ZONE r.timezone)::time
       )
       ORDER BY c.avail_date, c.start_time, c.therapist_name`,
      [spaId, from, to, treatmentId, therapistId, memberUntil]
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
    // member_email: an email the caller has verified, whose regulars' rate
    // (if any) sets the duration per date -- see findSpaAvailability.
    const { from, to, treatment_id, therapist_id, member_email } = req.query;

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

    const memberUntil = await memberRateUntil(pool, req.property_id, member_email);
    const result = await findSpaAvailability(spa_id, from, to, treatment_id, therapist_id ?? null, memberUntil);
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
    const treatmentRes = await pool.query('SELECT spa_id, days_of_week FROM spa_treatment WHERE id = $1', [treatment_id]);
    if (!treatmentRes.rows.length || treatmentRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'treatment_id does not belong to this spa' });
    }
    const daysOfWeek = treatmentRes.rows[0].days_of_week;

    const created = [];
    let date = from;
    while (date <= to) {
      // Days the treatment isn't offered on get no slots generated for them.
      if (!isOfferedOn(daysOfWeek, date)) { date = addDaysUTC(date, 1); continue; }
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
    // Only present when the caller's query selected st.spa_id (currently
    // just listAppointmentsForProperty) -- the property dashboard's
    // aggregated feed needs it to know which spa's PUT endpoint to hit for
    // a booking that could belong to any of them; the spa dashboard's own
    // feed already knows its spa_id from the page itself.
    spa_id: row.spa_id,
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
            tr.name AS treatment_name, (EXTRACT(EPOCH FROM (sa.end_time - sa.start_time)) / 60)::int AS duration_mins,
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

// A request's own branding / cancel_url wins; otherwise the property's
// defaults (Settings -> Branding, property.email_branding/email_cancel_url)
// apply -- so bookings made from the dashboard or by an AI reply are branded
// without every caller having to resend the same values. undefined means
// "not supplied"; an explicit null is honoured as "plain".
async function resolveEmailBranding(propertyId, branding, cancelUrl) {
  if (branding !== undefined && cancelUrl !== undefined) return { branding, cancelUrl };
  const { rows: [p] } = await pool.query('SELECT email_branding, email_cancel_url FROM property WHERE id = $1', [propertyId]);
  return {
    branding: branding !== undefined ? branding : p?.email_branding ?? undefined,
    cancelUrl: cancelUrl !== undefined ? cancelUrl : p?.email_cancel_url ?? undefined,
  };
}

// Fire-and-forget publish + (optional) email after a commit, shared by
// createAppointment and updateAppointment's cancellation path. Never throws
// -- every failure is caught and logged, matching the existing Ably
// .catch() convention in this file.
async function publishAndEmailAfterCreate(spaId, propertyId, appointmentId, rawInsertedRow, requestBranding, requestCancelUrl) {
  publishNewAppointment(spaId, rawInsertedRow).catch((err) => console.error('Ably publish failed:', err.message));

  const { branding, cancelUrl } = await resolveEmailBranding(propertyId, requestBranding, requestCancelUrl).catch((err) => {
    console.error('Failed to load property email branding:', err.message);
    return { branding: requestBranding, cancelUrl: requestCancelUrl };
  });

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
    const { cursor, limit, spa_id, therapist_id, date, from, to } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 500);
    let query = `
      SELECT sa.*, st.spa_id, st.name AS therapist_name, tr.name AS treatment_name,
             (EXTRACT(EPOCH FROM (sa.end_time - sa.start_time)) / 60)::int AS duration_mins
      FROM spa_appointment sa
      JOIN spa_therapist st ON st.id = sa.therapist_id
      JOIN spa_treatment tr ON tr.id = sa.treatment_id
      WHERE sa.property_id = $1
    `;
    const params = [req.property_id];
    // Optional -- the spa dashboard's own feed scopes to one spa; the
    // property dashboard omits this to show bookings across every spa (and
    // needs st.spa_id above since a booking's own row carries no spa_id of
    // its own -- the property dashboard's action buttons need it to PUT
    // /api/spa/:spa_id/appointments/:id for a booking from any spa).
    if (spa_id) { params.push(spa_id); query += ` AND st.spa_id = $${params.length}`; }
    // Optional -- a therapist linked to their own login sees just their own
    // appointments on the spa dashboard.
    if (therapist_id) { params.push(therapist_id); query += ` AND sa.therapist_id = $${params.length}`; }
    // Optional -- the spa schedule page scopes this feed to whichever date
    // is selected on its calendar, same as its own day-grid appointments.
    if (date) { params.push(date); query += ` AND sa.appointment_date = $${params.length}`; }
    // Optional inclusive appointment_date range -- for the property
    // dashboard's weekly bookings-count/revenue charts, same from/to shape
    // as listAppointments' own range filter. Not meant to combine with the
    // exact-match `date` above.
    if (from) { params.push(from); query += ` AND sa.appointment_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND sa.appointment_date <= $${params.length}`; }
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
    const { date, from, to, status, guest_id, clerk_user_id, therapist_id } = req.query;
    let query = `
      SELECT sa.*, st.name AS therapist_name, tr.name AS treatment_name
      FROM spa_appointment sa
      JOIN spa_therapist st ON st.id = sa.therapist_id
      JOIN spa_treatment tr ON tr.id = sa.treatment_id
      WHERE st.spa_id = $1 AND sa.property_id = $2
    `;
    const params = [spa_id, req.property_id];
    if (date) { params.push(date); query += ` AND sa.appointment_date = $${params.length}`; }
    // from/to is an inclusive date range -- for a calendar month view, not
    // meant to combine with the exact-match `date` above.
    if (from) { params.push(from); query += ` AND sa.appointment_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND sa.appointment_date <= $${params.length}`; }
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
      `SELECT sa.*, st.name AS therapist_name, tr.name AS treatment_name
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
      // slot_date comes back as a Date in the process's own timezone, so
      // the ::text copy is what the day-of-week check reads.
      `SELECT ss.*, ss.slot_date::text AS slot_date_text FROM spa_slot ss
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

    // The legacy slot flow has no regulars' rate -- standard price only.
    const treatmentRes = await client.query('SELECT duration_mins, price, days_of_week FROM spa_treatment WHERE id = $1', [slot.treatment_id]);
    // A slot generated before the treatment's days were restricted is
    // still sitting there bookable -- refuse it rather than let the legacy
    // flow be the one way round the restriction.
    if (!isOfferedOn(treatmentRes.rows[0].days_of_week, slot.slot_date_text)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That treatment is not offered on that day' });
    }
    const endTime = addMinutesToTime(slot.slot_time, treatmentRes.rows[0].duration_mins);

    const { rows } = await client.query(
      `INSERT INTO spa_appointment
         (property_id, slot_id, treatment_id, therapist_id, appointment_date, start_time, end_time,
          guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        req.property_id, slot_id, slot.treatment_id, slot.therapist_id, slot.slot_date, slot.slot_time, endTime,
        guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null,
        treatmentRes.rows[0].price,
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
// consistent with that lock. excludeAppointmentId leaves one appointment out
// of the overlap check -- rescheduling needs to know whether the *new*
// date/time/therapist is free without the appointment's own current slot
// counting as a conflict against itself.
async function isTherapistFree(client, therapistId, date, time, durationMins, timezone, excludeAppointmentId = null) {
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
           AND ($6::uuid IS NULL OR sa.id != $6)
       ) AS has_overlap,
       (
         $2::date < (now() AT TIME ZONE $5)::date
         OR ($2::date = (now() AT TIME ZONE $5)::date AND $3::time <= (now() AT TIME ZONE $5)::time)
       ) AS is_past`,
    [therapistId, date, time, durationMins, timezone, excludeAppointmentId]
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
// 'therapist_not_found' | 'members_only' | 'unavailable'.
//
// member_email is an email the caller has verified (never contact_email --
// see lib/spaMemberRate.js); when it qualifies for the regulars' rate on
// `date`, the appointment books at member_price/member_duration_mins. The
// price is frozen onto the appointment either way.
async function bookFromAvailability({ property_id, spa_id, treatment_id, therapist_id = null, date, time, guest_id = null, clerk_user_id = null, contact_name, contact_email = null, contact_phone = null, notes = null, member_email = null, branding, cancel_url }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const treatmentRes = await client.query(
      `SELECT id, duration_mins, price, member_price, member_duration_mins, days_of_week
       FROM spa_treatment WHERE id = $1 AND spa_id = $2 AND property_id = $3 AND status = 'active'`,
      [treatment_id, spa_id, property_id]
    );
    if (!treatmentRes.rows.length) { await client.query('ROLLBACK'); return { ok: false, code: 'treatment_not_found' }; }
    // Treatments the salon only offers on some days. Checked here rather
    // than only in findSpaAvailability so every booking path refuses a
    // blocked day -- guest site, AI replies, and the staff dashboard alike.
    if (!isOfferedOn(treatmentRes.rows[0].days_of_week, date)) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'day_not_offered' };
    }
    const rate = resolveRate(treatmentRes.rows[0], await memberRateUntil(client, property_id, member_email), date);
    if (!rate.ok) { await client.query('ROLLBACK'); return { ok: false, code: rate.code }; }
    const durationMins = rate.durationMins;

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
          guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, price, member_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        property_id, treatment_id, chosenTherapistId, date, time, endTime,
        guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null,
        rate.price, rate.memberRate,
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
  members_only: [403, "That service is only available at the regulars' rate"],
  day_not_offered: [409, 'That treatment is not offered on that day'],
  unavailable: [409, 'Time is not available'],
};

async function createAppointmentFromAvailability(req, res, next) {
  const { spa_id } = req.params;
  const { treatment_id, therapist_id, date, time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, member_email, branding, cancel_url } = req.body;

  if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });
  if (!isValidTime(time)) return res.status(400).json({ error: 'Invalid time format, use HH:MM' });

  try {
    const result = await bookFromAvailability({
      property_id: req.property_id, spa_id, treatment_id, therapist_id, date, time,
      guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes, member_email, branding, cancel_url,
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

// status/notes update in-place. Rescheduling (appointment_date/start_time/
// therapist_id) additionally needs a treatment duration to compute the new
// end_time, a conflict check against the target therapist's own hours/
// time-off/other-appointments (isTherapistFree, excluding this appointment's
// own current row from the overlap check), and a row lock for the duration
// of that check -- same shape as bookFromAvailability's booking path, just
// updating an existing row instead of inserting one. Only supported for
// hours-driven appointments (slot_id IS NULL); a slot-driven appointment's
// slot_id would otherwise go stale (still marked booked, and pointing at
// the old time) since this path never touches spa_slot.
async function updateAppointment(req, res, next) {
  const client = await pool.connect();
  try {
    const { spa_id, id } = req.params;
    const { status, notes, branding, appointment_date, start_time, therapist_id } = req.body;
    const reschedule = appointment_date != null || start_time != null || therapist_id != null;

    const brandingError = validateBranding(branding);
    if (brandingError) return res.status(400).json({ error: brandingError });
    if (status != null && !['confirmed', 'cancelled', 'checked_in', 'completed', 'no_show'].includes(status)) {
      return res.status(400).json({ error: "status must be one of 'confirmed', 'cancelled', 'checked_in', 'completed', 'no_show'" });
    }

    await client.query('BEGIN');

    const beforeRes = await client.query(
      `SELECT sa.status, sa.slot_id, sa.treatment_id, sa.therapist_id, sa.appointment_date, sa.start_time,
              -- The appointment's own length, not the treatment's: a
              -- regulars'-rate booking can run member_duration_mins.
              (EXTRACT(EPOCH FROM (sa.end_time - sa.start_time)) / 60)::int AS duration_mins
       FROM spa_appointment sa
       JOIN spa_therapist st ON st.id = sa.therapist_id
       JOIN spa_treatment tr ON tr.id = sa.treatment_id
       WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3
       FOR UPDATE OF sa`,
      [id, spa_id, req.property_id]
    );
    if (!beforeRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Appointment not found' }); }
    const before = beforeRes.rows[0];

    let newEndTime;
    if (reschedule) {
      if (before.slot_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This appointment is slot-based and can\'t have its date/time changed here.' });
      }

      const effectiveDate = appointment_date ?? before.appointment_date;
      const effectiveTime = start_time ?? before.start_time;
      const effectiveTherapistId = therapist_id ?? before.therapist_id;

      if (therapist_id) {
        const tRes = await client.query(
          "SELECT id FROM spa_therapist WHERE id = $1 AND spa_id = $2 AND property_id = $3 AND status = 'active' FOR UPDATE",
          [therapist_id, spa_id, req.property_id]
        );
        if (!tRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Therapist not found' }); }
      }

      const propertyRes = await client.query(
        `SELECT p.timezone FROM property p JOIN spa s ON s.property_id = p.id WHERE s.id = $1`,
        [spa_id]
      );
      const timezone = propertyRes.rows[0].timezone;

      const free = await isTherapistFree(client, effectiveTherapistId, effectiveDate, effectiveTime, before.duration_mins, timezone, id);
      if (!free) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'That time is no longer available.' });
      }

      const endRes = await client.query(
        `SELECT ($1::time + ($2 || ' minutes')::interval)::time AS end_time`,
        [effectiveTime, before.duration_mins]
      );
      newEndTime = endRes.rows[0].end_time;
    }

    const { rows } = await client.query(
      `UPDATE spa_appointment sa SET
         status           = COALESCE($1, sa.status),
         notes            = COALESCE($2, sa.notes),
         appointment_date = COALESCE($6, sa.appointment_date),
         start_time       = COALESCE($7, sa.start_time),
         end_time         = COALESCE($8, sa.end_time),
         therapist_id     = COALESCE($9, sa.therapist_id)
       FROM spa_therapist st
       WHERE sa.therapist_id = st.id
         AND sa.id = $3
         AND st.spa_id = $4
         AND sa.property_id = $5
       RETURNING sa.*`,
      [status, notes, id, spa_id, req.property_id, appointment_date, start_time, newEndTime, therapist_id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Appointment not found' }); }

    await client.query('COMMIT');

    if (rows[0].status !== before.status || reschedule) {
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
          resolveEmailBranding(req.property_id, branding, null)
            .then(({ branding: resolved }) => sendAppointmentCancellation(full, full.property_name, resolved))
            .catch((err) => console.error('Cancellation email failed:', err.message));
        }
      }
    }

    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// GET, unauthenticated -- the appointment UUID is the capability (unguessable,
// only ever in that customer's own review-request email), same reasoning as
// the {id} cancel link. Idempotent: a mail client prefetching the link is
// harmless. Just skips authenticateOrApiKey in routes/spa.js -- no raw body
// needed, so unlike the Resend webhook it has no reason to be in app.js's
// pre-express.json() allow-list.
async function reviewOptOut(req, res, next) {
  try {
    const { appointment_id } = req.params;
    const { rows } = await pool.query(
      `SELECT sa.property_id, sa.contact_email, p.name AS property_name
       FROM spa_appointment sa JOIN property p ON p.id = sa.property_id
       WHERE sa.id = $1`,
      [appointment_id]
    );
    const appointment = rows[0];
    if (!appointment) return res.status(404).send('<p>That link is no longer valid.</p>');

    if (appointment.contact_email) {
      await pool.query(
        `INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, lower($2))
         ON CONFLICT DO NOTHING`,
        [appointment.property_id, appointment.contact_email]
      );
    }

    res.send(`<p>You won't be asked for a review by ${escapeHtml(appointment.property_name)} again.</p>`);
  } catch (err) { next(err); }
}

// GET, unauthenticated -- same capability-in-the-URL reasoning as
// reviewOptOut above. `channel` is 'email' or 'sms' since a reminder text
// and a reminder email are opted out of independently (an SMS "STOP" reply
// shouldn't silence a guest's reminder emails too, and vice versa).
async function reminderOptOut(req, res, next) {
  try {
    const { appointment_id, channel } = req.params;
    if (channel !== 'email' && channel !== 'sms') return res.status(400).send('<p>Invalid link.</p>');

    const { rows } = await pool.query(
      `SELECT sa.property_id, sa.contact_email, sa.contact_phone, p.name AS property_name
       FROM spa_appointment sa JOIN property p ON p.id = sa.property_id
       WHERE sa.id = $1`,
      [appointment_id]
    );
    const appointment = rows[0];
    if (!appointment) return res.status(404).send('<p>That link is no longer valid.</p>');

    const contact = channel === 'email' ? appointment.contact_email : appointment.contact_phone;
    if (contact) {
      await pool.query(
        `INSERT INTO reminder_opt_out (property_id, channel, contact) VALUES ($1, $2, lower($3))
         ON CONFLICT DO NOTHING`,
        [appointment.property_id, channel, contact]
      );
    }

    const noun = channel === 'sms' ? 'texts' : 'emails';
    res.send(`<p>You won't get reminder ${noun} from ${escapeHtml(appointment.property_name)} again.</p>`);
  } catch (err) { next(err); }
}

module.exports = {
  listSpas, getSpa, createSpa, updateSpa,
  listTreatments, createTreatment, updateTreatment,
  getMemberRate,
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
  getFullAppointmentForEmail,
  resolveEmailBranding,
  reviewOptOut,
  reminderOptOut,
};
