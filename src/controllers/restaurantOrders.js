const pool = require('../db');
const {
  publishNewOrder,
  publishOrderStatusChanged,
  publishNewOrderForProperty,
  publishOrderStatusChangedForProperty,
  publishOrderStatusChangedForBooking,
  publishOrderStatusChangedForOrder,
  publishTableSessionOpened,
  client: ablyClient,
} = require('../lib/ably');
const { generateJoinCode, verifyJoinCode } = require('../lib/joinCode');
const { computeOrderTax } = require('../lib/tax');

function isValidTranslations(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Menu items ────────────────────────────────────────────────────────────────

async function listMenuItems(req, res, next) {
  try {
    const { category, restaurant_id } = req.query;
    let query = `SELECT * FROM restaurant_menu_item WHERE status = 'active' AND property_id = $1`;
    const params = [req.property_id];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (restaurant_id) { params.push(restaurant_id); query += ` AND restaurant_id = $${params.length}`; }
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createMenuItem(req, res, next) {
  try {
    const { name, description, category, price, restaurant_id, allergens, variants, translations } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (allergens !== undefined && !Array.isArray(allergens)) {
      return res.status(400).json({ error: 'allergens must be an array of strings' });
    }
    if (variants !== undefined && !Array.isArray(variants)) {
      return res.status(400).json({ error: 'variants must be an array of strings' });
    }
    if (translations !== undefined && !isValidTranslations(translations)) {
      return res.status(400).json({ error: 'translations must be a JSON object keyed by language code' });
    }

    if (restaurant_id) {
      const restaurantRes = await pool.query('SELECT id FROM restaurant WHERE id = $1 AND property_id = $2', [
        restaurant_id,
        req.property_id,
      ]);
      if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO restaurant_menu_item (property_id, restaurant_id, name, description, category, price, allergens, variants, translations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, restaurant_id || null, name, description || null, category || null, price, allergens ?? [], variants ?? [], translations ?? {}]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateMenuItem(req, res, next) {
  try {
    const { name, description, category, price, status, restaurant_id, allergens, variants, translations } = req.body;
    if (allergens !== undefined && !Array.isArray(allergens)) {
      return res.status(400).json({ error: 'allergens must be an array of strings' });
    }
    if (variants !== undefined && !Array.isArray(variants)) {
      return res.status(400).json({ error: 'variants must be an array of strings' });
    }
    if (translations !== undefined && !isValidTranslations(translations)) {
      return res.status(400).json({ error: 'translations must be a JSON object keyed by language code' });
    }

    if (restaurant_id) {
      const restaurantRes = await pool.query('SELECT id FROM restaurant WHERE id = $1 AND property_id = $2', [
        restaurant_id,
        req.property_id,
      ]);
      if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    }

    const { rows } = await pool.query(
      `UPDATE restaurant_menu_item SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         category      = COALESCE($3, category),
         price         = COALESCE($4, price),
         status        = COALESCE($5, status),
         restaurant_id = COALESCE($6, restaurant_id),
         allergens     = COALESCE($7, allergens),
         variants      = COALESCE($8, variants),
         translations  = COALESCE($9::jsonb, translations)
       WHERE id = $10 AND property_id = $11 RETURNING *`,
      [name, description, category, price, status, restaurant_id, allergens ?? null, variants ?? null, translations ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function bulkDeleteMenuItems(req, res, next) {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const { rows } = await pool.query(
      `UPDATE restaurant_menu_item SET status = 'inactive' WHERE id = ANY($1) AND property_id = $2 RETURNING id`,
      [ids, req.property_id]
    );
    res.json({ deleted: rows.length, ids: rows.map((r) => r.id) });
  } catch (err) { next(err); }
}

async function renameMenuCategory(req, res, next) {
  try {
    const { restaurant_id, from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let query = `UPDATE restaurant_menu_item SET category = $1 WHERE category = $2 AND property_id = $3`;
    const params = [to, from, req.property_id];
    if (restaurant_id) { params.push(restaurant_id); query += ` AND restaurant_id = $${params.length}`; }
    query += ' RETURNING id';

    const { rows } = await pool.query(query, params);
    res.json({ renamed: rows.length, ids: rows.map((r) => r.id) });
  } catch (err) { next(err); }
}

// ── Orders ────────────────────────────────────────────────────────────────────

async function listOrders(req, res, next) {
  try {
    const { restaurant_id, booking_id, table_id, guest_id, status, date_from, date_to, skip, take } = req.query;

    // A table_id listing is the full tab (items, totals, notes) -- without
    // this gate it would be a trivial read bypass of the join code. Wider
    // listings (restaurant-wide etc.) are pre-existing integration surface
    // and stay ungated.
    if (table_id && req.auth_method === 'api_key') {
      const { rows: openSessions } = await pool.query(
        `SELECT id, join_code, join_code_attempts FROM restaurant_table_session WHERE table_id = $1 AND status = 'open'`,
        [table_id]
      );
      if (openSessions.length) {
        const denied = await verifyJoinCode(openSessions[0], req);
        if (denied) return res.status(denied.status).json(denied.body);
      }
    }

    let query = `
      SELECT o.*, rm.room_number, rt.table_number,
             json_agg(json_build_object(
               'id', oi.id,
               'item_id', oi.item_id,
               'item_name', oi.item_name,
               'quantity', oi.quantity,
               'unit_price', oi.unit_price,
               'variant', oi.variant,
               'total', (oi.quantity * oi.unit_price)
             )) AS items
      FROM restaurant_order o
      LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
      LEFT JOIN booking bk ON bk.id = o.booking_id
      LEFT JOIN room rm ON rm.id = bk.room_id
      LEFT JOIN restaurant_table rt ON rt.id = o.table_id
      WHERE o.property_id = $1
    `;
    const params = [req.property_id];
    if (restaurant_id) { params.push(restaurant_id); query += ` AND o.restaurant_id = $${params.length}`; }
    if (booking_id) { params.push(booking_id); query += ` AND o.booking_id = $${params.length}`; }
    if (table_id)   { params.push(table_id);   query += ` AND o.table_id = $${params.length}`; }
    if (guest_id)   { params.push(guest_id);   query += ` AND o.guest_id = $${params.length}`; }
    if (status)     { params.push(status);     query += ` AND o.status = $${params.length}`; }
    // date_from/date_to are the restaurant dashboard's stat tiles and weekly
    // orders chart (restaurant-dashboard-client.ts) -- an inclusive range
    // over the order's created_at date, same convention as restaurant.js's
    // listReservations date_from/date_to.
    if (date_from)  { params.push(date_from);  query += ` AND o.created_at::date >= $${params.length}`; }
    if (date_to)    { params.push(date_to);    query += ` AND o.created_at::date <= $${params.length}`; }
    query += ' GROUP BY o.id, rm.room_number, rt.table_number ORDER BY o.created_at DESC';

    const countParams = [req.property_id, restaurant_id, booking_id, table_id, guest_id, status, date_from, date_to].filter(Boolean);
    const [{ rows: countRows }] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT o.id) AS total FROM restaurant_order o WHERE o.property_id = $1
        ${restaurant_id ? ` AND o.restaurant_id = $${[restaurant_id].length + 1}` : ''}
        ${booking_id ? ` AND o.booking_id = $${[restaurant_id, booking_id].filter(Boolean).length + 1}` : ''}
        ${table_id   ? ` AND o.table_id = $${[restaurant_id, booking_id, table_id].filter(Boolean).length + 1}` : ''}
        ${guest_id   ? ` AND o.guest_id = $${[restaurant_id, booking_id, table_id, guest_id].filter(Boolean).length + 1}` : ''}
        ${status     ? ` AND o.status = $${[restaurant_id, booking_id, table_id, guest_id, status].filter(Boolean).length + 1}` : ''}
        ${date_from  ? ` AND o.created_at::date >= $${[restaurant_id, booking_id, table_id, guest_id, status, date_from].filter(Boolean).length + 1}` : ''}
        ${date_to    ? ` AND o.created_at::date <= $${[restaurant_id, booking_id, table_id, guest_id, status, date_from, date_to].filter(Boolean).length + 1}` : ''}
      `, countParams)
    ]);

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
  } catch (err) { next(err); }
}

async function getOrder(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, rm.room_number, rt.table_number,
              json_agg(json_build_object(
                'id', oi.id,
                'item_id', oi.item_id,
                'item_name', oi.item_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'variant', oi.variant,
                'total', (oi.quantity * oi.unit_price)
              )) AS items
       FROM restaurant_order o
       LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
       LEFT JOIN booking bk ON bk.id = o.booking_id
       LEFT JOIN room rm ON rm.id = bk.room_id
       LEFT JOIN restaurant_table rt ON rt.id = o.table_id
       WHERE o.id = $1 AND o.property_id = $2
       GROUP BY o.id, rm.room_number, rt.table_number`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createOrder(req, res, next) {
  try {
    const { restaurant_id, booking_id, table_id, guest_id, items, notes, scheduled_for, force, contact_name, contact_email, contact_phone } = req.body;
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and an items array are required' });
    }

    // No booking_id/table_id = a paid-upfront pickup order (website
    // ordering, no waiter, nothing to bill a tab through) -- see
    // migrate-2026-09-07-merge-restaurant-web-order.sql. contact_name
    // defaults the same way restaurant_web_order did, so a PaymentIntent
    // can exist before a checkout form's contact fields even render.
    const isPickup = !booking_id && !table_id;
    const resolvedContactName = isPickup ? (contact_name || 'Website Guest') : (contact_name || null);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: restaurants } = await client.query(
        'SELECT id, require_join_code FROM restaurant WHERE id = $1 AND property_id = $2',
        [restaurant_id, req.property_id]
      );
      if (!restaurants.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Restaurant not found' }); }

      if (booking_id) {
        const { rows: bookings } = await client.query(
          `SELECT id FROM booking WHERE id = $1 AND property_id = $2 AND status NOT IN ('cancelled')`,
          [booking_id, req.property_id]
        );
        if (!bookings.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found or cancelled' }); }
      }

      let table_session_id = null;
      let openedSession = null; // set only when this request creates the session
      if (table_id) {
        const { rows: tables } = await client.query(
          `SELECT id FROM restaurant_table WHERE id = $1 AND property_id = $2 AND status = 'active'`,
          [table_id, req.property_id]
        );
        if (!tables.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Table not found' }); }

        // A walk-in must not quietly take a table whose booked party is due.
        // Only guards the *opening* of a session -- adding a round to a tab
        // that's already open is always fine (and a session opened via
        // seatReservation is the reservation's own), hence the NOT EXISTS.
        // Conflict = a confirmed, not-yet-seated reservation on this table
        // whose window overlaps the next default_duration_minutes, measured
        // in the restaurant's local time (restaurant.timezone, else
        // property.timezone). Includes a reservation whose start_time has
        // already passed but hasn't ended -- a late party is still expected.
        // `force: true` lets the waiter override when they've decided the
        // table is theirs to give away.
        if (!force) {
          const { rows: conflicts } = await client.query(
            `SELECT rr.id, rr.contact_name, rr.party_size, rr.reservation_date, rr.start_time, rr.end_time
             FROM restaurant_reservation rr
             JOIN restaurant r ON r.id = $2
             JOIN property p   ON p.id = r.property_id
             WHERE rr.table_id = $1
               AND rr.status = 'confirmed'
               AND NOT EXISTS (
                 SELECT 1 FROM restaurant_table_session s
                 WHERE s.table_id = rr.table_id AND s.status = 'open'
               )
               AND (rr.reservation_date + rr.start_time)
                   < (now() AT TIME ZONE COALESCE(r.timezone, p.timezone))
                     + make_interval(mins => r.default_duration_minutes)
               AND (rr.reservation_date + rr.end_time)
                   > (now() AT TIME ZONE COALESCE(r.timezone, p.timezone))
             ORDER BY rr.reservation_date, rr.start_time
             LIMIT 1`,
            [table_id, restaurant_id]
          );
          if (conflicts.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'Table has an upcoming reservation',
              details: 'Seat the reservation first, or pass force: true to open a walk-in session anyway',
              reservation: conflicts[0],
            });
          }
        }

        // Attach to the table's open session, creating one if none exists yet.
        // ON CONFLICT + re-SELECT (rather than a plain SELECT-then-INSERT)
        // handles two requests for the same table racing to open a session:
        // the unique partial index (one open session per table) rejects the
        // loser's insert instead of raising, and the re-SELECT picks up
        // whichever session actually won.
        const { rows: inserted } = await client.query(
          `INSERT INTO restaurant_table_session (property_id, restaurant_id, table_id, join_code)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (table_id) WHERE status = 'open' DO NOTHING
           RETURNING *`,
          [req.property_id, restaurant_id, table_id, restaurants[0].require_join_code ? generateJoinCode() : null]
        );
        if (inserted.length) {
          table_session_id = inserted[0].id;
          openedSession = inserted[0];
        } else {
          const { rows: existing } = await client.query(
            `SELECT id, status, join_code, join_code_attempts FROM restaurant_table_session WHERE table_id = $1 AND status = 'open'`,
            [table_id]
          );
          // Attaching a round to an existing session is a JOIN: gate it.
          // force:true bypasses only the reservation guard above, never the
          // code. verifyJoinCode writes its attempt counter via the shared
          // pool, so the penalty survives this transaction's rollback.
          const denied = await verifyJoinCode(existing[0], req);
          if (denied) { await client.query('ROLLBACK'); return res.status(denied.status).json(denied.body); }
          table_session_id = existing[0].id;
        }
      }

      // Lock in item prices from DB
      let itemsSubtotal = 0;
      const resolvedItems = [];
      for (const item of items) {
        const { item_id, quantity = 1, variant } = item;
        const { rows: found } = await client.query(
          `SELECT id, name, price FROM restaurant_menu_item WHERE id = $1 AND property_id = $2 AND status = 'active'`,
          [item_id, req.property_id]
        );
        if (!found.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: `Item ${item_id} not found` });
        }
        const unit_price = parseFloat(found[0].price);
        itemsSubtotal += unit_price * quantity;
        resolvedItems.push({ item_id, item_name: found[0].name, quantity, unit_price, variant: variant || null });
      }
      itemsSubtotal = Math.round(itemsSubtotal * 100) / 100;

      // Tax only applies to the pickup (website-checkout) case, matching
      // restaurant_web_order's original scope -- a waiter's tab is untaxed
      // here same as it always was.
      let taxAmount = 0;
      let total = itemsSubtotal;
      if (isPickup) {
        const { rows: properties } = await client.query(
          `SELECT tax_enabled, tax_rate, tax_inclusive FROM property WHERE id = $1`, [req.property_id]
        );
        const computed = computeOrderTax(properties[0], itemsSubtotal);
        taxAmount = computed.taxAmount;
        total = Math.round((itemsSubtotal + computed.totalExtra) * 100) / 100;
      }

      // Create order
      const { rows: order } = await client.query(
        `INSERT INTO restaurant_order
           (property_id, restaurant_id, booking_id, table_id, table_session_id, guest_id, notes, scheduled_for,
            total_price, contact_name, contact_email, contact_phone, items_subtotal, tax_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [req.property_id, restaurant_id, booking_id || null, table_id || null, table_session_id, guest_id || null, notes || null, scheduled_for || null,
         total, resolvedContactName, isPickup ? (contact_email || null) : null, isPickup ? (contact_phone || null) : null,
         isPickup ? itemsSubtotal : null, taxAmount]
      );

      // Insert line items
      for (const li of resolvedItems) {
        await client.query(
          `INSERT INTO restaurant_order_item (order_id, item_id, item_name, quantity, unit_price, variant)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [order[0].id, li.item_id, li.item_name, li.quantity, li.unit_price, li.variant]
        );
      }

      await client.query('COMMIT');

      // Same joined shape as listOrders/getOrder, so feeds can label the
      // order by table without a lookup of their own.
      let table_number = null;
      if (table_id) {
        const { rows: tables } = await pool.query('SELECT table_number FROM restaurant_table WHERE id = $1', [table_id]);
        table_number = tables[0]?.table_number ?? null;
      }
      const created = { ...order[0], table_number, items: resolvedItems };
      // Issuing moment when the first device's first action is an order
      // rather than an explicit open: this response genuinely opened a coded
      // session, so it carries the code -- the only order response that does.
      if (openedSession?.join_code) created.join_code = openedSession.join_code;
      if (openedSession) {
        publishTableSessionOpened(restaurant_id, req.property_id, { ...openedSession, table_number })
          .catch((err) => console.error('Ably publish failed:', err.message));
      }
      // A pickup order isn't real yet -- no payment taken. Publishing here
      // would put an abandoned checkout in front of the kitchen; it
      // publishes instead on the transition to paid (confirmOrderPayment).
      if (!isPickup) {
        publishNewOrder(restaurant_id, created).catch((err) => console.error('Ably publish failed:', err.message));
        publishNewOrderForProperty(req.property_id, created).catch((err) => console.error('Ably publish failed:', err.message));
      }
      res.status(201).json(created);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { status } = req.body;
    const valid = ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    }
    // A status change on an order in a coded OPEN session is a tab mutation
    // (a cancel changes what close charges) -- gate it. Closed-session
    // history stays ungated so admin fixes don't need codes.
    const { rows: orderRows } = await pool.query(
      `SELECT o.id, s.id AS session_id, s.status AS session_status, s.join_code, s.join_code_attempts
       FROM restaurant_order o
       LEFT JOIN restaurant_table_session s ON s.id = o.table_session_id
       WHERE o.id = $1 AND o.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!orderRows.length) return res.status(404).json({ error: 'Order not found' });
    if (orderRows[0].session_status === 'open') {
      const denied = await verifyJoinCode({ id: orderRows[0].session_id, join_code: orderRows[0].join_code, join_code_attempts: orderRows[0].join_code_attempts }, req);
      if (denied) return res.status(denied.status).json(denied.body);
    }
    const { rows } = await pool.query(
      `UPDATE restaurant_order SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    // live-dining-orders-feed's upsert() replaces the whole list item for an
    // id on every event (see the matching fix in OTA/bookings.js) -- a bare
    // {id, status, restaurant_id} patch would blank out the order's items/
    // total/table/booking on every status change. Re-fetch the joined shape
    // (same as getOrder) for the two order-feed channels; the room-service
    // booking-scoped channel keeps the narrow payload since its consumer
    // (peter-island) isn't verified to expect the fuller shape.
    const { rows: full } = await pool.query(
      `SELECT o.*, rm.room_number, rt.table_number,
              json_agg(json_build_object(
                'id', oi.id,
                'item_id', oi.item_id,
                'item_name', oi.item_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'variant', oi.variant,
                'total', (oi.quantity * oi.unit_price)
              )) AS items
       FROM restaurant_order o
       LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
       LEFT JOIN booking bk ON bk.id = o.booking_id
       LEFT JOIN room rm ON rm.id = bk.room_id
       LEFT JOIN restaurant_table rt ON rt.id = o.table_id
       WHERE o.id = $1
       GROUP BY o.id, rm.room_number, rt.table_number`,
      [rows[0].id]
    );
    const orderFull = full[0] ?? rows[0];

    const payload = { id: rows[0].id, status: rows[0].status, restaurant_id: rows[0].restaurant_id };
    publishOrderStatusChanged(rows[0].restaurant_id, orderFull).catch((err) => console.error('Ably publish failed:', err.message));
    publishOrderStatusChangedForProperty(rows[0].property_id, orderFull).catch((err) => console.error('Ably publish failed:', err.message));
    publishOrderStatusChangedForBooking(rows[0].booking_id, payload).catch((err) => console.error('Ably publish failed:', err.message));
    publishOrderStatusChangedForOrder(rows[0].id, orderFull).catch((err) => console.error('Ably publish failed:', err.message));
    res.json(orderFull);
  } catch (err) { next(err); }
}

// Same joined shape as getOrder -- reused below so the payment endpoints'
// Ably publishes carry the full row, never a partial patch (see the
// live-feed payload note in updateOrderStatus above).
async function loadJoinedOrder(orderId, propertyId) {
  const { rows } = await pool.query(
    `SELECT o.*, rm.room_number, rt.table_number,
            json_agg(json_build_object(
              'id', oi.id,
              'item_id', oi.item_id,
              'item_name', oi.item_name,
              'quantity', oi.quantity,
              'unit_price', oi.unit_price,
              'variant', oi.variant,
              'total', (oi.quantity * oi.unit_price)
            )) AS items
     FROM restaurant_order o
     LEFT JOIN restaurant_order_item oi ON oi.order_id = o.id
     LEFT JOIN booking bk ON bk.id = o.booking_id
     LEFT JOIN room rm ON rm.id = bk.room_id
     LEFT JOIN restaurant_table rt ON rt.id = o.table_id
     WHERE o.id = $1 AND o.property_id = $2
     GROUP BY o.id, rm.room_number, rt.table_number`,
    [orderId, propertyId]
  );
  return rows[0] ?? null;
}

async function orderTotalCents(order) {
  return Math.round(parseFloat(order.total_price) * 100);
}

// Per field: omit = unchanged. Patches in the guest's real contact details
// before confirm-payment -- createOrder defaults contact_name to "Website
// Guest" for a pickup order so a PaymentIntent can exist before a checkout
// form's contact fields even render (same reasoning restaurant_web_order
// used). Only meaningful for pickup orders, but harmless on any order.
async function updateOrder(req, res, next) {
  try {
    const { contact_name, contact_email, contact_phone, notes } = req.body ?? {};
    const { rows } = await pool.query(
      `UPDATE restaurant_order SET
         contact_name  = COALESCE($1, contact_name),
         contact_email = COALESCE($2, contact_email),
         contact_phone = COALESCE($3, contact_phone),
         notes         = COALESCE($4, notes)
       WHERE id = $5 AND property_id = $6 RETURNING *`,
      [contact_name, contact_email, contact_phone, notes, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// Pickup orders only (table_session_id IS NULL) -- an at-table order paid
// from a phone settles through restaurant_table_session's own
// payment-intent endpoint instead (it pays the whole tab, not one order).
async function createOrderPaymentIntent(req, res, next) {
  try {
    const order = await loadJoinedOrder(req.params.id, req.property_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.table_session_id) {
      return res.status(409).json({ error: "This order is billed through its table session -- use POST /api/restaurant-table-sessions/:id/payment-intent instead" });
    }
    if (order.status === 'cancelled') return res.status(409).json({ error: 'Order is cancelled' });
    if (order.payment_status === 'paid') return res.status(409).json({ error: 'Order already paid' });

    const { rows: properties } = await pool.query(`SELECT stripe_secret_key, currency FROM property WHERE id = $1`, [req.property_id]);
    const property = properties[0];
    if (!property?.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    const stripe = require('stripe')(property.stripe_secret_key);
    const amount = await orderTotalCents(order);

    // Idempotency: a retry (page refresh, a dropped connection after Stripe
    // confirmed) shouldn't create a second charge for the same order.
    if (order.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount: existing.amount });
      }
      if (existing.status === 'succeeded') {
        if (existing.amount !== amount) {
          return res.status(409).json({ error: 'A payment already succeeded for a different amount', payment_intent_id: existing.id });
        }
        const { rows: paidRows } = await pool.query(
          `UPDATE restaurant_order SET payment_status = 'paid', paid_at = now(),
             status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
           WHERE id = $1 RETURNING *`,
          [order.id]
        );
        const full = (await loadJoinedOrder(paidRows[0].id, req.property_id)) ?? paidRows[0];
        publishNewOrder(full.restaurant_id, full).catch((err) => console.error('Ably publish failed:', err.message));
        publishNewOrderForProperty(full.property_id, full).catch((err) => console.error('Ably publish failed:', err.message));
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled/failed -> fall through and mint a fresh intent
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: property.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      capture_method: 'automatic',
      metadata: { restaurant_order_id: order.id, restaurant_id: order.restaurant_id },
    });

    await pool.query(`UPDATE restaurant_order SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, order.id]);
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) return res.status(502).json({ error: `Stripe error: ${err.message}` });
    next(err);
  }
}

async function confirmOrderPayment(req, res, next) {
  try {
    const { payment_intent_id } = req.body ?? {};
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id is required' });

    const order = await loadJoinedOrder(req.params.id, req.property_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (payment_intent_id !== order.stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this order' });
    }

    const { rows: properties } = await pool.query(`SELECT stripe_secret_key FROM property WHERE id = $1`, [req.property_id]);
    const stripeSecretKey = properties[0]?.stripe_secret_key;
    if (!stripeSecretKey) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    const stripe = require('stripe')(stripeSecretKey);
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status !== 'succeeded') {
      return res.status(409).json({ error: `Payment has not succeeded (status: ${intent.status})` });
    }
    const expected = await orderTotalCents(order);
    if (intent.amount !== expected) {
      return res.status(409).json({ error: 'Payment amount does not match the order total' });
    }

    // A client retry after a dropped response just re-confirms harmlessly --
    // but the publish below must only fire on the actual first transition
    // to paid, same guard proshop.js uses.
    if (order.payment_status === 'paid') return res.json(order);

    const { rows } = await pool.query(
      `UPDATE restaurant_order SET
         payment_status = 'paid',
         paid_at = now(),
         status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
       WHERE id = $1 AND property_id = $2 RETURNING *`,
      [order.id, req.property_id]
    );
    const full = (await loadJoinedOrder(rows[0].id, req.property_id)) ?? rows[0];
    publishNewOrder(full.restaurant_id, full).catch((err) => console.error('Ably publish failed:', err.message));
    publishNewOrderForProperty(full.property_id, full).catch((err) => console.error('Ably publish failed:', err.message));
    res.json(full);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) return res.status(502).json({ error: `Stripe error: ${err.message}` });
    next(err);
  }
}

async function getAblyToken(req, res, next) {
  try {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });

    const { rows } = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const channel = `restaurant:${restaurant_id}:orders`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}

// Subscribe token for ONE order's channel -- the guest-safe realtime surface
// (contrast getAblyToken above: staff-only, restaurant-wide). The order's id
// is the only credential, same as the guest site's own status-polling call --
// a guest only ever learns it because it's their own order, handed to their
// browser at checkout. No join code: unlike a table session, a standalone
// order has no shared/guessable identifier a stranger could stumble onto.
async function getOrderAblyToken(req, res, next) {
  try {
    if (!ablyClient) return res.status(503).json({ error: 'Realtime notifications are not configured' });
    const { rows } = await pool.query(
      'SELECT id FROM restaurant_order WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    const channel = `restaurant-order:${rows[0].id}`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}

module.exports = { listMenuItems, createMenuItem, updateMenuItem, bulkDeleteMenuItems, renameMenuCategory, listOrders, getOrder, createOrder, updateOrder, updateOrderStatus, createOrderPaymentIntent, confirmOrderPayment, getAblyToken, getOrderAblyToken };
