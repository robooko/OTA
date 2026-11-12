-- What a golf course or an equipment item asks for at booking: nothing, or
-- the full price. Enforced only on bookings from a website API key (plan 3
-- of docs/superpowers/specs/2026-11-12-entity-charges-design.md). Defaults to
-- nothing, so no venue changes until its rule is switched on.
ALTER TABLE golf_course ADD COLUMN IF NOT EXISTS payment_required VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS payment_required VARCHAR(10) NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE golf_course ADD CONSTRAINT golf_course_payment_required_valid CHECK (payment_required IN ('none', 'full'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE equipment ADD CONSTRAINT equipment_payment_required_valid CHECK (payment_required IN ('none', 'full'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
