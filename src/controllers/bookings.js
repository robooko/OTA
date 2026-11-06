const pool = require('../db');
const { isValidDate, isValidUuid } = require('../middleware/validate');
const { publishNewBooking, publishBookingStatusChanged } = require('../lib/ably');
const { listOpenRoomBaskets } = require('../lib/roomBaskets');
const { computeFolio, toCents } = require('../lib/folio');
const { applyAdjustment, termsSnapshot, guestCancelDecision, PAY_WINDOW_MINUTES } = require('../lib/ratePlans');
const roomEmails = require('../lib/roomBookingEmails');
const roomPayments = require('../lib/roomPayments');
const housekeeping = require('../lib/housekeeping');
const { fetchJoinedBooking, CANCEL_SCORE_SQL, NIGHTS_SQL } = roomPayments;
const { stayNights } = require('../lib/roomPlacement');
const roomNights = require('../lib/roomNights');

// How a direct booking came in. Channel bookings leave it null (channel_id).
const SOURCES = ['web', 'phone', 'email', 'walk_in', 'agent'];
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

async function createBooking(req, res, next) {
  const { guest_id, room_id, room_type_id, check_in, check_out, guests, metadata, rate_plan_id, pay_at_hotel, source } = req.body;
  // The API-key rail is a website acting for a guest; anything else here is
  // signed-in staff (rate plans spec §4).
  const viaApiKey = req.auth_method === 'api_key';

  if (!guest_id || !check_in || !check_out || (!room_id && !room_type_id) || (room_id && room_type_id)) {
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
  if (source !== undefined && !SOURCES.includes(source)) {
    return res.status(400).json({ error: SOURCE_ERROR });
  }
  if (pay_at_hotel !== undefined && typeof pay_at_hotel !== 'boolean') {
    return res.status(400).json({ error: 'pay_at_hotel must be true or false' });
  }
  if (pay_at_hotel && viaApiKey) {
    return res.status(403).json({ error: 'pay_at_hotel is staff-only' });
  }
  if (pay_at_hotel && !rate_plan_id) {
    return res.status(400).json({ error: 'pay_at_hotel needs a rate_plan_id' });
  }

  const nights = stayNights(check_in, check_out);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const guestRes = await client.query(
      'SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]
    );
    if (!guestRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Guest not found' });
    }

    let baseRate;
    let rateTypeId;
    if (room_id) {
      const roomRes = await client.query(
        `SELECT r.id, r.status, r.room_type_id, rt.base_rate
         FROM room r JOIN room_type rt ON rt.id = r.room_type_id
         WHERE r.id = $1 AND r.property_id = $2`,
        [room_id, req.property_id]
      );
      if (!roomRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Room not found' });
      }
      if (roomRes.rows[0].status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Room is not active' });
      }
      baseRate = parseFloat(roomRes.rows[0].base_rate);
      rateTypeId = roomRes.rows[0].room_type_id;
    } else {
      const typeRes = await client.query(
        'SELECT id, base_rate FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id]
      );
      if (!typeRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Room type not found' });
      }
      baseRate = parseFloat(typeRes.rows[0].base_rate);
      rateTypeId = room_type_id;
    }

    // Rate plan (Saver/Flex). A website must book a plan-enabled room type on
    // a plan, so it can't skip payment; no plan = exactly the old behaviour.
    let plan = null;
    if (rate_plan_id) {
      const planRes = await client.query(
        `SELECT * FROM rate_plan WHERE id = $1 AND property_id = $2 AND room_type_id = $3 AND status = 'active'`,
        [rate_plan_id, req.property_id, rateTypeId]
      );
      if (!planRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Rate plan not found for this room type' });
      }
      plan = planRes.rows[0];
    } else if (viaApiKey) {
      const anyPlan = await client.query(
        `SELECT 1 FROM rate_plan WHERE room_type_id = $1 AND property_id = $2 AND status = 'active' LIMIT 1`,
        [rateTypeId, req.property_id]
      );
      if (anyPlan.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'rate_plan_id is required for this room type' });
      }
    }
    const needsCard = !!plan && !pay_at_hotel;
    if (needsCard) {
      const { rows: [prop] } = await client.query(
        'SELECT stripe_secret_key, stripe_publishable_key, room_booking_url FROM property WHERE id = $1', [req.property_id]
      );
      if (!prop.stripe_secret_key || !prop.stripe_publishable_key) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Online payment is not set up for this property', details: 'Staff can book it as pay at hotel' });
      }
      if (!viaApiKey && !prop.room_booking_url) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Set the room booking page link in Settings → Branding, or use pay at hotel' });
      }
    }

    // Nightly rate: a picked room's override, else the type's dated rate, else
    // base. A type booking has no room yet, so overrides never apply to it.
    const { rows: typeRateRows } = await client.query(
      `SELECT date, rate FROM room_type_rate
       WHERE room_type_id = $1 AND date >= $2 AND date < $3`,
      [rateTypeId, check_in, check_out]
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
    let total = 0;
    for (const date of nights) {
      const night = overrides[date] ?? typeRates[date] ?? baseRate;
      total += plan ? applyAdjustment(night, plan.adjustment_pct) : night;
    }
    // Stripe refuses a zero charge: a free stay on a plan needs no card.
    const card = needsCard && toCents(total) > 0;
    const status = card ? 'pending_payment' : 'confirmed';
    const payWindow = card ? PAY_WINDOW_MINUTES[viaApiKey ? 'api_key' : 'staff'] : null;
    const terms = plan ? termsSnapshot(plan, { pay_at_hotel: !card }) : null;
    const { rows: [inserted] } = await client.query(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, guests, total_price, metadata,
                            status, rate_plan_id, rate_plan_terms, payment_due_at, website_checkout, room_type_id, room_pick, source)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $11::int IS NULL THEN NULL ELSE now() + make_interval(mins => $11::int) END, $12, $13, $14, $15) RETURNING id`,
      [req.property_id, guest_id, check_in, check_out, guests || 1, total.toFixed(2), metadata ?? {},
        status, plan?.id ?? null, terms, payWindow, card && viaApiKey, rateTypeId, !!room_id,
        source ?? (viaApiKey ? 'web' : null)]
    );
    // Auto-assigns a room, takes the named one (bumping an auto-assigned
    // holder), or holds the stay with no room against the oversell allowance.
    try {
      await roomNights.holdStay(client, {
        propertyId: req.property_id, bookingId: inserted.id, roomTypeId: rateTypeId, nights,
        pickRoomId: room_id ?? null, movedBy: req.user?.id ?? null,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.status === 409) return res.status(409).json({ error: err.message });
      throw err;
    }
    const booked = (await client.query('SELECT * FROM booking WHERE id = $1', [inserted.id])).rows[0];

    await client.query('COMMIT');

    // After COMMIT (see refreshAvailabilityView); also nudges channel sync.
    await roomPayments.refreshAvailabilityView();

    // `booked` is only the raw `booking` row (INSERT ... RETURNING *) -- no
    // guest/room/room_type fields. Re-fetch the joined shape so both the Ably
    // payload and the HTTP response carry it, consistent with every other
    // booking read (see fetchJoinedBooking).
    const bookedFull = (await fetchJoinedBooking(booked.id)) ?? booked;

    publishNewBooking(req.property_id, bookedFull).catch((err) => console.error('Ably publish failed:', err.message));

    // A website takes the card itself (payment-intent); staff bookings email
    // the guest a pay link. Confirmed plan bookings get a confirmation.
    if (booked.rate_plan_id && booked.status === 'confirmed') roomEmails.sendConfirmation(booked.id);
    else if (booked.rate_plan_id && !viaApiKey) roomEmails.sendPayRequest(booked.id);

    res.status(201).json(bookedFull);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function updateBooking(req, res, next) {
  try {
    const { status, guests, metadata, source } = req.body;
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
      const settled = await roomPayments.settleByHand(req.params.id, req.property_id);
      if (settled.status !== 200 || (guests === undefined && metadata === undefined && source === undefined)) {
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
           source   = CASE WHEN $6 THEN $7 ELSE source END
         WHERE id = $4 AND property_id = $5 RETURNING *`,
        [nextStatus, guests, metadata ?? null, req.params.id, req.property_id, source !== undefined, source ?? null]
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

    const booking = await roomPayments.lockBooking(client, req.params.id, req.property_id);
    if (!booking || ['cancelled', 'expired', 'walked'].includes(booking.status)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found or already cancelled' });
    }

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
      const decision = req.auth_method === 'api_key'
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
        ({ refundedPaymentIds } = await roomPayments.stripeForCancel(booking, { refund: decision === 'refund' }));
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(502).json({ error: 'Payment provider error; booking not cancelled', details: err.message });
      }
    }

    const { rows } = await client.query(
      `UPDATE booking SET status = 'cancelled', payment_due_at = NULL WHERE id = $1 RETURNING *`, [booking.id]
    );
    if (refundedPaymentIds.length) {
      await client.query(`UPDATE payment SET status = 'refunded' WHERE id = ANY($1)`, [refundedPaymentIds]);
    }
    await roomPayments.releaseAvailability(client, booking);

    await client.query('COMMIT');

    await roomPayments.refreshAvailabilityView();

    // Full joined row -- see the matching note in updateBooking.
    const bookedFull = (await fetchJoinedBooking(rows[0].id)) ?? rows[0];
    publishBookingStatusChanged(req.property_id, bookedFull).catch((err) => console.error('Ably publish failed:', err.message));

    res.json(bookedFull);
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

module.exports = {
  purgeBookings,
  addCancelScores, listRoomBaskets, listBookings, getBooking, createBooking, updateBooking, cancelBooking,
  createPaymentIntent, confirmPayment, moveBooking, walkBooking,
};
