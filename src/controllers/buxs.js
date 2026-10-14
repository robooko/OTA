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
