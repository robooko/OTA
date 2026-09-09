const pool = require('../db');
const {
  publishProshopItemAdded,
  publishProshopItemRemoved,
  publishNewProshopOrder,
  publishProshopOrderStatusChanged,
  publishProshopReturnStatusChanged,
  publishNewInquiry,
} = require('../lib/ably');
const {
  RETURN_STATUSES, RETURN_TRANSITIONS, RETURN_EVENT_TYPE,
  findOrderByReferenceAndEmail, loadOrderLinesWithReturnable, loadReturnItems, loadReturn,
  buildReturnMessage, ensureFirstReply,
} = require('../lib/proshopReturns');
const { validateBranding, isValidUuid } = require('../middleware/validate');
const { runAiReply } = require('../lib/aiReplyPipeline');
const { computeOrderTax } = require('../lib/tax');
const { generateOrderReference } = require('../lib/orderReference');

// ── Shops ─────────────────────────────────────────────────────────────────────

async function listShops(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM shop WHERE status = 'active' AND property_id = $1 ORDER BY name`,
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createShop(req, res, next) {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO shop (property_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
      [req.property_id, name, description || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateShop(req, res, next) {
  try {
    const { name, description, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE shop SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         status      = COALESCE($3, status)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [name, description, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category, shop_id } = req.query;
    let query = `SELECT * FROM proshop_item WHERE status = 'active'`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (shop_id) { params.push(shop_id); query += ` AND shop_id = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND property_id = $${params.length}`;
    // Grouped variants sort adjacent to each other (by their shared
    // product_group), each group taking its place alphabetically among
    // standalone items (which sort by their own name instead).
    query += ' ORDER BY category, COALESCE(product_group, name), variant_label NULLS FIRST, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// stock_quantity: omit or null = untracked/unlimited (no check, no
// decrement, ever). A number = tracked from here on.
function isValidStockQuantity(value) {
  return value === undefined || value === null || (Number.isInteger(value) && value >= 0);
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price, shop_id, stock_quantity, product_group, variant_label } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });
    if (!isValidStockQuantity(stock_quantity)) {
      return res.status(400).json({ error: 'stock_quantity must be a non-negative integer, or null/omitted for unlimited' });
    }

    const { rows: shops } = await pool.query(
      `SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]
    );
    if (!shops.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows } = await pool.query(
      `INSERT INTO proshop_item (property_id, shop_id, name, description, category, price, stock_quantity, product_group, variant_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, shop_id, name, description || null, category || null, price, stock_quantity ?? null, product_group || null, variant_label || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { name, description, category, price, status, stock_quantity, product_group, variant_label } = req.body;
    if (stock_quantity !== undefined && !isValidStockQuantity(stock_quantity)) {
      return res.status(400).json({ error: 'stock_quantity must be a non-negative integer, or null for unlimited' });
    }
    // stock_quantity, product_group and variant_label are all nullable-on-
    // purpose (untracked / ungrouped), so they can't use the same
    // "COALESCE = omit" convention as the other fields here -- a
    // present-but-null value must clear them, not leave the old value in
    // place. undefined (the field wasn't sent at all) still means "leave
    // unchanged" for all three.
    const { rows } = await pool.query(
      `UPDATE proshop_item SET
         name           = COALESCE($1, name),
         description    = COALESCE($2, description),
         category       = COALESCE($3, category),
         price          = COALESCE($4, price),
         status         = COALESCE($5, status),
         stock_quantity = CASE WHEN $6 THEN $7  ELSE stock_quantity END,
         product_group  = CASE WHEN $8 THEN $9  ELSE product_group END,
         variant_label  = CASE WHEN $10 THEN $11 ELSE variant_label END
       WHERE id = $12 AND property_id = $13 RETURNING *`,
      [
        name, description, category, price, status,
        stock_quantity !== undefined, stock_quantity ?? null,
        product_group !== undefined, product_group ?? null,
        variant_label !== undefined, variant_label ?? null,
        req.params.id, req.property_id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Booking items ─────────────────────────────────────────────────────────────

async function listBookingItems(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT gbi.*, p.category
       FROM golf_booking_item gbi
       LEFT JOIN proshop_item p ON p.id = gbi.item_id
       WHERE gbi.booking_id = $1 AND gbi.property_id = $2
       ORDER BY p.category, gbi.item_name`,
      [req.params.booking_id, req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function addBookingItem(req, res, next) {
  try {
    const { booking_id } = req.params;
    const { item_id, quantity = 1 } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows: items } = await pool.query(
      `SELECT * FROM proshop_item WHERE id = $1 AND status = 'active' AND property_id = $2`,
      [item_id, req.property_id]
    );
    if (!items.length) return res.status(404).json({ error: 'Item not found' });
    if (items[0].stock_quantity !== null && items[0].stock_quantity < quantity) {
      return res.status(409).json({ error: `Only ${items[0].stock_quantity} of "${items[0].name}" left in stock` });
    }

    const { rows: bookings } = await pool.query(
      `SELECT id FROM golf_booking WHERE id = $1 AND property_id = $2`, [booking_id, req.property_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Golf booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO golf_booking_item (property_id, booking_id, item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, booking_id, item_id, items[0].name, quantity, items[0].price]
    );
    // Racy against a concurrent sale of the same item (two staff members,
    // same tee sheet) -- the WHERE guard means a loser here just leaves
    // stock at 0 rather than going negative, sold or not.
    if (items[0].stock_quantity !== null) {
      await pool.query(
        `UPDATE proshop_item SET stock_quantity = GREATEST(stock_quantity - $1, 0) WHERE id = $2 AND stock_quantity IS NOT NULL`,
        [quantity, item_id]
      );
    }
    const created = { ...rows[0], total: rows[0].quantity * rows[0].unit_price };

    publishProshopItemAdded(req.property_id, created).catch((err) => console.error('Ably publish failed:', err.message));

    res.status(201).json(created);
  } catch (err) { next(err); }
}

async function removeBookingItem(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM golf_booking_item WHERE id = $1 AND booking_id = $2 AND property_id = $3 RETURNING id, item_id, quantity`,
      [req.params.id, req.params.booking_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    if (rows[0].item_id) {
      await pool.query(
        `UPDATE proshop_item SET stock_quantity = stock_quantity + $1 WHERE id = $2 AND stock_quantity IS NOT NULL`,
        [rows[0].quantity, rows[0].item_id]
      );
    }

    publishProshopItemRemoved(req.property_id, { id: rows[0].id, booking_id: req.params.booking_id })
      .catch((err) => console.error('Ably publish failed:', err.message));

    res.status(204).end();
  } catch (err) { next(err); }
}

// ── Orders (guest self-checkout from the venue's website, no booking) ─────────
// Payment mirrors restaurant_table_session's 'online' channel: a regular
// (not card_present) PaymentIntent on the property's own Stripe account,
// verified server-side before payment_status flips -- see
// docs/superpowers/specs/2026-08-23-restaurant-tap-to-pay-backend-requirements.md
// for the pattern this follows. shipping_cost is trusted as given (the
// ordering website computes it); item prices never are -- items_subtotal is
// always recomputed here from the live proshop_item.price.

async function orderTotalCents(order) {
  return Math.round((parseFloat(order.total_price)) * 100);
}

function orderWithItems(order, items) {
  return { ...order, items };
}

// The order row carries no fulfillment_method column of its own -- derived
// here for @forgebuild/hotal-ui's <live-shop-orders-feed>, which renders a
// pickup/shipping icon per order, from whether shipping_address was given.
function forFeed(order) {
  return { ...order, fulfillment_method: order.shipping_address ? 'shipping' : 'pickup' };
}

// Only called once per order, guarded by the caller checking the
// pre-update payment_status wasn't already 'paid' -- a retried
// confirm-payment call (client retry after a dropped response, the
// already-paid idempotency branch) must never decrement twice for the same
// sale. stock_quantity IS NOT NULL guard: untracked items are skipped
// entirely, cheaper than a no-op UPDATE per line.
async function decrementStockForItems(items) {
  for (const item of items) {
    if (!item.item_id) continue;
    await pool.query(
      `UPDATE proshop_item SET stock_quantity = GREATEST(stock_quantity - $1, 0) WHERE id = $2 AND stock_quantity IS NOT NULL`,
      [item.quantity, item.item_id]
    );
  }
}

async function restoreStockForItems(items) {
  for (const item of items) {
    if (!item.item_id) continue;
    await pool.query(
      `UPDATE proshop_item SET stock_quantity = stock_quantity + $1 WHERE id = $2 AND stock_quantity IS NOT NULL`,
      [item.quantity, item.item_id]
    );
  }
}

async function loadOrderWithItems(orderId, propertyId) {
  const { rows: orders } = await pool.query(
    `SELECT o.*, p.stripe_secret_key, p.currency
     FROM proshop_order o JOIN property p ON p.id = o.property_id
     WHERE o.id = $1 AND o.property_id = $2`,
    [orderId, propertyId]
  );
  if (!orders.length) return null;
  const { rows: items } = await pool.query(
    `SELECT id, item_id, item_name, unit_price, quantity, subtotal FROM proshop_order_item WHERE order_id = $1 ORDER BY item_name`,
    [orderId]
  );
  return orderWithItems(orders[0], items);
}

async function listOrders(req, res, next) {
  try {
    const { shop_id, status, cursor, limit } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `SELECT * FROM proshop_order WHERE property_id = $1`;
    const params = [req.property_id];
    if (shop_id) { params.push(shop_id); query += ` AND shop_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (cursor) { params.push(cursor); query += ` AND created_at < $${params.length}`; }
    params.push(take);
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows: orders } = await pool.query(query, params);

    // One extra query for every order on the page, not one per order --
    // the dashboard's order list needs an item summary ("2x Golf Glove")
    // without an N+1 round trip per row.
    if (orders.length) {
      const { rows: items } = await pool.query(
        `SELECT order_id, item_id, item_name, unit_price, quantity, subtotal
         FROM proshop_order_item WHERE order_id = ANY($1) ORDER BY item_name`,
        [orders.map((o) => o.id)]
      );
      const itemsByOrder = new Map();
      for (const item of items) {
        if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
        itemsByOrder.get(item.order_id).push(item);
      }
      for (const order of orders) order.items = itemsByOrder.get(order.id) ?? [];
    }

    res.json(orders);
  } catch (err) { next(err); }
}

async function getOrder(req, res, next) {
  try {
    const full = await loadOrderWithItems(req.params.id, req.property_id);
    if (!full) return res.status(404).json({ error: 'Order not found' });
    const { stripe_secret_key, ...order } = full;
    res.json(order);
  } catch (err) { next(err); }
}

// items: [{ item_id, quantity }]. Every price comes from the live catalogue
// here, never from the request -- a tampered client-supplied price can't
// change what gets charged. contact_name is optional here on purpose: a
// website checkout (e.g. hotal-ui's <booking-checkout>) needs a
// PaymentIntent to exist before its own contact-detail form even renders,
// so the order is created from the cart alone first ("Website Guest" until
// patched) and PUT /orders/:id fills in the real contact details once the
// guest has entered them, right before confirm-payment.
async function createOrder(req, res, next) {
  try {
    const { shop_id, contact_name, contact_email, contact_phone, shipping_address, shipping_cost, notes, items } = req.body ?? {};
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items must be a non-empty array of { item_id, quantity }' });
    const shippingCost = shipping_cost != null ? Number(shipping_cost) : 0;
    if (!Number.isFinite(shippingCost) || shippingCost < 0) return res.status(400).json({ error: 'shipping_cost must be a non-negative number' });

    const { rows: shops } = await pool.query(`SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]);
    if (!shops.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows: properties } = await pool.query(
      `SELECT tax_enabled, tax_rate, tax_inclusive FROM property WHERE id = $1`, [req.property_id]
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let itemsSubtotal = 0;
      const lineItems = [];
      for (const { item_id, quantity } of items) {
        const qty = Number(quantity);
        if (!item_id || !Number.isInteger(qty) || qty < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Each item needs a valid item_id and a positive integer quantity' });
        }
        const { rows: catalog } = await client.query(
          `SELECT name, price, stock_quantity FROM proshop_item WHERE id = $1 AND shop_id = $2 AND property_id = $3 AND status = 'active'`,
          [item_id, shop_id, req.property_id]
        );
        if (!catalog.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Item ${item_id} is not available in this shop` });
        }
        if (catalog[0].stock_quantity !== null && catalog[0].stock_quantity < qty) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Only ${catalog[0].stock_quantity} of "${catalog[0].name}" left in stock` });
        }
        const unitPrice = parseFloat(catalog[0].price);
        const subtotal = Math.round(unitPrice * qty * 100) / 100;
        itemsSubtotal += subtotal;
        lineItems.push({ item_id, item_name: catalog[0].name, unit_price: unitPrice, quantity: qty, subtotal });
      }
      itemsSubtotal = Math.round(itemsSubtotal * 100) / 100;
      const { taxAmount, totalExtra } = computeOrderTax(properties[0], itemsSubtotal);
      const totalPrice = Math.round((itemsSubtotal + shippingCost + totalExtra) * 100) / 100;

      // Unique per property; the existence check runs inside the transaction
      // so a collision (vanishingly rare at 32^6) is retried instead of
      // aborting the transaction on the unique index.
      let reference;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateOrderReference();
        const { rows: clash } = await client.query(
          'SELECT 1 FROM proshop_order WHERE property_id = $1 AND reference = $2', [req.property_id, candidate]
        );
        if (!clash.length) { reference = candidate; break; }
      }
      if (!reference) throw new Error('Could not allocate an order reference');

      const { rows: orderRows } = await client.query(
        `INSERT INTO proshop_order
           (property_id, shop_id, reference, contact_name, contact_email, contact_phone, shipping_address, shipping_cost, items_subtotal, tax_amount, total_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [req.property_id, shop_id, reference, contact_name || 'Website Guest', contact_email || null, contact_phone || null, shipping_address || null, shippingCost, itemsSubtotal, taxAmount, totalPrice, notes || null]
      );
      const order = orderRows[0];

      for (const li of lineItems) {
        await client.query(
          `INSERT INTO proshop_order_item (order_id, item_id, item_name, unit_price, quantity, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [order.id, li.item_id, li.item_name, li.unit_price, li.quantity, li.subtotal]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(orderWithItems(order, lineItems));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
}

// Per field: omit = unchanged. Covers both staff use (status only, e.g.
// marking an order fulfilled/cancelled) and the checkout flow patching in
// the real contact details once the guest has entered them, between the
// PaymentIntent being created (from the cart alone, no contact info yet --
// see createOrder) and confirm-payment.
async function updateOrder(req, res, next) {
  try {
    const { status, contact_name, contact_email, contact_phone, shipping_address, notes } = req.body ?? {};
    if (status !== undefined && !['pending', 'paid', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: "status must be 'pending', 'paid', or 'cancelled'" });
    }

    // Only a paid order actually drew down stock, so only cancelling one
    // that was paid should give it back -- fetched before the update below
    // so it reflects the status this request is transitioning FROM.
    let wasPaid = false;
    if (status === 'cancelled') {
      const { rows: before } = await pool.query(
        `SELECT status FROM proshop_order WHERE id = $1 AND property_id = $2`, [req.params.id, req.property_id]
      );
      wasPaid = before[0]?.status === 'paid';
    }

    const { rows } = await pool.query(
      `UPDATE proshop_order SET
         status           = COALESCE($1, status),
         contact_name     = COALESCE($2, contact_name),
         contact_email    = COALESCE($3, contact_email),
         contact_phone    = COALESCE($4, contact_phone),
         shipping_address = COALESCE($5, shipping_address),
         notes            = COALESCE($6, notes)
       WHERE id = $7 AND property_id = $8 RETURNING *`,
      [status, contact_name, contact_email, contact_phone, shipping_address, notes, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    if (wasPaid) {
      // Restores the full ordered quantity per line, with no awareness of
      // any return already 'received' against this order (which already put
      // its returned quantity back -- see updateReturnStatus). Cancelling a
      // paid order that has a received return therefore over-counts stock
      // by the returned amount. Left as-is for now; staff can correct stock
      // directly in the Items dialog.
      const { rows: items } = await pool.query(
        `SELECT item_id, quantity FROM proshop_order_item WHERE order_id = $1`, [rows[0].id]
      );
      await restoreStockForItems(items);
    }
    if (status !== undefined) {
      publishProshopOrderStatusChanged(req.property_id, { id: rows[0].id, status: rows[0].status, payment_status: rows[0].payment_status })
        .catch((err) => console.error('Ably publish failed:', err.message));
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createOrderPaymentIntent(req, res, next) {
  try {
    const order = await loadOrderWithItems(req.params.id, req.property_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (order.status === 'cancelled') return res.status(409).json({ error: 'Order is cancelled' });
    if (order.payment_status === 'paid') return res.status(409).json({ error: 'Order already paid' });

    const stripe = require('stripe')(order.stripe_secret_key);
    const amount = await orderTotalCents(order);

    // Idempotency: a retry (page refresh, a dropped connection after Stripe
    // confirmed) shouldn't create a second charge for the same order --
    // same reasoning as restaurant_table_session's payment-intent endpoint.
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
          `UPDATE proshop_order SET status = 'paid', payment_status = 'paid' WHERE id = $1 RETURNING *`,
          [order.id]
        );
        await decrementStockForItems(order.items);
        publishNewProshopOrder(req.property_id, forFeed(orderWithItems(paidRows[0], order.items)))
          .catch((err) => console.error('Ably publish failed:', err.message));
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled/failed -> fall through and mint a fresh intent
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: order.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      capture_method: 'automatic',
      metadata: { proshop_order_id: order.id, shop_id: order.shop_id },
    });

    await pool.query(`UPDATE proshop_order SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, order.id]);
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

    const order = await loadOrderWithItems(req.params.id, req.property_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (payment_intent_id !== order.stripe_payment_intent_id) {
      return res.status(409).json({ error: 'Payment intent does not match this order' });
    }
    if (!order.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

    const stripe = require('stripe')(order.stripe_secret_key);
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status !== 'succeeded') {
      return res.status(409).json({ error: `Payment has not succeeded (status: ${intent.status})` });
    }
    const expected = await orderTotalCents(order);
    if (intent.amount !== expected) {
      return res.status(409).json({ error: 'Payment amount does not match the order total' });
    }

    const alreadyPaid = order.payment_status === 'paid';
    const { rows } = await pool.query(
      `UPDATE proshop_order SET status = 'paid', payment_status = 'paid' WHERE id = $1 AND property_id = $2 RETURNING *`,
      [order.id, req.property_id]
    );
    // Guard against decrementing twice for one sale -- this endpoint has no
    // "already paid" early-return (a client retry after a dropped response
    // just re-confirms harmlessly), so the stock/feed side effects below
    // must only fire on the actual first transition to paid.
    if (!alreadyPaid) {
      await decrementStockForItems(order.items);
      publishNewProshopOrder(req.property_id, forFeed(orderWithItems(rows[0], order.items)))
        .catch((err) => console.error('Ably publish failed:', err.message));
    }
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) return res.status(502).json({ error: `Stripe error: ${err.message}` });
    next(err);
  }
}

// ── Returns ───────────────────────────────────────────────────────────────────
// Design: docs/superpowers/specs/2026-09-08-proshop-returns-design.md.

// Guest-facing order lookup: reference + the email on the order. The same
// 404 for a wrong reference, a wrong email, or an unpaid/cancelled order,
// so the endpoint can't be used to probe which half was right.
async function lookupOrder(req, res, next) {
  try {
    const { reference, email } = req.body ?? {};
    const order = await findOrderByReferenceAndEmail(req.property_id, reference, email);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const items = await loadOrderLinesWithReturnable(order.id);
    // Explicit allowlist, not a destructure-out: this endpoint is proxied to
    // anonymous guests, so staff-only fields (notes, shipping_address,
    // contact_phone, contact_email, stripe_payment_intent_id, property_id,
    // shop_id) must never leak here even if new columns are added later.
    const {
      id, reference: orderReference, created_at, status, payment_status,
      items_subtotal, tax_amount, shipping_cost, total_price, contact_name,
    } = order;
    res.json({
      id, reference: orderReference, created_at, status, payment_status,
      items_subtotal, tax_amount, shipping_cost, total_price, contact_name,
      items,
    });
  } catch (err) { next(err); }
}

async function listReturns(req, res, next) {
  try {
    const { status, order_id, cursor, limit } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `SELECT r.*, o.reference, o.contact_name, o.contact_email
                 FROM proshop_return r JOIN proshop_order o ON o.id = r.order_id
                 WHERE r.property_id = $1`;
    const params = [req.property_id];
    if (status) { params.push(status); query += ` AND r.status = $${params.length}`; }
    if (order_id) { params.push(order_id); query += ` AND r.order_id = $${params.length}`; }
    if (cursor) { params.push(cursor); query += ` AND r.created_at < $${params.length}`; }
    params.push(take);
    query += ` ORDER BY r.created_at DESC LIMIT $${params.length}`;
    const { rows: returns } = await pool.query(query, params);
    const items = await loadReturnItems(returns.map((r) => r.id));
    for (const r of returns) r.items = items.get(r.id) ?? [];
    res.json(returns);
  } catch (err) { next(err); }
}

async function getReturn(req, res, next) {
  try {
    const ret = await loadReturn(req.params.id, req.property_id);
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    res.json(ret);
  } catch (err) { next(err); }
}

// Status only. Legal moves are RETURN_TRANSITIONS; 'received' puts the
// returned quantities back into stock (the goods are on the shelf again).
// The UPDATE is conditional on the status we validated against, so two
// staff changing it at once can't both succeed.
async function updateReturnStatus(req, res, next) {
  try {
    const { status } = req.body ?? {};
    if (!RETURN_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${RETURN_STATUSES.join(', ')}` });
    }
    const current = await loadReturn(req.params.id, req.property_id);
    if (!current) return res.status(404).json({ error: 'Return not found' });
    if (!RETURN_TRANSITIONS[current.status].includes(status)) {
      return res.status(409).json({ error: `Cannot move a return from '${current.status}' to '${status}'` });
    }
    const { rows } = await pool.query(
      `UPDATE proshop_return SET status = $1, updated_at = now()
       WHERE id = $2 AND property_id = $3 AND status = $4 RETURNING *`,
      [status, req.params.id, req.property_id, current.status]
    );
    if (!rows.length) return res.status(409).json({ error: 'Return changed while updating — reload and try again' });
    if (status === 'received') await restoreStockForItems(current.items);
    publishProshopReturnStatusChanged(req.property_id, { id: current.id, order_id: current.order_id, reference: current.reference, status })
      .catch((err) => console.error('Ably publish failed:', err.message));
    res.json({ ...current, ...rows[0], items: current.items });
  } catch (err) { next(err); }
}

// Two body shapes: a guest (website, API key) sends { reference, email };
// staff (dashboard, Clerk token) may send { order_id } instead. Everything
// else is common: reason, items [{ order_item_id, quantity }], branding.
// One transaction inserts the enquiry thread, the return and its lines,
// with the order row locked so two simultaneous requests can't both pass
// the quantity cap. No token gate (unlike createInquiry): the return must
// be recorded regardless, and the fallback acknowledgement is free.
async function createReturn(req, res, next) {
  try {
    const { reference, email, order_id, reason, items, branding } = req.body ?? {};
    const staffRail = req.auth_method === 'bearer';
    if (order_id !== undefined && !staffRail) {
      return res.status(400).json({ error: 'order_id is only accepted from the dashboard; send reference and email' });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items must be a non-empty array of { order_item_id, quantity }' });
    }
    if (reason != null && (typeof reason !== 'string' || reason.length > 2000)) {
      return res.status(400).json({ error: 'reason must be a string of at most 2000 characters' });
    }
    const brandingError = validateBranding(branding);
    if (brandingError) return res.status(400).json({ error: brandingError });
    const seen = new Set();
    for (const line of items) {
      const qty = Number(line?.quantity);
      if (!line?.order_item_id || !isValidUuid(line.order_item_id) || !Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({ error: 'Each item needs a valid order_item_id and a positive integer quantity' });
      }
      if (seen.has(line.order_item_id)) return res.status(400).json({ error: `Duplicate order_item_id ${line.order_item_id}` });
      seen.add(line.order_item_id);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let order;
      if (order_id !== undefined) {
        if (!isValidUuid(order_id)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
        ({ rows: [order] } = await client.query(
          `SELECT * FROM proshop_order WHERE id = $1 AND property_id = $2
             AND payment_status = 'paid' AND status <> 'cancelled' FOR UPDATE`,
          [order_id, req.property_id]
        ));
      } else {
        order = await findOrderByReferenceAndEmail(req.property_id, reference, email, client, { lock: true });
      }
      if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
      if (!order.contact_email) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Order has no email address to reply to' });
      }

      const lines = await loadOrderLinesWithReturnable(order.id, client);
      const byId = new Map(lines.map((l) => [l.id, l]));
      const returnLines = [];
      for (const { order_item_id, quantity } of items) {
        const line = byId.get(order_item_id);
        if (!line) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Item ${order_item_id} is not on this order` }); }
        const qty = Number(quantity);
        if (qty > line.returnable_quantity) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Only ${line.returnable_quantity} of "${line.item_name}" can still be returned` });
        }
        returnLines.push({ order_item_id, quantity: qty, item_name: line.item_name });
      }

      const message = buildReturnMessage(order.reference, returnLines, reason);
      const { rows: [inquiry] } = await client.query(
        `INSERT INTO event_inquiry (property_id, name, email, phone, event_type, message, branding)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.property_id, order.contact_name, order.contact_email, order.contact_phone, RETURN_EVENT_TYPE, message,
          branding ? JSON.stringify(branding) : null]
      );
      const { rows: [ret] } = await client.query(
        `INSERT INTO proshop_return (property_id, order_id, event_inquiry_id, reason, raised_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.property_id, order.id, inquiry.id, String(reason ?? '').trim() || null, staffRail ? 'staff' : 'guest']
      );
      for (const l of returnLines) {
        await client.query(
          `INSERT INTO proshop_return_item (return_id, order_item_id, quantity) VALUES ($1, $2, $3)`,
          [ret.id, l.order_item_id, l.quantity]
        );
      }
      await client.query('COMMIT');

      const full = await loadReturn(ret.id, req.property_id);
      const payload = { ...inquiry, return: full };
      publishNewInquiry(req.property_id, payload).catch((err) => console.error('Ably publish failed:', err.message));
      // Fire-and-forget like createInquiry: drafting takes tens of seconds.
      // Whatever the pipeline does (auto-send, draft, off, out of tokens,
      // failure), ensureFirstReply then guarantees the guest one reply.
      runAiReply({ inquiryId: inquiry.id, triggerType: 'new_inquiry' })
        .catch((err) => console.error('AI reply pipeline failed:', err.message))
        .then(() => ensureFirstReply(inquiry.id))
        .catch((err) => console.error(`Return acknowledgement failed for inquiry ${inquiry.id}:`, err.message));

      res.status(201).json(payload);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
}

module.exports = {
  listShops, createShop, updateShop,
  listItems, createItem, updateItem,
  listBookingItems, addBookingItem, removeBookingItem,
  listOrders, getOrder, createOrder, updateOrder,
  createOrderPaymentIntent, confirmOrderPayment,
  lookupOrder, listReturns, getReturn, updateReturnStatus,
  createReturn,
};
