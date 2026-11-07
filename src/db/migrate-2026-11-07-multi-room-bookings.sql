-- Multi-room room bookings: rooms booked together share a group id.
-- See docs/superpowers/specs/2026-11-07-multi-room-bookings-design.md.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS group_id UUID; -- rooms booked together (multi-room basket); null = booked alone
CREATE INDEX IF NOT EXISTS idx_booking_group ON booking(group_id) WHERE group_id IS NOT NULL;
