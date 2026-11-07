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
    `SELECT b.id, b.total_price, r.room_number, rt.name AS room_type_name, p.currency,
            (b.check_out - b.check_in) AS nights
     FROM booking b
     LEFT JOIN room r     ON r.id = b.room_id
     LEFT JOIN room_type rt ON rt.id = b.room_type_id
     JOIN property p ON p.id = b.property_id
     WHERE b.id = $1 AND b.property_id = $2`,
    [bookingId, propertyId]
  );
  if (!bookingRes.rows.length) return null;
  const booking = bookingRes.rows[0];

  const [extrasRes, ordersRes, adjustmentsRes, paymentsRes, minibarRes, spaRes] = await Promise.all([
    pool.query(
      `SELECT be.id, be.quantity, be.unit_price, e.name
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY be.created_at`,
      [bookingId]
    ),
    pool.query(
      `SELECT o.id, o.total_price, o.created_at, o.payment_status, r.name AS restaurant_name
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
    // Housekeeping's minibar count; included items are priced 0 and never
    // reach the folio.
    pool.query(
      `SELECT id, item_name, quantity, unit_price, created_at
       FROM minibar_usage
       WHERE booking_id = $1 AND unit_price > 0
       ORDER BY created_at, item_name`,
      [bookingId]
    ),
    pool.query(
      `SELECT sa.id, COALESCE(sa.price, st.price, 0) AS price, sa.payment_status, st.name,
              (sa.appointment_date + sa.start_time) AT TIME ZONE p.timezone AS created_at
       FROM spa_appointment sa
       JOIN spa_treatment st ON st.id = sa.treatment_id
       JOIN property p ON p.id = sa.property_id
       WHERE sa.booking_id = $1 AND sa.status NOT IN ('cancelled', 'pending')
       ORDER BY sa.appointment_date, sa.start_time`,
      [bookingId]
    ),
  ]);

  const items = [
    {
      type: 'room',
      // Imported past stays have no room: fall back to the room type.
      description: [booking.room_number ? `Room ${booking.room_number}` : booking.room_type_name, `${booking.nights} night${booking.nights === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
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
      description: `F&B · ${o.restaurant_name}`,
      amount: o.total_price,
      created_at: o.created_at,
      paid: o.payment_status === 'paid',
    })),
    ...spaRes.rows.map((a) => ({
      type: 'spa',
      source_id: a.id,
      description: `Spa · ${a.name}`,
      amount: a.price,
      created_at: a.created_at,
      paid: a.payment_status === 'paid',
    })),
    ...adjustmentsRes.rows.map((a) => ({
      type: 'adjustment',
      source_id: a.id,
      description: a.description,
      amount: a.amount,
      created_at: a.created_at,
    })),
    ...minibarRes.rows.map((m) => ({
      type: 'minibar',
      source_id: m.id,
      description: m.quantity > 1 ? `${m.item_name} × ${m.quantity}` : m.item_name,
      amount: fromCents(toCents(m.unit_price) * m.quantity),
      created_at: m.created_at,
    })),
  ];

  // paid: settled at the outlet (card at the restaurant, imported as paid) --
  // listed on the folio but not owed on it.
  const chargesCents = items.filter((i) => !i.paid).reduce((sum, i) => sum + toCents(i.amount), 0);
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
