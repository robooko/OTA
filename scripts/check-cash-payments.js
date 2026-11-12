// Cash payments on restaurant tabs and spa appointments, driving the
// controllers directly against a fake Stripe. Fixtures live under a throwaway
// property and are deleted at the end. Local DB only, with
// migrate-2026-11-02-cash-payments.sql applied.
//   node -r dotenv/config scripts/check-cash-payments.js
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const fakeStripe = require('./fake-stripe');
// The slice of billing the spa cash path reads; tests fill these in.
const billing = { customers: [], items: [], invoices: [], deleted: [], invoiceLines: [] };
fakeStripe.customers = { list: async () => ({ data: billing.customers }) };
fakeStripe.invoiceItems = {
  // settlePaidInvoice walks one invoice's lines with for-await.
  list: (params) => (params?.invoice
    ? { async *[Symbol.asyncIterator]() { yield* billing.invoiceLines; } }
    : Promise.resolve({ data: billing.items })),
  del: async (id) => { billing.deleted.push(id); billing.items = billing.items.filter((i) => i.id !== id); return { id, deleted: true }; },
};
fakeStripe.invoices = { list: async () => ({ data: billing.invoices }) };
require.cache[require.resolve('stripe')] = { id: 'stripe', filename: require.resolve('stripe'), loaded: true, exports: () => fakeStripe };

const pool = require('../src/db');
const ably = require('../src/lib/ably');
ably.publishTableSessionClosed = async () => {};
const sessions = require('../src/controllers/restaurantTableSessions');
const spa = require('../src/controllers/spaPayments');
const folios = require('../src/controllers/entityFolio');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name, currency, stripe_secret_key) VALUES ('Cash Check', 'GBP', 'sk_test_check') RETURNING id`)).id;
  const call = async (fn, req) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await fn({ property_id: P, params: {}, query: {}, body: {}, headers: {}, get: () => undefined, auth_method: 'bearer', user: { role: 'staff' }, ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };
  const guestKey = { auth_method: 'api_key', api_key: { permissions: ['housekeeping.inspect'] }, user: undefined };
  const fullKey = { auth_method: 'api_key', api_key: { permissions: null }, user: undefined };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    // ---- Restaurant ----
    const R = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Grill', 90) RETURNING id`, [P])).id;
    let tableNo = 0;
    const openTab = async () => {
      const t = (await one(`INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats) VALUES ($1, $2, $3, 4) RETURNING id`, [P, R, `C${++tableNo}`])).id;
      const s = (await one(`INSERT INTO restaurant_table_session (property_id, restaurant_id, table_id) VALUES ($1, $2, $3) RETURNING id`, [P, R, t])).id;
      await pool.query(`INSERT INTO restaurant_order (property_id, restaurant_id, table_id, table_session_id, total_price, status) VALUES ($1, $2, $3, $4, 42.50, 'delivered')`, [P, R, t, s]);
      return s;
    };
    const close = (id, body, extra) => call(sessions.closeSession, { params: { id }, body, ...extra });
    const tab = (id) => one('SELECT status, payment_status, payment_method, paid_at FROM restaurant_table_session WHERE id = $1', [id]);

    await check('restaurant: staff closes a tab in cash', async () => {
      const s = await openTab();
      const r = await close(s, { paid_with: 'cash' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await tab(s);
      assert.equal(row.status, 'closed'); assert.equal(row.payment_status, 'paid'); assert.equal(row.payment_method, 'cash'); assert.ok(row.paid_at);
      assert.equal((await close(s, { paid_with: 'cash' })).status, 409, 'already paid');
    });

    await check('restaurant: full key may record cash, a scoped key may not', async () => {
      const s = await openTab();
      assert.equal((await close(s, { paid_with: 'cash' }, guestKey)).status, 403);
      assert.equal((await tab(s)).status, 'open');
      assert.equal((await close(s, { paid_with: 'cash' }, fullKey)).status, 200);
    });

    await check('restaurant: bad bodies are 400', async () => {
      const s = await openTab();
      assert.equal((await close(s, { paid_with: 'card' })).status, 400);
      assert.equal((await close(s, { paid_with: 'cash', stripe_payment_intent_id: 'pi_x' })).status, 400);
      assert.equal((await tab(s)).status, 'open');
    });

    await check('restaurant: an untouched card intent is cancelled before cash', async () => {
      const s = await openTab();
      const pi = await call(sessions.createSessionPaymentIntent, { params: { id: s } });
      assert.equal(pi.status, 200, JSON.stringify(pi.body));
      assert.equal((await close(s, { paid_with: 'cash' })).status, 200);
      assert.equal(fakeStripe.store.get(pi.body.payment_intent_id).status, 'canceled');
    });

    await check('restaurant: a succeeded or in-flight card payment blocks cash', async () => {
      for (const status of ['succeeded', 'requires_action']) {
        const s = await openTab();
        const pi = await call(sessions.createSessionPaymentIntent, { params: { id: s } });
        fakeStripe.store.get(pi.body.payment_intent_id).status = status;
        const r = await close(s, { paid_with: 'cash' });
        assert.equal(r.status, 409, status); assert.equal(r.body.payment_intent_id, pi.body.payment_intent_id);
        assert.equal((await tab(s)).payment_status, 'unpaid');
      }
    });

    await check('restaurant: card close records payment_method card', async () => {
      const s = await openTab();
      const pi = await call(sessions.createSessionPaymentIntent, { params: { id: s } });
      fakeStripe.store.get(pi.body.payment_intent_id).status = 'succeeded';
      assert.equal((await close(s, { stripe_payment_intent_id: pi.body.payment_intent_id })).status, 200);
      assert.equal((await tab(s)).payment_method, 'card');
    });

    // ---- Spa ----
    const spaId = (await one("INSERT INTO spa (property_id, name) VALUES ($1, 'Spa') RETURNING id", [P])).id;
    const th = (await one("INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Tia') RETURNING id", [P, spaId])).id;
    const tr = (await one("INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Massage', 60, 80) RETURNING id", [P, spaId])).id;
    let hour = 8;
    const book = async () => (await one(
      `INSERT INTO spa_appointment (property_id, treatment_id, therapist_id, appointment_date, start_time, end_time, contact_name, contact_email, price)
       VALUES ($1, $2, $3, '2030-07-15', $4, $5, 'Ana', 'ana@example.test', 80) RETURNING id`,
      [P, tr, th, `${String(hour).padStart(2, '0')}:00`, `${String(++hour).padStart(2, '0')}:00`])).id;
    const pay = (id, body, extra) => call(spa.confirmAppointmentPayment, { params: { id, spa_id: spaId }, body, ...extra });
    const appt = (id) => one('SELECT payment_status, payment_method, paid_at FROM spa_appointment WHERE id = $1', [id]);

    await check('spa: staff records cash', async () => {
      const a = await book();
      const r = await pay(a, { paid_with: 'cash' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.payment_method, 'cash'); assert.equal(r.body.payment_status, 'paid');
      assert.equal((await pay(a, { paid_with: 'cash' })).status, 409, 'already paid');
    });

    await check('spa: scoped key 403, bad bodies 400, card path still needs an intent', async () => {
      const a = await book();
      assert.equal((await pay(a, { paid_with: 'cash' }, guestKey)).status, 403);
      assert.equal((await pay(a, { paid_with: 'card' })).status, 400);
      assert.equal((await pay(a, { paid_with: 'cash', stripe_payment_intent_id: 'pi_x' })).status, 400);
      assert.equal((await pay(a, {})).status, 400);
      assert.equal((await appt(a)).payment_status, 'unpaid');
      assert.equal((await pay(a, { paid_with: 'cash' }, fullKey)).status, 200);
    });

    await check('spa: untouched terminal intent cancelled; tapped one blocks cash', async () => {
      const a = await book();
      const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      assert.equal(pi.status, 200, JSON.stringify(pi.body));
      assert.equal((await pay(a, { paid_with: 'cash' })).status, 200);
      assert.equal(fakeStripe.store.get(pi.body.payment_intent_id).status, 'canceled');

      const b = await book();
      const pib = await call(spa.createAppointmentPaymentIntent, { params: { id: b, spa_id: spaId } });
      fakeStripe.store.get(pib.body.payment_intent_id).status = 'succeeded';
      assert.equal((await pay(b, { paid_with: 'cash' })).status, 409);
      assert.equal((await appt(b)).payment_status, 'unpaid');
    });

    await check('spa: pending bill line removed; invoiced appointment blocks cash', async () => {
      billing.customers = [{ id: 'cus_ana' }];
      const a = await book();
      billing.items = [{ id: 'ii_a', invoice: null, metadata: { spa_appointment_id: a } }];
      assert.equal((await pay(a, { paid_with: 'cash' })).status, 200);
      assert.deepEqual(billing.deleted, ['ii_a']);

      const b = await book();
      billing.invoices = [{ id: 'in_b', status: 'open', metadata: { spa_appointment_id: b } }];
      const r = await pay(b, { paid_with: 'cash' });
      assert.equal(r.status, 409); assert.equal(r.body.invoice_id, 'in_b');
      assert.equal((await appt(b)).payment_status, 'unpaid');
      billing.customers = []; billing.items = []; billing.invoices = [];
    });

    await check('spa: card confirm records payment_method card', async () => {
      const a = await book();
      const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      fakeStripe.store.get(pi.body.payment_intent_id).status = 'succeeded';
      assert.equal((await pay(a, { stripe_payment_intent_id: pi.body.payment_intent_id })).status, 200);
      assert.equal((await appt(a)).payment_method, 'card');
    });

    const paymentsOf = async (id) => (await pool.query('SELECT amount, method FROM payment WHERE spa_appointment_id = $1 ORDER BY amount', [id])).rows;
    await check('spa: deposit by card, the rest in cash', async () => {
      const a = await book();
      const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      assert.equal(pi.body.amount, 8000);
      const intent = fakeStripe.store.get(pi.body.payment_intent_id);
      intent.amount = 2000; intent.status = 'succeeded';            // a 20.00 deposit taken
      const first = await pay(a, { stripe_payment_intent_id: intent.id });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal((await pay(a, { stripe_payment_intent_id: intent.id })).status, 200, 'a retry is fine');
      assert.equal((await appt(a)).payment_status, 'unpaid');
      const cash = await pay(a, { paid_with: 'cash' });
      assert.equal(cash.status, 200, JSON.stringify(cash.body));
      assert.deepEqual(await paymentsOf(a), [{ amount: '20.00', method: 'card' }, { amount: '60.00', method: 'cash' }]);
      assert.equal((await appt(a)).payment_status, 'paid');
    });

    await check('spa: a charge added after payment is what the next tap takes', async () => {
      const a = await book();
      assert.equal((await pay(a, { paid_with: 'cash' })).status, 200);
      const add = await call(folios.addEntityAdjustment, { params: { kind: 'spa_appointment', id: a }, body: { description: 'Oil', amount: 12 } });
      assert.equal(add.status, 201);
      assert.equal((await appt(a)).payment_status, 'unpaid');
      const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      assert.equal(pi.status, 200, JSON.stringify(pi.body));
      assert.equal(pi.body.amount, 1200);
    });

    await check('spa: an unpaid tap is repriced to what is owed; a succeeded one is recorded, then the rest charged', async () => {
      const a = await book();
      const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      await call(folios.recordEntityPayment, { params: { kind: 'spa_appointment', id: a }, body: { amount: 30, method: 'cash' } });
      const again = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      assert.equal(again.body.payment_intent_id, pi.body.payment_intent_id);
      assert.equal(again.body.amount, 5000);
      const intent = fakeStripe.store.get(pi.body.payment_intent_id);
      intent.amount = 2000; intent.status = 'succeeded';           // tapped for 20, app died before confirm
      const after = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
      assert.notEqual(after.body.payment_intent_id, intent.id);
      assert.equal(after.body.amount, 3000);
      assert.deepEqual(await paymentsOf(a), [{ amount: '20.00', method: 'card' }, { amount: '30.00', method: 'cash' }]);
    });

    await check('spa: a paid invoice settles once', async () => {
      const a = await book();
      const invoice = { id: 'in_paid', currency: 'gbp', metadata: { spa_appointment_id: a } };
      billing.invoiceLines = [{ amount: 8000, metadata: { spa_appointment_id: a } }];
      assert.deepEqual((await spa.settlePaidInvoice(fakeStripe, invoice, P)).settled, [a]);
      assert.deepEqual((await spa.settlePaidInvoice(fakeStripe, invoice, P)).settled, [a]);
      assert.equal((await paymentsOf(a)).length, 1);
      assert.equal((await appt(a)).payment_status, 'paid');
      billing.invoiceLines = [];
    });
  } finally {
    await pool.query('DELETE FROM restaurant_order WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM folio_adjustment WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM payment WHERE property_id = $1', [P]);
    for (const t of ['restaurant_table_session', 'restaurant_table', 'restaurant', 'spa_appointment', 'spa_treatment', 'spa_therapist', 'spa']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
