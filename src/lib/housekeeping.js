const pool = require('../db');

// Room housekeeping -- see docs/superpowers/specs/2026-10-31-housekeeping-design.md.
// Housekeeping state is never availability: nothing here touches room.status
// or room_availability.

// ── Pure rules ───────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Nights since check-in for a 'YYYY-MM-DD' pair (night 0 = arrival day).
function nightIndex(checkIn, date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
}

// Every `everyDays` nights into a stay; never on arrival day; null = never.
function stayoverDue(n, everyDays) {
  return everyDays != null && n > 0 && n % everyDays === 0;
}

const linenDue = stayoverDue;

// Grades an inspection against the property's active checklist. Every active
// item must be scored exactly once, 1-5 integers; the room fails when any
// item is under its pass mark. rows snapshot name and pass mark so archiving
// an item never rewrites history.
function scoreInspection(items, scores) {
  if (!Array.isArray(scores)) return { error: 'scores must be an array' };
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set();
  const rows = [];
  for (const s of scores) {
    const item = byId.get(s?.item_id);
    if (!item) return { error: `Unknown checklist item ${s?.item_id}` };
    if (seen.has(item.id)) return { error: `${item.name} scored twice` };
    seen.add(item.id);
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) return { error: `${item.name}: score must be a whole number 1 to 5` };
    if (s.comment != null && (typeof s.comment !== 'string' || s.comment.length > 2000)) return { error: `${item.name}: comment must be text up to 2000 characters` };
    if (s.photo_url != null && (typeof s.photo_url !== 'string' || !/^https:\/\//.test(s.photo_url))) return { error: `${item.name}: photo_url must be an https URL` };
    rows.push({ item_id: item.id, item_name: item.name, pass_mark: item.pass_mark, score: s.score, comment: s.comment ?? null, photo_url: s.photo_url ?? null });
  }
  const missing = items.filter((i) => !seen.has(i.id));
  if (missing.length) return { error: `Missing scores for: ${missing.map((i) => i.name).join(', ')}` };
  if (!rows.length) return { error: 'No checklist items to score' };
  const score = Math.round((rows.reduce((a, r) => a + r.score, 0) / rows.length) * 100) / 100;
  return { passed: rows.every((r) => r.score >= r.pass_mark), score, rows };
}

// Room state once a clean is finished: only a checkout clean at a property
// that requires inspection waits at 'clean'.
function statusAfterFinish(kind, inspectionRequired) {
  return kind === 'checkout' && inspectionRequired ? 'clean' : 'ready';
}

// ── Property ────────────────────────────────────────────────────────────────

const ROOM_STATUSES = ['dirty', 'cleaning', 'clean', 'ready'];
// Booking statuses that put a guest in (or through) a room.
const LIVE = `('confirmed', 'checked_in', 'checked_out')`;

// Opt-in only: NULL enabled_modules ("everything on") does NOT switch
// housekeeping on, or every existing property would start blocking check-ins.
async function housekeepingEnabled(db, propertyId) {
  const { rows } = await db.query(
    `SELECT enabled_modules IS NOT NULL AND enabled_modules ? 'housekeeping' AS on FROM property WHERE id = $1`,
    [propertyId]
  );
  return rows[0]?.on === true;
}

async function propertyToday(db, propertyId) {
  const { rows } = await db.query(
    `SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM property WHERE id = $1`,
    [propertyId]
  );
  return rows[0].today;
}

// "First Last" from Clerk, cached for the process; null when Clerk can't say.
// Called through module.exports so the check script can stub it.
const nameCache = new Map();
async function staffName(userId) {
  if (!userId) return null;
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    const { clerkClient } = require('../middleware/auth');
    const u = await clerkClient.users.getUser(userId);
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.primaryEmailAddress?.emailAddress || null;
    nameCache.set(userId, name);
    return name;
  } catch (err) {
    console.error('Clerk name lookup failed:', err.message);
    return null;
  }
}

function publish(propertyId, event, payload) {
  require('./ably').publishHousekeeping(propertyId, event, payload)
    .catch((err) => console.error('Ably publish failed:', err.message));
}

async function setRoomStatus(db, propertyId, roomId, status) {
  const { rows } = await db.query(
    'UPDATE room SET housekeeping_status = $1 WHERE id = $2 AND property_id = $3 RETURNING *',
    [status, roomId, propertyId]
  );
  if (rows[0]) publish(propertyId, 'room-status-changed', rows[0]);
  return rows[0] ?? null;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

// Builds the day's jobs from bookings, idempotently (UNIQUE room+date+kind),
// and skips open jobs whose reason went away. Publishes job-updated for
// every job it creates or skips. No-op when housekeeping is off.
async function ensureJobs(db, propertyId, date) {
  if (!(await housekeepingEnabled(db, propertyId))) return;
  const client = await db.connect();
  const touched = [];
  const take = (r) => touched.push(...r.rows.map((x) => x.id));
  try {
    await client.query('BEGIN');
    // Departures. The arriving guest on the same room rides on the job.
    take(await client.query(
      `INSERT INTO hk_job (property_id, room_id, date, kind, booking_id, arriving_booking_id, linen_due)
       SELECT b.property_id, b.room_id, $2::date, 'checkout', b.id,
              (SELECT a.id FROM booking a WHERE a.room_id = b.room_id AND a.check_in = $2::date AND a.status IN ${LIVE} LIMIT 1),
              true
       FROM booking b
       WHERE b.property_id = $1 AND b.check_out = $2::date AND b.status IN ${LIVE}
       ON CONFLICT (room_id, date, kind) DO NOTHING RETURNING id`,
      [propertyId, date]
    ));
    // Arrivals booked (or cancelled) after the checkout job was made.
    await client.query(
      `UPDATE hk_job j SET arriving_booking_id =
         (SELECT a.id FROM booking a WHERE a.room_id = j.room_id AND a.check_in = j.date AND a.status IN ${LIVE} LIMIT 1)
       WHERE j.property_id = $1 AND j.date = $2::date AND j.kind = 'checkout'
         AND j.arriving_booking_id IS DISTINCT FROM
             (SELECT a.id FROM booking a WHERE a.room_id = j.room_id AND a.check_in = j.date AND a.status IN ${LIVE} LIMIT 1)`,
      [propertyId, date]
    );
    // Stayovers by the property's rule, unless skipped for the day.
    take(await client.query(
      `INSERT INTO hk_job (property_id, room_id, date, kind, booking_id, linen_due)
       SELECT b.property_id, b.room_id, $2::date, 'stayover', b.id,
              COALESCE(p.hk_linen_every_days IS NOT NULL AND ($2::date - b.check_in) % p.hk_linen_every_days = 0, false)
       FROM booking b JOIN property p ON p.id = b.property_id
       WHERE b.property_id = $1 AND b.status IN ('confirmed', 'checked_in')
         AND b.check_in < $2::date AND b.check_out > $2::date
         AND p.hk_service_every_days IS NOT NULL
         AND ($2::date - b.check_in) % p.hk_service_every_days = 0
         AND NOT EXISTS (SELECT 1 FROM hk_override o WHERE o.room_id = b.room_id AND o.date = $2::date AND o.action = 'skip')
       ON CONFLICT (room_id, date, kind) DO NOTHING RETURNING id`,
      [propertyId, date]
    ));
    // Extra cleans asked for by hand.
    take(await client.query(
      `INSERT INTO hk_job (property_id, room_id, date, kind, booking_id)
       SELECT o.property_id, o.room_id, o.date, 'extra',
              (SELECT b.id FROM booking b WHERE b.room_id = o.room_id AND b.check_in <= o.date AND b.check_out > o.date
                 AND b.status IN ('confirmed', 'checked_in') LIMIT 1)
       FROM hk_override o
       WHERE o.property_id = $1 AND o.date = $2::date AND o.action = 'clean'
       ON CONFLICT (room_id, date, kind) DO NOTHING RETURNING id`,
      [propertyId, date]
    ));
    // Arrivals into a room nobody leaves, when there are extras to place.
    take(await client.query(
      `INSERT INTO hk_job (property_id, room_id, date, kind, arriving_booking_id)
       SELECT b.property_id, b.room_id, $2::date, 'arrival', b.id
       FROM booking b
       WHERE b.property_id = $1 AND b.check_in = $2::date AND b.status IN ${LIVE}
         AND NOT EXISTS (SELECT 1 FROM hk_job j WHERE j.room_id = b.room_id AND j.date = $2::date AND j.kind = 'checkout')
         AND EXISTS (SELECT 1 FROM booking_extra be JOIN extra e ON e.id = be.extra_id
                     WHERE be.booking_id = b.id AND e.place_in_room)
       ON CONFLICT (room_id, date, kind) DO NOTHING RETURNING id`,
      [propertyId, date]
    ));
    // Jobs whose reason went away: cancelled booking, skip override, or a
    // removed clean override. Started work is never skipped.
    take(await client.query(
      `UPDATE hk_job j SET status = 'skipped'
       WHERE j.property_id = $1 AND j.date = $2::date AND j.status IN ('open', 'claimed')
         AND (
           (j.kind IN ('checkout', 'stayover') AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.id = j.booking_id AND b.status IN ${LIVE}))
           OR (j.kind = 'arrival' AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.id = j.arriving_booking_id AND b.status IN ${LIVE}))
           OR (j.kind = 'stayover' AND EXISTS (SELECT 1 FROM hk_override o WHERE o.room_id = j.room_id AND o.date = j.date AND o.action = 'skip'))
           OR (j.kind = 'extra' AND NOT EXISTS (SELECT 1 FROM hk_override o WHERE o.room_id = j.room_id AND o.date = j.date AND o.action = 'clean'))
         )
       RETURNING id`,
      [propertyId, date]
    ));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const id of touched) {
    const job = await module.exports.fetchJob(db, id, propertyId);
    if (job) publish(propertyId, 'job-updated', job);
  }
}

const KIND_ORDER = `array_position(ARRAY['checkout', 'arrival', 'extra', 'stayover']::varchar[], j.kind)`;

// One SELECT for both the board and a single job, so every publish carries
// exactly what the board shows.
const JOB_SQL = `
  SELECT j.*, r.room_number, r.floor, r.housekeeping_status, r.room_type_id, rt.name AS room_type_name,
    (SELECT json_build_object('booking_id', b.id, 'guest_name', g.first_name || ' ' || g.last_name,
                              'check_in', b.check_in, 'check_out', b.check_out, 'rate_plan_id', b.rate_plan_id)
       FROM booking b JOIN guest g ON g.id = b.guest_id WHERE b.id = j.booking_id) AS booking,
    (SELECT json_build_object('booking_id', b.id, 'guest_name', g.first_name || ' ' || g.last_name,
                              'arrival_time', b.metadata->>'arrival_time', 'check_out', b.check_out)
       FROM booking b JOIN guest g ON g.id = b.guest_id WHERE b.id = j.arriving_booking_id) AS arriving,
    COALESCE((SELECT json_agg(json_build_object('booking_extra_id', be.id, 'name', e.name, 'quantity', be.quantity,
                                                'placed_at', be.placed_at, 'placed_by', be.placed_by) ORDER BY e.name)
       FROM booking_extra be JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = j.arriving_booking_id AND e.place_in_room), '[]') AS extras_to_place,
    (SELECT json_build_object('id', c.cleaner_id, 'name', c.cleaner_name)
       FROM hk_clean c JOIN hk_job j2 ON j2.id = c.job_id
       WHERE j2.room_id = j.room_id AND j2.id <> j.id AND j2.date <= j.date AND c.finished_at IS NOT NULL
       ORDER BY c.finished_at DESC LIMIT 1) AS last_cleaner,
    (SELECT json_build_object('id', c.cleaner_id, 'name', max(c.cleaner_name))
       FROM hk_clean c JOIN hk_job j2 ON j2.id = c.job_id
       WHERE j.booking_id IS NOT NULL AND j2.booking_id = j.booking_id AND c.finished_at IS NOT NULL
       GROUP BY c.cleaner_id ORDER BY count(*) DESC, max(c.finished_at) DESC LIMIT 1) AS stay_cleaner,
    COALESCE((SELECT json_agg(c ORDER BY c.started_at) FROM hk_clean c WHERE c.job_id = j.id), '[]') AS attempts,
    COALESCE((SELECT json_agg(json_build_object(
                'id', i.id, 'clean_id', i.clean_id, 'inspector_id', i.inspector_id, 'inspector_name', i.inspector_name,
                'passed', i.passed, 'score', i.score, 'created_at', i.created_at,
                'scores', (SELECT json_agg(s ORDER BY s.item_name) FROM hk_inspection_score s WHERE s.inspection_id = i.id)
              ) ORDER BY i.created_at)
       FROM hk_inspection i WHERE i.job_id = j.id), '[]') AS inspections
  FROM hk_job j
  JOIN room r       ON r.id = j.room_id
  JOIN room_type rt ON rt.id = r.room_type_id`;

function shapeJob(row) {
  return {
    id: row.id,
    date: row.date,
    kind: row.kind,
    status: row.status,
    linen_due: row.linen_due,
    claimed_by: row.claimed_by,
    claimed_by_name: row.claimed_by_name,
    room: {
      id: row.room_id, room_number: row.room_number, floor: row.floor,
      housekeeping_status: row.housekeeping_status, room_type_id: row.room_type_id, room_type_name: row.room_type_name,
    },
    booking: row.booking,
    arriving: row.arriving,
    extras_to_place: row.extras_to_place,
    minibar: [],
    last_cleaner: row.last_cleaner,
    stay_cleaner: row.stay_cleaner,
    attempts: row.attempts,
    inspections: row.inspections,
  };
}

async function fetchJob(db, jobId, propertyId) {
  const { rows } = await db.query(`${JOB_SQL} WHERE j.id = $1 AND j.property_id = $2`, [jobId, propertyId]);
  return rows[0] ? shapeJob(rows[0]) : null;
}

// Dirty/unfinished rooms with someone arriving first, then by kind and room.
async function listJobs(db, propertyId, date) {
  const { rows } = await db.query(
    `${JOB_SQL} WHERE j.property_id = $1 AND j.date = $2::date
     ORDER BY (j.arriving_booking_id IS NOT NULL AND r.housekeeping_status <> 'ready') DESC, ${KIND_ORDER}, r.room_number`,
    [propertyId, date]
  );
  return rows.map(shapeJob);
}

// A guest left: the room needs cleaning, and today's board gets its job
// (normally already there from the expected departure).
async function onCheckedOut(propertyId, roomId) {
  if (!(await housekeepingEnabled(pool, propertyId))) return;
  await setRoomStatus(pool, propertyId, roomId, 'dirty');
  await module.exports.ensureJobs(pool, propertyId, await propertyToday(pool, propertyId));
}

// Inspection photos: public blob, random suffix (same call as
// marinaDocuments.putPublic). Seam -- the check script swaps it.
async function putPhoto(pathname, buf, contentType) {
  const r = await require('@vercel/blob').put(pathname, buf, {
    access: 'public', token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN, contentType, addRandomSuffix: true,
  });
  return r.url;
}

module.exports = {
  putPhoto, onCheckedOut,
  nightIndex, stayoverDue, linenDue, scoreInspection, statusAfterFinish,
  ROOM_STATUSES, housekeepingEnabled, propertyToday, staffName, publish, setRoomStatus,
  ensureJobs, fetchJob, listJobs,
};
