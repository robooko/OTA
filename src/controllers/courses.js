const pool = require('../db');
const { isValidDate, isValidTime } = require('../middleware/validate');
const { sessionDates, ageOn } = require('../lib/courseSessions');

const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isAgeBound = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 120);
const STATUSES = ['active', 'inactive'];
const MAX_RUN_DAYS = 366;

const withSessions = (run) => ({ ...run, sessions: sessionDates(run) });

// Participants on the run's live enrolments -- one seat each.
async function seatsTaken(client, runId) {
  const { rows: [{ n }] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM course_participant cp
     JOIN course_enrolment ce ON ce.id = cp.enrolment_id
     WHERE ce.run_id = $1 AND ce.status != 'cancelled'`, [runId]
  );
  return n;
}

// Locks the run (serialising enrolments and capacity edits on it) and
// share-locks its course (so the course can't be deleted underneath).
async function lockRun(client, runId, propertyId) {
  const { rows: [run] } = await client.query(
    `SELECT cr.*, c.name AS course_name, c.price AS course_price, c.min_age, c.max_age,
            c.status AS course_status, cr.start_date < CURRENT_DATE AS started
     FROM course_run cr JOIN course c ON c.id = cr.course_id
     WHERE cr.id = $1 AND cr.property_id = $2
     FOR UPDATE OF cr FOR SHARE OF c`, [runId, propertyId]
  );
  return run;
}

// 400-message for a course, null when fine. `c` is the full course as it
// would be saved (for updates: current row overlaid with the request).
function courseError(c) {
  if (!c.name || typeof c.name !== 'string' || c.name.length > 100) return 'name is required (at most 100 characters)';
  if (!isMoney(c.price)) return 'price must be a non-negative number';
  if (!isAgeBound(c.min_age) || !isAgeBound(c.max_age)) return 'min_age and max_age must be whole years, or null for no limit';
  if (c.min_age !== null && c.max_age !== null && c.min_age > c.max_age) return "min_age can't be above max_age";
  if (!STATUSES.includes(c.status)) return "status must be 'active' or 'inactive'";
  return null;
}

// Same, for a run.
function runError(r) {
  if (!isValidDate(r.start_date) || !isValidDate(r.end_date)) return 'start_date and end_date must be YYYY-MM-DD';
  if (r.end_date < r.start_date) return 'end_date must be on or after start_date';
  if ((new Date(r.end_date) - new Date(r.start_date)) / 86400000 >= MAX_RUN_DAYS) return `a run can span at most ${MAX_RUN_DAYS} days`;
  if (!Array.isArray(r.weekdays) || !r.weekdays.length || !r.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return 'weekdays must be a non-empty array of 0-6 (0 = Sunday)';
  }
  if (!Array.isArray(r.skip_dates) || !r.skip_dates.every(isValidDate)) return 'skip_dates must be an array of YYYY-MM-DD dates';
  if (!isValidTime(r.start_time) || !isValidTime(r.end_time)) return 'start_time and end_time must be HH:MM';
  if (r.end_time <= r.start_time) return 'end_time must be after start_time';
  if (!Number.isInteger(r.capacity) || r.capacity < 1) return 'capacity must be a positive integer';
  if (r.price !== null && !isMoney(r.price)) return 'price must be a non-negative number, or null for the course price';
  if (!STATUSES.includes(r.status)) return "status must be 'active' or 'inactive'";
  if (!sessionDates(r).length) return 'this run has no sessions -- check weekdays and skip_dates against the dates';
  return null;
}

// ── Courses ───────────────────────────────────────────────────────────────────

async function listCourses(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM course WHERE status = 'active' AND property_id = $1 ORDER BY name", [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createCourse(req, res, next) {
  try {
    const b = req.body;
    const c = { name: b.name, description: b.description ?? null, price: b.price, min_age: b.min_age ?? null, max_age: b.max_age ?? null, status: 'active' };
    const error = courseError(c);
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(
      `INSERT INTO course (property_id, name, description, price, min_age, max_age)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, c.name, c.description, c.price, c.min_age, c.max_age]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

const COURSE_FIELDS = ['name', 'description', 'price', 'min_age', 'max_age', 'status'];

async function updateCourse(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT * FROM course WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]
    );
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Course not found' }); }
    // Merge, then validate the whole: an explicit null on min_age / max_age /
    // description clears it, and the band is checked against the other bound.
    const c = { ...current, price: parseFloat(current.price) };
    for (const f of COURSE_FIELDS) if (f in req.body) c[f] = req.body[f];
    const error = courseError(c);
    if (error) { await client.query('ROLLBACK'); return res.status(400).json({ error }); }
    const { rows } = await client.query(
      `UPDATE course SET name = $1, description = $2, price = $3, min_age = $4, max_age = $5, status = $6
       WHERE id = $7 RETURNING *`,
      [c.name, c.description, c.price, c.min_age, c.max_age, c.status, current.id]
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

// Hard delete of a course or one run, with their enrolments. Refuses while
// any run that hasn't ended still has a live enrolment -- cancel those first.
async function hardDelete(req, res, next, kind) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const table = kind === 'course' ? 'course' : 'course_run';
    const { rows: [target] } = await client.query(
      `SELECT id FROM ${table} WHERE id = $1 AND property_id = $2 FOR UPDATE`, [req.params.id, req.property_id]
    );
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: kind === 'course' ? 'Course not found' : 'Run not found' });
    }
    const runFilter = kind === 'course' ? 'cr.course_id = $1' : 'cr.id = $1';
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM course_enrolment ce JOIN course_run cr ON cr.id = ce.run_id
       WHERE ${runFilter} AND ce.status != 'cancelled' AND cr.end_date >= CURRENT_DATE`, [target.id]
    );
    if (n) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${n} enrolment(s) on runs that haven't finished are still active -- cancel them first` });
    }
    // course_participant goes with its enrolment (ON DELETE CASCADE).
    await client.query(`DELETE FROM course_enrolment ce USING course_run cr WHERE cr.id = ce.run_id AND ${runFilter}`, [target.id]);
    await client.query(`DELETE FROM course_run cr WHERE ${runFilter}`, [target.id]);
    if (kind === 'course') await client.query('DELETE FROM course WHERE id = $1', [target.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

const deleteCourse = (req, res, next) => hardDelete(req, res, next, 'course');
const deleteRun = (req, res, next) => hardDelete(req, res, next, 'run');

// ── Runs ──────────────────────────────────────────────────────────────────────

// { runs: [...] } -- all or nothing.
async function createRuns(req, res, next) {
  const { runs } = req.body;
  if (!Array.isArray(runs) || !runs.length) return res.status(400).json({ error: 'runs must be a non-empty array' });
  const full = runs.map((r) => ({ ...r, skip_dates: r.skip_dates ?? [], price: r.price ?? null, status: 'active' }));
  for (const [i, r] of full.entries()) {
    const error = runError(r);
    if (error) return res.status(400).json({ error: `runs[${i}]: ${error}` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [course] } = await client.query(
      'SELECT id FROM course WHERE id = $1 AND property_id = $2 FOR SHARE', [req.params.id, req.property_id]
    );
    if (!course) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Course not found' }); }
    const created = [];
    for (const r of full) {
      const { rows } = await client.query(
        `INSERT INTO course_run (property_id, course_id, start_date, end_date, weekdays, skip_dates, start_time, end_time, capacity, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [req.property_id, course.id, r.start_date, r.end_date, r.weekdays, r.skip_dates, r.start_time, r.end_time, r.capacity, r.price]
      );
      created.push(withSessions(rows[0]));
    }
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

const RUN_FIELDS = ['start_date', 'end_date', 'weekdays', 'skip_dates', 'start_time', 'end_time', 'capacity', 'price', 'status'];

async function updateRun(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT * FROM course_run WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]
    );
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Run not found' }); }
    // TIME reads back as HH:MM:SS and NUMERIC as a string; normalise so the
    // merged run validates the same way a new one does.
    const r = {
      ...current,
      start_time: current.start_time.slice(0, 5),
      end_time: current.end_time.slice(0, 5),
      price: current.price === null ? null : parseFloat(current.price),
    };
    for (const f of RUN_FIELDS) if (f in req.body) r[f] = req.body[f];
    const error = runError(r);
    if (error) { await client.query('ROLLBACK'); return res.status(400).json({ error }); }
    const taken = await seatsTaken(client, current.id);
    if (r.capacity < taken) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${taken} places are already taken -- capacity can't go below that` });
    }
    const { rows } = await client.query(
      `UPDATE course_run SET start_date = $1, end_date = $2, weekdays = $3, skip_dates = $4, start_time = $5,
         end_time = $6, capacity = $7, price = $8, status = $9
       WHERE id = $10 RETURNING *`,
      [r.start_date, r.end_date, r.weekdays, r.skip_dates, r.start_time, r.end_time, r.capacity, r.price, r.status, current.id]
    );
    await client.query('COMMIT');
    res.json(withSessions(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// ── Enrolments ───────────────────────────────────────────────────────────────

const ageBand = (min, max) => (min !== null && max !== null ? `ages ${min}-${max}` : min !== null ? `ages ${min} and over` : `ages up to ${max}`);

// 400-message for a participant list, null when fine. Ages are checked
// later, against the run's start date.
function participantsError(participants) {
  if (!Array.isArray(participants) || !participants.length) return 'participants must be a non-empty array';
  for (const p of participants) {
    if (!p || typeof p.first_name !== 'string' || !p.first_name.trim() || p.first_name.length > 100) {
      return 'every participant needs a first_name (at most 100 characters)';
    }
    if (!isValidDate(p.date_of_birth)) return `${p.first_name}: date_of_birth must be YYYY-MM-DD`;
  }
  return null;
}

async function createEnrolment(req, res, next) {
  const { run_id, guest_id, contact_name, contact_email, contact_phone, notes, participants, total_price } = req.body;
  if (!run_id || !contact_name || typeof contact_name !== 'string') return res.status(400).json({ error: 'run_id and contact_name are required' });
  const pError = participantsError(participants);
  if (pError) return res.status(400).json({ error: pError });
  if (total_price != null && !isMoney(total_price)) return res.status(400).json({ error: 'total_price must be a non-negative number' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await lockRun(client, run_id, req.property_id);
    if (!run) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Run not found' }); }
    if (run.status !== 'active' || run.course_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This course is not open for booking' });
    }
    if (guest_id) {
      const { rows } = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }
    // Whole course only: a late joiner goes through staff, who set the price.
    if (run.started && total_price == null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This course has already started' });
    }
    for (const p of participants) {
      if (p.date_of_birth > run.start_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${p.first_name}: date_of_birth is after the course starts` });
      }
      const age = ageOn(p.date_of_birth, run.start_date);
      if ((run.min_age !== null && age < run.min_age) || (run.max_age !== null && age > run.max_age)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${p.first_name} is ${age} on ${run.start_date}; this course is for ${ageBand(run.min_age, run.max_age)}` });
      }
    }
    const taken = await seatsTaken(client, run.id);
    if (taken + participants.length > run.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${Math.max(run.capacity - taken, 0)} places left` });
    }

    const price = total_price ?? parseFloat(run.price ?? run.course_price) * participants.length;
    const { rows: [enrolment] } = await client.query(
      `INSERT INTO course_enrolment (property_id, run_id, guest_id, contact_name, contact_email, contact_phone, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.property_id, run.id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, price.toFixed(2), notes ?? null]
    );
    const { rows: people } = await client.query(
      `INSERT INTO course_participant (enrolment_id, first_name, date_of_birth)
       SELECT $1::uuid, * FROM unnest($2::text[], $3::date[])
       RETURNING id, first_name, date_of_birth`,
      [enrolment.id, participants.map((p) => p.first_name.trim()), participants.map((p) => p.date_of_birth)]
    );
    await client.query('COMMIT');
    res.status(201).json({ ...enrolment, participants: people });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function listEnrolments(req, res, next) {
  try {
    const { run_id, status, guest_id } = req.query;
    let query = `
      SELECT ce.*, cr.start_date, cr.end_date, c.name AS course_name,
             COALESCE(json_agg(json_build_object('id', cp.id, 'first_name', cp.first_name, 'date_of_birth', cp.date_of_birth)
                      ORDER BY cp.first_name) FILTER (WHERE cp.id IS NOT NULL), '[]') AS participants
      FROM course_enrolment ce
      JOIN course_run cr ON cr.id = ce.run_id
      JOIN course c ON c.id = cr.course_id
      LEFT JOIN course_participant cp ON cp.enrolment_id = ce.id
      WHERE ce.property_id = $1
    `;
    const params = [req.property_id];
    if (run_id) { params.push(run_id); query += ` AND ce.run_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND ce.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND ce.guest_id = $${params.length}`; }
    query += ' GROUP BY ce.id, cr.id, c.id ORDER BY cr.start_date, ce.created_at';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

const ENROLMENT_STATUSES = ['confirmed', 'cancelled'];

async function updateEnrolment(req, res, next) {
  const { status, notes } = req.body;
  if (status != null && !ENROLMENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be 'confirmed' or 'cancelled'" });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [found] } = await client.query(
      'SELECT run_id FROM course_enrolment WHERE id = $1 AND property_id = $2', [req.params.id, req.property_id]
    );
    if (!found) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Enrolment not found' }); }
    // Run first, then the enrolment: the same order as createEnrolment and
    // run deletes, so these can't deadlock each other.
    const run = await lockRun(client, found.run_id, req.property_id);
    const { rows: [current] } = await client.query(
      'SELECT status FROM course_enrolment WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    // Reinstating a cancelled enrolment takes its places back.
    if (current.status === 'cancelled' && status === 'confirmed') {
      const { rows: [{ n }] } = await client.query('SELECT COUNT(*)::int AS n FROM course_participant WHERE enrolment_id = $1', [req.params.id]);
      const taken = await seatsTaken(client, run.id);
      if (taken + n > run.capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Only ${Math.max(run.capacity - taken, 0)} places left` });
      }
    }
    const { rows } = await client.query(
      'UPDATE course_enrolment SET status = COALESCE($1, status), notes = COALESCE($2, notes) WHERE id = $3 RETURNING *',
      [status ?? null, notes ?? null, req.params.id]
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

module.exports = {
  listCourses, createCourse, updateCourse, deleteCourse,
  createRuns, updateRun, deleteRun,
  createEnrolment, listEnrolments, updateEnrolment,
};
