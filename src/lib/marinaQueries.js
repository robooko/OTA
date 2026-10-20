// SQL shared by the guest, staff and lifecycle code. Every function takes a
// pg client (or the pool) so callers can run it inside their transaction.
const { SAILOR_APPROVED_SQL } = require('./sailorDocuments');

async function propertyToday(client, propertyId) {
  const { rows: [r] } = await client.query(
    'SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM property WHERE id = $1', [propertyId]);
  return r.today;
}

async function marinaBySlug(client, propertyId, slug) {
  const { rows: [m] } = await client.query(
    "SELECT * FROM marina WHERE property_id = $1 AND slug = $2 AND status = 'active'", [propertyId, slug]);
  return m || null;
}

// A NULL departure means open-ended, same as the exclusion constraint.
const LIVE_OVERLAP = `EXISTS (SELECT 1 FROM marina_booking mb
  WHERE mb.berth_id = b.id AND mb.status IN ('hold', 'pending', 'confirmed')
    AND daterange(mb.arrival, mb.departure) && daterange($2::date, $3::date))`;

async function freeBerths(client, marinaId, arrival, departure) {
  const { rows } = await client.query(
    `SELECT b.* FROM marina_berth b
     WHERE b.marina_id = $1 AND b.status = 'active' AND NOT ${LIVE_OVERLAP}
     ORDER BY b.label`, [marinaId, arrival, departure]);
  return rows;
}

async function berthAvailability(client, marinaId, from, to) {
  const { rows } = await client.query(
    `SELECT b.id, (b.status = 'active' AND NOT ${LIVE_OVERLAP}) AS available
     FROM marina_berth b WHERE b.marina_id = $1 AND b.status <> 'inactive'`, [marinaId, from, to]);
  return new Map(rows.map((r) => [r.id, r.available]));
}

// A tier with a season takes the season's dates and repeats_yearly; an
// inactive season takes its tiers with it.
async function activeTiers(client, marinaId) {
  const { rows } = await client.query(
    `SELECT t.id, t.season_id, s.name AS season_name,
       COALESCE(s.valid_from, t.valid_from) AS valid_from, COALESCE(s.valid_to, t.valid_to) AS valid_to,
       COALESCE(s.repeats_yearly, false) AS repeats_yearly,
       t.max_length_m, t.max_beam_m, t.price_per_night, t.price_per_month, t.price_per_year,
       m.fixed_berths_flat
     FROM marina_price_tier t JOIN marina m ON m.id = t.marina_id LEFT JOIN marina_season s ON s.id = t.season_id
     WHERE t.marina_id = $1 AND t.status = 'active' AND (s.id IS NULL OR s.status = 'active')
     ORDER BY valid_from, max_length_m`, [marinaId]);
  return rows;
}

// Ready = the booking's verified mandatory requirements against the marina's
// mandatory total -- the same rule maybeAutoConfirm applies: a verified
// per-booking document, or this marina's approval of the sailor's shared
// one (SAILOR_APPROVED_SQL). Needs `mb`.
const READY_COLS = `(SELECT count(*)::int FROM marina_doc_requirement r
     WHERE r.marina_id = mb.marina_id AND r.status = 'active' AND r.mandatory) AS docs_required,
  (SELECT count(*)::int FROM marina_doc_requirement r
     WHERE r.marina_id = mb.marina_id AND r.status = 'active' AND r.mandatory
       AND (EXISTS (SELECT 1 FROM marina_document d WHERE d.booking_id = mb.id AND d.requirement_id = r.id AND d.status = 'verified')
            OR ${SAILOR_APPROVED_SQL})) AS docs_required_verified`;

async function joinedBooking(client, id) {
  const { rows: [r] } = await client.query(
    `SELECT mb.*, b.label AS berth_label, m.name AS marina_name, m.slug AS marina_slug,
            m.email AS marina_email, m.phone AS marina_phone, m.website AS marina_website,
            m.booking_url, m.response_window_hours, m.auto_confirm, p.name AS property_name,
            (SELECT count(*)::int FROM marina_document d WHERE d.booking_id = mb.id) AS doc_count,
            (SELECT count(*)::int FROM marina_document d WHERE d.booking_id = mb.id AND d.status = 'verified') AS docs_verified,
            ${READY_COLS}
     FROM marina_booking mb
     JOIN marina_berth b ON b.id = mb.berth_id
     JOIN marina m ON m.id = mb.marina_id
     JOIN property p ON p.id = mb.property_id
     WHERE mb.id = $1`, [id]);
  return r || null;
}

// A sailor's verified bookings across every marina, minus expired holds.
// Same columns as joinedBooking plus map/card fields.
async function sailorBookings(client, email) {
  const { rows } = await client.query(
    `SELECT mb.*, b.label AS berth_label, m.name AS marina_name, m.slug AS marina_slug,
            m.email AS marina_email, m.phone AS marina_phone, m.website AS marina_website,
            m.booking_url, m.response_window_hours, m.auto_confirm, p.name AS property_name,
            m.lat AS marina_lat, m.lng AS marina_lng,
            (SELECT i.url FROM marina_image i WHERE i.marina_id = m.id AND i.status = 'active' ORDER BY i.sort_order LIMIT 1) AS marina_image_url,
            EXISTS (SELECT 1 FROM marina_contract_signature s WHERE s.booking_id = mb.id AND s.agreed_at IS NOT NULL) AS has_signature,
            (SELECT count(*)::int FROM marina_document d WHERE d.booking_id = mb.id) AS doc_count,
            (SELECT count(*)::int FROM marina_document d WHERE d.booking_id = mb.id AND d.status = 'verified') AS docs_verified,
            ${READY_COLS}
     FROM marina_booking mb
     JOIN marina_berth b ON b.id = mb.berth_id
     JOIN marina m ON m.id = mb.marina_id
     JOIN property p ON p.id = mb.property_id
     WHERE lower(mb.contact_email) = $1 AND mb.email_verified
       AND NOT (mb.status = 'hold' AND mb.hold_expires_at < now())
     ORDER BY mb.arrival DESC`, [email]);
  return rows;
}

module.exports = { sailorBookings, READY_COLS, propertyToday, marinaBySlug, freeBerths, berthAvailability, activeTiers, joinedBooking };
