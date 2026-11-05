// Shared check-script fixtures.

// booking_night rows for a booking inserted straight into the booking table
// (the app writes them through roomNights.holdStay): every night of its stay
// in its room_id, unless it holds nothing (cancelled / expired / walked).
async function holdNights(db, bookingId) {
  await db.query(
    `INSERT INTO booking_night (booking_id, property_id, night, room_id)
     SELECT b.id, b.property_id, n::date, b.room_id
     FROM booking b, generate_series(b.check_in, b.check_out - 1, interval '1 day') n
     WHERE b.id = $1 AND b.status NOT IN ('cancelled', 'expired', 'walked')
     ON CONFLICT DO NOTHING`, [bookingId]);
  return bookingId;
}

module.exports = { holdNights };
