const { EXPIRY_REQUIRED } = require('./sailorDocTypes');

// Shared sailor documents: which of a marina's requirements a sailor meets
// for a stay, and whether a marina's staff may see a sailor's documents.
// Spec: docs/superpowers/specs/2026-10-17-shared-sailor-documents-design.md

const normalEmail = (s) => String(s ?? '').trim().toLowerCase();

// Per active requirement, the sailor's document that meets it or null. Met:
// not deleted, right type, expiry on/after departure (arrival when
// open-ended); null expiry only for types that needn't have one. Several
// candidates -> the newest. approval_count: other marinas that approved any
// version (never names or notes). latest: the newest document of the type
// whatever its expiry, so a guest can be told why it doesn't count.
async function requirementStatus(db, { marinaId, email, arrival, departure }) {
  const [{ rows: reqs }, { rows: docs }, { rows: newest }] = await Promise.all([
    db.query("SELECT id, type, name, mandatory FROM marina_doc_requirement WHERE marina_id = $1 AND status = 'active' ORDER BY sort_order, name", [marinaId]),
    db.query(
      `SELECT DISTINCT ON (d.type) d.id, d.type, d.expiry_date,
              (SELECT count(DISTINCT a.marina_id)::int FROM sailor_document_approval a JOIN sailor_document_version v ON v.id = a.version_id
                WHERE v.document_id = d.id AND a.status = 'approved' AND a.marina_id <> $1) AS approval_count,
              (SELECT coalesce(json_agg(json_build_object('id', v.id, 'file_name', v.file_name, 'uploaded_at', v.uploaded_at) ORDER BY v.uploaded_at DESC), '[]')
                 FROM sailor_document_version v WHERE v.document_id = d.id) AS versions
       FROM sailor_document d
       WHERE d.email = $2 AND d.deleted_at IS NULL
         AND ((d.expiry_date IS NULL AND d.type <> ALL($4)) OR d.expiry_date >= $3)
       ORDER BY d.type, d.created_at DESC`,
      [marinaId, normalEmail(email), departure ?? arrival, EXPIRY_REQUIRED]),
    db.query('SELECT DISTINCT ON (type) id, type, expiry_date FROM sailor_document WHERE email = $1 AND deleted_at IS NULL ORDER BY type, created_at DESC',
      [normalEmail(email)]),
  ]);
  const byType = new Map(docs.map((d) => [d.type, d]));
  const latestByType = new Map(newest.map((d) => [d.type, d]));
  return reqs.map((requirement) => ({ requirement, document: byType.get(requirement.type) ?? null, latest: latestByType.get(requirement.type) ?? null }));
}

const missingMandatory = (statuses) => statuses.filter((s) => s.requirement.mandatory && !s.document)
  .map(({ requirement: { id, type, name } }) => ({ id, type, name }));

// The only link from staff to a sailor's documents: a booking at one of
// their marinas whose email came from the sailor's token. Any status, any age.
async function canStaffSee(db, { marinaIds, email }) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM marina_booking WHERE marina_id = ANY($1) AND email_verified AND lower(contact_email) = $2 LIMIT 1',
    [marinaIds, normalEmail(email)]);
  return rowCount > 0;
}

// SQL (needs aliases mb = marina_booking, r = marina_doc_requirement): r is
// met for mb through shared documents -- the booking's email is verified,
// and this marina's verdict on the NEWEST version of the sailor's current
// document (same pick as requirementStatus) is 'approved' at the document's
// present expiry. Used by auto-confirm and the staff readiness counters.
const SAILOR_APPROVED_SQL = `(mb.email_verified AND EXISTS (
  SELECT 1 FROM (SELECT d.id, d.expiry_date FROM sailor_document d
                 WHERE d.email = lower(trim(mb.contact_email)) AND d.type = r.type AND d.deleted_at IS NULL
                   AND ((d.expiry_date IS NULL AND d.type NOT IN (${EXPIRY_REQUIRED.map((t) => `'${t}'`).join(', ')}))
                        OR d.expiry_date >= coalesce(mb.departure, mb.arrival))
                 ORDER BY d.created_at DESC LIMIT 1) cur
  JOIN LATERAL (SELECT v.id FROM sailor_document_version v WHERE v.document_id = cur.id ORDER BY v.uploaded_at DESC LIMIT 1) nv ON true
  JOIN sailor_document_approval a ON a.version_id = nv.id AND a.marina_id = mb.marina_id AND a.status = 'approved'
                                 AND a.expiry_date IS NOT DISTINCT FROM cur.expiry_date))`;

module.exports = { requirementStatus, missingMandatory, canStaffSee, normalEmail, SAILOR_APPROVED_SQL };
