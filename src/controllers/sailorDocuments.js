const { Readable } = require('stream');
const pool = require('../db');
const { isValidUuid, isValidDate } = require('../middleware/validate');
const docs = require('../lib/marinaDocuments');
const { TYPE_NAMES } = require('../lib/sailorDocTypes');

// The sailor's own documents (req.sailor.email from the Clerk token). Not
// the sailor's, unknown or malformed ids are all 404: existence is never
// confirmed to anyone else.
// Spec: docs/superpowers/specs/2026-10-17-shared-sailor-documents-design.md

const MAX_DOCUMENTS = 50;
const MAX_VERSIONS = 10;
const NOT_FOUND = { error: 'Document not found' };

// approval_count here spans every marina: it's the sailor's own view.
async function ownDocuments(email, id = null) {
  const { rows } = await pool.query(
    `SELECT d.id, d.type, d.expiry_date, d.extracted_data, d.created_at,
            (SELECT count(DISTINCT a.marina_id)::int FROM sailor_document_approval a JOIN sailor_document_version v ON v.id = a.version_id
              WHERE v.document_id = d.id AND a.status = 'approved') AS approval_count,
            (SELECT coalesce(json_agg(json_build_object('id', v.id, 'file_name', v.file_name, 'content_type', v.content_type,
                                                        'size_bytes', v.size_bytes, 'uploaded_at', v.uploaded_at) ORDER BY v.uploaded_at DESC), '[]')
               FROM sailor_document_version v WHERE v.document_id = d.id) AS versions
     FROM sailor_document d
     WHERE d.email = $1 AND d.deleted_at IS NULL AND ($2::uuid IS NULL OR d.id = $2)
     ORDER BY d.created_at DESC`, [email, id]);
  return rows;
}

// expiry_date: absent -> undefined, '' / null -> null, else must be YYYY-MM-DD.
function parseExpiry(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  return isValidDate(v) ? { ok: true, value: v } : { ok: false };
}

async function listDocuments(req, res, next) {
  try { res.json(await ownDocuments(req.sailor.email)); } catch (err) { next(err); }
}

// Raw body. ?document_id= adds a version to that document; otherwise
// ?type= starts a new one. ?expiry_date= optional (the sailor's own value).
async function uploadDocument(req, res, next) {
  try {
    const { email } = req.sailor;
    const { type, document_id } = req.query;
    const expiry = parseExpiry(req.query.expiry_date);
    if (!expiry.ok) return res.status(400).json({ error: 'expiry_date must be YYYY-MM-DD' });
    let documentId = null;
    if (document_id) {
      if (!isValidUuid(document_id)) return res.status(404).json(NOT_FOUND);
      const { rows: [d] } = await pool.query(
        `SELECT d.id, (SELECT count(*)::int FROM sailor_document_version v WHERE v.document_id = d.id) AS n
         FROM sailor_document d WHERE d.id = $1 AND d.email = $2 AND d.deleted_at IS NULL`, [document_id, email]);
      if (!d) return res.status(404).json(NOT_FOUND);
      if (d.n >= MAX_VERSIONS) return res.status(409).json({ error: `At most ${MAX_VERSIONS} versions per document` });
      documentId = d.id;
    } else {
      if (!TYPE_NAMES.includes(type)) return res.status(400).json({ error: `type must be one of ${TYPE_NAMES.join(', ')}` });
      const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM sailor_document WHERE email = $1 AND deleted_at IS NULL', [email]);
      if (n >= MAX_DOCUMENTS) return res.status(409).json({ error: `At most ${MAX_DOCUMENTS} documents` });
    }
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Send the file as the request body' });
    const contentType = docs.sniffType(buf);
    if (!contentType) return res.status(400).json({ error: 'Only PDF, JPEG or PNG files are accepted' });

    const pathname = docs.sailorDocPath(email, contentType);
    await docs.store.put(pathname, buf, contentType);
    const fileName = String(req.get('X-File-Name') || '').replace(/[^\w.\- ]/g, '').slice(0, 255) || null;
    if (!documentId) {
      ({ rows: [{ id: documentId }] } = await pool.query(
        'INSERT INTO sailor_document (email, type, expiry_date) VALUES ($1, $2, $3) RETURNING id', [email, type, expiry.value ?? null]));
    } else if (expiry.value !== undefined) {
      await pool.query('UPDATE sailor_document SET expiry_date = $1 WHERE id = $2', [expiry.value, documentId]);
    }
    const { rows: [v] } = await pool.query(
      `INSERT INTO sailor_document_version (document_id, blob_pathname, file_name, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [documentId, pathname, fileName, contentType, buf.length]);
    // Awaited so the response carries the extracted expiry (kept off when the
    // sailor sent one). Never throws.
    await docs.extractSailorVersion(v.id, { keepExpiry: expiry.value !== undefined });
    res.status(201).json((await ownDocuments(email, documentId))[0]);
  } catch (err) { next(err); }
}

async function updateDocument(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json(NOT_FOUND);
    const expiry = parseExpiry((req.body || {}).expiry_date);
    if (!expiry.ok || expiry.value === undefined) return res.status(400).json({ error: 'expiry_date must be YYYY-MM-DD or null' });
    const { rowCount } = await pool.query('UPDATE sailor_document SET expiry_date = $1 WHERE id = $2 AND email = $3 AND deleted_at IS NULL',
      [expiry.value, req.params.id, req.sailor.email]);
    if (!rowCount) return res.status(404).json(NOT_FOUND);
    res.json((await ownDocuments(req.sailor.email, req.params.id))[0]);
  } catch (err) { next(err); }
}

// Files go from the store; rows stay (soft delete) so marinas' approval
// history survives without the file.
async function deleteDocument(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json(NOT_FOUND);
    const { rows: [d] } = await pool.query('SELECT id FROM sailor_document WHERE id = $1 AND email = $2 AND deleted_at IS NULL', [req.params.id, req.sailor.email]);
    if (!d) return res.status(404).json(NOT_FOUND);
    const { rows } = await pool.query('SELECT blob_pathname FROM sailor_document_version WHERE document_id = $1 AND file_deleted_at IS NULL', [d.id]);
    if (rows.length) await docs.store.del(rows.map((r) => r.blob_pathname));
    await pool.query('UPDATE sailor_document_version SET file_deleted_at = now() WHERE document_id = $1 AND file_deleted_at IS NULL', [d.id]);
    await pool.query('UPDATE sailor_document SET deleted_at = now() WHERE id = $1', [d.id]);
    res.status(204).end();
  } catch (err) { next(err); }
}

// Shared with the staff file route.
async function streamVersion(res, next, v) {
  if (v.file_deleted_at) return res.status(410).json({ error: 'File deleted' });
  const file = await docs.store.get(v.blob_pathname);
  if (!file) return res.status(404).json({ error: 'File missing' });
  res.set({ 'Content-Type': v.content_type, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  Readable.fromWeb(file.stream).on('error', next).pipe(res);
}

async function streamOwnVersion(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json(NOT_FOUND);
    const { rows: [v] } = await pool.query(
      `SELECT v.blob_pathname, v.content_type, v.file_deleted_at FROM sailor_document_version v
       JOIN sailor_document d ON d.id = v.document_id WHERE v.id = $1 AND d.email = $2`, [req.params.id, req.sailor.email]);
    if (!v) return res.status(404).json(NOT_FOUND);
    await streamVersion(res, next, v);
  } catch (err) { next(err); }
}

module.exports = { listDocuments, uploadDocument, updateDocument, deleteDocument, streamOwnVersion, streamVersion };
