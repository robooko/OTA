-- One-time migration: partial-day (hourly) blocks on spa_therapist_time_off,
-- alongside the existing whole-day rows. See
-- docs/superpowers/specs/2026-08-30-spa-barbershop-bookings-design.md for
-- the whole-day design this extends.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline). Idempotent via IF NOT EXISTS. Non-destructive:
-- existing rows are untouched -- both new columns default to NULL, which is
-- exactly today's "whole day" meaning, so nothing already stored changes
-- behavior.

ALTER TABLE spa_therapist_time_off ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE spa_therapist_time_off ADD COLUMN IF NOT EXISTS end_time   TIME;

-- Both null (whole day) or both set (a specific window) -- never one or the
-- other. Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard with a
-- catalog check instead of letting a second run fail on a duplicate name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spa_therapist_time_off_time_pair_check'
  ) THEN
    ALTER TABLE spa_therapist_time_off
      ADD CONSTRAINT spa_therapist_time_off_time_pair_check CHECK ((start_time IS NULL) = (end_time IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spa_therapist_time_off_time_order_check'
  ) THEN
    ALTER TABLE spa_therapist_time_off
      ADD CONSTRAINT spa_therapist_time_off_time_order_check CHECK (start_time IS NULL OR start_time < end_time);
  END IF;
END $$;
