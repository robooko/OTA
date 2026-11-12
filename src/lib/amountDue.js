const pool = require('../db');
const { isValidUuid, isValidDate } = require('../middleware/validate');
const { toCents, fromCents } = require('./folio');
const { memberRateUntil, resolveRate } = require('./spaMemberRate');

// What a prospective booking must have paid at booking, by the venue's rule:
// golf course and equipment payment_required (none / full), restaurant
// payment_protection (none / hold / deposit, per table or per guest), spa
// payment_required (none / deposit / full, deposit capped at the price).
// Priced exactly as each create path prices the booking it stores. See
// docs/superpowers/plans/2026-11-12-entity-charges-3-enforcement.md.

const bad = (error) => ({ status: 400, error });
const notFound = (what) => ({ status: 404, error: `${what} not found` });
const positiveInt = (v) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isInteger(n) && n > 0 ? n : null;
};
const answer = (mode, priceCents, dueCents, currency) => ({
  mode,
  price: priceCents == null ? null : fromCents(priceCents),
  due_now: fromCents(dueCents),
  currency,
});

const KINDS = {
  async golf_booking(db, propertyId, { tee_time_id, players }) {
    const n = positiveInt(players);
    if (!n) return bad('players must be a positive integer');
    if (!isValidUuid(tee_time_id)) return notFound('Tee time');
    const { rows: [r] } = await db.query(
      `SELECT gc.price_per_player, gc.payment_required, p.currency
       FROM tee_time tt JOIN golf_course gc ON gc.id = tt.course_id JOIN property p ON p.id = tt.property_id
       WHERE tt.id = $1 AND tt.property_id = $2`,
      [tee_time_id, propertyId]
    );
    if (!r) return notFound('Tee time');
    const price = toCents(r.price_per_player) * n;
    return answer(r.payment_required, price, r.payment_required === 'full' ? price : 0, r.currency);
  },

  // Same validation and rounding as createHire (controllers/equipment.js).
  async equipment_hire(db, propertyId, { equipment_id, quantity, rate_type = 'per_day', duration = 1 }) {
    const n = positiveInt(quantity);
    if (!n) return bad('quantity must be a positive integer');
    if (!['per_day', 'per_hour'].includes(rate_type)) return bad('rate_type must be per_day or per_hour');
    const d = Math.round(Number(duration) * 100) / 100;
    if (!(d > 0 && d <= 999.99)) return bad('duration must be from 0.01 to 999.99');
    if (!isValidUuid(equipment_id)) return notFound('Equipment');
    const { rows: [r] } = await db.query(
      `SELECT e.price_per_day, e.price_per_hour, e.payment_required, p.currency
       FROM equipment e JOIN property p ON p.id = e.property_id WHERE e.id = $1 AND e.property_id = $2`,
      [equipment_id, propertyId]
    );
    if (!r) return notFound('Equipment');
    const rate = rate_type === 'per_hour' ? parseFloat(r.price_per_hour || 0) : parseFloat(r.price_per_day || 0);
    const price = toCents((rate * n * d).toFixed(2));
    return answer(r.payment_required, price, r.payment_required === 'full' ? price : 0, r.currency);
  },

  // A table has no price; a 'hold' is a card hold, nothing taken now.
  async restaurant_reservation(db, propertyId, { restaurant_id, party_size }) {
    const n = positiveInt(party_size);
    if (!n) return bad('party_size must be a positive integer');
    if (!isValidUuid(restaurant_id)) return notFound('Restaurant');
    const { rows: [r] } = await db.query(
      `SELECT r.payment_protection, r.payment_protection_amount, r.payment_protection_basis,
              COALESCE(r.currency, p.currency) AS currency
       FROM restaurant r JOIN property p ON p.id = r.property_id WHERE r.id = $1 AND r.property_id = $2`,
      [restaurant_id, propertyId]
    );
    if (!r) return notFound('Restaurant');
    if (r.payment_protection !== 'deposit') return answer(r.payment_protection, null, 0, r.currency);
    const per = toCents(r.payment_protection_amount ?? 0);
    return answer('deposit', null, r.payment_protection_basis === 'per_guest' ? per * n : per, r.currency);
  },

  // The price bookFromAvailability freezes (regulars' rate included).
  async spa_appointment(db, propertyId, { spa_id, treatment_id, date, member_email = null }) {
    if (!isValidDate(date)) return bad('date must be YYYY-MM-DD');
    if (!isValidUuid(spa_id) || !isValidUuid(treatment_id)) return notFound('Treatment');
    const { rows: [t] } = await db.query(
      `SELECT st.price, st.member_price, st.duration_mins, st.member_duration_mins,
              s.payment_required, s.deposit_amount, p.currency
       FROM spa_treatment st JOIN spa s ON s.id = st.spa_id JOIN property p ON p.id = st.property_id
       WHERE st.id = $1 AND st.spa_id = $2 AND st.property_id = $3 AND st.status = 'active'`,
      [treatment_id, spa_id, propertyId]
    );
    if (!t) return notFound('Treatment');
    const rate = resolveRate(t, await memberRateUntil(db, propertyId, member_email), date);
    if (!rate.ok) return { status: 409, error: rate.code };
    return spaAnswer(t, toCents(rate.price));
  },
};

// A spa's rule applied to a known price (also used by the legacy slot path,
// which books at the standard price).
function spaAnswer(spa, priceCents) {
  const mode = spa.payment_required;
  const due = mode === 'full' ? priceCents : mode === 'deposit' ? Math.min(toCents(spa.deposit_amount), priceCents) : 0;
  return answer(mode, priceCents, due, spa.currency);
}

// { mode, price, due_now, currency } or { status, error }. db: the pool or a
// transaction client. params as the kind's create body names them.
async function dueNow(db, kind, propertyId, params = {}) {
  if (!Object.hasOwn(KINDS, kind)) return { status: 404, error: 'Unknown kind' };
  return KINDS[kind](db ?? pool, propertyId, params);
}

module.exports = { dueNow, spaAnswer };
