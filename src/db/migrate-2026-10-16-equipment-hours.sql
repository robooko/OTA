-- Equipment opening hours and slot grid for hourly hires (spec
-- docs/superpowers/specs/2026-10-16-equipment-hire-time-windows-design.md).
-- New columns only; safe to run twice.
--   node scripts/run-migration.js src/db/migrate-2026-10-16-equipment-hours.sql

ALTER TABLE equipment ADD COLUMN IF NOT EXISTS open_time  TIME;
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS close_time TIME;
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS slot_interval_minutes INT NOT NULL DEFAULT 60;
