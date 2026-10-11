// HTTP-level marina checks: the real app on an ephemeral port, real
// connections. Fixtures are committed under a throwaway property and
// deleted at the end (pass or fail). Local DB only.
//   node -r dotenv/config scripts/check-marina-http.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret';
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const marinaStripe = require('../src/lib/marinaStripe');
const fakeStripe = require('./fake-stripe'); // Task 9
marinaStripe.stripeFor = () => fakeStripe;

const pool = require('../src/db');
const app = require('../src/app');
const { bookingToken } = require('../src/lib/marinaToken');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const KEY = `check_${crypto.randomBytes(8).toString('hex')}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, timezone, currency, api_key, api_key_enabled) VALUES ('Marina HTTP Check', 'Europe/Rome', 'eur', $1, true) RETURNING id`, [KEY])).id;
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const api = async (method, path, { body, headers = {}, raw } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'X-Api-Key': KEY, 'X-Client-Ip': '198.51.100.7', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };

  try {
    const m = (await api('POST', '/api/marina/marinas', { body: { name: 'Porto HTTP', slug: 'porto-http', response_window_hours: 24 } })).body;
    const berthRes = await api('POST', `/api/marina/marinas/${m.id}/berths`, { body: { label: 'H1', length_m: 15, beam_m: 5, price_per_night: 4, price_mode: 'per_metre' } });
    assert.equal(berthRes.status, 201);
    const G = '/api/marina/guest/porto-http';
    const future = (d) => { const t = new Date(Date.now() + d * 86400000); return t.toISOString().slice(0, 10); };
    let n = 0;
    const guestBody = (o = {}) => ({ berth_label: 'H1', arrival: future(30 + 10 * n), departure: future(32 + 10 * n++), contact_name: 'Ann', contact_email: `ann${n}@example.com`, boat_name: 'Wave', boat_length_m: 10, ...o });

    // ---- Task 6 ----
    await check('guest cannot set status; booking starts as hold', async () => {
      const r = await api('POST', `${G}/bookings`, { body: guestBody({ status: 'confirmed' }) });
      assert.equal(r.status, 201); assert.equal(r.body.booking.status, 'hold'); assert.ok(r.body.booking_token);
    });
    await check('wrong or missing booking token → 404', async () => {
      const r = await api('POST', `${G}/bookings`, { body: guestBody() });
      const id = r.body.booking.id;
      assert.equal((await api('GET', `${G}/bookings/${id}`)).status, 404);
      assert.equal((await api('GET', `${G}/bookings/${id}`, { headers: { 'X-Booking-Token': bookingToken(crypto.randomUUID()) } })).status, 404);
      assert.equal((await api('GET', `${G}/bookings/${id}`, { headers: { 'X-Booking-Token': r.body.booking_token } })).status, 200);
    });
    await check('hold → pending only via the email-confirm link; the create response cannot confirm', async () => {
      const r = await api('POST', `${G}/bookings`, { body: guestBody() });
      const id = r.body.booking.id;
      assert.equal((await api('GET', `/api/marina/confirm-booking/${id}/${r.body.booking_token}`, { headers: { 'X-Api-Key': '' } })).status, 404);
      const row = await one('SELECT status FROM marina_booking WHERE id = $1', [id]);
      assert.equal(row.status, 'hold');
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('UPDATE marina_booking SET confirm_token_hash = $2 WHERE id = $1', [id, crypto.createHash('sha256').update(token).digest('hex')]);
      const ok = await api('GET', `/api/marina/confirm-booking/${id}/${token}`, { headers: { 'X-Api-Key': '' } });
      assert.equal(ok.status, 200);
      const after = await one('SELECT status, hold_expires_at > now() + interval \'23 hours\' AS window FROM marina_booking WHERE id = $1', [id]);
      assert.equal(after.status, 'pending'); assert.ok(after.window);
    });
    await check('overlapping guest booking → 409', async () => {
      const b = guestBody();
      assert.equal((await api('POST', `${G}/bookings`, { body: b })).status, 201);
      assert.equal((await api('POST', `${G}/bookings`, { body: { ...b, contact_email: 'other@example.com' } })).status, 409);
    });
    await check('staff list hides holds; staff can confirm a pending booking', async () => {
      const r = await api('POST', '/api/marina/bookings', { body: { berth_id: berthRes.body.id, contact_name: 'Staff', arrival: future(400), departure: future(402), status: 'pending' } });
      assert.equal(r.status, 201);
      const list = await api('GET', '/api/marina/bookings');
      assert.ok(list.body.data.every((b) => b.status !== 'hold'));
      const c = await api('PUT', `/api/marina/bookings/${r.body.id}`, { body: { action: 'confirm' } });
      assert.equal(c.status, 200); assert.equal(c.body.status, 'confirmed');
      assert.equal((await api('PUT', `/api/marina/bookings/${r.body.id}`, { body: { action: 'confirm' } })).status, 409);
    });

    // (later tasks append here)
  } finally {
    server.close();
    // marina children cascade; booking children cascade from booking.
    await pool.query('DELETE FROM event_inquiry WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM marina WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
