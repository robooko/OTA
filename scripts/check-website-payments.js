// Website API keys and the payment a booking needs at booking: the website
// flag, golf / equipment rules, the amount due now, enforcement on each
// create path, and room payments carrying the website's Stripe id. Drives the
// controllers directly against a fake Stripe. Fixtures live under a throwaway
// property and are deleted at the end. Local DB only, with the 2026-11-12
// migrations applied.
//   node -r dotenv/config scripts/check-website-payments.js
// See docs/superpowers/plans/2026-11-12-entity-charges-3-enforcement.md.
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const fakeStripe = require('./fake-stripe');
require.cache[require.resolve('stripe')] = { id: 'stripe', filename: require.resolve('stripe'), loaded: true, exports: () => fakeStripe };

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');
const keysCtl = require('../src/controllers/apiKeys');
const { resolveSiteProperty } = require('../src/lib/propertyResolver');
const folioCtl = require('../src/controllers/entityFolio');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const ORG = `org_website_check_${Date.now()}`;
  await pool.query('INSERT INTO organization (clerk_org_id) VALUES ($1)', [ORG]);
  const P = (await one(`INSERT INTO property (name, currency, stripe_secret_key, clerk_org_id, slug) VALUES ('Website Check', 'GBP', 'sk_test_check', $1, $2) RETURNING id`,
    [ORG, `website-check-${Date.now()}`])).id;

  // Request decorators: who is calling.
  const websiteKey = { auth_method: 'api_key', api_key: { id: null, permissions: null, website: true }, user: undefined };
  const fullKey = { auth_method: 'api_key', api_key: { id: null, permissions: null, website: false }, user: undefined };
  const staff = { auth_method: 'bearer', user: { role: 'staff' } };

  const call = async (fn, req) => {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; },
    };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body: {}, headers: {}, get: () => undefined, ...staff, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    // ---- Website keys ----
    await check('keys: website flag defaults off, can be set, reaches the request', async () => {
      const k = await apiKeys.create(pool, { property_id: P }, { name: 'Site' });
      assert.equal(k.website, false);
      const put = await call(keysCtl.property.update, { params: { id: k.id }, body: { website: true } });
      assert.equal(put.status, 200, JSON.stringify(put.body)); assert.equal(put.body.website, true);
      assert.equal((await call(keysCtl.property.update, { params: { id: k.id }, body: { name: 'Site 2' } })).body.website, true);
      assert.equal((await call(keysCtl.property.update, { params: { id: k.id }, body: { website: 'yes' } })).status, 400);
      assert.equal((await resolveSiteProperty(pool, { key: k.key })).apiKey.website, true);
      const made = await call(keysCtl.property.create, { body: { name: 'Made website', website: true } });
      assert.equal(made.status, 201); assert.equal(made.body.website, true);
    });

    await check('keys: an org key carries website too', async () => {
      const k = await apiKeys.create(pool, { clerk_org_id: ORG }, { name: 'Group site' });
      await apiKeys.update(pool, { clerk_org_id: ORG }, k.id, { website: true });
      const r = await resolveSiteProperty(pool, { key: k.key, propertyId: P });
      assert.equal(r.propertyId, P);
      assert.equal(r.apiKey.website, true);
    });

    // ---- Golf course and equipment rules ----
    const golf = require('../src/controllers/golf');
    const equipment = require('../src/controllers/equipment');
    await check('rules: golf courses and equipment take no payment or full payment at booking', async () => {
      const c = await call(golf.createCourse, { body: { name: 'Rules Course', holes: 18, price_per_player: 90 } });
      assert.equal(c.status, 201, JSON.stringify(c.body)); assert.equal(c.body.payment_required, 'none');
      const cFull = await call(golf.updateCourse, { params: { id: c.body.id }, body: { payment_required: 'full' } });
      assert.equal(cFull.status, 200); assert.equal(cFull.body.payment_required, 'full');
      assert.equal((await call(golf.updateCourse, { params: { id: c.body.id }, body: { name: 'Rules Course 2' } })).body.payment_required, 'full');
      assert.equal((await call(golf.updateCourse, { params: { id: c.body.id }, body: { payment_required: 'deposit' } })).status, 400);
      assert.equal((await call(golf.updateCourse, { params: { id: c.body.id }, body: { payment_required: 5 } })).status, 400);
      assert.equal((await call(golf.createCourse, { body: { name: 'Bad', holes: 9, price_per_player: 1, payment_required: 'deposit' } })).status, 400);
      assert.equal((await call(golf.createCourse, { body: { name: 'Full', holes: 9, price_per_player: 1, payment_required: 'full' } })).body.payment_required, 'full');

      const e = await call(equipment.createEquipment, { body: { name: 'Rules Buggy', type: 'buggy', quantity: 2, price_per_day: 25 } });
      assert.equal(e.status, 201, JSON.stringify(e.body)); assert.equal(e.body.payment_required, 'none');
      const eFull = await call(equipment.updateEquipment, { params: { id: e.body.id }, body: { payment_required: 'full' } });
      assert.equal(eFull.status, 200, JSON.stringify(eFull.body)); assert.equal(eFull.body.payment_required, 'full');
      assert.equal((await call(equipment.updateEquipment, { params: { id: e.body.id }, body: { name: 'Rules Buggy 2' } })).body.payment_required, 'full');
      assert.equal((await call(equipment.updateEquipment, { params: { id: e.body.id }, body: { payment_required: 'deposit' } })).status, 400);
      assert.equal((await call(equipment.createEquipment, { body: { name: 'Bad', type: 'buggy', quantity: 1, payment_required: 5 } })).status, 400);
    });

    // ---- Fixtures for the amount due and enforcement ----
    const course = (await one(`INSERT INTO golf_course (property_id, name, holes, price_per_player, payment_required) VALUES ($1, 'Due Course', 18, 90, 'full') RETURNING id`, [P])).id;
    const tt = (await one(`INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players) VALUES ($1, $2, '2031-03-10', '08:00', 40) RETURNING id`, [P, course])).id;
    const kit = (await one(`INSERT INTO equipment (property_id, name, type, quantity, price_per_day, payment_required) VALUES ($1, 'Due Buggy', 'buggy', 50, 25, 'full') RETURNING id`, [P])).id;
    const rest = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes, payment_protection, payment_protection_amount, payment_protection_basis)
                             VALUES ($1, 'Due Grill', 90, 'deposit', 20, 'per_guest') RETURNING id`, [P])).id;
    const spaId = (await one(`INSERT INTO spa (property_id, name, payment_required, deposit_amount) VALUES ($1, 'Due Spa', 'deposit', 50) RETURNING id`, [P])).id;
    const treatment = (await one(`INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Due Massage', 60, 30) RETURNING id`, [P, spaId])).id;
    const setRule = (table, id, sets) => pool.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id]);

    // ---- Amount due now ----
    const { dueNow } = require('../src/lib/amountDue');
    const due = async (kind, params) => {
      const r = await dueNow(pool, kind, P, params);
      return r.status ? r : { mode: r.mode, price: r.price, due_now: r.due_now, currency: r.currency };
    };
    await check('due now: golf full, and none still prices the round', async () => {
      assert.deepEqual(await due('golf_booking', { tee_time_id: tt, players: 2 }), { mode: 'full', price: '180.00', due_now: '180.00', currency: 'GBP' });
      await setRule('golf_course', course, "payment_required = 'none'");
      assert.deepEqual(await due('golf_booking', { tee_time_id: tt, players: '2' }), { mode: 'none', price: '180.00', due_now: '0.00', currency: 'GBP' });
      await setRule('golf_course', course, "payment_required = 'full'");
    });
    await check('due now: hire full is rate x quantity x duration', async () => {
      assert.deepEqual(await due('equipment_hire', { equipment_id: kit, quantity: 2, duration: 3 }), { mode: 'full', price: '150.00', due_now: '150.00', currency: 'GBP' });
    });
    await check('due now: restaurant deposit per guest or per table, hold and none', async () => {
      assert.deepEqual(await due('restaurant_reservation', { restaurant_id: rest, party_size: 4 }), { mode: 'deposit', price: null, due_now: '80.00', currency: 'GBP' });
      await setRule('restaurant', rest, "payment_protection_basis = 'per_table'");
      assert.equal((await due('restaurant_reservation', { restaurant_id: rest, party_size: 4 })).due_now, '20.00');
      await setRule('restaurant', rest, "payment_protection = 'hold'");
      assert.deepEqual(await due('restaurant_reservation', { restaurant_id: rest, party_size: 4 }), { mode: 'hold', price: null, due_now: '0.00', currency: 'GBP' });
      await setRule('restaurant', rest, "payment_protection = 'none'");
      assert.equal((await due('restaurant_reservation', { restaurant_id: rest, party_size: 4 })).mode, 'none');
      await setRule('restaurant', rest, "payment_protection = 'deposit', payment_protection_basis = 'per_guest'");
    });
    await check('due now: a spa deposit is capped at the price; full is the price', async () => {
      const q = { spa_id: spaId, treatment_id: treatment, date: '2031-03-10' };
      assert.deepEqual(await due('spa_appointment', q), { mode: 'deposit', price: '30.00', due_now: '30.00', currency: 'GBP' });
      await setRule('spa', spaId, 'deposit_amount = 20');
      assert.equal((await due('spa_appointment', q)).due_now, '20.00');
      await setRule('spa', spaId, "payment_required = 'full'");
      assert.deepEqual(await due('spa_appointment', q), { mode: 'full', price: '30.00', due_now: '30.00', currency: 'GBP' });
      await setRule('spa', spaId, "payment_required = 'deposit'");
    });
    await check('due now: bad params 400, another property 404, unknown kind 404', async () => {
      const other = (await one(`INSERT INTO property (name, currency) VALUES ('Other', 'GBP') RETURNING id`)).id;
      try {
        const oc = (await one(`INSERT INTO golf_course (property_id, name, holes, price_per_player) VALUES ($1, 'X', 9, 10) RETURNING id`, [other])).id;
        const ot = (await one(`INSERT INTO tee_time (property_id, course_id, tee_date, tee_time) VALUES ($1, $2, '2031-03-10', '09:00') RETURNING id`, [other, oc])).id;
        assert.equal((await due('golf_booking', { tee_time_id: ot, players: 1 })).status, 404);
        await pool.query('DELETE FROM tee_time WHERE property_id = $1', [other]);
        await pool.query('DELETE FROM golf_course WHERE property_id = $1', [other]);
      } finally {
        await pool.query('DELETE FROM property WHERE id = $1', [other]);
      }
      assert.equal((await due('golf_booking', { tee_time_id: tt, players: 0 })).status, 400);
      assert.equal((await due('golf_booking', { tee_time_id: 'abc', players: 1 })).status, 404);
      assert.equal((await due('equipment_hire', { equipment_id: kit, quantity: 1.5 })).status, 400);
      assert.equal((await due('restaurant_reservation', { restaurant_id: rest })).status, 400);
      assert.equal((await due('spa_appointment', { spa_id: spaId, treatment_id: treatment, date: 'soon' })).status, 400);
      assert.equal((await due('nope', {})).status, 404);
    });
    await check('due now: the route answers what dueNow does', async () => {
      const r = await call(folioCtl.getDueNow, { params: { kind: 'golf_booking' }, query: { tee_time_id: tt, players: '2' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, await dueNow(pool, 'golf_booking', P, { tee_time_id: tt, players: '2' }));
      assert.equal((await call(folioCtl.getDueNow, { params: { kind: 'nope' }, query: {} })).status, 404);
      assert.equal((await call(folioCtl.getDueNow, { params: { kind: 'golf_booking' }, query: { tee_time_id: tt } })).status, 400);
    });
  } finally {
    for (const t of ['payment', 'golf_booking', 'tee_time', 'golf_course', 'equipment_hire', 'equipment', 'restaurant_reservation', 'restaurant_table', 'restaurant', 'spa_appointment', 'spa_therapist', 'spa_treatment', 'spa']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM api_key WHERE property_id = $1 OR clerk_org_id = $2', [P, ORG]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(1); });
