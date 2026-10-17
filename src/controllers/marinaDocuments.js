const { Readable } = require('stream');
const pool = require('../db');
const { isValidUuid } = require('../middleware/validate');
const docs = require('../lib/marinaDocuments');
const life = require('../lib/marinaLifecycle');
const q = require('../lib/marinaQueries');
const kc = require('../lib/marinaContracts');
const { nightsBetween } = require('../lib/marinaPricing');

// Guest upload (raw body, booking token). Accepted from the hold onwards so
// the guest can attach documents while booking; extraction (paid) waits
// until the hold reaches pending -- see afterChange.
async function uploadDocument(req, res, next) {
  try {
    const b = req.booking;
    if (!['hold', 'pending', 'confirmed'].includes(b.status)) return res.status(409).json({ error: `Booking is ${b.status}` });
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

    const pathname = docs.docPath(b.property_id, b.id, type);
    await docs.store.put(pathname, buf, type);
    const fileName = String(req.get('X-File-Name') || '').replace(/[^\w.\- ]/g, '').slice(0, 255) || null;
    const { rows: [d] } = await pool.query(
      `INSERT INTO marina_document (property_id, marina_id, booking_id, requirement_id, type, blob_pathname, file_name, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, requirement_id, type, file_name, content_type, size_bytes, status, submitted_at`,
      [b.property_id, b.marina_id, b.id, requirement?.id ?? null, requirement?.type ?? null, pathname, fileName, type, buf.length]);
    if (b.status !== 'hold') docs.extractDocument(d.id);
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
              d.expiry_date, d.status, d.notes, d.submitted_at, d.verified_at, d.verified_by, d.file_deleted_at
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
                d.expiry_date, d.status, d.notes, d.submitted_at, d.verified_at, d.file_deleted_at
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
    res.json({ requirements: reqs.rows, documents: documents.rows, contract });
  } catch (err) { next(err); }
}

async function streamDocumentFile(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Document not found' });
    const { rows: [d] } = await pool.query('SELECT blob_pathname, content_type, file_deleted_at FROM marina_document WHERE id = $1 AND property_id = $2', [req.params.id, req.property_id]);
    if (!d) return res.status(404).json({ error: 'Document not found' });
    if (d.file_deleted_at) return res.status(410).json({ error: 'File deleted under the retention policy' });
    const file = await docs.store.get(d.blob_pathname);
    if (!file) return res.status(404).json({ error: 'File missing' });
    res.set({ 'Content-Type': d.content_type, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    Readable.fromWeb(file.stream).on('error', next).pipe(res);
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

module.exports = { uploadDocument, listBookingDocuments, getBookingVerification, streamDocumentFile, updateDocument };
