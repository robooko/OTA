// Checks the marina module against the local DB. Every fixture lives inside
// one transaction that is rolled back, so nothing persists. Never point
// this at the live DB.
//   node -r dotenv/config scripts/check-marina.js
delete process.env.RESEND_API_KEY;
process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret';
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
    // Every check starts from the same fixtures: nothing one check inserts
    // is seen by the next.
    await db.query('ROLLBACK TO SAVEPOINT c');
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  // An expected error aborts the transaction; its own savepoint keeps the
  // rest of the check usable.
  const rejects = async (fn, code) => {
    await db.query('SAVEPOINT r');
    await assert.rejects(fn(), (e) => e.code === code);
    await db.query('ROLLBACK TO SAVEPOINT r');
  };

  try {
    const P = (await one(`INSERT INTO property (name, timezone, currency) VALUES ('Marina Check', 'Europe/Rome', 'EUR') RETURNING id`)).id;
    const marina = await one(`INSERT INTO marina (property_id, name, slug) VALUES ($1, 'Porto Check', 'porto-check') RETURNING *`, [P]);
    const berth = (label, extra = {}) => one(
      `INSERT INTO marina_berth (property_id, marina_id, label, length_m, beam_m, price_per_night, price_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [P, marina.id, label, extra.length_m ?? 12, extra.beam_m ?? 4, extra.price_per_night ?? 5, extra.price_mode ?? 'per_metre']);
    const berthA = await berth('A1');
    const berthB = await berth('A2', { price_mode: 'fixed', price_per_night: 80 });
    const booking = (berthId, arrival, departure, status = 'confirmed', source = 'staff') => one(
      `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, arrival, departure, status, source)
       VALUES ($1, $2, $3, 'Check', $4, $5, $6, $7) RETURNING *`,
      [P, marina.id, berthId, arrival, departure, status, source]);

    // ---- Task 1: overlap constraint ----
    await check('adjacent stays are allowed', async () => {
      await booking(berthA.id, '2027-06-01', '2027-06-05');
      await booking(berthA.id, '2027-06-05', '2027-06-08');
    });
    await check('overlapping stays are rejected', async () => {
      await booking(berthA.id, '2027-06-01', '2027-06-05');
      await rejects(() => booking(berthA.id, '2027-06-04', '2027-06-06'), '23P01');
    });
    await check('open-ended blocks every later date', async () => {
      await booking(berthA.id, '2027-07-01', null);
      await rejects(() => booking(berthA.id, '2028-01-01', '2028-01-03'), '23P01');
    });
    await check('cancelled and declined rows do not block', async () => {
      await booking(berthA.id, '2027-08-01', '2027-08-05', 'cancelled');
      await booking(berthA.id, '2027-08-01', '2027-08-05', 'declined');
      await booking(berthA.id, '2027-08-01', '2027-08-05', 'hold', 'guest');
    });
    await check('departure must be after arrival', async () => {
      await rejects(() => booking(berthA.id, '2027-09-05', '2027-09-05'), '23514');
    });

    // (later tasks append their checks here)
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
