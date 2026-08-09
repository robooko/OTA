const crypto = require('crypto');
const pool = require('../db');

function generateApiKey() {
  return 'prop_' + crypto.randomBytes(32).toString('hex');
}

async function getApiKey(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT api_key FROM property WHERE id = $1', [req.property_id]);
    res.json({ api_key: rows[0].api_key });
  } catch (err) {
    next(err);
  }
}

async function rotateApiKey(req, res, next) {
  try {
    const api_key = generateApiKey();
    const { rows } = await pool.query(
      'UPDATE property SET api_key = $1 WHERE id = $2 RETURNING api_key',
      [api_key, req.property_id]
    );
    res.json({ api_key: rows[0].api_key });
  } catch (err) {
    next(err);
  }
}

module.exports = { getApiKey, rotateApiKey };
