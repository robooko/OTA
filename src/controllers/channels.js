// Channel distribution API (spec 2026-11-04-channel-distribution-design §6).
// Every route is property-scoped: another property's channel is a 404.
const pool = require('../db');
const { isValidDate, isValidUuid } = require('../middleware/validate');
const { HORIZON_DAYS } = require('../lib/availabilitySeeder');
const { ADAPTERS } = require('../lib/channels');
const { drift, syncChannel, requestSync } = require('../lib/channels/sync');
const { receiveReservation } = require('../lib/channels/reservations');

const COLLECT = ['hotel', 'channel'];
const DRIFT_MAX = 500;

// Adapter settings may hold credentials: only the test switch is shown as is.
function present(ch) {
  const config = Object.fromEntries(Object.entries(ch.config || {}).map(([k, v]) => [k, k === 'fail_pushes' ? v : '***']));
  return { ...ch, config };
}

async function loadChannel(req, res) {
  if (!isValidUuid(req.params.id)) { res.status(404).json({ error: 'Channel not found' }); return null; }
  const ch = (await pool.query('SELECT * FROM channel WHERE id = $1 AND property_id = $2', [req.params.id, req.property_id])).rows[0];
  if (!ch) res.status(404).json({ error: 'Channel not found' });
  return ch || null;
}

// Shared by create and update; returns an error message or null.
function invalidSettings(b, adapter) {
  if (b.name !== undefined && !(typeof b.name === 'string' && b.name.trim() && b.name.length <= 100)) return 'name must be 1-100 characters';
  if (b.horizon_days !== undefined && !(Number.isInteger(b.horizon_days) && b.horizon_days >= 1 && b.horizon_days <= HORIZON_DAYS)) {
    return `horizon_days must be a whole number from 1 to ${HORIZON_DAYS}`;
  }
  if (b.collect !== undefined && !COLLECT.includes(b.collect)) return 'collect must be hotel or channel';
  if (b.config !== undefined) {
    if (!b.config || typeof b.config !== 'object' || Array.isArray(b.config)) return 'config must be an object';
    const errors = adapter.validateConfig(b.config);
    if (errors.length) return { error: 'Invalid config', details: errors.join('; ') };
  }
  return null;
}
const sendInvalid = (res, bad) => res.status(400).json(typeof bad === 'string' ? { error: bad } : bad);

async function listChannels(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM channel WHERE property_id = $1 ORDER BY created_at', [req.property_id]);
    res.json(rows.map(present));
  } catch (err) { next(err); }
}

async function createChannel(req, res, next) {
  try {
    const b = req.body || {};
    const adapter = ADAPTERS[b.adapter];
    if (!adapter) return res.status(400).json({ error: 'Unknown adapter', details: `One of: ${Object.keys(ADAPTERS).join(', ')}` });
    if (b.name === undefined) return res.status(400).json({ error: 'name is required' });
    const bad = invalidSettings(b, adapter);
    if (bad) return sendInvalid(res, bad);
    const { rows } = await pool.query(
      `INSERT INTO channel (property_id, adapter, name, horizon_days, collect, config)
       VALUES ($1, $2, $3, COALESCE($4, 365), COALESCE($5, 'hotel'), COALESCE($6, '{}'::jsonb)) RETURNING *`,
      [req.property_id, b.adapter, b.name.trim(), b.horizon_days ?? null, b.collect ?? null, b.config ? JSON.stringify(b.config) : null]
    );
    res.status(201).json(present(rows[0]));
  } catch (err) { next(err); }
}

async function getChannel(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const [{ rows: mappings }, { rows: trims }] = await Promise.all([
      pool.query('SELECT * FROM channel_mapping WHERE channel_id = $1 ORDER BY room_code, rate_code', [ch.id]),
      pool.query('SELECT * FROM channel_trim WHERE channel_id = $1 ORDER BY date_from, id', [ch.id]),
    ]);
    res.json({ ...present(ch), mappings, trims });
  } catch (err) { next(err); }
}

// status: 'paused' starts a close-out (pausing -> paused once the channel has
// taken 0 everywhere); 'active' resumes, and the next sync re-sends everything.
async function updateChannel(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const b = req.body || {};
    const bad = invalidSettings(b, ADAPTERS[ch.adapter] || { validateConfig: () => [] });
    if (bad) return sendInvalid(res, bad);
    if (b.status !== undefined && !['active', 'paused'].includes(b.status)) return res.status(400).json({ error: 'status must be active or paused' });
    let status = ch.status;
    if (b.status === 'paused' && ch.status === 'active') status = 'pausing';
    if (b.status === 'active') status = 'active';
    const { rows } = await pool.query(
      `UPDATE channel SET name = COALESCE($2, name), horizon_days = COALESCE($3, horizon_days), collect = COALESCE($4, collect),
         config = COALESCE($5, config), status = $6
       WHERE id = $1 RETURNING *`,
      [ch.id, b.name?.trim() ?? null, b.horizon_days ?? null, b.collect ?? null, b.config ? JSON.stringify(b.config) : null, status]
    );
    requestSync();
    res.json(present(rows[0]));
  } catch (err) { next(err); }
}

async function deleteChannel(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    if (ch.status !== 'paused') return res.status(409).json({ error: 'Pause the channel first', details: 'Pausing closes it out on the channel before it is removed' });
    const used = (await pool.query('SELECT 1 FROM booking WHERE channel_id = $1 LIMIT 1', [ch.id])).rows.length;
    if (used) return res.status(409).json({ error: 'This channel has bookings; keep it paused instead' });
    await pool.query('DELETE FROM channel WHERE id = $1', [ch.id]);
    res.status(204).end();
  } catch (err) { next(err); }
}

// Replace the mapping list: listed codes are kept/updated/added; mappings left
// out become 'closing' (closed out on the channel, then removed by sync).
async function replaceMappings(req, res, next) {
  const ch = await loadChannel(req, res).catch(next);
  if (!ch) return;
  const { mappings } = req.body || {};
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array is required' });
  const seen = new Set();
  for (const m of mappings) {
    if (!m || !isValidUuid(m.room_type_id)) return res.status(400).json({ error: 'Each mapping needs a room_type_id' });
    if (m.rate_plan_id != null && !isValidUuid(m.rate_plan_id)) return res.status(400).json({ error: 'rate_plan_id must be a uuid or null' });
    for (const k of ['room_code', 'rate_code']) {
      if (!(typeof m[k] === 'string' && m[k].trim() && m[k].length <= 64)) return res.status(400).json({ error: `Each mapping needs ${k} (1-64 characters)` });
    }
    const key = `${m.room_code}\u0000${m.rate_code}`;
    if (seen.has(key)) return res.status(400).json({ error: `Duplicate codes ${m.room_code}/${m.rate_code}` });
    seen.add(key);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of mappings) {
      const ok = (await client.query(
        `SELECT 1 FROM room_type rt
         WHERE rt.id = $1 AND rt.property_id = $2
           AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM rate_plan rp WHERE rp.id = $3 AND rp.room_type_id = rt.id AND rp.property_id = $2))`,
        [m.room_type_id, req.property_id, m.rate_plan_id ?? null])).rows.length;
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Room type or rate plan not found', details: `${m.room_code}/${m.rate_code}: the rate plan must belong to the room type` });
      }
      await client.query(
        `INSERT INTO channel_mapping (property_id, channel_id, room_type_id, rate_plan_id, room_code, rate_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel_id, room_code, rate_code) DO UPDATE SET
           room_type_id = EXCLUDED.room_type_id, rate_plan_id = EXCLUDED.rate_plan_id, status = 'active'`,
        [req.property_id, ch.id, m.room_type_id, m.rate_plan_id ?? null, m.room_code, m.rate_code]);
    }
    await client.query(
      `UPDATE channel_mapping SET status = 'closing'
       WHERE channel_id = $1 AND NOT ((room_code, rate_code) IN (SELECT * FROM unnest($2::text[], $3::text[])))`,
      [ch.id, mappings.map((m) => m.room_code), mappings.map((m) => m.rate_code)]);
    await client.query('COMMIT');
    requestSync();
    const { rows } = await pool.query('SELECT * FROM channel_mapping WHERE channel_id = $1 ORDER BY room_code, rate_code', [ch.id]);
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

async function listTrims(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const { rows } = await pool.query('SELECT * FROM channel_trim WHERE channel_id = $1 ORDER BY date_from, id', [ch.id]);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTrim(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const { room_type_id = null, date_from, date_to, max_available = null, stop_sell = false } = req.body || {};
    if (!isValidDate(date_from) || !isValidDate(date_to)) return res.status(400).json({ error: 'date_from and date_to are required (YYYY-MM-DD)' });
    if (date_from > date_to) return res.status(400).json({ error: 'date_from must not be after date_to (both inclusive)' });
    if (max_available !== null && !(Number.isInteger(max_available) && max_available >= 0)) return res.status(400).json({ error: 'max_available must be a whole number >= 0 or null' });
    if (typeof stop_sell !== 'boolean') return res.status(400).json({ error: 'stop_sell must be true or false' });
    if (max_available === null && !stop_sell) return res.status(400).json({ error: 'A trim needs max_available or stop_sell' });
    if (room_type_id !== null) {
      const ok = isValidUuid(room_type_id) && (await pool.query('SELECT 1 FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id])).rows.length;
      if (!ok) return res.status(400).json({ error: 'Room type not found' });
    }
    const { rows } = await pool.query(
      `INSERT INTO channel_trim (property_id, channel_id, room_type_id, date_from, date_to, max_available, stop_sell)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, ch.id, room_type_id, date_from, date_to, max_available, stop_sell]);
    requestSync();
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function deleteTrim(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const { rowCount } = isValidUuid(req.params.trim_id)
      ? await pool.query('DELETE FROM channel_trim WHERE id = $1 AND channel_id = $2', [req.params.trim_id, ch.id])
      : { rowCount: 0 };
    if (!rowCount) return res.status(404).json({ error: 'Trim not found' });
    requestSync();
    res.status(204).end();
  } catch (err) { next(err); }
}

async function syncNow(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    res.json(await syncChannel(ch.id));
  } catch (err) { next(err); }
}

async function getDrift(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const { from, to } = req.query;
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    const d = await drift(pool, ch, { from, to });
    res.json({ ...d, total: d.changes.length, changes: d.changes.slice(0, DRIFT_MAX) });
  } catch (err) { next(err); }
}

async function listInbound(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const { rows } = await pool.query(
      'SELECT * FROM channel_reservation_log WHERE channel_id = $1 ORDER BY received_at DESC, id DESC LIMIT $2', [ch.id, limit]);
    res.json(rows);
  } catch (err) { next(err); }
}

async function testReservation(req, res, next) {
  try {
    const ch = await loadChannel(req, res);
    if (!ch) return;
    if (ch.adapter !== 'test') return res.status(404).json({ error: 'Not a test channel' });
    const r = await receiveReservation(ch, req.body);
    res.status(r.outcome === 'created' ? 201 : r.outcome === 'rejected' ? 409 : 200).json(r);
  } catch (err) { next(err); }
}

module.exports = {
  listChannels, createChannel, getChannel, updateChannel, deleteChannel, replaceMappings,
  listTrims, createTrim, deleteTrim, syncNow, getDrift, listInbound, testReservation,
};
