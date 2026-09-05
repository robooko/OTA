-- Standalone guest orders for the Shop module, paid from the venue's own
-- website -- not attached to any booking (that's golf_booking_item, a
-- separate concept: staff adding retail items to an existing tee time).
-- Payment follows the same pattern as restaurant_table_session's 'online'
-- channel: property.stripe_secret_key, a regular (not card_present)
-- PaymentIntent, verified server-side before the order is marked paid.
--
-- Shipping cost is whatever the ordering website computed (carrier rates
-- are out of scope here) and is trusted as given; item prices are never
-- trusted from the client -- items_subtotal is computed server-side from
-- proshop_item.price at order time, same as every other module's pricing.
--
-- Idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS proshop_order (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID          NOT NULL REFERENCES property(id),
  shop_id                  UUID          NOT NULL REFERENCES shop(id),
  contact_name             VARCHAR(100)  NOT NULL,
  contact_email            VARCHAR(255),
  contact_phone            VARCHAR(30),
  shipping_address         TEXT,
  shipping_cost            NUMERIC(10,2) NOT NULL DEFAULT 0,
  items_subtotal           NUMERIC(10,2) NOT NULL,
  total_price              NUMERIC(10,2) NOT NULL,
  status                   VARCHAR(20)   NOT NULL DEFAULT 'pending',
  payment_status           VARCHAR(20)   NOT NULL DEFAULT 'unpaid',
  stripe_payment_intent_id VARCHAR(255),
  notes                    TEXT,
  created_at               TIMESTAMPTZ   DEFAULT now(),
  CONSTRAINT proshop_order_status_check CHECK (status IN ('pending', 'paid', 'cancelled')),
  CONSTRAINT proshop_order_payment_status_check CHECK (payment_status IN ('unpaid', 'paid'))
);

CREATE TABLE IF NOT EXISTS proshop_order_item (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID          NOT NULL REFERENCES proshop_order(id) ON DELETE CASCADE,
  item_id    UUID          REFERENCES proshop_item(id),
  item_name  VARCHAR(100)  NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  quantity   INT           NOT NULL CHECK (quantity > 0),
  subtotal   NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proshop_order_property ON proshop_order(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_order_shop     ON proshop_order(shop_id);
CREATE INDEX IF NOT EXISTS idx_proshop_order_item     ON proshop_order_item(order_id);
