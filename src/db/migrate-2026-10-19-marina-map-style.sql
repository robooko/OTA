-- Base map the apps draw a marina on. nautical = a chart / seamark layer
-- (e.g. OpenSeaMap over street tiles); the app picks the tile provider.
ALTER TABLE marina ADD COLUMN IF NOT EXISTS map_style VARCHAR(10) NOT NULL DEFAULT 'satellite' CHECK (map_style IN ('satellite', 'street', 'nautical'));
