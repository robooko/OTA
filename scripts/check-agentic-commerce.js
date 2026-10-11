// Checks agentic commerce (Stripe ACS): settings validation, feed building,
// and session -> order recording. DB fixtures live inside one transaction
// that is rolled back, so nothing persists. Never point this at the live DB.
//   node -r dotenv/config scripts/check-agentic-commerce.js
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { mergeAgenticCommerce } = require('../src/controllers/property');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const FULL = { sanity_project_id: 'a26xzsqt', sanity_dataset: 'production', site_url: 'https://willy-t-bvi.vercel.app', brand: 'Willy T' };

    await check('settings: full config can be enabled; site_url trailing slash stripped', async () => {
      const { value, error } = mergeAgenticCommerce(null, { ...FULL, site_url: 'https://willy-t-bvi.vercel.app/', enabled: true });
      assert.equal(error, undefined);
      assert.deepEqual(value, { ...FULL, enabled: true });
    });
    await check('settings: enabling with a field missing is rejected', async () => {
      assert.match(mergeAgenticCommerce(null, { ...FULL, brand: undefined, enabled: true }).error, /brand/);
    });
    await check('settings: omitted fields keep their stored value', async () => {
      const { value } = mergeAgenticCommerce({ ...FULL, enabled: true }, { brand: 'Willy-T' });
      assert.deepEqual(value, { ...FULL, brand: 'Willy-T', enabled: true });
    });
    await check('settings: bad values are rejected', async () => {
      assert.ok(mergeAgenticCommerce(null, { sanity_project_id: 'A26/x' }).error);
      assert.ok(mergeAgenticCommerce(null, { sanity_dataset: 'prod data' }).error);
      assert.ok(mergeAgenticCommerce(null, { site_url: 'javascript:alert(1)' }).error);
      assert.ok(mergeAgenticCommerce(null, { brand: '   ' }).error);
      assert.ok(mergeAgenticCommerce(null, { brand: 'x'.repeat(71) }).error);
      assert.ok(mergeAgenticCommerce(null, { enabled: 'yes' }).error);
    });

    // ── later tasks append checks above this line ──
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
