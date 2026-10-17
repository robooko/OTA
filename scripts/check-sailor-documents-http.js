// HTTP-level sailor document checks: the real app on an ephemeral port.
// Clerk is stubbed (token 'sailor:<email>' -> that email), the blob store is
// an in-memory map, extraction is off. Fixtures are committed under a
// throwaway property / run-unique emails and deleted at the end. Local DB only.
//   node -r dotenv/config scripts/check-sailor-documents-http.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret';
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Readable } = require('stream');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const sailorAuth = require('../src/middleware/sailorAuth');
sailorAuth.resolveSailor = async (t) => (t.startsWith('sailor:') ? { email: t.slice(7).toLowerCase() } : null);
const docs = require('../src/lib/marinaDocuments');
const blobs = new Map();
docs.store = {
  put: async (p, buf) => { blobs.set(p, buf); },
  get: async (p) => (blobs.has(p) ? { stream: Readable.toWeb(Readable.from(blobs.get(p))), contentType: 'application/pdf' } : null),
  del: async (ps) => ps.forEach((p) => blobs.delete(p)),
};
docs.extractDocument = async () => {};
docs.extractSailorVersion = async () => {};

const pool = require('../src/db');
const app = require('../src/app');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const RUN = crypto.randomBytes(4).toString('hex');
  const mail = (n) => `${n}-${RUN}@sd-http.test`;
  const KEY = `check_${crypto.randomBytes(8).toString('hex')}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, timezone, currency, api_key, api_key_enabled) VALUES ('Sailor Docs HTTP Check', 'Europe/Rome', 'eur', $1, true) RETURNING id`, [KEY])).id;
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const api = async (method, path, { body, headers = {}, raw } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'X-Client-Ip': '198.51.100.9', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const PDF = Buffer.from('%PDF-1.4 check');
  const as = (email) => ({ 'X-Sailor-Token': `sailor:${email}` });
  const S = '/api/sailor/documents';
  const upload = (email, qs, buf = PDF, type = 'application/pdf') =>
    api('POST', `${S}?${qs}`, { raw: buf, headers: { ...as(email), 'Content-Type': type, 'X-File-Name': 'policy.pdf' } });

  try {
    // ---- Task 3: sailor API ----
    const ANN = mail('ann'); const BOB = mail('bob');
    await check('no token → 401', async () => {
      assert.equal((await api('GET', S)).status, 401);
      assert.equal((await api('GET', S, { headers: { 'X-Sailor-Token': 'junk' } })).status, 401);
    });
    let annDoc;
    await check('upload creates a document with one version', async () => {
      const r = await upload(ANN, 'type=insurance&expiry_date=2028-01-31');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      annDoc = r.body;
      assert.equal(annDoc.type, 'insurance'); assert.equal(annDoc.expiry_date, '2028-01-31'); assert.equal(annDoc.approval_count, 0);
      assert.equal(annDoc.versions.length, 1); assert.equal(annDoc.versions[0].file_name, 'policy.pdf');
      const list = (await api('GET', S, { headers: as(ANN) })).body;
      assert.deepEqual(list.map((d) => d.id), [annDoc.id]);
    });
    await check('upload with document_id adds a version', async () => {
      const r = await upload(ANN, `document_id=${annDoc.id}`);
      assert.equal(r.status, 201); assert.equal(r.body.id, annDoc.id); assert.equal(r.body.versions.length, 2);
    });
    await check('unknown type → 400', async () => {
      const r = await upload(ANN, 'type=licence');
      assert.equal(r.status, 400);
    });
    await check('non-PDF bytes → 400', async () => {
      const r = await upload(ANN, 'type=passport', Buffer.from('hello world'));
      assert.equal(r.status, 400); assert.equal(r.body.error, 'Only PDF, JPEG or PNG files are accepted');
    });
    await check('bad expiry_date → 400', async () => {
      assert.equal((await upload(ANN, 'type=passport&expiry_date=31-01-2028')).status, 400);
    });
    await check('PUT sets and clears expiry', async () => {
      const set = await api('PUT', `${S}/${annDoc.id}`, { headers: as(ANN), body: { expiry_date: '2029-02-01' } });
      assert.equal(set.status, 200); assert.equal(set.body.expiry_date, '2029-02-01');
      const clr = await api('PUT', `${S}/${annDoc.id}`, { headers: as(ANN), body: { expiry_date: null } });
      assert.equal(clr.body.expiry_date, null);
      assert.equal((await api('PUT', `${S}/${annDoc.id}`, { headers: as(ANN), body: { expiry_date: 'soon' } })).status, 400);
    });
    await check('file streams for its owner', async () => {
      const r = await fetch(`${base}${S}/versions/${annDoc.versions[0].id}/file`, { headers: as(ANN) });
      assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'private, no-store');
      assert.equal(Buffer.from(await r.arrayBuffer()).toString(), PDF.toString());
    });
    await check("B cannot read, version, PUT or DELETE A's document → 404", async () => {
      assert.equal((await api('GET', `${S}/versions/${annDoc.versions[0].id}/file`, { headers: as(BOB) })).status, 404);
      assert.equal((await upload(BOB, `document_id=${annDoc.id}`)).status, 404);
      assert.equal((await api('PUT', `${S}/${annDoc.id}`, { headers: as(BOB), body: { expiry_date: null } })).status, 404);
      assert.equal((await api('DELETE', `${S}/${annDoc.id}`, { headers: as(BOB) })).status, 404);
      assert.deepEqual((await api('GET', S, { headers: as(BOB) })).body, []);
      assert.equal((await api('GET', `${S}/not-a-uuid/file`, { headers: as(BOB) })).status, 404);
    });
    await check('11th version → 409', async () => {
      const d = (await upload(ANN, 'type=safety')).body;
      for (let i = 0; i < 9; i++) assert.equal((await upload(ANN, `document_id=${d.id}`)).status, 201);
      const r = await upload(ANN, `document_id=${d.id}`);
      assert.equal(r.status, 409); assert.equal(r.body.error, 'At most 10 versions per document');
    });
    await check('delete removes blobs and hides the document; its file → 410', async () => {
      const vid = annDoc.versions[0].id;
      const { rows } = await pool.query('SELECT blob_pathname FROM sailor_document_version WHERE document_id = $1', [annDoc.id]);
      assert.equal((await api('DELETE', `${S}/${annDoc.id}`, { headers: as(ANN) })).status, 204);
      rows.forEach((r) => assert.equal(blobs.has(r.blob_pathname), false));
      assert.equal((await api('GET', S, { headers: as(ANN) })).body.some((d) => d.id === annDoc.id), false);
      assert.equal((await api('GET', `${S}/versions/${vid}/file`, { headers: as(ANN) })).status, 410);
      assert.equal((await upload(ANN, `document_id=${annDoc.id}`)).status, 404, 'no versions on a deleted document');
    });

    // ---- Task 4: guest rail ----
    const key = { 'X-Api-Key': KEY };
    const guestApi = (method, path, o = {}) => api(method, path, { ...o, headers: { ...key, ...(o.headers || {}) } });
    const mk = async (slug, extra = {}) => {
      const m = (await guestApi('POST', '/api/marina/marinas', { body: { name: slug, slug, response_window_hours: 24, ...extra } })).body;
      assert.equal((await guestApi('POST', `/api/marina/marinas/${m.id}/berths`, { body: { label: 'H1', length_m: 15, beam_m: 5, price_per_night: 4, price_mode: 'per_metre' } })).status, 201);
      return m;
    };
    const REQ = await mk(`sd-req-${RUN}`, { sailor_documents: true });
    const FREE = await mk(`sd-free-${RUN}`);
    // Requirements but not opted in: the legacy per-booking flow, untouched.
    const LEGACY = await mk(`sd-legacy-${RUN}`);
    for (const m of [REQ, LEGACY]) {
      await pool.query(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name, mandatory, sort_order) VALUES
        ($1, $2, 'insurance', 'Insurance', true, 0), ($1, $2, 'registration', 'Registration', false, 1)`, [P, m.id]);
    }
    const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    let slot = 0;
    const stay = () => { const a = 40 + 5 * slot++; return { arrival: day(a), departure: day(a + 2) }; };
    const bookingBody = (o = {}) => ({ berth_label: 'H1', ...stay(), contact_name: 'Cat', contact_email: 'typed@example.com', boat_name: 'Wave', boat_length_m: 10, ...o });
    const status = (m, qs, headers = {}) => guestApi('GET', `/api/marina/guest/${m.slug}/requirements-status?${qs}`, { headers });
    const CAT = mail('cat');
    const s0 = stay();
    const qs0 = `arrival=${s0.arrival}&departure=${s0.departure}`;

    await check('status without requirements says no sign-in', async () => {
      const r = await status(FREE, qs0);
      assert.equal(r.status, 200); assert.deepEqual(r.body, { sign_in_required: false, requirements: [] });
    });
    await check('status with requirements and no token says sign-in required', async () => {
      const r = await status(REQ, qs0);
      assert.equal(r.status, 200); assert.equal(r.body.sign_in_required, true);
      assert.deepEqual(r.body.requirements.map((x) => [x.type, x.mandatory, x.met]), [['insurance', true, false], ['registration', false, false]]);
    });
    await check('status reports met/unmet per requirement for the sailor', async () => {
      const d = (await upload(CAT, `type=registration`)).body;
      const r = await status(REQ, qs0, as(CAT));
      assert.equal(r.status, 200); assert.equal(r.body.sign_in_required, true);
      const [ins, reg] = r.body.requirements;
      assert.equal(ins.met, false); assert.equal(ins.document, null);
      assert.equal(reg.met, true); assert.equal(reg.document.id, d.id);
      assert.equal((await status(REQ, 'arrival=nope', as(CAT))).status, 400);
    });
    await check('create without token at a marina with requirements → 401', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${REQ.slug}/bookings`, { body: bookingBody() });
      assert.equal(r.status, 401); assert.equal(r.body.error, 'Sign in required');
    });
    await check('create with mandatory unmet → 409 listing it', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${REQ.slug}/bookings`, { body: bookingBody(), headers: as(CAT) });
      assert.equal(r.status, 409); assert.equal(r.body.error, 'Required documents missing');
      assert.deepEqual(r.body.missing.map((x) => x.type), ['insurance']);
    });
    let catIns;
    await check('create when met → 201, contact_email = token email, email_verified true', async () => {
      catIns = (await upload(CAT, 'type=insurance&expiry_date=2030-01-01')).body;
      const r = await guestApi('POST', `/api/marina/guest/${REQ.slug}/bookings`, { body: bookingBody(), headers: as(CAT) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const row = await one('SELECT contact_email, email_verified FROM marina_booking WHERE id = $1', [r.body.booking.id]);
      assert.deepEqual(row, { contact_email: CAT, email_verified: true });
    });
    await check('document deleted after status check → create 409', async () => {
      const s = stay();
      const before = await status(REQ, `arrival=${s.arrival}&departure=${s.departure}`, as(CAT));
      assert.equal(before.body.requirements[0].met, true);
      assert.equal((await api('DELETE', `${S}/${catIns.id}`, { headers: as(CAT) })).status, 204);
      const r = await guestApi('POST', `/api/marina/guest/${REQ.slug}/bookings`, { body: bookingBody(s), headers: as(CAT) });
      assert.equal(r.status, 409); assert.deepEqual(r.body.missing.map((x) => x.type), ['insurance']);
    });
    await check('marina without requirements books as before (unverified email)', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${FREE.slug}/bookings`, { body: bookingBody() });
      assert.equal(r.status, 201);
      const row = await one('SELECT contact_email, email_verified FROM marina_booking WHERE id = $1', [r.body.booking.id]);
      assert.deepEqual(row, { contact_email: 'typed@example.com', email_verified: false });
    });
    await check('signed-in guest at a marina without requirements gets a verified email', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${FREE.slug}/bookings`, { body: bookingBody(), headers: as(CAT) });
      assert.equal(r.status, 201);
      const row = await one('SELECT contact_email, email_verified FROM marina_booking WHERE id = $1', [r.body.booking.id]);
      assert.deepEqual(row, { contact_email: CAT, email_verified: true });
    });
    await check('requirements without sailor_documents: no sign-in, books without a token', async () => {
      assert.equal(REQ.sailor_documents, true); assert.equal(LEGACY.sailor_documents, false);
      const st = await status(LEGACY, qs0);
      assert.equal(st.body.sign_in_required, false);
      const r = await guestApi('POST', `/api/marina/guest/${LEGACY.slug}/bookings`, { body: bookingBody() });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });
    await check('invalid sailor token on create → 401 even without requirements', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${FREE.slug}/bookings`, { body: bookingBody(), headers: { 'X-Sailor-Token': 'junk' } });
      assert.equal(r.status, 401);
    });

    // (later tasks append here)
  } finally {
    server.close();
    await pool.query("DELETE FROM sailor_document WHERE email LIKE $1", [`%-${RUN}@sd-http.test`]);
    await pool.query('DELETE FROM marina WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM property_token_ledger WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
