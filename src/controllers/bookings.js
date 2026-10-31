const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { publishNewBooking, publishBookingStatusChanged } = require('../lib/ably');
const { computeFolio, toCents } = require('../lib/folio');
const { applyAdjustment, termsSnapshot, guestCancelDecision, PAY_WINDOW_MINUTES } = require('../lib/ratePlans');
const roomEmails = require('../lib/roomBookingEmails');
const roomPayments = require('../lib/roomPayments');
const housekeeping = require('../lib/housekeeping');
const { fetchJoinedBooking } = roomPayments;

function isValidMetadata(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function listBookings(req, res, next) {
  try {
    const { status, guest_id, from, to, created_from, created_to, skip, take } = req.query;
    let query = `
      SELECT b.*, g.first_name, g.last_name, g.email, g.phone,
             r.room_number, r.floor,
             rt.id AS room_type_id, rt.name AS room_type_name,
             rt.description AS room_type_description, rt.max_occupancy, rt.base_rate,
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
      JOIN room r       ON r.id  = b.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      LEFT JOIN booking_extra be ON be.booking_id = b.id
      LEFT JOIN extra e          ON e.id = be.extra_id
      WHERE b.property_id = $1
    `;
    const params = [req.property_id];
    let countQuery = 'SELECT COUNT(*) AS total FROM booking b WHERE b.property_id = $1';

    if (status) { params.push(status); query += ` AND b.status = $${params.length}`; countQuery += ` AND b.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND b.guest_id = $${params.length}`; countQuery += ` AND b.guest_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND b.check_in >= $${params.length}`; countQuery += ` AND b.check_in >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND b.check_out <= $${params.length}`; countQuery += ` AND b.check_out <= $${params.length}`; }
    // created_from/created_to are the main dashboard's Room total revenue
    // stat and Sales this week chart -- when the booking was made, not
    // when the stay happens (from/to above), same "revenue today" meaning
    // as restaurant-orders/proshop-orders' own date_from/date_to.
    if (created_from) { params.push(created_from); query += ` AND b.created_at::date >= $${params.length}`; countQuery += ` AND b.created_at::date >= $${params.length}`; }
    if (created_to)   { params.push(created_to);   query += ` AND b.created_at::date <= $${params.length}`; countQuery += ` AND b.created_at::date <= $${params.length}`; }

    const filterParams = [...params]; // snapshot before pagination params are appended below

    query += ' GROUP BY b.id, g.first_name, g.last_name, g.email, g.phone, r.room_number, r.floor, rt.id, rt.name, rt.description, rt.max_occupancy, rt.base_rate';
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
              rt.id AS room_type_id, rt.name AS room_type_name, rt.base_rate
       FROM booking b
       JOIN guest     g  ON g.id  = b.guest_id
       JOIN room      r  ON r.id  = b.room_id
       JOIN room_type rt ON rt.id = r.room_type_id
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
  const { guest_id, room_id, room_type_id, check_in, check_out, guests, metadata, rate_plan_id, pay_at_hotel } = req.body;
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
  if (pay_at_hotel !== undefined && typeof pay_at_hotel !== 'boolean') {
    return res.status(400).json({ error: 'pay_at_hotel must be true or false' });
  }
  if (pay_at_hotel && viaApiKey) {
    return res.status(403).json({ error: 'pay_at_hotel is staff-only' });
  }
  if (pay_at_hotel && !rate_plan_id) {
    return res.status(400).json({ error: 'pay_at_hotel needs a rate_plan_id' });
  }

  // Build set of required dates (shared by every candidate room)
  const required = new Set();
  const d = new Date(check_in);
  const end = new Date(check_out);
  while (d < end) {
    required.add(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }

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

    let candidates;
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
      candidates = [{ id: roomRes.rows[0].id, base_rate: roomRes.rows[0].base_rate }];
      rateTypeId = roomRes.rows[0].room_type_id;
    } else {
      const typeRes = await client.query(
        'SELECT id FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id]
      );
      if (!typeRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Room type not found' });
      }
      const roomsRes = await client.query(
        `SELECT r.id, rt.base_rate
         FROM room r JOIN room_type rt ON rt.id = r.room_type_id
         WHERE r.room_type_id = $1 AND r.property_id = $2 AND r.status = 'active'
         ORDER BY r.room_number`,
        [room_type_id, req.property_id]
      );
      candidates = roomsRes.rows;
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

    // Dated type-level rates for the stay -- one fetch covers every candidate,
    // since both branches yield rooms of a single room type.
    const { rows: typeRateRows } = await client.query(
      `SELECT date, rate FROM room_type_rate
       WHERE room_type_id = $1 AND date >= $2 AND date < $3`,
      [rateTypeId, check_in, check_out]
    );
    const typeRates = {};
    for (const row of typeRateRows) typeRates[row.date] = parseFloat(row.rate);

    let booked = null;
    let lastUnavailableDate = null;

    for (const candidate of candidates) {
      await client.query('SAVEPOINT attempt');

      const availRes = await client.query(
        `SELECT date, is_available, override_rate
         FROM room_availability
         WHERE room_id = $1 AND date >= $2 AND date < $3
         ORDER BY date`,
        [candidate.id, check_in, check_out]
      );
      const availMap = {};
      for (const row of availRes.rows) {
        availMap[row.date] = row;
      }

      let allAvailable = true;
      for (const date of required) {
        const entry = availMap[date];
        if (!entry || !entry.is_available) {
          allAvailable = false;
          lastUnavailableDate = date;
          break;
        }
      }

      if (!allAvailable) {
        await client.query('ROLLBACK TO SAVEPOINT attempt');
        continue;
      }

      let total = 0;
      const baseRate = parseFloat(candidate.base_rate);
      for (const date of required) {
        const entry = availMap[date];
        let night;
        if (entry && entry.override_rate != null) night = parseFloat(entry.override_rate);
        else if (typeRates[date] != null) night = typeRates[date];
        else night = baseRate;
        total += plan ? applyAdjustment(night, plan.adjustment_pct) : night;
      }
      // Stripe refuses a zero charge: a free stay on a plan needs no card.
      const card = needsCard && toCents(total) > 0;
      const status = card ? 'pending_payment' : 'confirmed';
      const payWindow = card ? PAY_WINDOW_MINUTES[viaApiKey ? 'api_key' : 'staff'] : null;
      const terms = plan ? termsSnapshot(plan, { pay_at_hotel: !card }) : null;

      try {
        const bookingRes = await client.query(
          `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, guests, total_price, metadata,
                                status, rate_plan_id, rate_plan_terms, payment_due_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   CASE WHEN $12::int IS NULL THEN NULL ELSE now() + make_interval(mins => $12::int) END) RETURNING *`,
          [req.property_id, guest_id, candidate.id, check_in, check_out, guests || 1, total.toFixed(2), metadata ?? {},
            status, plan?.id ?? null, terms, payWindow]
        );
        await client.query('RELEASE SAVEPOINT attempt');
        booked = bookingRes.rows[0];
        break;
      } catch (err) {
        if (err.code === '23P01') {
          await client.query('ROLLBACK TO SAVEPOINT attempt');
          continue;
        }
        throw err;
      }
    }

    if (!booked) {
      await client.query('ROLLBACK');
      if (room_id) {
        return res.status(409).json({ error: lastUnavailableDate ? `Room not available on ${lastUnavailableDate}` : 'Room already booked for this period' });
      }
      return res.status(409).json({ error: 'No rooms of this type available for the requested dates' });
    }

    // Mark availability as unavailable
    await client.query(
      `UPDATE room_availability
       SET is_available = false
       WHERE room_id = $1 AND date >= $2 AND date < $3`,
      [booked.room_id, check_in, check_out]
    );

    await client.query('COMMIT');

    // After COMMIT: older Postgres rejects CONCURRENTLY inside a transaction
    // block, and a failed refresh must not turn a committed booking into a
    // 500 -- the exclusion constraint guards double-booking, not the view,
    // and the view self-heals on the next refresh from any call site.
    try {
      await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    } catch (e) {
      console.error('MV refresh failed after commit:', e.message);
    }

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
    const { status, guests, metadata } = req.body;
    if (metadata !== undefined && !isValidMetadata(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }
    if (status === 'pending_payment' || status === 'expired') {
      return res.status(400).json({ error: `status ${status} is set by the system` });
    }

    const beforeRes = await pool.query('SELECT status, room_id FROM booking WHERE id = $1 AND property_id = $2', [
      req.params.id,
      req.property_id,
    ]);
    if (!beforeRes.rows.length) return res.status(404).json({ error: 'Booking not found' });
    let statusBefore = beforeRes.rows[0].status;

    // An unpaid plan booking: staff confirming it settles the open card
    // payment (rate plans spec §7); other status moves would leave the
    // guest's card form live, so they go through confirm or DELETE first.
    let nextStatus = status;
    if (statusBefore === 'pending_payment' && status !== undefined) {
      if (status !== 'confirmed') {
        return res.status(409).json({ error: 'Confirm this unpaid booking first, or cancel it (DELETE) to release the card payment' });
      }
      const settled = await roomPayments.settleByHand(req.params.id, req.property_id);
      if (settled.status !== 200 || (guests === undefined && metadata === undefined)) {
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
    if (status === 'checked_in' && statusBefore !== 'checked_in' && req.body.force !== true
        && await housekeeping.housekeepingEnabled(pool, req.property_id)) {
      const room = (await pool.query('SELECT housekeeping_status FROM room WHERE id = $1', [beforeRes.rows[0].room_id])).rows[0];
      if (room && room.housekeeping_status !== 'ready') {
        return res.status(409).json({ error: 'Room not ready', housekeeping_status: room.housekeeping_status });
      }
    }

    const { rows } = await pool.query(
      `UPDATE booking SET
         status   = COALESCE($1, status),
         guests   = COALESCE($2, guests),
         metadata = COALESCE($3::jsonb, metadata)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [nextStatus, guests, metadata ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    const bookedFull = (await fetchJoinedBooking(rows[0].id)) ?? rows[0];

    if (rows[0].status !== statusBefore) {
      // Full joined row, not just {id, status, room_id} -- the live feed
      // upserts by replacing the whole list item on every event (see
      // fetchJoinedBooking), so a partial payload here blanked out the
      // guest name / room line on every status change, not just creation.
      publishBookingStatusChanged(req.property_id, bookedFull).catch((err) => console.error('Ably publish failed:', err.message));
      if (rows[0].status === 'checked_out') {
        housekeeping.onCheckedOut(req.property_id, rows[0].room_id).catch((err) => console.error('Housekeeping checkout failed:', err.message));
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
    if (!booking || booking.status === 'cancelled' || booking.status === 'expired') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found or already cancelled' });
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

module.exports = { listBookings, getBooking, createBooking, updateBooking, cancelBooking, createPaymentIntent, confirmPayment };
