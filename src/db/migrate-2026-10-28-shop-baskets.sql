-- Abandoned shop baskets: one open basket per signed-in customer per shop,
-- and the per-property reminder settings.
ALTER TABLE property ADD COLUMN IF NOT EXISTS basket_reminder_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN IF NOT EXISTS basket_reminder_delay_mins INT NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS shop_basket (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id             UUID          NOT NULL REFERENCES property(id),
  shop_id                 UUID          NOT NULL REFERENCES shop(id),
  clerk_user_id           VARCHAR(255)  NOT NULL,
  contact_email           VARCHAR(255),
  contact_name            VARCHAR(100),
  -- [{item_id, item_name, unit_price, quantity}]
  items                   JSONB         NOT NULL DEFAULT '[]',
  items_subtotal          NUMERIC(10,2) NOT NULL DEFAULT 0,
  return_url              TEXT,
  status                  VARCHAR(20)   NOT NULL DEFAULT 'open',
  order_id                UUID          REFERENCES proshop_order(id),
  reminder_sent_at        TIMESTAMPTZ,
  reminder_resend_email_id VARCHAR(255),
  created_at              TIMESTAMPTZ   DEFAULT now(),
  updated_at              TIMESTAMPTZ   DEFAULT now(),
  CONSTRAINT shop_basket_status_check CHECK (status IN ('open', 'bought', 'recovered', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_basket_open ON shop_basket (property_id, shop_id, clerk_user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_shop_basket_status_updated ON shop_basket (status, updated_at);

CREATE TABLE IF NOT EXISTS basket_reminder_opt_out (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  email       VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ  DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_basket_reminder_opt_out ON basket_reminder_opt_out (property_id, lower(trim(email)));
