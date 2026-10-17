const pool = require('../db');
const integ = require('./integrations');

// Where a marina's per-booking documents can go: only the property's org's
// own Google Drive. No fallback -- when this says no, OTA stores nothing.
// Spec: docs/superpowers/specs/2026-10-17-per-org-storage-google-drive-design.md

const PROVIDER = 'google_drive';
const NO_UPLOADS = "This marina can't accept document uploads yet";

// { ok: true, orgId } | { ok: false, reason: 'not_configured' | 'not_connected' | 'reconnect', missing? }
async function status(propertyId) {
  const missing = integ.missingEnv(PROVIDER);
  if (missing.length) return { ok: false, reason: 'not_configured', missing };
  const { rows: [p] } = await pool.query('SELECT clerk_org_id FROM property WHERE id = $1', [propertyId]);
  const row = await integ.getIntegration(p?.clerk_org_id, PROVIDER);
  if (!row) return { ok: false, reason: 'not_connected' };
  if (row.reconnect_required) return { ok: false, reason: 'reconnect' };
  return { ok: true, orgId: p.clerk_org_id };
}

// The guest-facing refusal for a status that isn't ok.
function refusal(st) {
  if (st.reason === 'not_configured') return { status: 503, json: { error: 'Google Drive is not configured on this server', details: `Missing: ${st.missing.join(', ')}` } };
  const details = st.reason === 'reconnect'
    ? "The marina's Google Drive connection needs to be reconnected"
    : 'The marina has not connected document storage';
  return { status: 409, json: { error: NO_UPLOADS, details } };
}

// Staff copy when guests can't upload and a mandatory requirement is unmet.
const staffWarning = (st) => `Guests can't upload documents: ${st.reason === 'reconnect' ? 'reconnect' : 'connect'} Google Drive in Settings`;

module.exports = { status, refusal, staffWarning, NO_UPLOADS };
