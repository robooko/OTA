-- Prepaid token billing for platform usage (Settings -> Billing in the
-- dashboard). Properties buy token packs through the platform's own Stripe
-- account (PLATFORM_STRIPE_SECRET_KEY -- NOT property.stripe_secret_key,
-- which is the venue's account for its own guests' payments); features that
-- cost the platform money spend tokens, and at zero balance each degrades to
-- its free fallback rather than failing (an AI reply draft, for example,
-- becomes the enquiry forwarded to fallback_email so staff answer it from
-- their mail client).
--
-- token_balance is the live counter; every change also writes a
-- property_token_ledger row (delta, balance_after, why, what for). A
-- purchase is keyed by its Checkout Session id (UNIQUE) so the webhook and
-- the dashboard's return-URL confirm can both try to credit it and only one
-- succeeds.
--
-- Existing properties get the same starter grant a new property receives in
-- authenticate()'s auto-create, once (guarded on a 'starter' ledger row).
--
-- Idempotent via IF NOT EXISTS + the starter guard.

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS token_balance      INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS fallback_email     VARCHAR(255);

CREATE TABLE IF NOT EXISTS property_token_ledger (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                UUID NOT NULL REFERENCES property(id),
  delta                      INT NOT NULL,
  balance_after              INT NOT NULL,
  reason                     VARCHAR(40) NOT NULL, -- 'starter' | 'purchase' | 'ai_reply' | 'ai_reply_refund'
  ref_id                     TEXT,                 -- what it was for: inquiry id, payment intent id, ...
  stripe_checkout_session_id VARCHAR(255) UNIQUE,  -- purchases only; the idempotency key
  created_at                 TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_token_ledger_property ON property_token_ledger(property_id, created_at DESC);

WITH granted AS (
  INSERT INTO property_token_ledger (property_id, delta, balance_after, reason)
  SELECT p.id, 20, p.token_balance + 20, 'starter'
  FROM property p
  WHERE NOT EXISTS (
    SELECT 1 FROM property_token_ledger l WHERE l.property_id = p.id AND l.reason = 'starter'
  )
  RETURNING property_id
)
UPDATE property SET token_balance = token_balance + 20
WHERE id IN (SELECT property_id FROM granted);
