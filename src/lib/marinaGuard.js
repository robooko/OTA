const net = require('net');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { emailKey } = require('./spaBookingGuard');
const { isValidDate } = require('../middleware/validate');
const { nightsBetween } = require('./marinaPricing');

// Guards on the guest rail (X-Api-Key, via a site's forwarder): the spa
// pattern from spaBookingGuard.js, plus berth fit and per-visitor limits.
const MAX_UPCOMING = 3;
const HOLD_MINUTES = 30;
const MAX_NIGHTS = 90;
const LOCALES = ['en', 'it', 'fr', 'es'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const posNum = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : NaN);

// `status` is deliberately not read: guests can never set it.
function validateGuestBooking(body, today) {
  const b = body || {};
  const value = {
    berth_label: str(b.berth_label, 30),
    arrival: b.arrival,
    departure: b.departure,
    contact_name: str(b.contact_name, 100),
    contact_email: str(b.contact_email, 255),
    contact_phone: b.contact_phone ? str(b.contact_phone, 30) : null,
    boat_name: str(b.boat_name, 100),
    boat_length_m: posNum(b.boat_length_m),
    boat_beam_m: posNum(b.boat_beam_m),
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : null,
    locale: LOCALES.includes(b.locale) ? b.locale : 'en',
  };
  if (!value.berth_label) return { ok: false, error: 'berth_label is required' };
  if (!value.contact_name) return { ok: false, error: 'contact_name is required' };
  if (!value.contact_email || !EMAIL_RE.test(value.contact_email)) return { ok: false, error: 'A valid contact_email is required' };
  if (!value.boat_name) return { ok: false, error: 'boat_name is required' };
  if (value.boat_length_m == null || Number.isNaN(value.boat_length_m)) return { ok: false, error: 'boat_length_m must be a positive number' };
  if (Number.isNaN(value.boat_beam_m)) return { ok: false, error: 'boat_beam_m must be a positive number' };
  if (!isValidDate(value.arrival) || !isValidDate(value.departure)) return { ok: false, error: 'arrival and departure must be YYYY-MM-DD' };
  if (value.arrival < today) return { ok: false, error: 'arrival is in the past' };
  if (value.departure <= value.arrival) return { ok: false, error: 'departure must be after arrival' };
  if (nightsBetween(value.arrival, value.departure) > MAX_NIGHTS) return { ok: false, error: `Stays are limited to ${MAX_NIGHTS} nights online; contact the marina` };
  return { ok: true, value };
}

// Each check is skipped when the berth doesn't record that limit.
function berthFitError(berth, boatLengthM, boatBeamM) {
  if (berth.length_m != null && boatLengthM > Number(berth.length_m)) return 'The boat is too long for this berth';
  if (berth.min_length_m != null && boatLengthM < Number(berth.min_length_m)) return 'The boat is too short for this berth';
  if (berth.beam_m != null && boatBeamM != null && boatBeamM > Number(berth.beam_m)) return 'The boat beam is too wide for this berth';
  return null;
}

// Takes the per-email advisory lock for the rest of the caller's
// transaction (so two concurrent requests can't both see 2), then counts
// upcoming live bookings for the normalised email.
async function checkEmailCap(client, propertyId, email, today) {
  const key = emailKey(email);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`marina-email:${propertyId}:${key}`]);
  const { rows: [{ n }] } = await client.query(
    `SELECT count(*)::int AS n FROM marina_booking
     WHERE property_id = $1 AND contact_email_key = $2
       AND status IN ('hold', 'pending', 'confirmed')
       AND (departure IS NULL OR departure > $3)`,
    [propertyId, key, today]
  );
  return { ok: n < MAX_UPCOMING, key };
}

// X-Client-Ip is set by the site's forwarder from Astro's clientAddress
// (overwriting anything inbound). Read only on the key rail; never
// X-Forwarded-For, which Render appends to. IPv6 is grouped by /64 so one
// host can't rotate through its prefix.
function clientIp(req) {
  if (req.auth_method !== 'api_key') return null;
  const ip = String(req.headers['x-client-ip'] || '').trim();
  if (!net.isIP(ip)) return null;
  return net.isIPv6(ip) ? ipKeyGenerator(ip, 64) : ip;
}

// A key-rail request with no forwarder header shares one bucket per property.
const clientIpKey = (req) => clientIp(req) || `property:${req.property_id}`;

function guestLimiter(name, max) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.auth_method !== 'api_key' && req.auth_method !== 'sailor',
    // Sailor rail: one bucket per verified email, across marinas.
    keyGenerator: (req) => (req.auth_method === 'sailor' ? `${name}:sailor:${req.sailor.email}` : `${name}:${req.property_id}:${clientIpKey(req)}`),
    handler: (req, res) => res.status(429).json({ error: 'Too many requests, please try again later' }),
  });
}

module.exports = { MAX_UPCOMING, HOLD_MINUTES, MAX_NIGHTS, validateGuestBooking, berthFitError, checkEmailCap, clientIp, clientIpKey, guestLimiter };
