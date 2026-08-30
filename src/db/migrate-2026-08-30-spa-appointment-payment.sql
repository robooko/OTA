-- One-time migration: payment tracking for spa_appointment (Tap to Pay) --
-- see docs/superpowers/specs/2026-08-30-spa-tap-to-pay-backend-requirements.md.
-- Same shape as restaurant_table_session's payment fields
-- (migrate-2026-08-23-restaurant-table-session-payment.sql).
--
-- No backfill needed: every existing appointment correctly defaults to
-- payment_status='unpaid' (none of them went through a Stripe charge).
--
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spa_appointment_payment_status'
  ) THEN
    ALTER TABLE spa_appointment
      ADD CONSTRAINT spa_appointment_payment_status CHECK (payment_status IN ('unpaid', 'paid'));
  END IF;
END $$;
