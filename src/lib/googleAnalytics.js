// Google Analytics 4 visitor counts for the dashboard's visitors chart -- the
// alternative to Vercel Web Analytics, per website (property_website.
// ga4_property_id). Reads with ONE Forge service account that each venue adds
// as a Viewer on their own GA4 property, so there's no per-venue login or
// token to expire.
//
// No Google SDK: @google-analytics/data drags in gRPC for two REST calls. The
// service account JWT is signed with node:crypto and exchanged for an access
// token, then the Data API's runReport is called over plain fetch.
//
// GA_SERVICE_ACCOUNT_JSON holds the whole key file (the JSON Google Cloud
// downloads), as one env var.
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

let serviceAccount;
function loadServiceAccount() {
  if (serviceAccount !== undefined) return serviceAccount;
  const raw = process.env.GA_SERVICE_ACCOUNT_JSON;
  if (!raw) return (serviceAccount = null);
  try {
    const parsed = JSON.parse(raw);
    serviceAccount = parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    console.error('GA_SERVICE_ACCOUNT_JSON is set but is not valid JSON -- Google Analytics is disabled');
    serviceAccount = null;
  }
  return serviceAccount;
}

function isConfigured() {
  return !!loadServiceAccount();
}

/** The address a venue grants Viewer access to in GA4. Null when unset. */
function serviceAccountEmail() {
  return loadServiceAccount()?.client_email ?? null;
}

const base64url = (input) => Buffer.from(input).toString('base64url');

// Tokens last an hour; one is shared by every property, and refreshed a
// minute early so an in-flight report never races the expiry.
let cachedToken = null;
async function accessToken() {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;
  const sa = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  )}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const body = await res.json();
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

/** "properties/123456789", " 123456789 " -> "123456789"; anything else -> null. */
function normalisePropertyId(value) {
  const id = String(value ?? '').trim().replace(/^properties\//, '');
  return /^\d{5,15}$/.test(id) ? id : null;
}

// Thrown when Google refuses the property itself -- almost always because the
// venue hasn't added the service account as a Viewer yet. Carries a message
// that says what to do, since the dashboard shows it as-is.
class Ga4AccessError extends Error {
  constructor(propertyId) {
    super(`No access to GA4 property ${propertyId} -- add ${serviceAccountEmail()} as a Viewer in Google Analytics`);
    this.name = 'Ga4AccessError';
  }
}

/**
 * Same shape as property.js's fetchVercelAnalytics, so the chart doesn't care
 * which source it came from: { visitors, pageviews, daily: [{ date, visitors,
 * pageviews }] }. `visitors` is GA's activeUsers -- what the GA UI calls
 * "Users" -- and the total is GA's own de-duplicated figure, not a sum of the
 * days (summing daily users double-counts anyone who came back).
 */
async function fetchGa4Analytics({ propertyId, sinceIso, untilIso }) {
  const startDate = sinceIso.slice(0, 10);
  const endDate = untilIso.slice(0, 10);
  const res = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }],
      metricAggregations: ['TOTAL'],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
  });
  if (res.status === 403 || res.status === 404) {
    // A 403 also comes back when the Data API itself is switched off on the
    // service account's Cloud project -- that's our setup, not the venue's,
    // and telling them to re-add the Viewer would send them round in circles.
    const err = await res.json().catch(() => null);
    const disabled = (err?.error?.details ?? []).some((d) => d.reason === 'SERVICE_DISABLED');
    if (disabled) throw new Error('The Google Analytics Data API is not enabled on the service account\'s Cloud project');
    throw new Ga4AccessError(propertyId);
  }
  if (!res.ok) return null;
  const body = await res.json();

  const byDate = new Map(
    (body.rows ?? []).map((row) => {
      const d = row.dimensionValues[0].value; // YYYYMMDD
      return [`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, row.metricValues.map((m) => Number(m.value))];
    })
  );
  // GA leaves out days with no traffic; the chart wants every day on the
  // axis, the way Vercel returns them, or a quiet week just vanishes.
  const daily = [];
  for (let day = new Date(`${startDate}T00:00:00Z`); day <= new Date(`${endDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const [visitors = 0, pageviews = 0] = byDate.get(date) ?? [];
    daily.push({ date, visitors, pageviews });
  }
  const totals = body.totals?.[0]?.metricValues ?? [];
  return {
    visitors: Number(totals[0]?.value ?? 0),
    pageviews: Number(totals[1]?.value ?? 0),
    daily,
  };
}

module.exports = { isConfigured, serviceAccountEmail, normalisePropertyId, fetchGa4Analytics, Ga4AccessError };
