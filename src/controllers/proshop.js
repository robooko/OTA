const pool = require('../db');
const { publishProshopItemAdded, publishProshopItemRemoved } = require('../lib/ably');

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
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price, shop_id } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

    const { rows: shops } = await pool.query(
      `SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]
    );
    if (!shops.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows } = await pool.query(
      `INSERT INTO proshop_item (property_id, shop_id, name, description, category, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, shop_id, name, description || null, category || null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { name, description, category, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE proshop_item SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         category    = COALESCE($3, category),
         price       = COALESCE($4, price),
         status      = COALESCE($5, status)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [name, description, category, price, status, req.params.id, req.property_id]
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

    const { rows: bookings } = await pool.query(
      `SELECT id FROM golf_booking WHERE id = $1 AND property_id = $2`, [booking_id, req.property_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Golf booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO golf_booking_item (property_id, booking_id, item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, booking_id, item_id, items[0].name, quantity, items[0].price]
    );
    const created = { ...rows[0], total: rows[0].quantity * rows[0].unit_price };

    publishProshopItemAdded(req.property_id, created).catch((err) => console.error('Ably publish failed:', err.message));

    res.status(201).json(created);
  } catch (err) { next(err); }
}

async function removeBookingItem(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM golf_booking_item WHERE id = $1 AND booking_id = $2 AND property_id = $3 RETURNING id`,
      [req.params.id, req.params.booking_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

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
    const { rows } = await pool.query(query, params);
    res.json(rows);
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
// change what gets charged.
async function createOrder(req, res, next) {
  try {
    const { shop_id, contact_name, contact_email, contact_phone, shipping_address, shipping_cost, notes, items } = req.body ?? {};
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });
    if (!contact_name) return res.status(400).json({ error: 'contact_name is required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items must be a non-empty array of { item_id, quantity }' });
    const shippingCost = shipping_cost != null ? Number(shipping_cost) : 0;
    if (!Number.isFinite(shippingCost) || shippingCost < 0) return res.status(400).json({ error: 'shipping_cost must be a non-negative number' });

    const { rows: shops } = await pool.query(`SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]);
    if (!shops.length) return res.status(404).json({ error: 'Shop not found' });

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
          `SELECT name, price FROM proshop_item WHERE id = $1 AND shop_id = $2 AND property_id = $3 AND status = 'active'`,
          [item_id, shop_id, req.property_id]
        );
        if (!catalog.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Item ${item_id} is not available in this shop` });
        }
        const unitPrice = parseFloat(catalog[0].price);
        const subtotal = Math.round(unitPrice * qty * 100) / 100;
        itemsSubtotal += subtotal;
        lineItems.push({ item_id, item_name: catalog[0].name, unit_price: unitPrice, quantity: qty, subtotal });
      }
      itemsSubtotal = Math.round(itemsSubtotal * 100) / 100;
      const totalPrice = Math.round((itemsSubtotal + shippingCost) * 100) / 100;

      const { rows: orderRows } = await client.query(
        `INSERT INTO proshop_order
           (property_id, shop_id, contact_name, contact_email, contact_phone, shipping_address, shipping_cost, items_subtotal, total_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [req.property_id, shop_id, contact_name, contact_email || null, contact_phone || null, shipping_address || null, shippingCost, itemsSubtotal, totalPrice, notes || null]
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

async function updateOrderStatus(req, res, next) {
  try {
    const { status } = req.body ?? {};
    if (!['pending', 'paid', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: "status must be 'pending', 'paid', or 'cancelled'" });
    }
    const { rows } = await pool.query(
      `UPDATE proshop_order SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
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
        await pool.query(`UPDATE proshop_order SET status = 'paid', payment_status = 'paid' WHERE id = $1`, [order.id]);
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

    const { rows } = await pool.query(
      `UPDATE proshop_order SET status = 'paid', payment_status = 'paid' WHERE id = $1 AND property_id = $2 RETURNING *`,
      [order.id, req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) return res.status(502).json({ error: `Stripe error: ${err.message}` });
    next(err);
  }
}

module.exports = {
  listShops, createShop, updateShop,
  listItems, createItem, updateItem,
  listBookingItems, addBookingItem, removeBookingItem,
  listOrders, getOrder, createOrder, updateOrderStatus,
  createOrderPaymentIntent, confirmOrderPayment,
};
