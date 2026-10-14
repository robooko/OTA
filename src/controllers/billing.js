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
