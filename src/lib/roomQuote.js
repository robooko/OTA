// Multi-room quote: price a basket of rooms (occupancy each) for a stay,
// every room on the cheapest type that fits, at one rate (plan name) for the
// whole basket. Stateless: nothing is held. See
// docs/superpowers/specs/2026-11-07-multi-room-bookings-design.md.
const { stayNights } = require('./roomPlacement');
const { typeCounts } = require('./roomNights');
const { stayPrice, cancelDeadline, effectiveMode } = require('./ratePlans');
const { isValidDate, isValidUuid } = require('../middleware/validate');

const MAX_ROOMS = 10;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const cents = (x) => Math.round(x * 100);

// Lowest-total assignment of a type to each room: the type must fit the
// room's guests, a room's pick is forced, a type is used at most stock[t]
// times. Ties go to the order of candidates. null = nothing fits.
// ponytail: exhaustive search, fine for <=10 rooms x a handful of types.
function pickBasket(rooms, candidates, stock) {
  const order = Object.keys(candidates).sort((a, b) => candidates[a].price - candidates[b].price);
  const used = {};
  const types = [];
  let best = null;
  const walk = (i, total) => {
    if (best && total >= best.total) return;
    if (i === rooms.length) { best = { types: [...types], total }; return; }
    const { guests, pick } = rooms[i];
    for (const t of pick ? [pick] : order) {
      const c = candidates[t];
      if (!c || c.max_occupancy < guests || (used[t] ?? 0) >= (stock[t] ?? 0)) continue;
      used[t] = (used[t] ?? 0) + 1; types.push(t);
      walk(i + 1, total + c.price);
      used[t]--; types.pop();
    }
  };
  walk(0, 0);
  if (best) best.total = cents(best.total) / 100;
  return best;
}

function parseRooms(rooms) {
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > MAX_ROOMS) throw bad(`rooms must be a list of 1 to ${MAX_ROOMS} rooms`);
  return rooms.map((r, i) => {
    const adults = r?.adults; const children = r?.children ?? 0;
    if (!Number.isInteger(adults) || adults < 1) throw bad(`rooms[${i}].adults must be a whole number of at least 1`);
    if (!Number.isInteger(children) || children < 0) throw bad(`rooms[${i}].children must be a whole number of 0 or more`);
    if (r.room_type_id != null && !isValidUuid(r.room_type_id)) throw bad(`rooms[${i}].room_type_id is invalid`);
    return { adults, children, guests: adults + children, pick: r.room_type_id ?? null };
  });
}

// input: { check_in, check_out, rooms: [{ adults, children?, room_type_id? }], rate? }.
// rate omitted = cheapest; null = the no-online-payment rate (types with no plan).
async function quote(db, propertyId, input) {
  const { check_in, check_out } = input;
  if (!isValidDate(check_in) || !isValidDate(check_out)) throw bad('check_in and check_out are required (YYYY-MM-DD)');
  if (check_in >= check_out) throw bad('check_in must be before check_out');
  if (input.rate !== undefined && input.rate !== null && typeof input.rate !== 'string') throw bad('rate must be a rate name or null');
  const rooms = parseRooms(input.rooms);
  const nights = stayNights(check_in, check_out);

  const { rows: [prop] } = await db.query('SELECT currency, timezone FROM property WHERE id = $1', [propertyId]);
  const { rows: types } = await db.query(
    `SELECT id, name, max_occupancy, base_rate FROM room_type WHERE property_id = $1 AND status = 'active' ORDER BY name`, [propertyId]);
  const typeIds = types.map((t) => t.id);
  const { rows: rateRows } = await db.query(
    'SELECT room_type_id, date, rate FROM room_type_rate WHERE room_type_id = ANY($1) AND date >= $2 AND date < $3', [typeIds, check_in, check_out]);
  const { rows: plans } = await db.query(
    `SELECT * FROM rate_plan WHERE property_id = $1 AND room_type_id = ANY($2) AND status = 'active' ORDER BY sort_order, name`, [propertyId, typeIds]);
  const counts = await typeCounts(db, propertyId, null, nights);

  const stock = {};
  const typeRates = {};
  for (const t of types) {
    stock[t.id] = Math.min(...nights.map((n) => counts.get(`${t.id}|${n}`)?.sellable ?? 0));
    typeRates[t.id] = {};
  }
  for (const r of rateRows) typeRates[r.room_type_id][r.date] = parseFloat(r.rate);
  const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
  const price = (t, adj) => stayPrice(nights, typeRates[t.id], parseFloat(t.base_rate), {}, adj);

  // Rates: one per plan name (same name = same terms, enforced on save), plus
  // the unnamed rate for types without a plan.
  const rates = new Map();
  for (const p of plans) {
    const key = p.name.toLowerCase();
    if (!rates.has(key)) rates.set(key, { rate: p.name, plan: p, candidates: {} });
    const t = typeById[p.room_type_id];
    rates.get(key).candidates[t.id] ??= { price: price(t, p.adjustment_pct), max_occupancy: t.max_occupancy, plan_id: p.id };
  }
  const withPlan = new Set(plans.map((p) => p.room_type_id));
  const none = { rate: null, plan: null, candidates: {} };
  for (const t of types) if (!withPlan.has(t.id)) none.candidates[t.id] = { price: price(t, null), max_occupancy: t.max_occupancy, plan_id: null };
  if (Object.keys(none.candidates).length) rates.set(null, none);

  const head = { check_in, check_out, nights: nights.length, currency: prop.currency };
  const unavailable = (list) => ({ ...head, available: false, rate: null, total: null, terms: null, rates: [], rooms: [], unavailable: list });
  const maxOcc = Math.max(0, ...types.map((t) => t.max_occupancy));
  const tooBig = rooms.map((r, i) => (r.guests > maxOcc ? { room: i, reason: 'too_many_guests' } : null)).filter(Boolean);
  if (tooBig.length) return unavailable(tooBig);

  const now = new Date();
  const termsOf = (plan) => {
    if (!plan) return null;
    const deadline = plan.refundable ? cancelDeadline(check_in, prop.timezone, plan.cancel_cutoff_hours) : null;
    return {
      name: plan.name, refundable: plan.refundable, cancel_cutoff_hours: plan.cancel_cutoff_hours,
      cancel_deadline: deadline ? deadline.toISOString() : null,
      payment_mode: effectiveMode(plan, deadline, now),
      deposit_kind: plan.deposit_kind, deposit_value: plan.deposit_value == null ? null : Number(plan.deposit_value),
    };
  };
  const feasible = [];
  for (const r of rates.values()) {
    const best = pickBasket(rooms, r.candidates, stock);
    if (best) feasible.push({ ...r, best });
  }
  if (!feasible.length) return unavailable([{ room: null, reason: 'not_enough_rooms' }]);
  feasible.sort((a, b) => a.best.total - b.best.total);

  // A requested rate that can't place the basket falls back to the cheapest;
  // the response's rate says which one it is.
  const wanted = input.rate === undefined ? undefined : input.rate === null ? null : input.rate.toLowerCase();
  const sel = feasible.find((o) => wanted !== undefined && (o.rate === null ? wanted === null : o.rate.toLowerCase() === wanted)) ?? feasible[0];
  const chosen = sel.best.types;

  return {
    ...head,
    available: true,
    rate: sel.rate,
    total: sel.best.total,
    terms: termsOf(sel.plan),
    rates: feasible.map((o) => ({ rate: o.rate, total: o.best.total, terms: termsOf(o.plan) })),
    rooms: rooms.map((r, i) => {
      const t = chosen[i]; const c = sel.candidates[t];
      const others = chosen.filter((_, j) => j !== i);
      return {
        adults: r.adults, children: r.children, guests: r.guests,
        room_type_id: t, room_type_name: typeById[t].name, rate_plan_id: c.plan_id, price: c.price,
        options: Object.entries(sel.candidates)
          .filter(([id, o]) => id !== t && o.max_occupancy >= r.guests && others.filter((x) => x === id).length + 1 <= stock[id])
          .sort(([, a], [, b]) => a.price - b.price)
          .map(([id, o]) => ({
            room_type_id: id, room_type_name: typeById[id].name, rate_plan_id: o.plan_id, price: o.price,
            delta: (cents(o.price) - cents(c.price)) / 100,
          })),
      };
    }),
    unavailable: [],
  };
}

module.exports = { MAX_ROOMS, pickBasket, parseRooms, quote };
