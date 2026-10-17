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

async function activeTiers(client, marinaId) {
  const { rows } = await client.query(
    "SELECT * FROM marina_price_tier WHERE marina_id = $1 AND status = 'active'", [marinaId]);
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

module.exports = { READY_COLS, propertyToday, marinaBySlug, freeBerths, berthAvailability, activeTiers, joinedBooking };
