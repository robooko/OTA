-- One-time migration: opt-in scan-to-order join codes. A restaurant with
-- require_join_code on stamps a crypto-random 4-digit join_code onto every
-- newly opened table session; api-key callers (the guest site's proxy rail)
-- must present it on session-scoped requests, staff bearer bypasses.
--
-- join_code is stored PLAINTEXT by design: a 4-digit space (10,000 values)
-- gains nothing meaningful from hashing -- offline brute force of any hash
-- is instant -- so protection comes from the online attempt lockout
-- (join_code_attempts, hard stop at 10 until staff rotates the code).
--
-- No backfill: NULL join_code = uncoded session (grandfathered -- sessions
-- already open when a restaurant flips the flag stay open-access until they
-- close; flipping the flag can't lock out live tabs).
--
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE restaurant
  ADD COLUMN IF NOT EXISTS require_join_code BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE restaurant_table_session
  ADD COLUMN IF NOT EXISTS join_code VARCHAR(4),
  ADD COLUMN IF NOT EXISTS join_code_attempts INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_table_session_join_code_format'
  ) THEN
    ALTER TABLE restaurant_table_session
      ADD CONSTRAINT restaurant_table_session_join_code_format CHECK (join_code ~ '^[0-9]{4}$');
  END IF;
END $$;
