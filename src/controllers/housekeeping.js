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

module.exports = { board, getSettings, putSettings, putOverride, deleteOverride, putRoomStatus };
