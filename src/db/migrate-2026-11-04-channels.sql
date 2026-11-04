-- Channel distribution (rooms): see docs/superpowers/specs/2026-11-04-channel-distribution-design.md.
-- A channel gets a desired ARI grid computed from live tables; channel_ari
-- holds what we last sent it (and whether it acknowledged), so the diff is
-- both what to push and what is out of date.

CREATE TABLE IF NOT EXISTS channel (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID         NOT NULL REFERENCES property(id),
  adapter      VARCHAR(30)  NOT NULL,                  -- key in src/lib/channels ADAPTERS
  name         VARCHAR(100) NOT NULL,
  status       VARCHAR(10)  NOT NULL DEFAULT 'active', -- pausing = close-out push in flight
  horizon_days INT          NOT NULL DEFAULT 365,
  collect      VARCHAR(10)  NOT NULL DEFAULT 'hotel',  -- who takes the guest's money, by default
  config       JSONB        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT channel_status_check CHECK (status IN ('active', 'pausing', 'paused')),
  CONSTRAINT channel_horizon_check CHECK (horizon_days BETWEEN 1 AND 548),
  CONSTRAINT channel_collect_check CHECK (collect IN ('hotel', 'channel'))
);
CREATE INDEX IF NOT EXISTS idx_channel_property ON channel(property_id);

-- Channel room code + rate code -> OTA room type (+ rate plan; null = base rate).
CREATE TABLE IF NOT EXISTS channel_mapping (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID        NOT NULL REFERENCES property(id),
  channel_id   UUID        NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  room_type_id UUID        NOT NULL REFERENCES room_type(id),
  rate_plan_id UUID        REFERENCES rate_plan(id),
  room_code    VARCHAR(64) NOT NULL,
  rate_code    VARCHAR(64) NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'active', -- closing = being closed out before removal
  CONSTRAINT channel_mapping_status_check CHECK (status IN ('active', 'closing')),
  UNIQUE (channel_id, room_code, rate_code)
);
CREATE INDEX IF NOT EXISTS idx_channel_mapping_channel ON channel_mapping(channel_id);

-- Per-channel trims over [date_from, date_to] (inclusive): a cap and/or stop-sell.
-- room_type_id null = every room type.
CREATE TABLE IF NOT EXISTS channel_trim (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID    NOT NULL REFERENCES property(id),
  channel_id    UUID    NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  room_type_id  UUID    REFERENCES room_type(id),
  date_from     DATE    NOT NULL,
  date_to       DATE    NOT NULL,
  max_available INT,
  stop_sell     BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT channel_trim_range_check CHECK (date_from <= date_to),
  CONSTRAINT channel_trim_cap_check CHECK (max_available IS NULL OR max_available >= 0),
  CONSTRAINT channel_trim_effect_check CHECK (max_available IS NOT NULL OR stop_sell)
);
CREATE INDEX IF NOT EXISTS idx_channel_trim_channel ON channel_trim(channel_id);

-- Last values sent per mapping per date, and whether the channel took them.
CREATE TABLE IF NOT EXISTS channel_ari (
  mapping_id UUID          NOT NULL REFERENCES channel_mapping(id) ON DELETE CASCADE,
  date       DATE          NOT NULL,
  available  INT           NOT NULL,
  rate       NUMERIC(10,2) NOT NULL,
  stop_sell  BOOLEAN       NOT NULL,
  status     VARCHAR(10)   NOT NULL,
  error      TEXT,
  sent_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT channel_ari_status_check CHECK (status IN ('ok', 'failed')),
  PRIMARY KEY (mapping_id, date)
);

-- Every reservation message a channel delivered, with what OTA did with it.
CREATE TABLE IF NOT EXISTS channel_reservation_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  channel_id  UUID         NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  channel_ref VARCHAR(100),
  action      VARCHAR(10),
  outcome     VARCHAR(10)  NOT NULL,
  reason      TEXT,
  booking_id  UUID         REFERENCES booking(id),
  payload     JSONB        NOT NULL,
  received_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT channel_reservation_log_outcome_check CHECK (outcome IN ('created', 'modified', 'cancelled', 'duplicate', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_channel_reservation_log_channel ON channel_reservation_log(channel_id, received_at DESC);

-- Booking source: null = direct.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS channel_id  UUID REFERENCES channel(id);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS channel_ref VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_channel_ref ON booking (channel_id, channel_ref) WHERE channel_id IS NOT NULL;
