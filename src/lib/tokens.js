// Prepaid platform-usage tokens (see migrate-2026-09-01-property-token-billing.sql).
//
// A feature that costs the platform money calls spend() before doing the
// work and takes its free fallback branch when it returns { ok: false } --
// nothing ever hard-fails on an empty balance, it just gets worse. Every
// balance change goes through here so property.token_balance and
// property_token_ledger can't drift apart.
const pool = require('../db');

// What each metered action costs. The key doubles as the ledger reason.
const TOKEN_COSTS = {
  ai_reply: 1,   // one AI-drafted enquiry reply (Anthropic call)
  reply_send: 1, // one outbound reply email (Resend call) -- charged whether
                 // the body was hand-typed or an approved AI draft, since
                 // sending costs the same either way. Separate from ai_reply:
                 // drafting and sending are two different real costs.
};

// Thrown by spend()'s callers when a metered action can't proceed on the
// current balance. Controllers map it to 402 automatically (status is read
// generically by middleware/errorHandler); the dashboard treats 402 on a
// reply-send as "open the guest's own email client instead" rather than a
// bare error.
class InsufficientTokensError extends Error {
  constructor(balance, cost) {
    super(`Not enough tokens (balance ${balance}, need ${cost})`);
    this.name = 'InsufficientTokensError';
    this.status = 402;
    this.balance = balance;
    this.cost = cost;
  }
}

// Granted once to every new property so the paid features get tried before
// anyone is asked for a card. The migration grants the same to existing ones.
const STARTER_BALANCE = Number.parseInt(process.env.TOKEN_STARTER_BALANCE ?? '20', 10);

async function getBalance(propertyId) {
  const { rows } = await pool.query('SELECT token_balance FROM property WHERE id = $1', [propertyId]);
  return rows[0]?.token_balance ?? 0;
}

// Atomically deducts TOKEN_COSTS[reason]. The WHERE token_balance >= cost
// makes concurrent spends safe without a lock: the loser's UPDATE matches
// no row and it gets { ok: false }. refId is what the tokens bought (the
// inquiry id for an AI reply) so the ledger reads as a receipt.
async function spend(propertyId, reason, refId = null) {
  const cost = TOKEN_COSTS[reason];
  if (!cost) throw new Error(`Unknown token cost: ${reason}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE property SET token_balance = token_balance - $1 WHERE id = $2 AND token_balance >= $1 RETURNING token_balance',
      [cost, propertyId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, cost, balance: await getBalance(propertyId) };
    }
    const balance = rows[0].token_balance;
    await client.query(
      'INSERT INTO property_token_ledger (property_id, delta, balance_after, reason, ref_id) VALUES ($1, $2, $3, $4, $5)',
      [propertyId, -cost, balance, reason, refId]
    );
    await client.query('COMMIT');
    return { ok: true, cost, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Adds tokens. checkoutSessionId (purchases) is the idempotency key: a
// second credit for the same session -- the webhook and the return-URL
// confirm racing, or Stripe retrying the webhook -- returns
// { credited: false } and changes nothing. The property row is locked for
// the check-then-write so two first-time credits can't both pass the
// ON CONFLICT before either commits.
async function credit(propertyId, amount, reason, { refId = null, checkoutSessionId = null } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('credit amount must be a positive integer');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [prop] } = await client.query('SELECT token_balance FROM property WHERE id = $1 FOR UPDATE', [propertyId]);
    if (!prop) throw Object.assign(new Error('Property not found'), { status: 404 });
    const balance = prop.token_balance + amount;
    const { rows: inserted } = await client.query(
      `INSERT INTO property_token_ledger (property_id, delta, balance_after, reason, ref_id, stripe_checkout_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stripe_checkout_session_id) DO NOTHING
       RETURNING id`,
      [propertyId, amount, balance, reason, refId, checkoutSessionId]
    );
    if (!inserted.length) {
      await client.query('ROLLBACK');
      return { credited: false, balance: prop.token_balance };
    }
    await client.query('UPDATE property SET token_balance = $1 WHERE id = $2', [balance, propertyId]);
    await client.query('COMMIT');
    return { credited: true, balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The free tokens a brand-new property starts with. Called from
// authenticate()'s auto-create; no-op when TOKEN_STARTER_BALANCE is 0.
async function grantStarter(propertyId) {
  if (!(STARTER_BALANCE > 0)) return { credited: false, balance: 0 };
  return credit(propertyId, STARTER_BALANCE, 'starter');
}

async function listLedger(propertyId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, delta, balance_after, reason, ref_id, created_at
     FROM property_token_ledger WHERE property_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [propertyId, limit]
  );
  return rows;
}

module.exports = { TOKEN_COSTS, STARTER_BALANCE, InsufficientTokensError, getBalance, spend, credit, grantStarter, listLedger };
