-- One-time migration: adds an optional per-restaurant currency override.
-- NULL means "inherit the parent property's currency" -- same nullable-
-- override-falls-back-to-parent shape as room_availability.override_rate.

ALTER TABLE restaurant ADD COLUMN IF NOT EXISTS currency VARCHAR(3);
