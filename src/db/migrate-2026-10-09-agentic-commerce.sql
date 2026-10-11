-- Agentic commerce (Stripe ACS) -- see
-- docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
-- property.agentic_commerce holds pointers only (Sanity project/dataset,
-- site URL, brand): the feed job runs with no request to relay them from.
-- NULL = off.
ALTER TABLE property ADD COLUMN IF NOT EXISTS agentic_commerce JSONB;

-- Set on orders bought through an AI agent; the unique index is what makes
-- re-sweeping the same Checkout Session a no-op.
ALTER TABLE proshop_order ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proshop_order_checkout_session
  ON proshop_order (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
