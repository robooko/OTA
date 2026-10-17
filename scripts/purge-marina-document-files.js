// One-off: remove every LEGACY marina per-booking document from OTA -- the
// files in the private Vercel Blob store (marina-docs/ and
// marina-docs-archive/) and their marina_document rows. Drive-backed rows
// (drive_file_id set) are never counted or deleted, so a re-run is safe.
// Marina documents now live only in each org's Google Drive
// (docs/superpowers/specs/2026-10-17-per-org-storage-google-drive-design.md).
// Shared sailor documents (sailor-docs/) are never touched.
//
//   node -r dotenv/config scripts/purge-marina-document-files.js            # dry run: counts only
//   node -r dotenv/config scripts/purge-marina-document-files.js --commit   # delete
const pool = require('../src/db');
const docs = require('../src/lib/marinaDocuments');

const COMMIT = process.argv.includes('--commit');
const ARCHIVE = 'marina-docs-archive/';

async function archivePaths() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const { list } = require('@vercel/blob');
  const paths = [];
  let cursor;
  do {
    const page = await list({ prefix: ARCHIVE, cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
    paths.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return paths;
}

async function counts() {
  const { rows: [r] } = await pool.query(
    'SELECT count(*)::int AS rows, count(*) FILTER (WHERE blob_pathname IS NOT NULL AND file_deleted_at IS NULL)::int AS row_files FROM marina_document WHERE drive_file_id IS NULL');
  const archive = await archivePaths();
  return { rows: r.rows, row_files: r.row_files, archive_objects: archive ? archive.length : 'unknown (BLOB_READ_WRITE_TOKEN not set)' };
}

(async () => {
  const host = (process.env.DATABASE_URL || '').replace(/^.*@/, '').replace(/\/.*$/, '');
  console.log(`Database: ${host}`);
  console.log('Before:', await counts());
  if (!COMMIT) { console.log('Dry run. Re-run with --commit to delete.'); return; }
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('--commit needs BLOB_READ_WRITE_TOKEN (the files must go with the rows)');

  const { rows } = await pool.query('SELECT blob_pathname FROM marina_document WHERE drive_file_id IS NULL AND blob_pathname IS NOT NULL AND file_deleted_at IS NULL');
  const paths = [...rows.map((r) => r.blob_pathname), ...(await archivePaths())];
  const stray = paths.filter((p) => !p.startsWith('marina-docs'));
  if (stray.length) throw new Error(`Refusing: non-marina paths in the delete list: ${stray.slice(0, 5).join(', ')}`);
  for (let i = 0; i < paths.length; i += 500) await docs.store.del(paths.slice(i, i + 500));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM marina_document WHERE drive_file_id IS NULL');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  console.log('After:', await counts());
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
