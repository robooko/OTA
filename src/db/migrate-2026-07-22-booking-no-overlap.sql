-- One-time migration: enable btree_gist and add an exclusion constraint on
-- booking preventing overlapping non-cancelled bookings for the same room.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline). Preconditioned on there being no existing
-- overlapping non-cancelled bookings - verified separately before running
-- this (see Task 4 Step 1). See
-- docs/superpowers/specs/2026-07-22-book-by-room-type-design.md.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out) WITH &&
  )
  WHERE (status <> 'cancelled');
