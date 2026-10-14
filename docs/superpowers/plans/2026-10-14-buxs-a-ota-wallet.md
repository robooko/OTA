# BUXS plan A: one wallet per org in OTA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move OTA's prepaid balance from `property.token_balance` (HOTAL tokens) to a BUXS wallet per Clerk org (or per org-less property), sell it by the pound, and expose it to forge and forge-app through a secret-guarded service API.

**Architecture:** A `buxs_wallet` / `buxs_ledger` pair keyed by an owner string (`org_…` or `property:<uuid>`). `src/lib/tokens.js` gains owner-level `spendFrom`/`creditTo` and keeps its property-level functions as thin wrappers, so HOTAL's callers don't change. Billing sells £10–£1,000 at 25,000 BUXS per pound. `/api/buxs/*` lets forge and forge-app read, spend and credit with `X-Buxs-Secret`. A script moves Clerk-metadata balances in.

**Tech Stack:** Node/Express, `pg`, Postgres, Stripe (platform account), `@clerk/backend`. Checks are plain `node:assert` scripts in `scripts/` (no test framework), run with `node -r dotenv/config scripts/<name>.js` against the local DB.

**Spec:** `docs/superpowers/specs/2026-10-14-unified-buxs-balance-design.md`

Plans B (dashboard, `ota-table-bookings`), C (forge) and D (forge-app) follow in their own repo sessions; this plan is OTA only.

## Global Constraints

- Unit: BUXS. £40 per 1M: `TOKENS_PER_POUND = 25_000`, `MIN_GBP = 10`, `MAX_GBP = 1000`, `STEP_GBP = 10` (same constants as forge's `src/lib/buxs.ts`).
- 1 old HOTAL token = 2,500 BUXS. `TOKEN_COSTS = { ai_reply: 2500, reply_send: 2500 }`.
- Starter grant: 50,000 BUXS once per owner (`BUXS_STARTER_BALANCE`, default `50000`), `idem_key = 'starter:<owner>'`.
- Owner of a property: `COALESCE(clerk_org_id, 'property:' || id)`.
- Amounts are positive integers ≤ 50,000,000; anything else is a 400.
- Service API secret header: `X-Buxs-Secret`, env `BUXS_SERVICE_SECRET`; never sent to a browser.
- Every check script refuses a remote `DATABASE_URL` (`/neon\.tech|render\.com/`) and cleans up its own rows.
- Schema changes go to BOTH DBs via `node scripts/run-migration.js <file>` (local `DATABASE_URL` and `DATABASE_URL_LIVE`), but only in Task 6 for live.
- Commit straight to `main` in OTA, one commit per task, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A PaymentIntent created before the deploy (metadata `tokens`, old units) succeeding after it must credit `tokens × 2500`, not `tokens`. Task 3 checks `buxsFromMetadata`.
2. A late Stripe webhook retry for a purchase made before the migration must not credit again: the migration carries each Stripe id into `idem_key`. Task 1 verifies the count; Task 2 checks a credit with a migrated id is refused.
3. An org adding a second property must not get a second 50,000 starter. Task 2 checks it.
4. A spend from an owner with no wallet row yet (an org-less property that never had a credit) must return `{ ok: false }`, not throw. Task 2 checks it.
5. The service API must refuse a missing or wrong secret (401), work only when the env is set (503 otherwise), and refuse a `property:` owner or junk in `org` (400). Task 4 checks all three.

---

### Task 1: Wallet and ledger migration

**Files:**
- Create: `src/db/migrate-2026-10-14-buxs-wallet.sql`

**Interfaces:**
- Produces: tables `buxs_wallet(owner TEXT PK, balance BIGINT ≥ 0, created_at)` and `buxs_ledger(id, owner, property_id, delta, balance_after, reason, ref_id, source, idem_key UNIQUE, created_at)`, seeded from `property.token_balance` and `property_token_ledger` (× 2500). Marker row `idem_key = 'hotal-migration'` (owner `platform`) makes re-runs no-ops.

- [ ] **Step 1: Write the migration**

```sql
-- One BUXS balance per owner: a Clerk org, or a property with no org
-- ('property:<uuid>'). See docs/superpowers/specs/2026-10-14-unified-buxs-balance-design.md.
-- Replaces property.token_balance / property_token_ledger, which stay
-- read-only until a later cleanup migration drops them.
--
-- 1 old HOTAL token = 2,500 BUXS (£0.10 at £40 per 1M). The seed runs once:
-- the 'hotal-migration' marker row makes a re-run a no-op.
--
-- Run this immediately before deploying the code that reads it: a spend the
-- old code makes in between is lost (in the customer's favour).

CREATE TABLE IF NOT EXISTS buxs_wallet (
  owner      TEXT PRIMARY KEY,                -- 'org_…' or 'property:<uuid>'
  balance    BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buxs_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner         TEXT NOT NULL,
  property_id   UUID REFERENCES property(id) ON DELETE SET NULL, -- HOTAL actions only
  delta         BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason        VARCHAR(40) NOT NULL,         -- starter | purchase | ai_reply | ai_reply_refund | reply_send | forge_build | migration
  ref_id        TEXT,                         -- what it was for: inquiry id, payment id, build id
  source        VARCHAR(20) NOT NULL DEFAULT 'hotal', -- hotal | forge | forge-app | migration
  idem_key      TEXT UNIQUE,                  -- credits only: Stripe id, 'starter:<owner>', 'clerk-org:<id>', 'clerk-user:<id>'
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buxs_ledger_owner ON buxs_ledger(owner, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM buxs_ledger WHERE idem_key = 'hotal-migration') THEN
    RETURN;
  END IF;

  INSERT INTO buxs_wallet (owner, balance)
  SELECT COALESCE(clerk_org_id, 'property:' || id), SUM(token_balance)::bigint * 2500
  FROM property
  GROUP BY 1
  ON CONFLICT (owner) DO UPDATE SET balance = buxs_wallet.balance + EXCLUDED.balance;

  -- History, in the new unit. balance_after stays per property (an org with
  -- two hotels had two running balances); new rows are per owner.
  -- A purchase keeps its Stripe id as idem_key, so a late webhook retry for
  -- it can't credit again.
  INSERT INTO buxs_ledger (owner, property_id, delta, balance_after, reason, ref_id, source, idem_key, created_at)
  SELECT COALESCE(p.clerk_org_id, 'property:' || p.id), l.property_id,
         l.delta::bigint * 2500, l.balance_after::bigint * 2500,
         l.reason, l.ref_id, 'hotal', l.stripe_checkout_session_id, l.created_at
  FROM property_token_ledger l
  JOIN property p ON p.id = l.property_id;

  -- An owner that already had a starter grant never gets another.
  UPDATE buxs_ledger b SET idem_key = 'starter:' || b.owner
  FROM (
    SELECT DISTINCT ON (owner) id FROM buxs_ledger
    WHERE reason = 'starter' AND idem_key IS NULL
    ORDER BY owner, created_at, id
  ) first_starter
  WHERE b.id = first_starter.id;

  INSERT INTO buxs_ledger (owner, delta, balance_after, reason, source, idem_key)
  VALUES ('platform', 0, 0, 'migration', 'migration', 'hotal-migration');
END $$;
```

- [ ] **Step 2: Run it against the local DB only**

`run-migration.js` also runs `DATABASE_URL_LIVE` when set, so blank it for this run:

Run: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-10-14-buxs-wallet.sql`
Expected: `DATABASE_URL: ok` and `DATABASE_URL_LIVE: not set, skipped`

- [ ] **Step 3: Verify the seed**

Run:
```bash
node -r dotenv/config -e "
const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const q=async s=>(await c.query(s)).rows[0];
console.log(await q(\"SELECT (SELECT SUM(token_balance)::bigint*2500 FROM property) AS old_total, (SELECT SUM(balance) FROM buxs_wallet) AS wallet_total\"));
console.log(await q(\"SELECT (SELECT COUNT(*) FROM property_token_ledger WHERE stripe_checkout_session_id IS NOT NULL) AS old_paid, (SELECT COUNT(*) FROM buxs_ledger WHERE idem_key ~ '^(cs|pi)_') AS new_paid\"));
console.log(await q(\"SELECT COUNT(DISTINCT COALESCE(clerk_org_id, 'property:'||id)) AS owners, (SELECT COUNT(*) FROM buxs_wallet) AS wallets FROM property\"));
await c.end()})()"
```
Expected: `old_total` = `wallet_total`, `old_paid` = `new_paid`, `owners` = `wallets`.

- [ ] **Step 4: Re-run to prove it's idempotent**

Run: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-10-14-buxs-wallet.sql`, then Step 3 again.
Expected: identical numbers.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate-2026-10-14-buxs-wallet.sql
git commit -m "BUXS: wallet and ledger per owner, seeded from property tokens x2500

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Owner-level `tokens.js`

**Files:**
- Modify: `src/lib/tokens.js` (whole file)
- Create: `scripts/check-buxs.js`

**Interfaces:**
- Consumes: Task 1's tables.
- Produces (all exported from `src/lib/tokens.js`):
  - `TOKEN_COSTS`, `STARTER_BALANCE`, `MAX_AMOUNT = 50_000_000`, `InsufficientTokensError`
  - `ownerOfProperty(propertyId): Promise<string>` (404 error if no property)
  - `checkAmount(amount): void` — throws `{ status: 400 }` unless an integer in 1..MAX_AMOUNT
  - `getWalletBalance(owner): Promise<number>`
  - `spendFrom(owner, amount, reason, { propertyId?, refId?, source?, partial? }): Promise<{ ok: boolean, cost: number, spent: number, balance: number }>`
  - `creditTo(owner, amount, reason, { idemKey?, refId?, propertyId?, source? }): Promise<{ credited: boolean, balance: number }>`
  - Unchanged signatures, now owner-backed: `getBalance(propertyId)`, `spend(propertyId, reason, refId)`, `credit(propertyId, amount, reason, { refId?, idemKey? })`, `grantStarter(propertyId)`, `listLedger(propertyId, limit)` → rows `{ id, delta, balance_after, reason, ref_id, source, property_id, created_at }` with numeric `delta`/`balance_after`.

- [ ] **Step 1: Write the failing check script**

```js
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: FAILs such as `tokens.creditTo is not a function`.

- [ ] **Step 3: Rewrite `src/lib/tokens.js`**

```js
// Prepaid BUXS (see migrate-2026-10-14-buxs-wallet.sql and
// docs/superpowers/specs/2026-10-14-unified-buxs-balance-design.md).
//
// One wallet per owner: a Clerk org ('org_…'), or a property with no org
// ('property:<uuid>'). HOTAL, forge and forge-app all spend and credit the
// same wallet. A feature that costs the platform money calls spend() before
// doing the work and takes its free fallback branch when it returns
// { ok: false } -- nothing ever hard-fails on an empty balance, it just gets
// worse. Every balance change goes through here so buxs_wallet and
// buxs_ledger can't drift apart.
const pool = require('../db');

// What each HOTAL action costs, in BUXS (£0.10 each at £40 per 1M -- the
// same price the old 1-token actions had). The key doubles as the ledger
// reason.
const TOKEN_COSTS = {
  ai_reply: 2500,   // one AI-drafted enquiry reply (Anthropic call)
  reply_send: 2500, // one outbound reply email (Resend call) -- charged whether
                    // the body was hand-typed or an approved AI draft, since
                    // sending costs the same either way.
};

// Granted once per owner (idem_key 'starter:<owner>'), so the paid features
// get tried before anyone is asked for a card -- and an org adding a second
// hotel doesn't get it twice.
const STARTER_BALANCE = Number.parseInt(process.env.BUXS_STARTER_BALANCE ?? '50000', 10);

// £2,000 of BUXS: well above the largest purchase (£1,000), so anything
// bigger is a bug or an attack, not a customer.
const MAX_AMOUNT = 50_000_000;

// Thrown by spend()'s callers when a metered action can't proceed on the
// current balance. Controllers map it to 402 automatically (status is read
// generically by middleware/errorHandler); the dashboard treats 402 on a
// reply-send as "open the guest's own email client instead".
class InsufficientTokensError extends Error {
  constructor(balance, cost) {
    super(`Not enough BUXS (balance ${balance}, need ${cost})`);
    this.name = 'InsufficientTokensError';
    this.status = 402;
    this.balance = balance;
    this.cost = cost;
  }
}

function checkAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw Object.assign(new Error(`amount must be a whole number of BUXS from 1 to ${MAX_AMOUNT}`), { status: 400 });
  }
}

async function ownerOfProperty(propertyId) {
  const { rows } = await pool.query('SELECT id, clerk_org_id FROM property WHERE id = $1', [propertyId]);
  if (!rows[0]) throw Object.assign(new Error('Property not found'), { status: 404 });
  return rows[0].clerk_org_id || `property:${rows[0].id}`;
}

async function getWalletBalance(owner) {
  const { rows } = await pool.query('SELECT balance FROM buxs_wallet WHERE owner = $1', [owner]);
  return Number(rows[0]?.balance ?? 0);
}

// Deducts `amount` under a row lock, so concurrent spends can't take the
// balance below zero. A short balance refuses the whole spend
// ({ ok: false }) -- unless `partial`, which takes whatever is left: for
// forge-app, whose cost is only known after the model call has happened.
async function spendFrom(owner, amount, reason, { propertyId = null, refId = null, source = 'hotal', partial = false } = {}) {
  checkAmount(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [wallet] } = await client.query('SELECT balance FROM buxs_wallet WHERE owner = $1 FOR UPDATE', [owner]);
    const before = Number(wallet?.balance ?? 0);
    const spent = partial ? Math.min(amount, before) : amount;
    if ((!partial && before < amount) || spent === 0) {
      await client.query('ROLLBACK');
      return { ok: partial, cost: amount, spent: 0, balance: before };
    }
    const balance = before - spent;
    await client.query('UPDATE buxs_wallet SET balance = $1 WHERE owner = $2', [balance, owner]);
    await client.query(
      `INSERT INTO buxs_ledger (owner, property_id, delta, balance_after, reason, ref_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [owner, propertyId, -spent, balance, reason, refId, source]
    );
    await client.query('COMMIT');
    return { ok: true, cost: amount, spent, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Adds BUXS, creating the wallet on first use. idemKey (a Stripe id,
// 'starter:<owner>', 'clerk-org:<id>', …) makes a repeat -- the webhook and
// the return-URL confirm racing, Stripe retrying, a script re-run -- return
// { credited: false } and change nothing. The wallet row is locked for the
// check-then-write so two first-time credits can't both pass.
async function creditTo(owner, amount, reason, { idemKey = null, refId = null, propertyId = null, source = 'hotal' } = {}) {
  checkAmount(amount);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO buxs_wallet (owner) VALUES ($1) ON CONFLICT (owner) DO NOTHING', [owner]);
    const { rows: [wallet] } = await client.query('SELECT balance FROM buxs_wallet WHERE owner = $1 FOR UPDATE', [owner]);
    const before = Number(wallet.balance);
    const balance = before + amount;
    const { rows: inserted } = await client.query(
      `INSERT INTO buxs_ledger (owner, property_id, delta, balance_after, reason, ref_id, source, idem_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idem_key) DO NOTHING
       RETURNING id`,
      [owner, propertyId, amount, balance, reason, refId, source, idemKey]
    );
    if (!inserted.length) {
      await client.query('ROLLBACK');
      return { credited: false, balance: before };
    }
    await client.query('UPDATE buxs_wallet SET balance = $1 WHERE owner = $2', [balance, owner]);
    await client.query('COMMIT');
    return { credited: true, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Property-level: what HOTAL's features call. Same signatures as before
// the wallet; each resolves the property's owner first. ──

async function getBalance(propertyId) {
  return getWalletBalance(await ownerOfProperty(propertyId));
}

async function spend(propertyId, reason, refId = null) {
  const cost = TOKEN_COSTS[reason];
  if (!cost) throw new Error(`Unknown token cost: ${reason}`);
  return spendFrom(await ownerOfProperty(propertyId), cost, reason, { propertyId, refId });
}

async function credit(propertyId, amount, reason, { refId = null, idemKey = null } = {}) {
  return creditTo(await ownerOfProperty(propertyId), amount, reason, { propertyId, refId, idemKey });
}

// Called when a property is created (first-login auto-create, or another
// hotel in the org). Once per owner; no-op when BUXS_STARTER_BALANCE is 0.
async function grantStarter(propertyId) {
  if (!(STARTER_BALANCE > 0)) return { credited: false, balance: 0 };
  const owner = await ownerOfProperty(propertyId);
  return creditTo(owner, STARTER_BALANCE, 'starter', { propertyId, idemKey: `starter:${owner}` });
}

// The whole wallet's history (every hotel in the org, FORGE purchases,
// forge-app builds), newest first.
async function listLedger(propertyId, limit = 50) {
  const owner = await ownerOfProperty(propertyId);
  const { rows } = await pool.query(
    `SELECT id, delta, balance_after, reason, ref_id, source, property_id, created_at
     FROM buxs_ledger WHERE owner = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [owner, limit]
  );
  return rows.map((r) => ({ ...r, delta: Number(r.delta), balance_after: Number(r.balance_after) }));
}

module.exports = {
  TOKEN_COSTS, STARTER_BALANCE, MAX_AMOUNT, InsufficientTokensError,
  checkAmount, ownerOfProperty, getWalletBalance, spendFrom, creditTo,
  getBalance, spend, credit, grantStarter, listLedger,
};
```

- [ ] **Step 4: Run the checks**

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: every line `ok`, then `all passed`.

- [ ] **Step 5: Confirm the callers still load**

Run: `node -e "require('./src/app'); console.log('app loads')"`
Expected: `app loads` (the refund in `aiReplyPipeline.js` passes `{ refId }`, which `credit` still accepts; `eventInquiries.js` compares `getBalance` with `TOKEN_COSTS.reply_send`, now both in BUXS).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tokens.js scripts/check-buxs.js
git commit -m "BUXS: tokens.js spends and credits per owner, HOTAL costs in BUXS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Billing sells BUXS by the pound

**Files:**
- Modify: `src/lib/platformStripe.js` (whole file)
- Modify: `src/controllers/billing.js` (whole file)
- Modify: `src/docs/swagger.js:597` (`/api/billing` get), `:601` (`/api/billing/ledger` get), `:604` (`/checkout` post), `:610` (`/payment-intent` post)
- Modify: `src/lib/resend.js:166` (fallback note copy)
- Modify: `scripts/check-buxs.js` (add pure checks)

**Interfaces:**
- Consumes: `tokens.creditTo`, `tokens.ownerOfProperty`, `tokens.getBalance`, `tokens.listLedger`, `tokens.TOKEN_COSTS`, `tokens.STARTER_BALANCE` (Task 2).
- Produces (from `src/lib/platformStripe.js`): `TOKENS_PER_POUND`, `MIN_GBP`, `MAX_GBP`, `STEP_GBP`, `LEGACY_PACK_GBP`, `parsePurchase(body): { gbp, buxs, amount } | { error }`, `buxsFromMetadata(metadata): number` (NaN when unusable), plus the existing `stripe`, `CURRENCY`, `isBillingConfigured`, `constructWebhookEvent`. `TOKEN_PACKS` and `getPack` are removed.
- Produces (HTTP): `GET /api/billing` → `{ configured, balance, fallback_email, starter_balance, costs, currency, min_gbp, max_gbp, step_gbp, tokens_per_pound, publishable_key }`. `POST /checkout` and `/payment-intent` take `{ amount_gbp }` (or legacy `{ pack }`). Confirm routes return `{ credited, balance, paid, buxs, tokens }` (`tokens` = `buxs`, until Plan B's dashboard reads `buxs`).

- [ ] **Step 1: Add the failing pure checks**

In `scripts/check-buxs.js`, add after `const tokens = require('../src/lib/tokens');`:

```js
const { parsePurchase, buxsFromMetadata } = require('../src/lib/platformStripe');
```

and add these inside the `try`, after the last existing check:

```js
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
```

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: the script crashes or FAILs on `parsePurchase is not a function`.

- [ ] **Step 2: Rewrite `src/lib/platformStripe.js`**

```js
// The platform's OWN Stripe account, used to sell BUXS to properties.
// Deliberately separate from property.stripe_secret_key (the venue's account,
// used for its guests' deposits/tabs) -- a payment for our fee must pay us,
// and a webhook signed by our account can only be verified with our secret.
// Env unset = billing not offered; the dashboard hides the buyer and the
// AI pipeline still spends the starter grant.
const key = process.env.PLATFORM_STRIPE_SECRET_KEY;
const stripe = key ? require('stripe')(key) : null;

const CURRENCY = 'gbp';

// £40 per 1M BUXS, bought £10–£1,000 in £10 steps: the same constants as
// forge's src/lib/buxs.ts, so FORGE and HOTAL sell at one price.
const TOKENS_PER_POUND = 25_000;
const MIN_GBP = 10;
const MAX_GBP = 1000;
const STEP_GBP = 10;

// The old fixed packs, for a dashboard tab still open from before the
// deploy that posts { pack } instead of { amount_gbp }.
const LEGACY_PACK_GBP = { small: 10, medium: 40, large: 120 };

function isBillingConfigured() {
  return !!stripe;
}

// { gbp, buxs, amount (pence) } for a purchase request, or { error }.
function parsePurchase(body) {
  let gbp = body?.amount_gbp;
  if (gbp === undefined && Object.hasOwn(LEGACY_PACK_GBP, body?.pack ?? '')) gbp = LEGACY_PACK_GBP[body.pack];
  if (!Number.isInteger(gbp) || gbp < MIN_GBP || gbp > MAX_GBP || gbp % STEP_GBP) {
    return { error: `amount_gbp must be a whole number of pounds from £${MIN_GBP} to £${MAX_GBP}, in £${STEP_GBP} steps` };
  }
  return { gbp, buxs: gbp * TOKENS_PER_POUND, amount: gbp * 100 };
}

// What a paid Stripe object buys. New ones carry `buxs`; one created before
// the BUXS deploy carries `tokens` in the old unit (1 token = 2,500 BUXS).
// NaN when neither is usable.
function buxsFromMetadata(metadata) {
  if (metadata?.buxs !== undefined) return Number.parseInt(metadata.buxs, 10);
  if (metadata?.tokens !== undefined) return Number.parseInt(metadata.tokens, 10) * 2500;
  return Number.NaN;
}

// Verifies a webhook delivery against PLATFORM_STRIPE_WEBHOOK_SECRET. Throws
// on a bad signature (caller maps to 400) or when the secret is unset.
function constructWebhookEvent(rawBody, signatureHeader) {
  if (!stripe) throw new Error('Platform Stripe is not configured');
  const secret = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('PLATFORM_STRIPE_WEBHOOK_SECRET is not set');
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

module.exports = {
  stripe, CURRENCY, TOKENS_PER_POUND, MIN_GBP, MAX_GBP, STEP_GBP, LEGACY_PACK_GBP,
  isBillingConfigured, parsePurchase, buxsFromMetadata, constructWebhookEvent,
};
```

- [ ] **Step 3: Run the pure checks**

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: `all passed`.

- [ ] **Step 4: Rewrite `src/controllers/billing.js`**

```js
// Platform billing: the property's BUXS balance (its org's wallet, see
// lib/tokens.js), ledger, fallback settings, and buying BUXS by the pound
// through Stripe on the platform's account. Spending lives with the
// features that spend; this file only ever credits.
const pool = require('../db');
const tokens = require('../lib/tokens');
const {
  stripe, CURRENCY, TOKENS_PER_POUND, MIN_GBP, MAX_GBP, STEP_GBP,
  isBillingConfigured, parsePurchase, buxsFromMetadata, constructWebhookEvent,
} = require('../lib/platformStripe');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function billingResponse(balance, fallbackEmail) {
  return {
    configured: isBillingConfigured(),
    balance,
    fallback_email: fallbackEmail,
    starter_balance: tokens.STARTER_BALANCE,
    costs: tokens.TOKEN_COSTS,
    currency: CURRENCY.toUpperCase(),
    min_gbp: MIN_GBP,
    max_gbp: MAX_GBP,
    step_gbp: STEP_GBP,
    tokens_per_pound: TOKENS_PER_POUND,
    // Set (with PLATFORM_STRIPE_PUBLISHABLE_KEY) to let the dashboard take
    // payment in-page with Stripe Elements; when null it falls back to
    // redirecting to Stripe Checkout. Must be the same account as the
    // secret key or confirmPayment will reject the client_secret.
    publishable_key: isBillingConfigured() ? process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY || null : null,
  };
}

async function getBilling(req, res, next) {
  try {
    const [{ rows }, balance] = await Promise.all([
      pool.query('SELECT fallback_email FROM property WHERE id = $1', [req.property_id]),
      tokens.getBalance(req.property_id),
    ]);
    res.json(billingResponse(balance, rows[0].fallback_email));
  } catch (err) {
    next(err);
  }
}

// Only fallback_email is writable: where enquiries go when there's no
// balance for an AI draft (null = dashboard queue only). Balance changes
// come from purchases and spends, never from a PUT.
async function updateBilling(req, res, next) {
  try {
    const { fallback_email } = req.body ?? {};
    if (fallback_email !== undefined && fallback_email !== null) {
      if (typeof fallback_email !== 'string' || !EMAIL_RE.test(fallback_email.trim()) || fallback_email.length > 255) {
        return res.status(400).json({ error: 'fallback_email must be a valid email address or null' });
      }
    }
    const { rows } = await pool.query(
      `UPDATE property SET
         fallback_email = CASE WHEN $1::boolean THEN $2::text ELSE fallback_email END
       WHERE id = $3
       RETURNING fallback_email`,
      [fallback_email !== undefined, fallback_email?.trim() || null, req.property_id]
    );
    res.json(billingResponse(await tokens.getBalance(req.property_id), rows[0].fallback_email));
  } catch (err) {
    next(err);
  }
}

async function listLedger(req, res, next) {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    res.json(await tokens.listLedger(req.property_id, limit));
  } catch (err) {
    next(err);
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// One Stripe Customer per property on the platform account, created on the
// first purchase, so receipts and the Stripe dashboard group by venue. A
// stored id can be from the other Stripe mode (test key after a live-mode
// purchase, or vice versa) -- verify it, and mint a replacement when the
// current key can't see it rather than failing the purchase.
async function ensureStripeCustomer(propertyId) {
  const { rows: [prop] } = await pool.query('SELECT name, stripe_customer_id FROM property WHERE id = $1', [propertyId]);
  if (prop.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(prop.stripe_customer_id);
      if (!existing.deleted) return prop.stripe_customer_id;
    } catch (err) {
      if (err.code !== 'resource_missing') throw err;
    }
  }
  const customer = await stripe.customers.create({ name: prop.name, metadata: { property_id: propertyId } });
  await pool.query('UPDATE property SET stripe_customer_id = $1 WHERE id = $2', [customer.id, propertyId]);
  return customer.id;
}

// What every purchase carries in Stripe metadata: the property (for the
// confirm routes' ownership check), the wallet owner it credits, and the
// BUXS it buys. Nothing about the amount is trusted from the client after
// creation.
async function purchaseMetadata(propertyId, purchase) {
  return { property_id: propertyId, owner: await tokens.ownerOfProperty(propertyId), buxs: String(purchase.buxs) };
}

const describe = (purchase) => `${purchase.buxs.toLocaleString('en-GB')} BUXS`;

// Starts a Checkout Session. return_url is the dashboard page to come back
// to; we append billing=success&session_id=... (Stripe fills the
// placeholder) or billing=cancelled so the page can confirm/toast.
async function createCheckout(req, res, next) {
  try {
    if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server' });
    const purchase = parsePurchase(req.body);
    if (purchase.error) return res.status(400).json({ error: purchase.error });
    const { return_url } = req.body ?? {};
    if (typeof return_url !== 'string' || !isHttpUrl(return_url)) return res.status(400).json({ error: 'return_url must be an http(s) URL' });

    const customer = await ensureStripeCustomer(req.property_id);
    const sep = return_url.includes('?') ? '&' : '?';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: purchase.amount,
            product_data: { name: describe(purchase), description: 'Prepaid BUXS for AI replies, FORGE builds and other metered features' },
          },
        },
      ],
      metadata: await purchaseMetadata(req.property_id, purchase),
      client_reference_id: req.property_id,
      success_url: `${return_url}${sep}billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${return_url}${sep}billing=cancelled`,
    });
    res.status(201).json({ url: session.url, session_id: session.id });
  } catch (err) {
    next(err);
  }
}

// The Elements path: the dashboard collects the card in-page against this
// intent's client_secret instead of redirecting to Checkout. After creation
// the two flows credit identically.
async function createPaymentIntent(req, res, next) {
  try {
    if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server' });
    const purchase = parsePurchase(req.body);
    if (purchase.error) return res.status(400).json({ error: purchase.error });

    const customer = await ensureStripeCustomer(req.property_id);
    const intent = await stripe.paymentIntents.create({
      amount: purchase.amount,
      currency: CURRENCY,
      customer,
      metadata: await purchaseMetadata(req.property_id, purchase),
      automatic_payment_methods: { enabled: true },
      description: describe(purchase),
    });
    res.status(201).json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount: purchase.amount, buxs: purchase.buxs });
  } catch (err) {
    next(err);
  }
}

// Credits the Stripe object that paid (cs_… or pi_…), idempotent on its id.
// A purchase made before the BUXS deploy has no `owner`: its property's
// owner gets it, and buxsFromMetadata converts its old-unit `tokens`.
async function creditPaid(stripeId, metadata, refId) {
  const propertyId = metadata?.property_id;
  const amount = buxsFromMetadata(metadata);
  if (!propertyId || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${stripeId} has no usable property_id/buxs metadata`);
  }
  const owner = metadata.owner || (await tokens.ownerOfProperty(propertyId));
  const result = await tokens.creditTo(owner, amount, 'purchase', { propertyId, refId, idemKey: stripeId });
  return { ...result, buxs: amount };
}

const creditFromIntent = (intent) => creditPaid(intent.id, intent.metadata, intent.id);
const creditFromSession = (session) => {
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  return creditPaid(session.id, session.metadata, paymentIntent);
};

// Old dashboards toast `tokens`; Plan B's reads `buxs`. Same number.
const confirmed = (result) => ({ credited: result.credited, balance: result.balance, paid: true, buxs: result.buxs, tokens: result.buxs });

// Called by the dashboard right after confirmPayment succeeds (or on the
// return from a redirect-based payment method). Idempotent against the
// webhook.
async function confirmPaymentIntent(req, res, next) {
  try {
    if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server' });
    const { payment_intent_id } = req.body ?? {};
    if (typeof payment_intent_id !== 'string' || !payment_intent_id.startsWith('pi_')) {
      return res.status(400).json({ error: 'payment_intent_id is required' });
    }
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.metadata?.property_id !== req.property_id) return res.status(404).json({ error: 'Payment not found' });
    if (intent.status !== 'succeeded') {
      return res.json({ credited: false, paid: false, balance: await tokens.getBalance(req.property_id) });
    }
    res.json(confirmed(await creditFromIntent(intent)));
  } catch (err) {
    next(err);
  }
}

// Called by the dashboard when Stripe sends the user back with
// ?session_id=. Credits if paid and not already credited by the webhook --
// so a local dev setup without webhook forwarding still works.
async function confirmCheckout(req, res, next) {
  try {
    if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server' });
    const { session_id } = req.body ?? {};
    if (typeof session_id !== 'string' || !session_id.startsWith('cs_')) return res.status(400).json({ error: 'session_id is required' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.metadata?.property_id !== req.property_id) return res.status(404).json({ error: 'Checkout session not found' });
    if (session.payment_status !== 'paid') {
      return res.json({ credited: false, paid: false, balance: await tokens.getBalance(req.property_id) });
    }
    res.json(confirmed(await creditFromSession(session)));
  } catch (err) {
    next(err);
  }
}

// Mounted with express.raw (see app.js). Acknowledges everything it can
// verify; only a bad signature is a 4xx, so Stripe doesn't retry events we
// simply don't act on. A failed credit is a 500 so Stripe retries it.
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Platform Stripe webhook rejected:', err.message);
    return res.status(400).json({ error: 'Invalid webhook' });
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      try {
        const result = await creditFromSession(session);
        if (result.credited) console.log(`Credited ${result.buxs} BUXS for property ${session.metadata.property_id} (${session.id})`);
      } catch (err) {
        console.error(`Failed to credit checkout session ${session.id}:`, err.message);
        return res.status(500).json({ error: 'Credit failed' });
      }
    }
  }
  // The Elements flow. Only intents we created carry buxs (or, before the
  // BUXS deploy, tokens) metadata -- a Checkout purchase's underlying
  // intent doesn't, so a Checkout payment can't credit twice via both events.
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    if (intent.metadata?.buxs || intent.metadata?.tokens) {
      try {
        const result = await creditFromIntent(intent);
        if (result.credited) console.log(`Credited ${result.buxs} BUXS for property ${intent.metadata.property_id} (${intent.id})`);
      } catch (err) {
        console.error(`Failed to credit payment intent ${intent.id}:`, err.message);
        return res.status(500).json({ error: 'Credit failed' });
      }
    }
  }
  res.json({ received: true });
}

module.exports = { getBilling, updateBilling, listLedger, createCheckout, confirmCheckout, createPaymentIntent, confirmPaymentIntent, handleStripeWebhook };
```

- [ ] **Step 5: Update the Swagger entries and the fallback email copy**

Run this from the OTA root (it replaces the four whole lines by their unique opening and fails loudly if any isn't found):

```bash
python - <<'EOF'
p = 'src/docs/swagger.js'
lines = open(p, encoding='utf-8').read().split('\n')
new = {
  "      get: { tags: ['Billing'], summary: \"The current property's prepaid token balance":
    "      get: { tags: ['Billing'], summary: \"The current property's BUXS balance (its org's wallet), costs, price, and fallback settings\", description: 'Metered features (an AI reply draft, for example) spend BUXS; at zero balance each degrades to its free fallback rather than failing. The balance is shared by every property in the Clerk org, and by FORGE builds. `configured` is whether this server can sell BUXS (PLATFORM_STRIPE_SECRET_KEY). BUXS are bought in whole pounds from min_gbp to max_gbp in step_gbp steps, at tokens_per_pound.', security: [{ bearerAuth: [] }], responses: { 200: { description: '{ configured, balance, fallback_email, starter_balance, costs: { ai_reply: 2500, reply_send: 2500 }, currency, min_gbp, max_gbp, step_gbp, tokens_per_pound, publishable_key }' } } },",
  "      get: { tags: ['Billing'], summary: 'Recent token balance changes":
    "      get: { tags: ['Billing'], summary: 'Recent BUXS balance changes for the whole org wallet, newest first', security: [{ bearerAuth: [] }], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } }], responses: { 200: { description: 'Array of { id, delta, balance_after, reason, ref_id, source, property_id, created_at }' } } },",
  "      post: { tags: ['Billing'], summary: 'Start a Stripe Checkout Session to buy a token pack":
    "      post: { tags: ['Billing'], summary: 'Start a Stripe Checkout Session to buy BUXS (admin only)', description: 'amount_gbp: whole pounds, 10-1000 in steps of 10, at 25,000 BUXS per pound. Stripe returns the browser to return_url with billing=success&session_id=... or billing=cancelled.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['amount_gbp', 'return_url'], properties: { amount_gbp: { type: 'integer', minimum: 10, maximum: 1000, multipleOf: 10 }, return_url: { type: 'string', format: 'uri' } } } } } }, responses: { 201: { description: '{ url, session_id }' }, 400: { description: 'Bad amount or return_url' }, 403: { description: 'Insufficient permissions' }, 503: { description: 'Billing not configured' } } },",
  "      post: { tags: ['Billing'], summary: 'Create a PaymentIntent for a token pack":
    "      post: { tags: ['Billing'], summary: 'Create a PaymentIntent to buy BUXS, for in-page Stripe Elements payment (admin only)', description: 'amount_gbp: whole pounds, 10-1000 in steps of 10, at 25,000 BUXS per pound.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['amount_gbp'], properties: { amount_gbp: { type: 'integer', minimum: 10, maximum: 1000, multipleOf: 10 } } } } } }, responses: { 201: { description: '{ client_secret, payment_intent_id, amount, buxs }' }, 400: { description: 'Bad amount' }, 403: { description: 'Insufficient permissions' }, 503: { description: 'Billing not configured' } } },",
}
for prefix, line in new.items():
    hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    assert len(hits) == 1, (prefix, hits)
    lines[hits[0]] = line
open(p, 'w', encoding='utf-8', newline='').write('\n'.join(lines))

p = 'src/lib/resend.js'
s = open(p, encoding='utf-8').read()
old = 'your Forge account is out of AI reply tokens.'
assert s.count(old) == 1
s = s.replace(old, 'your Forge account is out of BUXS.')
open(p, 'w', encoding='utf-8', newline='').write(s)
EOF
```

- [ ] **Step 6: Check the app loads and the checks pass**

Run: `node -e "require('./src/app'); console.log('app loads')" && node -r dotenv/config scripts/check-buxs.js`
Expected: `app loads`, then `all passed`.

- [ ] **Step 7: Try a real purchase against Stripe test mode (local)**

With `PLATFORM_STRIPE_SECRET_KEY` set to a test key in `.env`, start the API (`npm run dev`) and, from the dashboard's browser console signed in as an admin (or with `curl` and a Clerk bearer token from `clerk impersonate`):
`POST /api/billing/payment-intent` with `{ "amount_gbp": 40 }`.
Expected: `201` with `buxs: 1000000` and an `amount` of `4000`; the intent in the Stripe test dashboard has metadata `owner` and `buxs`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/platformStripe.js src/controllers/billing.js src/docs/swagger.js src/lib/resend.js scripts/check-buxs.js
git commit -m "BUXS: billing sells by the pound, credits the owner, converts pre-deploy purchases

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Service API for forge and forge-app

**Files:**
- Create: `src/controllers/buxs.js`
- Create: `src/routes/buxs.js`
- Modify: `src/app.js` (require and mount after `express.json()`)
- Modify: `scripts/check-buxs.js` (HTTP checks)

**Interfaces:**
- Consumes: `tokens.getWalletBalance`, `tokens.spendFrom`, `tokens.creditTo` (Task 2).
- Produces (HTTP, all with header `X-Buxs-Secret`):
  - `GET /api/buxs/balance?org=org_…` → `200 { balance }`
  - `POST /api/buxs/spend` `{ org, amount, reason, ref?, source, partial? }` → `200 { spent, balance }` | `402 { balance }`
  - `POST /api/buxs/credit` `{ org, amount, reason, idem_key, ref?, source }` → `200 { credited, balance }`
  - Errors: `503` when `BUXS_SERVICE_SECRET` is unset, `401` for a missing or wrong secret, `400` for a bad `org`, `amount`, `reason`, `source` or `idem_key`.
  - `source` ∈ `forge`, `forge-app`, `migration`. `reason` matches `/^[a-z_]{1,40}$/`. `org` matches `/^org_[A-Za-z0-9]{10,64}$/`. `idem_key` is a string of 1–200 characters.

- [ ] **Step 1: Add the failing HTTP checks**

At the top of `scripts/check-buxs.js`, before `const pool = require('../src/db');`:

```js
process.env.BUXS_SERVICE_SECRET = 'check-service-secret';
```

After `const { parsePurchase, buxsFromMetadata } = …`:

```js
const app = require('../src/app');
```

Inside the `try`, after the last check:

```js
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
```

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: the service API checks FAIL (404s; the routes don't exist yet).

- [ ] **Step 2: Write `src/controllers/buxs.js`**

```js
// Server-to-server BUXS for forge (forge-build.co.uk: balance pill,
// purchases) and forge-app (builds). They vouch for the org from their own
// verified Clerk session and prove themselves with BUXS_SERVICE_SECRET, so
// there is no Clerk auth here. The secret must never reach a browser.
const crypto = require('crypto');
const tokens = require('../lib/tokens');

const ORG_RE = /^org_[A-Za-z0-9]{10,64}$/;
const REASON_RE = /^[a-z_]{1,40}$/;
const SOURCES = new Set(['forge', 'forge-app', 'migration']);

function requireServiceSecret(req, res, next) {
  const secret = process.env.BUXS_SERVICE_SECRET;
  if (!secret) return res.status(503).json({ error: 'The BUXS service API is not configured on this server' });
  const given = Buffer.from(req.get('x-buxs-secret') ?? '');
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Invalid service secret' });
  }
  next();
}

// Clerk org ids only: a 'property:' owner is HOTAL's own business.
function invalid(body, { needsIdemKey = false } = {}) {
  const { org, amount, reason, source, idem_key: idemKey } = body;
  if (typeof org !== 'string' || !ORG_RE.test(org)) return 'org must be a Clerk organization id (org_…)';
  if (!Number.isInteger(amount) || amount <= 0 || amount > tokens.MAX_AMOUNT) return `amount must be a whole number of BUXS from 1 to ${tokens.MAX_AMOUNT}`;
  if (typeof reason !== 'string' || !REASON_RE.test(reason)) return 'reason must be 1-40 lowercase letters or underscores';
  if (!SOURCES.has(source)) return `source must be one of ${[...SOURCES].join(', ')}`;
  if (needsIdemKey && (typeof idemKey !== 'string' || !idemKey.length || idemKey.length > 200)) return 'idem_key must be a string of 1-200 characters';
  return null;
}

async function getBalance(req, res, next) {
  try {
    const { org } = req.query;
    if (typeof org !== 'string' || !ORG_RE.test(org)) return res.status(400).json({ error: 'org must be a Clerk organization id (org_…)' });
    res.json({ balance: await tokens.getWalletBalance(org) });
  } catch (err) {
    next(err);
  }
}

async function spend(req, res, next) {
  try {
    const body = req.body ?? {};
    const error = invalid(body);
    if (error) return res.status(400).json({ error });
    const r = await tokens.spendFrom(body.org, body.amount, body.reason, {
      refId: typeof body.ref === 'string' ? body.ref.slice(0, 200) : null,
      source: body.source,
      partial: body.partial === true,
    });
    if (!r.ok) return res.status(402).json({ balance: r.balance });
    res.json({ spent: r.spent, balance: r.balance });
  } catch (err) {
    next(err);
  }
}

async function credit(req, res, next) {
  try {
    const body = req.body ?? {};
    const error = invalid(body, { needsIdemKey: true });
    if (error) return res.status(400).json({ error });
    res.json(await tokens.creditTo(body.org, body.amount, body.reason, {
      idemKey: body.idem_key,
      refId: typeof body.ref === 'string' ? body.ref.slice(0, 200) : null,
      source: body.source,
    }));
  } catch (err) {
    next(err);
  }
}

module.exports = { requireServiceSecret, getBalance, spend, credit };
```

- [ ] **Step 3: Write `src/routes/buxs.js`**

```js
const express = require('express');
const ctrl = require('../controllers/buxs');

const router = express.Router();

router.use(ctrl.requireServiceSecret);
router.get('/balance', ctrl.getBalance);
router.post('/spend', ctrl.spend);
router.post('/credit', ctrl.credit);

module.exports = router;
```

- [ ] **Step 4: Mount it in `src/app.js`**

After `const marinaRoutes = require('./routes/marina');` add:

```js
const buxsRoutes = require('./routes/buxs');
```

After `app.use('/api/billing', billingRoutes);` add:

```js
// forge and forge-app, server to server (X-Buxs-Secret); see controllers/buxs.js.
app.use('/api/buxs', buxsRoutes);
```

- [ ] **Step 5: Run the checks**

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: `all passed`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/buxs.js src/routes/buxs.js src/app.js scripts/check-buxs.js
git commit -m "BUXS: service API for forge and forge-app (balance, spend, credit)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Clerk → OTA move script

**Files:**
- Create: `src/lib/clerkBuxsMove.js`
- Create: `scripts/migrate-clerk-buxs.js`
- Modify: `scripts/check-buxs.js` (planner checks)

**Interfaces:**
- Consumes: `tokens.creditTo`, `tokens.MAX_AMOUNT` (Task 2); `@clerk/backend`'s `createClerkClient`.
- Produces:
  - `planOrgMoves(orgs): Array<{ owner, amount, idemKey, label }>` from Clerk `Organization` objects (`id`, `name`, `privateMetadata`).
  - `planUserMoves(users, membershipsByUser): Array<{ userId, owner?, amount, idemKey?, skipped? }>` from Clerk `User` objects (`id`, `privateMetadata`, `unsafeMetadata`) and a `Map<userId, OrganizationMembership[]>` (`createdAt`, `organization.id`).
  - CLI: `node -r dotenv/config scripts/migrate-clerk-buxs.js --orgs|--users [--dry-run] [--live]`.

- [ ] **Step 1: Add the failing planner checks**

In `scripts/check-buxs.js`, after the `require('../src/lib/platformStripe')` line:

```js
const { planOrgMoves, planUserMoves } = require('../src/lib/clerkBuxsMove');
```

Inside the `try`, before the `const server = app.listen(0);` line:

```js
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
```

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: crash on `Cannot find module '../src/lib/clerkBuxsMove'`.

- [ ] **Step 2: Write `src/lib/clerkBuxsMove.js`**

```js
// Plans the one-time move of BUXS balances out of Clerk metadata into OTA
// wallets (scripts/migrate-clerk-buxs.js does the writing). Pure, so the
// plan can be printed and checked before anything is credited.

const budget = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// FORGE sold BUXS to orgs: private_metadata.tokenBudget.
function planOrgMoves(orgs) {
  return orgs
    .map((o) => ({ owner: o.id, amount: budget(o.privateMetadata?.tokenBudget), idemKey: `clerk-org:${o.id}`, label: o.name }))
    .filter((m) => m.amount > 0);
}

// forge-app kept a per-user balance: unsafe_metadata on main, private on its
// unmerged branch. Whichever is larger moves, whole, into the user's oldest
// org. A user with no org keeps it in Clerk for now; forge-app moves it
// (same idem key) once they create one.
function planUserMoves(users, membershipsByUser) {
  const moves = [];
  for (const u of users) {
    const amount = Math.max(budget(u.privateMetadata?.tokenBudget), budget(u.unsafeMetadata?.tokenBudget));
    if (!amount) continue;
    const oldest = [...(membershipsByUser.get(u.id) ?? [])].sort((a, b) => a.createdAt - b.createdAt)[0];
    moves.push(oldest
      ? { userId: u.id, owner: oldest.organization.id, amount, idemKey: `clerk-user:${u.id}` }
      : { userId: u.id, amount, skipped: 'no organisation yet' });
  }
  return moves;
}

module.exports = { planOrgMoves, planUserMoves };
```

- [ ] **Step 3: Run the planner checks**

Run: `node -r dotenv/config scripts/check-buxs.js`
Expected: `all passed`.

- [ ] **Step 4: Write `scripts/migrate-clerk-buxs.js`**

```js
// Moves BUXS balances out of Clerk metadata into OTA wallets, once.
//   --orgs   FORGE's org balances (private_metadata.tokenBudget). Run right
//            after forge reads its balance from OTA (Plan C).
//   --users  forge-app's per-user balances. Run right after forge-app spends
//            through OTA (Plan D) -- earlier, forge-app would see an emptied
//            balance and re-grant its free 50k.
//   --dry-run  print the plan, write nothing.
//   --live     use DATABASE_URL_LIVE and CLERK_SECRET_KEY_LIVE instead.
// Credits first, then clears the Clerk field. Each credit is idempotent
// (clerk-org:<id> / clerk-user:<id>), so a re-run after a partial failure is
// safe.
//   node -r dotenv/config scripts/migrate-clerk-buxs.js --orgs --dry-run
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
if (live) {
  if (!process.env.DATABASE_URL_LIVE || !process.env.CLERK_SECRET_KEY_LIVE) {
    throw new Error('--live needs DATABASE_URL_LIVE and CLERK_SECRET_KEY_LIVE');
  }
  process.env.DATABASE_URL = process.env.DATABASE_URL_LIVE;
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY_LIVE;
}
const mode = args.has('--orgs') ? 'orgs' : args.has('--users') ? 'users' : null;
if (!mode) throw new Error('pass --orgs or --users');
const dryRun = args.has('--dry-run');

const { createClerkClient } = require('@clerk/backend');
const pool = require('../src/db');
const tokens = require('../src/lib/tokens');
const { planOrgMoves, planUserMoves } = require('../src/lib/clerkBuxsMove');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function all(list) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const { data, totalCount } = await list({ limit: 100, offset });
    out.push(...data);
    if (!data.length || out.length >= totalCount) return out;
  }
}

(async () => {
  let moves;
  if (mode === 'orgs') {
    moves = planOrgMoves(await all((p) => clerk.organizations.getOrganizationList(p)));
  } else {
    const users = await all((p) => clerk.users.getUserList(p));
    const memberships = new Map();
    for (const u of users) {
      const { data } = await clerk.users.getOrganizationMembershipList({ userId: u.id, limit: 100 });
      memberships.set(u.id, data);
    }
    moves = planUserMoves(users, memberships);
  }

  console.log(`${live ? 'LIVE' : 'local'} ${mode}${dryRun ? ' (dry run)' : ''}: ${moves.length} balance(s)`);
  let total = 0;
  let failed = 0;
  for (const m of moves) {
    const who = m.label ?? m.userId;
    if (m.skipped) { console.log(`skip   ${who}: ${m.amount} (${m.skipped})`); continue; }
    total += m.amount;
    if (dryRun) { console.log(`plan   ${who} -> ${m.owner}: ${m.amount}`); continue; }
    try {
      const r = await tokens.creditTo(m.owner, m.amount, 'migration', { idemKey: m.idemKey, source: 'migration' });
      if (mode === 'orgs') {
        await clerk.organizations.updateOrganizationMetadata(m.owner, { privateMetadata: { tokenBudget: null, creditedSessions: null } });
      } else {
        await clerk.users.updateUserMetadata(m.userId, { privateMetadata: { tokenBudget: null }, unsafeMetadata: { tokenBudget: null } });
      }
      console.log(`${r.credited ? 'moved ' : 'again '} ${who} -> ${m.owner}: ${m.amount} (wallet ${r.balance})`);
    } catch (err) {
      failed++;
      console.log(`FAIL   ${who}: ${err.message}`);
    }
  }
  console.log(`total ${total}${failed ? `, ${failed} failed (re-run to retry)` : ''}`);
  await pool.end();
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 5: Dry-run it against the local DB and the dev Clerk instance**

Run: `node -r dotenv/config scripts/migrate-clerk-buxs.js --orgs --dry-run`
Expected: a `plan   Robs -> org_…: <n>` line for each org with a balance, and a `total` line; nothing is written (`SELECT COUNT(*) FROM buxs_ledger WHERE source = 'migration' AND idem_key LIKE 'clerk-%'` is still 0).

Run: `node -r dotenv/config scripts/migrate-clerk-buxs.js --users --dry-run`
Expected: `plan` and `skip` lines, a `total`, nothing written.

Do NOT run either without `--dry-run` here: the real runs belong to Plans C and D (see the spec's Order).

- [ ] **Step 6: Commit**

```bash
git add src/lib/clerkBuxsMove.js scripts/migrate-clerk-buxs.js scripts/check-buxs.js
git commit -m "BUXS: script to move Clerk-metadata balances into OTA wallets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ship to live

This task changes the live DB and the live API. Confirm with Robert before Step 2.

**Files:** none.

- [ ] **Step 1: Generate the service secret**

Run: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
Add it to OTA's local `.env` as `BUXS_SERVICE_SECRET=<value>`.
Robert sets the same value as `BUXS_SERVICE_SECRET` on the Render OTA service (Environment). It will also go into forge's and forge-app's Vercel env in Plans C and D.

- [ ] **Step 2: Migrate live, then deploy straight away**

Run: `node scripts/run-migration.js src/db/migrate-2026-10-14-buxs-wallet.sql`
Expected: `DATABASE_URL: ok` (already applied, a no-op) and `DATABASE_URL_LIVE: ok`.

Then immediately: `git push origin main` (Render deploys `main`).

- [ ] **Step 3: Verify live**

Run Task 1 Step 3's query with `DATABASE_URL=$DATABASE_URL_LIVE` in front.
Expected: the three pairs match (a spend by the old code between migration and deploy can make `old_total` slightly larger than `wallet_total`, never smaller).

Run: `curl -s -H "X-Buxs-Secret: <secret>" "https://ota-u6ii.onrender.com/api/buxs/balance?org=<Robs org id>"`
Expected: `{"balance":<the Robs wallet>}`. Without the header: `401`.

- [ ] **Step 4: Tell Robert what's next**

- The dashboard (Plan B) still shows the balance as "tokens" and sells packs; its buyer keeps working (the `{ pack }` mapping), and its pill now shows BUXS numbers. Plan B makes the labels and the slider match.
- forge (Plan C) and forge-app (Plan D) still use Clerk metadata until their plans ship, each followed by its `migrate-clerk-buxs.js` run.
- A later cleanup migration drops `property.token_balance` and `property_token_ledger`, once Plans B–D are live.
