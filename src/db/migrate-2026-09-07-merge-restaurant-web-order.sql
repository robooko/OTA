-- Folds restaurant_web_order back into restaurant_order. The "Nando's
-- style" paid-upfront table (added yesterday, migrate-2026-09-06-restaurant-
-- web-orders.sql) never got wired into any live feed or dashboard -- it was
-- a second, disconnected order pipeline duplicating ~80% of restaurant_order
-- (menu pricing, line items, Ably publishing, the dashboard's Live orders
-- card, the waitress app's kitchen status walk). Rather than build a second
-- notification path, the paid-upfront case now lives in the one order
-- pipeline that already has all of that.
--
-- restaurant_order previously required booking_id OR table_id (a waiter
-- always opens against one or the other). A paid-upfront PICKUP order has
-- neither -- contact_name now satisfies the constraint instead, same
-- default ('Website Guest') restaurant_web_order used. An at-table order
-- paid from a phone still sets table_id and goes through the *existing*
-- restaurant_table_session 'online' payment channel (already built, see
-- migrate-2026-08-26-table-session-*.sql) -- restaurant_order gains no new
-- per-order payment plumbing for that case, only for pickup (nothing to
-- bill it through otherwise). In practice willy-t-bvi only ever creates
-- pickup orders (no table_id) today.
--
-- Status keeps restaurant_order's existing vocabulary (pending / confirmed
-- / preparing / delivered / cancelled -- see ota-waitress-app's
-- order-status.ts) rather than restaurant_web_order's richer one (which
-- added paid/ready/completed): a second vocabulary for the same column
-- would break the waitress app's status walk. payment_status is the
-- separate, decoupled signal for "has this been paid" -- confirmOrderPayment
-- also advances status pending -> confirmed on the same transition, folding
-- in what "paid" meant there.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / DROP ... IF EXISTS.

ALTER TABLE restaurant_order
  ADD COLUMN IF NOT EXISTS contact_name             VARCHAR(100),
  ADD COLUMN IF NOT EXISTS contact_email             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS contact_phone             VARCHAR(30),
  ADD COLUMN IF NOT EXISTS items_subtotal            NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS tax_amount                NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status            VARCHAR(20)   NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at                   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id  VARCHAR(255);

ALTER TABLE restaurant_order DROP CONSTRAINT IF EXISTS restaurant_order_booking_or_table;
ALTER TABLE restaurant_order ADD CONSTRAINT restaurant_order_booking_table_or_contact
  CHECK (booking_id IS NOT NULL OR table_id IS NOT NULL OR contact_name IS NOT NULL);

ALTER TABLE restaurant_order DROP CONSTRAINT IF EXISTS restaurant_order_payment_status_check;
ALTER TABLE restaurant_order ADD CONSTRAINT restaurant_order_payment_status_check
  CHECK (payment_status IN ('unpaid', 'paid'));

-- Carry over any real restaurant_web_order rows. Yesterday's test orders
-- were cleaned up from prod per that commit's message, but don't assume --
-- migrate defensively rather than silently drop data.
INSERT INTO restaurant_order
  (id, property_id, restaurant_id, table_id, contact_name, contact_email, contact_phone,
   scheduled_for, notes, items_subtotal, tax_amount, total_price, status, payment_status,
   stripe_payment_intent_id, created_at)
SELECT id, property_id, restaurant_id, table_id, contact_name, contact_email, contact_phone,
       scheduled_for, notes, items_subtotal, tax_amount, total_price,
       -- restaurant_web_order's 'paid'/'ready'/'completed' have no exact
       -- match in restaurant_order's vocabulary -- map onto the closest
       -- equivalent rather than carry over values updateOrderStatus would
       -- reject on the next PUT .../status.
       CASE status
         WHEN 'paid' THEN 'confirmed'
         WHEN 'ready' THEN 'preparing'
         WHEN 'completed' THEN 'delivered'
         ELSE status
       END,
       payment_status, stripe_payment_intent_id, created_at
FROM restaurant_web_order
WHERE EXISTS (SELECT 1 FROM restaurant_web_order)
ON CONFLICT (id) DO NOTHING;

INSERT INTO restaurant_order_item (id, order_id, item_id, item_name, quantity, unit_price, variant)
SELECT id, order_id, item_id, item_name, quantity, unit_price, variant
FROM restaurant_web_order_item
WHERE EXISTS (SELECT 1 FROM restaurant_web_order_item)
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS restaurant_web_order_item;
DROP TABLE IF EXISTS restaurant_web_order;
