-- One-time migration: groundwork for several properties per Clerk org --
-- see docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.
-- Purely additive and safe under the old code. Dropping the UNIQUE on
-- property.clerk_org_id is a separate migration
-- (migrate-2026-10-11-property-org-not-unique.sql) that runs only once the
-- locked auto-create is live.
--
-- Idempotent-safe via IF NOT EXISTS.

-- Path segment a group website routes on (mygroup.com/seaview). Unique
-- within an org; NULL until set. The leading clerk_org_id also serves the
-- org's property lookups.
ALTER TABLE property ADD COLUMN IF NOT EXISTS slug VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS property_org_slug_key ON property(clerk_org_id, slug);

-- Org-level website key: one website build serving every hotel in the org.
-- Org name/members/roles stay in Clerk.
CREATE TABLE IF NOT EXISTS organization (
  clerk_org_id     VARCHAR(255) PRIMARY KEY,
  api_key          TEXT UNIQUE,
  api_key_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);
