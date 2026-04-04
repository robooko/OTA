const pool = require('../db');

async function listRoomTypes(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM room_type ORDER BY name');
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getRoomType(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM room_type WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Room type not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createRoomType(req, res, next) {
  try {
    const { name, description, max_occupancy, base_rate } = req.body;
    if (!name || max_occupancy == null || base_rate == null) {
      return res.status(400).json({ error: 'name, max_occupancy, and base_rate are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO room_type (name, description, max_occupancy, base_rate)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, max_occupancy, base_rate]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateRoomType(req, res, next) {
  try {
    const { name, description, max_occupancy, base_rate } = req.body;
    const { rows } = await pool.query(
      `UPDATE room_type SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         max_occupancy = COALESCE($3, max_occupancy),
         base_rate     = COALESCE($4, base_rate)
       WHERE id = $5 RETURNING *`,
      [name, description, max_occupancy, base_rate, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room type not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listRoomTypes, getRoomType, createRoomType, updateRoomType };
