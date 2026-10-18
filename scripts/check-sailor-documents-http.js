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
const realExtractSailor = docs.extractSailorVersion;
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
    await check('extracted expiry is saved on the document unless the sailor gave one', async () => {
      const key = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY ||= 'stub';
      docs.extractSailorVersion = realExtractSailor;
      docs.extractFields = async () => ({ expiry_date: '2031-03-15' });
      try {
        const r = await upload(BOB, 'type=passport');
        assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.expiry_date, '2031-03-15');
        const own = await upload(BOB, 'type=insurance&expiry_date=2029-09-09');
        assert.equal(own.body.expiry_date, '2029-09-09');
        await api('DELETE', `${S}/${r.body.id}`, { headers: as(BOB) });
        await api('DELETE', `${S}/${own.body.id}`, { headers: as(BOB) });
      } finally {
        docs.extractSailorVersion = async () => {};
        if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      }
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
      assert.equal(r.status, 200); assert.deepEqual(r.body, { sign_in_required: false, requirements: [], document_uploads: false }); // no org Drive in this fixture
    });
    await check('sailor-document marina takes uploads without an org Drive', async () => {
      const r = await status(REQ, qs0, as(CAT));
      assert.equal(r.status, 200); assert.equal(r.body.document_uploads, true);
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

    // ---- Task 5: staff panel, file, approvals, auto-confirm ----
    const docCtrl = require('../src/controllers/marinaDocuments');
    const life = require('../src/lib/marinaLifecycle');
    // Bearer-only controllers driven directly (see check-marina-http.js).
    const call = async (fn, req) => {
      const res = { statusCode: 200, body: undefined, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
        set(h) { Object.assign(this.headers, h); return this; }, chunks: [], write(c) { this.chunks.push(c); return true; }, end(c) { if (c) this.chunks.push(c); this.ended = true; },
        on() { return this; }, once() { return this; }, emit() { return true; }, removeListener() { return this; } };
      let error;
      await fn({ params: {}, query: {}, body: {}, user: { id: 'staff_1' }, auth_method: 'bearer', ...req }, res, (e) => { error = e; });
      if (error) throw error;
      return res;
    };
    const AUTO = await mk(`sd-auto-${RUN}`, { sailor_documents: true, auto_confirm: true });
    await pool.query(`INSERT INTO marina_doc_requirement (property_id, marina_id, type, name, mandatory) VALUES ($1, $2, 'insurance', 'Insurance', true)`, [P, AUTO.id]);
    const DAN = mail('dan');
    const danIns = (await upload(DAN, 'type=insurance&expiry_date=2030-01-01')).body;
    // Own client IP per booking (10/hour/IP limiter); cancelled unless the
    // check needs it live (3 upcoming per email) -- staff visibility counts
    // any status.
    let ip = 0;
    const book = async (m, email, headers = as(email), { live = false } = {}) => {
      const r = await guestApi('POST', `/api/marina/guest/${m.slug}/bookings`, { body: bookingBody(), headers: { ...headers, 'X-Client-Ip': `203.0.113.${++ip}` } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      if (!live) await pool.query("UPDATE marina_booking SET status = 'cancelled' WHERE id = $1", [r.body.booking.id]);
      return r.body.booking.id;
    };
    const panel = (id) => call(docCtrl.getBookingVerification, { params: { id }, property_id: P });
    const decide = (id, versionId, body, property_id = P) => call(docCtrl.decideSailorVersion, { params: { id, versionId }, body, property_id });
    const waitStatus = async (id, want) => {
      for (let i = 0; i < 40; i++) {
        if ((await one('SELECT status FROM marina_booking WHERE id = $1', [id])).status === want) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail(`booking never reached ${want}`);
    };

    await check('panel has sailor block only for verified bookings', async () => {
      const verified = await book(REQ, DAN);
      const p = (await panel(verified)).body;
      assert.equal(p.sailor.email, DAN);
      const ins = p.sailor.requirements.find((x) => x.document?.type === 'insurance');
      assert.equal(ins.document.id, danIns.id); assert.equal(ins.document.versions[0].my_verdict, null);
      const legacy = await book(LEGACY, DAN, {});
      assert.equal((await panel(legacy)).body.sailor, null);
    });
    await check('staff approve records verdict on the version and shows as my_verdict; re-deciding overwrites', async () => {
      const id = await book(REQ, DAN);
      const vid = danIns.versions[0].id;
      const r = await decide(id, vid, { status: 'rejected', notes: 'blurry' });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      await decide(id, vid, { status: 'approved' });
      const rows = (await pool.query('SELECT status, notes, staff_user FROM sailor_document_approval WHERE version_id = $1 AND marina_id = $2', [vid, REQ.id])).rows;
      assert.deepEqual(rows, [{ status: 'approved', notes: null, staff_user: 'staff_1' }]);
      const v = (await panel(id)).body.sailor.requirements.find((x) => x.document?.type === 'insurance').document.versions[0];
      assert.equal(v.my_verdict.status, 'approved');
      assert.equal((await decide(id, vid, { status: 'maybe' })).statusCode, 400);
    });
    await check("approval of another email's version → 404", async () => {
      const id = await book(REQ, DAN);
      const eve = (await upload(mail('eve'), 'type=insurance&expiry_date=2030-01-01')).body;
      assert.equal((await decide(id, eve.versions[0].id, { status: 'approved' })).statusCode, 404);
    });
    await check('approval on an unverified booking → 409', async () => {
      const id = await book(LEGACY, DAN, {});
      assert.equal((await decide(id, danIns.versions[0].id, { status: 'approved' })).statusCode, 409);
    });
    await check('staff can correct expiry while approving', async () => {
      const id = await book(REQ, DAN);
      await decide(id, danIns.versions[0].id, { status: 'approved', expiry_date: '2031-03-01' });
      assert.equal((await one('SELECT expiry_date FROM sailor_document WHERE id = $1', [danIns.id])).expiry_date, '2031-03-01');
    });
    await check('staff file: streams with a verified booking at the property; 404 without one', async () => {
      const vid = danIns.versions[0].id;
      const ok = await call(docCtrl.streamSailorVersion, { params: { id: vid }, property_id: P });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ok.statusCode, 200); assert.equal(ok.headers['Cache-Control'], 'private, no-store');
      const P2 = (await one(`INSERT INTO property (name, timezone, currency) VALUES ('Sailor Docs Other', 'Europe/Rome', 'eur') RETURNING id`)).id;
      try {
        assert.equal((await call(docCtrl.streamSailorVersion, { params: { id: vid }, property_id: P2 })).statusCode, 404);
      } finally { await pool.query('DELETE FROM property WHERE id = $1', [P2]); }
      const fay = (await upload(mail('fay'), 'type=insurance&expiry_date=2030-01-01')).body;
      assert.equal((await call(docCtrl.streamSailorVersion, { params: { id: fay.versions[0].id }, property_id: P })).statusCode, 404);
    });
    await check("another marina's approval does not satisfy auto-confirm", async () => {
      const gus = mail('gus');
      const g = (await upload(gus, 'type=insurance&expiry_date=2030-01-01')).body;
      const id = await book(AUTO, gus, as(gus), { live: true });
      await pool.query("UPDATE marina_booking SET status = 'pending' WHERE id = $1", [id]);
      await pool.query("INSERT INTO sailor_document_approval (version_id, marina_id, property_id, status) VALUES ($1, $2, $3, 'approved')", [g.versions[0].id, REQ.id, P]);
      assert.equal(await life.maybeAutoConfirm(id), null);
    });
    await check('auto-confirm fires once every mandatory requirement has this marina’s approval', async () => {
      const hal = mail('hal');
      const h = (await upload(hal, 'type=insurance&expiry_date=2030-01-01')).body;
      const id = await book(AUTO, hal, as(hal), { live: true });
      await pool.query("UPDATE marina_booking SET status = 'pending' WHERE id = $1", [id]);
      assert.equal(await life.maybeAutoConfirm(id), null);
      await decide(id, h.versions[0].id, { status: 'approved' });
      await waitStatus(id, 'confirmed');
    });

    // ---- Task 6: requirement types ----
    await check('requirement with unknown type → 400; known type → 201', async () => {
      const r = await guestApi('POST', `/api/marina/marinas/${FREE.id}/doc-requirements`, { body: { type: 'licence', name: 'Licence' } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'type must be one of insurance, acord25, registration, uscg_cod, passport, safety');
      const ok = await guestApi('POST', `/api/marina/marinas/${FREE.id}/doc-requirements`, { body: { type: 'passport', name: 'Passport', status: 'inactive' } });
      assert.equal(ok.status, 201);
      assert.equal((await guestApi('PUT', `/api/marina/marinas/${FREE.id}/doc-requirements/${ok.body.id}`, { body: { type: 'visa' } })).status, 400);
    });

    // ---- Final review fixes ----
    await check('C1: editing a verified booking email clears email_verified; the new email sees nothing', async () => {
      const id = await book(REQ, DAN);
      const vic = mail('vic');
      const v = (await upload(vic, 'type=passport&expiry_date=2030-01-01')).body;
      const r = await guestApi('PUT', `/api/marina/bookings/${id}`, { body: { contact_email: vic } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await one('SELECT email_verified FROM marina_booking WHERE id = $1', [id])).email_verified, false);
      assert.equal((await panel(id)).body.sailor, null);
      assert.equal((await call(docCtrl.streamSailorVersion, { params: { id: v.versions[0].id }, property_id: P })).statusCode, 404);
    });
    await check('C1: same email in another case keeps email_verified', async () => {
      const id = await book(REQ, DAN);
      await guestApi('PUT', `/api/marina/bookings/${id}`, { body: { contact_email: DAN.toUpperCase() } });
      assert.equal((await one('SELECT email_verified FROM marina_booking WHERE id = $1', [id])).email_verified, true);
    });
    await check('I1: a rejection of the newest version beats an approval of an older one', async () => {
      const ivy = mail('ivy');
      const d = (await upload(ivy, 'type=insurance&expiry_date=2030-01-01')).body;
      const id = await book(AUTO, ivy, as(ivy), { live: true }); // hold: auto-confirm can't fire yet
      await decide(id, d.versions[0].id, { status: 'approved' });
      const v2 = (await upload(ivy, `document_id=${d.id}`)).body.versions[0];
      await decide(id, v2.id, { status: 'rejected' });
      await pool.query("UPDATE marina_booking SET status = 'pending' WHERE id = $1", [id]);
      assert.equal(await life.maybeAutoConfirm(id), null);
      await decide(id, v2.id, { status: 'approved' });
      await waitStatus(id, 'confirmed');
    });
    await check('I2: the sailor changing the expiry after approval voids that approval', async () => {
      const jay = mail('jay');
      const d = (await upload(jay, 'type=insurance&expiry_date=2030-01-01')).body;
      const id = await book(AUTO, jay, as(jay), { live: true });
      await decide(id, d.versions[0].id, { status: 'approved' });
      assert.equal((await api('PUT', `${S}/${d.id}`, { headers: as(jay), body: { expiry_date: '2031-01-01' } })).status, 200);
      await pool.query("UPDATE marina_booking SET status = 'pending' WHERE id = $1", [id]);
      assert.equal(await life.maybeAutoConfirm(id), null);
    });
    await check('I3: staff readiness counts this marina’s approval of the newest version', async () => {
      const q = require('../src/lib/marinaQueries');
      const kim = mail('kim');
      const d = (await upload(kim, 'type=insurance&expiry_date=2030-01-01')).body;
      const id = await book(REQ, kim, as(kim), { live: true });
      assert.equal((await q.joinedBooking(pool, id)).docs_required_verified, 0);
      await decide(id, d.versions[0].id, { status: 'approved' });
      const b = await q.joinedBooking(pool, id);
      assert.equal(b.docs_required, 1); assert.equal(b.docs_required_verified, 1);
    });
    await check('I4: an invalid sailor token where sailor documents are off books anonymously', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${FREE.slug}/bookings`, { body: bookingBody({ contact_email: 'anon@example.com' }), headers: { 'X-Sailor-Token': 'junk', 'X-Client-Ip': '203.0.113.250' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await one('SELECT email_verified FROM marina_booking WHERE id = $1', [r.body.booking.id])).email_verified, false);
    });
    await check('I4: an invalid sailor token where sailor documents are on → 401', async () => {
      const r = await guestApi('POST', `/api/marina/guest/${REQ.slug}/bookings`, { body: bookingBody(), headers: { 'X-Sailor-Token': 'junk', 'X-Client-Ip': '203.0.113.251' } });
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
