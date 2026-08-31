-- One-time migration: add event_inquiry.spa_id, mirroring restaurant_id
-- (see migrate-2026-08-17-event-inquiry-restaurant.sql) -- an enquiry can
-- optionally be tagged as being about one spa instead of/as well as a
-- restaurant, so the spa dashboard can show a feed scoped to just its own
-- enquiries. Run ONCE directly against an already-populated database (NOT
-- part of the normal reset pipeline). Idempotent-safe via IF NOT EXISTS.
-- Preserves every existing inquiry row; spa_id defaults to NULL for them.

ALTER TABLE event_inquiry
  ADD COLUMN IF NOT EXISTS spa_id UUID REFERENCES spa(id);

CREATE INDEX IF NOT EXISTS idx_event_inquiry_spa ON event_inquiry(spa_id);
