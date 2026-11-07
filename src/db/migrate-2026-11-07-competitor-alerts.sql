-- One-time migration: competitor_alert, alerts from a client-side competitor
-- price scraper (competitor sold out / price changed for a night, mapped to
-- one of our room types). OTA keeps the alerts only, never the scraped prices.
-- One open alert per night/room type/competitor/type; a repeat post updates it.

CREATE TABLE IF NOT EXISTS competitor_alert (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID          NOT NULL REFERENCES property(id),
  night               DATE          NOT NULL,
  room_type_id        UUID          NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  room_type_confirmed BOOLEAN       NOT NULL DEFAULT false, -- false = the scraper's guess at the matching room type
  competitor          VARCHAR(200)  NOT NULL,
  type                VARCHAR(20)   NOT NULL CHECK (type IN ('sold_out', 'price_change')),
  old_price           NUMERIC(14,2),
  new_price           NUMERIC(14,2),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  acknowledged_at     TIMESTAMPTZ,
  CHECK (type = 'sold_out' OR (old_price IS NOT NULL AND new_price IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_competitor_alert_open
  ON competitor_alert(property_id, night, room_type_id, competitor, type) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_competitor_alert_night ON competitor_alert(property_id, night);
