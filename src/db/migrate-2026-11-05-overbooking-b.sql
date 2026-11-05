-- Room overbooking, part B (run on live AFTER the new code is deployed).
-- Idempotent. Picks up bookings the old code wrote between part A and the
-- deploy, then tightens: every booking has a sold type, and the one-room-per-
-- stay overlap rule gives way to idx_booking_night_room (per night).

UPDATE booking b SET room_type_id = r.room_type_id FROM room r WHERE r.id = b.room_id AND b.room_type_id IS NULL;
INSERT INTO booking_night (booking_id, property_id, night, room_id)
SELECT b.id, b.property_id, n::date, b.room_id
FROM booking b, generate_series(b.check_in, b.check_out - 1, interval '1 day') n
WHERE b.status IN ('pending_payment', 'confirmed', 'checked_in')
   OR (b.status = 'checked_out' AND n::date < CURRENT_DATE)
ON CONFLICT DO NOTHING;

ALTER TABLE booking ALTER COLUMN room_type_id SET NOT NULL;
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_no_overlap;
