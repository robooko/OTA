// "Nando's style" food ordering: order and pay on the website, no running
// tab. See migrate-2026-09-06-restaurant-web-orders.sql for why this is a
// separate table from restaurant_order (table/booking-required, billed
// through restaurant_table_session) rather than a variant of it. Follows
// proshop.js's order controller shape closely -- same idempotent
// PaymentIntent pattern, same "never trust a client-supplied price" rule.
const pool = require('../db');
const { computeOrderTax } = require('../lib/tax');

const VALID_STATUSES = ['pending', 'paid', 'preparing', 'ready', 'completed', 'cancelled'];

async function orderTotalCents(order) {
  return Math.round(parseFloat(order.total_price) * 100);
}

function orderWithItems(order, items) {
  return { ...order, items };
}

async function loadOrderWithItems(orderId, propertyId) {
  const { rows: orders } = await pool.query(
    `SELECT o.*, p.stripe_secret_key, p.currency
     FROM restaurant_web_order o JOIN property p ON p.id = o.property_id
     WHERE o.id = $1 AND o.property_id = $2`,
    [orderId, propertyId]
  );
  if (!orders.length) return null;
  const { rows: items } = await pool.query(
    `SELECT id, item_id, item_name, unit_price, quantity, variant, subtotal FROM restaurant_web_order_item WHERE order_id = $1 ORDER BY item_name`,
    [orderId]
  );
  return orderWithItems(orders[0], items);
}

async function listOrders(req, res, next) {
  try {
    const { restaurant_id, status, cursor, limit } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `SELECT * FROM restaurant_web_order WHERE property_id = $1`;
    const params = [req.property_id];
    if (restaurant_id) { params.push(restaurant_id); query += ` AND restaurant_id = $${params.length}`; }
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

// items: [{ item_id, quantity, variant? }]. Prices always come from the
// live menu here, never from the request. contact_name is optional --
// defaults to "Website Guest" so a PaymentIntent can exist before a
// checkout form's contact fields even render (see proshop.js's createOrder
// for the same reasoning); PUT .../:id patches in the real details before
// confirm-payment.
async function createOrder(req, res, next) {
  try {
    const { restaurant_id, table_id, contact_name, contact_email, contact_phone, scheduled_for, notes, items } = req.body ?? {};
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items must be a non-empty array of { item_id, quantity, variant? }' });

    const { rows: restaurants } = await pool.query(`SELECT id FROM restaurant WHERE id = $1 AND property_id = $2`, [restaurant_id, req.property_id]);
    if (!restaurants.length) return res.status(404).json({ error: 'Restaurant not found' });

    if (table_id) {
      const { rows: tables } = await pool.query(
        `SELECT id FROM restaurant_table WHERE id = $1 AND restaurant_id = $2 AND property_id = $3 AND status = 'active'`,
        [table_id, restaurant_id, req.property_id]
      );
      if (!tables.length) return res.status(404).json({ error: 'Table not found' });
    }

    const { rows: properties } = await pool.query(
      `SELECT tax_enabled, tax_rate, tax_inclusive FROM property WHERE id = $1`, [req.property_id]
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let itemsSubtotal = 0;
      const lineItems = [];
      for (const { item_id, quantity, variant } of items) {
        const qty = Number(quantity);
        if (!item_id || !Number.isInteger(qty) || qty < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Each item needs a valid item_id and a positive integer quantity' });
        }
        const { rows: menu } = await client.query(
          `SELECT name, price, variants FROM restaurant_menu_item WHERE id = $1 AND restaurant_id = $2 AND property_id = $3 AND status = 'active'`,
          [item_id, restaurant_id, req.property_id]
        );
        if (!menu.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Item ${item_id} is not available on this menu` });
        }
        if (variant && !menu[0].variants.includes(variant)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `"${variant}" is not a valid variant for ${menu[0].name}` });
        }
        const unitPrice = parseFloat(menu[0].price);
        const subtotal = Math.round(unitPrice * qty * 100) / 100;
        itemsSubtotal += subtotal;
        lineItems.push({ item_id, item_name: menu[0].name, unit_price: unitPrice, quantity: qty, variant: variant || null, subtotal });
      }
      itemsSubtotal = Math.round(itemsSubtotal * 100) / 100;
      const { taxAmount, totalExtra } = computeOrderTax(properties[0], itemsSubtotal);
      const totalPrice = Math.round((itemsSubtotal + totalExtra) * 100) / 100;

      const { rows: orderRows } = await client.query(
        `INSERT INTO restaurant_web_order
           (property_id, restaurant_id, table_id, contact_name, contact_email, contact_phone, scheduled_for, notes, items_subtotal, tax_amount, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [req.property_id, restaurant_id, table_id || null, contact_name || 'Website Guest', contact_email || null, contact_phone || null, scheduled_for || null, notes || null, itemsSubtotal, taxAmount, totalPrice]
      );
      const order = orderRows[0];

      for (const li of lineItems) {
        await client.query(
          `INSERT INTO restaurant_web_order_item (order_id, item_id, item_name, unit_price, quantity, variant, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, li.item_id, li.item_name, li.unit_price, li.quantity, li.variant, li.subtotal]
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

// Per field: omit = unchanged. Covers kitchen status updates (preparing ->
// ready -> completed) and the checkout flow patching in real contact
// details before confirm-payment -- same split as proshop.js's updateOrder.
async function updateOrder(req, res, next) {
  try {
    const { status, contact_name, contact_email, contact_phone, notes } = req.body ?? {};
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE restaurant_web_order SET
         status        = COALESCE($1, status),
         contact_name  = COALESCE($2, contact_name),
         contact_email = COALESCE($3, contact_email),
         contact_phone = COALESCE($4, contact_phone),
         notes         = COALESCE($5, notes)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [status, contact_name, contact_email, contact_phone, notes, req.params.id, req.property_id]
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

    if (order.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount: existing.amount });
      }
      if (existing.status === 'succeeded') {
        if (existing.amount !== amount) {
          return res.status(409).json({ error: 'A payment already succeeded for a different amount', payment_intent_id: existing.id });
        }
        await pool.query(`UPDATE restaurant_web_order SET status = 'paid', payment_status = 'paid' WHERE id = $1`, [order.id]);
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled/failed -> fall through and mint a fresh intent
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: order.currency.toLowerCase(),
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      capture_method: 'automatic',
      metadata: { restaurant_web_order_id: order.id, restaurant_id: order.restaurant_id },
    });

    await pool.query(`UPDATE restaurant_web_order SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, order.id]);
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
      `UPDATE restaurant_web_order SET status = 'paid', payment_status = 'paid' WHERE id = $1 AND property_id = $2 RETURNING *`,
      [order.id, req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) return res.status(502).json({ error: `Stripe error: ${err.message}` });
    next(err);
  }
}

module.exports = { listOrders, getOrder, createOrder, updateOrder, createOrderPaymentIntent, confirmOrderPayment };
