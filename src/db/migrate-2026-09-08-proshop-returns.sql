-- One-time migration: pro-shop returns (design: docs/superpowers/specs/
-- 2026-09-08-proshop-returns-design.md). Run ONCE against an already-
-- populated database via scripts/run-migration.js (both DATABASE_URL and
-- DATABASE_URL_LIVE). Idempotent.

-- Short human-readable order code guests type into a return form. Backfilled
-- for existing orders below before NOT NULL is applied.
ALTER TABLE proshop_order ADD COLUMN IF NOT EXISTS reference VARCHAR(12);

DO $$
DECLARE
  r RECORD;
  ref TEXT;
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  FOR r IN SELECT id, property_id FROM proshop_order WHERE reference IS NULL LOOP
    LOOP
      ref := '';
      FOR i IN 1..6 LOOP
        ref := ref || substr(alphabet, floor(random() * 32)::int + 1, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM proshop_order WHERE property_id = r.property_id AND reference = ref);
    END LOOP;
    UPDATE proshop_order SET reference = ref WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE proshop_order ALTER COLUMN reference SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proshop_order_reference ON proshop_order(property_id, reference);

-- Free text sent to guests when they request a return and fed to AI replies.
ALTER TABLE property ADD COLUMN IF NOT EXISTS return_instructions TEXT;

CREATE TABLE IF NOT EXISTS proshop_return (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID        NOT NULL REFERENCES property(id),
  order_id         UUID        NOT NULL REFERENCES proshop_order(id),
  event_inquiry_id UUID        NOT NULL REFERENCES event_inquiry(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'requested',
  reason           TEXT,
  raised_by        VARCHAR(10) NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT proshop_return_status_check CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled')),
  CONSTRAINT proshop_return_raised_by_check CHECK (raised_by IN ('guest', 'staff'))
);

CREATE TABLE IF NOT EXISTS proshop_return_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     UUID NOT NULL REFERENCES proshop_return(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES proshop_order_item(id),
  quantity      INT  NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_proshop_return_property    ON proshop_return(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_order       ON proshop_return(order_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_inquiry     ON proshop_return(event_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_item_return ON proshop_return_item(return_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_item_line   ON proshop_return_item(order_item_id);
