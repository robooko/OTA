const pool = require('../db');

// NUMERIC(10,2) string -> integer minor units; same conversion as
// treatmentPriceCents (spaPayments.js) and sessionTotalCents.
function toCents(value) {
  return Math.round(parseFloat(value) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// The guest folio, computed live -- never stored. Single source of truth
// for both GET /api/bookings/:id/folio and the check-out gate. Returns
// null when the booking doesn't exist in this property (callers 404).
async function computeFolio(bookingId, propertyId) {
  const bookingRes = await pool.query(
    `SELECT b.id, b.total_price, r.room_number, p.currency,
            (b.check_out - b.check_in) AS nights
     FROM booking b
     JOIN room r     ON r.id = b.room_id
     JOIN property p ON p.id = b.property_id
     WHERE b.id = $1 AND b.property_id = $2`,
    [bookingId, propertyId]
  );
  if (!bookingRes.rows.length) return null;
  const booking = bookingRes.rows[0];

  const [extrasRes, ordersRes, adjustmentsRes, paymentsRes] = await Promise.all([
    pool.query(
      `SELECT be.id, be.quantity, be.unit_price, e.name
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY be.created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT o.id, o.total_price, o.created_at, r.name AS restaurant_name
       FROM restaurant_order o
       JOIN restaurant r ON r.id = o.restaurant_id
       WHERE o.booking_id = $1 AND o.status <> 'cancelled'
       ORDER BY o.created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT id, description, amount, created_at
       FROM folio_adjustment
       WHERE booking_id = $1
       ORDER BY created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT * FROM payment
       WHERE booking_id = $1
       ORDER BY paid_at DESC NULLS LAST, id`,
      [bookingId]
    ),
  ]);

  const items = [
    {
      type: 'room',
      description: `Room ${booking.room_number} · ${booking.nights} night${booking.nights === 1 ? '' : 's'}`,
      amount: booking.total_price,
    },
    ...extrasRes.rows.map((e) => ({
      type: 'extra',
      source_id: e.id,
      description: e.quantity > 1 ? `${e.name} × ${e.quantity}` : e.name,
      amount: fromCents(toCents(e.unit_price) * e.quantity),
    })),
    ...ordersRes.rows.map((o) => ({
      type: 'room_service',
      source_id: o.id,
      description: `Room service · ${o.restaurant_name}`,
      amount: o.total_price,
      created_at: o.created_at,
    })),
    ...adjustmentsRes.rows.map((a) => ({
      type: 'adjustment',
      source_id: a.id,
      description: a.description,
      amount: a.amount,
      created_at: a.created_at,
    })),
  ];

  const chargesCents = items.reduce((sum, i) => sum + toCents(i.amount), 0);
  const paymentsCents = paymentsRes.rows
    .filter((p) => p.status === 'completed')
    .reduce((sum, p) => sum + toCents(p.amount), 0);

  return {
    booking_id: booking.id,
    currency: booking.currency,
    items,
    charges_total: fromCents(chargesCents),
    payments: paymentsRes.rows,
    payments_total: fromCents(paymentsCents),
    balance: fromCents(chargesCents - paymentsCents),
  };
}

module.exports = { computeFolio, toCents, fromCents };
