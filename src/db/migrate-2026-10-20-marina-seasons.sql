-- Seasons: a named date window a marina's price tiers share, so every size
-- band doesn't repeat the dates. repeats_yearly = the same days every year
-- (the stored year is just where it starts), so a season isn't re-entered
-- each year. A tier with a season takes the season's dates; its own
-- valid_from/valid_to are then ignored (kept here so code still on the old
-- release keeps pricing until the deploy lands).
CREATE TABLE IF NOT EXISTS marina_season (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES property(id),
  marina_id       UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  valid_from      DATE NOT NULL,
  valid_to        DATE NOT NULL,
  repeats_yearly  BOOLEAN NOT NULL DEFAULT false,
  status          VARCHAR(20) DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS idx_marina_season_property ON marina_season (property_id);

ALTER TABLE marina_price_tier ADD COLUMN IF NOT EXISTS season_id UUID REFERENCES marina_season(id);
ALTER TABLE marina_price_tier ALTER COLUMN valid_from DROP NOT NULL, ALTER COLUMN valid_to DROP NOT NULL;
ALTER TABLE marina_price_tier DROP CONSTRAINT IF EXISTS marina_price_tier_season_or_dates;
ALTER TABLE marina_price_tier ADD CONSTRAINT marina_price_tier_season_or_dates
  CHECK (season_id IS NOT NULL OR (valid_from IS NOT NULL AND valid_to IS NOT NULL));

-- Backfill: one season per marina per distinct tier window, not repeating
-- (same behaviour as today; staff tick "every year" where it applies).
INSERT INTO marina_season (property_id, marina_id, name, valid_from, valid_to)
SELECT DISTINCT t.property_id, t.marina_id,
       to_char(t.valid_from, 'FMDD Mon YYYY') || ' – ' || to_char(t.valid_to, 'FMDD Mon YYYY'),
       t.valid_from, t.valid_to
FROM marina_price_tier t
WHERE t.season_id IS NULL AND t.valid_from IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM marina_season s WHERE s.marina_id = t.marina_id AND s.valid_from = t.valid_from AND s.valid_to = t.valid_to);

UPDATE marina_price_tier t SET season_id = s.id
FROM marina_season s
WHERE t.season_id IS NULL AND s.marina_id = t.marina_id AND s.valid_from = t.valid_from AND s.valid_to = t.valid_to;
