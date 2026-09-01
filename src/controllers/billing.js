// Platform token billing: balance, ledger, fallback settings, and buying
// packs through Stripe Checkout on the platform's account. Spending lives
// with the features that spend (lib/tokens.js spend()); this file only ever
// credits.
const pool = require('../db');
const tokens = require('../lib/tokens');
const { stripe, CURRENCY, TOKEN_PACKS, isBillingConfigured, getPack, constructWebhookEvent } = require('../lib/platformStripe');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function billingResponse(row) {
  return {
    configured: isBillingConfigured(),
    balance: row.token_balance,
    fallback_email: row.fallback_email,
    starter_balance: tokens.STARTER_BALANCE,
    costs: tokens.TOKEN_COSTS,
    currency: CURRENCY.toUpperCase(),
    packs: TOKEN_PACKS.map((p) => ({ id: p.id, tokens: p.tokens, amount: p.amount })),
  };
}

async function getBilling(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT token_balance, fallback_email FROM property WHERE id = $1', [req.property_id]);
    res.json(billingResponse(rows[0]));
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
       RETURNING token_balance, fallback_email`,
      [fallback_email !== undefined, fallback_email?.trim() || null, req.property_id]
    );
    res.json(billingResponse(rows[0]));
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
// first purchase, so receipts and the Stripe dashboard group by venue.
async function ensureStripeCustomer(propertyId) {
  const { rows: [prop] } = await pool.query('SELECT name, stripe_customer_id FROM property WHERE id = $1', [propertyId]);
  if (prop.stripe_customer_id) return prop.stripe_customer_id;
  const customer = await stripe.customers.create({ name: prop.name, metadata: { property_id: propertyId } });
  await pool.query('UPDATE property SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customer.id, propertyId]);
  return customer.id;
}

// Starts a Checkout Session for a pack. return_url is the dashboard page to
// come back to; we append billing=success&session_id=... (Stripe fills the
// placeholder) or billing=cancelled so the page can confirm/toast. The
// property id and token count ride in metadata -- that's what the webhook
// and confirmCheckout credit from, so nothing about the amount is trusted
// from the client after this point.
async function createCheckout(req, res, next) {
  try {
    if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server' });
    const { pack: packId, return_url } = req.body ?? {};
    const pack = getPack(packId);
    if (!pack) return res.status(400).json({ error: `pack must be one of ${TOKEN_PACKS.map((p) => p.id).join(', ')}` });
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
            unit_amount: pack.amount,
            product_data: { name: `${pack.tokens} tokens`, description: 'Prepaid usage tokens for AI replies and other metered features' },
          },
        },
      ],
      metadata: { property_id: req.property_id, tokens: String(pack.tokens), pack: pack.id },
      client_reference_id: req.property_id,
      success_url: `${return_url}${sep}billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${return_url}${sep}billing=cancelled`,
    });
    res.status(201).json({ url: session.url, session_id: session.id });
  } catch (err) {
    next(err);
  }
}

// Shared by the webhook and confirmCheckout. Idempotent on session.id.
async function creditFromSession(session) {
  const propertyId = session.metadata?.property_id;
  const amount = Number.parseInt(session.metadata?.tokens, 10);
  if (!propertyId || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Checkout session ${session.id} has no usable property_id/tokens metadata`);
  }
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  return tokens.credit(propertyId, amount, 'purchase', { refId: paymentIntent, checkoutSessionId: session.id });
}

// Called by the dashboard when Stripe sends the user back with
// ?session_id=. Credits if paid and not already credited by the webhook --
// so a local dev setup without webhook forwarding still works, and a live
// one doesn't show a stale balance while the webhook is in flight.
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
    const result = await creditFromSession(session);
    res.json({ ...result, paid: true, tokens: Number.parseInt(session.metadata.tokens, 10) });
  } catch (err) {
    next(err);
  }
}

// Mounted with express.raw (see app.js). Acknowledges everything it can
// verify; only a bad signature is a 4xx, so Stripe doesn't retry events we
// simply don't act on.
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
        if (result.credited) console.log(`Credited ${session.metadata.tokens} tokens to property ${session.metadata.property_id} (${session.id})`);
      } catch (err) {
        console.error(`Failed to credit checkout session ${session.id}:`, err.message);
        return res.status(500).json({ error: 'Credit failed' }); // let Stripe retry
      }
    }
  }
  res.json({ received: true });
}

module.exports = { getBilling, updateBilling, listLedger, createCheckout, confirmCheckout, handleStripeWebhook };
