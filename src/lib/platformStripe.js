// The platform's OWN Stripe account, used to sell token packs to properties.
// Deliberately separate from property.stripe_secret_key (the venue's account,
// used for its guests' deposits/tabs) -- a Checkout Session for our fee must
// pay us, and a webhook signed by our account can only be verified with our
// secret. Env unset = billing not offered; the dashboard hides the buy
// buttons and the AI pipeline still spends the starter grant.
const key = process.env.PLATFORM_STRIPE_SECRET_KEY;
const stripe = key ? require('stripe')(key) : null;

const CURRENCY = 'gbp';

// amount is in minor units (pence). Priced inline via price_data at
// checkout so nothing has to be pre-created in the Stripe dashboard.
const TOKEN_PACKS = [
  { id: 'small', tokens: 100, amount: 1000 }, // 10p/token
  { id: 'medium', tokens: 500, amount: 4000 }, // 8p/token
  { id: 'large', tokens: 2000, amount: 12000 }, // 6p/token
];

function isBillingConfigured() {
  return !!stripe;
}

function getPack(id) {
  return TOKEN_PACKS.find((p) => p.id === id) ?? null;
}

// Verifies a webhook delivery against PLATFORM_STRIPE_WEBHOOK_SECRET. Throws
// on a bad signature (caller maps to 400) or when the secret is unset.
function constructWebhookEvent(rawBody, signatureHeader) {
  if (!stripe) throw new Error('Platform Stripe is not configured');
  const secret = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('PLATFORM_STRIPE_WEBHOOK_SECRET is not set');
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

module.exports = { stripe, CURRENCY, TOKEN_PACKS, isBillingConfigured, getPack, constructWebhookEvent };
