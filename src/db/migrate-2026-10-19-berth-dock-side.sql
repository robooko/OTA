-- Which edge of a drawn berth meets the dock (the green entrance bar), in the
-- berth's own frame: end, far_end, left or right. Null = as drawn. Applied
-- when the map is served; the stored drawing keeps its bar for placement.
ALTER TABLE marina_berth ADD COLUMN IF NOT EXISTS dock_side VARCHAR(10) CHECK (dock_side IN ('end', 'far_end', 'left', 'right'));
