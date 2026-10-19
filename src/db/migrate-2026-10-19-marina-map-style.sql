-- The base map a marina's berths were lined up against, so the apps draw
-- them on the imagery they match (another provider's pontoons can sit metres
-- off). The staff Pontoons map records it when a berth is turned there.
-- nautical = a chart / seamark layer (e.g. OpenSeaMap over street tiles).
ALTER TABLE marina ADD COLUMN IF NOT EXISTS map_style VARCHAR(10) NOT NULL DEFAULT 'satellite' CHECK (map_style IN ('satellite', 'street', 'nautical'));
