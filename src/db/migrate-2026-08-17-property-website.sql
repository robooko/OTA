-- One-time migration: adds property_website, a property-scoped list of
-- websites (e.g. one per restaurant/venue site, plus a main site).
-- Soft-delete via status, matching the rest of this schema.

CREATE TABLE IF NOT EXISTS property_website (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID        NOT NULL REFERENCES property(id),
  url          TEXT        NOT NULL,
  label        VARCHAR(100),
  status       VARCHAR(20) DEFAULT 'active',
  created_at   TIMESTAMPTZ DEFAULT now()
);
