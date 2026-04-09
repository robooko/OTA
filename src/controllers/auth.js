const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '24h';

async function register(req, res, next) {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const validRoles = ['admin', 'staff', 'guest'];
    const assignedRole = validRoles.includes(role) ? role : 'staff';

    const existing = await pool.query('SELECT id FROM api_user WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO api_user (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [name, email, password_hash, assignedRole]
    );

    const token = jwt.sign({ id: rows[0].id, role: rows[0].role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.status(201).json({ user: rows[0], token });
  } catch (err) { next(err); }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await pool.query(
      'SELECT * FROM api_user WHERE email = $1', [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: rows[0].id, role: rows[0].role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role }, token });
  } catch (err) { next(err); }
}

async function me(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at FROM api_user WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id, name, email, role, created_at FROM api_user ORDER BY created_at');
    res.json(rows);
  } catch (err) { next(err); }
}

async function updateUser(req, res, next) {
  try {
    const { name, role } = req.body;
    const validRoles = ['admin', 'staff', 'guest'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const { rows } = await pool.query(
      `UPDATE api_user SET
         name = COALESCE($1, name),
         role = COALESCE($2, role)
       WHERE id = $3 RETURNING id, name, email, role`,
      [name, role, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = { register, login, me, listUsers, updateUser };
