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
  voice_call: 5000, // one AI receptionist call (Twilio minutes + up to 20 model turns)
  sms_conversation: 2500, // one day's text conversation with the receptionist (texts + model turns)
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
    `SELECT l.id, l.delta, l.balance_after, l.reason, l.ref_id, l.source, l.property_id,
            p.name AS property_name, l.created_at
     FROM buxs_ledger l LEFT JOIN property p ON p.id = l.property_id
     WHERE l.owner = $1
     ORDER BY l.created_at DESC, l.id DESC LIMIT $2`,
    [owner, limit]
  );
  return rows.map((r) => ({ ...r, delta: Number(r.delta), balance_after: Number(r.balance_after) }));
}

module.exports = {
  TOKEN_COSTS, STARTER_BALANCE, MAX_AMOUNT, InsufficientTokensError,
  checkAmount, ownerOfProperty, getWalletBalance, spendFrom, creditTo,
  getBalance, spend, credit, grantStarter, listLedger,
};
