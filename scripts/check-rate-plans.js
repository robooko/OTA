// Room rate plans (Saver/Flex) checks. Pure helpers are asserted directly;
// HTTP checks run the real app on an ephemeral port with fixtures under
// throwaway properties, deleted at the end (pass or fail). Stripe is the
// in-memory fake. Local DB only, with
// migrate-2026-10-30-room-rate-plans.sql applied.
//   node -r dotenv/config scripts/check-rate-plans.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const {
  applyAdjustment, cancelDeadline, effectiveMode, chargeAmountCents, guestCancelDecision, validatePlan,
} = require('../src/lib/ratePlans');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Task 1: pure rules ----
  await check('applyAdjustment rounds per night', async () => {
    assert.equal(applyAdjustment('100.00', -12), 88);
    assert.equal(applyAdjustment(133.33, -12.5), 116.66);
    assert.equal(applyAdjustment(99.99, -10), 89.99);
    assert.equal(applyAdjustment(150, 0), 150);
  });
  await check('cancelDeadline: midnight local minus cutoff', async () => {
    assert.equal(cancelDeadline('2030-07-10', 'Europe/London', 48).toISOString(), '2030-07-07T23:00:00.000Z'); // BST
    assert.equal(cancelDeadline('2030-01-10', 'Europe/London', 24).toISOString(), '2030-01-09T00:00:00.000Z');
    assert.equal(cancelDeadline('2030-07-10', 'America/Tortola', 48).toISOString(), '2030-07-08T04:00:00.000Z');
    assert.equal(cancelDeadline('2030-07-10', 'Europe/London', null), null);
  });
  await check('effectiveMode: hold only within 6 days of the deadline', async () => {
    const hold = { payment_mode: 'hold' }; const now = new Date('2030-07-01T12:00:00Z');
    assert.equal(effectiveMode(hold, new Date('2030-07-05T00:00:00Z'), now), 'hold');
    assert.equal(effectiveMode(hold, new Date('2030-07-08T00:00:00Z'), now), 'full'); // > 6 days
    assert.equal(effectiveMode(hold, new Date('2030-06-30T00:00:00Z'), now), 'full'); // deadline passed
    assert.equal(effectiveMode({ payment_mode: 'deposit' }, null, now), 'deposit');
  });
  await check('chargeAmountCents by mode', async () => {
    assert.equal(chargeAmountCents('full', {}, 30000, 30000), 30000);
    assert.equal(chargeAmountCents('hold', {}, 30000, 25000), 25000);
    assert.equal(chargeAmountCents('deposit', { deposit_kind: 'percent', deposit_value: 20 }, 30050, 30050), 6010);
    assert.equal(chargeAmountCents('deposit', { deposit_kind: 'fixed', deposit_value: 50 }, 30000, 30000), 5000);
    assert.equal(chargeAmountCents('deposit', { deposit_kind: 'fixed', deposit_value: 500 }, 30000, 30000), 30000); // capped
  });
  await check('guestCancelDecision table', async () => {
    const now = new Date('2030-07-01T00:00:00Z'); const later = new Date('2030-07-05T00:00:00Z'); const earlier = new Date('2030-06-30T00:00:00Z');
    const flex = { refundable: true, cancel_cutoff_hours: 48 }; const saver = { refundable: false };
    assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: null }, null, now), 'as_today');
    assert.equal(guestCancelDecision({ status: 'pending_payment', rate_plan_terms: saver }, null, now), 'release');
    assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: flex }, later, now), 'refund');
    assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: flex }, earlier, now), 'refuse');
    assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: saver }, null, now), 'refuse');
    assert.equal(guestCancelDecision({ status: 'confirmed', rate_plan_terms: { ...flex, pay_at_hotel: true } }, later, now), 'refund');
  });
  await check('validatePlan rules', async () => {
    const ok = { name: 'Flex', adjustment_pct: 0, refundable: true, cancel_cutoff_hours: 48, payment_mode: 'full', status: 'active' };
    assert.equal(validatePlan(ok), null);
    assert.match(validatePlan({ ...ok, payment_mode: 'hold', refundable: false, cancel_cutoff_hours: null }), /hold/);
    assert.match(validatePlan({ ...ok, cancel_cutoff_hours: null }), /cancel_cutoff_hours/);
    assert.match(validatePlan({ ...ok, refundable: false }), /cancel_cutoff_hours/); // must be null when non-refundable
    assert.match(validatePlan({ ...ok, payment_mode: 'deposit' }), /deposit/);
    assert.match(validatePlan({ ...ok, payment_mode: 'deposit', deposit_kind: 'percent', deposit_value: 120 }), /deposit_value/);
    assert.equal(validatePlan({ ...ok, payment_mode: 'deposit', deposit_kind: 'fixed', deposit_value: 50 }), null);
    assert.match(validatePlan({ ...ok, adjustment_pct: -101 }), /adjustment_pct/);
    assert.match(validatePlan({ ...ok, name: '' }), /name/);
    assert.match(validatePlan({ ...ok, status: 'deleted' }), /status/);
  });

  // ---- HTTP checks (Tasks 2+) ----

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
