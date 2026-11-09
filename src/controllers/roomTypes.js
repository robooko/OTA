const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { HORIZON_DAYS } = require('../lib/availabilitySeeder');
const { refreshAvailabilityView } = require('../lib/roomPayments');

function isValidFloorPlan(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidCode(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 3;
}

// Hotel label grouping room types within one property: trimmed, 1-100 chars.
function parseHotel(v) {
  if (v == null) return null;
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > 100) throw Object.assign(new Error('hotel must be a string of 1 to 100 characters, or null'), { status: 400 });
  return t;
}

// Unique index idx_room_type_property_code -> 409 instead of a 500.
function codeTaken(err) {
  if (err.code === '23505' && err.constraint === 'idx_room_type_property_code') {
    return Object.assign(new Error('code is already used by another room type'), { status: 409 });
  }
  return err;
}


async function listRoomTypes(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM room_type WHERE status = 'active' AND property_id = $1
       AND ($2::text IS NULL OR hotel = $2) ORDER BY name`,
      [req.property_id, req.query.hotel || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getRoomType(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM room_type WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room type not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createRoomType(req, res, next) {
  try {
    const { name, code, description, max_occupancy, base_rate } = req.body;
    const hotel = parseHotel(req.body.hotel);
    if (!name || max_occupancy == null || base_rate == null) {
      return res.status(400).json({ error: 'name, max_occupancy, and base_rate are required' });
    }
    if (code != null && !isValidCode(code)) {
      return res.status(400).json({ error: 'code must be a string of 1 to 3 characters' });
    }
    const { rows } = await pool.query(
      `INSERT INTO room_type (property_id, name, code, description, max_occupancy, base_rate, hotel)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, name, code ?? null, description || null, max_occupancy, base_rate, hotel]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(codeTaken(err));
  }
}

async function updateRoomType(req, res, next) {
  try {
    const { name, code, description, max_occupancy, base_rate, status, floor_plan } = req.body;
    const hotel = parseHotel(req.body.hotel);
    if (floor_plan !== undefined && !isValidFloorPlan(floor_plan)) {
      return res.status(400).json({ error: 'floor_plan must be a JSON object' });
    }
    if (code != null && !isValidCode(code)) {
      return res.status(400).json({ error: 'code must be a string of 1 to 3 characters, or null to clear it' });
    }
    const { rows } = await pool.query(
      `UPDATE room_type SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         max_occupancy = COALESCE($3, max_occupancy),
         base_rate     = COALESCE($4, base_rate),
         status        = COALESCE($5, status),
         floor_plan    = COALESCE($6::jsonb, floor_plan),
         code          = CASE WHEN $9 THEN $10 ELSE code END,
         hotel         = CASE WHEN $11 THEN $12 ELSE hotel END
       WHERE id = $7 AND property_id = $8 RETURNING *`,
      [name, description, max_occupancy, base_rate, status, floor_plan ?? null, req.params.id, req.property_id,
       code !== undefined, code ?? null, req.body.hotel !== undefined, hotel]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room type not found' });

    // base_rate feeds the materialized view's min_rate -- without this,
    // search keeps quoting the old rate until an unrelated availability
    // write happens to refresh the view.
    if (base_rate != null) await refreshAvailabilityView();

    res.json(rows[0]);
  } catch (err) {
    next(codeTaken(err));
  }
}

async function listRoomTypeRates(req, res, next) {
  try {
    const { from, to } = req.query;
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const typeCheck = await pool.query(
      'SELECT id FROM room_type WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!typeCheck.rows.length) return res.status(404).json({ error: 'Room type not found' });

    let query = `
      SELECT rtr.id, rtr.room_type_id, rtr.date, rtr.rate, rt.base_rate
      FROM room_type_rate rtr
      JOIN room_type rt ON rt.id = rtr.room_type_id
      WHERE rtr.room_type_id = $1 AND rtr.property_id = $2`;
    const params = [req.params.id, req.property_id];
    if (from) { params.push(from); query += ` AND rtr.date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND rtr.date < $${params.length}`; }
    query += ' ORDER BY rtr.date';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function upsertRoomTypeRates(req, res, next) {
  try {
    const { rates } = req.body;
    if (!Array.isArray(rates) || !rates.length) {
      return res.status(400).json({ error: 'rates array is required' });
    }

    const typeCheck = await pool.query(
      'SELECT id FROM room_type WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!typeCheck.rows.length) return res.status(404).json({ error: 'Room type not found' });

    // Validate every entry before writing anything (all-or-nothing).
    for (const entry of rates) {
      const { from, to, rate } = entry;
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'Each entry needs from and to as YYYY-MM-DD' });
      }
      if (from >= to) {
        return res.status(400).json({ error: `from must be before to (to is exclusive): ${from} >= ${to}` });
      }
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > HORIZON_DAYS) {
        return res.status(400).json({ error: `Range exceeds the ${HORIZON_DAYS}-day horizon` });
      }
      if (rate !== null && !(typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) {
        return res.status(400).json({ error: 'rate must be a number > 0, or null to clear the range' });
      }
    }

    const client = await pool.connect();
    let upserted = 0;
    let deleted = 0;
    try {
      await client.query('BEGIN');
      // Entries apply in array order -- overlapping ranges are last-wins.
      for (const { from, to, rate } of rates) {
        if (rate === null) {
          const { rowCount } = await client.query(
            `DELETE FROM room_type_rate
             WHERE room_type_id = $1 AND property_id = $2 AND date >= $3 AND date < $4`,
            [req.params.id, req.property_id, from, to]
          );
          deleted += rowCount;
        } else {
          const { rowCount } = await client.query(
            `INSERT INTO room_type_rate (property_id, room_type_id, date, rate)
             SELECT $1, $2, d::date, $5
             FROM generate_series($3::timestamp, $4::timestamp - interval '1 day', interval '1 day') d
             ON CONFLICT (room_type_id, date) DO UPDATE SET rate = EXCLUDED.rate`,
            [req.property_id, req.params.id, from, to, rate]
          );
          upserted += rowCount;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await refreshAvailabilityView();
    res.json({ upserted, deleted });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRoomTypes, getRoomType, createRoomType, updateRoomType, listRoomTypeRates, upsertRoomTypeRates };
