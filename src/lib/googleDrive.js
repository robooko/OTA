const crypto = require('crypto');
const pool = require('../db');
const integ = require('./integrations');

// Marina documents into the org's own Google Drive (drive.file scope: OTA
// only ever sees what it created). Folder ids are cached in
// org_integration.settings.folders, keyed by the joined path
// ('OTA', 'OTA/Seaview', ...), resolved under a per-org advisory lock so
// concurrent uploads never create the same folder twice. OTA never deletes
// or edits in the Drive.

const PROVIDER = 'google_drive';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,trashed';
const FOLDER = 'application/vnd.google-apps.folder';

// eslint-disable-next-line no-control-regex
const folderName = (s) => String(s ?? '').replace(/[/\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Untitled';

class NotFound extends Error {}

async function call(token, url, opts = {}) {
  let r;
  try {
    r = await integ.fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...opts.headers } });
  } catch (err) {
    // Timeouts and network errors: Google is unreachable, not our bug.
    throw new integ.IntegrationError(502, 'Google Drive upload failed', { details: err.name === 'TimeoutError' ? 'Google Drive timed out' : err.message });
  }
  const body = await r.json().catch(() => ({}));
  if (r.status === 404) throw new NotFound();
  if (!r.ok) throw new integ.IntegrationError(502, 'Google Drive upload failed', { details: body?.error?.message || `HTTP ${r.status}` });
  return body;
}

async function ensureFolders(token, folders, names) {
  let parent;
  for (let i = 0; i < names.length; i++) {
    const key = names.slice(0, i + 1).join('/');
    if (!folders[key]) {
      const meta = { name: names[i], mimeType: FOLDER, ...(parent && { parents: [parent] }) };
      folders[key] = (await call(token, `${API}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) })).id;
    }
    parent = folders[key];
  }
  return parent;
}

// The target folder id: under the org's lock, re-read the cache, optionally
// forget folders that are gone/trashed, create what's missing, save.
async function resolveFolder(orgId, token, names, { forget = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`drive-folders:${orgId}`]);
    const { rows: [row] } = await client.query('SELECT settings FROM org_integration WHERE clerk_org_id = $1 AND provider = $2', [orgId, PROVIDER]);
    const settings = row?.settings ?? {};
    const folders = { ...settings.folders };
    if (forget) await forgetMissing(token, folders, names);
    const folderId = await ensureFolders(token, folders, names);
    await client.query('UPDATE org_integration SET settings = $1 WHERE clerk_org_id = $2 AND provider = $3', [{ ...settings, folders }, orgId, PROVIDER]);
    await client.query('COMMIT');
    return folderId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Top-down: the first cached folder that is gone or trashed is dropped
// along with everything cached under it.
async function forgetMissing(token, folders, names) {
  for (let i = 0; i < names.length; i++) {
    const key = names.slice(0, i + 1).join('/');
    if (!folders[key]) return;
    let gone = false;
    try { gone = (await call(token, `${API}/${encodeURIComponent(folders[key])}?fields=id,trashed`)).trashed === true; }
    catch (err) { if (err instanceof NotFound) gone = true; else throw err; }
    if (gone) {
      for (const k of Object.keys(folders)) if (k === key || k.startsWith(`${key}/`)) delete folders[k];
      return;
    }
  }
}

function multipart(meta, contentType, buf) {
  const boundary = `ota-${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function uploadMarinaDocument(orgId, { path, fileName, contentType, buf }) {
  const token = await integ.getAccessToken(orgId, PROVIDER);
  const names = path.map(folderName);

  const attempt = async (forget) => {
    const folderId = await resolveFolder(orgId, token, names, { forget });
    const mp = multipart({ name: fileName, parents: [folderId] }, contentType, buf);
    const file = await call(token, UPLOAD, { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body });
    // Drive accepts files into a trashed folder (they'd be purged in 30 days).
    if (file.trashed) throw new NotFound();
    return file;
  };

  let file;
  try {
    file = await attempt(false);
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    // A cached folder was deleted or trashed in Drive: forget it, rebuild, retry once.
    try { file = await attempt(true); }
    catch (e) { if (e instanceof NotFound) throw new integ.IntegrationError(502, 'Google Drive upload failed', { details: 'Folder not found or in the trash' }); throw e; }
  }
  return { id: file.id, webViewLink: file.webViewLink };
}

module.exports = { uploadMarinaDocument, folderName };
