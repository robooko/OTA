-- Live Google reviews for venue websites. The property's Google Business
-- Profile place id plus a table-backed cache of the Places API payload, so
-- the public site is never blocked on (or rate-limited by) Google and the
-- endpoint stays cheap: one Places call per property per TTL window.
-- Property-level, not per-spa, matching the review-requests design
-- (docs/superpowers/specs/2026-09-01-spa-review-requests-design.md): a
-- property with several spas wanting different review targets is not a case
-- anyone has.
ALTER TABLE property
  ADD COLUMN IF NOT EXISTS google_place_id TEXT;

CREATE TABLE IF NOT EXISTS google_reviews_cache (
  property_id UUID PRIMARY KEY REFERENCES property(id) ON DELETE CASCADE,
  payload     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
