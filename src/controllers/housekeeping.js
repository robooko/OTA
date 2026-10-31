const crypto = require('crypto');
const pool = require('../db');
const hk = require('../lib/housekeeping');
const minibar = require('../lib/minibar');

// Room housekeeping for the staff app -- see
// docs/superpowers/specs/2026-10-31-housekeeping-design.md. Library calls go
// through the hk module object so the check script can stub them.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isInterval = (v) => v === null || (Number.isInteger(v) && v > 0 && v <= 365);

// ── Board ────────────────────────────────────────────────────────────────────

async function board(req, res, next) {
  try {
    const date = req.query.date ?? (await hk.propertyToday(pool, req.property_id));
    if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!(await hk.housekeepingEnabled(pool, req.property_id))) return res.json([]);
    await hk.ensureJobs(pool, req.property_id, date);
    res.json(await hk.listJobs(pool, req.property_id, date));
  } catch (err) { next(err); }
}

// ── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_SQL = `hk_inspection_required AS inspection_required, hk_service_every_days AS service_every_days,
                      hk_linen_every_days AS linen_every_days`;

async function getSettings(req, res, next) {
  try {
    const { rows } = await pool.query(`SELECT ${SETTINGS_SQL} FROM property WHERE id = $1`, [req.property_id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function putSettings(req, res, next) {
  try {
    const { inspection_required, service_every_days, linen_every_days } = req.body;
    if (inspection_required !== undefined && typeof inspection_required !== 'boolean') {
      return res.status(400).json({ error: 'inspection_required must be true or false' });
    }
    for (const [k, v] of Object.entries({ service_every_days, linen_every_days })) {
      if (v !== undefined && !isInterval(v)) return res.status(400).json({ error: `${k} must be a whole number of nights (1-365) or null` });
    }
    const { rows } = await pool.query(
      `UPDATE property SET
         hk_inspection_required = COALESCE($1, hk_inspection_required),
         hk_service_every_days  = CASE WHEN $3 THEN $2::int ELSE hk_service_every_days END,
         hk_linen_every_days    = CASE WHEN $5 THEN $4::int ELSE hk_linen_every_days END
       WHERE id = $6 RETURNING ${SETTINGS_SQL}`,
      [inspection_required ?? null, service_every_days ?? null, service_every_days !== undefined,
        linen_every_days ?? null, linen_every_days !== undefined, req.property_id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Overrides ────────────────────────────────────────────────────────────────

async function roomInProperty(roomId, propertyId) {
  if (typeof roomId !== 'string') return false;
  const { rows } = await pool.query('SELECT 1 FROM room WHERE id::text = $1 AND property_id = $2', [roomId, propertyId]);
  return rows.length > 0;
}

async function putOverride(req, res, next) {
  try {
    const { room_id, date, action } = req.body;
    if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    if (!['skip', 'clean'].includes(action)) return res.status(400).json({ error: "action must be 'skip' or 'clean'" });
    if (!(await roomInProperty(room_id, req.property_id))) return res.status(404).json({ error: 'Room not found' });
    const { rows } = await pool.query(
      `INSERT INTO hk_override (property_id, room_id, date, action, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, date) DO UPDATE SET action = EXCLUDED.action, created_by = EXCLUDED.created_by, created_at = now()
       RETURNING *`,
      [req.property_id, room_id, date, action, req.user?.id ?? null]
    );
    await hk.ensureJobs(pool, req.property_id, date);
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function deleteOverride(req, res, next) {
  try {
    const { room_id, date } = req.params;
    if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const { rows } = await pool.query(
      'DELETE FROM hk_override WHERE room_id::text = $1 AND date = $2 AND property_id = $3 RETURNING action',
      [room_id, date, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Override not found' });
    // A lifted skip reopens the stayover it skipped (if nobody started it).
    if (rows[0].action === 'skip') {
      const reopened = await pool.query(
        `UPDATE hk_job SET status = 'open', claimed_by = NULL, claimed_by_name = NULL
         WHERE room_id::text = $1 AND date = $2 AND kind = 'stayover' AND status = 'skipped'
           AND NOT EXISTS (SELECT 1 FROM hk_clean c WHERE c.job_id = hk_job.id)
         RETURNING id`,
        [room_id, date]
      );
      for (const { id } of reopened.rows) {
        const job = await hk.fetchJob(pool, id, req.property_id);
        if (job) hk.publish(req.property_id, 'job-updated', job);
      }
    }
    await hk.ensureJobs(pool, req.property_id, date);
    res.status(204).end();
  } catch (err) { next(err); }
}

// ── Room status by hand ─────────────────────────────────────────────────────

async function putRoomStatus(req, res, next) {
  try {
    const { housekeeping_status } = req.body;
    if (!hk.ROOM_STATUSES.includes(housekeeping_status)) {
      return res.status(400).json({ error: `housekeeping_status must be one of: ${hk.ROOM_STATUSES.join(', ')}` });
    }
    if (!(await roomInProperty(req.params.room_id, req.property_id))) return res.status(404).json({ error: 'Room not found' });
    res.json(await hk.setRoomStatus(pool, req.property_id, req.params.room_id, housekeeping_status));
  } catch (err) { next(err); }
}

// ── Cleaning: claim, start, finish ──────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadJob(db, id, propertyId) {
  if (!UUID_RE.test(String(id))) return null;
  const { rows } = await db.query('SELECT * FROM hk_job WHERE id = $1 AND property_id = $2', [id, propertyId]);
  return rows[0] ?? null;
}

// Sends the board row for a job and tells every open board about it.
async function respondJob(req, res, jobId, status = 200) {
  const job = await hk.fetchJob(pool, jobId, req.property_id);
  hk.publish(req.property_id, 'job-updated', job);
  res.status(status).json(job);
}

const isAdmin = (req) => req.user?.role === 'admin';

async function claimJob(req, res, next) {
  try {
    const job = await loadJob(pool, req.params.id, req.property_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const me = req.user?.id;
    if (job.status === 'claimed' && job.claimed_by !== me && req.body?.force !== true) {
      return res.status(409).json({ error: 'Already claimed', claimed_by: job.claimed_by, claimed_by_name: job.claimed_by_name });
    }
    const name = await hk.staffName(me);
    // The ownership rule lives in the WHERE so two simultaneous taps can't
    // both win: the second re-checks against the first's claim.
    const { rows } = await pool.query(
      `UPDATE hk_job SET status = 'claimed', claimed_by = $1, claimed_by_name = $2
       WHERE id = $3 AND (status = 'open' OR (status = 'claimed' AND (claimed_by = $1 OR $4::boolean)))
       RETURNING id`,
      [me, name, job.id, req.body?.force === true]
    );
    if (!rows.length) {
      const now = await loadJob(pool, job.id, req.property_id);
      if (now?.status === 'claimed') return res.status(409).json({ error: 'Already claimed', claimed_by: now.claimed_by, claimed_by_name: now.claimed_by_name });
      return res.status(409).json({ error: `Job is ${now?.status ?? job.status}` });
    }
    await respondJob(req, res, job.id);
  } catch (err) { next(err); }
}

async function unclaimJob(req, res, next) {
  try {
    const job = await loadJob(pool, req.params.id, req.property_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'claimed') return res.status(409).json({ error: `Job is ${job.status}` });
    if (job.claimed_by !== req.user?.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the person who claimed it (or an admin) can release it' });
    const { rows } = await pool.query(
      `UPDATE hk_job SET status = 'open', claimed_by = NULL, claimed_by_name = NULL
       WHERE id = $1 AND status = 'claimed' RETURNING id`,
      [job.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'Job changed, try again' });
    await respondJob(req, res, job.id);
  } catch (err) { next(err); }
}

// Starting takes the job (the board is shared; claims don't lock anyone out)
// and opens a new attempt -- a failed inspection's redo is another attempt.
async function startJob(req, res, next) {
  const client = await pool.connect();
  try {
    const job = await loadJob(client, req.params.id, req.property_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const me = req.user?.id;
    const name = await hk.staffName(me);
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE hk_job SET status = 'in_progress', claimed_by = $1, claimed_by_name = $2
       WHERE id = $3 AND status IN ('open', 'claimed', 'failed') RETURNING id`,
      [me, name, job.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Job is ${job.status}` });
    }
    await client.query('INSERT INTO hk_clean (job_id, cleaner_id, cleaner_name) VALUES ($1, $2, $3)', [job.id, me, name]);
    await client.query('COMMIT');
    await hk.setRoomStatus(pool, req.property_id, job.room_id, 'cleaning');
    await respondJob(req, res, job.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

async function finishJob(req, res, next) {
  const client = await pool.connect();
  try {
    const { sheets_changed, towels_changed, comments } = req.body;
    const job = await loadJob(client, req.params.id, req.property_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'in_progress') return res.status(409).json({ error: `Job is ${job.status}` });
    const attempt = (await client.query(
      'SELECT * FROM hk_clean WHERE job_id = $1 AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1', [job.id]
    )).rows[0];
    if (!attempt) return res.status(409).json({ error: 'No clean in progress' });
    if (attempt.cleaner_id !== req.user?.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the cleaner (or an admin) can finish this clean' });
    if (typeof sheets_changed !== 'boolean' || typeof towels_changed !== 'boolean') {
      return res.status(400).json({ error: 'sheets_changed and towels_changed must be true or false' });
    }
    if (comments != null && (typeof comments !== 'string' || comments.length > 2000)) {
      return res.status(400).json({ error: 'comments must be text up to 2000 characters' });
    }
    await client.query('BEGIN');
    const done = await client.query(`UPDATE hk_job SET status = 'done' WHERE id = $1 AND status = 'in_progress' RETURNING id`, [job.id]);
    if (!done.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Job changed, try again' });
    }
    await client.query(
      `UPDATE hk_clean SET finished_at = now(), sheets_changed = $1, towels_changed = $2, comments = $3 WHERE id = $4`,
      [sheets_changed, towels_changed, comments ?? null, attempt.id]
    );
    const { hk_inspection_required } = (await client.query('SELECT hk_inspection_required FROM property WHERE id = $1', [req.property_id])).rows[0];
    await client.query('COMMIT');
    await hk.setRoomStatus(pool, req.property_id, job.room_id, hk.statusAfterFinish(job.kind, hk_inspection_required));
    await respondJob(req, res, job.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// ── Arrival extras ──────────────────────────────────────────────────────────

// Ticks a booked extra as placed in the room. A second tick keeps the first
// time and person.
async function placeExtra(req, res, next) {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Booking extra not found' });
    const { rows } = await pool.query(
      `UPDATE booking_extra be SET placed_at = COALESCE(be.placed_at, now()), placed_by = COALESCE(be.placed_by, $1)
       FROM booking b
       WHERE be.id = $2 AND b.id = be.booking_id AND b.property_id = $3
       RETURNING be.*, b.room_id`,
      [req.user?.id ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking extra not found' });
    const { room_id, ...placed } = rows[0];
    const jobs = await pool.query('SELECT id FROM hk_job WHERE property_id = $1 AND arriving_booking_id = $2', [req.property_id, placed.booking_id]);
    for (const { id } of jobs.rows) {
      const job = await hk.fetchJob(pool, id, req.property_id);
      if (job) hk.publish(req.property_id, 'job-updated', job);
    }
    res.json(placed);
  } catch (err) { next(err); }
}

// ── Minibar ─────────────────────────────────────────────────────────────────

const isPrice = (v) => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e8;

function minibarItemError({ name, price, description, image_url, status }, partial) {
  if (!(partial && name === undefined) && (typeof name !== 'string' || !name.trim() || name.length > 100)) return 'name is required (up to 100 characters)';
  if (!(partial && price === undefined) && !isPrice(price)) return 'price must be 0 or more';
  if (description != null && typeof description !== 'string') return 'description must be text';
  if (image_url != null && (typeof image_url !== 'string' || !/^https:\/\//.test(image_url))) return 'image_url must be an https URL';
  if (status !== undefined && !['active', 'archived'].includes(status)) return "status must be 'active' or 'archived'";
  return null;
}

async function listMinibarItems(req, res, next) {
  try {
    const { rows } = await pool.query(`SELECT * FROM minibar_item WHERE property_id = $1 AND status = 'active' ORDER BY name`, [req.property_id]);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createMinibarItem(req, res, next) {
  try {
    const err = minibarItemError(req.body, false);
    if (err) return res.status(400).json({ error: err });
    const { name, price, description, image_url } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO minibar_item (property_id, name, price, description, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.property_id, name.trim(), price, description ?? null, image_url ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateMinibarItem(req, res, next) {
  try {
    const err = minibarItemError(req.body, true);
    if (err) return res.status(400).json({ error: err });
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Minibar item not found' });
    const { name, price, description, image_url, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE minibar_item SET name = COALESCE($1, name), price = COALESCE($2, price),
         description = COALESCE($3, description), image_url = COALESCE($4, image_url), status = COALESCE($5, status)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [name?.trim() ?? null, price ?? null, description ?? null, image_url ?? null, status ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Minibar item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// Replaces one list: the room type's (rate_plan_id null) or a rate plan's.
async function putMinibarList(req, res, next) {
  const client = await pool.connect();
  try {
    const { room_type_id, rate_plan_id = null, items } = req.body;
    if (!UUID_RE.test(String(room_type_id))) return res.status(400).json({ error: 'room_type_id is required' });
    if (rate_plan_id !== null && !UUID_RE.test(String(rate_plan_id))) return res.status(400).json({ error: 'rate_plan_id must be an id or null' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    for (const i of items) {
      if (!UUID_RE.test(String(i?.minibar_item_id))) return res.status(400).json({ error: 'Each item needs a minibar_item_id' });
      if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) return res.status(400).json({ error: 'quantity must be a whole number 1 to 99' });
      if (typeof i.included !== 'boolean') return res.status(400).json({ error: 'included must be true or false' });
    }
    const rt = await client.query('SELECT 1 FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id]);
    if (!rt.rows.length) return res.status(400).json({ error: 'Unknown room_type_id' });
    if (rate_plan_id) {
      const rp = await client.query('SELECT 1 FROM rate_plan WHERE id = $1 AND room_type_id = $2 AND property_id = $3', [rate_plan_id, room_type_id, req.property_id]);
      if (!rp.rows.length) return res.status(400).json({ error: 'Unknown rate_plan_id for this room type' });
    }
    const ids = [...new Set(items.map((i) => i.minibar_item_id))];
    if (ids.length !== items.length) return res.status(400).json({ error: 'Each item may appear once' });
    const known = await client.query('SELECT count(*)::int AS n FROM minibar_item WHERE property_id = $1 AND id = ANY($2::uuid[])', [req.property_id, ids]);
    if (known.rows[0].n !== ids.length) return res.status(400).json({ error: 'Unknown minibar_item_id' });

    await client.query('BEGIN');
    await client.query('DELETE FROM minibar_list_item WHERE room_type_id = $1 AND rate_plan_id IS NOT DISTINCT FROM $2', [room_type_id, rate_plan_id]);
    for (const i of items) {
      await client.query(
        'INSERT INTO minibar_list_item (room_type_id, rate_plan_id, minibar_item_id, quantity, included) VALUES ($1, $2, $3, $4, $5)',
        [room_type_id, rate_plan_id, i.minibar_item_id, i.quantity, i.included]
      );
    }
    await client.query('COMMIT');
    res.json((await client.query(
      `SELECT li.*, m.name FROM minibar_list_item li JOIN minibar_item m ON m.id = li.minibar_item_id
       WHERE li.room_type_id = $1 AND li.rate_plan_id IS NOT DISTINCT FROM $2 ORDER BY m.name`,
      [room_type_id, rate_plan_id]
    )).rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// For the booking site: what's in the minibar for a room type and plan.
async function getMinibarList(req, res, next) {
  try {
    const { room_type_id, rate_plan_id } = req.query;
    if (!UUID_RE.test(String(room_type_id))) return res.status(400).json({ error: 'room_type_id is required' });
    if (rate_plan_id !== undefined && !UUID_RE.test(String(rate_plan_id))) return res.status(400).json({ error: 'rate_plan_id must be an id' });
    const rt = await pool.query('SELECT 1 FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id]);
    if (!rt.rows.length) return res.status(404).json({ error: 'Room type not found' });
    res.json(await minibar.resolveList(pool, room_type_id, rate_plan_id ?? null));
  } catch (err) { next(err); }
}

async function recordMinibar(req, res, next) {
  try {
    const job = await loadJob(pool, req.params.id, req.property_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.booking_id) return res.status(400).json({ error: 'This job has no staying or departing guest to charge' });
    const out = await minibar.recordUsage(pool, { propertyId: req.property_id, job, items: req.body?.items, userId: req.user?.id });
    if (out.error) return res.status(400).json({ error: out.error });
    const row = await hk.fetchJob(pool, job.id, req.property_id);
    hk.publish(req.property_id, 'minibar-recorded', row);
    res.json({ job: row, usage: out.rows });
  } catch (err) { next(err); }
}

// ── Reports ─────────────────────────────────────────────────────────────────

// Finished attempts on jobs dated in [from, to), with each one's minutes.
const ATTEMPTS_CTE = `
  att AS (
    SELECT c.id, c.job_id, c.cleaner_id, c.cleaner_name, j.room_id,
           extract(epoch FROM c.finished_at - c.started_at) / 60 AS minutes
    FROM hk_clean c JOIN hk_job j ON j.id = c.job_id
    WHERE j.property_id = $1 AND j.date >= $2::date AND j.date < $3::date AND c.finished_at IS NOT NULL
  ),
  insp AS (SELECT i.*, a.cleaner_id, a.room_id FROM hk_inspection i JOIN att a ON a.id = i.clean_id),
  first_insp AS (SELECT DISTINCT ON (job_id) job_id, passed, cleaner_id, room_id FROM insp ORDER BY job_id, created_at)`;

// Guest ratings for stays that ended in range. Each counts once, unweighted,
// for the cleaner of the last un-failed checkout clean of that room before
// the guest arrived, and for every cleaner of a stayover/extra clean during
// the stay (plan call; the spec left weighting to the builder).
const RATED_CTE = `
  rated AS (
    SELECT cr.rating, b.id AS booking_id, b.room_id, b.check_in
    FROM cleanliness_rating cr JOIN booking b ON b.id = cr.booking_id
    WHERE cr.property_id = $1 AND cr.rating IS NOT NULL AND b.check_out >= $2::date AND b.check_out < $3::date
  ),
  credit AS (
    SELECT r.rating, x.cleaner_id FROM rated r
    CROSS JOIN LATERAL (
      (SELECT c.cleaner_id FROM hk_clean c JOIN hk_job j ON j.id = c.job_id
        WHERE j.room_id = r.room_id AND j.kind = 'checkout' AND j.date <= r.check_in AND c.finished_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hk_inspection i WHERE i.clean_id = c.id AND NOT i.passed)
        ORDER BY c.finished_at DESC LIMIT 1)
      UNION
      (SELECT c.cleaner_id FROM hk_clean c JOIN hk_job j ON j.id = c.job_id
        WHERE j.booking_id = r.booking_id AND j.kind IN ('stayover', 'extra') AND c.finished_at IS NOT NULL)
    ) x
  )`;

const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

async function reports(req, res, next) {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD, to exclusive)' });
    if (from >= to) return res.status(400).json({ error: 'from must be before to' });
    const params = [req.property_id, from, to];
    const byDim = (dim) => `
      SELECT ${dim} AS key, count(DISTINCT job_id) AS jobs_done, avg(minutes) AS avg_minutes,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS median_minutes
      FROM att GROUP BY ${dim}`;
    const [cleanerTime, roomTime, cleanerInsp, roomInsp, cleanerFirst, roomFirst, cleanerGuest, roomGuest, names, rooms] = await Promise.all([
      pool.query(`WITH ${ATTEMPTS_CTE} ${byDim('cleaner_id')}`, params),
      pool.query(`WITH ${ATTEMPTS_CTE} ${byDim('room_id')}`, params),
      pool.query(`WITH ${ATTEMPTS_CTE} SELECT cleaner_id AS key, avg(score) AS v FROM insp GROUP BY cleaner_id`, params),
      pool.query(`WITH ${ATTEMPTS_CTE} SELECT room_id AS key, avg(score) AS v FROM insp GROUP BY room_id`, params),
      pool.query(`WITH ${ATTEMPTS_CTE} SELECT cleaner_id AS key, avg(passed::int) AS v FROM first_insp GROUP BY cleaner_id`, params),
      pool.query(`WITH ${ATTEMPTS_CTE} SELECT room_id AS key, avg(passed::int) AS v FROM first_insp GROUP BY room_id`, params),
      pool.query(`WITH ${RATED_CTE} SELECT cleaner_id AS key, avg(rating) AS v FROM credit GROUP BY cleaner_id`, params),
      pool.query(`WITH ${RATED_CTE} SELECT room_id AS key, avg(rating) AS v FROM rated GROUP BY room_id`, params),
      pool.query(`SELECT DISTINCT ON (c.cleaner_id) c.cleaner_id, c.cleaner_name FROM hk_clean c JOIN hk_job j ON j.id = c.job_id
                  WHERE j.property_id = $1 ORDER BY c.cleaner_id, c.started_at DESC`, [req.property_id]),
      pool.query('SELECT id, room_number FROM room WHERE property_id = $1', [req.property_id]),
    ]);
    const map = (r) => new Map(r.rows.map((x) => [x.key, x.v]));
    const build = (time, insp, first, guest, label) => {
      const t = new Map(time.rows.map((x) => [x.key, x]));
      const ins = map(insp); const fir = map(first); const gst = map(guest);
      const keys = [...new Set([...t.keys(), ...gst.keys()])];
      return keys.map((key) => ({
        id: key,
        ...label(key),
        jobs_done: Number(t.get(key)?.jobs_done ?? 0),
        avg_minutes: r2(t.get(key)?.avg_minutes),
        median_minutes: r2(t.get(key)?.median_minutes),
        avg_inspection_score: r2(ins.get(key)),
        first_time_pass_rate: r2(fir.get(key)),
        avg_guest_score: r2(gst.get(key)),
      }));
    };
    const nameOf = new Map(names.rows.map((x) => [x.cleaner_id, x.cleaner_name]));
    const numberOf = new Map(rooms.rows.map((x) => [x.id, x.room_number]));
    res.json({
      cleaners: build(cleanerTime, cleanerInsp, cleanerFirst, cleanerGuest, (k) => ({ name: nameOf.get(k) ?? null }))
        .sort((a, b) => b.jobs_done - a.jobs_done),
      rooms: build(roomTime, roomInsp, roomFirst, roomGuest, (k) => ({ room_number: numberOf.get(k) ?? null }))
        .sort((a, b) => String(a.room_number).localeCompare(String(b.room_number), undefined, { numeric: true })),
    });
  } catch (err) { next(err); }
}

// ── Inspection ──────────────────────────────────────────────────────────────

function checkItemError({ name, pass_mark, sort_order, status }, partial) {
  if (!(partial && name === undefined) && (typeof name !== 'string' || !name.trim() || name.length > 100)) return 'name is required (up to 100 characters)';
  if (!(partial && pass_mark === undefined) && !(Number.isInteger(pass_mark) && pass_mark >= 1 && pass_mark <= 5)) return 'pass_mark must be a whole number 1 to 5';
  if (sort_order !== undefined && !Number.isInteger(sort_order)) return 'sort_order must be a whole number';
  if (status !== undefined && !['active', 'archived'].includes(status)) return "status must be 'active' or 'archived'";
  return null;
}

async function activeCheckItems(db, propertyId) {
  const { rows } = await db.query(
    `SELECT * FROM hk_check_item WHERE property_id = $1 AND status = 'active' ORDER BY sort_order, name`, [propertyId]
  );
  return rows;
}

async function listCheckItems(req, res, next) {
  try { res.json(await activeCheckItems(pool, req.property_id)); } catch (err) { next(err); }
}

async function createCheckItem(req, res, next) {
  try {
    const err = checkItemError(req.body, false);
    if (err) return res.status(400).json({ error: err });
    const { name, pass_mark, sort_order } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO hk_check_item (property_id, name, pass_mark, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.property_id, name.trim(), pass_mark, sort_order ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateCheckItem(req, res, next) {
  try {
    const err = checkItemError(req.body, true);
    if (err) return res.status(400).json({ error: err });
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Checklist item not found' });
    const { name, pass_mark, sort_order, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE hk_check_item SET
         name = COALESCE($1, name), pass_mark = COALESCE($2, pass_mark),
         sort_order = COALESCE($3, sort_order), status = COALESCE($4, status)
       WHERE id = $5 AND property_id = $6 RETURNING *`,
      [name?.trim() ?? null, pass_mark ?? null, sort_order ?? null, status ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Checklist item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Raw image body (express.raw on the route); returns a URL to put on a score.
async function uploadPhoto(req, res, next) {
  try {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!PHOTO_EXT[type]) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP image as the request body' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty image' });
    const url = await hk.putPhoto(`housekeeping/${req.property_id}/${crypto.randomUUID()}.${PHOTO_EXT[type]}`, req.body, type);
    res.status(201).json({ url });
  } catch (err) { next(err); }
}

// Grades the latest clean. Fail sends the room back to dirty and the job back
// to its cleaner with exactly what failed; pass makes the room ready. A done
// job is inspected; a passed one may be spot-checked again.
async function inspectJob(req, res, next) {
  const client = await pool.connect();
  try {
    const job = await loadJob(client, req.params.id, req.property_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['done', 'passed'].includes(job.status)) return res.status(409).json({ error: `Job is ${job.status}; only a finished clean can be inspected` });
    const attempt = (await client.query(
      'SELECT * FROM hk_clean WHERE job_id = $1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1', [job.id]
    )).rows[0];
    if (!attempt) return res.status(409).json({ error: 'No finished clean to inspect' });
    if (attempt.cleaner_id === req.user?.id && !isAdmin(req)) return res.status(409).json({ error: 'Cannot inspect your own clean' });
    const graded = hk.scoreInspection(await activeCheckItems(client, req.property_id), req.body?.scores);
    if (graded.error) return res.status(400).json({ error: graded.error });

    const me = req.user?.id;
    const name = await hk.staffName(me);
    await client.query('BEGIN');
    const moved = await client.query(
      `UPDATE hk_job SET status = $1 WHERE id = $2 AND status = $3 RETURNING id`,
      [graded.passed ? 'passed' : 'failed', job.id, job.status]
    );
    if (!moved.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Job changed, try again' });
    }
    const insp = (await client.query(
      `INSERT INTO hk_inspection (job_id, clean_id, inspector_id, inspector_name, passed, score)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [job.id, attempt.id, me, name, graded.passed, graded.score]
    )).rows[0];
    for (const r of graded.rows) {
      await client.query(
        `INSERT INTO hk_inspection_score (inspection_id, item_id, item_name, pass_mark, score, comment, photo_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [insp.id, r.item_id, r.item_name, r.pass_mark, r.score, r.comment, r.photo_url]
      );
    }
    await client.query('COMMIT');

    await hk.setRoomStatus(pool, req.property_id, job.room_id, graded.passed ? 'ready' : 'dirty');
    const row = await hk.fetchJob(pool, job.id, req.property_id);
    hk.publish(req.property_id, 'job-updated', row);
    if (!graded.passed) {
      hk.publish(req.property_id, 'inspection-failed', {
        cleaner_id: attempt.cleaner_id,
        cleaner_name: attempt.cleaner_name,
        job: row,
        failed_items: graded.rows.filter((r) => r.score < r.pass_mark)
          .map(({ item_name, score, pass_mark, comment, photo_url }) => ({ item_name, score, pass_mark, comment, photo_url })),
      });
    }
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  board, getSettings, putSettings, putOverride, deleteOverride, putRoomStatus,
  claimJob, unclaimJob, startJob, finishJob,
  placeExtra, reports,
  listMinibarItems, createMinibarItem, updateMinibarItem, putMinibarList, getMinibarList, recordMinibar,
  listCheckItems, createCheckItem, updateCheckItem, uploadPhoto, inspectJob,
  loadJob, respondJob, isAdmin, UUID_RE,
};
