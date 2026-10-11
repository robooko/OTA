const pool = require('../db');
const crypto = require('crypto');
const { isValidDate, isValidUuid } = require('../middleware/validate');
const q = require('../lib/marinaQueries');
const { priceStay, addDays } = require('../lib/marinaPricing');
const guard = require('../lib/marinaGuard');
const { berthFitError } = guard;
const life = require('../lib/marinaLifecycle');
const { bookingToken, bookingTokenMatches } = require('../lib/marinaToken');
const { createSubscribeTokenRequest } = require('../lib/ably');

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

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Wrong or missing token -> 404, so a booking id alone reveals nothing.
async function requireBookingToken(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidUuid(id) || !bookingTokenMatches(id, req.get('X-Booking-Token'))) return res.status(404).json({ error: 'Booking not found' });
    const b = await q.joinedBooking(pool, id);
    if (!b || b.marina_id !== req.marina.id) return res.status(404).json({ error: 'Booking not found' });
    req.booking = b;
    next();
  } catch (err) { next(err); }
}

// What the guest's booking page may see. No staff notes, no PI ids.
function guestView(b) {
  return {
    id: b.id, status: b.status, berth_label: b.berth_label, marina_name: b.marina_name,
    arrival: b.arrival, departure: b.departure, contact_name: b.contact_name, contact_email: b.contact_email,
    boat_name: b.boat_name, boat_length_m: b.boat_length_m, boat_beam_m: b.boat_beam_m,
    total_price: b.total_price, currency: b.currency, payment_status: b.payment_status,
    hold_expires_at: b.hold_expires_at, locale: b.locale, doc_count: b.doc_count,
  };
}

async function createGuestBooking(req, res, next) {
  const client = await pool.connect();
  let committed = null;
  try {
    const today = await q.propertyToday(client, req.property_id);
    // Staff (bearer) use POST /api/marina/bookings; this route is the guest rail only.
    if (req.auth_method !== 'api_key') return res.status(403).json({ error: 'Use POST /api/marina/bookings for staff bookings' });
    const parsed = guard.validateGuestBooking(req.body, today);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;

    await client.query('BEGIN');
    const { rows: [berth] } = await client.query("SELECT * FROM marina_berth WHERE marina_id = $1 AND label = $2 AND status = 'active'", [req.marina.id, v.berth_label]);
    if (!berth) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Berth not found' }); }
    const fit = guard.berthFitError(berth, v.boat_length_m, v.boat_beam_m);
    if (fit) { await client.query('ROLLBACK'); return res.status(400).json({ error: fit }); }
    const cap = await guard.checkEmailCap(client, req.property_id, v.contact_email, today);
    if (!cap.ok) { await client.query('ROLLBACK'); return res.status(429).json({ error: `At most ${guard.MAX_UPCOMING} upcoming bookings per email` }); }

    const price = priceStay({ berth, tiers: await q.activeTiers(client, req.marina.id), arrival: v.arrival, departure: v.departure, boatLengthM: v.boat_length_m, boatBeamM: v.boat_beam_m });
    const { rows: [prop] } = await client.query('SELECT upper(currency) AS currency, stripe_secret_key, stripe_publishable_key FROM property WHERE id = $1', [req.property_id]);
    const cardPath = price.total_price != null && prop.stripe_secret_key && prop.stripe_publishable_key;
    const confirmToken = cardPath ? null : crypto.randomBytes(32).toString('base64url');

    const { rows: [row] } = await client.query(
      `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, contact_email, contact_phone, contact_email_key,
         boat_name, boat_length_m, boat_beam_m, arrival, departure, status, source, locale, total_price, currency,
         hold_expires_at, confirm_token_hash, client_ip, user_agent, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'hold','guest',$13,$14,$15, now() + make_interval(mins => $16), $17, $18, $19, $20)
       RETURNING id`,
      [req.property_id, req.marina.id, berth.id, v.contact_name, v.contact_email, v.contact_phone, cap.key,
        v.boat_name, v.boat_length_m, v.boat_beam_m, v.arrival, v.departure, v.locale, price.total_price, prop.currency,
        guard.HOLD_MINUTES, confirmToken && hashToken(confirmToken), guard.clientIp(req), req.get('User-Agent')?.slice(0, 500) ?? null, v.notes]);
    await client.query('COMMIT');
    committed = row.id;

    let payment = null;
    // (Task 9: when cardPath, create the PaymentIntent here; on failure cancel the hold and 502.)
    const booking = await q.joinedBooking(pool, row.id);
    if (!cardPath) life.afterChange(null, { ...booking, _confirmToken: confirmToken }); // Task 8 emails the confirm link
    res.status(201).json({ booking: guestView(booking), booking_token: bookingToken(row.id), payment });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23P01') return res.status(409).json({ error: 'That berth is no longer available for those dates' });
    next(err);
  } finally { client.release(); }
}

async function getGuestBooking(req, res, next) {
  try {
    const payment = null; // (Task 9: client_secret while hold with a PI)
    res.json({ booking: guestView(req.booking), payment });
  } catch (err) { next(err); }
}

async function cancelGuestBooking(req, res, next) {
  try {
    const r = await life.cancelBooking(req.booking.id, { by: 'guest', reason: 'cancelled by guest' });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ booking: guestView(r.booking) });
  } catch (err) { next(err); }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`;

// Unauthenticated email-confirm link (spa pattern): emailed as an absolute
// OTA URL, never through a forwarder. hold -> pending, then on to the
// marina's booking page when it has one.
async function confirmBookingLink(req, res, next) {
  try {
    const { id, confirmToken } = req.params;
    if (!isValidUuid(id)) return res.status(404).send(page('Link not valid', 'That link is no longer valid.'));
    const r = await life.withLockedBooking(id, async (client, row) => {
      if (!row.confirm_token_hash || !crypto.timingSafeEqual(Buffer.from(hashToken(confirmToken)), Buffer.from(row.confirm_token_hash))) return life.fail(404, 'invalid');
      if (row.status !== 'hold') return life.fail(200, row.status); // already confirmed or released
      if (row.lapsed) { await life.setRow(client, id, { status: 'cancelled', cancel_reason: 'expired', hold_expires_at: null }); return { ok: true, booking: true }; }
      return { ok: true, booking: await life.toPending(client, row) };
    });
    if (!r.ok && r.status === 404) return res.status(404).send(page('Link not valid', 'That link is no longer valid.'));
    const b = r.ok ? r.booking : await q.joinedBooking(pool, id);
    if (b.status === 'cancelled') return res.status(410).send(page('Booking released', "This booking wasn't confirmed in time, so the berth was released. Please book again."));
    if (b.booking_url) return res.redirect(303, b.booking_url.replace('{id}', b.id).replace('{token}', bookingToken(b.id)));
    res.send(page('Request received', `Thanks — ${b.marina_name} has your request for berth ${b.berth_label} and will reply soon.`));
  } catch (err) { next(err); }
}

async function ablyToken(req, res, next) {
  try {
    const t = await createSubscribeTokenRequest(`marina-booking:${req.booking.id}`);
    if (!t) return res.status(503).json({ error: 'Live updates are not configured' });
    res.json(t);
  } catch (err) { next(err); }
}

module.exports = {
  resolveMarina, getMarinaMap, getAvailability, getDocRequirements, quote,
  requireBookingToken, guestView, createGuestBooking, getGuestBooking, cancelGuestBooking, confirmBookingLink, ablyToken,
};
