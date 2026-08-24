-- One-time migration: payment tracking for restaurant_table_session (the
-- whole-tab billing unit), plus a per-property Stripe Terminal location
-- (required by the Terminal API even for Tap to Pay, which has no physical
-- reader to register). See 2026-08-23-restaurant-tap-to-pay-backend-requirements.md.
--
-- No backfill needed: every existing session row correctly defaults to
-- payment_status='unpaid' (none of them went through a Stripe charge).
--
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE restaurant_table_session
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_table_session_payment_status'
  ) THEN
    ALTER TABLE restaurant_table_session
      ADD CONSTRAINT restaurant_table_session_payment_status CHECK (payment_status IN ('unpaid', 'paid'));
  END IF;
END $$;

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS stripe_terminal_location_id VARCHAR(255);
