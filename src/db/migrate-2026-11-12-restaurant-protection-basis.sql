-- A restaurant's payment_protection_amount is charged once per table or once
-- per guest. Existing restaurants keep the flat (per table) reading.
BEGIN;
ALTER TABLE restaurant ADD COLUMN IF NOT EXISTS payment_protection_basis VARCHAR(10) NOT NULL DEFAULT 'per_table';
ALTER TABLE restaurant DROP CONSTRAINT IF EXISTS restaurant_payment_protection_basis_check;
ALTER TABLE restaurant ADD CONSTRAINT restaurant_payment_protection_basis_check CHECK (payment_protection_basis IN ('per_table', 'per_guest'));
COMMIT;
