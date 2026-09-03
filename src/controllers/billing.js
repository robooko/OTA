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
    // Set (with PLATFORM_STRIPE_PUBLISHABLE_KEY) to let the dashboard take
    // payment in-page with Stripe Elements; when null it falls back to
    // redirecting to Stripe Checkout. Must be the same account as the
    // secret key or confirmPayment will reject the client_secret.
    publishable_key: isBillingConfigured() ? process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY || null : null,
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

// The Elements path: the dashboard collects the card in-page against this
// intent's client_secret instead of redirecting to Checkout. metadata
// carries property_id/tokens just like a Checkout Session's does -- after
// creation the two flows credit identically and nothing about the amount is
// trusted from the client.
async function createPaymentIntent(req, res, next) {
  try {
    if (!isBillingConfigured()) return res.status(503).json({ error: 'Billing is not configured on this server' });
    const pack = getPack(req.body?.pack);
    if (!pack) return res.status(400).json({ error: `pack must be one of ${TOKEN_PACKS.map((p) => p.id).join(', ')}` });

    const customer = await ensureStripeCustomer(req.property_id);
    const intent = await stripe.paymentIntents.create({
      amount: pack.amount,
      currency: CURRENCY,
      customer,
      metadata: { property_id: req.property_id, tokens: String(pack.tokens), pack: pack.id },
      automatic_payment_methods: { enabled: true },
      description: `${pack.tokens} tokens`,
    });
    res.status(201).json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount: pack.amount, tokens: pack.tokens });
  } catch (err) {
    next(err);
  }
}

// Idempotent on the intent id -- stored in the ledger's unique
// stripe_checkout_session_id column, which both purchase flows use as
// "the Stripe object that paid" (cs_... or pi_...).
async function creditFromIntent(intent) {
  const propertyId = intent.metadata?.property_id;
  const amount = Number.parseInt(intent.metadata?.tokens, 10);
  if (!propertyId || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Payment intent ${intent.id} has no usable property_id/tokens metadata`);
  }
  return tokens.credit(propertyId, amount, 'purchase', { refId: intent.id, checkoutSessionId: intent.id });
}

// Called by the dashboard right after confirmPayment succeeds (or on the
// return from a redirect-based payment method). Same belt-and-braces role
// as confirmCheckout: idempotent against the webhook.
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
    const result = await creditFromIntent(intent);
    res.json({ ...result, paid: true, tokens: Number.parseInt(intent.metadata.tokens, 10) });
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
  // The Elements flow. Only intents we created carry tokens metadata --
  // a Checkout purchase's underlying intent doesn't (its metadata lives on
  // the session), so a Checkout payment can't credit twice via both events.
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    if (intent.metadata?.tokens) {
      try {
        const result = await creditFromIntent(intent);
        if (result.credited) console.log(`Credited ${intent.metadata.tokens} tokens to property ${intent.metadata.property_id} (${intent.id})`);
      } catch (err) {
        console.error(`Failed to credit payment intent ${intent.id}:`, err.message);
        return res.status(500).json({ error: 'Credit failed' }); // let Stripe retry
      }
    }
  }
  res.json({ received: true });
}

module.exports = { getBilling, updateBilling, listLedger, createCheckout, confirmCheckout, createPaymentIntent, confirmPaymentIntent, handleStripeWebhook };
