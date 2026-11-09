// Long-term berth holders: term long, notice period from the contract,
// checkout (action end) frees the berth for resale, return (action return)
// opens a linked booking with the same contract. Real app on an ephemeral
// port; fixtures under a throwaway property, deleted at the end. Local DB only.
//   node -r dotenv/config scripts/check-marina-long-term.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');
const app = require('../src/app');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const KEY = `check_${crypto.randomBytes(8).toString('hex')}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const ORG = `org_mlt_${crypto.randomBytes(6).toString('hex')}`;
  await pool.query('INSERT INTO organization (clerk_org_id) VALUES ($1)', [ORG]);
  const P = (await one(`INSERT INTO property (name, timezone, currency, clerk_org_id) VALUES ('Marina Long-Term Check', 'Europe/Rome', 'eur', $1) RETURNING id`, [ORG])).id;
  await apiKeys.create(pool, { property_id: P }, { key: KEY });
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'X-Api-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  try {
    const m = (await api('POST', '/api/marina/marinas', { name: 'Porto Long', slug: `porto-long-${crypto.randomBytes(3).toString('hex')}` })).body;
    const berth = (await api('POST', `/api/marina/marinas/${m.id}/berths`, { label: 'L1', length_m: 15, beam_m: 5, price_per_night: 4, price_mode: 'per_metre' })).body;
    await api('POST', `/api/marina/marinas/${m.id}/contract-templates`, { name: 'Visitor', body_markdown: 'Visitor terms', min_nights: 0 });
    const tpl = await api('POST', `/api/marina/marinas/${m.id}/contract-templates`, {
      name: 'Annual', min_nights: 180, return_notice_days: 14,
      body_markdown: 'Give {{return_notice_days}} days notice before returning. Until {{contract_until}}.' });
    const B = '/api/marina/bookings';
    const holder = { berth_id: berth.id, contact_name: 'Hal', contact_email: 'hal@example.com', boat_name: 'Stay', boat_length_m: 10, arrival: '2030-01-01' };
    let lt;

    await check('template stores return_notice_days', async () => {
      assert.equal(tpl.status, 201); assert.equal(tpl.body.return_notice_days, 14);
      assert.equal(tpl.body.warnings, undefined, 'new merge fields are known');
    });
    await check('long-term rejects a departure; short rejects long-term fields', async () => {
      assert.equal((await api('POST', B, { ...holder, term: 'long', departure: '2030-02-01' })).status, 400);
      assert.equal((await api('POST', B, { ...holder, departure: '2030-02-01', contract_until: '2031-01-01' })).status, 400);
      assert.equal((await api('POST', B, { ...holder, term: 'medium' })).status, 400);
    });
    await check('long-term booking: open-ended, notice snapshotted from the longest template', async () => {
      const r = await api('POST', B, { ...holder, term: 'long', contract_until: '2030-12-31' });
      assert.equal(r.status, 201, JSON.stringify(r.body)); lt = r.body;
      assert.equal(lt.term, 'long'); assert.equal(lt.departure, null); assert.equal(lt.return_notice_days, 14);
      await api('PUT', `/api/marina/marinas/${m.id}/contract-templates/${tpl.body.id}`, { return_notice_days: 30 });
      assert.equal((await api('GET', `${B}/${lt.id}`)).body.return_notice_days, 14, 'template edits do not change the booking');
    });
    await check('templateFor picks the longest template for long-term; merge fields render', async () => {
      const c = require('../src/lib/marinaContracts');
      const t = c.templateFor([{ min_nights: 0 }, { min_nights: 180 }], { term: 'long' });
      assert.equal(t.min_nights, 180);
      assert.equal(c.templateFor([{ min_nights: 0 }], { term: 'short', arrival: '2030-01-01', departure: null }), null);
      assert.equal(c.renderContract('{{return_notice_days}}/{{contract_until}}', c.contractContext({ ...lt, return_notice_days: 14, contract_until: '2030-12-31' })), '14/2030-12-31');
    });
    await check('staff edit contract_until and return_notice_days; a negative notice is refused', async () => {
      const r = await api('PUT', `${B}/${lt.id}`, { contract_until: '2031-06-30', return_notice_days: 21 });
      assert.equal(r.status, 200); assert.equal(r.body.return_notice_days, 21);
      assert.equal((await api('PUT', `${B}/${lt.id}`, { return_notice_days: -1 })).status, 400);
    });
    await check('return before checkout → 409', async () => {
      assert.equal((await api('PUT', `${B}/${lt.id}`, { action: 'return', arrival: '2030-03-01' })).status, 409);
    });
    let visitor;
    await check('checkout frees the berth: a visitor books the gap', async () => {
      assert.equal((await api('POST', B, { ...holder, contact_name: 'Vic', arrival: '2030-03-01', departure: '2030-03-05' })).status, 409, 'held before checkout');
      const co = await api('PUT', `${B}/${lt.id}`, { action: 'end', departure: '2030-03-01' });
      assert.equal(co.status, 200); assert.equal(co.body.departure, '2030-03-01');
      const v = await api('POST', B, { ...holder, contact_name: 'Vic', arrival: '2030-03-01', departure: '2030-03-05' });
      assert.equal(v.status, 201); visitor = v.body;
    });
    await check('return clashing with the resold stay → 409; earlier than checkout → 400', async () => {
      assert.equal((await api('PUT', `${B}/${lt.id}`, { action: 'return', arrival: '2030-03-03' })).status, 409);
      assert.equal((await api('PUT', `${B}/${lt.id}`, { action: 'return', arrival: '2030-02-01' })).status, 400);
    });
    await check('return after the resold stay: new linked open-ended booking with the contract copied', async () => {
      await pool.query(`INSERT INTO marina_contract_signature (property_id, booking_id, template_id, rendered_body, signer_email)
        VALUES ($1, $2, $3, 'signed text', 'hal@example.com')`, [P, lt.id, tpl.body.id]);
      const r = await api('PUT', `${B}/${lt.id}`, { action: 'return', arrival: visitor.departure });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.previous_booking_id, lt.id); assert.equal(r.body.term, 'long'); assert.equal(r.body.departure, null);
      assert.equal(r.body.status, 'confirmed'); assert.equal(r.body.return_notice_days, 21); assert.equal(r.body.contract_until, '2031-06-30');
      const g = await api('GET', `${B}/${r.body.id}`);
      assert.equal(g.body.signature.rendered_body, 'signed text');
      assert.equal((await api('PUT', `${B}/${lt.id}`, { action: 'return', arrival: '2031-01-01' })).status, 409, 'only one return');
    });
    await check('return on a short-term booking → 409', async () => {
      assert.equal((await api('PUT', `${B}/${visitor.id}`, { action: 'return', arrival: '2030-04-01' })).status, 409);
    });
  } finally {
    server.close();
    await pool.query('DELETE FROM marina WHERE property_id = $1', [P]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
