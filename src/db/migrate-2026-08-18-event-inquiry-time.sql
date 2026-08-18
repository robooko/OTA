-- One-time migration: add event_inquiry.event_time, so the requested
-- time of an event can be tracked alongside event_date. Nullable --
-- existing inquiries and most inbound ones never specified a time.

ALTER TABLE event_inquiry
  ADD COLUMN IF NOT EXISTS event_time TIME;
