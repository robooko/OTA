-- Child tickets. tour.child_price: per-child price, NULL = children pay the
-- adult price. tour_booking.children: how many of group_size are children
-- (group_size stays the total headcount, so capacity checks are unchanged).

ALTER TABLE tour
  ADD COLUMN IF NOT EXISTS child_price NUMERIC(10,2);

ALTER TABLE tour_booking
  ADD COLUMN IF NOT EXISTS children INT NOT NULL DEFAULT 0;
