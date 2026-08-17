const crypto = require('crypto');
const pool = require('../db');
const { isValidCurrencyCode, isValidTimezone, isValidUrl } = require('../middleware/validate');

function generateApiKey() {
  return 'prop_' + crypto.randomBytes(32).toString('hex');
}

async function getCurrentProperty(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id, name, currency, timezone FROM property WHERE id = $1', [req.property_id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateCurrentProperty(req, res, next) {
  try {
    const { currency, timezone } = req.body;
    if (currency !== undefined && !isValidCurrencyCode(currency)) {
      return res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code (e.g. GBP)' });
    }
    if (timezone !== undefined && !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'timezone must be a valid IANA timezone name (e.g. Europe/London)' });
    }
    const { rows } = await pool.query(
      'UPDATE property SET currency = COALESCE($1, currency), timezone = COALESCE($2, timezone) WHERE id = $3 RETURNING id, name, currency, timezone',
      [currency, timezone, req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function getApiKey(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT api_key, api_key_enabled FROM property WHERE id = $1', [req.property_id]);
    res.json(rows[0]);
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

async function disableApiKey(req, res, next) {
  try {
    const { rows } = await pool.query(
      'UPDATE property SET api_key_enabled = false WHERE id = $1 RETURNING api_key, api_key_enabled',
      [req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function enableApiKey(req, res, next) {
  try {
    const { rows } = await pool.query(
      'UPDATE property SET api_key_enabled = true WHERE id = $1 RETURNING api_key, api_key_enabled',
      [req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function listWebsites(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT id, url, label FROM property_website WHERE property_id = $1 AND status = 'active' ORDER BY created_at",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createWebsite(req, res, next) {
  try {
    const { url, label } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!isValidUrl(url)) return res.status(400).json({ error: 'url must be a valid http(s) URL' });
    const { rows } = await pool.query(
      'INSERT INTO property_website (property_id, url, label) VALUES ($1, $2, $3) RETURNING id, url, label',
      [req.property_id, url, label ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateWebsite(req, res, next) {
  try {
    const { url, label, status } = req.body;
    if (url !== undefined && !isValidUrl(url)) {
      return res.status(400).json({ error: 'url must be a valid http(s) URL' });
    }
    const { rows } = await pool.query(
      `UPDATE property_website SET
         url    = COALESCE($1, url),
         label  = COALESCE($2, label),
         status = COALESCE($3, status)
       WHERE id = $4 AND property_id = $5 RETURNING id, url, label, status`,
      [url, label, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Website not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getCurrentProperty, updateCurrentProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey,
  listWebsites, createWebsite, updateWebsite,
};
