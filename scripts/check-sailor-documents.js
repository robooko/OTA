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

  // ---- Task 2: sailor auth (no DB; Clerk stubbed through the _clerk seam) ----
  const plain = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const sa = require('../src/middleware/sailorAuth');
  process.env.SAILOR_CLERK_SECRET_KEYS = 'sk_one, sk_two';
  const users = {
    u_ok: { primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: 'Ann@Example.com', verification: { status: 'verified' } }] },
    u_unverified: { primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: 'bob@example.com', verification: { status: 'unverified' } }] },
    u_secondary: { primaryEmailAddressId: 'e1', emailAddresses: [
      { id: 'e1', emailAddress: 'cat@example.com', verification: { status: 'unverified' } },
      { id: 'e2', emailAddress: 'cat2@example.com', verification: { status: 'verified' } }] },
  };
  // Tokens look like '<secret>:<sub>': only verify under the matching secret.
  sa._clerk = {
    verifyToken: async (token, secretKey) => { const [k, sub] = token.split(':'); if (k !== secretKey) throw new Error('bad'); return { sub }; },
    getUser: async (secretKey, sub) => users[sub],
  };
  const run = async (mw, token) => {
    const req = { headers: token ? { 'x-sailor-token': token } : {}, get(h) { return this.headers[h.toLowerCase()]; } };
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    return { req, res, nexted };
  };
  await plain('no header → 401', async () => {
    const r = await run(sa.authenticateSailor, null);
    assert.equal(r.res.statusCode, 401); assert.equal(r.nexted, false);
    assert.deepEqual(r.res.body, { error: 'Sign in required' });
  });
  await plain('verified primary → req.sailor.email lower-cased (second trusted instance)', async () => {
    const r = await run(sa.authenticateSailor, 'sk_two:u_ok');
    assert.equal(r.nexted, true); assert.deepEqual(r.req.sailor, { email: 'ann@example.com' });
  });
  await plain('unverified primary email → 401', async () => {
    assert.equal((await run(sa.authenticateSailor, 'sk_one:u_unverified')).res.statusCode, 401);
  });
  await plain('secondary verified but primary unverified → 401', async () => {
    assert.equal((await run(sa.authenticateSailor, 'sk_one:u_secondary')).res.statusCode, 401);
  });
  await plain('token verifying under an earlier key (shared JWKS cache) still resolves on its own instance', async () => {
    // @clerk/backend caches JWKS by kid across secret keys, so a second
    // instance's token can verify under the first key; that instance then
    // has no such user (404) and the lookup must move on.
    const saved = sa._clerk;
    sa._clerk = {
      verifyToken: async () => ({ sub: 'u_ok' }),
      getUser: async (secretKey, sub) => {
        if (secretKey === 'sk_one') throw Object.assign(new Error('Not Found'), { status: 404 });
        return users[sub];
      },
    };
    try {
      const r = await run(sa.authenticateSailor, 'any');
      assert.equal(r.nexted, true); assert.deepEqual(r.req.sailor, { email: 'ann@example.com' });
    } finally { sa._clerk = saved; }
  });
  await plain('token from an untrusted instance → 401', async () => {
    assert.equal((await run(sa.authenticateSailor, 'sk_other:u_ok')).res.statusCode, 401);
  });
  await plain('optionalSailor carries on signed out with no header or an invalid token', async () => {
    const r = await run(sa.optionalSailor, null);
    assert.equal(r.nexted, true); assert.equal(r.req.sailor, undefined);
    const bad = await run(sa.optionalSailor, 'sk_one:u_unverified');
    assert.equal(bad.nexted, true); assert.equal(bad.req.sailor, undefined);
    const ok = await run(sa.optionalSailor, 'sk_one:u_ok');
    assert.deepEqual(ok.req.sailor, { email: 'ann@example.com' });
  });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
