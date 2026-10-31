-- One-time migration: room housekeeping. See
-- docs/superpowers/specs/2026-10-31-housekeeping-design.md.
--
--   property.hk_*        -- inspection required (default off), stayover
--                           service / linen intervals in nights (NULL = never)
--   room.housekeeping_status -- dirty | cleaning | clean | ready. Not
--                           availability: room.status and room_availability
--                           are untouched.
--   extra.place_in_room, booking_extra.placed_at/by -- arrival extras
--   hk_job / hk_clean / hk_override -- the daily board, each cleaning attempt
--   hk_check_item / hk_inspection / hk_inspection_score -- inspections
--   minibar_item / minibar_list_item / minibar_usage -- minibar
--   cleanliness_rating   -- the guest's post-stay rating form
--
-- Only active for a property whose enabled_modules lists 'housekeeping'
-- (NULL does not count). Idempotent via IF NOT EXISTS.

ALTER TABLE property ADD COLUMN IF NOT EXISTS hk_inspection_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN IF NOT EXISTS hk_service_every_days INT CHECK (hk_service_every_days > 0);
ALTER TABLE property ADD COLUMN IF NOT EXISTS hk_linen_every_days INT CHECK (hk_linen_every_days > 0);

ALTER TABLE room ADD COLUMN IF NOT EXISTS housekeeping_status VARCHAR(20) NOT NULL DEFAULT 'ready';
DO $$ BEGIN
  ALTER TABLE room ADD CONSTRAINT room_housekeeping_status_check
    CHECK (housekeeping_status IN ('dirty', 'cleaning', 'clean', 'ready'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE extra ADD COLUMN IF NOT EXISTS place_in_room BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE booking_extra ADD COLUMN IF NOT EXISTS placed_at TIMESTAMPTZ;
ALTER TABLE booking_extra ADD COLUMN IF NOT EXISTS placed_by VARCHAR(100);

CREATE TABLE IF NOT EXISTS hk_job (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID NOT NULL REFERENCES property(id),
  room_id             UUID NOT NULL REFERENCES room(id),
  date                DATE NOT NULL,
  kind                VARCHAR(20) NOT NULL CHECK (kind IN ('checkout', 'stayover', 'arrival', 'extra')),
  booking_id          UUID REFERENCES booking(id),          -- departing / staying guest
  arriving_booking_id UUID REFERENCES booking(id),          -- guest arriving that day
  status              VARCHAR(20) NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'claimed', 'in_progress', 'done', 'passed', 'failed', 'skipped')),
  claimed_by          VARCHAR(100),                         -- clerk user id
  claimed_by_name     VARCHAR(200),
  linen_due           BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, date, kind)
);
CREATE INDEX IF NOT EXISTS idx_hk_job_property_date ON hk_job(property_id, date);

-- One row per cleaning attempt (a failed inspection's redo is a new row).
CREATE TABLE IF NOT EXISTS hk_clean (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES hk_job(id) ON DELETE CASCADE,
  cleaner_id     VARCHAR(100) NOT NULL,
  cleaner_name   VARCHAR(200),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  sheets_changed BOOLEAN,
  towels_changed BOOLEAN,
  comments       TEXT
);
CREATE INDEX IF NOT EXISTS idx_hk_clean_job ON hk_clean(job_id);

CREATE TABLE IF NOT EXISTS hk_override (
  property_id UUID NOT NULL REFERENCES property(id),
  room_id     UUID NOT NULL REFERENCES room(id),
  date        DATE NOT NULL,
  action      VARCHAR(10) NOT NULL CHECK (action IN ('skip', 'clean')),
  created_by  VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, date)
);

CREATE TABLE IF NOT EXISTS hk_check_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  pass_mark   INT NOT NULL CHECK (pass_mark BETWEEN 1 AND 5),
  sort_order  INT NOT NULL DEFAULT 0,
  status      VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
CREATE INDEX IF NOT EXISTS idx_hk_check_item_property ON hk_check_item(property_id);

CREATE TABLE IF NOT EXISTS hk_inspection (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES hk_job(id) ON DELETE CASCADE,
  clean_id       UUID REFERENCES hk_clean(id) ON DELETE CASCADE,
  inspector_id   VARCHAR(100) NOT NULL,
  inspector_name VARCHAR(200),
  passed         BOOLEAN NOT NULL,
  score          NUMERIC(3,2) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hk_inspection_job ON hk_inspection(job_id);

-- item_name / pass_mark are snapshots: archiving or editing an item never
-- rewrites an old inspection.
CREATE TABLE IF NOT EXISTS hk_inspection_score (
  inspection_id UUID NOT NULL REFERENCES hk_inspection(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES hk_check_item(id),
  item_name     VARCHAR(100) NOT NULL,
  pass_mark     INT NOT NULL,
  score         INT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment       TEXT,
  photo_url     TEXT,
  PRIMARY KEY (inspection_id, item_id)
);

CREATE TABLE IF NOT EXISTS minibar_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  image_url   TEXT,
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  status      VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
CREATE INDEX IF NOT EXISTS idx_minibar_item_property ON minibar_item(property_id);

-- A room type's list (rate_plan_id NULL), or a rate plan's list, which
-- replaces the room type's entirely.
CREATE TABLE IF NOT EXISTS minibar_list_item (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id    UUID NOT NULL REFERENCES room_type(id),
  rate_plan_id    UUID REFERENCES rate_plan(id),
  minibar_item_id UUID NOT NULL REFERENCES minibar_item(id),
  quantity        INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  included        BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_minibar_list_item ON minibar_list_item
  (room_type_id, COALESCE(rate_plan_id, '00000000-0000-0000-0000-000000000000'::uuid), minibar_item_id);

-- unit_price 0 = included in the rate (never on the folio).
CREATE TABLE IF NOT EXISTS minibar_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES booking(id),
  job_id          UUID REFERENCES hk_job(id) ON DELETE SET NULL,
  minibar_item_id UUID NOT NULL REFERENCES minibar_item(id),
  item_name       VARCHAR(100) NOT NULL,
  quantity        INT NOT NULL CHECK (quantity > 0),
  unit_price      NUMERIC(10,2) NOT NULL,
  recorded_by     VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_minibar_usage_booking ON minibar_usage(booking_id);
CREATE INDEX IF NOT EXISTS idx_minibar_usage_job ON minibar_usage(job_id);

CREATE TABLE IF NOT EXISTS cleanliness_rating (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  booking_id  UUID NOT NULL UNIQUE REFERENCES booking(id),
  email       VARCHAR(255) NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    INT NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ,
  rating      INT CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  rated_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
