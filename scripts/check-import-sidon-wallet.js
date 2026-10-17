// Checks scripts/import-sidon-wallet.js against the local OTA DB with fake
// Sidon rows, a fake Clerk lookup, fake file fetches and an in-memory store.
// Fixtures use run-unique emails and are deleted at the end. Local DB only.
//   node -r dotenv/config scripts/check-import-sidon-wallet.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { importWallet } = require('./import-sidon-wallet');

(async () => {
  const RUN = crypto.randomBytes(4).toString('hex');
  const ANN = `ann-${RUN}@wallet.test`;
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const PDF = Buffer.from('%PDF-1.4 wallet');
  const store = new Map();
  const deps = (o = {}) => ({
    db: pool,
    store: { put: async (p, buf) => { store.set(p, buf); } },
    // Clerk user id -> primary verified email (null: none verified).
    primaryEmail: async (sub) => ({ [`u_ann_${RUN}`]: ANN.toUpperCase(), [`u_unv_${RUN}`]: null })[sub] ?? null,
    fetchFile: async (url) => (url.endsWith('.txt') ? Buffer.from('nope') : PDF),
    commit: true,
    ...o,
  });
  const row = (id, o = {}) => ({ id, sailor_id: `u_ann_${RUN}`, guest_email: null, type: 'insurance', file_url: `https://blob.test/${id}.pdf`,
    file_name: 'policy.pdf', extracted_data: JSON.stringify({ policy_number: 'P1' }), expiry_date: new Date('2028-03-01T00:00:00Z'), ...o });
  const base = 900000 + Math.floor(Math.random() * 90000);
  const rows = [
    row(base + 1),
    row(base + 2, { sailor_id: null, guest_email: 'g@x.test' }),
    row(base + 3, { sailor_id: `u_unv_${RUN}` }),
    row(base + 4, { type: 'licence' }),
    row(base + 5, { file_url: `https://blob.test/${base + 5}.txt` }),
    row(base + 6, { type: 'passport', expiry_date: null, extracted_data: null }),
  ];

  try {
    await check('dry run writes nothing', async () => {
      const r = await importWallet(rows, deps({ commit: false }));
      assert.equal(r.counts.imported, 2);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM sailor_document WHERE email = $1', [ANN])).rows[0].n, 0);
      assert.equal(store.size, 0);
    });
    await check("imports a verified user's document with one version", async () => {
      const r = await importWallet(rows, deps());
      assert.equal(r.counts.imported, 2);
      const { rows: docs } = await pool.query(
        `SELECT d.id, d.type, d.expiry_date, d.extracted_data, d.source_ref, count(v.id)::int AS versions
         FROM sailor_document d JOIN sailor_document_version v ON v.document_id = d.id WHERE d.email = $1 GROUP BY d.id ORDER BY d.type`, [ANN]);
      assert.deepEqual(docs.map((d) => [d.type, d.expiry_date, d.versions, d.source_ref]),
        [['insurance', '2028-03-01', 1, `sidon:${base + 1}`], ['passport', null, 1, `sidon:${base + 6}`]]);
      assert.deepEqual(docs[0].extracted_data, { policy_number: 'P1' });
      assert.equal(r.map[base + 1], docs[0].id);
      assert.equal(r.counts.expiry_imported, 1);
      assert.equal(store.size, 2);
    });
    await check('skips guest rows, unverified emails, bad types, bad files', async () => {
      const r = await importWallet(rows, deps());
      assert.equal(r.counts.guest_skipped, 1); assert.equal(r.counts.unverified, 1);
      assert.equal(r.counts.bad_type, 1); assert.equal(r.counts.bad_file, 1);
    });
    await check('second run imports nothing new', async () => {
      const r = await importWallet(rows, deps());
      assert.equal(r.counts.imported, 0); assert.equal(r.counts.already, 2);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM sailor_document WHERE email = $1', [ANN])).rows[0].n, 2);
    });
  } finally {
    await pool.query('DELETE FROM sailor_document WHERE email = $1', [ANN]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
