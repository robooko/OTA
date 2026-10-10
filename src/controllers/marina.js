const pool = require('../db');

// Step 2 of unifying OTA and sidon-marina: berth bookings still live in
// Sidon's database, so OTA reads them through Sidon's keyed bookings
// endpoint, server-side -- the key must never reach a browser (Sidon's CORS
// accepts X-Marina-Key from any origin). Goes away once the marina tables
// move into OTA.
const SIDON_API_ORIGIN = process.env.SIDON_API_ORIGIN || 'https://marina.sidonmarine.uk';

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

// Sidon errors come back as 502, never 401/403 -- the dashboard's apiFetch
// would read those as the staff member's own session failing.
async function listMarinaBookings(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT sidon_marina_id, sidon_marina_key FROM property WHERE id = $1', [req.property_id]);
    const { sidon_marina_id: marinaId, sidon_marina_key: key } = rows[0] ?? {};
    if (!marinaId || !key) {
      return res.status(409).json({ error: 'Link a Sidon marina and set its API key in Settings first' });
    }

    let upstream;
    try {
      upstream = await fetch(`${SIDON_API_ORIGIN}/api/marina/public/${encodeURIComponent(marinaId)}/bookings`, {
        headers: { 'X-Marina-Key': key },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return res.status(502).json({ error: 'Sidon did not respond' });
    }
    if (upstream.status === 401) return res.status(502).json({ error: 'Sidon rejected the marina API key' });
    if (!upstream.ok) return res.status(502).json({ error: `Sidon returned ${upstream.status}` });
    const bookings = await upstream.json().catch(() => null);
    if (!Array.isArray(bookings)) return res.status(502).json({ error: 'Unexpected response from Sidon' });

    // Whitelisted and snake_cased: Sidon's row also carries Stripe payment
    // ids and sailor account ids the dashboard has no use for.
    // ponytail: Sidon returns every booking ever (no date filter); add one
    // upstream if a marina's history gets large.
    res.json(bookings.map((b) => ({
      id: b.id,
      berth_id: b.berthId,
      sailor_name: b.sailorName,
      sailor_email: b.sailorEmail,
      boat_name: b.boatName,
      boat_loa: b.boatLoa,
      boat_beam: b.boatBeam,
      arrival_date: b.arrivalDate,
      departure_date: b.departureDate,
      nights: b.nights,
      notes: b.notes,
      status: b.status,
      amount_cents: b.amountCents,
      expires_at: b.expiresAt,
      created_at: b.createdAt,
    })));
  } catch (err) {
    next(err);
  }
}

module.exports = { setSidonMarinaKey, clearSidonMarinaKey, listMarinaBookings };
