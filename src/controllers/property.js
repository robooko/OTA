const crypto = require('crypto');
const pool = require('../db');
const { isValidCurrencyCode, isValidTimezone, isValidUrl, isValidDate } = require('../middleware/validate');

const VERCEL_API_BASE = 'https://api.vercel.com';

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
      "SELECT id, url, label, vercel_project_id FROM property_website WHERE property_id = $1 AND status = 'active' ORDER BY created_at",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createWebsite(req, res, next) {
  try {
    const { url, label, vercel_project_id } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!isValidUrl(url)) return res.status(400).json({ error: 'url must be a valid http(s) URL' });
    const { rows } = await pool.query(
      'INSERT INTO property_website (property_id, url, label, vercel_project_id) VALUES ($1, $2, $3, $4) RETURNING id, url, label, vercel_project_id',
      [req.property_id, url, label ?? null, vercel_project_id ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateWebsite(req, res, next) {
  try {
    const { url, label, status, vercel_project_id } = req.body;
    if (url !== undefined && !isValidUrl(url)) {
      return res.status(400).json({ error: 'url must be a valid http(s) URL' });
    }
    const { rows } = await pool.query(
      `UPDATE property_website SET
         url                = COALESCE($1, url),
         label              = COALESCE($2, label),
         status             = COALESCE($3, status),
         vercel_project_id  = COALESCE($4, vercel_project_id)
       WHERE id = $5 AND property_id = $6 RETURNING id, url, label, status, vercel_project_id`,
      [url, label, status, vercel_project_id, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Website not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

function defaultSinceUntil(since, until) {
  const untilDate = until ? new Date(`${until}T23:59:59.999Z`) : new Date();
  const sinceDate = since ? new Date(`${since}T00:00:00.000Z`) : new Date(untilDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { sinceIso: sinceDate.toISOString(), untilIso: untilDate.toISOString() };
}

async function getWebsiteAnalytics(req, res, next) {
  try {
    const { since, until } = req.query;
    if (since !== undefined && !isValidDate(since)) return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    if (until !== undefined && !isValidDate(until)) return res.status(400).json({ error: 'until must be YYYY-MM-DD' });

    const { rows } = await pool.query(
      'SELECT id, vercel_project_id FROM property_website WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Website not found' });
    const { vercel_project_id } = rows[0];
    if (!vercel_project_id) return res.status(400).json({ error: 'Website is not mapped to a Vercel project' });

    if (!process.env.VERCEL_TOKEN) {
      return res.status(503).json({ error: 'Vercel analytics is not configured on this server' });
    }

    const { sinceIso, untilIso } = defaultSinceUntil(since, until);
    const headers = { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` };
    const teamQuery = process.env.VERCEL_TEAM_ID ? `&teamId=${process.env.VERCEL_TEAM_ID}` : '';
    const params = `projectId=${vercel_project_id}&since=${sinceIso}&until=${untilIso}${teamQuery}`;

    const [countRes, dailyRes] = await Promise.all([
      fetch(`${VERCEL_API_BASE}/v1/query/web-analytics/visits/count?${params}`, { headers }),
      fetch(`${VERCEL_API_BASE}/v1/query/web-analytics/visits/aggregate?${params}&by=day`, { headers }),
    ]);
    if (!countRes.ok || !dailyRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch analytics from Vercel' });
    }
    const [countBody, dailyBody] = await Promise.all([countRes.json(), dailyRes.json()]);

    res.json({
      visitors: countBody.data.visitors,
      pageviews: countBody.data.pageviews,
      daily: dailyBody.data.map((d) => ({ date: d.timestamp.slice(0, 10), visitors: d.visitors, pageviews: d.pageviews })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getCurrentProperty, updateCurrentProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey,
  listWebsites, createWebsite, updateWebsite, getWebsiteAnalytics,
};
