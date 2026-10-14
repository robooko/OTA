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
