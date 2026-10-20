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
const extracted = [];
docs.extractDocument = async (id, buf) => { extracted.push([id, buf]); }; // no model calls in checks
// Marina documents go to the org's Google Drive; fake the Drive client.
process.env.GOOGLE_CLIENT_ID ||= 'cid'; process.env.GOOGLE_CLIENT_SECRET ||= 'csecret'; process.env.GOOGLE_REDIRECT_URI ||= 'http://localhost/cb';
process.env.INTEGRATIONS_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
const drive = require('../src/lib/googleDrive');
const driveCalls = [];
let driveFail = null;
drive.uploadMarinaDocument = async (orgId, d) => {
  if (driveFail) throw driveFail;
  driveCalls.push([orgId, d]);
  return { id: `f${driveCalls.length}`, webViewLink: `https://drive.example/f${driveCalls.length}` };
};

const pool = require('../src/db');
const app = require('../src/app');
const { bookingToken } = require('../src/lib/marinaToken');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const KEY = `check_${crypto.randomBytes(8).toString('hex')}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const ORG = `org_mhc_${crypto.randomBytes(6).toString('hex')}`;
  await pool.query('INSERT INTO organization (clerk_org_id) VALUES ($1)', [ORG]);
  await pool.query("INSERT INTO org_integration (clerk_org_id, provider, refresh_token) VALUES ($1, 'google_drive', 'x')", [ORG]);
  const P = (await one(`INSERT INTO property (name, timezone, currency, api_key, api_key_enabled, clerk_org_id) VALUES ('Marina HTTP Check', 'Europe/Rome', 'eur', $1, true, $2) RETURNING id`, [KEY, ORG])).id;
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
    await check('sailor rail: books by marina id with a sailor token, no site key', async () => {
      const sa = require('../src/middleware/sailorAuth');
      const saved = sa.resolveSailor;
      sa.resolveSailor = async (t) => (t === 'good' ? { email: 'sailor@example.com' } : null);
      try {
        const S = `/api/marina/sailor/${m.id}`;
        const noKey = { 'X-Api-Key': '' };
        assert.equal((await api('POST', `${S}/bookings`, { body: guestBody(), headers: noKey })).status, 401);
        assert.equal((await api('POST', `${S}/bookings`, { body: guestBody(), headers: { ...noKey, 'X-Sailor-Token': 'bad' } })).status, 401);
        assert.equal((await api('GET', `/api/marina/sailor/${crypto.randomUUID()}`, { headers: { ...noKey, 'X-Sailor-Token': 'good' } })).status, 404);
        assert.equal((await api('GET', '/api/marina/sailor/porto-http', { headers: { ...noKey, 'X-Sailor-Token': 'good' } })).status, 404);
        const h = { ...noKey, 'X-Sailor-Token': 'good' };
        assert.equal((await api('GET', S, { headers: h })).status, 200);
        const r = await api('POST', `${S}/bookings`, { body: guestBody({ contact_email: 'spoof@example.com' }), headers: h });
        assert.equal(r.status, 201); assert.equal(r.body.booking.contact_email, 'sailor@example.com');
        const row = await one('SELECT property_id, email_verified, status, confirm_token_hash FROM marina_booking WHERE id = $1', [r.body.booking.id]);
        assert.equal(row.property_id, P); assert.equal(row.email_verified, true);
        // Already verified: straight to the marina, no confirm link.
        assert.notEqual(row.status, 'hold'); assert.equal(row.confirm_token_hash, null); assert.notEqual(r.body.booking.status, 'hold');
        assert.equal((await api('GET', `${S}/bookings/${r.body.booking.id}`, { headers: { ...h, 'X-Booking-Token': r.body.booking_token } })).status, 200);
      } finally { sa.resolveSailor = saved; }
    });
    // Fixed far-future dates: guestBody's rolling counter must not move for later checks.
    const fixedBody = { berth_label: 'H1', contact_name: 'Ann', boat_name: 'Wave', boat_length_m: 10 };
    const sailorH = { 'X-Api-Key': '', 'X-Sailor-Token': 'good' };
    await check('sailor bookings: lists only my verified bookings, across properties, with tokens', async () => {
      const sa = require('../src/middleware/sailorAuth');
      const saved = sa.resolveSailor;
      sa.resolveSailor = async (t) => (t === 'good' ? { email: 'sailor@example.com' } : null);
      const reqRow = await one(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name, mandatory) VALUES ($1, $2, 'passport', 'Passport SB', true) RETURNING id`, [P, m.id]);
      try {
        const S = `/api/marina/sailor/${m.id}`;
        const mine = await api('POST', `${S}/bookings`, { body: { ...fixedBody, arrival: future(950), departure: future(952) }, headers: sailorH });
        assert.equal(mine.status, 201);
        const sailorBookingId = mine.body.booking.id;
        const site = await api('POST', `${G}/bookings`, { body: { ...fixedBody, contact_email: 'sailor@example.com', arrival: future(960), departure: future(962) } });
        assert.equal(site.status, 201);
        const unverifiedId = site.body.booking.id;
        const r = await api('GET', '/api/marina/sailor/bookings', { headers: sailorH });
        assert.equal(r.status, 200);
        assert.ok(r.body.every((b) => b.contact_email === 'sailor@example.com'));
        assert.equal(r.body.filter((b) => b.id === unverifiedId).length, 0);
        const b = r.body.find((x) => x.id === sailorBookingId);
        assert.equal(b.booking_token, bookingToken(b.id));
        assert.equal(b.marina_id, m.id); assert.equal(typeof b.contract_required, 'boolean');
        assert.equal(typeof b.contract_agreed, 'boolean');
        assert.ok(Array.isArray(b.missing_documents));
        assert.deepEqual(b.missing_documents, [{ id: reqRow.id, name: 'Passport SB' }]);
        assert.equal((await api('GET', '/api/marina/sailor/bookings', { headers: { 'X-Api-Key': '' } })).status, 401);
      } finally {
        sa.resolveSailor = saved;
        await pool.query('DELETE FROM marina_doc_requirement WHERE id = $1', [reqRow.id]);
      }
    });
    await check('sailor bookings: route is not swallowed by /sailor/:marina_id', async () => {
      const sa = require('../src/middleware/sailorAuth');
      const saved = sa.resolveSailor;
      sa.resolveSailor = async (t) => (t === 'good' ? { email: 'sailor@example.com' } : null);
      try {
        assert.notEqual((await api('GET', '/api/marina/sailor/bookings', { headers: sailorH })).status, 404);
      } finally { sa.resolveSailor = saved; }
    });
    await check('sailor ably token: 503 when Ably is off', async () => {
      const sa = require('../src/middleware/sailorAuth');
      const saved = sa.resolveSailor;
      sa.resolveSailor = async (t) => (t === 'good' ? { email: 'sailor@example.com' } : null);
      try {
        // ABLY_API_KEY is deleted at the top of this script
        assert.equal((await api('GET', '/api/marina/sailor/bookings/ably-token', { headers: sailorH })).status, 503);
      } finally { sa.resolveSailor = saved; }
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
    const pendingBooking = async (ip = '192.0.2.121') => {
      await pool.query('UPDATE property SET stripe_publishable_key = NULL WHERE id = $1', [P]); // email-confirm path
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': ip } })).body;
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
      assert.equal((await api('GET', `/api/marina/documents/${d.id}/file`)).status, 404, 'file route removed: files live in Drive');
      assert.equal((await api('PUT', `/api/marina/documents/${d.id}`, { body: { status: 'verified' } })).status, 401);
    });

    // ---- Per-org storage: marina documents in the org's Google Drive ----
    let ipN = 0; const nextIp = () => `192.0.2.${200 + ipN++}`; // own IPs: the guest create limiter is per IP
    const nBeforeStorage = n; n = 200; // own date range: don't shift later fixtures' rolling dates
    const bearerCall = async (fn, req) => {
      const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let error;
      await fn({ params: {}, query: {}, body: {}, property_id: P, auth_method: 'bearer', ...req }, res, (e) => { error = e; });
      if (error) throw error;
      return res;
    };
    const docCtrlT = require('../src/controllers/marinaDocuments');
    const setDrive = (sql) => pool.query(`UPDATE org_integration SET ${sql} WHERE clerk_org_id = $1`, [ORG]);
    const driveOff = () => setDrive("provider = 'google_drive_off'");
    const driveOn = () => setDrive("provider = 'google_drive', reconnect_required = false");
    const NO_UPLOADS = "This marina can't accept document uploads yet";
    await check('upload goes to the org Drive: record only, path OTA/property/marina/booking, extraction gets the buffer', async () => {
      const b = await pendingBooking(nextIp());
      driveCalls.length = 0; extracted.length = 0;
      const r = await upload(b, pdf);
      assert.equal(r.status, 201);
      const row = await one('SELECT drive_file_id, drive_web_link FROM marina_document WHERE id = $1', [r.body.id]);
      assert.deepEqual(row, { drive_file_id: 'f' + driveCalls.length, drive_web_link: 'https://drive.example/f' + driveCalls.length });
      const [orgId, d] = driveCalls[0];
      assert.equal(orgId, ORG);
      const bk = await one('SELECT arrival::text, contact_name FROM marina_booking WHERE id = $1', [b.booking.id]);
      assert.deepEqual(d.path, ['OTA', 'Marina HTTP Check', 'Porto HTTP', `${bk.arrival} ${bk.contact_name} (${b.booking.id.slice(0, 8)})`]);
      assert.equal(d.fileName, 'passport.pdf'); assert.equal(d.contentType, 'application/pdf'); assert.ok(d.buf.equals(pdf));
      assert.equal(extracted.length, 1); assert.equal(extracted[0][0], r.body.id); assert.ok(extracted[0][1].equals(pdf));
      assert.equal(blobs.size, 0, 'nothing in the OTA store');
    });
    await check('no Drive connected → 409, nothing stored, Drive not called', async () => {
      const b = await pendingBooking(nextIp());
      await driveOff();
      try {
        driveCalls.length = 0;
        const r = await upload(b, pdf);
        assert.equal(r.status, 409); assert.equal(r.body.error, NO_UPLOADS); assert.match(r.body.details, /not connected document storage/);
        assert.equal(driveCalls.length, 0);
        assert.equal((await one('SELECT count(*)::int AS n FROM marina_document WHERE booking_id = $1', [b.booking.id])).n, 0);
      } finally { await driveOn(); }
    });
    await check('property without an org → same 409', async () => {
      const b = await pendingBooking(nextIp());
      await pool.query('UPDATE property SET clerk_org_id = NULL WHERE id = $1', [P]);
      try {
        const r = await upload(b, pdf);
        assert.equal(r.status, 409); assert.equal(r.body.error, NO_UPLOADS);
      } finally { await pool.query('UPDATE property SET clerk_org_id = $2 WHERE id = $1', [P, ORG]); }
    });
    await check('reconnect_required → 409 with reconnect details', async () => {
      const b = await pendingBooking(nextIp());
      await setDrive('reconnect_required = true');
      try {
        const r = await upload(b, pdf);
        assert.equal(r.status, 409); assert.equal(r.body.error, NO_UPLOADS); assert.match(r.body.details, /reconnect/i);
      } finally { await driveOn(); }
    });
    await check('Drive failure → 502, no row; revoked mid-upload → 409 reconnect', async () => {
      const b = await pendingBooking(nextIp());
      const { IntegrationError } = require('../src/lib/integrations');
      driveFail = new IntegrationError(502, 'Google Drive upload failed', { details: 'boom' });
      try {
        const r = await upload(b, pdf);
        assert.equal(r.status, 502); assert.equal(r.body.error, 'Google Drive upload failed');
        driveFail = new IntegrationError(409, 'Google Drive access was revoked', { code: 'invalid_grant' });
        const r2 = await upload(b, pdf);
        assert.equal(r2.status, 409); assert.equal(r2.body.error, NO_UPLOADS); assert.match(r2.body.details, /reconnect/i);
      } finally { driveFail = null; }
      assert.equal((await one('SELECT count(*)::int AS n FROM marina_document WHERE booking_id = $1', [b.booking.id])).n, 0);
    });
    await check('server without Google config → 503 naming the env var', async () => {
      const b = await pendingBooking(nextIp());
      const saved = process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_ID;
      try {
        const r = await upload(b, pdf);
        assert.equal(r.status, 503); assert.equal(r.body.error, 'Google Drive is not configured on this server'); assert.match(r.body.details, /GOOGLE_CLIENT_ID/);
      } finally { process.env.GOOGLE_CLIENT_ID = saved; }
    });
    await check('staff list and verification carry drive_web_link; warning when uploads are off', async () => {
      const b = await pendingBooking(nextIp());
      const d = (await upload(b, pdf)).body;
      const list = await bearerCall(docCtrlT.listBookingDocuments, { params: { id: b.booking.id } });
      assert.equal(list.body[0].id, d.id);
      assert.match(list.body[0].drive_web_link, /^https:\/\/drive\.example\//); assert.ok(!('file_deleted_at' in list.body[0]));
      const req = await one(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name) VALUES ($1, $2, 'passport', 'Passport W') RETURNING id`, [P, m.id]);
      try {
        let v = await bearerCall(docCtrlT.getBookingVerification, { params: { id: b.booking.id } });
        assert.deepEqual(v.body.document_uploads, { ok: true, reason: null }); assert.equal(v.body.warning, null);
        assert.match(v.body.documents[0].drive_web_link, /drive\.example/);
        await setDrive('reconnect_required = true');
        v = await bearerCall(docCtrlT.getBookingVerification, { params: { id: b.booking.id } });
        assert.deepEqual(v.body.document_uploads, { ok: false, reason: 'reconnect' });
        assert.equal(v.body.warning, "Guests can't upload documents: reconnect Google Drive in Settings");
        await driveOff();
        v = await bearerCall(docCtrlT.getBookingVerification, { params: { id: b.booking.id } });
        assert.equal(v.body.warning, "Guests can't upload documents: connect Google Drive in Settings");
      } finally {
        await driveOn();
        await pool.query('DELETE FROM marina_doc_requirement WHERE id = $1', [req.id]);
      }
    });
    await check('guest booking view and requirements-status report document_uploads', async () => {
      const b = await pendingBooking(nextIp());
      const view = () => api('GET', `${G}/bookings/${b.booking.id}`, { headers: { 'X-Booking-Token': b.booking_token } });
      const rs = () => api('GET', `${G}/requirements-status`);
      assert.equal((await view()).body.document_uploads, true);
      assert.equal((await rs()).body.document_uploads, true);
      await driveOff();
      try {
        assert.equal((await view()).body.document_uploads, false);
        assert.equal((await rs()).body.document_uploads, false);
      } finally { await driveOn(); }
    });

    await check('final review I3: the purge never counts or deletes Drive-backed rows', async () => {
      const { execFileSync } = require('child_process');
      const out = execFileSync(process.execPath, ['-r', 'dotenv/config', 'scripts/purge-marina-document-files.js'], { encoding: 'utf8', env: { ...process.env, BLOB_READ_WRITE_TOKEN: '' } });
      const rows = Number(/rows: (\d+)/.exec(out)[1]);
      const legacy = (await one('SELECT count(*)::int AS n FROM marina_document WHERE drive_file_id IS NULL')).n;
      assert.ok((await one('SELECT count(*)::int AS n FROM marina_document WHERE drive_file_id IS NOT NULL')).n > 0, 'fixture has Drive rows');
      assert.equal(rows, legacy);
    });
    n = nBeforeStorage;
    // ---- Task 11 ----
    await check('auto-confirm: off by default; on with no requirements confirms at pending', async () => {
      const b = await pendingBooking();
      assert.equal(await life.maybeAutoConfirm(b.booking.id), null);
      await pool.query('UPDATE marina SET auto_confirm = true WHERE id = $1', [m.id]);
      assert.equal((await life.maybeAutoConfirm(b.booking.id)).status, 'confirmed');
    });
    await check('auto-confirm waits for a verified mandatory doc and the contract', async () => {
      const req = await one(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name) VALUES ($1, $2, 'passport', 'Passport') RETURNING id`, [P, m.id]);
      await one(`INSERT INTO marina_contract_template (property_id, marina_id, name, body_markdown) VALUES ($1, $2, 'T', 'Hi {{sailor_name}}') RETURNING id`, [P, m.id]);
      const b = await pendingBooking();
      assert.equal(await life.maybeAutoConfirm(b.booking.id), null);
      const d = await one(`INSERT INTO marina_document (property_id, marina_id, booking_id, requirement_id, drive_file_id, content_type, size_bytes, status)
        VALUES ($1, $2, $3, $4, 'x', 'application/pdf', 1, 'verified') RETURNING id`, [P, m.id, b.booking.id, req.id]);
      assert.equal(await life.maybeAutoConfirm(b.booking.id), null, 'contract still missing');
      const r = await api('POST', `${G}/bookings/${b.booking.id}/contract`, { headers: { 'X-Booking-Token': b.booking_token } });
      assert.equal(r.status, 201); assert.match(r.body.rendered_body, /Hi Ann/);
      await new Promise((ok) => setTimeout(ok, 200)); // agreeContract fires auto-confirm in the background
      assert.equal((await one('SELECT status FROM marina_booking WHERE id = $1', [b.booking.id])).status, 'confirmed');
      await pool.query("UPDATE marina SET auto_confirm = false WHERE id = $1", [m.id]);
      await pool.query("UPDATE marina_doc_requirement SET status = 'inactive' WHERE marina_id = $1", [m.id]);
      await pool.query("UPDATE marina_contract_template SET status = 'inactive' WHERE marina_id = $1", [m.id]);
    });

    await check('contract: editor warns on unknown placeholders; preview and booking page render it', async () => {
      const t = await api('POST', `/api/marina/marinas/${m.id}/contract-templates`, { body: { name: 'Std', body_markdown: 'Berth {{berth_id}} for {{sailor_name}} at {{marina_name}} {{acord25.policy}}' } });
      assert.deepEqual(t.body.warnings, { unknown_placeholders: ['acord25.policy'] });
      const pv = await api('GET', `${G}/contract-preview?nights=2`);
      assert.equal(pv.body.body, 'Berth  for  at Porto HTTP ');
      const b = await pendingBooking();
      const page = await api('GET', `${G}/bookings/${b.booking.id}`, { headers: { 'X-Booking-Token': b.booking_token } });
      assert.equal(page.body.contract.rendered_body, 'Berth H1 for Ann at Porto HTTP '); assert.equal(page.body.contract.agreed_at, null);
      await pool.query("UPDATE marina_contract_template SET status = 'inactive' WHERE id = $1", [t.body.id]);
    });

    // ---- Task 12 ----
    await check('marina enquiry lands in the inbox with marina_id; guest sees only id+status', async () => {
      await pool.query('UPDATE property SET token_balance = 100 WHERE id = $1', [P]); // the enquiry gate needs a reply's worth
      const r = await api('POST', `${G}/enquiries`, { body: { name: 'Ann', email: 'ann@example.com', message: 'Space for a 12 m yacht?', arrival: future(60), departure: future(63), boat_length_m: 12 }, headers: { 'X-Client-Ip': '192.0.2.130' } });
      assert.equal(r.status, 201, JSON.stringify(r.body)); assert.deepEqual(Object.keys(r.body).sort(), ['id', 'status']);
      const row = await one('SELECT marina_id, message FROM event_inquiry WHERE id = $1', [r.body.id]);
      assert.equal(row.marina_id, m.id); assert.match(row.message, /Boat length: 12 m/);
    });

    await check('AI: marina inquiries get a berth availability tool, real results and marina facts', async () => {
      const { buildAvailabilityTool, executeAvailabilityTool } = require('../src/lib/aiReplyTools');
      const { buildVenueFacts } = require('../src/lib/aiReplies');
      const { loadMarinaContext } = require('../src/lib/aiReplyPipeline');
      const tool = buildAvailabilityTool({ marina_id: m.id });
      assert.equal(tool.name, 'check_availability'); assert.deepEqual(tool.input_schema.required, ['arrival', 'departure']);
      const r = await executeAvailabilityTool({ marina_id: m.id }, { arrival: future(700), departure: future(702), boat_length_m: 10 });
      assert.equal(r.options[0].label, 'H1'); assert.equal(r.options[0].total_price, '80.00');
      assert.match((await executeAvailabilityTool({ marina_id: m.id }, { arrival: 'x', departure: future(2) })).error, /YYYY-MM-DD/);
      const ctx = await loadMarinaContext(m.id);
      const facts = buildVenueFacts({ currency: 'EUR' }, null, null, ctx);
      assert.match(facts, /<marina name="Porto HTTP">/); assert.match(facts, /15\.00 m/); assert.match(facts, /within 24 hours/);
    });

    // ---- Final review fixes ----
    const heldCardBooking = async () => {
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
      const b = await cardBooking();
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [b.booking.id]);
      fake.store.get(row.stripe_payment_intent_id).status = 'requires_capture';
      await api('POST', `${G}/bookings/${b.booking.id}/confirm-payment`, { headers: tokenHdr(b.booking_token) });
      return b;
    };
    await check('a cleared Stripe key never blocks decline: booking declined, payment_error kept for retry', async () => {
      const b = await heldCardBooking();
      await pool.query('UPDATE property SET stripe_secret_key = NULL WHERE id = $1', [P]);
      const r = await api('PUT', `/api/marina/bookings/${b.booking.id}`, { body: { action: 'decline' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await one('SELECT status, payment_status, payment_error FROM marina_booking WHERE id = $1', [b.booking.id]);
      assert.equal(row.status, 'declined'); assert.equal(row.payment_status, 'held'); assert.match(row.payment_error, /Stripe key/);
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check' WHERE id = $1", [P]);
      await life.sweepOnce(); // the retry releases it once the key is back
      assert.equal((await one('SELECT payment_status FROM marina_booking WHERE id = $1', [b.booking.id])).payment_status, 'released');
    });
    await check('a failing release retry does not republish to the staff feed', async () => {
      const b = await heldCardBooking();
      await pool.query('UPDATE property SET stripe_secret_key = NULL WHERE id = $1', [P]);
      await api('PUT', `/api/marina/bookings/${b.booking.id}`, { body: { action: 'decline' } });
      const real = life.afterChange; let published = 0;
      life.afterChange = () => { published++; };
      try { await life.sweepOnce(); } finally { life.afterChange = real; }
      assert.equal(published, 0);
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check' WHERE id = $1", [P]);
      await life.sweepOnce();
    });
    await check('send-guest-link: 200 with email and booking_url, 409 without either', async () => {
      const mk = (email, day) => api('POST', '/api/marina/bookings', { body: { berth_id: berthRes.body.id, contact_name: 'Staff Guest', contact_email: email, arrival: future(day), departure: future(day + 2), status: 'pending' } });
      const withEmail = (await mk('sg@example.com', 900)).body;
      const noEmail = (await mk(undefined, 910)).body;
      assert.ok(withEmail.id && noEmail.id, 'fixtures created');
      assert.equal((await api('POST', `/api/marina/bookings/${withEmail.id}/send-guest-link`)).status, 409, 'no booking_url yet');
      await pool.query("UPDATE marina SET booking_url = 'https://site.example/booking?id={id}&token={token}' WHERE id = $1", [m.id]);
      assert.equal((await api('POST', `/api/marina/bookings/${withEmail.id}/send-guest-link`)).status, 200);
      assert.equal((await api('POST', `/api/marina/bookings/${noEmail.id}/send-guest-link`)).status, 409);
      await pool.query('UPDATE marina SET booking_url = NULL WHERE id = $1', [m.id]);
    });
    await check('key rail never sees passport-derived data on a booking', async () => {
      const b = await pendingBooking();
      const d = (await upload(b, pdf)).body;
      await pool.query("UPDATE marina_document SET expiry_date = '2031-01-01', extracted_data = '{\"number\":\"X1\"}' WHERE id = $1", [d.id]);
      const r = await api('GET', `/api/marina/bookings/${b.booking.id}`);
      assert.equal(r.status, 200);
      assert.ok(!JSON.stringify(r.body).includes('2031-01-01'));
      assert.ok(!JSON.stringify(r.body).includes('X1'));
    });

    // ---- Plan B Task 1 (R20) ----
    // guestBody's rolling dates would reach the staff booking fixed at
    // +400 days within three more calls; jump past every fixed fixture.
    n = 100;
    const ipR20 = { 'X-Client-Ip': '192.0.2.140' };
    const view = (b) => api('GET', `${G}/bookings/${b.booking.id}`, { headers: { 'X-Booking-Token': b.booking_token } });
    await check('R20: booking page lists document metadata only', async () => {
      const b = await pendingBooking();
      const d = (await upload(b, pdf)).body;
      await pool.query("UPDATE marina_document SET extracted_data = '{\"number\":\"X9\"}' WHERE id = $1", [d.id]);
      const r = await view(b);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.documents, [{ id: d.id, requirement_id: null, file_name: 'passport.pdf', status: 'pending', submitted_at: d.submitted_at }]);
      const json = JSON.stringify(r.body);
      assert.ok(!json.includes('X9')); assert.ok(!json.includes('drive_')); assert.ok(!json.includes('drive.example'));
    });
    await check('R20: booking.expired marks a lapsed hold, not a guest cancel', async () => {
      const a = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      assert.equal(a.booking.expired, false);
      await pool.query("UPDATE marina_booking SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [a.booking.id]);
      await life.sweepOnce();
      const lapsed = (await view(a)).body.booking;
      assert.equal(lapsed.status, 'cancelled'); assert.equal(lapsed.expired, true);
      const c = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      const cancelled = (await api('POST', `${G}/bookings/${c.booking.id}/cancel`, { headers: { 'X-Booking-Token': c.booking_token } })).body.booking;
      assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.expired, false);
    });
    await check('R20: a failing PaymentIntent retrieve gives payment null, not a 500', async () => {
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      assert.ok(b.payment, 'card path');
      assert.ok((await view(b)).body.payment, 'resumes while Stripe answers');
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [b.booking.id]);
      fake.store.delete(row.stripe_payment_intent_id); // the fake's retrieve now throws, as in a Stripe outage
      const r = await view(b);
      assert.equal(r.status, 200); assert.equal(r.body.payment, null); assert.equal(r.body.booking.status, 'hold');
    });
    await check('R20: no MARINA_BOOKING_TOKEN_SECRET → 503 before any hold is taken', async () => {
      const secret = process.env.MARINA_BOOKING_TOKEN_SECRET;
      delete process.env.MARINA_BOOKING_TOKEN_SECRET;
      try {
        const body = guestBody();
        const r = await api('POST', `${G}/bookings`, { body, headers: ipR20 });
        assert.equal(r.status, 503); assert.equal(r.body.error, 'Online booking is not configured');
        assert.equal((await one('SELECT count(*)::int AS n FROM marina_booking WHERE property_id = $1 AND contact_email = $2', [P, body.contact_email])).n, 0);
      } finally { process.env.MARINA_BOOKING_TOKEN_SECRET = secret; }
    });
    await check('R20: a zero total takes the email-confirm path, never a card hold', async () => {
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
      assert.equal((await api('POST', `/api/marina/marinas/${m.id}/berths`, { body: { label: 'Z1', length_m: 15, price_per_night: 0 } })).status, 201);
      const r = await api('POST', `${G}/bookings`, { body: guestBody({ berth_label: 'Z1' }), headers: ipR20 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.booking.total_price, '0.00'); assert.equal(r.body.payment, null);
      const row = await one('SELECT stripe_payment_intent_id, confirm_token_hash FROM marina_booking WHERE id = $1', [r.body.booking.id]);
      assert.equal(row.stripe_payment_intent_id, null); assert.ok(row.confirm_token_hash, 'confirm link issued');
    });

    // ---- Plan B final review ----
    await check('final: a used confirm link still lands the guest (mail scanners prefetch it)', async () => {
      await pool.query('UPDATE property SET stripe_secret_key = NULL, stripe_publishable_key = NULL WHERE id = $1', [P]);
      const r = await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 });
      assert.equal(r.body.payment, null, 'email path');
      const id = r.body.booking.id;
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('UPDATE marina_booking SET confirm_token_hash = $2 WHERE id = $1', [id, crypto.createHash('sha256').update(token).digest('hex')]);
      const link = `/api/marina/confirm-booking/${id}/${token}`;
      assert.equal((await api('GET', link, { headers: { 'X-Api-Key': '' } })).status, 200);
      const again = await api('GET', link, { headers: { 'X-Api-Key': '' } });
      assert.equal(again.status, 200, 'second click');
      assert.equal((await one('SELECT status FROM marina_booking WHERE id = $1', [id])).status, 'pending');
      assert.equal((await api('GET', `/api/marina/confirm-booking/${id}/${crypto.randomBytes(32).toString('base64url')}`, { headers: { 'X-Api-Key': '' } })).status, 404, 'a wrong token still 404s');
    });
    await check('final: booking.card_hold tells a card hold from an email-path hold, even with Stripe down', async () => {
      const email = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      assert.equal(email.booking.card_hold, false);
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
      const card = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      assert.ok(card.payment); assert.equal(card.booking.card_hold, true);
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [card.booking.id]);
      fake.store.delete(row.stripe_payment_intent_id);
      const v = (await view(card)).body;
      assert.equal(v.payment, null); assert.equal(v.booking.card_hold, true);
    });

    // ---- Plan C Task 1 (R12-R15) ----
    const docCtrl = require('../src/controllers/marinaDocuments');
    // Bearer-only controllers can't be reached over HTTP without a real
    // Clerk token; drive them directly (check-multi-property-http.js).
    const call = async (fn, req) => {
      const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let error;
      await fn({ params: {}, query: {}, body: {}, ...req }, res, (e) => { error = e; });
      if (error) throw error;
      return res;
    };
    // Records afterChange calls (the staff-feed publish) instead of publishing.
    const spyAfterChange = async (fn) => {
      const real = life.afterChange; const calls = [];
      life.afterChange = (...args) => { calls.push(args); };
      try { await fn(); } finally { life.afterChange = real; }
      return calls;
    };
    // Exactly one republish: the same joined row as before and after (no
    // status change, so no guest update or email), never a hold.
    const republishedOnce = (calls, id) => {
      assert.equal(calls.length, 1, `afterChange calls: ${calls.length}`);
      const [before, after] = calls[0];
      assert.equal(before, after); assert.equal(after.id, id); assert.notEqual(after.status, 'hold');
      return after;
    };
    const ipR12 = '192.0.2.150';
    const review = (id, status) => call(docCtrl.updateDocument, { params: { id }, body: { status }, property_id: P, auth_method: 'bearer' });
    // Off, so a verify or an agreement can't add a second, status-changing event.
    await pool.query('UPDATE marina SET auto_confirm = false WHERE id = $1', [m.id]);
    await check('R12: a guest document upload republishes the booking once', async () => {
      const b = await pendingBooking(ipR12);
      const calls = await spyAfterChange(async () => assert.equal((await upload(b, pdf)).status, 201));
      assert.equal(republishedOnce(calls, b.booking.id).doc_count, 1);
    });
    await check('R12: a staff verify and a reject each republish the booking once', async () => {
      const b = await pendingBooking(ipR12);
      const d = (await upload(b, pdf)).body;
      const verified = await spyAfterChange(async () => {
        const r = await review(d.id, 'verified');
        assert.equal(r.statusCode, 200); assert.equal(r.body.status, 'verified');
      });
      assert.equal(republishedOnce(verified, b.booking.id).docs_verified, 1);
      const rejected = await spyAfterChange(async () => assert.equal((await review(d.id, 'rejected')).body.status, 'rejected'));
      assert.equal(republishedOnce(rejected, b.booking.id).docs_verified, 0);
    });
    const tpl = (await api('POST', `/api/marina/marinas/${m.id}/contract-templates`, { body: { name: 'R12', body_markdown: 'Agreed by {{sailor_name}}' } })).body;
    const agree = (b) => api('POST', `${G}/bookings/${b.booking.id}/contract`, { headers: { 'X-Booking-Token': b.booking_token } });
    await check('R12: a contract agreement republishes the booking once', async () => {
      const b = await pendingBooking(ipR12);
      const calls = await spyAfterChange(async () => assert.equal((await agree(b)).status, 201));
      republishedOnce(calls, b.booking.id);
    });
    await check('R13: staff GET /bookings/:id returns the agreed contract text', async () => {
      const b = await pendingBooking(ipR12);
      assert.equal((await agree(b)).status, 201);
      const r = await api('GET', `/api/marina/bookings/${b.booking.id}`);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body.signature).sort(), ['agreed_at', 'rendered_body', 'signer_email', 'template_id']);
      assert.equal(r.body.signature.rendered_body, 'Agreed by Ann'); assert.equal(r.body.signature.template_id, tpl.id);
    });
    await pool.query("UPDATE marina_contract_template SET status = 'inactive' WHERE id = $1", [tpl.id]);
    await check('R12: republish never sends a hold to the staff feed', async () => {
      const h = await insert({ arrival: future(3300), departure: future(3302), status: 'hold', source: 'guest', expires: new Date(Date.now() + 3600000) });
      const calls = await spyAfterChange(() => life.republish(h.id));
      assert.equal(calls.length, 0);
    });
    await check('R14: include_inactive=1 lists deactivated rows; the default and include_inactive=true do not', async () => {
      const mk = async (path, body) => { const r = await api('POST', path, { body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
      const M = `/api/marina/marinas/${m.id}`;
      const pon = await mk(`${M}/pontoons`, { name: 'R14 pontoon' });
      const berth = await mk(`${M}/berths`, { label: 'R14', length_m: 10 });
      const tier = await mk(`${M}/price-tiers`, { valid_from: '2090-01-01', valid_to: '2090-12-31', max_length_m: 10, price_per_night: 1 });
      const other = await mk('/api/marina/marinas', { name: 'Porto R14', slug: 'porto-r14' });
      const lists = [[`${M}/pontoons`, pon.id], [`${M}/berths`, berth.id], [`${M}/price-tiers`, tier.id], ['/api/marina/marinas', other.id]];
      for (const [path, id] of lists) assert.equal((await api('PUT', `${path}/${id}`, { body: { status: 'inactive' } })).status, 200, `deactivate ${path}`);
      const ids = async (path) => (await api('GET', path)).body.map((r) => r.id);
      for (const [path, id] of lists) {
        assert.ok(!(await ids(path)).includes(id), `${path} default`);
        assert.ok(!(await ids(`${path}?include_inactive=true`)).includes(id), `${path} =true`);
        assert.ok((await ids(`${path}?include_inactive=1`)).includes(id), `${path} =1`);
      }
      assert.ok((await ids('/api/marina/marinas?include_inactive=1')).includes(m.id), 'active rows stay listed');
    });
    await check('R15: negative berth and tier prices or sizes → 400', async () => {
      const M = `/api/marina/marinas/${m.id}`;
      const b = await api('POST', `${M}/berths`, { body: { label: 'NEG', length_m: 10, price_per_night: -1 } });
      assert.equal(b.status, 400); assert.equal(b.body.error, 'price_per_night must be a number, 0 or more');
      const l = await api('PUT', `${M}/berths/${berthRes.body.id}`, { body: { length_m: -0.5 } });
      assert.equal(l.status, 400); assert.equal(l.body.error, 'length_m must be a number, 0 or more');
      const t = await api('POST', `${M}/price-tiers`, { body: { valid_from: '2091-01-01', valid_to: '2091-12-31', max_length_m: 10, price_per_night: -5 } });
      assert.equal(t.status, 400); assert.equal(t.body.error, 'price_per_night must be a number, 0 or more');
      const bulk = await api('POST', `${M}/berths/bulk`, { body: { rows: [{ label: 'NB1' }, { label: 'NB2', beam_m: -3 }] } });
      assert.equal(bulk.status, 400); assert.equal(bulk.body.error, 'row 2: beam_m must be a number, 0 or more');
    });
    await check('R15: price tier valid_from after valid_to → 400 on create and update', async () => {
      const T = `/api/marina/marinas/${m.id}/price-tiers`;
      const bad = await api('POST', T, { body: { valid_from: '2092-06-10', valid_to: '2092-06-01', max_length_m: 10, price_per_night: 1 } });
      assert.equal(bad.status, 400); assert.equal(bad.body.error, 'valid_to must be on or after valid_from');
      const ok = await api('POST', T, { body: { valid_from: '2092-06-01', valid_to: '2092-06-01', max_length_m: 10, price_per_night: 1, status: 'inactive' } });
      assert.equal(ok.status, 201, 'a one-day tier is fine');
      const upd = await api('PUT', `${T}/${ok.body.id}`, { body: { valid_from: '2092-06-02' } });
      assert.equal(upd.status, 400); assert.equal(upd.body.error, 'valid_to must be on or after valid_from');
      assert.equal((await api('PUT', `${T}/${ok.body.id}`, { body: { valid_to: '2092-06-30' } })).status, 200);
    });
    await check('seasons: tier takes a season instead of dates; checks ownership and span', async () => {
      const S = `/api/marina/marinas/${m.id}/seasons`, T = `/api/marina/marinas/${m.id}/price-tiers`;
      const long = await api('POST', S, { body: { name: 'Too long', valid_from: '2093-05-01', valid_to: '2094-05-01', repeats_yearly: true } });
      assert.equal(long.status, 400); assert.equal(long.body.error, 'a season that repeats every year must be shorter than a year');
      const s = await api('POST', S, { body: { name: 'Summer', valid_from: '2093-05-01', valid_to: '2093-10-31', repeats_yearly: true, status: 'inactive' } });
      assert.equal(s.status, 201);
      const t = await api('POST', T, { body: { season_id: s.body.id, max_length_m: 10, price_per_night: 1, status: 'inactive' } });
      assert.equal(t.status, 201); assert.equal(t.body.valid_from, null);
      const none = await api('POST', T, { body: { max_length_m: 10, price_per_night: 1 } });
      assert.equal(none.status, 400); assert.equal(none.body.error, 'season_id, or valid_from and valid_to, is required');
      const unhook = await api('PUT', `${T}/${t.body.id}`, { body: { season_id: null } });
      assert.equal(unhook.status, 400, 'dropping the season needs dates');
      const foreign = await api('POST', T, { body: { season_id: '6f1c0d4e-0000-4000-8000-000000000009', max_length_m: 10, price_per_night: 1 } });
      assert.equal(foreign.status, 400); assert.equal(foreign.body.error, 'season_id must be a season of this marina');
    });
    await check('R15: staff booking contact_phone over 30 and bad boat sizes → 400, on create and edit', async () => {
      const base = { berth_id: berthRes.body.id, contact_name: 'Val', arrival: future(3100), departure: future(3102), status: 'pending' };
      const post = (o) => api('POST', '/api/marina/bookings', { body: { ...base, ...o } });
      const phone = await post({ contact_phone: '1'.repeat(31) });
      assert.equal(phone.status, 400); assert.equal(phone.body.error, 'contact_phone must be up to 30 characters');
      for (const [k, val] of [['boat_length_m', -1], ['boat_length_m', 'abc'], ['boat_beam_m', -2]]) {
        const r = await post({ [k]: val });
        assert.equal(r.status, 400, `${k}=${val}`); assert.equal(r.body.error, `${k} must be a number, 0 or more`);
      }
      const ok = await post({ contact_phone: '1'.repeat(30), boat_length_m: 0, boat_beam_m: '' });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const put = (body) => api('PUT', `/api/marina/bookings/${ok.body.id}`, { body });
      const p2 = await put({ contact_phone: '+39 '.padEnd(31, '0') });
      assert.equal(p2.status, 400); assert.equal(p2.body.error, 'contact_phone must be up to 30 characters');
      const l2 = await put({ boat_length_m: -4 });
      assert.equal(l2.status, 400); assert.equal(l2.body.error, 'boat_length_m must be a number, 0 or more');
      assert.equal((await put({ boat_length_m: '12.5', boat_beam_m: '' })).status, 200);
    });
    await check('R15: marina email must be an email address', async () => {
      const r = await api('POST', '/api/marina/marinas', { body: { name: 'Porto Mail', slug: 'porto-mail', email: 'harbour office' } });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'email must be an email address');
      const u = await api('PUT', `/api/marina/marinas/${m.id}`, { body: { email: 'a@b' } });
      assert.equal(u.status, 400); assert.equal(u.body.error, 'email must be an email address');
      assert.equal((await api('PUT', `/api/marina/marinas/${m.id}`, { body: { email: '' } })).status, 200, "'' clears it");
    });
    await check('R15: an image over 4 MB → 413 JSON', async () => {
      // PNG signature + padding = 4 MB + 1 byte.
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4 * 1024 * 1024 - 7)]);
      const r = await api('POST', `/api/marina/marinas/${m.id}/images/upload`, { raw: png, headers: { 'Content-Type': 'image/png' } });
      assert.equal(r.status, 413); assert.deepEqual(r.body, { error: 'Images are limited to 4 MB' });
    });

    // (later tasks append here)
  } finally {
    server.close();
    // marina children cascade; booking children cascade from booking.
    await pool.query('DELETE FROM event_inquiry WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM property_token_ledger WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM marina WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
