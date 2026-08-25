const pool = require('../db');
const { publishTableSessionClosed } = require('../lib/ably');

// Realtime close notification for the order-channel subscribers. Built from
// the UPDATE's RETURNING row (bare session columns only) -- never from the
// SELECT rows here, which carry the property's stripe_secret_key.
function announceClosed(session, tableNumber) {
  publishTableSessionClosed(session.restaurant_id, session.property_id, { ...session, table_number: tableNumber ?? null })
    .catch((err) => console.error('Ably publish failed:', err.message));
}

async function sessionTotalCents(sessionId) {
  const { rows } = await pool.query(
    // A voided round must not be charged for.
    `SELECT COALESCE(SUM(total_price), 0) AS total FROM restaurant_order WHERE table_session_id = $1 AND status <> 'cancelled'`,
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
      `SELECT rts.*, p.stripe_secret_key, p.currency, rt.table_number
       FROM restaurant_table_session rts
       JOIN property p ON p.id = rts.property_id
       JOIN restaurant_table rt ON rt.id = rts.table_id
       WHERE rts.id = $1 AND rts.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!propRows.length) return res.status(404).json({ error: 'Session not found' });
    const session = propRows[0];
    if (!session.stripe_secret_key) return res.status(409).json({ error: 'No Stripe secret key configured for this property' });
    if (session.status !== 'open') return res.status(409).json({ error: 'Session is not open' });
    if (session.payment_status === 'paid') return res.status(409).json({ error: 'Session already paid' });

    const stripe = require('stripe')(session.stripe_secret_key);

    // Which rail the tab is being settled on. 'terminal' (default) is the
    // waiter's card reader -- a card_present intent that only Stripe Terminal
    // can complete. 'online' is the guest paying on their own phone (the
    // website's scan-to-order page) via Stripe Elements, which cannot render
    // a card_present intent, so it needs a regular automatic-methods intent.
    const channel = req.body?.channel === 'online' ? 'online' : 'terminal';
    const isTerminalIntent = (intent) => (intent.payment_method_types || []).includes('card_present');

    // Idempotency: a retry (e.g. a failed tap) shouldn't create a second
    // charge against the same tab. Reuse the existing intent unless it's
    // already reached a terminal state.
    if (session.stripe_payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(session.stripe_payment_intent_id);
      if (['requires_payment_method', 'requires_confirmation', 'requires_capture', 'requires_action'].includes(existing.status)) {
        const sameChannel = (channel === 'terminal') === isTerminalIntent(existing);
        if (sameChannel) {
          return res.json({ client_secret: existing.client_secret, payment_intent_id: existing.id, amount: existing.amount, channel });
        }
        // The other rail already started on this tab. If nothing has been
        // attached yet, hand the tab over: cancel and mint on the new rail.
        // If a payment is mid-flight (confirming / 3DS), don't yank it.
        if (existing.status !== 'requires_payment_method') {
          return res.status(409).json({
            error: `A ${isTerminalIntent(existing) ? 'card reader' : 'online'} payment is already in progress on this tab`,
            payment_intent_id: existing.id,
          });
        }
        await stripe.paymentIntents.cancel(existing.id);
        // fall through and mint a fresh intent on the requested channel
      }
      // Crash-window recovery: the tap succeeded but the app died before
      // calling close, so the charge exists while the session still reads
      // unpaid. Creating a fresh intent here would charge the customer
      // twice -- instead, settle the session with the charge that already
      // landed, applying the same checks close-with-payment would.
      if (existing.status === 'succeeded') {
        const expected = await sessionTotalCents(session.id);
        if (existing.amount !== expected) {
          return res.status(409).json({
            error: 'A payment already succeeded for a different amount',
            payment_intent_id: existing.id,
          });
        }
        const { rows: active } = await pool.query(
          `SELECT COUNT(*) FROM restaurant_order WHERE table_session_id = $1 AND status IN ('pending', 'confirmed', 'preparing')`,
          [session.id]
        );
        if (parseInt(active[0].count, 10) > 0) {
          return res.status(409).json({
            error: 'A payment already succeeded but the session has active orders',
            payment_intent_id: existing.id,
          });
        }
        const { rows: settled } = await pool.query(
          `UPDATE restaurant_table_session SET status = 'closed', closed_at = now(), payment_status = 'paid', paid_at = now()
           WHERE id = $1 RETURNING *`,
          [session.id]
        );
        announceClosed(settled[0], session.table_number);
        return res.json({ already_paid: true, payment_intent_id: existing.id });
      }
      // canceled -> fall through and mint a fresh intent
    }

    const amount = await sessionTotalCents(session.id);
    if (amount <= 0) return res.status(409).json({ error: 'Nothing to pay on this session' });
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: session.currency.toLowerCase(),
      ...(channel === 'online'
        ? { automatic_payment_methods: { enabled: true } }
        : { payment_method_types: ['card_present'] }),
      capture_method: 'automatic',
      metadata: { table_session_id: session.id, restaurant_id: session.restaurant_id, channel },
    });

    await pool.query(`UPDATE restaurant_table_session SET stripe_payment_intent_id = $1 WHERE id = $2`, [intent.id, session.id]);
    res.json({ client_secret: intent.client_secret, payment_intent_id: intent.id, amount, channel });
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

// Session row plus everything a "what's on this tab" view needs: the
// table's number, every order under the session (with line items), and
// the reservation it was seated from (null for walk-ins).
async function loadSessionDetails(session) {
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
      `SELECT id, contact_name, contact_email, contact_phone, party_size, reservation_date, start_time, end_time, status, notes
       FROM restaurant_reservation WHERE id = $1`,
      [session.reservation_id]
    );
    reservation = reservations[0] ?? null;
  }

  return { ...session, orders, reservation };
}

const SESSION_SELECT = `SELECT rts.*, t.table_number
  FROM restaurant_table_session rts
  JOIN restaurant_table t ON t.id = rts.table_id`;

async function getOpenSession(req, res, next) {
  try {
    const { table_id, restaurant_id, status } = req.query;
    if (!table_id && !restaurant_id) return res.status(400).json({ error: 'table_id or restaurant_id is required' });

    // Bulk mode (restaurant_id, no table_id): the Tables grid needs to know
    // which tables are occupied, not the full "what's on this tab" detail
    // loadSessionDetails builds for a single table -- a lightweight row per
    // open session is enough and avoids an orders+reservation join per table.
    if (!table_id) {
      const { rows } = await pool.query(
        `SELECT id, table_id, status, opened_at FROM restaurant_table_session
         WHERE restaurant_id = $1 AND property_id = $2 AND status = $3`,
        [restaurant_id, req.property_id, status || 'open']
      );
      return res.json(rows);
    }

    let query = `${SESSION_SELECT} WHERE rts.table_id = $1 AND rts.property_id = $2`;
    const params = [table_id, req.property_id];
    if (status) { params.push(status); query += ` AND rts.status = $${params.length}`; }
    query += ' ORDER BY rts.opened_at DESC LIMIT 1';

    const { rows: sessions } = await pool.query(query, params);
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });

    res.json(await loadSessionDetails(sessions[0]));
  } catch (err) { next(err); }
}

async function getSession(req, res, next) {
  try {
    const { rows: sessions } = await pool.query(
      `${SESSION_SELECT} WHERE rts.id = $1 AND rts.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!sessions.length) return res.status(404).json({ error: 'Session not found' });

    res.json(await loadSessionDetails(sessions[0]));
  } catch (err) { next(err); }
}

async function closeSession(req, res, next) {
  try {
    const { stripe_payment_intent_id } = req.body ?? {};

    const { rows: sessions } = await pool.query(
      `SELECT rts.*, p.stripe_secret_key, rt.table_number
       FROM restaurant_table_session rts
       JOIN property p ON p.id = rts.property_id
       JOIN restaurant_table rt ON rt.id = rts.table_id
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
    announceClosed(rows[0], session.table_number);
    res.json(rows[0]);
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: `Stripe error: ${err.message}` });
    }
    next(err);
  }
}

module.exports = { getOpenSession, getSession, closeSession, createConnectionToken, createSessionPaymentIntent };
