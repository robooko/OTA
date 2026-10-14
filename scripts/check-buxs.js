// Checks the BUXS wallet (src/lib/tokens.js) and, from Task 4, the
// /api/buxs service routes against the local DB. tokens.js uses the shared
// pool, so fixtures are committed under throwaway owners ('org_check…',
// a fresh org-less property) and deleted at the end, pass or fail.
// Never point this at the live DB.
//   node -r dotenv/config scripts/check-buxs.js
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const tokens = require('../src/lib/tokens');

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
    });

    await check('HOTAL costs are in BUXS', async () => {
      assert.deepEqual(tokens.TOKEN_COSTS, { ai_reply: 2500, reply_send: 2500 });
    });

    await check('amounts must be integers from 1 to 50,000,000', async () => {
      for (const bad of [0, -1, 1.5, 50_000_001, '10', null]) {
        assert.throws(() => tokens.checkAmount(bad), (e) => e.status === 400, String(bad));
      }
      tokens.checkAmount(1);
      tokens.checkAmount(50_000_000);
    });
  } finally {
    await pool.query('DELETE FROM buxs_ledger WHERE owner = ANY($1)', [owners]);
    await pool.query('DELETE FROM buxs_wallet WHERE owner = ANY($1)', [owners]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [properties]);
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
