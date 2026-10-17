// Moves sidon-ai's document wallet (public Vercel Blob + its sailor_document
// table) into OTA's shared sailor documents (private store). Dry run unless
// --commit. Re-runnable: rows already imported (source_ref) are skipped.
//   node scripts/import-sidon-wallet.js [--commit]
// Env: SIDON_POSTGRES_URL, SIDON_CLERK_SECRET_KEY (+ OTA's DATABASE_URL,
// BLOB_READ_WRITE_TOKEN). Writes sidon-wallet-import.json (sidon id -> OTA
// document id) so sidon-ai deletes the public blobs of imported rows only.
// Output carries counts only: never an email.
require('dotenv').config();
require('../src/db'); // DATE as 'YYYY-MM-DD' strings
const fs = require('fs');
const docs = require('../src/lib/marinaDocuments');
const { TYPE_NAMES } = require('../src/lib/sailorDocTypes');
const { normalEmail } = require('../src/lib/sailorDocuments');

const dateOnly = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// rows: sidon-ai sailor_document rows. deps: { db, store, primaryEmail(sub)
// -> verified primary email | null, fetchFile(url) -> Buffer, commit }.
async function importWallet(rows, { db, store, primaryEmail, fetchFile, commit }) {
  const counts = { imported: 0, already: 0, guest_skipped: 0, unverified: 0, bad_type: 0, bad_file: 0, expiry_imported: 0 };
  const map = {};
  for (const r of rows) {
    const ref = `sidon:${r.id}`;
    // No Clerk user: the email can't be proven (sidon-ai deletes these).
    if (!r.sailor_id) { counts.guest_skipped++; continue; }
    if (!TYPE_NAMES.includes(r.type)) { counts.bad_type++; continue; }
    const { rows: [done] } = await db.query('SELECT id FROM sailor_document WHERE source_ref = $1', [ref]);
    if (done) { counts.already++; map[r.id] = done.id; continue; }
    const email = await primaryEmail(r.sailor_id);
    if (!email) { counts.unverified++; continue; }
    let buf;
    try { buf = await fetchFile(r.file_url); } catch { buf = null; }
    const contentType = buf && docs.sniffType(buf);
    if (!contentType) { counts.bad_file++; continue; }
    counts.imported++;
    // sidon-ai's expiry was read off the document by extraction; imported
    // as-is (the sailor can correct it) and counted so it's visible.
    const expiry = dateOnly(r.expiry_date);
    if (expiry) counts.expiry_imported++;
    if (!commit) continue;
    const pathname = docs.sailorDocPath(normalEmail(email), contentType);
    await store.put(pathname, buf, contentType);
    const extracted = parseJson(r.extracted_data);
    const { rows: [d] } = await db.query(
      'INSERT INTO sailor_document (email, type, extracted_data, expiry_date, source_ref) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [normalEmail(email), r.type, extracted, expiry, ref]);
    await db.query(
      `INSERT INTO sailor_document_version (document_id, blob_pathname, file_name, content_type, size_bytes, extracted_data)
       VALUES ($1, $2, $3, $4, $5, $6)`, [d.id, pathname, r.file_name ?? null, contentType, buf.length, extracted]);
    map[r.id] = d.id;
  }
  return { counts, map };
}

module.exports = { importWallet };

if (require.main === module) {
  (async () => {
    const commit = process.argv.includes('--commit');
    for (const k of ['SIDON_POSTGRES_URL', 'SIDON_CLERK_SECRET_KEY']) if (!process.env[k]) throw new Error(`${k} is required`);
    const { Client } = require('pg');
    const { createClerkClient } = require('@clerk/backend');
    const { verifiedPrimaryEmail } = require('../src/middleware/sailorAuth');
    const pool = require('../src/db');
    const sidon = new Client({ connectionString: process.env.SIDON_POSTGRES_URL });
    await sidon.connect();
    const clerk = createClerkClient({ secretKey: process.env.SIDON_CLERK_SECRET_KEY });
    try {
      const { rows } = await sidon.query('SELECT id, sailor_id, guest_email, type, file_url, file_name, extracted_data, expiry_date FROM sailor_document ORDER BY id');
      const { counts, map } = await importWallet(rows, {
        db: pool,
        store: docs.store,
        primaryEmail: async (sub) => { try { return verifiedPrimaryEmail(await clerk.users.getUser(sub)); } catch { return null; } },
        fetchFile: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(String(r.status)); return Buffer.from(await r.arrayBuffer()); },
        commit,
      });
      console.log(commit ? 'Committed.' : 'Dry run (pass --commit to write).', counts);
      if (commit) fs.writeFileSync('sidon-wallet-import.json', JSON.stringify(map, null, 2));
    } finally {
      await sidon.end();
      await pool.end();
    }
  })().catch((err) => { console.error(err.message); process.exit(1); });
}
