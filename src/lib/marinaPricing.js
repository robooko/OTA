const { toCents, fromCents } = require('./folio');

// One price for a stay, used by quote, booking create and the
// PaymentIntent amount so the three can never disagree (Sidon priced
// create-intent and book differently).
//
// Dates are 'YYYY-MM-DD' strings (src/db/index.js keeps DATE raw), so
// string comparison is date comparison. Departure is exclusive.

const DAY_MS = 86400000;
const nightsBetween = (arrival, departure) => Math.round((Date.parse(departure) - Date.parse(arrival)) / DAY_MS);
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY_MS).toISOString().slice(0, 10);
const num = (v) => (v == null ? null : Number(v));

// A tier covers the stay when every night falls inside [valid_from,
// valid_to] and the boat fits its size band. Tiers match on the BOAT's
// length (a deliberate change from Sidon's book.ts, which used the
// berth's); staff bookings without a boat length use the berth's.
function priceStay({ berth, tiers, arrival, departure, boatLengthM, boatBeamM }) {
  if (!departure) return { nights: null, total_price: null, tier_id: null };
  const nights = nightsBetween(arrival, departure);
  const length = boatLengthM ?? num(berth.length_m);
  const lastNight = addDays(departure, -1);

  const tier = length == null ? null : tiers
    .filter((t) => t.valid_from <= arrival && lastNight <= t.valid_to
      && num(t.max_length_m) >= length
      && (t.max_beam_m == null || boatBeamM == null || num(t.max_beam_m) >= boatBeamM))
    .sort((a, b) => num(a.max_length_m) - num(b.max_length_m))[0];

  let cents = null;
  if (tier) cents = toCents(tier.price_per_night) * nights;
  else if (berth.price_per_night != null && berth.price_mode === 'fixed') cents = toCents(berth.price_per_night) * nights;
  else if (berth.price_per_night != null && length != null) cents = Math.round(num(berth.price_per_night) * length * 100) * nights;

  return { nights, total_price: cents == null ? null : fromCents(cents), tier_id: tier?.id ?? null };
}

// Seasons are the tiers' date windows: a marina with tiers is closed on any
// night none of them covers (the dashboard's "make berths bookable on those
// dates"). No tiers at all = berth prices year-round.
const closedFor = (tiers, arrival, departure) => tiers.length > 0
  && !tiers.some((t) => t.valid_from <= arrival && addDays(departure, -1) <= t.valid_to);

// The open windows from today on, for a calendar: null = no tiers, open
// year-round; [] = every season is past.
function seasons(tiers, today) {
  if (!tiers.length) return null;
  const keys = new Set(tiers.filter((t) => t.valid_to >= today).map((t) => `${t.valid_from}|${t.valid_to}`));
  return [...keys].sort().map((k) => { const [from, to] = k.split('|'); return { from, to }; });
}

module.exports = { priceStay, closedFor, seasons, nightsBetween, addDays };
