-- One-time migration: folio_adjustment, manual guest-folio lines
-- (positive = charge e.g. minibar/damage, negative = credit/comp).
-- See docs/superpowers/specs/2026-09-01-guest-folio-design.md.
-- amount = 0 is rejected at the API layer, not by constraint.
-- Idempotent-safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS folio_adjustment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES booking(id),
  description VARCHAR(200)  NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folio_adjustment_booking ON folio_adjustment(booking_id);
