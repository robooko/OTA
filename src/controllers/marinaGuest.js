const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const q = require('../lib/marinaQueries');
const { priceStay, addDays } = require('../lib/marinaPricing');
const { berthFitError } = require('../lib/marinaGuard');

// Guest routes: /api/marina/guest/:marina/... -- the only prefix a site's
// forwarder passes through. On the key rail the guest rules apply; a
// bearer (the dashboard's own forwarder) gets staff behaviour on reads.

async function resolveMarina(req, res, next) {
  try {
    const m = await q.marinaBySlug(pool, req.property_id, req.params.marina);
    if (!m) return res.status(404).json({ error: 'Marina not found' });
    req.marina = m;
    next();
  } catch (err) { next(err); }
}

// The map payload. Whitelisted: nothing else from marina or property.
async function getMarinaMap(req, res, next) {
  try {
    const m = req.marina;
    let { from, to } = req.query;
    if (from || to) {
      if (!isValidDate(from) || !isValidDate(to) || to <= from) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD with to after from' });
    } else {
      from = await q.propertyToday(pool, m.property_id);
      to = addDays(from, 1);
    }
    const [pontoons, berths, tiers, pois, images, prop, avail] = await Promise.all([
      pool.query("SELECT id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order FROM marina_pontoon WHERE marina_id = $1 AND status = 'active' ORDER BY sort_order, name", [m.id]),
      pool.query("SELECT id, label, pontoon_id, lat, lng, rotation, length_m, min_length_m, beam_m, depth_m, price_per_night, price_mode FROM marina_berth WHERE marina_id = $1 AND status <> 'inactive' ORDER BY label", [m.id]),
      pool.query("SELECT valid_from, valid_to, max_length_m, max_beam_m, price_per_night, price_per_month, price_per_year FROM marina_price_tier WHERE marina_id = $1 AND status = 'active' ORDER BY valid_from, max_length_m", [m.id]),
      pool.query("SELECT label, type, lat, lng FROM marina_poi WHERE marina_id = $1 AND status = 'active'", [m.id]),
      pool.query("SELECT url, description FROM marina_image WHERE marina_id = $1 AND status = 'active' ORDER BY sort_order", [m.id]),
      pool.query('SELECT upper(currency) AS currency, stripe_publishable_key FROM property WHERE id = $1', [m.property_id]),
      q.berthAvailability(pool, m.id, from, to),
    ]);
    res.json({
      marina: {
        name: m.name, slug: m.slug, description: m.description, lat: m.lat, lng: m.lng,
        phone: m.phone, email: m.email, website: m.website,
        layout: m.layout_svg ? { svg: m.layout_svg, sw_lat: m.layout_sw_lat, sw_lng: m.layout_sw_lng, ne_lat: m.layout_ne_lat, ne_lng: m.layout_ne_lng, rotation: m.layout_rotation } : null,
      },
      pontoons: pontoons.rows,
      berths: berths.rows.map(({ id, ...b }) => ({ ...b, available: avail.get(id) === true })),
      price_tiers: tiers.rows,
      pois: pois.rows,
      images: images.rows,
      currency: prop.rows[0].currency,
      stripe_publishable_key: prop.rows[0].stripe_publishable_key,
    });
  } catch (err) { next(err); }
}

const parseLen = (v) => (v === undefined || v === '' ? null : Number(v));

async function getAvailability(req, res, next) {
  try {
    const { arrival, departure } = req.query;
    const len = parseLen(req.query.boat_length_m);
    const beam = parseLen(req.query.boat_beam_m);
    if (!isValidDate(arrival) || !isValidDate(departure) || departure <= arrival) return res.status(400).json({ error: 'arrival and departure must be YYYY-MM-DD with departure after arrival' });
    if (!(len > 0)) return res.status(400).json({ error: 'boat_length_m must be a positive number' });
    if (beam !== null && !(beam > 0)) return res.status(400).json({ error: 'boat_beam_m must be a positive number' });
    const [berths, tiers] = await Promise.all([q.freeBerths(pool, req.marina.id, arrival, departure), q.activeTiers(pool, req.marina.id)]);
    res.json(berths
      .filter((b) => !berthFitError(b, len, beam))
      .map((b) => ({ label: b.label, pontoon_id: b.pontoon_id, length_m: b.length_m, beam_m: b.beam_m, depth_m: b.depth_m,
        ...priceStay({ berth: b, tiers, arrival, departure, boatLengthM: len, boatBeamM: beam }) })));
  } catch (err) { next(err); }
}

async function getDocRequirements(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT id, type, name, description, fields, mandatory FROM marina_doc_requirement WHERE marina_id = $1 AND status = 'active' ORDER BY sort_order, name", [req.marina.id]);
    res.json(rows);
  } catch (err) { next(err); }
}

async function quote(req, res, next) {
  try {
    const { berth_label, arrival, departure } = req.body || {};
    const len = parseLen(req.body?.boat_length_m);
    const beam = parseLen(req.body?.boat_beam_m);
    if (!isValidDate(arrival) || !isValidDate(departure) || departure <= arrival) return res.status(400).json({ error: 'arrival and departure must be YYYY-MM-DD with departure after arrival' });
    if (!(len > 0)) return res.status(400).json({ error: 'boat_length_m must be a positive number' });
    const { rows: [berth] } = await pool.query("SELECT * FROM marina_berth WHERE marina_id = $1 AND label = $2 AND status <> 'inactive'", [req.marina.id, berth_label]);
    if (!berth) return res.status(404).json({ error: 'Berth not found' });
    const fit = berthFitError(berth, len, beam);
    if (fit) return res.status(400).json({ error: fit });
    const price = priceStay({ berth, tiers: await q.activeTiers(pool, req.marina.id), arrival, departure, boatLengthM: len, boatBeamM: beam });
    const { rows: [p] } = await pool.query('SELECT upper(currency) AS currency FROM property WHERE id = $1', [req.marina.property_id]);
    res.json({ berth_label: berth.label, arrival, departure, ...price, currency: p.currency });
  } catch (err) { next(err); }
}

module.exports = { resolveMarina, getMarinaMap, getAvailability, getDocRequirements, quote };
