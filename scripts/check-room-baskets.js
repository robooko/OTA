// Checks room baskets (unpaid website checkouts) against the local DB. Every
// fixture lives inside one transaction that is rolled back. Never point this
// at the live DB.
//   node -r dotenv/config scripts/check-room-baskets.js
// No key, no client: a send fails (logged) instead of emailing.
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
    const { listOpenRoomBaskets, publishRoomBaskets, claimDueRoomBaskets } = require('../src/lib/roomBaskets');
    const ably = require('../src/lib/ably');
    const P = (await one(`INSERT INTO property (name, basket_reminder_enabled, basket_reminder_delay_mins)
                          VALUES ('Room Basket Check', true, 60) RETURNING id`)).id;
    const rt = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Deluxe', 2, 100) RETURNING id`, [P])).id;
    const room = (await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'B1') RETURNING id`, [P, rt])).id;
    const mkGuest = (email) => one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Ana', 'Guest', $2) RETURNING id`, [P, email]);
    let day = 1;
    const mkBooking = (guestId, status, { website = true, ago = '2 hours' } = {}) => {
      const d = day++;
      return one(
        `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status, website_checkout, created_at)
         VALUES ($1, $2, $3, DATE '2030-01-01' + $4::int, DATE '2030-01-02' + $4::int, 300, $5, $6, now() - $7::interval) RETURNING id`,
        [P, guestId, room, d * 2, status, website, ago]);
    };
    const openIds = async () => (await listOpenRoomBaskets(db, P, 50)).map((b) => b.id);

    await check('expired and pending website checkouts are open; staff and confirmed are not', async () => {
      const g = await mkGuest('a@example.test');
      const expired = await mkBooking(g.id, 'expired');
      const g2 = await mkGuest('b@example.test');
      const pending = await mkBooking(g2.id, 'pending_payment', { ago: '5 minutes' });
      const g3 = await mkGuest('c@example.test');
      await mkBooking(g3.id, 'expired', { website: false });
      const g4 = await mkGuest('d@example.test');
      await mkBooking(g4.id, 'confirmed');
      assert.deepEqual((await openIds()).sort(), [expired.id, pending.id].sort());
    });

    await check('row shape: one room line, total as subtotal, reminder due after the pay window', async () => {
      const g = await mkGuest('shape@example.test');
      const b = await mkBooking(g.id, 'pending_payment', { ago: '0 minutes' });
      const row = (await listOpenRoomBaskets(db, P, 50)).find((r) => r.id === b.id);
      assert.equal(row.status, 'open');
      assert.equal(row.contact_name, 'Ana Guest');
      assert.equal(row.items.length, 1);
      assert.match(row.items[0].item_name, /^Deluxe, /);
      assert.equal(row.items_subtotal, '300.00');
      const mins = (new Date(row.reminder_due_at) - new Date(row.updated_at)) / 60000;
      assert.equal(Math.round(mins), 60);
    });

    await check('a later booking by the same guest closes the basket; a later expired one replaces it', async () => {
      const g = await mkGuest('rebook@example.test');
      const first = await mkBooking(g.id, 'expired', { ago: '3 hours' });
      const retry = await mkBooking(g.id, 'expired', { ago: '1 hour' });
      let ids = await openIds();
      assert.ok(!ids.includes(first.id));
      assert.ok(ids.includes(retry.id));
      await mkBooking(g.id, 'confirmed', { website: false, ago: '10 minutes' });
      ids = await openIds();
      assert.ok(!ids.includes(retry.id));
    });

    await check('older than 7 days is not open', async () => {
      const g = await mkGuest('old@example.test');
      const b = await mkBooking(g.id, 'expired', { ago: '8 days' });
      assert.ok(!(await openIds()).includes(b.id));
    });

    await check('claim: only expired, due, opted-in, once', async () => {
      await db.query(`UPDATE booking SET basket_reminder_sent_at = now() WHERE property_id = $1`, [P]); // park earlier fixtures
      const g = await mkGuest('due@example.test');
      const due = await mkBooking(g.id, 'expired', { ago: '61 minutes' });
      const g2 = await mkGuest('early@example.test');
      await mkBooking(g2.id, 'expired', { ago: '30 minutes' });
      const g3 = await mkGuest('pending@example.test');
      await mkBooking(g3.id, 'pending_payment', { ago: '2 hours' });
      const g4 = await mkGuest('Opted@example.test');
      await mkBooking(g4.id, 'expired', { ago: '2 hours' });
      await db.query(`INSERT INTO basket_reminder_opt_out (property_id, email) VALUES ($1, 'opted@example.test')`, [P]);
      const claimed = (await claimDueRoomBaskets(db)).filter((b) => b.property_id === P);
      assert.deepEqual(claimed.map((b) => b.id), [due.id]);
      assert.equal(claimed[0].email, 'due@example.test');
      assert.equal(claimed[0].room_type_name, 'Deluxe');
      assert.equal((await claimDueRoomBaskets(db)).filter((b) => b.property_id === P).length, 0);
    });

    await check('reminders off: nothing claimed, no reminder_due_at', async () => {
      await db.query(`UPDATE property SET basket_reminder_enabled = false WHERE id = $1`, [P]);
      const g = await mkGuest('off@example.test');
      const b = await mkBooking(g.id, 'expired', { ago: '2 hours' });
      assert.equal((await claimDueRoomBaskets(db)).filter((r) => r.property_id === P).length, 0);
      const row = (await listOpenRoomBaskets(db, P, 50)).find((r) => r.id === b.id);
      assert.equal(row.reminder_due_at, null);
    });

    await check('publish sends every recent basket of the guest, closed ones as closed', async () => {
      const g = await mkGuest('pub@example.test');
      const first = await mkBooking(g.id, 'expired', { ago: '2 hours' });
      const second = await mkBooking(g.id, 'expired', { ago: '1 hour' });
      const sent = [];
      const orig = ably.publishRoomBasketUpdated;
      ably.publishRoomBasketUpdated = async (pid, r) => { sent.push(r); };
      try { await publishRoomBaskets(db, P, g.id); } finally { ably.publishRoomBasketUpdated = orig; }
      const byId = Object.fromEntries(sent.map((r) => [r.id, r.status]));
      assert.deepEqual(byId, { [first.id]: 'closed', [second.id]: 'open' });
    });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall ok');
  process.exit(failed ? 1 : 0);
})();
