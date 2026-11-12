-- What a spa asks for at booking: nothing, a fixed deposit per appointment,
-- or the full price. Defaults to nothing, so no spa changes until a rule is
-- switched on; enforcement is plan 3 of
-- docs/superpowers/specs/2026-11-12-entity-charges-design.md.
ALTER TABLE spa ADD COLUMN IF NOT EXISTS payment_required VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE spa ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(14,2);
DO $$ BEGIN
  ALTER TABLE spa ADD CONSTRAINT spa_payment_required_valid CHECK (payment_required IN ('none', 'deposit', 'full'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE spa ADD CONSTRAINT spa_deposit_amount_positive CHECK (deposit_amount IS NULL OR deposit_amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE spa ADD CONSTRAINT spa_deposit_has_amount CHECK (payment_required <> 'deposit' OR deposit_amount IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
