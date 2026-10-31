-- One-time migration: named permissions for staff and API keys. See
-- docs/superpowers/specs/2026-10-31-permissions-design.md.
--
--   api_key          -- several named keys per property or org, each full
--                       (permissions NULL) or holding a list of permission
--                       names. Existing property/organization keys are
--                       copied in unchanged as rows named 'Default'.
--   staff_permission -- a staff member's permission names at one property.
--
-- The legacy columns property.api_key / api_key_enabled and
-- organization.api_key / api_key_enabled are left in place so code still
-- running during the migrate-then-push window keeps resolving keys. A later
-- cleanup migration drops them.
--
-- Idempotent via IF NOT EXISTS and the NOT EXISTS guards. Run ONCE directly
-- against an already-populated database (NOT part of the normal reset
-- pipeline).

CREATE TABLE IF NOT EXISTS api_key (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID REFERENCES property(id) ON DELETE CASCADE,
  clerk_org_id  VARCHAR(255) REFERENCES organization(clerk_org_id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL DEFAULT 'Default',
  key           TEXT NOT NULL UNIQUE,
  permissions   TEXT[],                      -- NULL = everything (full key)
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    VARCHAR(100),                -- clerk user id; NULL for migrated rows
  CHECK ((property_id IS NULL) <> (clerk_org_id IS NULL))
);

-- Copy only for owners with no key row yet, so a re-run after a rotation
-- can't resurrect the stale legacy value as a second Default row.
INSERT INTO api_key (property_id, name, key, enabled)
SELECT p.id, 'Default', p.api_key, p.api_key_enabled FROM property p
WHERE p.api_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM api_key k WHERE k.property_id = p.id);

INSERT INTO api_key (clerk_org_id, name, key, enabled)
SELECT o.clerk_org_id, 'Default', o.api_key, o.api_key_enabled FROM organization o
WHERE o.api_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM api_key k WHERE k.clerk_org_id = o.clerk_org_id);

CREATE TABLE IF NOT EXISTS staff_permission (
  property_id    UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  clerk_user_id  VARCHAR(100) NOT NULL,
  permissions    TEXT[] NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     VARCHAR(100),                -- clerk user id of the admin
  PRIMARY KEY (property_id, clerk_user_id)
);
