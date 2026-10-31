// Checks the BUXS wallet (src/lib/tokens.js) and, from Task 4, the
// /api/buxs service routes against the local DB. tokens.js uses the shared
// pool, so fixtures are committed under throwaway owners ('org_check…',
// a fresh org-less property) and deleted at the end, pass or fail.
// Never point this at the live DB.
//   node -r dotenv/config scripts/check-buxs.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

process.env.BUXS_SERVICE_SECRET = 'check-service-secret';
const pool = require('../src/db');
const tokens = require('../src/lib/tokens');
const { parsePurchase, buxsFromMetadata } = require('../src/lib/platformStripe');
const { planOrgMoves, planUserMoves } = require('../src/lib/clerkBuxsMove');
const billing = require('../src/controllers/billing');
const { reconcileAfterMigration } = require('../src/lib/buxsReconcile');
const app = require('../src/app');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const hex = () => crypto.randomBytes(6).toString('hex');
  const owners = [];
  const properties = [];
  const newOrg = () => { const o = `org_check${hex()}`; owners.push(o); return o; };
  const newProperty = async (orgId = null) => {
    const { rows: [p] } = await pool.query(
      `INSERT INTO property (name, clerk_org_id) VALUES ('BUXS Check', $1) RETURNING id`, [orgId]);
    properties.push(p.id);
    if (!orgId) owners.push(`property:${p.id}`);
    return p.id;
  };
  const ledgerRows = async (owner) => (await pool.query('SELECT * FROM buxs_ledger WHERE owner = $1', [owner])).rows;

  try {
    await check('creditTo creates the wallet and writes a matching ledger row', async () => {
      const o = newOrg();
      const r = await tokens.creditTo(o, 1000, 'purchase', { idemKey: `check-${hex()}`, source: 'forge' });
      assert.deepEqual(r, { credited: true, balance: 1000 });
      assert.equal(await tokens.getWalletBalance(o), 1000);
      const [row] = await ledgerRows(o);
      assert.equal(Number(row.delta), 1000);
      assert.equal(Number(row.balance_after), 1000);
      assert.equal(row.source, 'forge');
    });

    await check('the same idem_key credits once', async () => {
      const o = newOrg();
      const key = `check-${hex()}`;
      await tokens.creditTo(o, 500, 'purchase', { idemKey: key });
      const again = await tokens.creditTo(o, 500, 'purchase', { idemKey: key });
      assert.deepEqual(again, { credited: false, balance: 500 });
      assert.equal((await ledgerRows(o)).length, 1);
    });

    await check('a migrated Stripe id is refused like any other repeat', async () => {
      const { rows } = await pool.query("SELECT idem_key FROM buxs_ledger WHERE idem_key ~ '^(cs|pi)_' LIMIT 1");
      if (!rows.length) return console.log('     (no migrated purchases locally; skipped)');
      const o = newOrg();
      const r = await tokens.creditTo(o, 100, 'purchase', { idemKey: rows[0].idem_key });
      assert.equal(r.credited, false);
    });

    await check('a short balance refuses the spend and changes nothing', async () => {
      const o = newOrg();
      await tokens.creditTo(o, 100, 'purchase', { idemKey: `check-${hex()}` });
      const r = await tokens.spendFrom(o, 101, 'forge_build', { source: 'forge-app' });
      assert.deepEqual(r, { ok: false, cost: 101, spent: 0, balance: 100 });
      assert.equal(await tokens.getWalletBalance(o), 100);
      assert.equal((await ledgerRows(o)).length, 1);
    });

    await check('a spend from an owner with no wallet returns ok:false', async () => {
      const o = newOrg();
      const r = await tokens.spendFrom(o, 1, 'forge_build');
      assert.deepEqual(r, { ok: false, cost: 1, spent: 0, balance: 0 });
    });

    await check('20 concurrent spends of 10 against 100: exactly 10 succeed, never negative', async () => {
      const o = newOrg();
      await tokens.creditTo(o, 100, 'purchase', { idemKey: `check-${hex()}` });
      const results = await Promise.all(Array.from({ length: 20 }, () => tokens.spendFrom(o, 10, 'forge_build')));
      assert.equal(results.filter((r) => r.ok).length, 10);
      assert.equal(await tokens.getWalletBalance(o), 0);
      const sum = (await ledgerRows(o)).reduce((s, r) => s + Number(r.delta), 0);
      assert.equal(sum, 0);
    });

    await check('partial drains a short balance to zero', async () => {
      const o = newOrg();
      await tokens.creditTo(o, 300, 'purchase', { idemKey: `check-${hex()}` });
      const r = await tokens.spendFrom(o, 1000, 'forge_build', { partial: true, source: 'forge-app', refId: 'build-1' });
      assert.deepEqual(r, { ok: true, cost: 1000, spent: 300, balance: 0 });
      const spendRow = (await ledgerRows(o)).find((x) => x.reason === 'forge_build');
      assert.equal(Number(spendRow.delta), -300);
      assert.equal(spendRow.ref_id, 'build-1');
    });

    await check('partial against an empty wallet spends nothing and writes no row', async () => {
      const o = newOrg();
      const r = await tokens.spendFrom(o, 50, 'forge_build', { partial: true });
      assert.deepEqual(r, { ok: true, cost: 50, spent: 0, balance: 0 });
      assert.equal((await ledgerRows(o)).length, 0);
    });

    await check('two properties in one org share one wallet and one starter grant', async () => {
      const o = newOrg();
      const p1 = await newProperty(o);
      const p2 = await newProperty(o);
      await tokens.grantStarter(p1);
      await tokens.grantStarter(p2);
      assert.equal(await tokens.getBalance(p1), tokens.STARTER_BALANCE);
      assert.equal(await tokens.getBalance(p2), tokens.STARTER_BALANCE);
      const r = await tokens.spend(p2, 'ai_reply', 'inq-1');
      assert.equal(r.ok, true);
      assert.equal(await tokens.getBalance(p1), tokens.STARTER_BALANCE - tokens.TOKEN_COSTS.ai_reply);
    });

    await check('an org-less property owns its own wallet', async () => {
      const p = await newProperty(null);
      assert.equal(await tokens.ownerOfProperty(p), `property:${p}`);
      await tokens.grantStarter(p);
      assert.equal(await tokens.getWalletBalance(`property:${p}`), tokens.STARTER_BALANCE);
      const rows = await tokens.listLedger(p, 10);
      assert.equal(rows[0].reason, 'starter');
      assert.equal(typeof rows[0].delta, 'number');
      assert.equal(rows[0].property_id, p);
      assert.equal(rows[0].property_name, 'BUXS Check');
    });

    await check('HOTAL costs are in BUXS', async () => {
      assert.deepEqual(tokens.TOKEN_COSTS, { ai_reply: 2500, reply_send: 2500, voice_call: 5000, sms_conversation: 2500 });
    });

    await check('amounts must be integers from 1 to 50,000,000', async () => {
      for (const bad of [0, -1, 1.5, 50_000_001, '10', null]) {
        assert.throws(() => tokens.checkAmount(bad), (e) => e.status === 400, String(bad));
      }
      tokens.checkAmount(1);
      tokens.checkAmount(50_000_000);
    });

    await check('parsePurchase takes £10–£1000 in £10 steps at 25,000 BUXS per pound', async () => {
      assert.deepEqual(parsePurchase({ amount_gbp: 40 }), { gbp: 40, buxs: 1_000_000, amount: 4000 });
      assert.deepEqual(parsePurchase({ amount_gbp: 1000 }), { gbp: 1000, buxs: 25_000_000, amount: 100_000 });
      for (const bad of [0, 5, 15, 1010, 40.5, '40', null, undefined]) {
        assert.ok(parsePurchase({ amount_gbp: bad }).error, String(bad));
      }
    });

    await check('parsePurchase maps a legacy pack from a tab open across the deploy', async () => {
      assert.equal(parsePurchase({ pack: 'small' }).gbp, 10);
      assert.equal(parsePurchase({ pack: 'medium' }).gbp, 40);
      assert.equal(parsePurchase({ pack: 'large' }).gbp, 120);
      assert.ok(parsePurchase({ pack: 'huge' }).error);
    });

    await check('buxsFromMetadata: new buxs as is, a pre-deploy tokens purchase x2500', async () => {
      assert.equal(buxsFromMetadata({ buxs: '1000000' }), 1_000_000);
      assert.equal(buxsFromMetadata({ tokens: '100' }), 250_000);
      assert.equal(buxsFromMetadata({ buxs: '1000000', tokens: '100' }), 1_000_000);
      assert.ok(Number.isNaN(buxsFromMetadata({})));
      assert.ok(Number.isNaN(buxsFromMetadata({ buxs: 'x' })));
    });

    await check('planOrgMoves: every org with a positive budget, nothing else', async () => {
      const plan = planOrgMoves([
        { id: 'org_a', name: 'Robs', privateMetadata: { tokenBudget: 2250000 } },
        { id: 'org_b', name: 'Empty', privateMetadata: { tokenBudget: 0 } },
        { id: 'org_c', name: 'None', privateMetadata: {} },
        { id: 'org_d', name: 'Junk', privateMetadata: { tokenBudget: 'lots' } },
        { id: 'org_e', name: 'Fraction', privateMetadata: { tokenBudget: 10.7 } },
      ]);
      assert.deepEqual(plan, [
        { owner: 'org_a', amount: 2250000, idemKey: 'clerk-org:org_a', label: 'Robs' },
        { owner: 'org_e', amount: 10, idemKey: 'clerk-org:org_e', label: 'Fraction' },
      ]);
    });

    await check('planUserMoves: larger of private/unsafe, oldest org, no-org users skipped', async () => {
      const users = [
        { id: 'user_1', privateMetadata: { tokenBudget: 30000 }, unsafeMetadata: { tokenBudget: 50000 } },
        { id: 'user_2', privateMetadata: {}, unsafeMetadata: { tokenBudget: 1200 } },
        { id: 'user_3', privateMetadata: {}, unsafeMetadata: {} },
      ];
      const memberships = new Map([
        ['user_1', [
          { createdAt: 200, organization: { id: 'org_new' } },
          { createdAt: 100, organization: { id: 'org_old' } },
        ]],
        ['user_2', []],
      ]);
      assert.deepEqual(planUserMoves(users, memberships), [
        { userId: 'user_1', owner: 'org_old', amount: 50000, idemKey: 'clerk-user:user_1' },
        { userId: 'user_2', amount: 1200, skipped: 'no organisation yet' },
      ]);
    });

    await check('GET /api/billing still lists packs for a dashboard that predates the slider', async () => {
      const p = await newProperty(newOrg());
      const res = { status() { return this; }, json(b) { this.body = b; } };
      await billing.getBilling({ property_id: p }, res, (e) => { throw e; });
      assert.deepEqual(res.body.packs, [
        { id: 'small', tokens: 250_000, amount: 1000 },
        { id: 'medium', tokens: 1_000_000, amount: 4000 },
        { id: 'large', tokens: 3_000_000, amount: 12000 },
      ]);
      assert.equal(res.body.tokens_per_pound, 25_000);
    });

    await check('reconcile moves old-code credits made after the migration, once', async () => {
      const o = newOrg();
      const p = await newProperty(o);
      const late = (delta, reason, stripeId) => pool.query(
        `INSERT INTO property_token_ledger (property_id, delta, balance_after, reason, stripe_checkout_session_id, created_at)
         VALUES ($1, $2, $2, $3, $4, now() + interval '1 second')`, [p, delta, reason, stripeId]);
      await late(100, 'purchase', `cs_check_${hex()}`);
      await late(20, 'starter', null);
      await late(-1, 'ai_reply', null); // spends after the migration stay lost, in the customer's favour
      const first = await reconcileAfterMigration();
      assert.ok(first.moved >= 2);
      assert.equal(await tokens.getBalance(p), 120 * 2500);
      await reconcileAfterMigration();
      assert.equal(await tokens.getBalance(p), 120 * 2500);
      const rows = await ledgerRows(o);
      assert.equal(rows.filter((r) => r.reason === 'purchase' && /^cs_check_/.test(r.idem_key)).length, 1);
    });

    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, path, { body, secret = 'check-service-secret' } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (secret !== null) headers['X-Buxs-Secret'] = secret;
      const r = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    try {
      await check('service API: missing or wrong secret is 401', async () => {
        assert.equal((await api('GET', '/api/buxs/balance?org=org_checkabcdef1234', { secret: null })).status, 401);
        assert.equal((await api('GET', '/api/buxs/balance?org=org_checkabcdef1234', { secret: 'nope' })).status, 401);
      });

      await check('service API: unset secret is 503', async () => {
        const saved = process.env.BUXS_SERVICE_SECRET;
        delete process.env.BUXS_SERVICE_SECRET;
        try {
          assert.equal((await api('GET', '/api/buxs/balance?org=org_checkabcdef1234')).status, 503);
        } finally {
          process.env.BUXS_SERVICE_SECRET = saved;
        }
      });

      await check('service API: org must be a Clerk org id', async () => {
        const p = await newProperty(null);
        for (const org of [`property:${p}`, 'org_x', '', 'org_abc def123456']) {
          assert.equal((await api('GET', `/api/buxs/balance?org=${encodeURIComponent(org)}`)).status, 400, org);
        }
      });

      await check('service API: credit, balance, spend, 402, partial', async () => {
        const o = newOrg();
        const key = `check-${hex()}`;
        const c1 = await api('POST', '/api/buxs/credit', { body: { org: o, amount: 1000, reason: 'purchase', idem_key: key, ref: 'pi_check', source: 'forge' } });
        assert.deepEqual(c1, { status: 200, body: { credited: true, balance: 1000 } });
        const c2 = await api('POST', '/api/buxs/credit', { body: { org: o, amount: 1000, reason: 'purchase', idem_key: key, source: 'forge' } });
        assert.deepEqual(c2.body, { credited: false, balance: 1000 });
        assert.deepEqual((await api('GET', `/api/buxs/balance?org=${o}`)).body, { balance: 1000 });
        const s1 = await api('POST', '/api/buxs/spend', { body: { org: o, amount: 600, reason: 'forge_build', ref: 'b1', source: 'forge-app' } });
        assert.deepEqual(s1, { status: 200, body: { spent: 600, balance: 400 } });
        const s2 = await api('POST', '/api/buxs/spend', { body: { org: o, amount: 600, reason: 'forge_build', source: 'forge-app' } });
        assert.deepEqual(s2, { status: 402, body: { balance: 400 } });
        const s3 = await api('POST', '/api/buxs/spend', { body: { org: o, amount: 600, reason: 'forge_build', source: 'forge-app', partial: true } });
        assert.deepEqual(s3, { status: 200, body: { spent: 400, balance: 0 } });
      });

      await check('service API: bad amount, reason, source or idem_key is 400', async () => {
        const o = newOrg();
        const ok = { org: o, amount: 10, reason: 'purchase', idem_key: `check-${hex()}`, source: 'forge' };
        for (const bad of [{ amount: 0 }, { amount: 1.5 }, { amount: '10' }, { reason: 'Bad Reason' }, { source: 'hotal' }, { idem_key: '' }, { idem_key: undefined }]) {
          assert.equal((await api('POST', '/api/buxs/credit', { body: { ...ok, ...bad } })).status, 400, JSON.stringify(bad));
        }
        assert.equal((await api('POST', '/api/buxs/spend', { body: { org: o, amount: 10, reason: 'forge_build', source: 'nope' } })).status, 400);
      });
    } finally {
      server.close();
    }
  } finally {
    await pool.query('DELETE FROM buxs_ledger WHERE owner = ANY($1)', [owners]);
    await pool.query('DELETE FROM buxs_wallet WHERE owner = ANY($1)', [owners]);
    await pool.query('DELETE FROM property_token_ledger WHERE property_id = ANY($1)', [properties]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [properties]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
