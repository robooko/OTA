const pool = require('../db');
const integ = require('../lib/integrations');

// Org-level integrations (req.clerk_org_id from authenticateOrg), one row
// per org per provider -- see src/lib/integrations.js. Same connect flow as
// QuickBooks: admin gets a consent URL, Google calls back with signed state.

const page = (res, status, text) => res.status(status).send(`<p>${text}</p>`);

function requireProvider(req, res, next) {
  if (!integ.PROVIDERS[req.params.provider]) return res.status(404).json({ error: 'Unknown integration' });
  next();
}

function notConfigured(provider) {
  const missing = integ.missingEnv(provider);
  return missing.length ? { error: `${integ.PROVIDERS[provider].label} is not configured on this server`, details: `Missing: ${missing.join(', ')}` } : null;
}

function getConnectUrl(req, res) {
  const { provider } = req.params;
  const nc = notConfigured(provider);
  if (nc) return res.status(503).json(nc);
  const p = integ.PROVIDERS[provider];
  const url = `${p.authUrl}?${new URLSearchParams({
    client_id: process.env[p.env.clientId],
    redirect_uri: process.env[p.env.redirectUri],
    response_type: 'code',
    scope: p.scope,
    state: integ.signState(req.clerk_org_id, provider),
    ...p.extraAuthParams,
  })}`;
  res.json({ url });
}

// Google Drive's account email, without asking for an extra scope.
async function accountEmail(accessToken) {
  const r = await integ.fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return (await r.json().catch(() => ({})))?.user?.emailAddress ?? null;
}

async function connectCallback(req, res, next) {
  try {
    const { provider } = req.params;
    const label = integ.PROVIDERS[provider].label;
    const { code, state, error } = req.query;
    if (error) return page(res, 400, `${label} connection was cancelled. Close this tab and try again from Settings.`);
    const s = integ.verifyState(state);
    if (!code || !s || s.provider !== provider) return page(res, 400, 'Invalid or expired connect link. Close this tab and try again from Settings.');
    if (notConfigured(provider)) return page(res, 503, `${label} is not configured on this server.`);
    let t;
    try {
      t = await integ.tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: process.env[integ.PROVIDERS[provider].env.redirectUri] });
    } catch (err) {
      if (!(err instanceof integ.IntegrationError)) throw err;
      return page(res, 502, `Failed to connect ${label}. Close this tab and try again from Settings.`);
    }
    if (!t.refresh_token) return page(res, 502, `${label} did not grant offline access. Close this tab and try again from Settings.`);
    const email = await accountEmail(t.access_token).catch(() => null);
    await pool.query('INSERT INTO organization (clerk_org_id) VALUES ($1) ON CONFLICT DO NOTHING', [s.orgId]);
    // Reconnecting (any account) starts from a clean folder cache.
    await pool.query(
      `INSERT INTO org_integration (clerk_org_id, provider, account_email, refresh_token, access_token, access_token_expires_at, settings, reconnect_required, connected_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), '{}', false, now())
       ON CONFLICT (clerk_org_id, provider) DO UPDATE SET
         account_email = EXCLUDED.account_email, refresh_token = EXCLUDED.refresh_token, access_token = EXCLUDED.access_token,
         access_token_expires_at = EXCLUDED.access_token_expires_at, settings = '{}', reconnect_required = false, connected_at = now()`,
      [s.orgId, provider, email, integ.encrypt(t.refresh_token), integ.encrypt(t.access_token), t.expires_in]);
    page(res, 200, `${label} connected. You can close this tab and return to Settings.`);
  } catch (err) { next(err); }
}

async function getStatus(req, res, next) {
  try {
    const row = await integ.getIntegration(req.clerk_org_id, req.params.provider);
    res.json({
      configured: integ.missingEnv(req.params.provider).length === 0,
      connected: !!row,
      account_email: row?.account_email ?? null,
      reconnect_required: row?.reconnect_required ?? false,
      connected_at: row?.connected_at ?? null,
    });
  } catch (err) { next(err); }
}

async function disconnect(req, res, next) {
  try {
    const { provider } = req.params;
    const { rows: [row] } = await pool.query('SELECT refresh_token FROM org_integration WHERE clerk_org_id = $1 AND provider = $2', [req.clerk_org_id, provider]);
    // Best effort: a failed revoke mustn't leave the grant stored here.
    if (row?.refresh_token) {
      try {
        await integ.fetch(`${integ.PROVIDERS[provider].revokeUrl}?token=${encodeURIComponent(integ.decrypt(row.refresh_token))}`, { method: 'POST' });
      } catch (err) { console.error(`${integ.PROVIDERS[provider].label} revoke failed:`, err.message); }
    }
    await pool.query('DELETE FROM org_integration WHERE clerk_org_id = $1 AND provider = $2', [req.clerk_org_id, provider]);
    res.json({ connected: false });
  } catch (err) { next(err); }
}

module.exports = { requireProvider, getConnectUrl, connectCallback, getStatus, disconnect };
