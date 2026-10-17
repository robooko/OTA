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
  } finally {
    await pool.query('DELETE FROM organization WHERE clerk_org_id = $1', [ORG]).catch(() => {});
    await pool.end();
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
  }
})();
