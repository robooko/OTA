const crypto = require('crypto');
const pool = require('../db');

// Per-org integrations (one org_integration row per org per provider).
// The app's OAuth client id/secret live in .env; the per-org grant lives in
// the row, tokens AES-256-GCM encrypted under INTEGRATIONS_ENCRYPTION_KEY.
// Spec: docs/superpowers/specs/2026-10-17-per-org-storage-google-drive-design.md

const PROVIDERS = {
  google_drive: {
    label: 'Google Drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    // Only files OTA created -- never the rest of the marina's Drive.
    scope: 'https://www.googleapis.com/auth/drive.file',
    env: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', redirectUri: 'GOOGLE_REDIRECT_URI' },
    // offline + consent: Google only issues a refresh token on consent.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
};

const STATE_MAX_AGE_MS = 60 * 60 * 1000;

class IntegrationError extends Error {
  constructor(status, message, { details, code } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

function missingEnv(provider) {
  const p = PROVIDERS[provider];
  return [...Object.values(p.env), 'INTEGRATIONS_ENCRYPTION_KEY'].filter((k) => !process.env[k]);
}
const envOf = (provider, name) => process.env[PROVIDERS[provider].env[name]];

function key() {
  const k = Buffer.from(process.env.INTEGRATIONS_ENCRYPTION_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes, base64');
  return k;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(s) {
  const [v, iv, tag, ct] = String(s).split(':');
  if (v !== 'v1') throw new Error('Unknown token format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// The callback arrives with no Clerk session, so org + provider ride in a
// signed, timestamped state (same idea as quickbooks.js, plus an expiry).
const hmac = (payload) => crypto.createHmac('sha256', key()).update(payload).digest('hex');
function signState(orgId, provider, ts = Date.now()) {
  const payload = `${orgId}.${provider}.${ts}`;
  return `${payload}.${hmac(payload)}`;
}
function verifyState(state, maxAgeMs = STATE_MAX_AGE_MS) {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 4) return null;
  const [orgId, provider, ts, sig] = parts;
  if (!orgId || !PROVIDERS[provider] || !/^\d+$/.test(ts)) return null;
  const expected = Buffer.from(hmac(`${orgId}.${provider}.${ts}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (Date.now() - Number(ts) > maxAgeMs) return null;
  return { orgId, provider };
}

async function tokenRequest(provider, params) {
  const res = await module.exports.fetch(PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: envOf(provider, 'clientId'), client_secret: envOf(provider, 'clientSecret'), ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new IntegrationError(409, `${PROVIDERS[provider].label} access was revoked -- reconnect from Settings`, { code: 'invalid_grant' });
    throw new IntegrationError(502, `${PROVIDERS[provider].label} token request failed`, { details: body.error_description || body.error || `HTTP ${res.status}` });
  }
  return body;
}

// A live access token, refreshed under a row lock so two requests never
// race the same grant. Google usually omits refresh_token on refresh: keep
// the stored one. A revoked grant flags reconnect_required.
async function getAccessToken(orgId, provider) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      'SELECT refresh_token, access_token, access_token_expires_at, reconnect_required FROM org_integration WHERE clerk_org_id = $1 AND provider = $2 FOR UPDATE',
      [orgId, provider]);
    const label = PROVIDERS[provider].label;
    if (!row?.refresh_token) throw new IntegrationError(409, `${label} is not connected`, { code: 'not_connected' });
    if (row.reconnect_required) throw new IntegrationError(409, `${label} needs to be reconnected`, { code: 'reconnect' });
    if (row.access_token && new Date(row.access_token_expires_at) > new Date(Date.now() + 60_000)) {
      await client.query('COMMIT');
      return decrypt(row.access_token);
    }
    let t;
    try {
      t = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token) });
    } catch (err) {
      if (err.code === 'invalid_grant') {
        await client.query('UPDATE org_integration SET reconnect_required = true WHERE clerk_org_id = $1 AND provider = $2', [orgId, provider]);
        await client.query('COMMIT');
      }
      throw err;
    }
    await client.query(
      `UPDATE org_integration SET access_token = $1, refresh_token = COALESCE($2, refresh_token),
         access_token_expires_at = now() + make_interval(secs => $3)
       WHERE clerk_org_id = $4 AND provider = $5`,
      [encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, t.expires_in, orgId, provider]);
    await client.query('COMMIT');
    return t.access_token;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Never carries tokens.
async function getIntegration(orgId, provider) {
  if (!orgId) return null;
  const { rows: [row] } = await pool.query(
    'SELECT account_email, settings, reconnect_required, connected_at FROM org_integration WHERE clerk_org_id = $1 AND provider = $2',
    [orgId, provider]);
  return row || null;
}

async function setSettings(orgId, provider, settings) {
  await pool.query('UPDATE org_integration SET settings = $1 WHERE clerk_org_id = $2 AND provider = $3', [settings, orgId, provider]);
}

module.exports = {
  PROVIDERS, IntegrationError, missingEnv, encrypt, decrypt, signState, verifyState,
  tokenRequest, getAccessToken, getIntegration, setSettings,
  // Seam: checks swap this for a fake Google.
  fetch: (...a) => fetch(...a),
};
