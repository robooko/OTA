// POST /api/spa/:spa_id/appointments/bulk, driving the controller directly.
// Fixtures live under a throwaway property and are deleted at the end.
// Local DB only.
//   node -r dotenv/config scripts/check-spa-bulk-appointments.js
delete process.env.ABLY_API_KEY;
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
// Stubbed before the controller loads: it destructures these at require time.
const resend = require('../src/lib/resend');
const sent = [];
resend.sendAppointmentConfirmation = async (a) => { sent.push({ kind: 'confirm', to: a.contact_email }); return null; };
resend.sendAppointmentCancellation = async (a) => { sent.push({ kind: 'cancel', to: a.contact_email }); };
const spa = require('../src/controllers/spa');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const P = (await one(`INSERT INTO property (name, currency) VALUES ('Bulk Spa Check', 'GBP') RETURNING id`)).id;
  const call = async (body, extra) => {
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error;
    await spa.bulkCreateAppointments({ property_id: P, params: { spa_id: S }, query: {}, body, headers: {}, get: () => undefined, auth_method: 'bearer', user: { role: 'staff' }, ...extra }, res, (e) => { error = e; });
    if (error) throw error;
    return { status: res.statusCode, body: res.body };
  };

  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  const S = (await one("INSERT INTO spa (property_id, name) VALUES ($1, 'Spa') RETURNING id", [P])).id;
  try {
    const th = (await one("INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Tia') RETURNING id", [P, S])).id;
    const th2 = (await one("INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Uma') RETURNING id", [P, S])).id;
    const tr = (await one("INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Massage', 60, 80) RETURNING id", [P, S])).id;
    for (let d = 1; d <= 7; d++) {
      for (const t of [th, th2]) await pool.query("INSERT INTO spa_therapist_hours (property_id, therapist_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, '09:00', '17:00')", [P, t, d]);
    }
    const date = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const appt = (time, extra) => ({ treatment_id: tr, therapist_id: th, date, time, contact_name: `Guest ${time}`, ...extra });

    await check('books in order; a clash fails alone, the rest still book', async () => {
      const r = await call({ appointments: [appt('10:00'), appt('10:00'), appt('12:00'), { contact_name: 'No flow' }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.created, 2); assert.equal(r.body.failed, 2);
      assert.deepEqual(r.body.results.map((x) => x.index), [0, 1, 2, 3]);
      assert.ok(r.body.results[0].appointment.id);
      assert.equal(r.body.results[1].status, 409); assert.equal(r.body.results[1].code, 'unavailable');
      assert.ok(r.body.results[2].appointment.id);
      assert.equal(r.body.results[3].status, 400);
      const { n } = await one("SELECT count(*)::int AS n FROM spa_appointment WHERE property_id = $1 AND status != 'cancelled'", [P]);
      assert.equal(n, 2);
    });

    await check('all failing is 200 with created 0', async () => {
      const r = await call({ appointments: [appt('10:00')] });
      assert.equal(r.status, 200); assert.equal(r.body.created, 0);
    });

    await check('guest rail still applies per item (contact_email required)', async () => {
      const r = await call({ appointments: [appt('14:00')] }, { auth_method: 'api_key', api_key: { permissions: null }, user: undefined });
      assert.equal(r.body.results[0].status, 400);
    });

    await check('send_emails: top-level default, item wins; stored on the row', async () => {
      const r = await call({ send_emails: false, appointments: [appt('09:00'), appt('13:00', { send_emails: true })] });
      assert.equal(r.body.created, 2, JSON.stringify(r.body));
      assert.equal(r.body.results[0].appointment.send_emails, false);
      assert.equal(r.body.results[1].appointment.send_emails, true);
      const plain = await call({ appointments: [appt('15:00')] });
      assert.equal(plain.body.results[0].appointment.send_emails, true);
      const bad = await call({ appointments: [appt('16:00', { send_emails: 'no' })] });
      assert.equal(bad.body.results[0].status, 400);
    });

    await check('send_emails false: scoped key 403; full key books as staff (no hold, no email needed)', async () => {
      const scoped = await call({ send_emails: false, appointments: [appt('14:00', { contact_email: 'g@example.com' })] }, { auth_method: 'api_key', api_key: { permissions: ['spa.book'] }, user: undefined });
      assert.equal(scoped.body.results[0].status, 403);
      const full = await call({ send_emails: false, appointments: [appt('14:00')] }, { auth_method: 'api_key', api_key: { permissions: null }, user: undefined });
      const a = full.body.results[0].appointment;
      assert.ok(a, JSON.stringify(full.body));
      assert.equal(a.status, 'confirmed'); assert.equal(a.awaiting_email_confirmation, false); assert.equal(a.send_emails, false);
      const site = await call({ appointments: [appt('11:00', { contact_email: 'h@example.com' })] }, { auth_method: 'api_key', api_key: { permissions: null }, user: undefined });
      assert.equal(site.body.results[0].appointment.status, 'pending', 'full key with emails on is still the guest rail');
    });

    await check('no confirmation or cancellation email when send_emails is false', async () => {
      const tick = () => new Promise((r) => setTimeout(r, 200));
      const r = await call({ appointments: [
        appt('16:00', { contact_email: 'loud@example.com' }),
        appt('16:00', { therapist_id: th2, contact_email: 'quiet@example.com', send_emails: false }),
      ] });
      assert.equal(r.body.created, 2, JSON.stringify(r.body));
      await tick();
      assert.deepEqual(sent.map((e) => e.to), ['loud@example.com']);
      for (const { appointment } of r.body.results) {
        const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await spa.updateAppointment({ property_id: P, params: { spa_id: S, id: appointment.id }, query: {}, body: { status: 'cancelled' }, headers: {}, get: () => undefined, auth_method: 'bearer', user: { role: 'staff' } }, res, (e) => { throw e; });
      }
      await tick();
      assert.deepEqual(sent.map((e) => `${e.kind} ${e.to}`), ['confirm loud@example.com', 'cancel loud@example.com']);
    });

    await check('bad bodies are 400', async () => {
      assert.equal((await call({})).status, 400);
      assert.equal((await call({ appointments: [] })).status, 400);
      assert.equal((await call({ appointments: Array(51).fill(appt('15:00')) })).status, 400);
      assert.equal((await call({ appointments: ['x'] })).status, 400);
    });
  } finally {
    for (const t of ['spa_appointment', 'spa_therapist_hours', 'spa_treatment', 'spa_therapist', 'spa']) {
      await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    }
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
