// Pro-shop returns: the status machine, the DB loaders shared by the
// proshop controller, the enquiry list and the AI pipeline, and the
// generated enquiry message. Design: docs/superpowers/specs/
// 2026-09-08-proshop-returns-design.md.
const pool = require('../db');
const { normaliseReference } = require('./orderReference');

const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled'];

// from -> allowed next states. Terminal states have no exits; refunds are
// manual in Stripe, 'refunded' just records that it happened.
const RETURN_TRANSITIONS = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['received', 'cancelled'],
  received: ['refunded', 'cancelled'],
  refunded: [],
  rejected: [],
  cancelled: [],
};

// event_inquiry.event_type for return threads -- the feeds show it as a
// badge and the AI prompt keys off it, so it's a fixed literal.
const RETURN_EVENT_TYPE = 'Return order items';

// The guest-facing identity of an order: reference + the email on it. A
// mismatch on either half is the same 404 to the caller (no hint which).
// Only paid, uncancelled orders resolve -- nothing else is returnable.
async function findOrderByReferenceAndEmail(propertyId, reference, email, client = pool, { lock = false } = {}) {
  const ref = normaliseReference(reference);
  const mail = String(email ?? '').trim().toLowerCase();
  if (!ref || !mail) return null;
  const { rows } = await client.query(
    `SELECT * FROM proshop_order
     WHERE property_id = $1 AND reference = $2 AND lower(contact_email) = $3
       AND payment_status = 'paid' AND status <> 'cancelled'${lock ? ' FOR UPDATE' : ''}`,
    [propertyId, ref, mail]
  );
  return rows[0] ?? null;
}

// Every line of an order with how many can still be returned: bought minus
// everything already on a return that isn't rejected/cancelled.
async function loadOrderLinesWithReturnable(orderId, client = pool) {
  const { rows } = await client.query(
    `SELECT oi.id, oi.item_id, oi.item_name, oi.unit_price, oi.quantity,
            (oi.quantity - COALESCE((
              SELECT SUM(ri.quantity) FROM proshop_return_item ri
              JOIN proshop_return r ON r.id = ri.return_id
              WHERE ri.order_item_id = oi.id AND r.status NOT IN ('rejected', 'cancelled')
            ), 0))::int AS returnable_quantity
     FROM proshop_order_item oi WHERE oi.order_id = $1 ORDER BY oi.item_name`,
    [orderId]
  );
  return rows;
}

// Lines for a page of returns in one query. item_id rides along so
// restoreStockForItems can use these rows directly.
async function loadReturnItems(returnIds) {
  const byReturn = new Map();
  if (!returnIds.length) return byReturn;
  const { rows } = await pool.query(
    `SELECT ri.return_id, ri.order_item_id, ri.quantity, oi.item_id, oi.item_name, oi.unit_price
     FROM proshop_return_item ri JOIN proshop_order_item oi ON oi.id = ri.order_item_id
     WHERE ri.return_id = ANY($1) ORDER BY oi.item_name`,
    [returnIds]
  );
  for (const row of rows) {
    if (!byReturn.has(row.return_id)) byReturn.set(row.return_id, []);
    byReturn.get(row.return_id).push(row);
  }
  return byReturn;
}

const RETURN_SELECT = `SELECT r.*, o.reference, o.contact_name, o.contact_email
                       FROM proshop_return r JOIN proshop_order o ON o.id = r.order_id`;

async function loadReturn(returnId, propertyId) {
  const { rows } = await pool.query(`${RETURN_SELECT} WHERE r.id = $1 AND r.property_id = $2`, [returnId, propertyId]);
  if (!rows.length) return null;
  const items = await loadReturnItems([rows[0].id]);
  return { ...rows[0], items: items.get(rows[0].id) ?? [] };
}

// The return behind an enquiry thread, or null for a general enquiry.
async function loadReturnForInquiry(inquiryId) {
  const { rows } = await pool.query(`${RETURN_SELECT} WHERE r.event_inquiry_id = $1`, [inquiryId]);
  if (!rows.length) return null;
  const items = await loadReturnItems([rows[0].id]);
  return { ...rows[0], items: items.get(rows[0].id) ?? [] };
}

// The enquiry's message body. lines: [{ item_name, quantity }].
function buildReturnMessage(reference, lines, reason) {
  const body = [`Return request for order ${reference}`, ''];
  for (const line of lines) body.push(`${line.quantity} × ${line.item_name}`);
  body.push('', `Reason: ${String(reason ?? '').trim() || '(none given)'}`);
  return body.join('\n');
}

module.exports = {
  RETURN_STATUSES, RETURN_TRANSITIONS, RETURN_EVENT_TYPE,
  findOrderByReferenceAndEmail, loadOrderLinesWithReturnable, loadReturnItems,
  loadReturn, loadReturnForInquiry, buildReturnMessage,
};
