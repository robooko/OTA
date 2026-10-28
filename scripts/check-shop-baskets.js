// Checks abandoned shop baskets against the local DB. Every fixture lives
// inside one transaction that is rolled back, so nothing persists. Never
// point this at the live DB.
//   node -r dotenv/config scripts/check-shop-baskets.js
// No key, no client: a stub that fails to apply errors instead of emailing.
delete process.env.RESEND_API_KEY;
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
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const prop = await one(`INSERT INTO property (name, timezone) VALUES ('Basket Check Hotel', 'Europe/London') RETURNING id`);
    const P = prop.id;

    await check('property defaults', async () => {
      const r = await one('SELECT basket_reminder_enabled, basket_reminder_delay_mins FROM property WHERE id = $1', [P]);
      assert.equal(r.basket_reminder_enabled, false);
      assert.equal(r.basket_reminder_delay_mins, 60);
    });

    // New check() blocks for later tasks go above this line.
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
