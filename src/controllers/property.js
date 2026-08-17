const crypto = require('crypto');
const pool = require('../db');
const { isValidCurrencyCode, isValidTimezone, isValidUrl, isValidDate } = require('../middleware/validate');

const VERCEL_API_BASE = 'https://api.vercel.com';
const VERCEL_INSTALL_URL = 'https://vercel.com/integrations/forge-build/new';
const VERCEL_CALLBACK_URL = 'https://ota-u6ii.onrender.com/api/property/vercel/callback';

// Signs property_id into the OAuth `state` param so the callback (which
// Vercel calls directly, with no Clerk session) can trust which property to
// mark connected. Reuses VERCEL_INTEGRATION_SECRET (already required to be
// present here) rather than a per-process random value, so state survives
// server restarts/redeploys between the connect click and the callback.
function signState(propertyId) {
  const sig = crypto.createHmac('sha256', process.env.VERCEL_INTEGRATION_SECRET).update(propertyId).digest('hex');
  return `${propertyId}.${sig}`;
}
function verifyState(state) {
  const [propertyId, sig] = String(state ?? '').split('.');
  if (!propertyId || !sig) return null;
  const expected = crypto.createHmac('sha256', process.env.VERCEL_INTEGRATION_SECRET).update(propertyId).digest('hex');
  return sig === expected ? propertyId : null;
}

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

async function listVercelProjects(req, res, next) {
  try {
    // Prefer this property's own connected account (correctly scoped to
    // whoever connected) over the shared admin VERCEL_TOKEN fallback.
    const { rows } = await pool.query(
      'SELECT vercel_access_token, vercel_team_id FROM property WHERE id = $1',
      [req.property_id]
    );
    const own = rows[0];

    const token = own?.vercel_access_token || process.env.VERCEL_TOKEN;
    const teamId = own?.vercel_access_token ? own.vercel_team_id : process.env.VERCEL_TEAM_ID;
    if (!token) {
      return res.status(503).json({ error: 'Vercel analytics is not configured on this server' });
    }
    const headers = { Authorization: `Bearer ${token}` };
    const teamQuery = teamId ? `&teamId=${teamId}` : '';
    const vercelRes = await fetch(`${VERCEL_API_BASE}/v9/projects?limit=100${teamQuery}`, { headers });
    if (!vercelRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch projects from Vercel' });
    }
    const body = await vercelRes.json();
    const projects = (body.projects ?? []).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
    res.json(projects);
  } catch (err) {
    next(err);
  }
}

function getVercelConnectUrl(req, res) {
  const state = signState(req.property_id);
  const url = `${VERCEL_INSTALL_URL}?state=${state}`;
  res.json({ url });
}

async function vercelConnectCallback(req, res, next) {
  try {
    const { code, state } = req.query;
    const propertyId = verifyState(state);
    if (!code || !propertyId) {
      return res.status(400).send('Invalid or expired connect link. Close this tab and try again from Settings.');
    }

    const tokenRes = await fetch(`${VERCEL_API_BASE}/v2/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.VERCEL_INTEGRATION_ID,
        client_secret: process.env.VERCEL_INTEGRATION_SECRET,
        code,
        redirect_uri: VERCEL_CALLBACK_URL,
      }),
    });
    const tokenBody = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(502).send('Failed to connect Vercel. Close this tab and try again from Settings.');
    }

    await pool.query(
      'UPDATE property SET vercel_team_id = $1, vercel_access_token = $2, vercel_connected_at = now() WHERE id = $3',
      [tokenBody.team_id ?? null, tokenBody.access_token ?? null, propertyId]
    );

    // Vercel gives us `next` to send the user back to close out its own UI.
    if (req.query.next) return res.redirect(req.query.next);
    res.send('<p>Vercel connected. You can close this tab and return to Settings.</p>');
  } catch (err) {
    next(err);
  }
}

async function getVercelConnectionStatus(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT vercel_team_id, vercel_connected_at FROM property WHERE id = $1',
      [req.property_id]
    );
    const row = rows[0] ?? {};
    res.json({ connected: !!row.vercel_connected_at, teamId: row.vercel_team_id ?? null, connectedAt: row.vercel_connected_at ?? null });
  } catch (err) {
    next(err);
  }
}

async function disconnectVercel(req, res, next) {
  try {
    await pool.query(
      'UPDATE property SET vercel_team_id = NULL, vercel_access_token = NULL, vercel_connected_at = NULL WHERE id = $1',
      [req.property_id]
    );
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getCurrentProperty, updateCurrentProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey,
  listWebsites, createWebsite, updateWebsite, getWebsiteAnalytics, listVercelProjects,
  getVercelConnectUrl, vercelConnectCallback, getVercelConnectionStatus, disconnectVercel,
};
