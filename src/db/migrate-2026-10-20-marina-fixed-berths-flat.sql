-- Fixed-price berths (mooring buoys next to a marina's slips) can keep their
-- price all year instead of taking the season tiers, which match on boat
-- length only. Off by default: fox-mooring's buoys follow its tiers.
ALTER TABLE marina ADD COLUMN IF NOT EXISTS fixed_berths_flat BOOLEAN NOT NULL DEFAULT false;
