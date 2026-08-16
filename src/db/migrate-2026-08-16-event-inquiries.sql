-- One-time migration: creates event_inquiry, a new table (not an
-- addition to an existing one), so there's no backfill concern at
-- all -- CREATE TABLE IF NOT EXISTS is inherently idempotent-safe.

CREATE TABLE IF NOT EXISTS event_inquiry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID         NOT NULL REFERENCES property(id),
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  phone        VARCHAR(30),
  event_date   DATE         NOT NULL,
  guests       INT,
  event_type   VARCHAR(50),
  format       VARCHAR(50),
  message      TEXT,
  status       VARCHAR(20)  NOT NULL DEFAULT 'new',
  created_at   TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_property ON event_inquiry(property_id);
