// Charges on golf bookings, equipment hires and restaurant reservations:
// payment and folio_adjustment owned by any of them, their folios, the
// /api/folios routes, and the restaurant deposit basis. Fixtures live under a
// throwaway property and are deleted at the end. Local DB only, with
// migrate-2026-11-12-entity-folios.sql and
// migrate-2026-11-12-restaurant-protection-basis.sql applied.
//   node -r dotenv/config scripts/check-entity-folios.js
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name, currency) VALUES ('Entity Folio Check', 'GBP') RETURNING id`)).id;
  const call = async (fn, req) => {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; },
    };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body: {}, headers: {}, get: () => undefined, auth_method: 'bearer', user: { role: 'staff' }, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Fixtures ----
  const course = (await one(`INSERT INTO golf_course (property_id, name, holes, price_per_player) VALUES ($1, 'Dent 18', 18, 180) RETURNING id`, [P])).id;
  const tee = (await one(`INSERT INTO tee_time (property_id, course_id, tee_date, tee_time) VALUES ($1, $2, '2030-07-15', '08:00') RETURNING id`, [P, course])).id;
  const kit = (await one(`INSERT INTO equipment (property_id, name, type, quantity, price_per_day) VALUES ($1, 'Buggy', 'buggy', 10, 50) RETURNING id`, [P])).id;

  // price is per player; total_price = price x players, as createBooking does.
  const golfBooking = async ({ players = 1, price = '180.00', status = 'confirmed' } = {}) => (await one(
    `INSERT INTO golf_booking (property_id, tee_time_id, contact_name, players, total_price, status)
     VALUES ($1, $2, 'Gail', $3::int, $4::numeric * $3::int, $5) RETURNING id`,
    [P, tee, players, price, status])).id;
  const hire = async ({ quantity = 1, total = '50.00' } = {}) => (await one(
    `INSERT INTO equipment_hire (property_id, equipment_id, contact_name, hire_date, quantity, total_price)
     VALUES ($1, $2, 'Hal', '2030-07-15', $3, $4) RETURNING id`,
    [P, kit, quantity, total])).id;
  let tableNo = 0;
  const reservation = async ({ partySize = 2, intent = null, currency = null } = {}) => {
    const r = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes, currency) VALUES ($1, 'Grill', 90, $2) RETURNING id`, [P, currency])).id;
    const t = (await one(`INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats) VALUES ($1, $2, $3, 8) RETURNING id`, [P, r, `E${++tableNo}`])).id;
    return (await one(
      `INSERT INTO restaurant_reservation (property_id, table_id, reservation_date, start_time, end_time, contact_name, party_size, stripe_payment_intent_id)
       VALUES ($1, $2, '2030-07-15', '19:00', '20:30', 'Rita', $3, $4) RETURNING id`,
      [P, t, partySize, intent])).id;
  };

  const spaId = (await one(`INSERT INTO spa (property_id, name) VALUES ($1, 'Spa') RETURNING id`, [P])).id;
  const therapist = (await one(`INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Tia') RETURNING id`, [P, spaId])).id;
  const treatment = (await one(`INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Massage', 60, 90) RETURNING id`, [P, spaId])).id;
  // price is the frozen price (the treatment lists 90, so the frozen one must win).
  // paid = marked paid the old way: payment_status only, no payment row.
  let spaHour = 6;
  const spaAppointment = async ({ price = '80.00', paid = false, bookingId = null, status = 'confirmed' } = {}) => {
    const h = spaHour++;
    return (await one(
      `INSERT INTO spa_appointment (property_id, treatment_id, therapist_id, appointment_date, start_time, end_time, contact_name, price, status,
                                    payment_status, paid_at, payment_method, booking_id)
       VALUES ($1, $2, $3, '2030-07-15', make_time($4, 0, 0), make_time($4 + 1, 0, 0), 'Sia', $5, $6,
               CASE WHEN $7 THEN 'paid' ELSE 'unpaid' END, CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN 'cash' END, $8)
       RETURNING id`,
      [P, treatment, therapist, h % 24, price, status, paid, bookingId])).id;
  };
  const roomType = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Suite', 2, 300) RETURNING id`, [P])).id;
  const roomGuest = (await one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Rob', 'Room', 'rob@example.test') RETURNING id`, [P])).id;
  const roomBooking = async () => (await one(
    `INSERT INTO booking (property_id, guest_id, room_type_id, check_in, check_out, total_price) VALUES ($1, $2, $3, '2030-07-14', '2030-07-16', 600) RETURNING id`,
    [P, roomGuest, roomType])).id;

  try {
    // ---- Schema ----
    await check('schema: a payment has exactly one owner', async () => {
      const g = await golfBooking({ players: 2, price: '180.00' });
      const h = await hire({ quantity: 1, total: '50.00' });
      await pool.query(`INSERT INTO payment (property_id, golf_booking_id, amount, status) VALUES ($1, $2, 10, 'completed')`, [P, g]);
      await assert.rejects(pool.query(`INSERT INTO payment (property_id, amount) VALUES ($1, 10)`, [P]), /payment_one_owner/);
      await assert.rejects(pool.query(`INSERT INTO payment (property_id, golf_booking_id, equipment_hire_id, amount) VALUES ($1, $2, $3, 10)`, [P, g, h]), /payment_one_owner/);
    });

    await check('schema: an adjustment has exactly one owner', async () => {
      const g = await golfBooking({ players: 1, price: '180.00' });
      await pool.query(`INSERT INTO folio_adjustment (property_id, golf_booking_id, description, amount) VALUES ($1, $2, 'Glove', 20)`, [P, g]);
      await assert.rejects(pool.query(`INSERT INTO folio_adjustment (property_id, description, amount) VALUES ($1, 'x', 1)`, [P]), /folio_adjustment_one_owner/);
    });

    // ---- Compute ----
    const { computeEntityFolio, ENTITY_KINDS, ownerColumn } = require('../src/lib/entityFolio');

    await check('compute: golf base charge and balance', async () => {
      const g = await golfBooking({ players: 2, price: '180.00' });
      const f = await computeEntityFolio('golf_booking', g, P);
      assert.equal(f.items.length, 1);
      assert.equal(f.items[0].type, 'base');
      assert.match(f.items[0].description, / · 2 players$/);
      assert.equal(f.items[0].amount, '360.00');
      assert.deepEqual([f.charges_total, f.payments_total, f.balance], ['360.00', '0.00', '360.00']);
      assert.equal(f.external_payment, false);
      assert.equal(f.currency, 'GBP');
      assert.deepEqual([f.kind, f.id, f.status], ['golf_booking', g, 'confirmed']);
    });

    await check('compute: golf purchases, adjustments and payments', async () => {
      const g = await golfBooking({ players: 1, price: '180.00' });
      await pool.query(`INSERT INTO golf_booking_item (property_id, booking_id, item_name, quantity, unit_price) VALUES ($1, $2, 'Balls', 2, 15.50)`, [P, g]);
      await pool.query(`INSERT INTO folio_adjustment (property_id, golf_booking_id, description, amount) VALUES ($1, $2, 'Comp', -10)`, [P, g]);
      await pool.query(`INSERT INTO payment (property_id, golf_booking_id, amount, status) VALUES ($1, $2, 100, 'completed'), ($1, $2, 50, 'pending')`, [P, g]);
      const f = await computeEntityFolio('golf_booking', g, P);
      assert.deepEqual(f.items.map((i) => [i.type, i.amount]), [['base', '180.00'], ['item', '31.00'], ['adjustment', '-10.00']]);
      assert.match(f.items[0].description, / · 1 player$/);
      assert.equal(f.items[1].description, 'Balls × 2');
      assert.deepEqual([f.charges_total, f.payments_total, f.balance], ['201.00', '100.00', '101.00']);
      assert.equal(f.payments.length, 2);
    });

    await check('compute: a cancelled booking drops its base charge and shows a credit', async () => {
      const g = await golfBooking({ players: 2, price: '180.00', status: 'cancelled' });
      await pool.query(`INSERT INTO payment (property_id, golf_booking_id, amount, status) VALUES ($1, $2, 100, 'completed')`, [P, g]);
      const f = await computeEntityFolio('golf_booking', g, P);
      assert.equal(f.items.length, 0);
      assert.equal(f.balance, '-100.00');
    });

    await check('compute: hire with no price is a zero base charge', async () => {
      const h = await hire({ quantity: 3, total: null });
      const f = await computeEntityFolio('equipment_hire', h, P);
      assert.equal(f.items[0].amount, '0.00');
      assert.match(f.items[0].description, /^Buggy × 3$/);
      const one = await computeEntityFolio('equipment_hire', await hire({ quantity: 1, total: '50.00' }), P);
      assert.deepEqual([one.items[0].description, one.items[0].amount], ['Buggy', '50.00']);
    });

    await check('compute: a reservation has no base charge, its own currency, and flags a Stripe deposit', async () => {
      const r = await reservation({ partySize: 4, intent: 'pi_check_1', currency: 'EUR' });
      const f = await computeEntityFolio('restaurant_reservation', r, P);
      assert.deepEqual(f.items, []);
      assert.equal(f.currency, 'EUR');
      assert.equal(f.external_payment, true);
      assert.equal(f.balance, '0.00');
      assert.equal((await computeEntityFolio('restaurant_reservation', await reservation({}), P)).currency, 'GBP');
    });

    await check('compute: unknown kind, bad id and another property are all null', async () => {
      const g = await golfBooking({ players: 1, price: '180.00' });
      assert.equal(await computeEntityFolio('booking', g, P), null);
      assert.equal(await computeEntityFolio('golf_booking', 'abc', P), null);
      assert.equal(await computeEntityFolio('golf_booking', g, '00000000-0000-0000-0000-000000000000'), null);
      assert.equal(ownerColumn('golf_booking'), 'golf_booking_id');
      assert.equal(ownerColumn('booking'), null);
      assert.deepEqual(ENTITY_KINDS, ['golf_booking', 'equipment_hire', 'restaurant_reservation', 'spa_appointment']);
    });

    // ---- Routes ----
    const ctl = require('../src/controllers/entityFolio');
    const at = (kind, id, extra = {}) => ({ params: { kind, id, ...extra.params }, body: extra.body ?? {} });

    await check('routes: read, add a charge, remove it', async () => {
      const g = await golfBooking({ players: 2, price: '180.00' });
      assert.equal((await call(ctl.getEntityFolio, at('golf_booking', g))).body.balance, '360.00');
      const add = await call(ctl.addEntityAdjustment, at('golf_booking', g, { body: { description: 'Glove', amount: 10.006 } }));
      assert.equal(add.status, 201);
      assert.equal(add.body.amount, '10.01');
      assert.equal(add.body.golf_booking_id, g);
      assert.equal((await call(ctl.getEntityFolio, at('golf_booking', g))).body.balance, '370.01');
      const del = await call(ctl.removeEntityAdjustment, at('golf_booking', g, { params: { adjustment_id: add.body.id } }));
      assert.equal(del.status, 204);
      assert.equal((await call(ctl.getEntityFolio, at('golf_booking', g))).body.balance, '360.00');
    });

    await check('routes: adjustment validation', async () => {
      const g = await golfBooking({ players: 1, price: '180.00' });
      for (const body of [{ description: 'x', amount: 0 }, { description: 'x', amount: 'abc' }, { amount: 5 }, { description: 'y'.repeat(201), amount: 5 }]) {
        assert.equal((await call(ctl.addEntityAdjustment, at('golf_booking', g, { body }))).status, 400, JSON.stringify(body));
      }
      assert.equal((await call(ctl.getEntityFolio, at('golf_booking', g))).body.items.length, 1);
    });

    await check('routes: record a payment, including on a cancelled booking and over the balance', async () => {
      const h = await hire({ quantity: 1, total: '50.00' });
      const pay = await call(ctl.recordEntityPayment, at('equipment_hire', h, { body: { amount: 80, method: 'cash' } }));
      assert.equal(pay.status, 201);
      assert.deepEqual([pay.body.status, pay.body.method, pay.body.equipment_hire_id], ['completed', 'cash', h]);
      assert.equal(pay.body.booking_id, null);
      assert.ok(pay.body.paid_at);
      assert.equal((await call(ctl.getEntityFolio, at('equipment_hire', h))).body.balance, '-30.00');
      const g = await golfBooking({ players: 1, price: '180.00', status: 'cancelled' });
      assert.equal((await call(ctl.recordEntityPayment, at('golf_booking', g, { body: { amount: 20 } }))).status, 201);
      for (const amount of [0, -5, 'abc', undefined]) {
        assert.equal((await call(ctl.recordEntityPayment, at('equipment_hire', h, { body: { amount } }))).status, 400, String(amount));
      }
    });

    await check('routes: unknown kind, bad id and another property are 404, never 500', async () => {
      const g = await golfBooking({ players: 1, price: '180.00' });
      const other = { property_id: '00000000-0000-0000-0000-000000000000' };
      for (const fn of [ctl.getEntityFolio, ctl.addEntityAdjustment, ctl.recordEntityPayment]) {
        const body = { description: 'x', amount: 5 };
        assert.equal((await call(fn, at('booking', g, { body }))).status, 404);
        assert.equal((await call(fn, at('golf_booking', 'abc', { body }))).status, 404);
        assert.equal((await call(fn, { ...at('golf_booking', g, { body }), ...other })).status, 404);
      }
      assert.equal((await one('SELECT count(*)::int AS n FROM payment WHERE golf_booking_id = $1', [g])).n, 0);
    });

    await check('routes: an adjustment can only be removed through the booking that owns it', async () => {
      const a = await golfBooking({ players: 1, price: '180.00' });
      const b = await golfBooking({ players: 1, price: '180.00' });
      const h = await hire({ quantity: 1, total: '50.00' });
      const adj = (await call(ctl.addEntityAdjustment, at('golf_booking', a, { body: { description: 'Glove', amount: 10 } }))).body.id;
      assert.equal((await call(ctl.removeEntityAdjustment, at('golf_booking', b, { params: { adjustment_id: adj } }))).status, 404);
      assert.equal((await call(ctl.removeEntityAdjustment, at('equipment_hire', h, { params: { adjustment_id: adj } }))).status, 404);
      assert.equal((await call(ctl.removeEntityAdjustment, at('golf_booking', a, { params: { adjustment_id: 'abc' } }))).status, 404);
      assert.ok(await one('SELECT id FROM folio_adjustment WHERE id = $1', [adj]));
    });

    // ---- Spa appointments ----
    const fs = require('node:fs');
    await check('spa: folio charges the frozen price, payments come from payment rows', async () => {
      const a = await spaAppointment({ price: '80.00' });
      await pool.query(`INSERT INTO payment (property_id, spa_appointment_id, amount, status, paid_at) VALUES ($1, $2, 20, 'completed', now())`, [P, a]);
      const f = await computeEntityFolio('spa_appointment', a, P);
      assert.deepEqual(f.items.map((i) => [i.type, i.amount]), [['base', '80.00']]);
      assert.equal(f.items[0].description, 'Massage');
      assert.equal(f.payments_total, '20.00'); assert.equal(f.balance, '60.00');
      assert.equal(f.currency, 'GBP');
      assert.equal(f.charged_to_booking_id, null);
    });

    await check('spa: stay-linked appointment names its room booking', async () => {
      const b = await roomBooking();
      const a = await spaAppointment({ bookingId: b });
      assert.equal((await computeEntityFolio('spa_appointment', a, P)).charged_to_booking_id, b);
      assert.equal((await computeEntityFolio('golf_booking', await golfBooking(), P)).charged_to_booking_id, null);
    });

    await check('spa: backfill records a paid appointment once, and only once', async () => {
      const a = await spaAppointment({ price: '80.00', paid: true });
      const b = await spaAppointment({ price: '80.00', paid: true });
      await pool.query(`INSERT INTO payment (property_id, spa_appointment_id, amount, status, paid_at) VALUES ($1, $2, 80, 'completed', now())`, [P, b]);
      const sql = fs.readFileSync(require('node:path').join(__dirname, '../src/db/migrate-2026-11-12-spa-payments-backfill.sql'), 'utf8');
      await pool.query(sql); await pool.query(sql);
      const rows = async (id) => (await pool.query('SELECT amount, method, status FROM payment WHERE spa_appointment_id = $1', [id])).rows;
      assert.deepEqual(await rows(a), [{ amount: '80.00', method: 'cash', status: 'completed' }]);
      assert.equal((await rows(b)).length, 1);
      assert.equal((await computeEntityFolio('spa_appointment', a, P)).balance, '0.00');
    });

    // ---- Restaurant deposit basis ----
    const restaurants = require('../src/controllers/restaurant');
    await check('restaurant: deposit basis defaults to per_table and can be set to per_guest', async () => {
      const made = await call(restaurants.createRestaurant, { body: { name: 'Basis', default_duration_minutes: 90 } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal(made.body.payment_protection_basis, 'per_table');
      const id = made.body.id;
      const put = await call(restaurants.updateRestaurant, { params: { id }, body: { payment_protection_basis: 'per_guest' } });
      assert.equal(put.body.payment_protection_basis, 'per_guest');
      assert.equal((await call(restaurants.updateRestaurant, { params: { id }, body: { name: 'Basis 2' } })).body.payment_protection_basis, 'per_guest');
      assert.equal((await call(restaurants.updateRestaurant, { params: { id }, body: { payment_protection_basis: 'per_person' } })).status, 400);
      assert.equal((await call(restaurants.createRestaurant, { body: { name: 'Bad', default_duration_minutes: 90, payment_protection_basis: 'per_person' } })).status, 400);
      const guest = await call(restaurants.createRestaurant, { body: { name: 'Guest', default_duration_minutes: 90, payment_protection_basis: 'per_guest' } });
      assert.equal(guest.body.payment_protection_basis, 'per_guest');
    });
  } finally {
    for (const t of ['payment', 'folio_adjustment', 'golf_booking_item', 'golf_booking', 'tee_time', 'golf_course', 'equipment_hire', 'equipment', 'restaurant_reservation', 'restaurant_table', 'restaurant',
      'spa_appointment', 'spa_treatment', 'spa_therapist', 'spa', 'booking', 'guest', 'room_type']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
})().catch((err) => { console.error(err); process.exit(1); });
