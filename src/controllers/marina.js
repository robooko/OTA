const pool = require('../db');

// The stored Sidon key outlives Switch only so a rollback can re-enable the
// old proxy; the whole file goes at cleanup.

async function setSidonMarinaKey(req, res, next) {
  try {
    const key = typeof req.body?.sidon_marina_key === 'string' ? req.body.sidon_marina_key.trim() : '';
    // Sidon keys are mk_ + hex. The shape check also stops a browser-autofilled
    // login password from being stored as the key.
    if (!/^mk_[A-Za-z0-9]{8,200}$/.test(key)) {
      return res.status(400).json({ error: 'sidon_marina_key must be the mk_… key from the Sidon dashboard' });
    }
    await pool.query('UPDATE property SET sidon_marina_key = $1 WHERE id = $2', [key, req.property_id]);
    res.json({ sidon_marina_key_set: true });
  } catch (err) {
    next(err);
  }
}

async function clearSidonMarinaKey(req, res, next) {
  try {
    await pool.query('UPDATE property SET sidon_marina_key = NULL WHERE id = $1', [req.property_id]);
    res.json({ sidon_marina_key_set: false });
  } catch (err) {
    next(err);
  }
}

module.exports = { setSidonMarinaKey, clearSidonMarinaKey };
