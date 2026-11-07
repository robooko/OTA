const crypto = require('crypto');
const pool = require('../db');
const { isValidDate, isValidUuid } = require('../middleware/validate');
const { publishNewBooking, publishBookingStatusChanged } = require('../lib/ably');
const { listOpenRoomBaskets } = require('../lib/roomBaskets');
const { computeFolio, toCents } = require('../lib/folio');
const { stayPrice, termsSnapshot, guestCancelDecision, PAY_WINDOW_MINUTES } = require('../lib/ratePlans');
const roomEmails = require('../lib/roomBookingEmails');
const roomPayments = require('../lib/roomPayments');
const housekeeping = require('../lib/housekeeping');
const { fetchJoinedBooking, CANCEL_SCORE_SQL, NIGHTS_SQL } = roomPayments;
const { stayNights } = require('../lib/roomPlacement');
const roomNights = require('../lib/roomNights');

// How a direct booking came in. Channel bookings leave it null (channel_id).
const SOURCES = ['web', 'phone', 'email', 'walk_in', 'agent', 'ota', 'corporate'];
const SOURCE_ERROR = `source must be one of ${SOURCES.join(', ')}`;

function isValidMetadata(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function listBookings(req, res, next) {
  try {
    const { status, guest_id, from, to, on, created_from, created_to, skip, take, channel_id, source } = req.query;
    if (source && !SOURCES.includes(source)) return res.status(400).json({ error: SOURCE_ERROR });
    if (channel_id && channel_id !== 'direct' && !isValidUuid(channel_id)) {
      return res.status(400).json({ error: "channel_id must be a channel id or 'direct'" });
    }
    let query = `
      SELECT b.*, g.first_name, g.last_name, g.email, g.phone,
             r.room_number, r.floor,
             rt.id AS room_type_id, rt.name AS room_type_name, rt.code AS room_type_code,
             rt.description AS room_type_description, rt.max_occupancy, rt.base_rate,
             ${CANCEL_SCORE_SQL}, ${NIGHTS_SQL},
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', be.id,
                   'extra_id', be.extra_id,
                   'name', e.name,
                   'quantity', be.quantity,
                   'unit_price', be.unit_price,
                   'total', (be.quantity * be.unit_price)
                 )
               ) FILTER (WHERE be.id IS NOT NULL), '[]'
             ) AS extras
      FROM booking b
      JOIN guest g      ON g.id  = b.guest_id
      LEFT JOIN room r       ON r.id  = b.room_id
      JOIN room_type rt ON rt.id = b.room_type_id
      LEFT JOIN booking_extra be ON be.booking_id = b.id
      LEFT JOIN extra e          ON e.id = be.extra_id
      WHERE b.property_id = $1
    `;
    const params = [req.property_id];
    let countQuery = 'SELECT COUNT(*) AS total FROM booking b WHERE b.property_id = $1';

    if (status) { params.push(status); query += ` AND b.status = $${params.length}`; countQuery += ` AND b.status = $${params.length}`; }
    // channel_id: one channel's bookings, or 'direct' for bookings made in OTA.
    if (channel_id === 'direct') { query += ' AND b.channel_id IS NULL'; countQuery += ' AND b.channel_id IS NULL'; }
    else if (channel_id) { params.push(channel_id); query += ` AND b.channel_id = $${params.length}`; countQuery += ` AND b.channel_id = $${params.length}`; }
    if (source) { params.push(source); query += ` AND b.source = $${params.length}`; countQuery += ` AND b.source = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND b.guest_id = $${params.length}`; countQuery += ` AND b.guest_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND b.check_in >= $${params.length}`; countQuery += ` AND b.check_in >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND b.check_out <= $${params.length}`; countQuery += ` AND b.check_out <= $${params.length}`; }
    // on: stays touching that date -- arriving, in-house or departing (the
    // room-bookings day bar). Unlike from/to, which keep stays inside a range.
    // on_kind narrows it to that day's arrivals or departures.
    if (on) {
      if (!isValidDate(on)) return res.status(400).json({ error: 'on must be YYYY-MM-DD' });
      const kind = req.query.on_kind;
      if (kind && kind !== 'arrivals' && kind !== 'departures') return res.status(400).json({ error: "on_kind must be 'arrivals' or 'departures'" });
      params.push(on);
      const n = `$${params.length}`;
      const cond = kind === 'arrivals' ? ` AND b.check_in = ${n}` : kind === 'departures' ? ` AND b.check_out = ${n}` : ` AND b.check_in <= ${n} AND b.check_out >= ${n}`;
      query += cond; countQuery += cond;
    }
    // created_from/created_to are the main dashboard's Room total revenue
    // stat and Sales this week chart -- when the booking was made, not
    // when the stay happens (from/to above), same "revenue today" meaning
    // as restaurant-orders/proshop-orders' own date_from/date_to.
    if (created_from) { params.push(created_from); query += ` AND b.created_at::date >= $${params.length}`; countQuery += ` AND b.created_at::date >= $${params.length}`; }
    if (created_to)   { params.push(created_to);   query += ` AND b.created_at::date <= $${params.length}`; countQuery += ` AND b.created_at::date <= $${params.length}`; }

    const filterParams = [...params]; // snapshot before pagination params are appended below

    query += ' GROUP BY b.id, g.first_name, g.last_name, g.email, g.phone, r.room_number, r.floor, rt.id, rt.name, rt.code, rt.description, rt.max_occupancy, rt.base_rate';
    query += ' ORDER BY b.created_at DESC';

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, filterParams),
    ]);

    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT b.*,
              g.first_name, g.last_name, g.email, g.phone,
              r.room_number, r.floor, r.status AS room_status,
              rt.id AS room_type_id, rt.name AS room_type_name, rt.code AS room_type_code, rt.base_rate,
              ${CANCEL_SCORE_SQL}, ${NIGHTS_SQL}
       FROM booking b
       JOIN guest     g  ON g.id  = b.guest_id
       LEFT JOIN room      r  ON r.id  = b.room_id
       JOIN room_type rt ON rt.id = b.room_type_id
       WHERE b.id = $1 AND b.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows: extras } = await pool.query(
      `SELECT be.id, be.extra_id, be.quantity, be.unit_price,
              e.name, e.description,
              (be.quantity * be.unit_price) AS total
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.id]
    );

    res.json({ ...rows[0], extras });
  } catch (err) {
    next(err);
  }
}

// Multi-room bookings: up to MAX_ROOMS rooms in one request, booked all or
// nothing as one group with one rate (see the 2026-11-07 multi-room spec).
const MAX_ROOMS = 10;
const httpError = (status, message, details) => Object.assign(new Error(message), { status, ...(details && { details }) });

// One room of a booking request, checked and priced but not yet written.
async function priceStay(client, req, { stay, check_in, check_out, nights, viaApiKey }) {
  const { room_id, room_type_id, rate_plan_id } = stay;
  let type;
  if (room_id) {
    const { rows } = await client.query(
      `SELECT r.status, r.room_type_id AS id, rt.base_rate, rt.max_occupancy
       FROM room r JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1 AND r.property_id = $2`,
      [room_id, req.property_id]
    );
    if (!rows.length) throw httpError(404, 'Room not found');
    if (rows[0].status !== 'active') throw httpError(409, 'Room is not active');
    type = rows[0];
  } else {
    const { rows } = await client.query(
      'SELECT id, base_rate, max_occupancy FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id]
    );
    if (!rows.length) throw httpError(404, 'Room type not found');
    type = rows[0];
  }

  // Rate plan (Saver/Flex). A website must book a plan-enabled room type on
  // a plan, so it can't skip payment; no plan = exactly the old behaviour.
  let plan = null;
  if (rate_plan_id) {
    const { rows } = await client.query(
      `SELECT * FROM rate_plan WHERE id = $1 AND property_id = $2 AND room_type_id = $3 AND status = 'active'`,
      [rate_plan_id, req.property_id, type.id]
    );
    if (!rows.length) throw httpError(400, 'Rate plan not found for this room type');
    plan = rows[0];
  } else if (viaApiKey) {
    const { rows } = await client.query(
      `SELECT 1 FROM rate_plan WHERE room_type_id = $1 AND property_id = $2 AND status = 'active' LIMIT 1`,
      [type.id, req.property_id]
    );
    if (rows.length) throw httpError(400, 'rate_plan_id is required for this room type');
  }

  // Nightly rate: a picked room's override, else the type's dated rate, else
  // base. A type booking has no room yet, so overrides never apply to it.
  const { rows: typeRateRows } = await client.query(
    `SELECT date, rate FROM room_type_rate
     WHERE room_type_id = $1 AND date >= $2 AND date < $3`,
    [type.id, check_in, check_out]
  );
  const typeRates = {};
  for (const row of typeRateRows) typeRates[row.date] = parseFloat(row.rate);
  const overrides = {};
  if (room_id) {
    const { rows: ov } = await client.query(
      `SELECT date, override_rate FROM room_availability
       WHERE room_id = $1 AND date = ANY($2::date[]) AND override_rate IS NOT NULL`, [room_id, nights]);
    for (const row of ov) overrides[row.date] = parseFloat(row.override_rate);
  }
  const total = stayPrice(nights, typeRates, parseFloat(type.base_rate), overrides, plan ? plan.adjustment_pct : null);
  return { stay, roomId: room_id ?? null, rateTypeId: type.id, maxOccupancy: type.max_occupancy, plan, total };
}

function roomsError(rooms) {
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > MAX_ROOMS) return `rooms must be a list of 1 to ${MAX_ROOMS} rooms`;
  for (const [i, r] of rooms.entries()) {
    if (!r || typeof r !== 'object' || (!r.room_id && !r.room_type_id) || (r.room_id && r.room_type_id)) {
      return `rooms[${i}] needs exactly one of room_id or room_type_id`;
    }
    if (r.guests !== undefined && (!Number.isInteger(r.guests) || r.guests < 1)) return `rooms[${i}].guests must be a whole number of at least 1`;
  }
  return null;
}

async function createBooking(req, res, next) {
  const { guest_id, room_id, room_type_id, check_in, check_out, guests, metadata, rate_plan_id, pay_at_hotel, source, send_emails, rooms } = req.body;
  // The API-key rail is a website acting for a guest; anything else here is
  // signed-in staff (rate plans spec §4).
  const viaApiKey = req.auth_method === 'api_key';
  const multi = rooms !== undefined;

  if (multi) {
    if (room_id !== undefined || room_type_id !== undefined || rate_plan_id !== undefined || guests !== undefined) {
      return res.status(400).json({ error: 'Give rooms, or room_id / room_type_id / rate_plan_id / guests, not both' });
    }
    const error = roomsError(rooms);
    if (error) return res.status(400).json({ error });
    if (!guest_id || !check_in || !check_out) {
      return res.status(400).json({ error: 'guest_id, check_in, check_out and rooms are required' });
    }
  } else if (!guest_id || !check_in || !check_out || (!room_id && !room_type_id) || (room_id && room_type_id)) {
    return res.status(400).json({ error: 'guest_id, check_in, check_out, and exactly one of room_id or room_type_id are required' });
  }
  if (!isValidDate(check_in) || !isValidDate(check_out)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
  if (check_in >= check_out) {
    return res.status(400).json({ error: 'check_in must be before check_out' });
  }
  if (metadata !== undefined && !isValidMetadata(metadata)) {
    return res.status(400).json({ error: 'metadata must be a JSON object' });
  }
  // Staff must say how the booking came in; a website is web by default.
  if ((source !== undefined || !viaApiKey) && !SOURCES.includes(source)) {
    return res.status(400).json({ error: SOURCE_ERROR });
  }
  if (send_emails !== undefined && typeof send_emails !== 'boolean') {
    return res.status(400).json({ error: 'send_emails must be true or false' });
  }
  if (pay_at_hotel !== undefined && typeof pay_at_hotel !== 'boolean') {
    return res.status(400).json({ error: 'pay_at_hotel must be true or false' });
  }
  if (pay_at_hotel && viaApiKey) {
    return res.status(403).json({ error: 'pay_at_hotel is staff-only' });
  }
  const stays = multi ? rooms : [{ room_id, room_type_id, rate_plan_id, guests }];
  if (pay_at_hotel && !stays.every((s) => s.rate_plan_id)) {
    return res.status(400).json({ error: 'pay_at_hotel needs a rate_plan_id' });
  }

  const nights = stayNights(check_in, check_out);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const guestRes = await client.query(
      'SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]
    );
    if (!guestRes.rows.length) throw httpError(404, 'Guest not found');

    const priced = [];
    for (const stay of stays) priced.push(await priceStay(client, req, { stay, check_in, check_out, nights, viaApiKey }));
    if (multi) {
      const names = new Set(priced.map((p) => p.plan?.name.toLowerCase() ?? null));
      if (names.size > 1) throw httpError(400, 'All rooms in a booking must be on one rate');
      for (const [i, p] of priced.entries()) {
        if ((p.stay.guests ?? 1) > p.maxOccupancy) throw httpError(400, `rooms[${i}] has more guests than the room type takes (${p.maxOccupancy})`);
      }
    }
    // One rate per booking, so the first room's plan speaks for all.
    const plan = priced[0].plan;
    const needsCard = !!plan && !pay_at_hotel;
    if (needsCard) {
      const { rows: [prop] } = await client.query(
        'SELECT stripe_secret_key, stripe_publishable_key, room_booking_url FROM property WHERE id = $1', [req.property_id]
      );
      if (!prop.stripe_secret_key || !prop.stripe_publishable_key) {
        throw httpError(409, 'Online payment is not set up for this property', 'Staff can book it as pay at hotel');
      }
      if (!viaApiKey && !prop.room_booking_url) {
        throw httpError(409, 'Set the room booking page link in Settings → Branding, or use pay at hotel');
      }
    }

    // Stripe refuses a zero charge: a free stay on a plan needs no card.
    const grandTotal = priced.reduce((a, p) => a + p.total, 0);
    const card = needsCard && toCents(grandTotal) > 0;
    const status = card ? 'pending_payment' : 'confirmed';
    const payWindow = card ? PAY_WINDOW_MINUTES[viaApiKey ? 'api_key' : 'staff'] : null;
    const groupId = priced.length > 1 ? crypto.randomUUID() : null;
    // Lock every sold type up front, in a stable order, so two baskets can't
    // deadlock taking each other's types (holdStay re-takes them: no-op).
    for (const t of [...new Set(priced.map((p) => p.rateTypeId))].sort()) await roomNights.lockType(client, t);

    const ids = [];
    for (const p of priced) {
      const terms = p.plan ? termsSnapshot(p.plan, { pay_at_hotel: !card }) : null;
      const { rows: [inserted] } = await client.query(
        `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, guests, total_price, metadata,
                              status, rate_plan_id, rate_plan_terms, payment_due_at, website_checkout, room_type_id, room_pick, source, send_emails, group_id)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10,
                 CASE WHEN $11::int IS NULL THEN NULL ELSE now() + make_interval(mins => $11::int) END, $12, $13, $14, $15, $16, $17) RETURNING id`,
        [req.property_id, guest_id, check_in, check_out, p.stay.guests || 1, p.total.toFixed(2), metadata ?? {},
          status, p.plan?.id ?? null, terms, payWindow, card && viaApiKey, p.rateTypeId, !!p.roomId,
          source ?? (viaApiKey ? 'web' : null), send_emails ?? true, groupId]
      );
      // Auto-assigns a room, takes the named one (bumping an auto-assigned
      // holder), or holds the stay with no room against the oversell allowance.
      await roomNights.holdStay(client, {
        propertyId: req.property_id, bookingId: inserted.id, roomTypeId: p.rateTypeId, nights,
        pickRoomId: p.roomId, movedBy: req.user?.id ?? null,
      });
      ids.push(inserted.id);
    }

    await client.query('COMMIT');

    // After COMMIT (see refreshAvailabilityView); also nudges channel sync.
    await roomPayments.refreshAvailabilityView();

    // The joined shape (guest/room/room_type fields), consistent with every
    // other booking read (see fetchJoinedBooking), for Ably and the response.
    const booked = [];
    for (const id of ids) booked.push(await fetchJoinedBooking(id));
    for (const b of booked) publishNewBooking(req.property_id, b).catch((err) => console.error('Ably publish failed:', err.message));

    // A website takes the card itself (payment-intent); staff bookings email
    // the guest a pay link. Confirmed plan bookings get a confirmation. One
    // email per booking, whatever its number of rooms.
    if (plan && status === 'confirmed') roomEmails.sendConfirmation(ids[0]);
    else if (plan && !viaApiKey) roomEmails.sendPayRequest(ids[0]);

    if (!multi) return res.status(201).json(booked[0]);
    res.status(201).json({ group_id: groupId, total_price: grandTotal.toFixed(2), status, bookings: booked });
  } catch (err) {
    await client.query('ROLLBACK');
    // Request problems answer here, as before (holdStay's 409 included).
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
    next(err);
  } finally {
    client.release();
  }
}

async function updateBooking(req, res, next) {
  try {
    const { status, guests, metadata, source, send_emails } = req.body;
    if (send_emails !== undefined && typeof send_emails !== 'boolean') {
      return res.status(400).json({ error: 'send_emails must be true or false' });
    }
    if (source !== undefined && source !== null && !SOURCES.includes(source)) {
      return res.status(400).json({ error: SOURCE_ERROR });
    }
    if (metadata !== undefined && !isValidMetadata(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }
    if (status === 'pending_payment' || status === 'expired') {
      return res.status(400).json({ error: `status ${status} is set by the system` });
    }
    if (status === 'walked') {
      return res.status(400).json({ error: 'Walk a guest with POST /api/bookings/{id}/walk' });
    }

    const beforeRes = await pool.query('SELECT * FROM booking WHERE id = $1 AND property_id = $2', [
      req.params.id,
      req.property_id,
    ]);
    if (!beforeRes.rows.length) return res.status(404).json({ error: 'Booking not found' });
    let statusBefore = beforeRes.rows[0].status;
    // A booking that has let its rooms go can't simply take them back -- they
    // may be resold. Book again instead.
    if (['confirmed', 'checked_in'].includes(status) && ['cancelled', 'expired', 'walked', 'checked_out'].includes(statusBefore)) {
      return res.status(409).json({ error: `A ${statusBefore} booking no longer holds rooms; make a new booking` });
    }

    // An unpaid plan booking: staff confirming it settles the open card
    // payment (rate plans spec §7); other status moves would leave the
    // guest's card form live, so they go through confirm or DELETE first.
    let nextStatus = status;
    if (statusBefore === 'pending_payment' && status !== undefined) {
      if (status !== 'confirmed') {
        return res.status(409).json({ error: 'Confirm this unpaid booking first, or cancel it (DELETE) to release the card payment' });
      }
      // Before settling: settling sends the confirmation.
      if (send_emails !== undefined) {
        await pool.query('UPDATE booking SET send_emails = $1 WHERE id = $2 AND property_id = $3', [send_emails, req.params.id, req.property_id]);
      }
      const settled = await roomPayments.settleByHand(req.params.id, req.property_id);
      if (settled.status !== 200 || (guests === undefined && metadata === undefined && source === undefined && send_emails === undefined)) {
        return res.status(settled.status).json(settled.body);
      }
      statusBefore = 'confirmed';
      nextStatus = undefined;
    }

    // Soft check-out gate: an outstanding folio balance blocks the
    // transition unless the caller explicitly forces it (comps/disputes
    // are the property's call). See the guest-folio spec.
    if (status === 'checked_out' && statusBefore !== 'checked_out' && req.body.force !== true) {
      const folio = await computeFolio(req.params.id, req.property_id);
      if (folio && toCents(folio.balance) > 0) {
        return res.status(409).json({ error: 'Outstanding folio balance', balance: folio.balance });
      }
    }

    // Soft check-in gate: the room hasn't been cleaned (or passed
    // inspection) yet. Housekeeping properties only; force overrides.
    // Checking in needs a room for tonight. An oversold guest (or one whose
    // stay is split) gets one here: room_id places tonight, and later nights
    // still without a room follow into it where it's free.
    let tonightRoom = beforeRes.rows[0].room_id;
    if (status === 'checked_in' && statusBefore !== 'checked_in') {
      const b = beforeRes.rows[0];
      const today = await roomNights.propertyToday(pool, req.property_id);
      const night = b.check_in > today ? b.check_in : today;
      const held = (await pool.query('SELECT room_id FROM booking_night WHERE booking_id = $1 AND night = $2', [b.id, night])).rows[0];
      tonightRoom = held?.room_id ?? tonightRoom;
      if (held && !held.room_id) {
        if (!isValidUuid(req.body.room_id)) {
          return res.status(409).json({ error: 'room_required', details: `No room held for ${night}; pass room_id to check in` });
        }
        const moved = await moveInTransaction(req, b.id, { roomId: req.body.room_id, from: night, to: roomNights.addDaysIso(night, 1), keepLaterNights: true });
        if (moved.error) return res.status(moved.status).json({ error: moved.error });
        tonightRoom = req.body.room_id;
      }
    }

    if (status === 'checked_in' && statusBefore !== 'checked_in' && req.body.force !== true
        && await housekeeping.housekeepingEnabled(pool, req.property_id)) {
      const room = (await pool.query('SELECT housekeeping_status FROM room WHERE id = $1', [tonightRoom])).rows[0];
      if (room && room.housekeeping_status !== 'ready') {
        return res.status(409).json({ error: 'Room not ready', housekeeping_status: room.housekeeping_status });
      }
    }

    // Status and nights change together. Leaving the holding statuses frees
    // the nights: checking out frees tonight on (an early departure puts those
    // rooms back on sale / to waiting bookings), cancelling frees them all.
    let rows;
    let released = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(
        `UPDATE booking SET
           status   = COALESCE($1, status),
           guests   = COALESCE($2, guests),
           metadata = COALESCE($3::jsonb, metadata),
           source   = CASE WHEN $6 THEN $7 ELSE source END,
           send_emails = COALESCE($8, send_emails)
         WHERE id = $4 AND property_id = $5 RETURNING *`,
        [nextStatus, guests, metadata ?? null, req.params.id, req.property_id, source !== undefined, source ?? null, send_emails ?? null]
      ));
      if (rows.length && rows[0].status !== statusBefore
          && roomNights.HOLDING.includes(statusBefore) && !roomNights.HOLDING.includes(rows[0].status)) {
        const from = rows[0].status === 'checked_out' ? await roomNights.propertyToday(client, req.property_id) : null;
        await roomNights.releaseNights(client, rows[0], from);
        released = true;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    if (released) await roomPayments.refreshAvailabilityView();

    const bookedFull = (await fetchJoinedBooking(rows[0].id)) ?? rows[0];

    if (rows[0].status !== statusBefore) {
      // Full joined row, not just {id, status, room_id} -- the live feed
      // upserts by replacing the whole list item on every event (see
      // fetchJoinedBooking), so a partial payload here blanked out the
      // guest name / room line on every status change, not just creation.
      publishBookingStatusChanged(req.property_id, bookedFull).catch((err) => console.error('Ably publish failed:', err.message));
      if (rows[0].status === 'checked_out') {
        housekeeping.onCheckedOut(req.property_id, rows[0].room_id, rows[0].id).catch((err) => console.error('Housekeeping checkout failed:', err.message));
      }
    }

    res.json(bookedFull);
  } catch (err) {
    next(err);
  }
}

async function cancelBooking(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const members = roomPayments.requestedFirst(await roomPayments.lockMembers(client, req.params.id, req.property_id), req.params.id);
    const booking = members[0];
    if (!booking || ['cancelled', 'expired', 'walked'].includes(booking.status)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found or already cancelled' });
    }
    // Multi-room: a guest (website) cancels the whole booking; staff cancel
    // one room, but not while the booking's one payment is still open.
    const viaApiKey = req.auth_method === 'api_key';
    const others = members.slice(1).filter((m) => roomNights.HOLDING.includes(m.status));
    if (!viaApiKey && others.length && booking.status === 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This room is part of an unpaid multi-room booking',
        details: 'Cancel the whole booking from the website or confirm it first',
      });
    }
    const targets = viaApiKey ? [booking, ...others] : [booking];

    // A channel booking is cancelled on the channel (which then tells us);
    // cancelling only here would leave the guest holding it there.
    if (booking.channel_id && !(req.body?.force === true || req.query.force === 'true')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This booking came from a channel; cancel it on the channel', details: 'Pass force: true to cancel it in OTA only' });
    }

    // Rate plan bookings (rate plans spec §9): a website cancelling for a
    // guest gets the plan's terms; staff can always cancel, with no
    // automatic refund. Stripe goes first, so a failure changes nothing.
    let refundedPaymentIds = [];
    if (booking.rate_plan_terms || booking.stripe_payment_intent_id) {
      const decision = viaApiKey
        ? guestCancelDecision(booking, roomPayments.deadlineOf(booking), new Date())
        : 'staff';
      if (decision === 'refuse') {
        await client.query('ROLLBACK');
        const deadline = roomPayments.deadlineOf(booking);
        return res.status(409).json({
          error: 'This booking can no longer be cancelled online. Please contact the hotel.',
          details: deadline ? `Free cancellation ended ${deadline.toISOString()}` : 'non-refundable',
        });
      }
      try {
        for (const t of targets) {
          const r = await roomPayments.stripeForCancel(t, { refund: decision === 'refund', keepIntent: !viaApiKey && others.length > 0 });
          refundedPaymentIds.push(...r.refundedPaymentIds);
        }
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(502).json({ error: 'Payment provider error; booking not cancelled', details: err.message });
      }
    }

    await client.query(
      `UPDATE booking SET status = 'cancelled', payment_due_at = NULL WHERE id = ANY($1)`, [targets.map((t) => t.id)]
    );
    if (refundedPaymentIds.length) {
      await client.query(`UPDATE payment SET status = 'refunded' WHERE id = ANY($1)`, [refundedPaymentIds]);
    }
    await roomPayments.releaseMembers(client, targets);

    await client.query('COMMIT');

    await roomPayments.refreshAvailabilityView();

    // Full joined rows -- see the matching note in updateBooking. The
    // response is the booking asked for; every cancelled room is published.
    const joined = [];
    for (const t of targets) joined.push(await fetchJoinedBooking(t.id));
    for (const j of joined) publishBookingStatusChanged(req.property_id, j).catch((err) => console.error('Ably publish failed:', err.message));

    res.json(joined[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// The website's card step (rate plans spec §7).
async function createPaymentIntent(req, res, next) {
  try {
    const r = await roomPayments.paymentIntentFor(req.params.id, req.property_id);
    res.status(r.status).json(r.body);
  } catch (err) {
    next(err);
  }
}

async function confirmPayment(req, res, next) {
  try {
    const r = await roomPayments.confirmPaid(req.params.id, req.property_id);
    res.status(r.status).json(r.body);
  } catch (err) {
    next(err);
  }
}

// Unpaid website checkouts, newest first -- see src/lib/roomBaskets.js.
async function listRoomBaskets(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
    res.json(await listOpenRoomBaskets(pool, req.property_id, limit));
  } catch (err) { next(err); }
}

// Bulk-record ML cancellation-risk scores (append-only; payloads show the
// latest). Booking ids not in this property come back in unknown.
async function addCancelScores(req, res, next) {
  try {
    const list = req.body?.scores;
    if (!Array.isArray(list) || !list.length || list.length > 500) {
      return res.status(400).json({ error: 'scores must be an array of 1-500 scores' });
    }
    for (const [i, x] of list.entries()) {
      if (!x || !isValidUuid(x.booking_id)) return res.status(400).json({ error: `scores[${i}].booking_id must be a uuid` });
      if (typeof x.score !== 'number' || !(x.score >= 0 && x.score <= 1)) return res.status(400).json({ error: `scores[${i}].score must be a number from 0 to 1` });
      if (typeof x.model !== 'string' || !x.model.trim() || x.model.length > 100) return res.status(400).json({ error: `scores[${i}].model must be a string of 1-100 characters` });
    }
    const { rows } = await pool.query(
      `INSERT INTO booking_cancel_score (property_id, booking_id, score, model)
       SELECT $1, b.id, x.score, x.model
       FROM unnest($2::uuid[], $3::numeric[], $4::text[]) AS x(booking_id, score, model)
       JOIN booking b ON b.id = x.booking_id AND b.property_id = $1
       RETURNING booking_id`,
      [req.property_id, list.map((x) => x.booking_id), list.map((x) => x.score), list.map((x) => x.model.trim())]
    );
    const saved = new Set(rows.map((r) => r.booking_id));
    res.json({ saved: rows.length, unknown: [...new Set(list.map((x) => x.booking_id).filter((id) => !saved.has(id)))] });
  } catch (err) {
    next(err);
  }
}

// Locks the booking and runs roomNights.moveNights in its own transaction.
// Returns { booking } or { status, error } (4xx from the move rules).
async function moveInTransaction(req, bookingId, { roomId, from, to, reason = null, keepLaterNights = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = await roomPayments.lockBooking(client, bookingId, req.property_id);
    if (!booking) { await client.query('ROLLBACK'); return { status: 404, error: 'Booking not found' }; }
    if (!roomNights.HOLDING.includes(booking.status)) {
      await client.query('ROLLBACK');
      return { status: 409, error: `A ${booking.status} booking holds no rooms` };
    }
    const today = await roomNights.propertyToday(client, req.property_id);
    from ??= booking.check_in > today ? booking.check_in : today;
    to ??= booking.check_out;
    try {
      await roomNights.moveNights(client, booking, { roomId, from, to, reason, movedBy: req.user?.id ?? null });
      if (keepLaterNights) await roomNights.fillFromRoom(client, booking, roomId, to);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.status && err.status < 500) return { status: err.status, error: err.message };
      throw err;
    }
    await client.query('COMMIT');
    await roomPayments.refreshAvailabilityView();
    return { booking };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// POST /api/bookings/:id/move -- staff put a booking in any room (upgrade,
// downgrade, mid-stay move, or a room for nights it was waiting on). The
// price never changes; refunds are manual.
async function moveBooking(req, res, next) {
  try {
    const { room_id, from, to, reason } = req.body ?? {};
    if (!isValidUuid(room_id)) return res.status(400).json({ error: 'room_id must be a uuid' });
    if ((from !== undefined && !isValidDate(from)) || (to !== undefined && !isValidDate(to))) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    if (reason !== undefined && !['upgrade', 'downgrade', 'move'].includes(reason)) {
      return res.status(400).json({ error: 'reason must be upgrade, downgrade or move' });
    }
    const moved = await moveInTransaction(req, req.params.id, { roomId: room_id, from, to, reason });
    if (moved.error) return res.status(moved.status).json({ error: moved.error });
    const full = await fetchJoinedBooking(req.params.id);
    publishBookingStatusChanged(req.property_id, full).catch((err) => console.error('Ably publish failed:', err.message));
    res.json(full);
  } catch (err) {
    next(err);
  }
}

// POST /api/bookings/:id/walk -- the hotel can't house the guest and sends
// them elsewhere. Not a cancellation: no rate plan terms, no email, kept
// apart for the overbooking backtest. Frees every night.
async function walkBooking(req, res, next) {
  const note = req.body?.note;
  if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
    return res.status(400).json({ error: 'note must be a string of at most 500 characters' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = await roomPayments.lockBooking(client, req.params.id, req.property_id);
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }
    // An unpaid booking's card form is still live: cancel it (DELETE), which
    // releases the payment, rather than walk a guest who could still pay.
    if (booking.status === 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This booking is awaiting card payment; cancel it (DELETE) to release the payment' });
    }
    if (booking.status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `A ${booking.status} booking can't be walked` });
    }
    await client.query(
      `UPDATE booking SET status = 'walked', payment_due_at = NULL,
              metadata = CASE WHEN $2::text IS NULL THEN metadata ELSE metadata || jsonb_build_object('walk_note', $2::text) END
       WHERE id = $1`, [booking.id, note ?? null]);
    await roomNights.releaseNights(client, booking);
    await client.query('COMMIT');
    await roomPayments.refreshAvailabilityView();
    const full = await fetchJoinedBooking(booking.id);
    publishBookingStatusChanged(req.property_id, full).catch((err) => console.error('Ably publish failed:', err.message));
    res.json(full);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// Hard-delete test bookings (seeded/demo data): the rows and their folio,
// extras, minibar and rating rows go; housekeeping jobs, restaurant tabs and
// channel logs keep their row with the link cleared. Freed rooms go to
// waiting bookings. Refuses card-paid bookings (real money; cancel those) and
// channel bookings unless force (e.g. imported backtest data).
async function purgeBookings(req, res, next) {
  const ids = req.body?.booking_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(isValidUuid)) {
    return res.status(400).json({ error: 'booking_ids must be an array of 1-500 uuids' });
  }
  if (req.body.confirm !== true) {
    return res.status(400).json({ error: 'confirm must be true: this permanently deletes the bookings' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: found } = await client.query(
      `SELECT * FROM booking WHERE property_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
      [req.property_id, [...new Set(ids)]]);
    const keep = found.length ? (await client.query(
      `SELECT b.id FROM booking b WHERE b.id = ANY($1::uuid[])
         AND ((b.channel_id IS NOT NULL AND NOT $2) OR b.stripe_payment_intent_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM payment p WHERE p.booking_id = b.id AND p.stripe_payment_intent_id IS NOT NULL))`,
      [found.map((b) => b.id), req.body.force === true])).rows.map((r) => r.id) : [];
    if (keep.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Some bookings have a card payment, or came from a channel (pass force: true for those); cancel card-paid ones instead', details: keep });
    }
    const freed = new Map();
    for (const b of found) {
      for (const [roomId, ns] of await roomNights.releaseNights(client, b, null, { refillNow: false })) {
        freed.set(roomId, [...(freed.get(roomId) ?? []), ...ns]);
      }
    }
    const del = found.map((b) => b.id);
    for (const t of ['payment', 'folio_adjustment', 'booking_extra', 'minibar_usage', 'cleanliness_rating']) {
      await client.query(`DELETE FROM ${t} WHERE booking_id = ANY($1::uuid[])`, [del]);
    }
    await client.query('UPDATE hk_job SET booking_id = NULL WHERE booking_id = ANY($1::uuid[])', [del]);
    await client.query('UPDATE hk_job SET arriving_booking_id = NULL WHERE arriving_booking_id = ANY($1::uuid[])', [del]);
    await client.query('UPDATE restaurant_order SET booking_id = NULL WHERE booking_id = ANY($1::uuid[])', [del]);
    await client.query('UPDATE channel_reservation_log SET booking_id = NULL WHERE booking_id = ANY($1::uuid[])', [del]);
    await client.query('DELETE FROM booking WHERE id = ANY($1::uuid[])', [del]);
    await roomNights.refill(client, req.property_id, freed);
    await client.query('COMMIT');
    await roomPayments.refreshAvailabilityView();
    const gone = new Set(del);
    res.json({ deleted: del.length, unknown: [...new Set(ids)].filter((id) => !gone.has(id)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
}

// Bulk import of bookings made elsewhere (another system, a dataset):
// the given price, booked_at and status (confirmed or cancelled), the guest
// matched by email or added. One transaction per booking, idempotent on
// (property, external_ref). Nothing is emailed at creation; send_emails
// (default false here) is stored for the later ones (review request,
// cleanliness rating).
// Only confirmed holds nights (and so needs a free room). checked_out and
// no_show are past stays: no nights, no availability check, any dates.
// ponytail: no checked_in -- an in-house import needs a room; add when asked.
const IMPORT_MAX = 500;
const IMPORT_STATUSES = ['confirmed', 'cancelled', 'checked_out', 'no_show'];
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function invalidImportField(b) {
  if (!nonEmpty(b.external_ref) || b.external_ref.length > 100) return 'external_ref';
  if (!isValidUuid(b.room_type_id)) return 'room_type_id';
  if (!isValidDate(b.check_in)) return 'check_in';
  if (!isValidDate(b.check_out) || b.check_out <= b.check_in) return 'check_out';
  if (b.guests !== undefined && !(Number.isInteger(b.guests) && b.guests > 0)) return 'guests';
  if (!(typeof b.total_price === 'number' && Number.isFinite(b.total_price) && b.total_price >= 0)) return 'total_price';
  if (b.status !== undefined && !IMPORT_STATUSES.includes(b.status)) return 'status';
  if (b.source !== undefined && b.source !== null && !SOURCES.includes(b.source)) return 'source';
  if (b.booked_at !== undefined && (typeof b.booked_at !== 'string' || Number.isNaN(Date.parse(b.booked_at)))) return 'booked_at';
  if (b.metadata !== undefined && !isValidMetadata(b.metadata)) return 'metadata';
  if (b.send_emails !== undefined && typeof b.send_emails !== 'boolean') return 'send_emails';
  const g = b.guest;
  if (!g || !nonEmpty(g.first_name) || !nonEmpty(g.last_name) || (g.email != null && !nonEmpty(g.email))) return 'guest';
  return null;
}

async function importOne(propertyId, b, sendEmails) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      'SELECT id FROM booking WHERE property_id = $1 AND external_ref = $2', [propertyId, b.external_ref])).rows[0];
    if (existing) { await client.query('ROLLBACK'); return { outcome: 'duplicate', booking_id: existing.id }; }
    const type = (await client.query('SELECT id FROM room_type WHERE id = $1 AND property_id = $2', [b.room_type_id, propertyId])).rows[0];
    if (!type) { await client.query('ROLLBACK'); return { outcome: 'rejected', reason: 'room type not found' }; }
    const email = (b.guest.email ?? `${b.external_ref}@import.invalid`).trim().toLowerCase();
    const guestId = (await client.query(
      `INSERT INTO guest (property_id, first_name, last_name, email, phone) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (property_id, email) DO UPDATE SET first_name = guest.first_name RETURNING id`,
      [propertyId, b.guest.first_name.trim(), b.guest.last_name.trim(), email, b.guest.phone ?? null])).rows[0].id;
    const status = b.status ?? 'confirmed';
    const { rows: [inserted] } = await client.query(
      `INSERT INTO booking (property_id, guest_id, room_id, room_type_id, check_in, check_out, guests, total_price, status,
                            metadata, source, send_emails, external_ref, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now())) RETURNING id`,
      [propertyId, guestId, b.room_type_id, b.check_in, b.check_out, b.guests ?? 1, b.total_price.toFixed(2), status,
        b.metadata ?? {}, b.source ?? null, b.send_emails ?? sendEmails, b.external_ref, b.booked_at ?? null]);
    if (status === 'confirmed') {
      try {
        await roomNights.holdStay(client, {
          propertyId, bookingId: inserted.id, roomTypeId: b.room_type_id, nights: stayNights(b.check_in, b.check_out),
        });
      } catch (err) {
        if (err.status !== 409) throw err;
        await client.query('ROLLBACK');
        return { outcome: 'rejected', reason: 'no room available' };
      }
    }
    await client.query('COMMIT');
    return { outcome: 'created', booking_id: inserted.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function importBookings(req, res, next) {
  try {
    const { bookings: list, send_emails } = req.body || {};
    if (!Array.isArray(list) || !list.length || list.length > IMPORT_MAX) {
      return res.status(400).json({ error: `bookings must be an array of 1-${IMPORT_MAX} bookings` });
    }
    if (send_emails !== undefined && typeof send_emails !== 'boolean') {
      return res.status(400).json({ error: 'send_emails must be true or false' });
    }
    const results = [];
    for (const [index, raw] of list.entries()) {
      const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const bad = invalidImportField(b);
      const out = bad ? { outcome: 'rejected', reason: `invalid booking: ${bad}` } : await importOne(req.property_id, b, send_emails ?? false);
      results.push({ index, external_ref: b.external_ref ?? null, ...out });
    }
    // Once for the batch, not per booking (also nudges channel sync).
    await roomPayments.refreshAvailabilityView();
    const counts = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    res.json({ counts, results });
  } catch (err) { next(err); }
}

module.exports = {
  purgeBookings, importBookings,
  addCancelScores, listRoomBaskets, listBookings, getBooking, createBooking, updateBooking, cancelBooking,
  createPaymentIntent, confirmPayment, moveBooking, walkBooking,
};
