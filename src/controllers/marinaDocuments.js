const pool = require('../db');
const { isValidUuid, isValidDate } = require('../middleware/validate');
const docs = require('../lib/marinaDocuments');
const life = require('../lib/marinaLifecycle');
const q = require('../lib/marinaQueries');
const kc = require('../lib/marinaContracts');
const { nightsBetween } = require('../lib/marinaPricing');
const sd = require('../lib/sailorDocuments');
const { streamVersion } = require('./sailorDocuments');
const storage = require('../lib/marinaStorage');
const drive = require('../lib/googleDrive');
const { IntegrationError } = require('../lib/integrations');

// Guest upload (raw body, booking token). Only while pending/confirmed, so
// a card-free hold can't trigger paid extraction. The file goes to the
// org's own Google Drive (marinaStorage) and nowhere else: OTA keeps the
// record and the Drive pointer only.
async function uploadDocument(req, res, next) {
  try {
    const b = req.booking;
    if (!['pending', 'confirmed'].includes(b.status)) return res.status(409).json({ error: 'Documents can be uploaded once the booking request is with the marina' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Send the file as the request body' });
    const type = docs.sniffType(buf);
    if (!type) return res.status(400).json({ error: 'Only PDF, JPEG or PNG files are accepted' });
    const { requirement_id } = req.query;
    let requirement = null;
    if (requirement_id) {
      if (!isValidUuid(requirement_id)) return res.status(400).json({ error: 'Invalid requirement_id' });
      ({ rows: [requirement] } = await pool.query("SELECT id, type FROM marina_doc_requirement WHERE id = $1 AND marina_id = $2 AND status = 'active'", [requirement_id, b.marina_id]));
      if (!requirement) return res.status(400).json({ error: 'Unknown requirement_id' });
    }
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM marina_document WHERE booking_id = $1', [b.id]);
    if (n >= docs.MAX_PER_BOOKING) return res.status(409).json({ error: `At most ${docs.MAX_PER_BOOKING} documents per booking` });

    const st = await storage.status(b.property_id);
    if (!st.ok) { const r = storage.refusal(st); return res.status(r.status).json(r.json); }
    const fileName = String(req.get('X-File-Name') || '').replace(/[^\w.\- ]/g, '').slice(0, 255) || null;
    const { rows: [p] } = await pool.query('SELECT name FROM property WHERE id = $1', [b.property_id]);
    let file;
    try {
      file = await drive.uploadMarinaDocument(st.orgId, {
        path: ['OTA', p.name, req.marina.name, `${b.arrival} ${b.contact_name} (${b.id.slice(0, 8)})`],
        fileName: fileName || `document.${docs.EXT[type]}`, contentType: type, buf,
      });
    } catch (err) {
      if (!(err instanceof IntegrationError)) throw err;
      // Revoked between the status check and the upload: same refusal.
      if (err.status === 409) { const r = storage.refusal({ reason: 'reconnect' }); return res.status(r.status).json(r.json); }
      return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
    }
    const { rows: [d] } = await pool.query(
      `INSERT INTO marina_document (property_id, marina_id, booking_id, requirement_id, type, drive_file_id, drive_web_link, file_name, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, requirement_id, type, file_name, content_type, size_bytes, status, submitted_at`,
      [b.property_id, b.marina_id, b.id, requirement?.id ?? null, requirement?.type ?? null, file.id, file.webViewLink, fileName, type, buf.length]);
    docs.extractDocument(d.id, buf);
    // Staff tables and an open detail dialog update live (doc_count).
    await life.republish(b.id);
    res.status(201).json(d);
  } catch (err) { next(err); }
}

async function listBookingDocuments(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Booking not found' });
    const { rows } = await pool.query(
      `SELECT d.id, d.requirement_id, r.name AS requirement_name, d.type, d.file_name, d.content_type, d.size_bytes, d.extracted_data,
              d.expiry_date, d.status, d.notes, d.submitted_at, d.verified_at, d.verified_by, d.drive_web_link
       FROM marina_document d LEFT JOIN marina_doc_requirement r ON r.id = d.requirement_id
       WHERE d.booking_id = $1 AND d.property_id = $2 ORDER BY d.submitted_at`, [req.params.id, req.property_id]);
    res.json(rows);
  } catch (err) { next(err); }
}

// The staff verification panel in one read: the marina's active
// requirements (with mandatory), every document on the booking, and the
// contract -- the signed snapshot, or an unsigned preview of the template
// this stay would get (same pick as agreeContract), or null when none applies.
async function getBookingVerification(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Booking not found' });
    const b = await q.joinedBooking(pool, req.params.id);
    if (!b || b.property_id !== req.property_id) return res.status(404).json({ error: 'Booking not found' });
    const [reqs, documents, sig, templates] = await Promise.all([
      pool.query("SELECT id, type, name, mandatory FROM marina_doc_requirement WHERE marina_id = $1 AND status = 'active' ORDER BY sort_order, name", [b.marina_id]),
      pool.query(
        `SELECT d.id, d.requirement_id, r.name AS requirement_name, d.type, d.file_name, d.content_type, d.size_bytes, d.extracted_data,
                d.expiry_date, d.status, d.notes, d.submitted_at, d.verified_at, d.drive_web_link
         FROM marina_document d LEFT JOIN marina_doc_requirement r ON r.id = d.requirement_id
         WHERE d.booking_id = $1 ORDER BY d.submitted_at`, [b.id]),
      pool.query(
        `SELECT s.agreed_at, s.signer_email, s.rendered_body, t.name FROM marina_contract_signature s
         LEFT JOIN marina_contract_template t ON t.id = s.template_id WHERE s.booking_id = $1`, [b.id]),
      b.departure ? pool.query("SELECT id, name, body_markdown, min_nights FROM marina_contract_template WHERE marina_id = $1 AND status = 'active'", [b.marina_id]) : { rows: [] },
    ]);
    let contract = null;
    const s = sig.rows[0];
    if (s) contract = { name: s.name ?? 'Contract', signed: true, agreed_at: s.agreed_at, signer_email: s.signer_email, rendered_body: s.rendered_body };
    else if (b.departure) {
      const t = kc.pickTemplate(templates.rows, nightsBetween(b.arrival, b.departure));
      if (t) contract = { name: t.name, signed: false, rendered_body: kc.renderContract(t.body_markdown, kc.contractContext(b, await q.propertyToday(pool, b.property_id))) };
    }
    // No fallback store: say so when guests can't upload and something is still owed.
    const st = await storage.status(b.property_id);
    const warning = !st.ok && b.docs_required > b.docs_required_verified ? storage.staffWarning(st) : null;
    res.json({ requirements: reqs.rows, documents: documents.rows, contract, sailor: await sailorBlock(b),
      document_uploads: { ok: st.ok, reason: st.ok ? null : st.reason }, warning });
  } catch (err) { next(err); }
}

// Shared sailor documents on the panel: only for a booking whose email came
// from the sailor's token. Each version carries this marina's own verdict.
async function sailorBlock(b) {
  if (!b.email_verified) return null;
  const statuses = await sd.requirementStatus(pool, { marinaId: b.marina_id, email: b.contact_email, arrival: b.arrival, departure: b.departure });
  const versionIds = statuses.flatMap((s) => s.document?.versions.map((v) => v.id) ?? []);
  const { rows } = await pool.query('SELECT version_id, status, notes, decided_at FROM sailor_document_approval WHERE marina_id = $1 AND version_id = ANY($2)', [b.marina_id, versionIds]);
  const mine = new Map(rows.map(({ version_id, ...v }) => [version_id, v]));
  return {
    email: sd.normalEmail(b.contact_email),
    requirements: statuses.map(({ requirement, document }) => ({
      requirement_id: requirement.id,
      document: document && { ...document, versions: document.versions.map((v) => ({ ...v, my_verdict: mine.get(v.id) ?? null })) },
    })),
  };
}

const marinaIdsOf = async (propertyId) => (await pool.query('SELECT id FROM marina WHERE property_id = $1', [propertyId])).rows.map((r) => r.id);

// A sailor's file for staff: 404 unless one of this property's marinas has a
// verified-email booking for that sailor (sd.canStaffSee).
async function streamSailorVersion(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Document not found' });
    const { rows: [v] } = await pool.query(
      `SELECT v.blob_pathname, v.content_type, v.file_deleted_at, d.email FROM sailor_document_version v
       JOIN sailor_document d ON d.id = v.document_id WHERE v.id = $1`, [req.params.id]);
    if (!v || !(await sd.canStaffSee(pool, { marinaIds: await marinaIdsOf(req.property_id), email: v.email }))) return res.status(404).json({ error: 'Document not found' });
    await streamVersion(res, next, v);
  } catch (err) { next(err); }
}

// This marina's verdict on one version of the booking sailor's document;
// re-deciding overwrites. expiry_date (optional) corrects the document.
async function decideSailorVersion(req, res, next) {
  try {
    const { id, versionId } = req.params;
    if (!isValidUuid(id) || !isValidUuid(versionId)) return res.status(404).json({ error: 'Not found' });
    const { status, notes, expiry_date } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
    if (expiry_date !== undefined && expiry_date !== null && !isValidDate(expiry_date)) return res.status(400).json({ error: 'expiry_date must be YYYY-MM-DD or null' });
    const { rows: [b] } = await pool.query('SELECT id, marina_id, property_id, contact_email, email_verified FROM marina_booking WHERE id = $1 AND property_id = $2', [id, req.property_id]);
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (!b.email_verified) return res.status(409).json({ error: 'The booking email is not verified, so it has no shared documents' });
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.document_id FROM sailor_document_version v JOIN sailor_document d ON d.id = v.document_id
       WHERE v.id = $1 AND d.deleted_at IS NULL AND d.email = $2`, [versionId, sd.normalEmail(b.contact_email)]);
    if (!v) return res.status(404).json({ error: 'Document not found' });
    if (expiry_date !== undefined) await pool.query('UPDATE sailor_document SET expiry_date = $1 WHERE id = $2', [expiry_date, v.document_id]);
    // Records the expiry it was given against (sd.SAILOR_APPROVED_SQL).
    const { rows: [verdict] } = await pool.query(
      `INSERT INTO sailor_document_approval (version_id, marina_id, property_id, status, notes, staff_user, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT expiry_date FROM sailor_document WHERE id = $7))
       ON CONFLICT (version_id, marina_id) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, staff_user = EXCLUDED.staff_user,
         expiry_date = EXCLUDED.expiry_date, decided_at = now()
       RETURNING version_id, status, notes, staff_user, expiry_date, decided_at`,
      [v.id, b.marina_id, b.property_id, status, notes ?? null, req.user?.id ?? null, v.document_id]);
    await life.republish(b.id);
    if (status === 'approved') life.maybeAutoConfirm(b.id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
    res.json(verdict);
  } catch (err) { next(err); }
}


async function updateDocument(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Document not found' });
    const { status, notes } = req.body || {};
    if (status !== undefined && !['verified', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'status must be verified, rejected or pending' });
    const { rows: [d] } = await pool.query(
      `UPDATE marina_document SET status = COALESCE($1, status), notes = COALESCE($2, notes),
              verified_at = CASE WHEN $1 = 'verified' THEN now() WHEN $1 IS NULL THEN verified_at END,
              verified_by = CASE WHEN $1 = 'verified' THEN $3 WHEN $1 IS NULL THEN verified_by END
       WHERE id = $4 AND property_id = $5
       RETURNING id, booking_id, status, notes, verified_at, verified_by`,
      [status ?? null, notes ?? null, req.user?.id ?? null, req.params.id, req.property_id]);
    if (!d) return res.status(404).json({ error: 'Document not found' });
    // Before auto-confirm, so the feed sees the document change ahead of any
    // confirmation it triggers.
    await life.republish(d.booking_id);
    if (status === 'verified') life.maybeAutoConfirm(d.booking_id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
    res.json(d);
  } catch (err) { next(err); }
}

module.exports = { uploadDocument, listBookingDocuments, getBookingVerification, updateDocument, streamSailorVersion, decideSailorVersion };
