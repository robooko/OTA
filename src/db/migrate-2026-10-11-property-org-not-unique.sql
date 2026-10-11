-- One-time migration: a Clerk org may own several properties -- see
-- docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.
-- Run ONLY after the code with the locked auto-create
-- (src/lib/propertyResolver.js resolveStaffProperty) is live: until then
-- this UNIQUE is what stops two concurrent first requests creating two
-- properties for one org. property_org_slug_key (clerk_org_id, slug) keeps
-- the org's lookups indexed.
--
-- Idempotent-safe via IF EXISTS.

ALTER TABLE property DROP CONSTRAINT IF EXISTS property_clerk_org_id_key;
