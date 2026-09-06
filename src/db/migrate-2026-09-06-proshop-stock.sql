-- One-time migration: optional stock tracking on proshop_item. NULL (the
-- default -- existing rows are untouched) means untracked/unlimited, same
-- convention as everything else about this column: a property that never
-- sets a count sees no behavior change at all. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).
-- Idempotent via IF NOT EXISTS.

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS stock_quantity INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proshop_item_stock_quantity_check'
  ) THEN
    ALTER TABLE proshop_item
      ADD CONSTRAINT proshop_item_stock_quantity_check CHECK (stock_quantity IS NULL OR stock_quantity >= 0);
  END IF;
END $$;
