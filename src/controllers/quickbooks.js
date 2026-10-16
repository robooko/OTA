const crypto = require('crypto');
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// Org-level (req.clerk_org_id from authenticateOrg): one QuickBooks Online
// company per organization -- see migrate-2026-10-16-organization-quickbooks.sql.
// QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI are the app's, in .env.

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = 75;

const apiBase = () => (process.env.QBO_ENV === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com');
const configured = () => !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET && process.env.QBO_REDIRECT_URI);
const basicAuth = () => 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');

// Same idea as the Vercel connect flow in controllers/property.js: the
// callback arrives with no Clerk session, so the org id rides in a signed
// `state`. Keyed on the client secret so it survives restarts.
const sign = (orgId) => crypto.createHmac('sha256', process.env.QBO_CLIENT_SECRET).update(orgId).digest('hex');
function signState(orgId) {
  return `${orgId}.${sign(orgId)}`;
}
function verifyState(state) {
  const [orgId, sig] = String(state ?? '').split('.');
  if (!orgId || !sig) return null;
  const expected = Buffer.from(sign(orgId));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? orgId : null;
}

class QboError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant = refresh token expired/revoked (or the user disconnected
    // the app inside QuickBooks): only a fresh connect fixes it.
    if (body.error === 'invalid_grant') throw new QboError(409, 'QuickBooks connection expired -- reconnect from Settings');
    throw new QboError(502, 'QuickBooks token request failed', body.error_description || body.error);
  }
  return body;
}

// Returns a live access token, refreshing under a row lock so two requests
// never spend the same (rotating) refresh token.
async function getAccessToken(orgId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [org] } = await client.query(
      `SELECT qbo_realm_id, qbo_refresh_token, qbo_access_token, qbo_access_token_expires_at
       FROM organization WHERE clerk_org_id = $1 FOR UPDATE`,
      [orgId]
    );
    if (!org?.qbo_refresh_token) throw new QboError(409, 'QuickBooks is not connected');
    if (org.qbo_access_token && new Date(org.qbo_access_token_expires_at) > new Date(Date.now() + 60_000)) {
      await client.query('COMMIT');
      return { accessToken: org.qbo_access_token, realmId: org.qbo_realm_id };
    }
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: org.qbo_refresh_token });
    await client.query(
      `UPDATE organization SET qbo_access_token = $1, qbo_refresh_token = $2,
         qbo_access_token_expires_at = now() + make_interval(secs => $3)
       WHERE clerk_org_id = $4`,
      [t.access_token, t.refresh_token, t.expires_in, orgId]
    );
    await client.query('COMMIT');
    return { accessToken: t.access_token, realmId: org.qbo_realm_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function getConnectUrl(req, res) {
  if (!configured()) return res.status(503).json({ error: 'QuickBooks is not configured on this server' });
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: process.env.QBO_REDIRECT_URI,
    state: signState(req.clerk_org_id),
  })}`;
  res.json({ url });
}

async function connectCallback(req, res, next) {
  try {
    const { code, state, realmId, error } = req.query;
    if (error) return res.status(400).send('QuickBooks connection was cancelled. Close this tab and try again from Settings.');
    const orgId = verifyState(state);
    if (!code || !realmId || !orgId) {
      return res.status(400).send('Invalid or expired connect link. Close this tab and try again from Settings.');
    }
    // One QuickBooks company belongs to one org -- otherwise every org
    // connected through the same Intuit login reads the same books.
    const { rows: [taken] } = await pool.query(
      'SELECT 1 FROM organization WHERE qbo_realm_id = $1 AND clerk_org_id <> $2',
      [realmId, orgId]
    );
    if (taken) {
      return res.status(409).send('That QuickBooks company is already connected to another organisation. Pick a different company, or disconnect it there first.');
    }
    let t;
    try {
      t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: process.env.QBO_REDIRECT_URI });
    } catch (err) {
      if (!(err instanceof QboError)) throw err;
      return res.status(502).send('Failed to connect QuickBooks. Close this tab and try again from Settings.');
    }
    await pool.query(
      `INSERT INTO organization (clerk_org_id, qbo_realm_id, qbo_refresh_token, qbo_access_token, qbo_access_token_expires_at, qbo_connected_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), now())
       ON CONFLICT (clerk_org_id) DO UPDATE SET
         qbo_realm_id = EXCLUDED.qbo_realm_id, qbo_refresh_token = EXCLUDED.qbo_refresh_token,
         qbo_access_token = EXCLUDED.qbo_access_token, qbo_access_token_expires_at = EXCLUDED.qbo_access_token_expires_at,
         qbo_connected_at = EXCLUDED.qbo_connected_at`,
      [orgId, realmId, t.refresh_token, t.access_token, t.expires_in]
    );
    res.send('<p>QuickBooks connected. You can close this tab and return to Settings.</p>');
  } catch (err) {
    next(err);
  }
}

async function getStatus(req, res, next) {
  try {
    const { rows: [org] } = await pool.query(
      'SELECT qbo_realm_id, qbo_connected_at FROM organization WHERE clerk_org_id = $1',
      [req.clerk_org_id]
    );
    res.json({
      configured: configured(),
      connected: !!org?.qbo_connected_at,
      realmId: org?.qbo_realm_id ?? null,
      connectedAt: org?.qbo_connected_at ?? null,
      environment: process.env.QBO_ENV === 'production' ? 'production' : 'sandbox',
    });
  } catch (err) {
    next(err);
  }
}

async function disconnect(req, res, next) {
  try {
    const { rows: [org] } = await pool.query(
      'SELECT qbo_refresh_token FROM organization WHERE clerk_org_id = $1',
      [req.clerk_org_id]
    );
    // Best effort: revoking ends the grant on Intuit's side too, but a
    // failure there mustn't leave the token stored here.
    if (org?.qbo_refresh_token && configured()) {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: org.qbo_refresh_token }),
      }).catch((err) => console.error('QuickBooks revoke failed:', err.message));
    }
    await pool.query(
      `UPDATE organization SET qbo_realm_id = NULL, qbo_refresh_token = NULL, qbo_access_token = NULL,
         qbo_access_token_expires_at = NULL, qbo_connected_at = NULL
       WHERE clerk_org_id = $1`,
      [req.clerk_org_id]
    );
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
}

const COST_GROUPS = ['COGS', 'Expenses', 'OtherExpenses'];
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

// QBO's ProfitAndLoss report JSON -> flat cost lines. Sections nest
// (parent account -> sub-accounts); only the leaf Data rows carry amounts,
// and a parent with direct postings shows up as its own Data row inside.
function summarizeProfitAndLoss(report) {
  const sections = report?.Rows?.Row ?? [];
  const total = (group) => money(sections.find((s) => s.group === group)?.Summary?.ColData?.[1]?.value);
  const leaves = (rows) => (rows ?? []).flatMap((r) => (r.Rows ? leaves(r.Rows.Row) : r.type === 'Data' && r.ColData ? [r] : []));

  const costs = sections
    .filter((s) => COST_GROUPS.includes(s.group))
    .flatMap((s) => leaves(s.Rows?.Row).map((r) => ({
      group: s.group,
      account: r.ColData[0].value,
      account_id: r.ColData[0].id ?? null,
      amount: money(r.ColData[1]?.value),
    })))
    .filter((c) => c.amount !== 0);

  return {
    currency: report?.Header?.Currency ?? null,
    income: total('Income'),
    total_costs: money(COST_GROUPS.reduce((sum, g) => sum + total(g), 0)),
    net_income: total('NetIncome'),
    costs,
  };
}

// summarize_column_by=Month report -> one row per month column (the last,
// "Total", column is dropped). Same groups and totals as above.
function summarizeProfitAndLossByMonth(report) {
  const sections = report?.Rows?.Row ?? [];
  const monthCols = (report?.Columns?.Column ?? [])
    .map((c, i) => ({ i, start: c.MetaData?.find((m) => m.Name === 'StartDate')?.Value }))
    .filter((c) => c.i > 0 && c.start);
  const total = (group, i) => money(sections.find((s) => s.group === group)?.Summary?.ColData?.[i]?.value);
  return {
    currency: report?.Header?.Currency ?? null,
    months: monthCols.map(({ i, start }) => ({
      month: start.slice(0, 7),
      income: total('Income', i),
      total_costs: money(COST_GROUPS.reduce((sum, g) => sum + total(g, i), 0)),
      net_income: total('NetIncome', i),
    })),
  };
}

// GET ?from=&to= (to exclusive, like every other range here; QBO's
// end_date is inclusive) &location= (QBO Location/Department id) &class=
// &by=month (per-month totals instead of cost lines)
async function getProfitAndLoss(req, res, next) {
  try {
    const { from, to, location, class: classId, by } = req.query;
    if (!isValidDate(from) || !isValidDate(to) || from >= to) {
      return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD, from < to, to exclusive)' });
    }
    const endDate = new Date(Date.parse(to) - 86_400_000).toISOString().slice(0, 10);

    const { accessToken, realmId } = await getAccessToken(req.clerk_org_id);
    const params = new URLSearchParams({ start_date: from, end_date: endDate, minorversion: MINOR_VERSION });
    if (location) params.set('department', location);
    if (classId) params.set('class', classId);
    if (by === 'month') params.set('summarize_column_by', 'Month');

    const qbo = await fetch(`${apiBase()}/v3/company/${encodeURIComponent(realmId)}/reports/ProfitAndLoss?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const body = await qbo.json().catch(() => ({}));
    if (!qbo.ok) {
      const fault = body.Fault?.Error?.[0];
      return res.status(502).json({ error: 'QuickBooks report request failed', details: fault?.Detail || fault?.Message || `HTTP ${qbo.status}` });
    }
    res.json({ from, to, ...(by === 'month' ? summarizeProfitAndLossByMonth(body) : summarizeProfitAndLoss(body)) });
  } catch (err) {
    if (err instanceof QboError) return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
    next(err);
  }
}

module.exports = { getConnectUrl, connectCallback, getStatus, disconnect, getProfitAndLoss, summarizeProfitAndLoss, summarizeProfitAndLossByMonth, signState, verifyState };
