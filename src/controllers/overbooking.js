// Room overbooking: the per-property switch and cap, oversell allowances (the
// model's and a manager's override), the per-night overview and the front
// desk's oversold arrivals. See docs/superpowers/specs/2026-11-05-room-overbooking-design.md.
const pool = require('../db');
const { isValidDate, isValidUuid } = require('../middleware/validate');
const roomNights = require('../lib/roomNights');
const { refreshAvailabilityView, NIGHTS_SQL } = require('../lib/roomPayments');

const MAX_ROWS = 5000;
const MAX_DAYS = 400;
const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= 10000;
const bad = (res, error, details) => res.status(400).json(details === undefined ? { error } : { error, details });

function nightsBetween(from, to) {
  const out = [];
  for (let n = from; n < to && out.length <= MAX_DAYS; n = roomNights.addDaysIso(n, 1)) out.push(n);
  return out;
}

const settingsOf = (p) => ({ enabled: p.overbooking_enabled, max_pct: Number(p.oversell_max_pct), room_lock_days: p.room_lock_days });

// PUT /api/overbooking/settings { enabled?, max_pct?, room_lock_days? }
async function putSettings(req, res, next) {
  try {
    const { enabled, max_pct, room_lock_days } = req.body ?? {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return bad(res, 'enabled must be true or false');
    if (max_pct !== undefined && !(typeof max_pct === 'number' && max_pct >= 0 && max_pct <= 100)) return bad(res, 'max_pct must be a number from 0 to 100');
    if (room_lock_days !== undefined && !(Number.isInteger(room_lock_days) && room_lock_days >= 0 && room_lock_days <= 30)) {
      return bad(res, 'room_lock_days must be a whole number from 0 to 30');
    }
    const { rows: [p] } = await pool.query(
      `UPDATE property SET overbooking_enabled = COALESCE($2, overbooking_enabled),
              oversell_max_pct = COALESCE($3, oversell_max_pct), room_lock_days = COALESCE($4, room_lock_days)
       WHERE id = $1 RETURNING overbooking_enabled, oversell_max_pct, room_lock_days`,
      [req.property_id, enabled ?? null, max_pct ?? null, room_lock_days ?? null]);
    await refreshAvailabilityView();
    res.json(settingsOf(p));
  } catch (err) { next(err); }
}

// GET /api/overbooking/settings
async function getSettings(req, res, next) {
  try {
    const { rows: [p] } = await pool.query(
      'SELECT overbooking_enabled, oversell_max_pct, room_lock_days FROM property WHERE id = $1', [req.property_id]);
    res.json(settingsOf(p));
  } catch (err) { next(err); }
}

// POST /api/overbooking/allowances { model, from, to, allowances: [{ room_type_id, date, allowance }] }
// Replaces the model's allowances for [from, to): nights it leaves out go to
// 0, so a stale value can't keep overselling. Manual overrides are untouched.
async function postAllowances(req, res, next) {
  const { model, from, to, allowances } = req.body ?? {};
  if (typeof model !== 'string' || !model.trim() || model.length > 100) return bad(res, 'model must be a string of 1-100 characters');
  if (!isValidDate(from) || !isValidDate(to) || from >= to) return bad(res, 'from and to must be YYYY-MM-DD with from before to');
  if (nightsBetween(from, to).length > MAX_DAYS) return bad(res, `from-to spans at most ${MAX_DAYS} days`);
  if (!Array.isArray(allowances) || allowances.length > MAX_ROWS) return bad(res, `allowances must be an array of at most ${MAX_ROWS}`);
  for (const [i, a] of allowances.entries()) {
    if (!a || !isValidUuid(a.room_type_id)) return bad(res, `allowances[${i}].room_type_id must be a uuid`);
    if (!isValidDate(a.date) || a.date < from || a.date >= to) return bad(res, `allowances[${i}].date must be in [from, to)`);
    if (!isCount(a.allowance)) return bad(res, `allowances[${i}].allowance must be a whole number >= 0`);
  }
  const typeIds = [...new Set(allowances.map((a) => a.room_type_id))];
  const client = await pool.connect();
  try {
    const { rows: own } = await client.query('SELECT id FROM room_type WHERE property_id = $1 AND id = ANY($2::uuid[])', [req.property_id, typeIds]);
    const unknown = typeIds.filter((t) => !own.some((o) => o.id === t));
    if (unknown.length) return bad(res, 'Room types not found in this property', unknown);
    await client.query('BEGIN');
    await client.query(
      `UPDATE room_type_oversell SET model_allowance = 0, model = $4, updated_at = now()
       WHERE property_id = $1 AND date >= $2 AND date < $3`, [req.property_id, from, to, model.trim()]);
    if (allowances.length) {
      await client.query(
        `INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance, model)
         SELECT $1, x.t, x.d, x.a, $5 FROM unnest($2::uuid[], $3::date[], $4::int[]) AS x(t, d, a)
         ON CONFLICT (room_type_id, date) DO UPDATE SET model_allowance = EXCLUDED.model_allowance, model = EXCLUDED.model, updated_at = now()`,
        [req.property_id, allowances.map((a) => a.room_type_id), allowances.map((a) => a.date), allowances.map((a) => a.allowance), model.trim()]);
    }
    await client.query('COMMIT');
    await refreshAvailabilityView();
    res.json({ saved: allowances.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// PUT /api/overbooking/allowances/:room_type_id/:date { manual_allowance: n | null }
// A manager's override for one night; null hands it back to the model.
async function putManual(req, res, next) {
  try {
    const { room_type_id, date } = req.params;
    const manual = req.body?.manual_allowance;
    if (!isValidUuid(room_type_id) || !isValidDate(date)) return bad(res, 'room_type_id must be a uuid and date YYYY-MM-DD');
    if (manual !== null && !isCount(manual)) return bad(res, 'manual_allowance must be a whole number >= 0, or null');
    const type = (await pool.query('SELECT id FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id])).rows[0];
    if (!type) return res.status(404).json({ error: 'Room type not found' });
    const { rows: [row] } = await pool.query(
      `INSERT INTO room_type_oversell (property_id, room_type_id, date, manual_allowance) VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_type_id, date) DO UPDATE SET manual_allowance = EXCLUDED.manual_allowance, updated_at = now()
       RETURNING room_type_id, date::text, model_allowance, manual_allowance, model`,
      [req.property_id, room_type_id, date, manual]);
    await refreshAvailabilityView();
    res.json(row);
  } catch (err) { next(err); }
}

// GET /api/overbooking?from&to[&room_type_id] -- per night x room type.
async function getOverview(req, res, next) {
  try {
    const { from, to, room_type_id } = req.query;
    if (!isValidDate(from) || !isValidDate(to) || from >= to) return bad(res, 'from and to must be YYYY-MM-DD with from before to');
    if (room_type_id !== undefined && !isValidUuid(room_type_id)) return bad(res, 'room_type_id must be a uuid');
    const nights = nightsBetween(from, to);
    if (nights.length > MAX_DAYS) return bad(res, `from-to spans at most ${MAX_DAYS} days`);
    const counts = await roomNights.typeCounts(pool, req.property_id, room_type_id ?? null, nights);
    res.json([...counts.values()]
      .sort((a, b) => a.night.localeCompare(b.night) || a.room_type_id.localeCompare(b.room_type_id))
      .map((c) => ({
        room_type_id: c.room_type_id, date: c.night, rooms: c.rooms, sold: c.sold, model_allowance: c.model,
        manual_allowance: c.manual, cap: c.cap, effective_allowance: c.allowance, sellable: c.sellable, unplaced: c.unplaced,
      })));
  } catch (err) { next(err); }
}

// GET /api/overbooking/arrivals?date -- the front desk's warning: guests
// arriving (or in house) with no room that night, and the rooms still free.
async function getArrivals(req, res, next) {
  try {
    const { date } = req.query;
    if (!isValidDate(date)) return bad(res, 'date must be YYYY-MM-DD');
    const { rows: waiting } = await pool.query(
      `SELECT b.id, b.status, b.check_in::text, b.check_out::text, b.room_type_id, rt.name AS room_type_name, rt.code AS room_type_code,
              g.first_name, g.last_name, ${NIGHTS_SQL}
       FROM booking_night bn JOIN booking b ON b.id = bn.booking_id
       JOIN guest g ON g.id = b.guest_id JOIN room_type rt ON rt.id = b.room_type_id
       WHERE bn.property_id = $1 AND bn.night = $2 AND bn.room_id IS NULL AND b.status = ANY($3::text[])
       ORDER BY b.created_at`, [req.property_id, date, roomNights.HOLDING]);
    const { rows: free } = await pool.query(
      `SELECT r.room_type_id, json_agg(json_build_object('id', r.id, 'room_number', r.room_number) ORDER BY r.room_number) AS rooms
       FROM room r JOIN room_availability ra ON ra.room_id = r.id AND ra.date = $2
       WHERE r.property_id = $1 AND r.status = 'active' AND ra.is_available
         AND NOT EXISTS (SELECT 1 FROM booking_night h WHERE h.room_id = r.id AND h.night = $2)
       GROUP BY r.room_type_id ORDER BY r.room_type_id`, [req.property_id, date]);
    res.json({
      unplaced_arrivals: waiting.filter((b) => b.check_in === date),
      unplaced_in_house: waiting.filter((b) => b.check_in !== date),
      free_rooms: free,
    });
  } catch (err) { next(err); }
}

// GET /api/overbooking/pace?days=90 -- booking pace per coming night: rooms
// on the books today vs. what the same weekday usually had at that lead time
// (mean over the past year's nights, since this property's first stay).
// Net of cancellations both sides: bookings carry no cancelled date, so a
// cancelled one never counted. Imported bookings carry their real lead time
// in metadata.lead_time (created_at is the import date).
// ponytail: correlated subqueries, O(nights x past nights x bookings) -- a
// pickup snapshot table if a property outgrows a year of a few thousand stays.
const PACE_SQL = `
WITH h AS (
  SELECT check_in, check_out,
         CASE WHEN metadata->>'lead_time' ~ '^[0-9]+$' THEN check_in - (metadata->>'lead_time')::int
              ELSE created_at::date END AS booked_on
    FROM booking
   WHERE property_id = $1 AND status IN ('pending_payment', 'confirmed', 'checked_in', 'checked_out')
     AND check_out > current_date - 365
),
past AS (
  SELECT d::date AS night
    FROM generate_series(GREATEST(current_date - 364, (SELECT min(check_in) FROM h)), current_date - 1, interval '1 day') d
),
f AS (SELECT d::date AS night FROM generate_series(current_date, current_date + $2::int - 1, interval '1 day') d)
SELECT f.night::text AS date, f.night - current_date AS lead,
       (SELECT count(*) FROM h WHERE f.night >= h.check_in AND f.night < h.check_out AND h.booked_on <= current_date)::int AS on_books,
       (SELECT count(*) FROM past p WHERE extract(dow FROM p.night) = extract(dow FROM f.night))::int AS samples,
       (SELECT count(*) FROM past p JOIN h ON p.night >= h.check_in AND p.night < h.check_out
                                      AND h.booked_on <= p.night - (f.night - current_date)
         WHERE extract(dow FROM p.night) = extract(dow FROM f.night))::int AS past_total
  FROM f ORDER BY f.night`;

async function getPace(req, res, next) {
  try {
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 180) return bad(res, 'days must be a whole number from 1 to 180');
    const [{ rows }, { rows: [{ rooms }] }] = await Promise.all([
      pool.query(PACE_SQL, [req.property_id, days]),
      pool.query(`SELECT count(*)::int AS rooms FROM room r JOIN room_type rt ON rt.id = r.room_type_id
                   WHERE r.property_id = $1 AND r.status = 'active' AND rt.status = 'active'`, [req.property_id]),
    ]);
    res.json({
      rooms,
      nights: rows.map((r) => ({
        date: r.date, lead: r.lead, on_books: r.on_books, samples: r.samples,
        expected: r.samples ? Math.round((r.past_total / r.samples) * 10) / 10 : null,
      })),
    });
  } catch (err) { next(err); }
}

module.exports = { getSettings, putSettings, postAllowances, putManual, getOverview, getArrivals, getPace };
