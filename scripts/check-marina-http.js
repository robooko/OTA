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
const docs = require('../src/lib/marinaDocuments');
const blobs = new Map();
docs.store = {
  put: async (p, buf) => { blobs.set(p, buf); },
  get: async (p) => (blobs.has(p) ? { stream: require('stream').Readable.toWeb(require('stream').Readable.from(blobs.get(p))), contentType: 'application/pdf' } : null),
  del: async (ps) => ps.forEach((p) => blobs.delete(p)),
};
docs.extractDocument = async () => {}; // no model calls in checks

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

    // ---- Task 7: sweep ----
    const life = require('../src/lib/marinaLifecycle');
    const insert = (o) => one(
      `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, arrival, departure, status, source, hold_expires_at)
       VALUES ($1, $2, $3, 'Sweep', $4, $5, $6, $7, $8) RETURNING id`,
      [P, m.id, berthRes.body.id, o.arrival, o.departure, o.status, o.source, o.expires]);
    await check('sweep cancels expired guest hold/pending exactly once, never staff/import', async () => {
      const past = new Date(Date.now() - 60000);
      const a = await insert({ arrival: future(500), departure: future(501), status: 'hold', source: 'guest', expires: past });
      const b = await insert({ arrival: future(502), departure: future(503), status: 'pending', source: 'guest', expires: past });
      const c = await insert({ arrival: future(504), departure: future(505), status: 'pending', source: 'staff', expires: null });
      const d = await insert({ arrival: future(506), departure: future(507), status: 'pending', source: 'guest', expires: new Date(Date.now() + 3600000) });
      const r1 = await life.sweepOnce();
      assert.ok(r1.cancelled >= 2);
      const st = async (id) => (await one('SELECT status FROM marina_booking WHERE id = $1', [id])).status;
      assert.equal(await st(a.id), 'cancelled'); assert.equal(await st(b.id), 'cancelled');
      assert.equal(await st(c.id), 'pending'); assert.equal(await st(d.id), 'pending');
      const r2 = await life.sweepOnce();
      assert.equal(r2.cancelled, 0);
    });
    await check('staff confirm racing the sweep on an expired pending never confirms it', async () => {
      const x = await insert({ arrival: future(510), departure: future(511), status: 'pending', source: 'guest', expires: new Date(Date.now() - 1000) });
      const [conf] = await Promise.all([life.confirmBooking(x.id), life.sweepOnce()]);
      const s = (await one('SELECT status FROM marina_booking WHERE id = $1', [x.id])).status;
      assert.equal(s, 'cancelled');
      assert.ok(!conf.ok || conf.expired);
    });

    // ---- Task 8 ----
    await check('11th guest booking from one IP in an hour → 429', async () => {
      const ip = { 'X-Client-Ip': '192.0.2.55' };
      let last;
      for (let i = 0; i < 11; i++) last = await api('POST', `${G}/bookings`, { body: guestBody({ contact_email: `rl${i}@example.com` }), headers: ip });
      assert.equal(last.status, 429);
    });
    await check('ably-token requires the booking token', async () => {
      const r = await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': '192.0.2.56' } });
      assert.equal((await api('GET', `${G}/bookings/${r.body.booking.id}/ably-token`)).status, 404);
      // ABLY_API_KEY is unset in this check, so a valid token reaches the route and gets 503.
      assert.equal((await api('GET', `${G}/bookings/${r.body.booking.id}/ably-token`, { headers: { 'X-Booking-Token': r.body.booking_token } })).status, 503);
    });

    // ---- Task 9 ----
    const fake = require('./fake-stripe');
    await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
    const tokenHdr = (t) => ({ 'X-Booking-Token': t, 'X-Client-Ip': '192.0.2.90' });
    const cardBooking = async () => {
      const r = await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': '192.0.2.91' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body;
    };
    await check('priced booking returns a client_secret; PI amount and currency match', async () => {
      const b = await cardBooking();
      assert.ok(b.payment.client_secret); assert.equal(b.payment.publishable_key, 'pk_test_check');
      const row = await one('SELECT stripe_payment_intent_id, total_price FROM marina_booking WHERE id = $1', [b.booking.id]);
      const pi = fake.store.get(row.stripe_payment_intent_id);
      assert.equal(pi.amount, Math.round(row.total_price * 100)); assert.equal(pi.currency, 'eur'); assert.equal(pi.capture_method, 'manual');
    });
    await check('confirm-payment before authorisation → 409; after → pending + held', async () => {
      const b = await cardBooking();
      const path = `${G}/bookings/${b.booking.id}/confirm-payment`;
      assert.equal((await api('POST', path, { headers: tokenHdr(b.booking_token) })).status, 409);
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [b.booking.id]);
      fake.store.get(row.stripe_payment_intent_id).status = 'requires_capture';
      const ok = await api('POST', path, { headers: tokenHdr(b.booking_token) });
      assert.equal(ok.status, 200); assert.equal(ok.body.booking.status, 'pending'); assert.equal(ok.body.booking.payment_status, 'held');
    });
    await check('confirm-payment on a just-lapsed hold promotes (never cancels an authorised card)', async () => {
      const b = await cardBooking();
      const row = await one("UPDATE marina_booking SET hold_expires_at = now() - interval '5 seconds' WHERE id = $1 RETURNING stripe_payment_intent_id", [b.booking.id]);
      fake.store.get(row.stripe_payment_intent_id).status = 'requires_capture';
      const r = await api('POST', `${G}/bookings/${b.booking.id}/confirm-payment`, { headers: tokenHdr(b.booking_token) });
      assert.equal(r.body.booking.status, 'pending');
    });
    await check('sweep promotes an expired hold whose PI is requires_capture; cancels+releases one that is not', async () => {
      const a = await cardBooking(); const c = await cardBooking();
      const ra = await one("UPDATE marina_booking SET hold_expires_at = now() - interval '1 minute' WHERE id = $1 RETURNING stripe_payment_intent_id", [a.booking.id]);
      const rc = await one("UPDATE marina_booking SET hold_expires_at = now() - interval '1 minute' WHERE id = $1 RETURNING stripe_payment_intent_id", [c.booking.id]);
      fake.store.get(ra.stripe_payment_intent_id).status = 'requires_capture';
      await life.sweepOnce();
      assert.equal((await one('SELECT status, payment_status FROM marina_booking WHERE id = $1', [a.booking.id])).payment_status, 'held');
      const cc = await one('SELECT status, payment_status FROM marina_booking WHERE id = $1', [c.booking.id]);
      assert.equal(cc.status, 'cancelled'); assert.equal(cc.payment_status, 'released');
      assert.equal(fake.store.get(rc.stripe_payment_intent_id).status, 'canceled');
    });
    await check('PI creation failure frees the berth at once (502)', async () => {
      fake.failNextCreate = true;
      const body = guestBody();
      const r = await api('POST', `${G}/bookings`, { body, headers: { 'X-Client-Ip': '192.0.2.92' } });
      assert.equal(r.status, 502);
      assert.equal((await api('POST', `${G}/bookings`, { body: { ...body, contact_email: 'retry@example.com' }, headers: { 'X-Client-Ip': '192.0.2.92' } })).status, 201);
    });
    await check('staff confirm captures; capture failure keeps pending with payment_error', async () => {
      const b = await cardBooking();
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [b.booking.id]);
      fake.store.get(row.stripe_payment_intent_id).status = 'requires_capture';
      await api('POST', `${G}/bookings/${b.booking.id}/confirm-payment`, { headers: tokenHdr(b.booking_token) });
      fake.failNextCapture = true;
      const bad = await api('PUT', `/api/marina/bookings/${b.booking.id}`, { body: { action: 'confirm' } });
      assert.equal(bad.status, 502);
      const mid = await one('SELECT status, payment_error FROM marina_booking WHERE id = $1', [b.booking.id]);
      assert.equal(mid.status, 'pending'); assert.match(mid.payment_error, /capture failed/);
      const good = await api('PUT', `/api/marina/bookings/${b.booking.id}`, { body: { action: 'confirm' } });
      assert.equal(good.body.status, 'confirmed'); assert.equal(good.body.payment_status, 'captured'); assert.equal(good.body.payment_error, null);
    });
    await check('staff cancel of a captured booking with refund:true refunds', async () => {
      const id = (await one("SELECT id FROM marina_booking WHERE property_id = $1 AND payment_status = 'captured' LIMIT 1", [P])).id;
      const r = await api('PUT', `/api/marina/bookings/${id}`, { body: { action: 'cancel', refund: true } });
      assert.equal(r.body.payment_status, 'refunded');
    });
    await check('confirm-payment accepts a mismatched-case currency, rejects a wrong amount', async () => {
      const b = await cardBooking();
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [b.booking.id]);
      const pi = fake.store.get(row.stripe_payment_intent_id);
      pi.status = 'requires_capture'; pi.amount += 1;
      assert.equal((await api('POST', `${G}/bookings/${b.booking.id}/confirm-payment`, { headers: tokenHdr(b.booking_token) })).status, 409);
    });

    await check('Stripe key modes must match: a test publishable key is refused beside a live secret', async () => {
      const prop = require('../src/controllers/property');
      const call = async (fn, body) => {
        let out = { status: 200 };
        const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; } };
        await prop[fn]({ property_id: P, body }, res, (e) => { throw e; });
        return out;
      };
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_live_abc', stripe_publishable_key = NULL WHERE id = $1", [P]);
      const bad = await call('setStripePublishableKey', { stripe_publishable_key: 'pk_test_abc' });
      assert.equal(bad.status, 400); assert.match(bad.body.error, /test.*live/);
      assert.equal((await call('setStripePublishableKey', { stripe_publishable_key: 'pk_live_abc' })).status, 200);
      assert.equal((await call('setStripeKey', { stripe_secret_key: 'sk_test_abc' })).status, 400);
      assert.equal((await call('setStripeKey', { stripe_secret_key: 'pk_live_abc' })).status, 400);
      assert.equal((await call('clearStripePublishableKey', {})).status, 200);
      assert.equal((await call('setStripeKey', { stripe_secret_key: 'sk_test_abc' })).status, 200);
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
    });

    // ---- Task 10 ----
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1000)]);
    const upload = (b, buf, type = 'application/pdf', t = b.booking_token) => api('POST', `${G}/bookings/${b.booking.id}/documents`, { raw: buf, headers: { 'Content-Type': type, 'X-File-Name': 'passport.pdf', 'X-Booking-Token': t, 'X-Client-Ip': '192.0.2.120' } });
    const pendingBooking = async () => {
      await pool.query('UPDATE property SET stripe_publishable_key = NULL WHERE id = $1', [P]); // email-confirm path
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': '192.0.2.121' } })).body;
      await pool.query("UPDATE marina_booking SET status = 'pending' WHERE id = $1", [b.booking.id]);
      return b;
    };
    await check('upload rejected while hold', async () => {
      await pool.query('UPDATE property SET stripe_publishable_key = NULL WHERE id = $1', [P]);
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': '192.0.2.122' } })).body;
      assert.equal((await upload(b, pdf)).status, 409);
    });
    await check('upload: wrong magic bytes 400, > 4 MB 413, 11th file 409', async () => {
      const b = await pendingBooking();
      assert.equal((await upload(b, Buffer.from('not a pdf at all'))).status, 400);
      assert.equal((await upload(b, Buffer.concat([pdf, Buffer.alloc(4 * 1024 * 1024)]))).status, 413);
      for (let i = 0; i < 10; i++) assert.equal((await upload(b, pdf)).status, 201);
      assert.equal((await upload(b, pdf)).status, 409);
    });
    await check('document metadata and file routes reject the API key', async () => {
      const b = await pendingBooking();
      const d = (await upload(b, pdf)).body;
      assert.equal((await api('GET', `/api/marina/bookings/${b.booking.id}/documents`)).status, 401);
      assert.equal((await api('GET', `/api/marina/documents/${d.id}/file`)).status, 401);
      assert.equal((await api('PUT', `/api/marina/documents/${d.id}`, { body: { status: 'verified' } })).status, 401);
    });

    await check('retention deletes the file 90 days after cancellation, keeps the row', async () => {
      const b = await pendingBooking();
      const fresh = (await upload(b, pdf)).body;
      await pool.query("UPDATE marina_booking SET status = 'cancelled', updated_at = now() - interval '91 days' WHERE id = $1", [b.booking.id]);
      const d = await one('SELECT blob_pathname FROM marina_document WHERE id = $1', [fresh.id]);
      assert.ok(blobs.has(d.blob_pathname));
      await docs.retentionOnce();
      const after = await one('SELECT file_deleted_at FROM marina_document WHERE id = $1', [fresh.id]);
      assert.ok(after.file_deleted_at); assert.ok(!blobs.has(d.blob_pathname));
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
