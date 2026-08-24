const pool = require('../db');
const { isValidDate, isValidTime, isValidCurrencyCode, isValidTimezone } = require('../middleware/validate');
const { publishNewReservation, publishReservationStatusChanged } = require('../lib/ably');

function addMinutesToTime(timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function isoDayOfWeek(dateStr) {
  const jsDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function isValidClosedDays(arr) {
  return Array.isArray(arr) && arr.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}

function isValidMetadata(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const PAYMENT_PROTECTION_MODES = ['none', 'hold', 'deposit'];

function isValidPaymentProtection(v) {
  return PAYMENT_PROTECTION_MODES.includes(v);
}

// ── Restaurants ───────────────────────────────────────────────────────────────

async function listRestaurants(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM restaurant WHERE status = 'active' AND property_id = $1 ORDER BY name",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function getRestaurant(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM restaurant WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createRestaurant(req, res, next) {
  try {
    const { name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, currency, timezone, payment_protection, payment_protection_amount } = req.body;
    if (!name || !default_duration_minutes) {
      return res.status(400).json({ error: 'name and default_duration_minutes are required' });
    }
    if (closed_days !== undefined && !isValidClosedDays(closed_days)) {
      return res.status(400).json({ error: 'closed_days must contain integers between 1 and 7' });
    }
    if (currency !== undefined && !isValidCurrencyCode(currency)) {
      return res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code (e.g. GBP)' });
    }
    if (timezone !== undefined && !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'timezone must be a valid IANA timezone name (e.g. Europe/London)' });
    }
    if (payment_protection !== undefined && !isValidPaymentProtection(payment_protection)) {
      return res.status(400).json({ error: `payment_protection must be one of: ${PAYMENT_PROTECTION_MODES.join(', ')}` });
    }
    if (payment_protection_amount != null && (typeof payment_protection_amount !== 'number' || payment_protection_amount < 0)) {
      return res.status(400).json({ error: 'payment_protection_amount must be a non-negative number' });
    }
    const { rows } = await pool.query(
      `INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, currency, timezone, payment_protection, payment_protection_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.property_id, name, description ?? null, phone ?? null, slot_interval_minutes ?? 15, default_duration_minutes, closed_days ?? [], currency ?? null, timezone ?? null, payment_protection ?? 'none', payment_protection_amount ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, status, currency, timezone, floor_plan, payment_protection, payment_protection_amount } = req.body;
    if (closed_days !== undefined && !isValidClosedDays(closed_days)) {
      return res.status(400).json({ error: 'closed_days must contain integers between 1 and 7' });
    }
    if (currency !== undefined && !isValidCurrencyCode(currency)) {
      return res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code (e.g. GBP)' });
    }
    if (timezone !== undefined && !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'timezone must be a valid IANA timezone name (e.g. Europe/London)' });
    }
    if (floor_plan !== undefined && !isValidMetadata(floor_plan)) {
      return res.status(400).json({ error: 'floor_plan must be a JSON object' });
    }
    if (payment_protection !== undefined && !isValidPaymentProtection(payment_protection)) {
      return res.status(400).json({ error: `payment_protection must be one of: ${PAYMENT_PROTECTION_MODES.join(', ')}` });
    }
    // == null (not falsy) -- 0 is a legitimate amount and must not be
    // rejected the way a bare `if (!payment_protection_amount)` would.
    if (payment_protection_amount !== undefined && payment_protection_amount != null &&
        (typeof payment_protection_amount !== 'number' || payment_protection_amount < 0)) {
      return res.status(400).json({ error: 'payment_protection_amount must be a non-negative number' });
    }
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                       = COALESCE($1, name),
         description                = COALESCE($2, description),
         phone                      = COALESCE($3, phone),
         slot_interval_minutes      = COALESCE($4, slot_interval_minutes),
         default_duration_minutes   = COALESCE($5, default_duration_minutes),
         closed_days                = COALESCE($6, closed_days),
         status                     = COALESCE($7, status),
         currency                   = COALESCE($8, currency),
         timezone                   = COALESCE($9, timezone),
         floor_plan                 = COALESCE($10::jsonb, floor_plan),
         payment_protection         = COALESCE($11, payment_protection),
         payment_protection_amount  = CASE WHEN $12::boolean THEN $13::numeric ELSE payment_protection_amount END
       WHERE id = $14 AND property_id = $15 RETURNING *`,
      [
        name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, status, currency, timezone, floor_plan ?? null,
        payment_protection,
        payment_protection_amount !== undefined, payment_protection_amount ?? null,
        req.params.id, req.property_id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tables ────────────────────────────────────────────────────────────────────

async function listTables(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      'SELECT * FROM restaurant_table WHERE restaurant_id = $1 ORDER BY table_number',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTable(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { table_number, seats, location } = req.body;
    if (!table_number || !seats) return res.status(400).json({ error: 'table_number and seats are required' });

    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      `INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats, location) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, restaurant_id, table_number, seats, location ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTable(req, res, next) {
  try {
    const { restaurant_id, id } = req.params;
    const { table_number, seats, location, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant_table SET
         table_number = COALESCE($1, table_number),
         seats        = COALESCE($2, seats),
         location     = COALESCE($3, location),
         status       = COALESCE($4, status)
       WHERE id = $5 AND restaurant_id = $6 AND property_id = $7 RETURNING *`,
      [table_number, seats, location, status, id, restaurant_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Table not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Service Periods ──────────────────────────────────────────────────────────

async function listServicePeriods(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      'SELECT id, label, start_time, end_time FROM service_period WHERE restaurant_id = $1 ORDER BY start_time',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function setServicePeriods(req, res, next) {
  const { restaurant_id } = req.params;
  const { periods } = req.body;

  if (!Array.isArray(periods)) {
    return res.status(400).json({ error: 'periods must be an array' });
  }
  for (const p of periods) {
    if (!p.start_time || !p.end_time) {
      return res.status(400).json({ error: 'Each period requires start_time and end_time' });
    }
    if (!isValidTime(p.start_time) || !isValidTime(p.end_time)) {
      return res.status(400).json({ error: 'Invalid time format, use HH:MM' });
    }
    if (p.start_time >= p.end_time) {
      return res.status(400).json({ error: 'Each period\'s start_time must be before its end_time' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const restaurantRes = await client.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    await client.query('DELETE FROM service_period WHERE restaurant_id = $1', [restaurant_id]);

    const inserted = [];
    for (const p of periods) {
      const { rows } = await client.query(
        `INSERT INTO service_period (property_id, restaurant_id, label, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, label, start_time, end_time`,
        [req.property_id, restaurant_id, p.label ?? null, p.start_time, p.end_time]
      );
      inserted.push(rows[0]);
    }

    await client.query('COMMIT');
    res.json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// ── Availability search ─────────────────────────────────────────────────────

async function searchAvailability(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { from, to, party_size, location } = req.query;

    if (!from || !to || !party_size) {
      return res.status(400).json({ error: 'from, to, and party_size are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });
    if (from > to) return res.status(400).json({ error: 'from must be before or equal to to' });
    const partySize = parseInt(party_size, 10);
    if (!Number.isInteger(partySize) || partySize <= 0) {
      return res.status(400).json({ error: 'party_size must be a positive integer' });
    }

    const restaurantRes = await pool.query("SELECT id FROM restaurant WHERE id = $1 AND status = 'active'", [restaurant_id]);
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      `WITH r AS (
         SELECT slot_interval_minutes, default_duration_minutes, closed_days
         FROM restaurant WHERE id = $1
       ),
       candidate_times AS (
         SELECT generate_series(
           DATE '2000-01-01' + sp.start_time,
           DATE '2000-01-01' + sp.end_time - (r.default_duration_minutes || ' minutes')::interval,
           (r.slot_interval_minutes || ' minutes')::interval
         )::time AS start_time
         FROM service_period sp
         CROSS JOIN r
         WHERE sp.restaurant_id = $1
       ),
       candidate_dates AS (
         SELECT gs::date AS reservation_date
         FROM generate_series($2::date, $3::date, '1 day') AS gs
         CROSS JOIN r
         WHERE NOT (EXTRACT(ISODOW FROM gs)::int = ANY(r.closed_days))
           AND NOT EXISTS (
             SELECT 1 FROM restaurant_seasonal_closure sc
             WHERE sc.restaurant_id = $1
               AND ROW(EXTRACT(MONTH FROM gs)::int, EXTRACT(DAY FROM gs)::int)
                   BETWEEN ROW(sc.start_month, sc.start_day) AND ROW(sc.end_month, sc.end_day)
           )
       )
       SELECT
         to_char(cd.reservation_date, 'YYYY-MM-DD') AS reservation_date,
         ct.start_time,
         rt.location,
         COUNT(rt.id) AS available_tables
       FROM candidate_dates cd
       CROSS JOIN candidate_times ct
       CROSS JOIN restaurant_table rt
       WHERE rt.restaurant_id = $1
         AND rt.status = 'active'
         AND rt.seats >= $4
         AND ($5::varchar IS NULL OR rt.location = $5)
         AND NOT EXISTS (
           SELECT 1 FROM restaurant_reservation rr
           CROSS JOIN r
           WHERE rr.table_id = rt.id
             AND rr.reservation_date = cd.reservation_date
             AND rr.status != 'cancelled'
             AND rr.start_time < ct.start_time + (r.default_duration_minutes || ' minutes')::interval
             AND rr.end_time   > ct.start_time
         )
       GROUP BY cd.reservation_date, ct.start_time, rt.location
       HAVING COUNT(rt.id) > 0
       ORDER BY cd.reservation_date, ct.start_time, rt.location`,
      [restaurant_id, from, to, partySize, location ?? null]
    );

    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.reservation_date)) byDate.set(row.reservation_date, []);
      byDate.get(row.reservation_date).push({
        time: row.start_time.slice(0, 5),
        location: row.location,
        available_tables: parseInt(row.available_tables, 10),
      });
    }
    res.json([...byDate.entries()].map(([date, slots]) => ({ date, slots })));
  } catch (err) { next(err); }
}

// ── Reservations ──────────────────────────────────────────────────────────────

async function listAllReservations(req, res, next) {
  try {
    const { date, status } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rr.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    query += ' ORDER BY rr.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, date_from, date_to, status, guest_id, clerk_user_id, cursor, limit } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rt.restaurant_id = $1 AND rr.property_id = $2
    `;
    const params = [restaurant_id, req.property_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    // date_from/date_to are the restaurant dashboard's live-reservations-feed
    // built-in range picker (hotal-ui >= 0.23.3, showDateFilter) -- an
    // inclusive range, independent of the single-day `date` param above
    // (still used by the admin /reservations page's day picker).
    if (date_from) { params.push(date_from); query += ` AND rr.reservation_date >= $${params.length}`; }
    if (date_to) { params.push(date_to); query += ` AND rr.reservation_date <= $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND rr.clerk_user_id = $${params.length}`; }
    // cursor/limit are the restaurant dashboard's live-reservations-feed
    // paginating by recency (hotal-ui passes the created_at of the oldest
    // loaded reservation as cursor) -- the admin /reservations page never
    // sends these, so its date-ordered listing above is untouched.
    if (cursor) { params.push(cursor); query += ` AND rr.created_at < $${params.length}`; }
    query += cursor ? ' ORDER BY rr.created_at DESC' : ' ORDER BY rr.reservation_date, rr.start_time';
    if (limit) { params.push(parseInt(limit, 10)); query += ` LIMIT $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getReservation(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1 AND rr.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// Fetches the live status/amount of the reservation's linked Stripe
// PaymentIntent (a deposit/hold), using the property's own stored secret
// key -- never the client's. 404s distinctly for "no PaymentIntent linked"
// vs "property has no Stripe key configured" vs "reservation not found",
// since the host UI needs to tell those apart (e.g. to know whether to
// offer setting one up).
async function getReservationPaymentIntent(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.stripe_payment_intent_id, p.stripe_secret_key
       FROM restaurant_reservation rr
       JOIN property p ON p.id = rr.property_id
       WHERE rr.id = $1 AND rr.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    const { stripe_payment_intent_id, stripe_secret_key } = rows[0];
    if (!stripe_payment_intent_id) return res.status(404).json({ error: 'No payment intent linked to this reservation' });
    if (!stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    const stripe = require('stripe')(stripe_secret_key);
    // A refunded intent still retrieves as 'succeeded' -- refunds live on
    // the charge, not the intent -- so expand it and report a synthetic
    // 'refunded' status, otherwise a cancelled-and-refunded reservation
    // reads as if the money was kept.
    const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id, { expand: ['latest_charge'] });
    const refunded = typeof intent.latest_charge === 'object' && intent.latest_charge?.refunded;
    res.json({
      id: intent.id,
      status: refunded ? 'refunded' : intent.status,
      amount: intent.amount,
      currency: intent.currency,
      capture_method: intent.capture_method,
      created: intent.created,
    });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function createReservation(req, res, next) {
  const { restaurant_id } = req.params;
  const { reservation_date, start_time, location, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes, metadata, stripe_payment_intent_id } = req.body;

  if (!reservation_date || !start_time || !contact_name || !party_size) {
    return res.status(400).json({ error: 'reservation_date, start_time, contact_name, and party_size are required' });
  }
  if (!isValidDate(reservation_date)) return res.status(400).json({ error: 'Invalid date format' });
  if (!isValidTime(start_time)) return res.status(400).json({ error: 'Invalid start_time format, use HH:MM' });
  if (!Number.isInteger(party_size) || party_size <= 0) {
    return res.status(400).json({ error: 'party_size must be a positive integer' });
  }
  if (metadata !== undefined && !isValidMetadata(metadata)) {
    return res.status(400).json({ error: 'metadata must be a JSON object' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const restaurantRes = await client.query(
      "SELECT * FROM restaurant WHERE id = $1 AND property_id = $2 AND status = 'active'",
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantRes.rows[0];

    if (guest_id) {
      const guestRes = await client.query(
        'SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]
      );
      if (!guestRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Guest not found' });
      }
    }

    if (restaurant.closed_days.includes(isoDayOfWeek(reservation_date))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restaurant is closed on this day' });
    }

    const seasonRes = await client.query(
      `SELECT 1 FROM restaurant_seasonal_closure
       WHERE restaurant_id = $1
         AND ROW(EXTRACT(MONTH FROM $2::date)::int, EXTRACT(DAY FROM $2::date)::int)
             BETWEEN ROW(start_month, start_day) AND ROW(end_month, end_day)`,
      [restaurant_id, reservation_date]
    );
    if (seasonRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restaurant is closed on this day' });
    }

    const end_time = addMinutesToTime(start_time, restaurant.default_duration_minutes);
    const periodsRes = await client.query(
      'SELECT start_time, end_time FROM service_period WHERE restaurant_id = $1',
      [restaurant_id]
    );
    const fitsAPeriod = periodsRes.rows.some((p) => {
      const periodStart = p.start_time.slice(0, 5);
      const periodEnd = p.end_time.slice(0, 5);
      return start_time >= periodStart && end_time <= periodEnd;
    });
    if (!fitsAPeriod) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'start_time is outside service hours' });
    }

    const { rows: candidates } = await client.query(
      `SELECT id FROM restaurant_table
       WHERE restaurant_id = $1
         AND status = 'active'
         AND seats >= $2
         AND ($3::varchar IS NULL OR location = $3)
       ORDER BY seats ASC
       FOR UPDATE SKIP LOCKED`,
      [restaurant_id, party_size, location ?? null]
    );

    let assignedTableId = null;
    for (const table of candidates) {
      const overlapRes = await client.query(
        `SELECT id FROM restaurant_reservation
         WHERE table_id = $1
           AND reservation_date = $2
           AND status != 'cancelled'
           AND start_time < $4
           AND end_time   > $3`,
        [table.id, reservation_date, start_time, end_time]
      );
      if (!overlapRes.rows.length) { assignedTableId = table.id; break; }
    }

    if (!assignedTableId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No tables available for this time' });
    }

    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (property_id, table_id, reservation_date, start_time, end_time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes, metadata, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [req.property_id, assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null, metadata ?? {}, stripe_payment_intent_id ?? null]
    );

    await client.query('COMMIT');

    // LiveReservation (hotal-ui) needs table_number/location, which only
    // exist via the restaurant_table join, not on the bare INSERT...RETURNING
    // row above.
    const { rows: full } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1`,
      [rows[0].id]
    );
    if (full.length) {
      publishNewReservation(restaurant_id, req.property_id, full[0]).catch((err) => console.error('Ably publish failed:', err.message));
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone, metadata, stripe_payment_intent_id } = req.body;
    if (metadata !== undefined && !isValidMetadata(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }
    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status                   = COALESCE($1, status),
         notes                    = COALESCE($2, notes),
         contact_name             = COALESCE($3, contact_name),
         contact_email            = COALESCE($4, contact_email),
         contact_phone            = COALESCE($5, contact_phone),
         metadata                 = COALESCE($6::jsonb, metadata),
         stripe_payment_intent_id = COALESCE($7, stripe_payment_intent_id)
       WHERE id = $8 AND property_id = $9 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, metadata ?? null, stripe_payment_intent_id ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    if (status !== undefined) {
      // live-reservations-feed's upsert replaces the whole list item for an
      // id on every event (same as every other hotal-ui feed) -- re-fetch
      // the joined shape so status-changed doesn't blank out table_number/
      // location on an otherwise-unrelated field.
      const { rows: full } = await pool.query(
        `SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
         FROM restaurant_reservation rr
         JOIN restaurant_table rt ON rt.id = rr.table_id
         WHERE rr.id = $1`,
        [rows[0].id]
      );
      if (full.length) {
        publishReservationStatusChanged(full[0].restaurant_id, req.property_id, full[0])
          .catch((err) => console.error('Ably publish failed:', err.message));
      }
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function seatReservation(req, res, next) {
  const { restaurant_id, id } = req.params;
  const { table_id: overrideTableId } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: reservations } = await client.query(
      `SELECT rr.*, rt.restaurant_id
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1 AND rr.property_id = $2`,
      [id, req.property_id]
    );
    if (!reservations.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reservation not found' }); }
    const reservation = reservations[0];
    if (reservation.restaurant_id !== restaurant_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reservation not found' });
    }
    if (reservation.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cannot seat a cancelled reservation' });
    }
    if (reservation.status === 'seated') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Reservation already seated' });
    }

    // Defaults to the reservation's own table, but a different one can be
    // passed -- e.g. the booked table isn't actually free, or a larger
    // party needs a different spot. This is the whole table-change support:
    // seating just targets whichever table_id the waitress picks.
    const table_id = overrideTableId || reservation.table_id;
    const { rows: tables } = await client.query(
      `SELECT id FROM restaurant_table WHERE id = $1 AND restaurant_id = $2 AND status = 'active'`,
      [table_id, restaurant_id]
    );
    if (!tables.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Table not found' }); }

    // Unlike createOrder's get-or-create (any open session is a valid target
    // for adding a round), seating must not attach to a table's EXISTING
    // open session unless it's already this reservation's own -- that
    // session could belong to an unrelated walk-in or another party
    // entirely, and silently relinking it would misattribute their tab.
    // Only a genuinely free table (no open session) can be freshly seated.
    const { rows: openSessions } = await client.query(
      `SELECT id, reservation_id FROM restaurant_table_session WHERE table_id = $1 AND status = 'open'`,
      [table_id]
    );
    let session_id;
    if (openSessions.length && openSessions[0].reservation_id !== reservation.id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Table already has an active session' });
    } else if (openSessions.length) {
      session_id = openSessions[0].id; // idempotent -- already seated here
    } else {
      const { rows: inserted } = await client.query(
        `INSERT INTO restaurant_table_session (property_id, restaurant_id, table_id, reservation_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (table_id) WHERE status = 'open' DO NOTHING
         RETURNING id`,
        [req.property_id, restaurant_id, table_id, reservation.id]
      );
      if (!inserted.length) {
        // Lost a race against a concurrent open (createOrder or another
        // seat call) between the SELECT above and this INSERT.
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Table already has an active session' });
      }
      session_id = inserted[0].id;
    }

    const { rows: updatedReservation } = await client.query(
      `UPDATE restaurant_reservation SET status = 'seated' WHERE id = $1 RETURNING *`,
      [reservation.id]
    );

    await client.query('COMMIT');

    // Full joined shape for the live feed -- upsert replaces the whole list
    // item, same as every other hotal-ui feed (see updateReservation).
    const { rows: full } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1`,
      [reservation.id]
    );
    if (full.length) {
      publishReservationStatusChanged(full[0].restaurant_id, req.property_id, full[0])
        .catch((err) => console.error('Ably publish failed:', err.message));
    }

    res.json({ reservation: updatedReservation[0], session_id, table_id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// Cancels a reservation and settles its linked Stripe hold in the same
// request. The Stripe side runs BEFORE the status flip: if releasing or
// refunding fails, the reservation stays as-is instead of ending up
// cancelled with a live hold nobody remembers to deal with.
// body.refund === false keeps the deposit (a cancellation fee) -- which
// for an uncaptured hold means capturing it now, since an unclaimed hold
// just expires on its own after ~7 days.
async function cancelReservation(req, res, next) {
  const { restaurant_id, id } = req.params;
  const refund = req.body?.refund !== false;
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, rt.restaurant_id, p.stripe_secret_key
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       JOIN property p ON p.id = rr.property_id
       WHERE rr.id = $1 AND rr.property_id = $2`,
      [id, req.property_id]
    );
    if (!rows.length || rows[0].restaurant_id !== restaurant_id) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const reservation = rows[0];
    if (reservation.status === 'cancelled') {
      return res.status(409).json({ error: 'Reservation already cancelled' });
    }

    // 'unavailable' (intent linked but no key configured) still cancels the
    // reservation -- without a key nothing can ever be done about the hold
    // from here, and blocking cancellation forever would be worse.
    let payment = 'none';
    if (reservation.stripe_payment_intent_id) {
      if (!reservation.stripe_secret_key) {
        payment = 'unavailable';
      } else {
        const stripe = require('stripe')(reservation.stripe_secret_key);
        try {
          const intent = await stripe.paymentIntents.retrieve(reservation.stripe_payment_intent_id);
          if (refund) {
            if (intent.status === 'requires_capture') {
              await stripe.paymentIntents.cancel(intent.id);
              payment = 'released';
            } else if (intent.status === 'succeeded') {
              await stripe.refunds.create({ payment_intent: intent.id });
              payment = 'refunded';
            } else if (intent.status === 'canceled') {
              payment = 'released'; // already released -- idempotent
            }
          } else {
            if (intent.status === 'requires_capture') {
              await stripe.paymentIntents.capture(intent.id);
              payment = 'captured';
            } else if (intent.status === 'succeeded') {
              payment = 'kept';
            }
          }
        } catch (err) {
          if (err.type?.startsWith('Stripe')) {
            return res.status(502).json({ error: `Stripe error: ${err.message}` });
          }
          throw err;
        }
      }
    }

    const { rows: updated } = await pool.query(
      `UPDATE restaurant_reservation SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [id]
    );

    // Full joined shape for the live feed -- upsert replaces the whole list
    // item, same as every other hotal-ui feed (see updateReservation).
    const { rows: full } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1`,
      [id]
    );
    if (full.length) {
      publishReservationStatusChanged(restaurant_id, req.property_id, full[0])
        .catch((err) => console.error('Ably publish failed:', err.message));
    }

    res.json({ reservation: updated[0], payment });
  } catch (err) { next(err); }
}

module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  listServicePeriods, setServicePeriods,
  searchAvailability,
  listAllReservations,
  listReservations, getReservation, createReservation, updateReservation, seatReservation,
  cancelReservation,
  getReservationPaymentIntent,
};
