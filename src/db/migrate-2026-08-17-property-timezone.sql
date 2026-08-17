-- One-time migration: adds timezone to property, defaulting existing rows
-- to Europe/London for the same reason as the currency default (GBP) --
-- the platform's own base locale, no consistent per-row signal to infer
-- a better default from.

ALTER TABLE property ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) NOT NULL DEFAULT 'Europe/London';
