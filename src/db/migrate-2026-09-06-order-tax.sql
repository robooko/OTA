-- One-time migration: optional per-property tax on website-checkout orders
-- (pro shop + restaurant web ordering). Off by default -- both new order
-- columns default to 0, so a property that never sets tax_enabled sees
-- total_price computed exactly as before. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).
-- Idempotent via IF NOT EXISTS.

ALTER TABLE property ADD COLUMN IF NOT EXISTS tax_enabled   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN IF NOT EXISTS tax_rate      NUMERIC(5,2) NOT NULL DEFAULT 0;
-- Most venues price goods/menus with tax already baked in (a guest sees one
-- sticker price) rather than adding tax at checkout -- true by default.
ALTER TABLE property ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT true;
-- VAT/tax registration number, printed on invoices -- optional, no format
-- enforced (varies by jurisdiction).
ALTER TABLE property ADD COLUMN IF NOT EXISTS tax_id        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_tax_rate_check'
  ) THEN
    ALTER TABLE property ADD CONSTRAINT property_tax_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100);
  END IF;
END $$;

-- Snapshotted at order time, like unit_price/subtotal on the item rows --
-- never recomputed later from the property's current rate, so a rate change
-- doesn't retroactively alter a past order's numbers.
ALTER TABLE proshop_order         ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE restaurant_web_order  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
