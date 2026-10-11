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

    // ---- Task 2: priceStay ----
    const { priceStay } = require('../src/lib/marinaPricing');
    const tier = (o) => ({ id: o.id ?? 't', valid_from: '2027-06-01', valid_to: '2027-06-30', max_length_m: '12.00', max_beam_m: null, price_per_night: '50.00', ...o });
    await check('per-metre berth price, no tiers', async () => {
      const r = priceStay({ berth: berthA, tiers: [], arrival: '2027-06-01', departure: '2027-06-04', boatLengthM: 10.5, boatBeamM: null });
      assert.deepEqual(r, { nights: 3, total_price: '157.50', tier_id: null }); // 5 × 10.5 × 3
    });
    await check('fixed berth price', async () => {
      const r = priceStay({ berth: berthB, tiers: [], arrival: '2027-06-01', departure: '2027-06-03', boatLengthM: 9, boatBeamM: null });
      assert.equal(r.total_price, '160.00');
    });
    await check('smallest fitting tier wins', async () => {
      const tiers = [tier({ id: 'big', max_length_m: '20.00', price_per_night: '90.00' }), tier({ id: 'small', max_length_m: '12.00' })];
      const r = priceStay({ berth: berthA, tiers, arrival: '2027-06-10', departure: '2027-06-12', boatLengthM: 11, boatBeamM: null });
      assert.deepEqual(r, { nights: 2, total_price: '100.00', tier_id: 'small' });
    });
    await check('tier matches on boat length, not berth length', async () => {
      const r = priceStay({ berth: berthA, tiers: [tier({ max_length_m: '8.00' })], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 7.5, boatBeamM: null });
      assert.equal(r.tier_id, 't'); // berth is 12 m, boat 7.5 m
    });
    await check('stay ending the day after valid_to is covered; one more night is not', async () => {
      const t = [tier({})];
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-28', departure: '2027-07-01', boatLengthM: 10, boatBeamM: null }).tier_id, 't');
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-28', departure: '2027-07-02', boatLengthM: 10, boatBeamM: null }).tier_id, null);
    });
    await check('beam limit applies only when both are set', async () => {
      const t = [tier({ max_beam_m: '3.50' })];
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10, boatBeamM: 4 }).tier_id, null);
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10, boatBeamM: null }).tier_id, 't');
    });
    await check('no price anywhere → null total (request-only)', async () => {
      const r = priceStay({ berth: { ...berthA, price_per_night: null }, tiers: [], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10, boatBeamM: null });
      assert.equal(r.total_price, null);
    });
    await check('open-ended → null total', async () => {
      assert.equal(priceStay({ berth: berthA, tiers: [], arrival: '2027-06-10', departure: null, boatLengthM: 10, boatBeamM: null }).total_price, null);
    });
    await check('2-dp rounding of per-metre', async () => {
      const r = priceStay({ berth: { ...berthA, price_per_night: '3.33' }, tiers: [], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10.15, boatBeamM: null });
      assert.equal(r.total_price, '33.80'); // 3.33 × 10.15 = 33.7995
    });
    await check('no boat length falls back to berth length (staff)', async () => {
      const r = priceStay({ berth: berthA, tiers: [], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: null, boatBeamM: null });
      assert.equal(r.total_price, '60.00'); // 5 × 12
    });

    // (later tasks append their checks here)
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
