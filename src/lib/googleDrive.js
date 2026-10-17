const crypto = require('crypto');
const integ = require('./integrations');

// Marina documents into the org's own Google Drive (drive.file scope: OTA
// only ever sees what it created). Folder ids are cached in
// org_integration.settings.folders, keyed by the joined path
// ('OTA', 'OTA/Seaview', ...). OTA never deletes or edits in the Drive.

const PROVIDER = 'google_drive';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
const FOLDER = 'application/vnd.google-apps.folder';

// eslint-disable-next-line no-control-regex
const folderName = (s) => String(s ?? '').replace(/[/\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Untitled';

class NotFound extends Error {}

async function call(token, url, opts = {}) {
  const r = await integ.fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...opts.headers } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 404) throw new NotFound();
  if (!r.ok) throw new integ.IntegrationError(502, 'Google Drive upload failed', { details: body?.error?.message || `HTTP ${r.status}` });
  return body;
}

async function ensureFolders(token, folders, names) {
  let parent;
  let changed = false;
  for (let i = 0; i < names.length; i++) {
    const key = names.slice(0, i + 1).join('/');
    if (!folders[key]) {
      const meta = { name: names[i], mimeType: FOLDER, ...(parent && { parents: [parent] }) };
      folders[key] = (await call(token, `${API}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) })).id;
      changed = true;
    }
    parent = folders[key];
  }
  return { folderId: parent, changed };
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
  const settings = (await integ.getIntegration(orgId, PROVIDER))?.settings ?? {};
  const folders = { ...settings.folders };
  const names = path.map(folderName);
  const save = () => integ.setSettings(orgId, PROVIDER, { ...settings, folders });

  const attempt = async () => {
    const { folderId, changed } = await ensureFolders(token, folders, names);
    if (changed) await save();
    const mp = multipart({ name: fileName, parents: [folderId] }, contentType, buf);
    return call(token, UPLOAD, { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body });
  };

  let file;
  try {
    file = await attempt();
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    // A cached folder was deleted in Drive: forget it, rebuild, retry once.
    await forgetMissing(token, folders, names);
    await save();
    try { file = await attempt(); }
    catch (e) { if (e instanceof NotFound) throw new integ.IntegrationError(502, 'Google Drive upload failed', { details: 'Folder not found' }); throw e; }
  }
  return { id: file.id, webViewLink: file.webViewLink };
}

module.exports = { uploadMarinaDocument, folderName };
