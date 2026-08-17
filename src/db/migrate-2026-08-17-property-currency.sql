-- One-time migration: adds currency to property, defaulting existing rows
-- to GBP (the platform's own base currency) since properties have no
-- consistent country pattern to infer a better per-row default from.

ALTER TABLE property ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'GBP';
