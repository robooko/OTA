-- One-time migration: make event_inquiry.event_date nullable. The module
-- now also carries group-booking and general enquiries from properties
-- that aren't hotels (first: Bedford Barber Co), where "do you do X?" has
-- no date. See docs/superpowers/specs/2026-08-30-general-inquiries-design.md.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline). Idempotent: dropping an absent NOT NULL is a no-op.
-- No backfill -- every existing row already has a date.

ALTER TABLE event_inquiry
  ALTER COLUMN event_date DROP NOT NULL;
