// Agent purchases -> paid pro shop orders -- see
// docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
// Polls the venue's own Stripe account (no webhook to register per venue)
// for completed Checkout Sessions whose lines carry this shop's feed ids.
const pool = require('../db');
const { allocateOrderReference } = require('./orderReference');
const { publishNewProshopOrder } = require('./ably');
const { feedId } = require('./agenticFeed');
const { fromStripeAmount } = require('./stripeAmount');

// The seller guide expands line items with this preview version to get
// price.external_reference (the feed id).
const SESSION_API_VERSION = '2025-12-15.preview';
const LOOKBACK_SECONDS = 24 * 60 * 60;
// Stripe amount -> price in the session's currency (zero-decimal aware).
const money = (n, currency) => fromStripeAmount(n ?? 0, currency) / 100;
const cap = (s, n) => (s == null ? s : String(s).slice(0, n));

function formatAddress(details) {
  const a = details?.address;
  if (!a) return null;
  return [details.name, a.line1, a.line2, a.city, [a.state, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');
}

// Pure. null = no line is one of this property's feed items (not ours).
function sessionToOrder(session, itemsByFeedId) {
  const cents = (n) => money(n, session.currency);
  const lines = (session.line_items?.data ?? []).map((li) => {
    const item = itemsByFeedId.get(li.price?.external_reference);
    const unit = cents(li.price?.unit_amount);
    return {
      item_id: item?.id ?? null,
      item_name: cap(item?.name ?? li.description ?? 'Item', 100),
      unit_price: unit,
      quantity: li.quantity,
      subtotal: Math.round(unit * li.quantity * 100) / 100,
    };
  });
  if (!lines.some((l) => l.item_id)) return null;
  const c = session.customer_details ?? {};
  const ship = session.collected_information?.shipping_details;
  return {
    order: {
      contact_name: cap(c.name || ship?.name || 'Agent Guest', 100),
      contact_email: c.email ?? null,
      contact_phone: cap(c.phone ?? null, 30),
      shipping_address: formatAddress(ship),
      shipping_cost: cents(session.total_details?.amount_shipping),
      tax_amount: cents(session.total_details?.amount_tax),
      items_subtotal: cents(session.amount_subtotal),
      total_price: cents(session.amount_total),
      stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      stripe_checkout_session_id: session.id,
    },
    lines,
  };
}

// Caller owns the transaction. null = this session was already recorded.
async function recordOrder(db, propertyId, shopId, { order, lines }) {
  const reference = await allocateOrderReference(db, propertyId);
  const { rows: [row] } = await db.query(
    `INSERT INTO proshop_order
       (property_id, shop_id, reference, contact_name, contact_email, contact_phone, shipping_address,
        shipping_cost, items_subtotal, tax_amount, total_price, status, payment_status,
        stripe_payment_intent_id, stripe_checkout_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'paid', 'paid', $12, $13)
     ON CONFLICT (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [propertyId, shopId, reference, order.contact_name, order.contact_email, order.contact_phone, order.shipping_address,
     order.shipping_cost, order.items_subtotal, order.tax_amount, order.total_price,
     order.stripe_payment_intent_id, order.stripe_checkout_session_id]
  );
  if (!row) return null;
  for (const l of lines) {
    await db.query(
      `INSERT INTO proshop_order_item (order_id, item_id, item_name, unit_price, quantity, subtotal) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, l.item_id, l.item_name, l.unit_price, l.quantity, l.subtotal]
    );
    // Same rule as the website's decrementStockForItems, but inside this
    // transaction: the order and its stock change commit together.
    if (l.item_id) {
      await db.query(
        `UPDATE proshop_item SET stock_quantity = GREATEST(stock_quantity - $1, 0) WHERE id = $2 AND stock_quantity IS NOT NULL`,
        [l.quantity, l.item_id]
      );
    }
  }
  return { ...row, items: lines };
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Every property with agentic commerce configured, enabled or not:
// enabled=false only stops feed uploads (spec), and agents can still sell
// what Stripe already holds until the connection is turned off in Stripe.
async function orderProperties(db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, stripe_secret_key, agentic_commerce FROM property
     WHERE agentic_commerce IS NOT NULL AND stripe_secret_key IS NOT NULL`
  );
  return rows;
}

function afterRecordDefault(order, p) {
  // Lazy require: controllers/proshop pulls in a lot; keeps this module's
  // pure exports cheap to load in the check script.
  const { emailOrderConfirmationInBackground, closeBasketsInBackground, forFeed } = require('../controllers/proshop');
  publishNewProshopOrder(p.id, forFeed(order)).catch((err) => console.error('Ably publish failed:', err.message));
  emailOrderConfirmationInBackground(order.id, p.id);
  closeBasketsInBackground(order);
}

async function sweepProperty(p, {
  db = pool,
  stripe = require('stripe')(p.stripe_secret_key),
  transact = inTransaction,
  afterRecord = afterRecordDefault,
} = {}) {
  // The shop the site sells from: first active shop by name (GET /api/proshop/shops).
  const { rows: [shop] } = await db.query(`SELECT id FROM shop WHERE status = 'active' AND property_id = $1 ORDER BY name LIMIT 1`, [p.id]);
  if (!shop) { console.warn(`Agentic orders ${p.name}: no active shop`); return 0; }
  const { rows: items } = await db.query('SELECT id, name FROM proshop_item WHERE property_id = $1', [p.id]);
  const itemsByFeedId = new Map(items.map((i) => [feedId(i.id), i]));
  const { rows: seenRows } = await db.query(
    `SELECT stripe_checkout_session_id FROM proshop_order
     WHERE property_id = $1 AND stripe_checkout_session_id IS NOT NULL AND created_at > now() - interval '3 days'`,
    [p.id]
  );
  const seen = new Set(seenRows.map((r) => r.stripe_checkout_session_id));

  let recorded = 0;
  // ponytail: a venue that also uses Checkout elsewhere gets those sessions
  // re-retrieved each sweep for 24 h; remember skipped ids if that grows.
  for await (const s of stripe.checkout.sessions.list({ status: 'complete', created: { gt: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS }, limit: 100 })) {
    if (seen.has(s.id)) continue;
    try {
      const full = await stripe.checkout.sessions.retrieve(s.id, {}, { apiVersion: SESSION_API_VERSION });
      // 'complete' isn't 'collected': delayed methods (e.g. ACH) settle later.
      // Not added to `seen`, so a later sweep records it once it's paid.
      if (full.payment_status !== 'paid') continue;
      // Every page -- an expanded retrieve stops at the first 10 lines.
      const data = [];
      for await (const li of stripe.checkout.sessions.listLineItems(s.id, { expand: ['data.price'], limit: 100 }, { apiVersion: SESSION_API_VERSION })) data.push(li);
      const mapped = sessionToOrder({ ...full, line_items: { data } }, itemsByFeedId);
      if (!mapped) continue;
      const order = await transact((client) => recordOrder(client, p.id, shop.id, mapped));
      if (!order) continue;
      afterRecord(order, p);
      recorded++;
    } catch (err) {
      console.error(`Agentic order ${s.id} for ${p.name} failed:`, err.message);
    }
  }
  return recorded;
}

async function sweepOrders() {
  for (const p of await orderProperties()) {
    try {
      const n = await sweepProperty(p);
      if (n) console.log(`Agentic orders ${p.name}: recorded ${n}`);
    } catch (err) {
      console.error(`Agentic orders ${p.name} failed:`, err.message);
    }
  }
}

function startAgenticOrderJob() {
  const run = () => sweepOrders().catch((err) => console.error('Agentic order sweep failed:', err.message));
  run();
  const timer = setInterval(run, 5 * 60 * 1000);
  timer.unref();
}

module.exports = { sessionToOrder, recordOrder, orderProperties, sweepProperty, startAgenticOrderJob };
