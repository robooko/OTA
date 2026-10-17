// Org integrations: encrypted tokens, signed state, locked refresh, routes
// and the Google Drive client. All HTTP to Google is faked through
// integrations.fetch. Local DB only; the throwaway org is deleted at the end.
//   node -r dotenv/config scripts/check-integrations.js
process.env.INTEGRATIONS_ENCRYPTION_KEY ||= require('crypto').randomBytes(32).toString('base64');
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const integ = require('../src/lib/integrations');
const pool = require('../src/db');

// Fake Google: a queue of responses per call, every request recorded.
let calls = [];
let replies = [];
integ.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  const r = replies.shift();
  if (!r) throw new Error(`unexpected fetch ${url}`);
  if (r instanceof Error) throw r;
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
};
const reply = (...rs) => { calls = []; replies = rs; };

const ORG = `org_check_${crypto.randomBytes(6).toString('hex')}`;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
};

async function seedIntegration(fields = {}) {
  await pool.query('INSERT INTO organization (clerk_org_id) VALUES ($1) ON CONFLICT DO NOTHING', [ORG]);
  await pool.query('DELETE FROM org_integration WHERE clerk_org_id = $1', [ORG]);
  await pool.query(
    `INSERT INTO org_integration (clerk_org_id, provider, account_email, refresh_token, access_token, access_token_expires_at, reconnect_required)
     VALUES ($1, 'google_drive', 'ops@example.com', $2, $3, $4, $5)`,
    [ORG, integ.encrypt(fields.refresh ?? 'refresh-1'), integ.encrypt(fields.access ?? 'old'), fields.expires ?? new Date(Date.now() - 1000), fields.reconnect ?? false]);
}

(async () => {
  try {
    // ---- Task 2 ----
    await check('encrypt/decrypt round-trip; random IV; tamper throws', async () => {
      const a = integ.encrypt('tok');
      assert.equal(integ.decrypt(a), 'tok');
      assert.notEqual(integ.encrypt('tok'), a);
      const parts = a.split(':');
      const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 1; parts[3] = ct.toString('base64');
      assert.throws(() => integ.decrypt(parts.join(':')));
    });
    await check('signed state: valid, tampered, stale, garbage', async () => {
      const s = integ.signState('org_a', 'google_drive');
      assert.deepEqual(integ.verifyState(s), { orgId: 'org_a', provider: 'google_drive' });
      assert.equal(integ.verifyState(s.slice(0, -1) + (s.endsWith('0') ? '1' : '0')), null);
      const [o, p, , sig] = s.split('.');
      assert.equal(integ.verifyState(`${o}.${p}.${Date.now() - 2 * 3600000}.${sig}`), null);
      const old = integ.signState('org_a', 'google_drive', Date.now() - 2 * 3600000);
      assert.equal(integ.verifyState(old), null);
      assert.equal(integ.verifyState(undefined), null);
      assert.equal(integ.verifyState('a.b'), null);
    });
    await check('missingEnv lists exactly the unset vars', async () => {
      const saved = { ...process.env };
      process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'y'; delete process.env.GOOGLE_REDIRECT_URI;
      assert.deepEqual(integ.missingEnv('google_drive'), ['GOOGLE_REDIRECT_URI']);
      process.env.GOOGLE_REDIRECT_URI = 'z';
      assert.deepEqual(integ.missingEnv('google_drive'), []);
      Object.assign(process.env, saved);
      for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) if (!(k in saved)) delete process.env[k];
    });
    await check('refresh without refresh_token keeps the stored one', async () => {
      await seedIntegration();
      reply({ body: { access_token: 'new', expires_in: 3600 } });
      assert.equal(await integ.getAccessToken(ORG, 'google_drive'), 'new');
      assert.equal(calls.length, 1); assert.match(calls[0].url, /oauth2\.googleapis\.com\/token/);
      const row = await one('SELECT refresh_token, access_token FROM org_integration WHERE clerk_org_id = $1', [ORG]);
      assert.equal(integ.decrypt(row.refresh_token), 'refresh-1');
      assert.notEqual(row.access_token, 'new'); assert.equal(integ.decrypt(row.access_token), 'new');
      reply(); // still valid: no fetch
      assert.equal(await integ.getAccessToken(ORG, 'google_drive'), 'new');
    });
    await check('invalid_grant marks reconnect_required; later calls skip Google', async () => {
      await seedIntegration();
      reply({ status: 400, body: { error: 'invalid_grant' } });
      await assert.rejects(integ.getAccessToken(ORG, 'google_drive'), (e) => e.code === 'invalid_grant' && e.status === 409);
      assert.equal((await one('SELECT reconnect_required FROM org_integration WHERE clerk_org_id = $1', [ORG])).reconnect_required, true);
      reply();
      await assert.rejects(integ.getAccessToken(ORG, 'google_drive'), (e) => e.code === 'reconnect');
    });
    await check('not connected → 409 not_connected', async () => {
      await pool.query('DELETE FROM org_integration WHERE clerk_org_id = $1', [ORG]);
      await assert.rejects(integ.getAccessToken(ORG, 'google_drive'), (e) => e.code === 'not_connected' && e.status === 409);
    });

    // ---- Task 3 ----
    const ctrl = require('../src/controllers/integrations');
    const call = async (fn, req) => {
      const res = {
        statusCode: 200, body: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        send(b) { this.body = b; return this; },
      };
      let error;
      await fn({ params: { provider: 'google_drive' }, query: {}, body: {}, clerk_org_id: ORG, ...req }, res, (e) => { error = e; });
      if (error) throw error;
      return res;
    };
    process.env.GOOGLE_CLIENT_ID = 'cid'; process.env.GOOGLE_CLIENT_SECRET = 'csecret'; process.env.GOOGLE_REDIRECT_URI = 'http://localhost/cb';

    await check('unknown provider → 404 through the app', async () => {
      const server = require('../src/app').listen(0);
      try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/nope/callback`);
        assert.equal(r.status, 404); assert.equal((await r.json()).error, 'Unknown integration');
      } finally { server.close(); }
    });
    await check('connect: 503 naming a missing env var; otherwise a Google URL with drive.file + offline', async () => {
      delete process.env.GOOGLE_REDIRECT_URI;
      const r = await call(ctrl.getConnectUrl, {});
      assert.equal(r.statusCode, 503); assert.equal(r.body.error, 'Google Drive is not configured on this server'); assert.match(r.body.details, /GOOGLE_REDIRECT_URI/);
      process.env.GOOGLE_REDIRECT_URI = 'http://localhost/cb';
      const ok = await call(ctrl.getConnectUrl, {});
      const u = new URL(ok.body.url);
      assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
      assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('prompt'), 'consent');
      assert.deepEqual(integ.verifyState(u.searchParams.get('state')), { orgId: ORG, provider: 'google_drive' });
    });
    await check('callback: forged state or other-provider path → 400', async () => {
      reply();
      assert.equal((await call(ctrl.connectCallback, { query: { code: 'c', state: 'x.google_drive.1.y' } })).statusCode, 400);
      integ.PROVIDERS.other = { ...integ.PROVIDERS.google_drive, label: 'Other' }; // a second provider, as later ones will be
      try {
        assert.equal((await call(ctrl.connectCallback, { params: { provider: 'other' }, query: { code: 'c', state: integ.signState(ORG, 'google_drive') } })).statusCode, 400);
      } finally { delete integ.PROVIDERS.other; }
      assert.equal(calls.length, 0);
    });
    await check('callback: stores encrypted tokens + account email, resets settings', async () => {
      await pool.query('DELETE FROM org_integration WHERE clerk_org_id = $1', [ORG]);
      await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]); // the callback creates it
      reply({ body: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } }, { body: { user: { emailAddress: 'marina@example.com' } } });
      const r = await call(ctrl.connectCallback, { query: { code: 'c', state: integ.signState(ORG, 'google_drive') } });
      assert.equal(r.statusCode, 200); assert.match(r.body, /Google Drive connected/);
      assert.match(calls[1].url, /drive\/v3\/about/); assert.equal(calls[1].opts.headers.Authorization, 'Bearer acc');
      const row = await one('SELECT * FROM org_integration WHERE clerk_org_id = $1', [ORG]);
      assert.notEqual(row.access_token, 'acc'); assert.equal(integ.decrypt(row.access_token), 'acc'); assert.equal(integ.decrypt(row.refresh_token), 'ref');
      assert.equal(row.account_email, 'marina@example.com'); assert.deepEqual(row.settings, {}); assert.equal(row.reconnect_required, false);
    });
    await check('status: connected, no token fields', async () => {
      const r = await call(ctrl.getStatus, {});
      assert.equal(r.body.connected, true); assert.equal(r.body.configured, true); assert.equal(r.body.account_email, 'marina@example.com');
      assert.equal(r.body.reconnect_required, false);
      assert.ok(!/token/i.test(JSON.stringify(r.body)));
    });
    await check('disconnect: revokes, deletes row; a failing revoke still disconnects', async () => {
      reply({ body: {} });
      const r = await call(ctrl.disconnect, {});
      assert.deepEqual(r.body, { connected: false }); assert.match(calls[0].url, /oauth2\.googleapis\.com\/revoke\?token=ref/);
      assert.equal(await one('SELECT 1 FROM org_integration WHERE clerk_org_id = $1', [ORG]), undefined);
      await seedIntegration();
      reply(new Error('network down'));
      assert.deepEqual((await call(ctrl.disconnect, {})).body, { connected: false });
      assert.equal(await one('SELECT 1 FROM org_integration WHERE clerk_org_id = $1', [ORG]), undefined);
      assert.equal((await call(ctrl.getStatus, {})).body.connected, false);
    });

    // ---- Task 4 ----
    const drive = require('../src/lib/googleDrive');
    const live = () => seedIntegration({ access: 'live', expires: new Date(Date.now() + 3600000) });
    const folder = (id) => ({ body: { id } });
    const file = (id) => ({ body: { id, webViewLink: `https://drive.google.com/file/d/${id}/view` } });
    const doc = (booking = '2026-11-02 Ann Smith (1a2b3c4d)') => ({ path: ['OTA', 'Seaview', 'Porto', booking], fileName: 'passport.pdf', contentType: 'application/pdf', buf: Buffer.from('%PDF-1.4 x') });
    const folderCreates = () => calls.filter((c) => /drive\/v3\/files\?/.test(c.url) && !/upload/.test(c.url) && c.opts.method === 'POST');

    await check('first upload creates the folder chain, then uploads into the last folder', async () => {
      await live();
      reply(folder('f1'), folder('f2'), folder('f3'), folder('f4'), file('d1'));
      const r = await drive.uploadMarinaDocument(ORG, doc());
      assert.deepEqual(r, { id: 'd1', webViewLink: 'https://drive.google.com/file/d/d1/view' });
      const made = folderCreates().map((c) => JSON.parse(c.opts.body));
      assert.deepEqual(made.map((m) => m.name), ['OTA', 'Seaview', 'Porto', '2026-11-02 Ann Smith (1a2b3c4d)']);
      assert.equal(made[0].parents, undefined);
      assert.deepEqual(made.slice(1).map((m) => m.parents), [['f1'], ['f2'], ['f3']]);
      assert.ok(made.every((m) => m.mimeType === 'application/vnd.google-apps.folder'));
      const up = calls[4];
      assert.match(up.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
      assert.equal(up.opts.headers.Authorization, 'Bearer live');
      const body = Buffer.from(up.opts.body).toString('latin1');
      assert.match(body, /"parents":\["f4"\]/); assert.match(body, /"name":"passport.pdf"/); assert.match(body, /%PDF-1.4 x/);
    });
    await check('same path reuses cached folders; a sibling booking creates one', async () => {
      reply(file('d2'));
      await drive.uploadMarinaDocument(ORG, doc());
      assert.equal(folderCreates().length, 0);
      reply(folder('f5'), file('d3'));
      await drive.uploadMarinaDocument(ORG, doc('2026-12-01 Bob (99999999)'));
      assert.deepEqual(folderCreates().map((c) => JSON.parse(c.opts.body).parents), [['f3']]);
    });
    await check('deleted booking folder in Drive: recreated once, upload succeeds', async () => {
      // upload 404 → probe OTA ok, Seaview ok, Porto ok, booking folder 404 → recreate → upload
      reply({ status: 404, body: {} }, { body: { id: 'f1', trashed: false } }, { body: { id: 'f2', trashed: false } }, { body: { id: 'f3', trashed: false } }, { status: 404, body: {} }, folder('f6'), file('d4'));
      const r = await drive.uploadMarinaDocument(ORG, doc());
      assert.equal(r.id, 'd4');
      assert.deepEqual(folderCreates().map((c) => JSON.parse(c.opts.body).parents), [['f3']]);
      const { settings } = await one('SELECT settings FROM org_integration WHERE clerk_org_id = $1', [ORG]);
      assert.equal(settings.folders['OTA/Seaview/Porto/2026-11-02 Ann Smith (1a2b3c4d)'], 'f6');
      assert.equal(settings.folders['OTA/Seaview/Porto/2026-12-01 Bob (99999999)'], 'f5');
    });
    await check('trashed parent folder: it and everything under it are recreated', async () => {
      reply({ status: 404, body: {} }, { body: { id: 'f1', trashed: false } }, { body: { id: 'f2', trashed: true } }, folder('f7'), folder('f8'), folder('f9'), file('d5'));
      await drive.uploadMarinaDocument(ORG, doc());
      assert.deepEqual(folderCreates().map((c) => JSON.parse(c.opts.body).parents), [['f1'], ['f7'], ['f8']]);
      const { settings } = await one('SELECT settings FROM org_integration WHERE clerk_org_id = $1', [ORG]);
      assert.equal(settings.folders['OTA/Seaview/Porto/2026-12-01 Bob (99999999)'], undefined);
    });
    await check('upload 500 → 502 IntegrationError, Google Drive named', async () => {
      reply({ status: 500, body: { error: { message: 'boom' } } });
      await assert.rejects(drive.uploadMarinaDocument(ORG, doc()), (e) => e.status === 502 && e.message === 'Google Drive upload failed');
    });
    await check('folder names drop slashes and control chars', async () => {
      assert.equal(drive.folderName('A/B\n'), 'AB');
      assert.equal(drive.folderName('  x  '), 'x');
      assert.equal(drive.folderName('y'.repeat(150)).length, 100);
      assert.equal(drive.folderName('/'), 'Untitled');
    });
  } catch (err) {
    failed++; console.log(`FAIL setup\n     ${err.stack}`);
  } finally {
    await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]).catch(() => {});
    await pool.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
