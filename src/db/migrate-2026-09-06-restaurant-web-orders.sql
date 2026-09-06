-- "Nando's style" food ordering: order and pay on the website, no running
-- tab. Distinct from restaurant_order (which requires booking_id OR
-- table_id and is billed through restaurant_table_session -- built for a
-- waiter opening a walk-in tab, not a standalone paid-upfront order) and
-- from restaurant_reservation (a dine-in booking, no food). table_id is
-- optional here: pickup orders have none; an at-table order paid per-round
-- (rather than run up on a tab) sets it.
--
-- Payment mirrors restaurant_table_session's 'online' channel and
-- proshop_order exactly: property.stripe_secret_key, a regular
-- PaymentIntent, verified server-side (status AND amount) before
-- payment_status flips -- never trusted from the client.
--
-- Idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS restaurant_web_order (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID          NOT NULL REFERENCES property(id),
  restaurant_id            UUID          NOT NULL REFERENCES restaurant(id),
  table_id                 UUID          REFERENCES restaurant_table(id),
  contact_name             VARCHAR(100)  NOT NULL DEFAULT 'Website Guest',
  contact_email            VARCHAR(255),
  contact_phone            VARCHAR(30),
  scheduled_for            TIMESTAMPTZ,
  notes                    TEXT,
  items_subtotal           NUMERIC(10,2) NOT NULL,
  total_price              NUMERIC(10,2) NOT NULL,
  status                   VARCHAR(20)   NOT NULL DEFAULT 'pending',
  payment_status           VARCHAR(20)   NOT NULL DEFAULT 'unpaid',
  stripe_payment_intent_id VARCHAR(255),
  created_at               TIMESTAMPTZ   DEFAULT now(),
  CONSTRAINT restaurant_web_order_status_check
    CHECK (status IN ('pending', 'paid', 'preparing', 'ready', 'completed', 'cancelled')),
  CONSTRAINT restaurant_web_order_payment_status_check CHECK (payment_status IN ('unpaid', 'paid'))
);

CREATE TABLE IF NOT EXISTS restaurant_web_order_item (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID          NOT NULL REFERENCES restaurant_web_order(id) ON DELETE CASCADE,
  item_id    UUID          REFERENCES restaurant_menu_item(id),
  item_name  VARCHAR(100)  NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  quantity   INT           NOT NULL CHECK (quantity > 0),
  variant    VARCHAR(100),
  subtotal   NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restaurant_web_order_property   ON restaurant_web_order(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_web_order_restaurant ON restaurant_web_order(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_web_order_item       ON restaurant_web_order_item(order_id);
