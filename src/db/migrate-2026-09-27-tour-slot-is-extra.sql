-- tour_slot.is_extra: a one-off departure added by hand (POST
-- /api/tours/slots/bulk), as opposed to one the timetable seeder generated.
-- Timetable edits prune future generated slots that no longer match
-- (updateTour), and must leave hand-added ones alone.

ALTER TABLE tour_slot
  ADD COLUMN IF NOT EXISTS is_extra BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any existing slot its tour's current timetable wouldn't have
-- produced (including every slot of a tour with no timetable) was added
-- by hand.
UPDATE tour_slot ts SET is_extra = true
FROM tour t
WHERE t.id = ts.tour_id
  AND NOT (
    ts.slot_time = ANY(COALESCE(t.departure_times, '{}'))
    AND (t.departure_days IS NULL OR EXTRACT(DOW FROM ts.slot_date)::int = ANY(t.departure_days))
  );
