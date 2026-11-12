-- A key flagged website is a guest-facing site booking on a guest's behalf:
-- its bookings must carry the payment the venue requires (plan 3 of
-- docs/superpowers/specs/2026-11-12-entity-charges-design.md). Staff and
-- every other key, full or scoped, stay exempt. Defaults off.
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS website BOOLEAN NOT NULL DEFAULT false;
