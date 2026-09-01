-- One-time migration: Stripe payment-intent id on the payment ledger.
-- The folio Tap to Pay flow (docs/superpowers/specs/2026-09-01-guest-folio-design.md)
-- keeps its pending state as a payment row (status 'pending', method 'card')
-- carrying the intent id -- unlike spa/table-sessions, which grew a
-- parallel payment_status column.
--
-- No backfill: every existing row is a manual payment; NULL is correct.
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);
