const crypto = require('crypto');
const pool = require('../db');
const hk = require('../lib/housekeeping');

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
    const { rows } = await pool.query(
      `UPDATE hk_job SET status = 'claimed', claimed_by = $1, claimed_by_name = $2
       WHERE id = $3 AND status IN ('open', 'claimed') RETURNING id`,
      [me, name, job.id]
    );
    if (!rows.length) return res.status(409).json({ error: `Job is ${job.status}` });
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
  placeExtra,
  listCheckItems, createCheckItem, updateCheckItem, uploadPhoto, inspectJob,
  loadJob, respondJob, isAdmin, UUID_RE,
};
