// Sailor documents against the local DB: requirement status and staff
// visibility (DB level), then the sailor auth middleware. Fixtures live in
// one transaction that is rolled back. Never point this at the live DB.
//   node -r dotenv/config scripts/check-sailor-documents.js
require('../src/db'); // DATE as 'YYYY-MM-DD' strings
const assert = require('node:assert/strict');
const { Client } = require('pg');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
    await db.query('ROLLBACK TO SAVEPOINT c');
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const sd = require('../src/lib/sailorDocuments');
    const P = (await one(`INSERT INTO property (name, timezone, currency) VALUES ('Sailor Docs Check', 'Europe/Rome', 'EUR') RETURNING id`)).id;
    const marina = async (slug) => one('INSERT INTO marina (property_id, name, slug) VALUES ($1, $2, $2) RETURNING *', [P, slug]);
    const M = await marina('sd-check-a');
    const X = await marina('sd-check-x');
    const Y = await marina('sd-check-y');
    const ins = await one(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name, mandatory, sort_order) VALUES ($1, $2, 'insurance', 'Insurance', true, 0) RETURNING id`, [P, M.id]);
    await one(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name, mandatory, sort_order) VALUES ($1, $2, 'registration', 'Registration', false, 1) RETURNING id`, [P, M.id]);
    const EMAIL = 'ann@example.com';
    const doc = async (type, expiry, extra = {}) => {
      const d = await one('INSERT INTO sailor_document (email, type, expiry_date, created_at, deleted_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [extra.email ?? EMAIL, type, expiry, extra.created_at ?? new Date(), extra.deleted_at ?? null]);
      const v = await one(`INSERT INTO sailor_document_version (document_id, blob_pathname, content_type, size_bytes) VALUES ($1, 'p', 'application/pdf', 1) RETURNING *`, [d.id]);
      return { ...d, version: v };
    };
    const status = (o = {}) => sd.requirementStatus(db, { marinaId: M.id, email: EMAIL, arrival: '2027-06-01', departure: '2027-06-05', ...o });
    const byType = (rows) => Object.fromEntries(rows.map((r) => [r.requirement.type, r.document]));

    await check('unmet when no document', async () => {
      const rows = await status();
      assert.deepEqual(rows.map((r) => [r.requirement.type, r.document]), [['insurance', null], ['registration', null]]);
      assert.deepEqual(sd.missingMandatory(rows).map((r) => r.type), ['insurance']);
    });
    await check('insurance with null expiry is unmet; registration with null expiry is met', async () => {
      await doc('insurance', null);
      const r = await doc('registration', null);
      const s = byType(await status());
      assert.equal(s.insurance, null);
      assert.equal(s.registration.id, r.id);
    });
    await check('expiry before departure is unmet; on departure is met', async () => {
      await doc('insurance', '2027-06-04');
      assert.equal(byType(await status()).insurance, null);
      const d = await doc('insurance', '2027-06-05');
      assert.equal(byType(await status()).insurance.id, d.id);
    });
    await check('open-ended stay checks expiry against arrival', async () => {
      const d = await doc('insurance', '2027-06-01');
      assert.equal(byType(await status({ departure: null })).insurance.id, d.id);
      assert.equal(byType(await status({ arrival: '2027-06-02', departure: null })).insurance, null);
    });
    await check('deleted document is unmet', async () => {
      await doc('insurance', '2028-01-01', { deleted_at: new Date() });
      assert.equal(byType(await status()).insurance, null);
    });
    await check('newest of two current documents wins', async () => {
      await doc('insurance', '2028-01-01', { created_at: new Date(Date.now() - 86400000) });
      const newer = await doc('insurance', '2027-12-01');
      const s = byType(await status());
      assert.equal(s.insurance.id, newer.id);
      assert.deepEqual(s.insurance.versions.map((v) => v.id), [newer.version.id]);
    });
    await check('approval_count counts other marinas only, approved only', async () => {
      const d = await doc('insurance', '2028-01-01');
      const approve = (m, st) => db.query('INSERT INTO sailor_document_approval (version_id, marina_id, property_id, status) VALUES ($1, $2, $3, $4)', [d.version.id, m.id, P, st]);
      await approve(X, 'approved'); await approve(Y, 'rejected'); await approve(M, 'approved');
      assert.equal(byType(await status()).insurance.approval_count, 1);
    });
    await check('email matching ignores case', async () => {
      const d = await doc('insurance', '2028-01-01', { email: 'ann@example.com' });
      assert.equal(byType(await status({ email: 'Ann@Example.COM' })).insurance.id, d.id);
    });
    await check('canStaffSee true only for a verified booking at one of the marinas', async () => {
      const berth = await one(`INSERT INTO marina_berth (property_id, marina_id, label) VALUES ($1, $2, 'B1') RETURNING id`, [P, M.id]);
      const book = (email, verified) => db.query(
        `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, contact_email, arrival, departure, status, source, email_verified)
         VALUES ($1, $2, $3, 'A', $4, '2027-01-01', '2027-01-03', 'cancelled', 'guest', $5)`, [P, M.id, berth.id, email, verified]);
      await book('ann@example.com', false);
      assert.equal(await sd.canStaffSee(db, { marinaIds: [M.id], email: EMAIL }), false);
      await book('ANN@example.com', true);
      assert.equal(await sd.canStaffSee(db, { marinaIds: [X.id], email: EMAIL }), false);
      assert.equal(await sd.canStaffSee(db, { marinaIds: [X.id, M.id], email: EMAIL }), true);
      assert.equal(await sd.canStaffSee(db, { marinaIds: [M.id], email: 'bob@example.com' }), false);
    });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
