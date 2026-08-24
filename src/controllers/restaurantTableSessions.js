const pool = require('../db');

async function sessionTotalCents(sessionId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_price), 0) AS total FROM restaurant_order WHERE table_session_id = $1`,
    [sessionId]
  );
  return Math.round(parseFloat(rows[0].total) * 100);
}

async function createConnectionToken(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT name, stripe_secret_key, stripe_terminal_location_id FROM property WHERE id = $1`,
      [req.property_id]
    );
    const property = rows[0];
    if (!property?.stripe_secret_key) {
      return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    }
    const stripe = require('stripe')(property.stripe_secret_key);

    let locationId = property.stripe_terminal_location_id;
    if (!locationId) {
      // Tap to Pay has no physical reader to register, but the Terminal API
      // still requires a Location object. property has no address data at
      // all today, so this is a placeholder, not a real address -- fine,
      // since Tap to Pay never ships anything here.
      const location = await stripe.terminal.locations.create({
        display_name: property.name,
        address: { line1: 'Unknown', city: 'Unknown', postal_code: 'SW1A 1AA', country: 'GB' },
      });
      locationId = location.id;
      await pool.query(`UPDATE property SET stripe_terminal_location_id = $1 WHERE id = $2`, [locationId, req.property_id]);
    }

    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret, location_id: locationId });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function createSessionPaymentIntent(req, res, next) {
  try {
    const { rows: propRows } = await pool.query(
      `SELECT rts.*, p.stripe_secret_key, p.currency
       FROM restaurant_table_session rts
       JOIN property p ON p.id = rts.property_id
       WHERE rts.id = $1 AND rts.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!propRows.length) return res.status(404).json({ error: 'Session not found' });
    const session = propRows[0];
    if (!session.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (session.status !== 'open') return res.status(409).json({ error: 'Session is not open' });
    if (session.payment_status === 'paid') return res.status(409).json({ error: 'Session already paid' });

    const stripe = require('stripe')(session.stripe_secret_key);

    // Idempotency: a retry (e.g. a failed tap) shouldn't create a second
    // charge against the same tab. Reuse the existing intent unless it's
    // already reached a terminal state.
    if (session.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(session.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id });
      }
    }

    const amount = await sessionTotalCents(session.id);
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: session.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: { table_session_id: session.id, restaurant_id: session.restaurant_id },
    });

    await pool.query(`UPDATE restaurant_table_session SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, session.id]);
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

async function getOpenSession(req, res, next) {
  try {
    const { table_id, status } = req.query;
    if (!table_id) return res.status(400).json({ error: 'table_id is required' });

    let query = `SELECT * FROM restaurant_table_session WHERE table_id = $1 AND property_id = $2`;
    const params = [table_id, req.property_id];
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    query += ' ORDER BY opened_at DESC LIMIT 1';

    const { rows: sessions } = await pool.query(query, params);
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessions[0];

    const { rows: orders } = await pool.query(
      `SELECT o.*,
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
       WHERE o.table_session_id = $1
       GROUP BY o.id
       ORDER BY o.created_at`,
      [session.id]
    );

    let reservation = null;
    if (session.reservation_id) {
      const { rows: reservations } = await pool.query(
        `SELECT id, contact_name, party_size, notes FROM restaurant_reservation WHERE id = $1`,
        [session.reservation_id]
      );
      reservation = reservations[0] ?? null;
    }

    res.json({ ...session, orders, reservation });
  } catch (err) { next(err); }
}

async function closeSession(req, res, next) {
  try {
    const { stripe_payment_intent_id } = req.body ?? {};

    const { rows: sessions } = await pool.query(
      `SELECT rts.*, p.stripe_secret_key
       FROM restaurant_table_session rts
       JOIN property p ON p.id = rts.property_id
       WHERE rts.id = $1 AND rts.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessions[0];

    const { rows: active } = await pool.query(
      `SELECT COUNT(*) FROM restaurant_order WHERE table_session_id = $1 AND status IN ('pending', 'confirmed', 'preparing')`,
      [req.params.id]
    );
    const activeCount = parseInt(active[0].count, 10);
    if (activeCount > 0) {
      return res.status(409).json({ error: `Cannot close: ${activeCount} order(s) still active` });
    }

    // Paying and closing are the same real-world moment -- no separate
    // "mark paid" endpoint. Omitting stripe_payment_intent_id closes the
    // table without recording a Stripe payment (comp'd, cash paid another
    // way, etc.) -- payment_status stays whatever it already was.
    let paymentColumns = '';
    const params = [req.params.id, req.property_id];
    if (stripe_payment_intent_id) {
      if (stripe_payment_intent_id !== session.stripe_payment_intent_id) {
        return res.status(409).json({ error: 'Payment intent does not match this session' });
      }
      if (!session.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });

      const stripe = require('stripe')(session.stripe_secret_key);
      const intent = await stripe.paymentIntents.retrieve(stripe_payment_intent_id);
      if (intent.status !== 'succeeded') {
        return res.status(409).json({ error: `Payment has not succeeded (status: ${intent.status})` });
      }
      const expectedAmount = await sessionTotalCents(req.params.id);
      if (intent.amount !== expectedAmount) {
        return res.status(409).json({ error: 'Payment amount does not match the current session total' });
      }

      paymentColumns = `, payment_status = 'paid', paid_at = now()`;
    }

    const { rows } = await pool.query(
      `UPDATE restaurant_table_session SET status = 'closed', closed_at = now()${paymentColumns}
       WHERE id = $1 AND property_id = $2 RETURNING *`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { getOpenSession, closeSession, createConnectionToken, createSessionPaymentIntent };
