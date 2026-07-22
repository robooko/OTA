const jwt = require('jsonwebtoken');
const pool = require('../db');
const { isValidUuid } = require('./validate');

const JWT_SECRET = process.env.JWT_SECRET;

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.property_id = req.user.property_id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
  }

  const property_id = req.body.property_id || req.query.property_id;
  if (!property_id || !isValidUuid(property_id)) {
    return res.status(400).json({ error: 'property_id is required and must be a valid UUID when authenticating with X-Api-Key' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE id = $1', [property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Property not found' });
    req.property_id = property_id;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateOrApiKey, requireRole };
