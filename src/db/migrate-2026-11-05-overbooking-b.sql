-- Room overbooking, part B (run on live AFTER the new code is deployed).
-- Idempotent; run it as soon as the deploy is healthy. Reconciles what the old
-- code wrote between part A and the deploy, then tightens: every booking has a sold type, and the one-room-per-
-- stay overlap rule gives way to idx_booking_night_room (per night).

UPDATE booking b SET room_type_id = r.room_type_id FROM room r WHERE r.id = b.room_id AND b.room_type_id IS NULL;
-- The old code cancelled, expired and moved bookings in that window without
-- touching booking_night. Drop nights no booking holds any more, then rebuild
-- the nights of bookings only the old code has placed (every placement by the
-- new code logs a booking_room_move; the old code always set room_id).
DELETE FROM booking_night bn USING booking b
WHERE b.id = bn.booking_id
  AND NOT (b.status IN ('pending_payment', 'confirmed', 'checked_in') OR (b.status = 'checked_out' AND bn.night < CURRENT_DATE));
DELETE FROM booking_night bn USING booking b
WHERE b.id = bn.booking_id AND b.room_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM booking_room_move m WHERE m.booking_id = b.id);
INSERT INTO booking_night (booking_id, property_id, night, room_id)
SELECT b.id, b.property_id, n::date, b.room_id
FROM booking b, generate_series(b.check_in, b.check_out - 1, interval '1 day') n
WHERE b.status IN ('pending_payment', 'confirmed', 'checked_in')
   OR (b.status = 'checked_out' AND n::date < CURRENT_DATE)
ON CONFLICT DO NOTHING;

ALTER TABLE booking ALTER COLUMN room_type_id SET NOT NULL;
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_no_overlap;
