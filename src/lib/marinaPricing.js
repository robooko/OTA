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

// A repeats_yearly tier (from its season) is the same days every year: its
// window moved to start in `year`, span kept, so Nov-Mar wraps New Year.
// ponytail: 29 Feb becomes e.g. '2027-02-29' -- compares right, but seasons()
// would hand the calendar a non-date; clamp to 28 Feb if a season ever uses it.
const shift = (t, year) => ({
  from: `${year}${t.valid_from.slice(4)}`,
  to: `${Number(t.valid_to.slice(0, 4)) + year - Number(t.valid_from.slice(0, 4))}${t.valid_to.slice(4)}`,
});

// Every night of [arrival, lastNight] inside the tier's window -- for a
// repeating one, the window starting in the arrival's year or the year
// before (a winter season that began last year).
function covers(t, arrival, lastNight) {
  if (!t.repeats_yearly) return t.valid_from <= arrival && lastNight <= t.valid_to;
  const y = Number(arrival.slice(0, 4));
  return [y - 1, y].some((yr) => { const w = shift(t, yr); return w.from <= arrival && lastNight <= w.to; });
}

// Each night is priced by the tier whose window holds it, so a stay can
// cross from one season into the next. A tier fits when the boat fits its
// size band. Tiers match on the BOAT's length (a deliberate change from
// Sidon's book.ts, which used the berth's); staff bookings without a boat
// length use the berth's. A night no fitting tier covers takes the berth's
// own price. With the marina's fixed_berths_flat, fixed-price berths (buoys
// next to slips) skip the tiers and keep their price all year.
const tierFor = (tiers, night, length, beam) => tiers
  .filter((t) => covers(t, night, night)
    && num(t.max_length_m) >= length
    && (t.max_beam_m == null || beam == null || num(t.max_beam_m) >= beam))
  .sort((a, b) => num(a.max_length_m) - num(b.max_length_m))[0];

const nightsOf = (arrival, departure) => Array.from({ length: nightsBetween(arrival, departure) }, (_, i) => addDays(arrival, i));

function priceStay({ berth, tiers, arrival, departure, boatLengthM, boatBeamM }) {
  if (!departure) return { nights: null, total_price: null, tier_id: null };
  const nights = nightsBetween(arrival, departure);
  const length = boatLengthM ?? num(berth.length_m);
  const fixed = berth.price_mode === 'fixed';
  const usable = fixed && tiers[0]?.fixed_berths_flat ? [] : tiers;
  const berthCents = berth.price_per_night == null ? null
    : fixed ? toCents(berth.price_per_night)
      : length == null ? null : Math.round(num(berth.price_per_night) * length * 100);

  let cents = 0;
  let firstTier = null;
  for (const [i, night] of nightsOf(arrival, departure).entries()) {
    const tier = length == null ? null : tierFor(usable, night, length, boatBeamM);
    if (i === 0) firstTier = tier;
    const c = tier ? toCents(tier.price_per_night) : berthCents;
    if (c == null) return { nights, total_price: null, tier_id: null };
    cents += c;
  }
  return { nights, total_price: fromCents(cents), tier_id: firstTier?.id ?? null };
}

// Seasons are the tiers' date windows: a marina with tiers is closed on any
// night none of them covers (the dashboard's "make berths bookable on those
// dates"). No tiers at all = berth prices year-round.
const closedFor = (tiers, arrival, departure) => tiers.length > 0
  && nightsOf(arrival, departure).some((night) => !tiers.some((t) => covers(t, night, night)));

// The open windows from today on, for a calendar: null = no tiers, open
// year-round; [] = every season is past. A repeating season shows as its
// windows starting last, this and next year that haven't ended.
function seasons(tiers, today) {
  if (!tiers.length) return null;
  const y = Number(today.slice(0, 4));
  const windows = tiers.flatMap((t) => (t.repeats_yearly ? [y - 1, y, y + 1].map((yr) => shift(t, yr)) : [{ from: t.valid_from, to: t.valid_to }]));
  const keys = new Set(windows.filter((w) => w.to >= today).map((w) => `${w.from}|${w.to}`));
  return [...keys].sort().map((k) => { const [from, to] = k.split('|'); return { from, to }; });
}

// A tier with a repeating season's dates moved to its current or next
// window, for payloads that show dates (sites compare them with today).
function datedTier(t, today) {
  if (!t.repeats_yearly) return t;
  const y = Number(today.slice(0, 4));
  const w = [y - 1, y, y + 1].map((yr) => shift(t, yr)).find((x) => x.to >= today);
  return { ...t, valid_from: w.from, valid_to: w.to };
}

module.exports = { priceStay, closedFor, seasons, datedTier, nightsBetween, addDays };
