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
  } finally {
    for (const t of ['payment', 'folio_adjustment', 'golf_booking_item', 'golf_booking', 'tee_time', 'golf_course', 'equipment_hire', 'equipment', 'restaurant_reservation', 'restaurant_table', 'restaurant']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
})().catch((err) => { console.error(err); process.exit(1); });
