const pool = require('../db');

async function listRooms(req, res, next) {
  try {
    const { room_type_id } = req.query;
    let query = `
      SELECT r.*, rt.name AS room_type_name
      FROM room r
      JOIN room_type rt ON rt.id = r.room_type_id
    `;
    const params = [];
    if (room_type_id) {
      query += ' WHERE r.room_type_id = $1';
      params.push(room_type_id);
    }
    query += ' ORDER BY r.room_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getRoom(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, rt.name AS room_type_name
       FROM room r
       JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createRoom(req, res, next) {
  try {
    const { room_type_id, room_number, floor, status } = req.body;
    if (!room_type_id || !room_number) {
      return res.status(400).json({ error: 'room_type_id and room_number are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO room (room_type_id, room_number, floor, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [room_type_id, room_number, floor || null, status || 'active']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Room number already exists' });
    if (err.code === '23503') return res.status(400).json({ error: 'Invalid room_type_id' });
    next(err);
  }
}

async function updateRoom(req, res, next) {
  try {
    const { room_type_id, room_number, floor, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE room SET
         room_type_id = COALESCE($1, room_type_id),
         room_number  = COALESCE($2, room_number),
         floor        = COALESCE($3, floor),
         status       = COALESCE($4, status)
       WHERE id = $5 RETURNING *`,
      [room_type_id, room_number, floor, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Room number already exists' });
    next(err);
  }
}

module.exports = { listRooms, getRoom, createRoom, updateRoom };
