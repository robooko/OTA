// OTA does its money maths in cents (toCents/fromCents in ./folio). Stripe
// takes amounts in the currency's smallest unit, and zero-decimal currencies
// have no minor unit: 153,000 XPF is amount 153000, not 15300000. Convert at
// the Stripe boundary only -- every amount sent to or read back from Stripe.
// https://docs.stripe.com/currencies#zero-decimal (UGX and ISK are left out:
// Stripe takes them as two-decimal amounts divisible by 100.)
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

const isZeroDecimal = (currency) => ZERO_DECIMAL.has(String(currency).toLowerCase());

// Cents -> Stripe amount.
function toStripeAmount(cents, currency) {
  return isZeroDecimal(currency) ? Math.round(cents / 100) : cents;
}

// Stripe amount -> cents.
function fromStripeAmount(amount, currency) {
  return isZeroDecimal(currency) ? amount * 100 : amount;
}

module.exports = { toStripeAmount, fromStripeAmount };
