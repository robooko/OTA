const pool = require('../db');
const { isValidDate, isValidUuid } = require('../middleware/validate');

const TYPES = ['sold_out', 'price_change'];
const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Alerts from a client-side competitor price scraper. OTA keeps the alerts
// only. One open alert per night/room type/competitor/type: a repeat post
// updates it (keeping the first old_price, so it shows the whole move).
// Room type ids outside this property come back in unknown.
async function reportAlerts(req, res, next) {
  try {
    const list = req.body?.alerts;
    if (!Array.isArray(list) || !list.length || list.length > 500) {
      return res.status(400).json({ error: 'alerts must be an array of 1-500 alerts' });
    }
    const byKey = new Map(); // last one wins inside a batch (ON CONFLICT can't touch a row twice)
    for (const [i, a] of list.entries()) {
      const at = `alerts[${i}]`;
      if (!a || !isValidDate(a.night)) return res.status(400).json({ error: `${at}.night must be YYYY-MM-DD` });
      if (!isValidUuid(a.room_type_id)) return res.status(400).json({ error: `${at}.room_type_id must be a uuid` });
      if (typeof a.competitor !== 'string' || !a.competitor.trim() || a.competitor.length > 200) return res.status(400).json({ error: `${at}.competitor must be a string of 1-200 characters` });
      if (!TYPES.includes(a.type)) return res.status(400).json({ error: `${at}.type must be sold_out or price_change` });
      if (a.room_type_confirmed != null && typeof a.room_type_confirmed !== 'boolean') return res.status(400).json({ error: `${at}.room_type_confirmed must be a boolean` });
      for (const k of ['old_price', 'new_price']) {
        if (a.type === 'price_change' ? !isPrice(a[k]) : a[k] != null && !isPrice(a[k])) {
          return res.status(400).json({ error: `${at}.${k} must be a number >= 0${a.type === 'price_change' ? ' for price_change' : ''}` });
        }
      }
      const competitor = a.competitor.trim();
      byKey.set([a.night, a.room_type_id, competitor, a.type].join('|'), { ...a, competitor });
    }
    const rows = [...byKey.values()];
    const col = (k, d = null) => rows.map((a) => a[k] ?? d);
    const { rows: saved } = await pool.query(
      `INSERT INTO competitor_alert (property_id, night, room_type_id, room_type_confirmed, competitor, type, old_price, new_price)
       SELECT $1, x.night, rt.id, x.confirmed, x.competitor, x.type, x.old_price, x.new_price
       FROM unnest($2::date[], $3::uuid[], $4::boolean[], $5::text[], $6::text[], $7::numeric[], $8::numeric[])
            AS x(night, room_type_id, confirmed, competitor, type, old_price, new_price)
       JOIN room_type rt ON rt.id = x.room_type_id AND rt.property_id = $1
       ON CONFLICT (property_id, night, room_type_id, competitor, type) WHERE acknowledged_at IS NULL
       DO UPDATE SET room_type_confirmed = EXCLUDED.room_type_confirmed,
                     old_price = COALESCE(competitor_alert.old_price, EXCLUDED.old_price),
                     new_price = EXCLUDED.new_price,
                     updated_at = now()
       RETURNING room_type_id, (xmax = 0) AS created`,
      [req.property_id, col('night'), col('room_type_id'), col('room_type_confirmed', false), col('competitor'), col('type'), col('old_price'), col('new_price')]
    );
    const known = new Set(saved.map((r) => r.room_type_id));
    const created = saved.filter((r) => r.created).length;
    res.json({ created, updated: saved.length - created, unknown: [...new Set(col('room_type_id').filter((id) => !known.has(id)))] });
  } catch (err) { next(err); }
}

async function listAlerts(req, res, next) {
  try {
    const { from, to, room_type_id, type, acknowledged } = req.query;
    if (from && !isValidDate(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
    if (to && !isValidDate(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
    if (room_type_id && !isValidUuid(room_type_id)) return res.status(400).json({ error: 'room_type_id must be a uuid' });
    if (type && !TYPES.includes(type)) return res.status(400).json({ error: 'type must be sold_out or price_change' });
    if (acknowledged && !['true', 'false', 'all'].includes(acknowledged)) return res.status(400).json({ error: 'acknowledged must be true, false or all' });
    const params = [req.property_id];
    let where = 'a.property_id = $1';
    const add = (sql, v) => { params.push(v); where += ` AND ${sql.replace('?', `$${params.length}`)}`; };
    if (from) add('a.night >= ?', from);
    if (to) add('a.night < ?', to);
    if (room_type_id) add('a.room_type_id = ?', room_type_id);
    if (type) add('a.type = ?', type);
    if ((acknowledged || 'false') !== 'all') where += ` AND a.acknowledged_at IS ${acknowledged === 'true' ? 'NOT ' : ''}NULL`;
    const { rows } = await pool.query(
      `SELECT a.id, a.night, a.room_type_id, rt.name AS room_type_name,
              a.room_type_confirmed, a.competitor, a.type, a.old_price, a.new_price,
              a.created_at, a.updated_at, a.acknowledged_at
       FROM competitor_alert a JOIN room_type rt ON rt.id = a.room_type_id
       WHERE ${where}
       ORDER BY a.night, rt.name, a.competitor, a.type
       LIMIT 2000`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function acknowledgeAlert(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Alert not found' });
    const { rows } = await pool.query(
      `UPDATE competitor_alert SET acknowledged_at = COALESCE(acknowledged_at, now())
       WHERE id = $1 AND property_id = $2 RETURNING id, acknowledged_at`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { reportAlerts, listAlerts, acknowledgeAlert };
