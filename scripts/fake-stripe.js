// In-memory stand-in for the slice of Stripe the marina code uses. Tests
// flip pi.status to simulate the guest authorising the card.
const store = new Map();
let n = 0;
const fake = {
  store,
  failNextCreate: false,
  failNextCapture: false,
  paymentIntents: {
    async create(params, { idempotencyKey } = {}) {
      if (fake.failNextCreate) { fake.failNextCreate = false; throw new Error('card setup failed'); }
      const existing = [...store.values()].find((p) => p._key === idempotencyKey);
      if (existing) return existing;
      const pi = { id: `pi_fake_${++n}`, client_secret: `pi_fake_${n}_secret`, status: 'requires_payment_method', ...params, _key: idempotencyKey };
      store.set(pi.id, pi);
      return pi;
    },
    async retrieve(id) { const pi = store.get(id); if (!pi) throw new Error('No such payment_intent'); return pi; },
    async capture(id) {
      if (fake.failNextCapture) { fake.failNextCapture = false; throw new Error('capture failed'); }
      const pi = store.get(id); if (pi.status !== 'requires_capture') throw new Error(`cannot capture ${pi.status}`);
      pi.status = 'succeeded'; return pi;
    },
    async cancel(id) {
      const pi = store.get(id); if (pi.status === 'succeeded') throw new Error('cannot cancel succeeded');
      pi.status = 'canceled'; return pi;
    },
  },
  refunds: { async create({ payment_intent }) { store.get(payment_intent).refunded = true; return { id: 're_fake' }; } },
};
module.exports = fake;
