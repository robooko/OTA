-- Departure timetable on tour: when departure_times is non-empty, the
-- boot/daily seeder materialises tour_slot rows out to a rolling horizon
-- (see src/lib/tourSlotSeeder.js) -- same open-by-default approach as the
-- golf tee sheet, for fixed-schedule tours like a ferry. departure_days
-- limits it to certain weekdays (0 = Sunday .. 6 = Saturday); NULL = every
-- day. departure_times NULL or empty = manual slots via
-- POST /api/tours/slots/bulk, unchanged.

ALTER TABLE tour
  ADD COLUMN IF NOT EXISTS departure_times TIME[],
  ADD COLUMN IF NOT EXISTS departure_days  SMALLINT[];
