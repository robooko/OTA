-- One-time migration: add restaurant_table_session so a waitress "adding to"
-- an existing table's order groups multiple rounds (drinks, then mains, then
-- dessert) under one tab, and so billing can ask "what does this table owe
-- right now." restaurant_order gains a nullable table_session_id -- nullable
-- because room-service orders (booking_id set, table_id null) never get one.
--
-- Backfill required: this repo already has live table-based orders from the
-- waitress app's own testing (do not assume zero rows). For every existing
-- restaurant_order row with table_id set and no table_session_id, group by
-- table_id and create one CLOSED restaurant_table_session per distinct table
-- (opened_at = earliest order's created_at, closed_at = now), then link
-- those orders to it. Closed immediately on backfill so historical data can
-- never collide with the one-open-session-per-table unique index -- none of
-- it represents a real still-open tab.
--
-- Idempotent: IF NOT EXISTS throughout; the backfill loop only ever targets
-- rows where table_session_id IS NULL, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS restaurant_table_session (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_id      UUID         NOT NULL REFERENCES restaurant_table(id),
  status        VARCHAR(20)  NOT NULL DEFAULT 'open',
  opened_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  CONSTRAINT restaurant_table_session_status CHECK (status IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_session_table
  ON restaurant_table_session(table_id);

-- Enforces "at most one open session per table" at the DB level -- this is
-- the invariant the whole design leans on, so it isn't just app-logic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_table_session_one_open
  ON restaurant_table_session(table_id) WHERE status = 'open';

ALTER TABLE restaurant_order
  ADD COLUMN IF NOT EXISTS table_session_id UUID REFERENCES restaurant_table_session(id);

CREATE INDEX IF NOT EXISTS idx_restaurant_order_table_session
  ON restaurant_order(table_session_id);

DO $$
DECLARE
  t RECORD;
  new_session_id UUID;
BEGIN
  FOR t IN
    SELECT DISTINCT table_id, restaurant_id, property_id
    FROM restaurant_order
    WHERE table_id IS NOT NULL AND table_session_id IS NULL
  LOOP
    INSERT INTO restaurant_table_session (property_id, restaurant_id, table_id, status, opened_at, closed_at)
    SELECT t.property_id, t.restaurant_id, t.table_id, 'closed',
           MIN(created_at), now()
    FROM restaurant_order
    WHERE table_id = t.table_id AND table_session_id IS NULL
    RETURNING id INTO new_session_id;

    UPDATE restaurant_order
    SET table_session_id = new_session_id
    WHERE table_id = t.table_id AND table_session_id IS NULL;
  END LOOP;
END $$;
