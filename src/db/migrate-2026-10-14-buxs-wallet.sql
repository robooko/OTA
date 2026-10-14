-- One BUXS balance per owner: a Clerk org, or a property with no org
-- ('property:<uuid>'). See docs/superpowers/specs/2026-10-14-unified-buxs-balance-design.md.
-- Replaces property.token_balance / property_token_ledger, which stay
-- read-only until a later cleanup migration drops them.
--
-- 1 old HOTAL token = 2,500 BUXS (£0.10 at £40 per 1M). The seed runs once:
-- the 'hotal-migration' marker row makes a re-run a no-op.
--
-- Run this immediately before deploying the code that reads it: a spend the
-- old code makes in between is lost (in the customer's favour).

CREATE TABLE IF NOT EXISTS buxs_wallet (
  owner      TEXT PRIMARY KEY,                -- 'org_…' or 'property:<uuid>'
  balance    BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buxs_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner         TEXT NOT NULL,
  property_id   UUID REFERENCES property(id) ON DELETE SET NULL, -- HOTAL actions only
  delta         BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason        VARCHAR(40) NOT NULL,         -- starter | purchase | ai_reply | ai_reply_refund | reply_send | forge_build | migration
  ref_id        TEXT,                         -- what it was for: inquiry id, payment id, build id
  source        VARCHAR(20) NOT NULL DEFAULT 'hotal', -- hotal | forge | forge-app | migration
  idem_key      TEXT UNIQUE,                  -- credits only: Stripe id, 'starter:<owner>', 'clerk-org:<id>', 'clerk-user:<id>'
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buxs_ledger_owner ON buxs_ledger(owner, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM buxs_ledger WHERE idem_key = 'hotal-migration') THEN
    RETURN;
  END IF;

  INSERT INTO buxs_wallet (owner, balance)
  SELECT COALESCE(clerk_org_id, 'property:' || id), SUM(token_balance)::bigint * 2500
  FROM property
  GROUP BY 1
  ON CONFLICT (owner) DO UPDATE SET balance = buxs_wallet.balance + EXCLUDED.balance;

  -- History, in the new unit. balance_after stays per property (an org with
  -- two hotels had two running balances); new rows are per owner.
  -- A purchase keeps its Stripe id as idem_key, so a late webhook retry for
  -- it can't credit again.
  INSERT INTO buxs_ledger (owner, property_id, delta, balance_after, reason, ref_id, source, idem_key, created_at)
  SELECT COALESCE(p.clerk_org_id, 'property:' || p.id), l.property_id,
         l.delta::bigint * 2500, l.balance_after::bigint * 2500,
         l.reason, l.ref_id, 'hotal', l.stripe_checkout_session_id, l.created_at
  FROM property_token_ledger l
  JOIN property p ON p.id = l.property_id;

  -- An owner that already had a starter grant never gets another.
  UPDATE buxs_ledger b SET idem_key = 'starter:' || b.owner
  FROM (
    SELECT DISTINCT ON (owner) id FROM buxs_ledger
    WHERE reason = 'starter' AND idem_key IS NULL
    ORDER BY owner, created_at, id
  ) first_starter
  WHERE b.id = first_starter.id;

  INSERT INTO buxs_ledger (owner, delta, balance_after, reason, source, idem_key)
  VALUES ('platform', 0, 0, 'migration', 'migration', 'hotal-migration');
END $$;
