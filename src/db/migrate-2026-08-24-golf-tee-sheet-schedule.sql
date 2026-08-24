-- Tee-sheet schedule on golf_course: when first_tee, last_tee, and
-- tee_interval_minutes are all set, the boot/daily seeder materialises
-- tee_time rows out to a rolling horizon (see src/lib/teeTimeSeeder.js),
-- so staff only manage exceptions -- same open-by-default philosophy as
-- room_availability. All three NULL (the default) = manual tee sheet via
-- POST /api/golf/tee-times/bulk, unchanged.

ALTER TABLE golf_course
  ADD COLUMN IF NOT EXISTS first_tee            TIME,
  ADD COLUMN IF NOT EXISTS last_tee             TIME,
  ADD COLUMN IF NOT EXISTS tee_interval_minutes INT,
  ADD COLUMN IF NOT EXISTS default_max_players  INT NOT NULL DEFAULT 4;
