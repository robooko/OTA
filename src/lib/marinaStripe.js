// The one place marina code builds a Stripe client, on the property's own
// account (no Connect). A seam: scripts/check-marina-http.js replaces
// stripeFor to run the payment paths without Stripe.
function stripeFor(secretKey) {
  return require('stripe')(secretKey);
}

// sk_/rk_/pk_ + live_/test_. null = not a Stripe key.
function keyMode(key) {
  const m = /^(sk|rk|pk)_(live|test)_/.exec(key || '');
  return m ? m[2] : null;
}

module.exports = { stripeFor, keyMode };
