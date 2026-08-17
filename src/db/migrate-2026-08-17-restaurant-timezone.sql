-- One-time migration: adds an optional per-restaurant timezone override.
-- NULL means "inherit the parent property's timezone" -- same nullable-
-- override-falls-back-to-parent shape as room_availability.override_rate.

ALTER TABLE restaurant ADD COLUMN IF NOT EXISTS timezone VARCHAR(50);
