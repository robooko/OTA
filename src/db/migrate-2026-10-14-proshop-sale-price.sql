-- One-time migration: optional sale price on proshop_item. NULL (the
-- default -- existing rows are untouched) means not on sale; set, it's what
-- every order, booking-item sale and agentic feed charges, with price kept
-- as the "was" price. Run ONCE directly against an already-populated
-- database (NOT part of the normal reset pipeline). Idempotent.

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS sale_price NUMERIC(10,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proshop_item_sale_price_check'
  ) THEN
    ALTER TABLE proshop_item
      ADD CONSTRAINT proshop_item_sale_price_check CHECK (sale_price IS NULL OR (sale_price >= 0 AND sale_price < price));
  END IF;
END $$;
