const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

async function getRoomAvailability(req, res, next) {
  try {
    const { room_id } = req.params;
    const { from, to } = req.query;

    let query = 'SELECT * FROM room_availability WHERE room_id = $1';
    const params = [room_id];

    if (from && to) {
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }
      query += ' AND date >= $2 AND date < $3';
      params.push(from, to);
    }

    query += ' ORDER BY date';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getRoomTypeAvailability(req, res, next) {
  try {
    const { from, to, room_type_id } = req.query;

    let query = 'SELECT * FROM room_type_availability WHERE 1=1';
    const params = [];

    if (from) {
      if (!isValidDate(from)) return res.status(400).json({ error: 'Invalid from date' });
      params.push(from);
      query += ` AND date >= $${params.length}`;
    }
    if (to) {
      if (!isValidDate(to)) return res.status(400).json({ error: 'Invalid to date' });
      params.push(to);
      query += ` AND date < $${params.length}`;
    }
    if (room_type_id) {
      params.push(room_type_id);
      query += ` AND room_type_id = $${params.length}`;
    }

    query += ' ORDER BY date';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function searchAvailability(req, res, next) {
  try {
    const { check_in, check_out, guests } = req.query;

    if (!check_in || !check_out || !guests) {
      return res.status(400).json({ error: 'check_in, check_out, and guests are required' });
    }
    if (!isValidDate(check_in) || !isValidDate(check_out)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    if (check_in >= check_out) {
      return res.status(400).json({ error: 'check_in must be before check_out' });
    }

    const { rows } = await pool.query(
      `SELECT
         rta.room_type_id,
         rt.name,
         rt.description,
         rt.max_occupancy,
         MIN(rta.available_rooms) AS min_available,
         MIN(rta.min_rate)        AS from_rate
       FROM room_type_availability rta
       JOIN room_type rt ON rt.id = rta.room_type_id
       WHERE rta.date >= $1
         AND rta.date <  $2
         AND rt.max_occupancy >= $3
       GROUP BY rta.room_type_id, rt.name, rt.description, rt.max_occupancy
       HAVING MIN(rta.available_rooms) > 0
       ORDER BY from_rate ASC`,
      [check_in, check_out, parseInt(guests, 10)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function upsertRoomAvailability(req, res, next) {
  try {
    const { room_id } = req.params;
    const { dates } = req.body;

    if (!Array.isArray(dates) || !dates.length) {
      return res.status(400).json({ error: 'dates array is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const entry of dates) {
        const { date, is_available, override_rate, block_reason } = entry;
        if (!isValidDate(date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Invalid date: ${date}` });
        }
        const { rows } = await client.query(
          `INSERT INTO room_availability (room_id, date, is_available, override_rate, block_reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (room_id, date) DO UPDATE SET
             is_available  = EXCLUDED.is_available,
             override_rate = EXCLUDED.override_rate,
             block_reason  = EXCLUDED.block_reason
           RETURNING *`,
          [room_id, date, is_available ?? true, override_rate ?? null, block_reason ?? null]
        );
        results.push(rows[0]);
      }
      await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
      await client.query('COMMIT');
      res.json(results);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
}

async function listOverrides(req, res, next) {
  try {
    const { room_id, from, to } = req.query;
    let query = `
      SELECT ra.*, r.room_number, rt.name AS room_type_name, rt.base_rate
      FROM room_availability ra
      JOIN room r ON r.id = ra.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      WHERE ra.override_rate IS NOT NULL
    `;
    const params = [];
    if (room_id) { params.push(room_id); query += ` AND ra.room_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND ra.date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND ra.date <= $${params.length}`; }
    query += ' ORDER BY ra.date, r.room_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function deleteOverride(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE room_availability
       SET override_rate = NULL, block_reason = NULL
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Availability record not found' });
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function refreshView(req, res, next) {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    res.json({ message: 'Materialized view refreshed' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getRoomAvailability,
  getRoomTypeAvailability,
  searchAvailability,
  upsertRoomAvailability,
  listOverrides,
  deleteOverride,
  refreshView,
};
