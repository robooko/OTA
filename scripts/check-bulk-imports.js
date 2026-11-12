// POST /api/bookings/import, /api/event-inquiries/bulk and
// /api/restaurant-orders/import and /api/spa/:spa_id/appointments/import, driving the
// controllers directly. Fixtures live under a throwaway property and are
// deleted at the end. Local DB only, with migrate-2026-11-06-bulk-imports.sql and
// migrate-2026-11-06-restaurant-order-import.sql and migrate-2026-11-06-spa-appointment-import.sql.
//   node -r dotenv/config scripts/check-bulk-imports.js
delete process.env.ABLY_API_KEY;
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
// Stubbed before the controllers load: they destructure / call these.
const pipeline = require('../src/lib/aiReplyPipeline');
const aiRuns = [];
pipeline.runAiReply = async (args) => { aiRuns.push(args.inquiryId); };
const tokens = require('../src/lib/tokens');
tokens.getBalance = async () => 0;
const { importBookings } = require('../src/controllers/bookings');
const { bulkCreateInquiries } = require('../src/controllers/eventInquiries');
const { importOrders } = require('../src/controllers/restaurantOrders');
const { importAppointments } = require('../src/controllers/spa');
const { getGuestSummary } = require('../src/controllers/guests');
const { computeFolio } = require('../src/lib/folio');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name, currency) VALUES ('Import Check', 'IDR') RETURNING id`)).id;
  const call = async (fn, body, params = {}) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await fn({ property_id: P, params, query: {}, body, headers: {}, get: () => undefined, auth_method: 'api_key', api_key: { permissions: null } }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    const T = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Villa', 2, 5500000) RETURNING id`, [P])).id;
    const V1 = (await one(`INSERT INTO room (property_id, room_type_id, room_number, status) VALUES ($1, $2, 'V1', 'active') RETURNING id`, [P, T])).id;
    await require('../src/lib/availabilitySeeder').seedRoomAvailability(V1);
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const bk = (ref, extra) => ({
      external_ref: ref, room_type_id: T, check_in: day(30), check_out: day(32), total_price: 11250000,
      guest: { first_name: 'Ayu', last_name: 'Lestari', email: 'Ayu@Example.com' }, ...extra,
    });

    await check('bookings: kept price/source/booked_at; full type rejected; cancelled holds nothing; re-run is duplicate', async () => {
      const r = await call(importBookings, { bookings: [
        bk('B1', { source: 'ota', booked_at: '2026-09-01T10:00:00Z', metadata: { ota: 'Booking.com' } }),
        bk('B2'),
        bk('B3', { status: 'cancelled', source: 'corporate' }),
        bk('B4', { source: 'nope' }),
      ] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.results.map((x) => x.outcome), ['created', 'rejected', 'created', 'rejected']);
      assert.equal(r.body.results[1].reason, 'no room available');
      assert.equal(r.body.results[3].reason, 'invalid booking: source');
      const b1 = await one('SELECT * FROM booking WHERE id = $1', [r.body.results[0].booking_id]);
      assert.equal(b1.total_price, '11250000.00'); assert.equal(b1.source, 'ota'); assert.equal(b1.status, 'confirmed');
      assert.equal(b1.send_emails, false); assert.equal(b1.metadata.ota, 'Booking.com');
      assert.equal(b1.created_at.toISOString(), '2026-09-01T10:00:00.000Z');
      assert.equal((await one('SELECT count(*)::int AS n FROM booking_night WHERE booking_id = $1', [b1.id])).n, 2);
      const b3 = r.body.results[2].booking_id;
      assert.equal((await one('SELECT count(*)::int AS n FROM booking_night WHERE booking_id = $1', [b3])).n, 0);
      assert.equal((await one('SELECT count(*)::int AS n FROM guest WHERE property_id = $1', [P])).n, 1, 'one guest, matched by email');
      const again = await call(importBookings, { send_emails: true, bookings: [bk('B1')] });
      assert.equal(again.body.results[0].outcome, 'duplicate');
      assert.equal(again.body.results[0].booking_id, b1.id);
    });

    await check('bookings: send_emails top-level and per booking; no email = placeholder guest', async () => {
      const r = await call(importBookings, { send_emails: true, bookings: [
        bk('C1', { check_in: day(40), check_out: day(41) }),
        bk('C2', { check_in: day(41), check_out: day(42), send_emails: false, guest: { first_name: 'No', last_name: 'Mail' } }),
      ] });
      assert.deepEqual(r.body.counts, { created: 2 });
      const [c1, c2] = await Promise.all(r.body.results.map((x) => one('SELECT b.send_emails, g.email FROM booking b JOIN guest g ON g.id = b.guest_id WHERE b.id = $1', [x.booking_id])));
      assert.equal(c1.send_emails, true); assert.equal(c2.send_emails, false);
      assert.equal(c2.email, 'c2@import.invalid');
    });

    await check('bookings: checked_out / no_show are past stays with no availability check and no nights', async () => {
      // 2024 has no room_availability rows, so a confirmed import there would be 'no room available'.
      const r = await call(importBookings, { bookings: [
        bk('P1', { status: 'checked_out', check_in: '2024-01-10', check_out: '2024-01-13', total_price: 3000000 }),
        bk('P2', { status: 'no_show', check_in: '2024-01-10', check_out: '2024-01-12' }),
        bk('P3', { status: 'checked_in', check_in: '2024-01-10', check_out: '2024-01-12' }),
      ] });
      assert.deepEqual(r.body.results.map((x) => x.outcome), ['created', 'created', 'rejected'], JSON.stringify(r.body));
      for (const x of r.body.results.slice(0, 2)) {
        assert.equal((await one('SELECT count(*)::int AS n FROM booking_night WHERE booking_id = $1', [x.booking_id])).n, 0);
      }
      assert.equal((await one('SELECT status FROM booking WHERE id = $1', [r.body.results[0].booking_id])).status, 'checked_out');
    });

    await check('bookings: bad bodies are 400', async () => {
      assert.equal((await call(importBookings, {})).status, 400);
      assert.equal((await call(importBookings, { bookings: [] })).status, 400);
      assert.equal((await call(importBookings, { bookings: Array(501).fill(bk('X')) })).status, 400);
      assert.equal((await call(importBookings, { send_emails: 'no', bookings: [bk('X')] })).status, 400);
    });

    await check('inquiries: send_emails false (default) skips the AI reply and the token check', async () => {
      const r = await call(bulkCreateInquiries, { inquiries: [
        { name: 'PT Sinar', email: 'events@sinar.example', event_date: day(60), guests: 80, event_type: 'conference' },
        { name: 'No email' },
      ] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.created, 1); assert.equal(r.body.results[1].status, 400);
      assert.equal(aiRuns.length, 0);
      const on = await call(bulkCreateInquiries, { send_emails: true, inquiries: [{ name: 'A', email: 'a@example.com' }] });
      assert.equal(on.status, 200); assert.equal(on.body.results[0].status, 402, 'no tokens = refused, as for the website');
      assert.equal((await call(bulkCreateInquiries, { inquiries: [] })).status, 400);
    });

    await check('orders: paid at ordered_at, menu item matched by name, guest linked; re-run is duplicate', async () => {
      const R = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Sunset Restaurant', 90) RETURNING id`, [P])).id;
      const M = (await one(`INSERT INTO restaurant_menu_item (property_id, restaurant_id, name, price) VALUES ($1, $2, 'Nasi Goreng Nirwana', 95000) RETURNING id`, [P, R])).id;
      const r = await call(importOrders, { orders: [
        { external_ref: 'TX1', restaurant_id: R, ordered_at: '2026-10-01T08:15:00+08:00', guest_email: 'ayu@example.com',
          items: [{ item_name: 'nasi goreng nirwana', quantity: 2, unit_price: 95000 }, { item_name: 'Es Teh', unit_price: 15000 }] },
        { external_ref: 'TX2', restaurant_id: R, ordered_at: '2026-10-01T19:00:00+08:00', status: 'cancelled', paid: false, items: [{ item_name: 'Bintang', unit_price: 45000 }] },
        { external_ref: 'TX3', restaurant_id: R, ordered_at: 'nope', items: [{ item_name: 'X', unit_price: 1 }] },
        { external_ref: 'TX4', restaurant_id: T, ordered_at: '2026-10-01T19:00:00Z', items: [{ item_name: 'X', unit_price: 1 }] },
      ] });
      assert.deepEqual(r.body.results.map((x) => x.outcome), ['created', 'created', 'rejected', 'rejected'], JSON.stringify(r.body));
      assert.equal(r.body.results[2].reason, 'invalid order: ordered_at');
      assert.equal(r.body.results[3].reason, 'restaurant not found');
      const o1 = await one('SELECT * FROM restaurant_order WHERE id = $1', [r.body.results[0].order_id]);
      assert.equal(o1.total_price, '205000.00'); assert.equal(o1.status, 'delivered'); assert.equal(o1.payment_status, 'paid');
      assert.equal(o1.paid_at.toISOString(), '2026-10-01T00:15:00.000Z'); assert.equal(o1.created_at.toISOString(), '2026-10-01T00:15:00.000Z');
      assert.equal(o1.contact_name, 'Ayu Lestari'); assert.ok(o1.guest_id); assert.equal(o1.contact_email, null);
      const items = (await pool.query('SELECT item_id, quantity FROM restaurant_order_item WHERE order_id = $1 ORDER BY unit_price DESC', [o1.id])).rows;
      assert.equal(items[0].item_id, M); assert.equal(items[0].quantity, 2); assert.equal(items[1].item_id, null);
      const o2 = await one('SELECT status, payment_status, paid_at, contact_name FROM restaurant_order WHERE id = $1', [r.body.results[1].order_id]);
      assert.equal(o2.status, 'cancelled'); assert.equal(o2.payment_status, 'unpaid'); assert.equal(o2.paid_at, null); assert.equal(o2.contact_name, 'Walk-in');
      const again = await call(importOrders, { orders: [{ external_ref: 'TX1', restaurant_id: R, ordered_at: '2026-10-01T08:15:00Z', items: [{ item_name: 'X', unit_price: 1 }] }] });
      assert.equal(again.body.results[0].outcome, 'duplicate');
      assert.equal(again.body.results[0].order_id, o1.id);
      assert.equal((await call(importOrders, { orders: [] })).status, 400);

      // Full batch in one go; in-batch repeat ref; foreign/unknown menu item id.
      const big = Array.from({ length: 497 }, (_, i) => ({ external_ref: `B${i}`, restaurant_id: R, ordered_at: '2026-10-02T12:00:00Z',
        items: [{ item_name: 'Nasi Goreng Nirwana', unit_price: 95000 }, { item_name: 'Es Teh', quantity: 3, unit_price: 15000 }] }));
      big.push({ ...big[0] });
      big.push({ external_ref: 'BX', restaurant_id: R, ordered_at: '2026-10-02T12:00:00Z', items: [{ item_name: 'X', menu_item_id: T, unit_price: 1 }] });
      big.push({ external_ref: 'BY', restaurant_id: R, ordered_at: '2026-10-02T12:00:00Z', items: [{ item_name: 'Nasi', menu_item_id: M, unit_price: 1 }] });
      const t0 = Date.now();
      const b = await call(importOrders, { orders: big });
      const ms = Date.now() - t0;
      assert.deepEqual(b.body.counts, { created: 498, duplicate: 1, rejected: 1 }, JSON.stringify(b.body.counts));
      assert.equal(b.body.results[497].order_id, b.body.results[0].order_id);
      assert.equal(b.body.results[498].reason, 'menu item not found');
      assert.equal((await one(`SELECT count(*)::int AS n FROM restaurant_order_item i JOIN restaurant_order o ON o.id = i.order_id
        WHERE o.property_id = $1 AND o.external_ref LIKE 'B%'`, [P])).n, 497 * 2 + 1);
      assert.equal((await one(`SELECT total_price FROM restaurant_order WHERE id = $1`, [b.body.results[5].order_id])).total_price, '140000.00');
      assert.ok(ms < 3000, `500 orders took ${ms}ms`);
      console.log(`     500-order import: ${ms}ms`);
    });
    await check('spa appointments: completed + paid at local start, by name, no emails; skips availability; re-run is duplicate', async () => {
      await pool.query(`UPDATE property SET timezone = 'Asia/Makassar' WHERE id = $1`, [P]);
      const S = (await one(`INSERT INTO spa (property_id, name) VALUES ($1, 'Spa') RETURNING id`, [P])).id;
      const TR = (await one(`INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Balinese Massage', 90, 450000) RETURNING id`, [P, S])).id;
      const TH = (await one(`INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Wayan') RETURNING id`, [P, S])).id;
      const imp = (appointments) => call(importAppointments, { appointments }, { spa_id: S });
      // No therapist hours at all, dates in the past: availability is not checked.
      const r = await imp([
        { external_ref: 'SP1', treatment_name: 'balinese massage', therapist_name: 'WAYAN', date: '2026-09-01', start_time: '10:00', guest_email: 'ayu@example.com', payment_method: 'cash' },
        { external_ref: 'SP2', treatment_id: TR, therapist_id: TH, date: '2026-09-01', start_time: '10:00', end_time: '11:00', status: 'cancelled', paid: false, price: 300000 },
        { external_ref: 'SP3', treatment_name: 'Facial', therapist_id: TH, date: '2026-09-01', start_time: '10:00' },
        { external_ref: 'SP4', treatment_id: TR, therapist_name: 'Nobody', date: '2026-09-01', start_time: '10:00' },
        { external_ref: 'SP5', treatment_id: TR, therapist_id: TH, date: '2026-09-01', start_time: '10:00', status: 'confirmed' },
        { external_ref: 'SP1', treatment_id: TR, therapist_id: TH, date: '2026-09-02', start_time: '10:00' },
      ]);
      assert.deepEqual(r.body.results.map((x) => x.outcome), ['created', 'created', 'rejected', 'rejected', 'rejected', 'duplicate'], JSON.stringify(r.body));
      assert.deepEqual(r.body.results.slice(2, 5).map((x) => x.reason), ['treatment not found', 'therapist not found', 'invalid appointment: status']);
      assert.equal(r.body.results[5].appointment_id, r.body.results[0].appointment_id);
      const a1 = await one('SELECT * FROM spa_appointment WHERE id = $1', [r.body.results[0].appointment_id]);
      assert.equal(a1.status, 'completed'); assert.equal(a1.payment_status, 'paid'); assert.equal(a1.payment_method, 'cash');
      assert.equal(a1.paid_at.toISOString(), '2026-09-01T02:00:00.000Z'); // 10:00 WITA
      assert.equal(a1.end_time, '11:30:00'); assert.equal(a1.price, '450000.00');
      assert.equal(a1.contact_name, 'Ayu Lestari'); assert.ok(a1.guest_id); assert.equal(a1.contact_email, null);
      assert.equal(a1.send_emails, false); assert.equal(a1.slot_id, null);
      const a2 = await one('SELECT * FROM spa_appointment WHERE id = $1', [r.body.results[1].appointment_id]);
      assert.equal(a2.status, 'cancelled'); assert.equal(a2.payment_status, 'unpaid'); assert.equal(a2.paid_at, null);
      assert.equal(a2.end_time, '11:00:00'); assert.equal(a2.price, '300000.00'); assert.equal(a2.contact_name, 'Walk-in');
      const again = await imp([{ external_ref: 'SP2', treatment_id: TR, therapist_id: TH, date: '2026-09-03', start_time: '09:00' }]);
      assert.equal(again.body.results[0].outcome, 'duplicate'); assert.equal(again.body.results[0].appointment_id, a2.id);
      // A paid import is on record as a payment; an unpaid one and a re-import add none.
      const paymentsOf = async (id) => (await pool.query('SELECT amount, method, status, paid_at FROM payment WHERE spa_appointment_id = $1', [id])).rows;
      assert.deepEqual((await paymentsOf(a1.id)).map((p) => [p.amount, p.method, p.status, p.paid_at.toISOString()]),
        [['450000.00', 'cash', 'completed', '2026-09-01T02:00:00.000Z']]);
      assert.deepEqual(await paymentsOf(a2.id), []);
      await imp([{ external_ref: 'SP1', treatment_id: TR, therapist_id: TH, date: '2026-09-01', start_time: '10:00' }]);
      assert.equal((await paymentsOf(a1.id)).length, 1);
      assert.equal((await imp([])).status, 400);
      assert.equal((await call(importAppointments, { appointments: [{}] }, { spa_id: TR })).status, 404);
      const big = Array.from({ length: 500 }, (_, i) => ({ external_ref: `SB${i}`, treatment_id: TR, therapist_id: TH, date: '2026-08-01', start_time: '09:00' }));
      const t0 = Date.now();
      assert.deepEqual((await imp(big)).body.counts, { created: 500 });
      assert.ok(Date.now() - t0 < 3000, `500 appointments took ${Date.now() - t0}ms`);
    });

    await check('re-import links a guestless order / appointment to guest_email; nothing else changes', async () => {
      const R = (await one(`SELECT id FROM restaurant WHERE property_id = $1`, [P])).id;
      const S = (await one(`SELECT id FROM spa WHERE property_id = $1`, [P])).id;
      const before = await one(`SELECT * FROM restaurant_order WHERE property_id = $1 AND external_ref = 'TX2'`, [P]);
      const o = await call(importOrders, { orders: [
        { external_ref: 'TX2', restaurant_id: R, ordered_at: '2020-01-01T00:00:00Z', guest_email: ' AYU@example.com', items: [{ item_name: 'X', unit_price: 1 }] },
        { external_ref: 'TX2', restaurant_id: R, ordered_at: '2020-01-01T00:00:00Z', guest_email: 'ayu@example.com', items: [{ item_name: 'X', unit_price: 1 }] },
        { external_ref: 'TX1', restaurant_id: R, ordered_at: '2020-01-01T00:00:00Z', guest_email: 'ayu@example.com', items: [{ item_name: 'X', unit_price: 1 }] },
        { external_ref: 'B1', restaurant_id: R, ordered_at: '2020-01-01T00:00:00Z', guest_email: 'nobody@example.com', items: [{ item_name: 'X', unit_price: 1 }] },
        { external_ref: 'B2', restaurant_id: R, ordered_at: '2020-01-01T00:00:00Z', items: [{ item_name: 'X', unit_price: 1 }] },
      ] });
      assert.deepEqual(o.body.results.map((x) => x.outcome), ['linked', 'duplicate', 'duplicate', 'duplicate', 'duplicate'], JSON.stringify(o.body));
      assert.equal(o.body.results[0].order_id, before.id);
      const after = await one('SELECT * FROM restaurant_order WHERE id = $1', [before.id]);
      assert.ok(after.guest_id);
      assert.deepEqual({ ...after, guest_id: null, updated_at: null }, { ...before, guest_id: null, updated_at: null });
      assert.equal((await call(importOrders, { orders: [{ external_ref: 'TX2', restaurant_id: R, ordered_at: '2020-01-01T00:00:00Z', guest_email: 'ayu@example.com', items: [{ item_name: 'X', unit_price: 1 }] }] })).body.results[0].outcome, 'duplicate', 'already linked');
      const a = await call(importAppointments, { appointments: [
        { external_ref: 'SP2', treatment_name: 'Nope', therapist_name: 'Nope', date: '2020-01-01', start_time: '09:00', guest_email: 'ayu@example.com' },
        { external_ref: 'SP1', treatment_name: 'Nope', therapist_name: 'Nope', date: '2020-01-01', start_time: '09:00', guest_email: 'ayu@example.com' },
      ] }, { spa_id: S });
      assert.deepEqual(a.body.results.map((x) => x.outcome), ['linked', 'duplicate'], JSON.stringify(a.body));
      const a2 = await one(`SELECT guest_id, contact_name, status, price FROM spa_appointment WHERE property_id = $1 AND external_ref = 'SP2'`, [P]);
      assert.ok(a2.guest_id); assert.equal(a2.contact_name, 'Walk-in'); assert.equal(a2.status, 'cancelled'); assert.equal(a2.price, '300000.00');
    });

    await check('guest summary: first_stay + spa/F&B spend in lifetime_spent; cancelled/no_show left out', async () => {
      const g = (await one(`SELECT id FROM guest WHERE property_id = $1 AND email = 'ayu@example.com'`, [P])).id;
      const s = (await call(getGuestSummary, undefined, { id: g })).body;
      // Rooms B1 + C1 (11.25M each) + P1 3M; B3 cancelled, P2 no_show out. Spa SP1, F&B TX1.
      assert.equal(s.first_stay, '2024-01-10');
      assert.equal(Number(s.spa_spent), 450000); assert.equal(Number(s.restaurant_spent), 205000);
      assert.equal(s.lifetime_spent, '26155000.00');
    });

    await check("imports attach the guest's stay covering the day (check-out day, local time); folio lists them, paid ones not owed", async () => {
      const R = (await one(`SELECT id FROM restaurant WHERE property_id = $1`, [P])).id;
      const S = (await one(`SELECT id FROM spa WHERE property_id = $1`, [P])).id;
      const ref = async (r) => (await one(`SELECT id FROM booking WHERE property_id = $1 AND external_ref = $2`, [P, r])).id;
      const [P1, B1] = [await ref('P1'), await ref('B1')];
      const ord = (external_ref, ordered_at, extra) => ({ external_ref, restaurant_id: R, ordered_at, guest_email: 'ayu@example.com', items: [{ item_name: 'Kopi', unit_price: 30000 }], ...extra });
      const o = await call(importOrders, { orders: [
        ord('ST1', '2024-01-12T23:30:00Z'),               // 07:30 WITA on 2024-01-13, P1's check-out day
        ord('ST2', '2024-01-11T04:00:00Z', { paid: false }), // P1 and no-show P2 both cover: P1
        ord('ST3', `${day(31)}T04:00:00Z`),                // cancelled B3 and confirmed B1 cover: B1
        ord('ST4', '2025-06-01T04:00:00Z'),                // no stay
        ord('ST5', '2024-01-11T04:00:00Z', { guest_email: undefined }), // no guest
        ord('ST6', '2024-03-05T04:00:00Z'),
      ] });
      assert.deepEqual(o.body.results.map((x) => [x.outcome, x.booking_id]),
        [['created', P1], ['created', P1], ['created', B1], ['created', null], ['created', null], ['created', null]], JSON.stringify(o.body));
      // A stay imported later: the re-run attaches it, then is a duplicate.
      const P4 = (await call(importBookings, { bookings: [bk('P4', { status: 'checked_out', check_in: '2024-03-04', check_out: '2024-03-06', total_price: 1000000 })] })).body.results[0].booking_id;
      const again = await call(importOrders, { orders: [ord('ST6', '2020-01-01T00:00:00Z'), ord('ST1', '2020-01-01T00:00:00Z')] });
      assert.deepEqual(again.body.results.map((x) => [x.outcome, x.booking_id]), [['linked', P4], ['duplicate', P1]]);
      assert.equal((await call(importOrders, { orders: [ord('ST6', '2020-01-01T00:00:00Z')] })).body.results[0].outcome, 'duplicate');

      const spa = (external_ref, date, extra) => ({ external_ref, treatment_name: 'Balinese Massage', therapist_name: 'Wayan', date, start_time: '09:00', guest_email: 'ayu@example.com', ...extra });
      const a = await call(importAppointments, { appointments: [spa('SS1', '2024-01-13'), spa('SS2', '2024-01-12', { status: 'cancelled' }), spa('SS3', '2024-02-01')] }, { spa_id: S });
      assert.deepEqual(a.body.results.map((x) => [x.outcome, x.booking_id]), [['created', P1], ['created', P1], ['created', null]], JSON.stringify(a.body));
      // SP1 (2026-09-01) predates this; re-run leaves it with no stay.
      assert.equal((await call(importAppointments, { appointments: [spa('SP1', '2020-01-01')] }, { spa_id: S })).body.results[0].booking_id, null);

      const f = await computeFolio(P1, P);
      assert.deepEqual(f.items.slice(0, 2).map((i) => i.description), ['Villa · 3 nights', 'F&B · Sunset Restaurant']);
      const lines = f.items.map((i) => [i.type, i.amount, i.paid ?? null]);
      assert.deepEqual(lines, [['room', '3000000.00', null], ['room_service', '30000.00', false], ['room_service', '30000.00', true], ['spa', '450000.00', true]], JSON.stringify(f.items));
      assert.equal(f.charges_total, '3030000.00', 'paid at the outlet = listed, not owed; cancelled spa left off');
      assert.equal(f.balance, '3030000.00');
    });
  } finally {
    await pool.query('DELETE FROM payment WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM spa_appointment WHERE property_id = $1', [P]);
    for (const t of ['spa_treatment', 'spa_therapist', 'spa']) await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    await pool.query('DELETE FROM restaurant_order_item WHERE order_id IN (SELECT id FROM restaurant_order WHERE property_id = $1)', [P]);
    for (const t of ['restaurant_order', 'restaurant_menu_item', 'restaurant']) await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    await pool.query('DELETE FROM event_inquiry WHERE property_id = $1', [P]);
    for (const t of ['booking_night', 'booking', 'guest', 'room_availability', 'room', 'room_type']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
