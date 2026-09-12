-- One-time migration: add proshop_order.clerk_user_id, mirroring
-- spa_appointment.clerk_user_id (see migrate-2026-08-01-spa-appointment-
-- clerk-user.sql). Lets a shop order be linked to a Clerk-authenticated
-- customer for "My Orders" lookup/filtering. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).
-- Idempotent-safe via IF NOT EXISTS. Preserves every existing order row;
-- clerk_user_id defaults to NULL for them.

ALTER TABLE proshop_order
  ADD COLUMN IF NOT EXISTS clerk_user_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_proshop_order_clerk_user ON proshop_order(clerk_user_id);
