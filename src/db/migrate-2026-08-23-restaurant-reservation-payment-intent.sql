-- One-time migration: add stripe_payment_intent_id to restaurant_reservation,
-- so a deposit/prepayment charge can be linked back to the reservation it
-- belongs to. Same shape as event_inquiry_message.resend_email_id: nullable
-- (most reservations take no deposit), with a unique partial index so a
-- Stripe webhook can look up "which reservation does this charge belong to"
-- by payment intent id.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE restaurant_reservation
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_reservation_payment_intent
  ON restaurant_reservation(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
