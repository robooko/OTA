-- One-time migration: adds the `shop` parent entity (a property can run
-- several shops -- Dive, Gift, Pro Shop, etc.) and scopes proshop_item
-- underneath it. shop_id is left NULLABLE: there are already 4 real
-- proshop_item rows locally with no shop to assign them to with any
-- confidence, and the user explicitly ruled out auto-creating a default
-- shop to backfill into. Those rows stay shop_id = NULL and get fixed by
-- hand, out of band -- this migration does not touch them. Going forward
-- the API requires shop_id on create (enforced in the controller, not
-- the DB, since a DB-level NOT NULL would reject the existing rows).
-- Idempotent-safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS shop (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_shop_property ON shop(property_id);

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shop(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_shop ON proshop_item(shop_id);
