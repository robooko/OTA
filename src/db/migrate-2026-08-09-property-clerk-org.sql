-- One-time migration: add property.clerk_org_id, linking a property to a
-- Clerk Organization. Purely additive -- nullable, no backfill needed
-- (no existing property has a Clerk org yet). Idempotent-safe via
-- IF NOT EXISTS. Run ONCE directly against an already-populated database
-- (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS clerk_org_id VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_clerk_org_id_key'
  ) THEN
    ALTER TABLE property ADD CONSTRAINT property_clerk_org_id_key UNIQUE (clerk_org_id);
  END IF;
END $$;
