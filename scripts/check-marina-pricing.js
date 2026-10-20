// Pure check of src/lib/marinaPricing.js (no DB): per-night season pricing,
// stays across a season boundary, closed nights, fixed_berths_flat.
//   node scripts/check-marina-pricing.js
const assert = require('assert');
const { priceStay, closedFor } = require('../src/lib/marinaPricing');

const season = (from, to, price, extra = {}) => ({ id: `${from}:${price}`, valid_from: from, valid_to: to, repeats_yearly: true, max_length_m: '20', max_beam_m: null, price_per_night: String(price), ...extra });
const high = season('2026-12-15', '2027-04-15', 300);
const autumn = season('2026-11-01', '2026-12-14', 200);
const rest = season('2026-04-16', '2026-10-31', 100);
const tiers = [high, autumn, rest];
const slip = { price_mode: 'per_metre', price_per_night: '15', length_m: '14' };
const buoy = { price_mode: 'fixed', price_per_night: '40', length_m: '18' };
const stay = (berth, arrival, departure, t = tiers) => priceStay({ berth, tiers: t, arrival, departure, boatLengthM: 12 }).total_price;

// Inside one season.
assert.strictEqual(stay(slip, '2026-11-10', '2026-11-12'), '400.00');
// Across a boundary: 13, 14 Dec autumn + 15, 16 Dec high.
assert.strictEqual(stay(slip, '2026-12-13', '2026-12-17'), '1000.00');
assert.strictEqual(closedFor(tiers, '2026-12-13', '2026-12-17'), false);
// Repeating season wraps New Year, and next year's windows.
assert.strictEqual(stay(slip, '2027-12-31', '2028-01-02'), '600.00');
// A night no season covers closes the stay; no tiers = open.
assert.strictEqual(closedFor([high], '2026-12-13', '2026-12-16'), true);
assert.strictEqual(closedFor([], '2026-12-13', '2026-12-16'), false);
// Boat too big for every band: the berth's own price (12 m x 15).
assert.strictEqual(priceStay({ berth: slip, tiers, arrival: '2026-11-10', departure: '2026-11-11', boatLengthM: 25 }).total_price, '375.00');
// Buoys follow the tiers by default (fox-mooring) ...
assert.strictEqual(stay(buoy, '2026-11-10', '2026-11-12'), '400.00');
// ... and keep their fixed price with fixed_berths_flat.
const flat = tiers.map((t) => ({ ...t, fixed_berths_flat: true }));
assert.strictEqual(stay(buoy, '2026-12-13', '2026-12-17', flat), '160.00');
assert.strictEqual(stay(slip, '2026-12-13', '2026-12-17', flat), '1000.00');
console.log('marina pricing ok');
