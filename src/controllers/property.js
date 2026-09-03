const crypto = require('crypto');
const pool = require('../db');
const { isValidCurrencyCode, isValidTimezone, isValidUrl, isValidDate, validateBranding, validateCancelUrl } = require('../middleware/validate');
const { isConfigured: aiConfigured, MODEL: AI_MODEL } = require('../lib/aiReplies');
const googleReviews = require('../lib/googleReviews');

// One Places call per property per window; stale cache always beats an
// error, so a Google outage degrades to yesterday's numbers, not a broken
// section on the venue's site.
const GOOGLE_REVIEWS_TTL_MS = 12 * 60 * 60 * 1000;

const AI_REPLY_MODES = ['off', 'draft', 'auto'];
// ~2k tokens. Keeps the cached per-property prompt prefix small and bounds
// the per-draft cost; a venue brief longer than this belongs in a document,
// not a settings field.
const AI_INSTRUCTIONS_MAX_LENGTH = 8000;

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

// Live Google reviews for the property's website (rating, count, latest
// quotes, write-a-review link), lazily cached in google_reviews_cache.
async function getGoogleReviews(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT google_place_id FROM property WHERE id = $1', [req.property_id]);
    const placeId = rows[0]?.google_place_id;
    if (!placeId) {
      return res.status(404).json({ error: 'No Google place id configured for this property' });
    }
    const cached = await pool.query(
      'SELECT payload, fetched_at FROM google_reviews_cache WHERE property_id = $1',
      [req.property_id]
    );
    const cacheRow = cached.rows[0];
    const fresh = cacheRow && Date.now() - new Date(cacheRow.fetched_at).getTime() < GOOGLE_REVIEWS_TTL_MS;
    if (fresh) {
      return res.json({ ...cacheRow.payload, fetched_at: cacheRow.fetched_at });
    }
    if (!googleReviews.isConfigured()) {
      if (cacheRow) return res.json({ ...cacheRow.payload, fetched_at: cacheRow.fetched_at });
      return res.status(503).json({ error: 'Google reviews are not configured on this server' });
    }
    const payload = await googleReviews.fetchPlaceReviews(placeId);
    if (!payload) {
      if (cacheRow) return res.json({ ...cacheRow.payload, fetched_at: cacheRow.fetched_at });
      return res.status(502).json({ error: 'Failed to fetch reviews from Google' });
    }
    await pool.query(
      `INSERT INTO google_reviews_cache (property_id, payload, fetched_at)
       VALUES ($1, $2, now())
       ON CONFLICT (property_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [req.property_id, payload]
    );
    res.json({ ...payload, fetched_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

// On the API-key rail (like ai-replies/instructions) so onboarding tooling
// and the MCP can set it. Changing the place id invalidates the cache.
async function setGooglePlaceId(req, res, next) {
  try {
    const { place_id } = req.body;
    if (place_id !== null && (typeof place_id !== 'string' || !place_id.trim() || place_id.length > 300)) {
      return res.status(400).json({ error: 'place_id must be a non-empty string (or null to clear)' });
    }
    const { rows } = await pool.query(
      'UPDATE property SET google_place_id = $1 WHERE id = $2 RETURNING id, google_place_id',
      [place_id === null ? null : place_id.trim(), req.property_id]
    );
    await pool.query('DELETE FROM google_reviews_cache WHERE property_id = $1', [req.property_id]);
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

// Prefers this property's own connected Vercel account (correctly scoped to
// whoever connected) over the shared admin VERCEL_TOKEN fallback. Only safe
// for endpoints like listing projects -- OAuth Integration installation
// tokens are confirmed (see commit 0532a08) unable to read Web Analytics, so
// analytics calls must use resolveAnalyticsAuth() below instead.
async function resolveVercelAuth(propertyId) {
  const { rows } = await pool.query(
    'SELECT vercel_access_token, vercel_team_id FROM property WHERE id = $1',
    [propertyId]
  );
  const own = rows[0];
  return {
    token: own?.vercel_access_token || process.env.VERCEL_TOKEN,
    teamId: own?.vercel_access_token ? own.vercel_team_id : process.env.VERCEL_TEAM_ID,
  };
}

// Web Analytics needs a token that can actually read it -- OAuth Integration
// installation tokens can't (see resolveVercelAuth above), so this prefers a
// property-supplied Personal Access Token, then falls back to the shared
// admin VERCEL_TOKEN env var.
async function resolveAnalyticsAuth(propertyId) {
  const { rows } = await pool.query(
    'SELECT vercel_pat, vercel_team_id FROM property WHERE id = $1',
    [propertyId]
  );
  const own = rows[0];
  return {
    token: own?.vercel_pat || process.env.VERCEL_TOKEN,
    teamId: own?.vercel_team_id || process.env.VERCEL_TEAM_ID,
  };
}

async function fetchVercelAnalytics({ token, teamId, projectId, sinceIso, untilIso }) {
  const headers = { Authorization: `Bearer ${token}` };
  const teamQuery = teamId ? `&teamId=${teamId}` : '';
  const params = `projectId=${projectId}&since=${sinceIso}&until=${untilIso}${teamQuery}`;

  const [countRes, dailyRes] = await Promise.all([
    fetch(`${VERCEL_API_BASE}/v1/query/web-analytics/visits/count?${params}`, { headers }),
    fetch(`${VERCEL_API_BASE}/v1/query/web-analytics/visits/aggregate?${params}&by=day`, { headers }),
  ]);
  if (!countRes.ok || !dailyRes.ok) return null;
  const [countBody, dailyBody] = await Promise.all([countRes.json(), dailyRes.json()]);
  return {
    visitors: countBody.data.visitors,
    pageviews: countBody.data.pageviews,
    daily: dailyBody.data.map((d) => ({ date: d.timestamp.slice(0, 10), visitors: d.visitors, pageviews: d.pageviews })),
  };
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

    const { token, teamId } = await resolveAnalyticsAuth(req.property_id);
    if (!token) {
      return res.status(503).json({ error: 'Vercel analytics is not configured on this server' });
    }

    const { sinceIso, untilIso } = defaultSinceUntil(since, until);
    const analytics = await fetchVercelAnalytics({ token, teamId, projectId: vercel_project_id, sinceIso, untilIso });
    if (!analytics) return res.status(502).json({ error: 'Failed to fetch analytics from Vercel' });
    res.json(analytics);
  } catch (err) {
    next(err);
  }
}

async function getVercelProjectAnalytics(req, res, next) {
  try {
    const { since, until } = req.query;
    if (since !== undefined && !isValidDate(since)) return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    if (until !== undefined && !isValidDate(until)) return res.status(400).json({ error: 'until must be YYYY-MM-DD' });

    const { token, teamId } = await resolveAnalyticsAuth(req.property_id);
    if (!token) {
      return res.status(503).json({ error: 'Vercel analytics is not configured on this server' });
    }

    const { sinceIso, untilIso } = defaultSinceUntil(since, until);
    const analytics = await fetchVercelAnalytics({ token, teamId, projectId: req.params.projectId, sinceIso, untilIso });
    if (!analytics) return res.status(502).json({ error: 'Failed to fetch analytics from Vercel' });
    res.json(analytics);
  } catch (err) {
    next(err);
  }
}

async function listVercelProjects(req, res, next) {
  try {
    const { token, teamId } = await resolveVercelAuth(req.property_id);
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
      'SELECT vercel_team_id, vercel_connected_at, vercel_pat FROM property WHERE id = $1',
      [req.property_id]
    );
    const row = rows[0] ?? {};
    res.json({
      connected: !!row.vercel_connected_at,
      teamId: row.vercel_team_id ?? null,
      connectedAt: row.vercel_connected_at ?? null,
      analyticsPatConfigured: !!row.vercel_pat,
    });
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

async function setVercelPat(req, res, next) {
  try {
    const { vercel_pat, vercel_team_id } = req.body;
    if (!vercel_pat || typeof vercel_pat !== 'string') {
      return res.status(400).json({ error: 'vercel_pat is required' });
    }
    await pool.query(
      'UPDATE property SET vercel_pat = $1, vercel_team_id = COALESCE($2, vercel_team_id) WHERE id = $3',
      [vercel_pat, vercel_team_id || null, req.property_id]
    );
    res.json({ analyticsPatConfigured: true });
  } catch (err) {
    next(err);
  }
}

async function clearVercelPat(req, res, next) {
  try {
    await pool.query('UPDATE property SET vercel_pat = NULL WHERE id = $1', [req.property_id]);
    res.json({ analyticsPatConfigured: false });
  } catch (err) {
    next(err);
  }
}

// Same shape as the Vercel PAT above -- a property-supplied secret, admin-
// only read/write, and the key itself never comes back to the client, only
// a "configured" boolean. Lets the restaurant reservation flow create
// payment intents / holds under this property's own Stripe account.
async function getStripeStatus(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT stripe_secret_key FROM property WHERE id = $1', [req.property_id]);
    res.json({ stripeKeyConfigured: !!rows[0]?.stripe_secret_key });
  } catch (err) {
    next(err);
  }
}

async function setStripeKey(req, res, next) {
  try {
    const { stripe_secret_key } = req.body;
    if (!stripe_secret_key || typeof stripe_secret_key !== 'string') {
      return res.status(400).json({ error: 'stripe_secret_key is required' });
    }
    await pool.query('UPDATE property SET stripe_secret_key = $1 WHERE id = $2', [stripe_secret_key, req.property_id]);
    res.json({ stripeKeyConfigured: true });
  } catch (err) {
    next(err);
  }
}

async function clearStripeKey(req, res, next) {
  try {
    await pool.query('UPDATE property SET stripe_secret_key = NULL WHERE id = $1', [req.property_id]);
    res.json({ stripeKeyConfigured: false });
  } catch (err) {
    next(err);
  }
}

// AI-drafted event-inquiry replies. Readable by any staff member (the
// dashboard needs the mode to render draft badges), writable by admins only,
// same split as /stripe/status vs /stripe/key. `configured` reports whether
// the server has an Anthropic key at all -- a property can't turn the
// feature on if the deployment doesn't have one.
function aiReplySettingsResponse(row) {
  return {
    configured: aiConfigured(),
    model: AI_MODEL,
    mode: row.ai_reply_mode,
    instructions: row.ai_reply_instructions,
    auto_send_min_score: row.ai_reply_auto_send_min_score,
  };
}

async function getAiReplySettings(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT ai_reply_mode, ai_reply_instructions, ai_reply_auto_send_min_score FROM property WHERE id = $1',
      [req.property_id]
    );
    res.json(aiReplySettingsResponse(rows[0]));
  } catch (err) {
    next(err);
  }
}

async function updateAiReplySettings(req, res, next) {
  try {
    const { mode, instructions, auto_send_min_score } = req.body ?? {};
    if (mode !== undefined && !AI_REPLY_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of ${AI_REPLY_MODES.join(', ')}` });
    }
    if (auto_send_min_score !== undefined && (!Number.isInteger(auto_send_min_score) || auto_send_min_score < 0 || auto_send_min_score > 100)) {
      return res.status(400).json({ error: 'auto_send_min_score must be an integer from 0 to 100' });
    }
    if (instructions !== undefined && instructions !== null) {
      if (typeof instructions !== 'string') return res.status(400).json({ error: 'instructions must be a string or null' });
      if (instructions.length > AI_INSTRUCTIONS_MAX_LENGTH) {
        return res.status(400).json({ error: `instructions must be at most ${AI_INSTRUCTIONS_MAX_LENGTH} characters` });
      }
    }
    // mode/score: omit = unchanged (COALESCE). instructions: omit = unchanged,
    // null = clear -- the CASE-on-provided pattern restaurant currency uses,
    // since COALESCE can't tell "clear it" from "leave it".
    const { rows } = await pool.query(
      `UPDATE property SET
         ai_reply_mode                = COALESCE($1, ai_reply_mode),
         ai_reply_auto_send_min_score = COALESCE($2, ai_reply_auto_send_min_score),
         ai_reply_instructions        = CASE WHEN $3::boolean THEN $4::text ELSE ai_reply_instructions END
       WHERE id = $5
       RETURNING ai_reply_mode, ai_reply_instructions, ai_reply_auto_send_min_score`,
      [mode ?? null, auto_send_min_score ?? null, instructions !== undefined, instructions?.trim() || null, req.property_id]
    );
    res.json(aiReplySettingsResponse(rows[0]));
  } catch (err) {
    next(err);
  }
}

// ── Email branding ────────────────────────────────────────────────────────
// Default {logo_url, brand_color, header_bg} + cancel_url for booking emails
// (see migrate-2026-09-01-property-email-branding.sql). Flattened to one
// object for the API/UI; stored as email_branding JSONB + email_cancel_url.

const BRANDING_KEYS = ['logo_url', 'brand_color', 'header_bg'];
const REVIEW_REQUEST_FIELDS = 'email_branding, email_cancel_url, review_request_enabled, review_url, review_request_delay_mins, review_request_cooldown_days';

function emailBrandingResponse(row) {
  const b = row.email_branding ?? {};
  return {
    logo_url: b.logo_url ?? null,
    brand_color: b.brand_color ?? null,
    header_bg: b.header_bg ?? null,
    cancel_url: row.email_cancel_url ?? null,
    // Post-visit Google review request (spa module) -- see
    // migrate-2026-09-03-spa-review-requests.sql. Off until review_url is set.
    review_request_enabled: row.review_request_enabled,
    review_url: row.review_url ?? null,
    review_request_delay_mins: row.review_request_delay_mins,
    review_request_cooldown_days: row.review_request_cooldown_days,
  };
}

async function getEmailBranding(req, res, next) {
  try {
    const { rows } = await pool.query(`SELECT ${REVIEW_REQUEST_FIELDS} FROM property WHERE id = $1`, [req.property_id]);
    res.json(emailBrandingResponse(rows[0]));
  } catch (err) {
    next(err);
  }
}

// Per field: omit = unchanged, null or '' = clear. Validation reuses the
// per-request rules so a value accepted here is exactly what a website could
// have sent with a booking.
async function updateEmailBranding(req, res, next) {
  try {
    const body = req.body ?? {};
    const { rows: [current] } = await pool.query(`SELECT ${REVIEW_REQUEST_FIELDS} FROM property WHERE id = $1`, [req.property_id]);
    const branding = { ...(current.email_branding ?? {}) };
    for (const key of BRANDING_KEYS) {
      if (body[key] === undefined) continue;
      const value = typeof body[key] === 'string' ? body[key].trim() : body[key];
      if (value === null || value === '') delete branding[key];
      else branding[key] = value;
    }
    const brandingError = validateBranding(branding);
    if (brandingError) return res.status(400).json({ error: brandingError });

    let cancelUrl = current.email_cancel_url;
    if (body.cancel_url !== undefined) {
      const value = typeof body.cancel_url === 'string' ? body.cancel_url.trim() : body.cancel_url;
      cancelUrl = value === null || value === '' ? null : value;
      const cancelUrlError = validateCancelUrl(cancelUrl);
      if (cancelUrlError) return res.status(400).json({ error: cancelUrlError });
    }

    let reviewUrl = current.review_url;
    if (body.review_url !== undefined) {
      const value = typeof body.review_url === 'string' ? body.review_url.trim() : body.review_url;
      reviewUrl = value === null || value === '' ? null : value;
      if (reviewUrl !== null && !isValidUrl(reviewUrl)) {
        return res.status(400).json({ error: 'review_url must be a valid http(s) URL' });
      }
    }

    let reviewRequestEnabled = current.review_request_enabled;
    if (body.review_request_enabled !== undefined) {
      reviewRequestEnabled = !!body.review_request_enabled;
    }
    if (reviewRequestEnabled && !reviewUrl) {
      return res.status(400).json({ error: 'review_url is required to enable review requests' });
    }

    let reviewDelayMins = current.review_request_delay_mins;
    if (body.review_request_delay_mins !== undefined) {
      reviewDelayMins = Number(body.review_request_delay_mins);
      if (!Number.isInteger(reviewDelayMins) || reviewDelayMins < 0 || reviewDelayMins > 1440) {
        return res.status(400).json({ error: 'review_request_delay_mins must be an integer between 0 and 1440' });
      }
    }

    let reviewCooldownDays = current.review_request_cooldown_days;
    if (body.review_request_cooldown_days !== undefined) {
      reviewCooldownDays = Number(body.review_request_cooldown_days);
      if (!Number.isInteger(reviewCooldownDays) || reviewCooldownDays < 0 || reviewCooldownDays > 365) {
        return res.status(400).json({ error: 'review_request_cooldown_days must be an integer between 0 and 365' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE property SET email_branding = $1, email_cancel_url = $2,
              review_request_enabled = $3, review_url = $4,
              review_request_delay_mins = $5, review_request_cooldown_days = $6
       WHERE id = $7
       RETURNING ${REVIEW_REQUEST_FIELDS}`,
      [
        Object.keys(branding).length ? JSON.stringify(branding) : null,
        cancelUrl,
        reviewRequestEnabled,
        reviewUrl,
        reviewDelayMins,
        reviewCooldownDays,
        req.property_id,
      ]
    );
    res.json(emailBrandingResponse(rows[0]));
  } catch (err) {
    next(err);
  }
}

// Instructions-only write for the API-key rail (MCP set_ai_reply_instructions):
// venue automation may tune what the AI is told about the venue, but mode and
// the auto-send threshold -- the knobs that decide whether emails leave
// unsupervised -- stay bearer+admin (updateAiReplySettings above).
async function updateAiReplyInstructions(req, res, next) {
  try {
    const { instructions } = req.body ?? {};
    if (instructions === undefined) {
      return res.status(400).json({ error: 'instructions is required (a string, or null to clear)' });
    }
    if (instructions !== null) {
      if (typeof instructions !== 'string') return res.status(400).json({ error: 'instructions must be a string or null' });
      if (instructions.length > AI_INSTRUCTIONS_MAX_LENGTH) {
        return res.status(400).json({ error: `instructions must be at most ${AI_INSTRUCTIONS_MAX_LENGTH} characters` });
      }
    }
    const { rows } = await pool.query(
      `UPDATE property SET ai_reply_instructions = $1 WHERE id = $2
       RETURNING ai_reply_mode, ai_reply_instructions, ai_reply_auto_send_min_score`,
      [instructions?.trim() || null, req.property_id]
    );
    res.json(aiReplySettingsResponse(rows[0]));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getEmailBranding, updateEmailBranding,
  getCurrentProperty, updateCurrentProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey,
  listWebsites, createWebsite, updateWebsite, getWebsiteAnalytics, listVercelProjects, getVercelProjectAnalytics,
  getVercelConnectUrl, vercelConnectCallback, getVercelConnectionStatus, disconnectVercel,
  setVercelPat, clearVercelPat,
  getStripeStatus, setStripeKey, clearStripeKey,
  getAiReplySettings, updateAiReplySettings, updateAiReplyInstructions,
  getGoogleReviews, setGooglePlaceId,
};
