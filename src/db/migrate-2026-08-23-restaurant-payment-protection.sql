-- One-time migration: add payment protection settings to restaurant, so a
-- restaurant can require a card hold or upfront deposit to guarantee a
-- reservation (e.g. against no-shows). 'none' (default) requires nothing.
-- The mode/amount are just the configured policy -- creating the actual
-- Stripe PaymentIntent for a reservation still happens wherever the
-- reservation itself is created (see stripe_payment_intent_id on
-- restaurant_reservation), which is expected to read this policy.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE restaurant
  ADD COLUMN IF NOT EXISTS payment_protection VARCHAR(20) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS payment_protection_amount NUMERIC(10,2);

ALTER TABLE restaurant
  DROP CONSTRAINT IF EXISTS restaurant_payment_protection_check;

ALTER TABLE restaurant
  ADD CONSTRAINT restaurant_payment_protection_check
  CHECK (payment_protection IN ('none', 'hold', 'deposit'));
