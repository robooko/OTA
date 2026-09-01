-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Enable btree_gist so the booking_no_overlap exclusion constraint below can
-- mix an equality column (room_id) with a range-overlap column (daterange)
-- in one GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Properties (tenants)
CREATE TABLE IF NOT EXISTS property (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) NOT NULL,
  status           VARCHAR(20)  DEFAULT 'active',
  clerk_org_id     VARCHAR(255) UNIQUE,
  api_key          TEXT UNIQUE,
  api_key_enabled  BOOLEAN NOT NULL DEFAULT true,
  currency         VARCHAR(3)   NOT NULL DEFAULT 'GBP',
  timezone         VARCHAR(50)  NOT NULL DEFAULT 'Europe/London',
  vercel_team_id       VARCHAR(100),
  vercel_connected_at  TIMESTAMPTZ,
  vercel_access_token  TEXT, -- "Projects: Read" scope only -- confirmed can't read Web Analytics
  vercel_pat           TEXT, -- Personal Access Token, optionally set per-property so Web Analytics works
  stripe_secret_key    TEXT, -- optionally set per-property so reservation deposits/holds can be created under the property's own Stripe account
  stripe_terminal_location_id VARCHAR(255), -- lazily created on first Tap to Pay connection-token request
  -- AI-drafted event-inquiry replies -- see migrate-2026-08-29-event-inquiry-ai-replies.sql.
  -- 'off' = no automation, 'draft' = every AI reply needs individual approval,
  -- 'auto' = send unreviewed when score >= ai_reply_auto_send_min_score and not requires_human.
  ai_reply_mode                VARCHAR(10) NOT NULL DEFAULT 'off',
  ai_reply_instructions        TEXT, -- venue knowledge/tone/limits; the ONLY facts the model may state
  ai_reply_auto_send_min_score INT NOT NULL DEFAULT 80,
  created_at       TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT property_ai_reply_mode_check CHECK (ai_reply_mode IN ('off', 'draft', 'auto')),
  CONSTRAINT property_ai_reply_auto_send_min_score_check CHECK (ai_reply_auto_send_min_score BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS property_website (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        UUID        NOT NULL REFERENCES property(id),
  url                TEXT        NOT NULL,
  label              VARCHAR(100),
  vercel_project_id  VARCHAR(100), -- NULL = not mapped, no analytics available
  status             VARCHAR(20) DEFAULT 'active',
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- Guests
CREATE TABLE IF NOT EXISTS guest (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  clerk_user_id VARCHAR(100),
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(30),
  created_at    TIMESTAMPTZ  DEFAULT now(),
  UNIQUE (property_id, email),
  UNIQUE (property_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_guest_property ON guest(property_id);

-- Room types
CREATE TABLE IF NOT EXISTS room_type (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID            NOT NULL REFERENCES property(id),
  name           VARCHAR(100)    NOT NULL,
  description    TEXT,
  max_occupancy  INT             NOT NULL,
  base_rate      NUMERIC(10,2)   NOT NULL,
  floor_plan     JSONB           NOT NULL DEFAULT '{}',
  status         VARCHAR(20)     DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_room_type_property ON room_type(property_id);

-- Dated nightly rates per room type (rate calendar). One row per date; a
-- missing row falls back to base_rate, and a per-room
-- room_availability.override_rate still outranks both.
CREATE TABLE IF NOT EXISTS room_type_rate (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  room_type_id  UUID          NOT NULL REFERENCES room_type(id),
  date          DATE          NOT NULL,
  rate          NUMERIC(10,2) NOT NULL,
  UNIQUE (room_type_id, date)
);

CREATE INDEX IF NOT EXISTS idx_room_type_rate_property ON room_type_rate(property_id);

-- Rooms
CREATE TABLE IF NOT EXISTS room (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID          NOT NULL REFERENCES property(id),
  room_type_id UUID          NOT NULL REFERENCES room_type(id),
  room_number  VARCHAR(10)   NOT NULL,
  floor        INT,
  status       VARCHAR(20)   DEFAULT 'active',
  UNIQUE (property_id, room_number)
);

CREATE INDEX IF NOT EXISTS idx_room_property ON room(property_id);

-- Room availability
CREATE TABLE IF NOT EXISTS room_availability (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  room_id       UUID          NOT NULL REFERENCES room(id),
  date          DATE          NOT NULL,
  is_available  BOOLEAN       DEFAULT true,
  override_rate NUMERIC(10,2),
  block_reason  VARCHAR(100),
  UNIQUE (room_id, date)
);

-- Bookings
CREATE TABLE IF NOT EXISTS booking (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  guest_id    UUID          NOT NULL REFERENCES guest(id),
  room_id     UUID          NOT NULL REFERENCES room(id),
  check_in    DATE          NOT NULL,
  check_out   DATE          NOT NULL,
  guests      INT           NOT NULL DEFAULT 1,
  total_price NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'confirmed',
  metadata    JSONB         NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ   DEFAULT now(),
  CONSTRAINT booking_no_overlap EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out) WITH &&) WHERE (status <> 'cancelled')
);

-- Payments
CREATE TABLE IF NOT EXISTS payment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES booking(id),
  amount      NUMERIC(10,2) NOT NULL,
  method      VARCHAR(30),
  status      VARCHAR(20)   DEFAULT 'pending',
  paid_at     TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_room_availability_room_date ON room_availability(room_id, date);
CREATE INDEX IF NOT EXISTS idx_room_availability_property_date ON room_availability(property_id, date);
CREATE INDEX IF NOT EXISTS idx_booking_room_dates         ON booking(property_id, room_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_booking_guest              ON booking(property_id, guest_id);
CREATE INDEX IF NOT EXISTS idx_payment_property           ON payment(property_id);

-- Materialised view
CREATE MATERIALIZED VIEW IF NOT EXISTS room_type_availability AS
SELECT
  r.property_id,
  r.room_type_id,
  ra.date,
  COUNT(*)                                                AS total_rooms,
  COUNT(*) FILTER (WHERE ra.is_available = true)          AS available_rooms,
  MIN(COALESCE(ra.override_rate, rtr.rate, rt.base_rate)) AS min_rate
FROM room_availability ra
JOIN room      r  ON r.id  = ra.room_id
JOIN room_type rt ON rt.id = r.room_type_id
LEFT JOIN room_type_rate rtr
       ON rtr.room_type_id = r.room_type_id
      AND rtr.date         = ra.date
GROUP BY r.property_id, r.room_type_id, ra.date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rta_property_type_date ON room_type_availability(property_id, room_type_id, date);

-- ── Extras ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS extra (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_extra_property ON extra(property_id);

CREATE TABLE IF NOT EXISTS booking_extra (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID          NOT NULL REFERENCES booking(id),
  extra_id   UUID          NOT NULL REFERENCES extra(id),
  quantity   INT           NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_extra_booking ON booking_extra(booking_id);

-- ── Auth ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'staff',
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_user_property ON api_user(property_id);

-- ── Restaurant ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS restaurant (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               UUID         NOT NULL REFERENCES property(id),
  name                      VARCHAR(100) NOT NULL,
  description               TEXT,
  phone                     VARCHAR(30),
  slot_interval_minutes     INT          NOT NULL DEFAULT 15,
  default_duration_minutes  INT          NOT NULL,
  closed_days               SMALLINT[]   NOT NULL DEFAULT '{}',
  status                    VARCHAR(20)  DEFAULT 'active',
  currency                  VARCHAR(3),  -- NULL = inherit property.currency
  timezone                  VARCHAR(50), -- NULL = inherit property.timezone
  payment_protection        VARCHAR(20)  NOT NULL DEFAULT 'none', -- 'none' | 'hold' | 'deposit'
  payment_protection_amount NUMERIC(10,2),
  website_id                UUID REFERENCES property_website(id), -- NULL = no guest website; table QR codes then carry only the table id
  require_join_code         BOOLEAN      NOT NULL DEFAULT false, -- opt-in: newly opened table sessions get a 4-digit join code that api-key (guest-rail) callers must present
  created_at                TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT restaurant_payment_protection_check CHECK (payment_protection IN ('none', 'hold', 'deposit'))
);

CREATE TABLE IF NOT EXISTS restaurant_table (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_number  VARCHAR(10)  NOT NULL,
  seats         INT          NOT NULL,
  location      VARCHAR(50),
  status        VARCHAR(20)  DEFAULT 'active',
  UNIQUE (restaurant_id, table_number)
);

-- Groups a table's rounds (drinks, then mains, then dessert) into one tab.
-- At most one open session per table (unique partial index below) --
-- restaurant_order.table_session_id attaches new orders to whichever
-- session is currently open, or a new one if none is.
CREATE TABLE IF NOT EXISTS restaurant_table_session (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_id      UUID         NOT NULL REFERENCES restaurant_table(id),
  status        VARCHAR(20)  NOT NULL DEFAULT 'open',
  opened_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  payment_status            VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  paid_at                   TIMESTAMPTZ,
  stripe_payment_intent_id  VARCHAR(255),
  -- Scan-to-order join code (see migrate-2026-08-26-table-session-join-code):
  -- plaintext by design -- 4 digits gain nothing from hashing; protection is
  -- the attempt lockout. NULL = uncoded session, no enforcement.
  join_code                 VARCHAR(4),
  join_code_attempts        INT NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_table_session_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT restaurant_table_session_payment_status CHECK (payment_status IN ('unpaid', 'paid')),
  CONSTRAINT restaurant_table_session_join_code_format CHECK (join_code ~ '^[0-9]{4}$')
);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_session_table
  ON restaurant_table_session(table_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_table_session_one_open
  ON restaurant_table_session(table_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS service_period (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  restaurant_id UUID NOT NULL REFERENCES restaurant(id),
  label         VARCHAR(50),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (start_time < end_time)
);

CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID         NOT NULL REFERENCES property(id),
  table_id         UUID         NOT NULL REFERENCES restaurant_table(id),
  reservation_date DATE         NOT NULL,
  start_time       TIME         NOT NULL,
  end_time         TIME         NOT NULL,
  guest_id         UUID         REFERENCES guest(id),
  clerk_user_id    VARCHAR(100),
  contact_name     VARCHAR(100) NOT NULL,
  contact_email    VARCHAR(255),
  contact_phone    VARCHAR(30),
  party_size       INT          NOT NULL,
  status           VARCHAR(20)  DEFAULT 'confirmed',
  notes            TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  stripe_payment_intent_id VARCHAR(255),
  created_at       TIMESTAMPTZ  DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_reservation_payment_intent
  ON restaurant_reservation(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- Added via ALTER, not baked into restaurant_table_session's CREATE TABLE
-- above, since that table is declared earlier in this file (restaurant_order
-- also references it) and restaurant_reservation didn't exist yet at that
-- point. Nullable -- most sessions are walk-ins with no reservation.
ALTER TABLE restaurant_table_session
  ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES restaurant_reservation(id);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_session_reservation
  ON restaurant_table_session(reservation_id);

CREATE TABLE IF NOT EXISTS restaurant_seasonal_closure (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID     NOT NULL REFERENCES property(id),
  restaurant_id UUID     NOT NULL REFERENCES restaurant(id),
  start_month   SMALLINT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_day     SMALLINT NOT NULL CHECK (start_day BETWEEN 1 AND 31),
  end_month     SMALLINT NOT NULL CHECK (end_month BETWEEN 1 AND 12),
  end_day       SMALLINT NOT NULL CHECK (end_day BETWEEN 1 AND 31),
  CHECK (ROW(start_month, start_day) <= ROW(end_month, end_day))
);

CREATE INDEX IF NOT EXISTS idx_restaurant_property             ON restaurant(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_table_property        ON restaurant_table(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant       ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_property           ON restaurant_reservation(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time    ON restaurant_reservation(table_id, reservation_date, start_time);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_clerk_user         ON restaurant_reservation(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_prop  ON restaurant_seasonal_closure(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_rest  ON restaurant_seasonal_closure(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_service_period_property           ON service_period(property_id);
CREATE INDEX IF NOT EXISTS idx_service_period_restaurant         ON service_period(restaurant_id);

-- ── Spa ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spa (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID         NOT NULL REFERENCES property(id),
  name                  VARCHAR(100) NOT NULL,
  description           TEXT,
  phone                 VARCHAR(30),
  status                VARCHAR(20)  DEFAULT 'active',
  slot_interval_minutes INT          NOT NULL DEFAULT 15, -- step between computed availability candidates; see spa_therapist_hours
  contact_email         VARCHAR(255), -- reply-to on booking confirmation/cancellation emails
  address               TEXT,         -- shown in booking confirmation/cancellation emails
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spa_treatment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  spa_id        UUID          NOT NULL REFERENCES spa(id),
  name          VARCHAR(100)  NOT NULL,
  description   TEXT,
  duration_mins INT           NOT NULL,
  price         NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_therapist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  spa_id        UUID         NOT NULL REFERENCES spa(id),
  name          VARCHAR(100) NOT NULL,
  status        VARCHAR(20)  DEFAULT 'active',
  clerk_user_id VARCHAR(100) -- optional: this therapist's own staff login, so the
                              -- spa dashboard can default to just their appointments
);

-- Per-therapist weekly working hours, mirrors service_period. Multiple rows
-- per (therapist_id, day_of_week) express a lunch break/split shift. No row
-- for a day means the therapist doesn't work that day -- there is no
-- closed_days array on spa itself since closure is per-barber, not per-shop.
CREATE TABLE IF NOT EXISTS spa_therapist_hours (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  therapist_id UUID NOT NULL REFERENCES spa_therapist(id),
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- ISO: 1 = Mon
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  CHECK (start_time < end_time)
);

-- Whole-day time off per therapist, mirrors restaurant_seasonal_closure but
-- dated rather than annually recurring. Partial-day blocks aren't a
-- supported case -- edit hours for that week, or book a placeholder
-- appointment.
CREATE TABLE IF NOT EXISTS spa_therapist_time_off (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  therapist_id UUID NOT NULL REFERENCES spa_therapist(id),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  reason       VARCHAR(100),
  CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS spa_slot (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID         NOT NULL REFERENCES property(id),
  therapist_id UUID         NOT NULL REFERENCES spa_therapist(id),
  treatment_id UUID         NOT NULL REFERENCES spa_treatment(id),
  slot_date    DATE         NOT NULL,
  slot_time    TIME         NOT NULL,
  status       VARCHAR(20)  DEFAULT 'available',
  UNIQUE (therapist_id, slot_date, slot_time)
);

-- slot_id is nullable and now just an optional back-pointer to the legacy
-- slot-based flow (Pirates Bight) -- every appointment, slot-based or
-- computed, always has the five columns below set directly, so reads never
-- need to join through spa_slot.
CREATE TABLE IF NOT EXISTS spa_appointment (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                   UUID         NOT NULL REFERENCES property(id),
  slot_id                       UUID         REFERENCES spa_slot(id),
  treatment_id                  UUID         NOT NULL REFERENCES spa_treatment(id),
  therapist_id                  UUID         NOT NULL REFERENCES spa_therapist(id),
  appointment_date              DATE         NOT NULL,
  start_time                    TIME         NOT NULL,
  end_time                      TIME         NOT NULL,
  guest_id                      UUID         REFERENCES guest(id),
  clerk_user_id                 VARCHAR(100),
  contact_name                  VARCHAR(100) NOT NULL,
  contact_email                 VARCHAR(255),
  contact_phone                 VARCHAR(30),
  status                        VARCHAR(20)  DEFAULT 'confirmed',
  notes                         TEXT,
  confirmation_resend_email_id  TEXT,
  payment_status                VARCHAR(20)  NOT NULL DEFAULT 'unpaid',
  paid_at                       TIMESTAMPTZ,
  stripe_payment_intent_id      VARCHAR(255),
  created_at                    TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT spa_appointment_payment_status CHECK (payment_status IN ('unpaid', 'paid'))
);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa       ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa       ON spa_therapist(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_clerk_user ON spa_therapist(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_therapist_date ON spa_slot(therapist_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_spa_slot_treatment      ON spa_slot(treatment_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_slot    ON spa_appointment(slot_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_clerk_user ON spa_appointment(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_therapist_date ON spa_appointment(therapist_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_hours_property   ON spa_therapist_hours(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_hours_therapist  ON spa_therapist_hours(therapist_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_time_off_therapist ON spa_therapist_time_off(therapist_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_spa_property             ON spa(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_treatment_property    ON spa_treatment(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_property    ON spa_therapist(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_property         ON spa_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_property  ON spa_appointment(property_id);

-- ── Beach Club ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS beach_bed (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_number  VARCHAR(10)  NOT NULL UNIQUE,
  zone        VARCHAR(50),
  status      VARCHAR(20)  DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS beach_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_id        UUID         NOT NULL REFERENCES beach_bed(id),
  guest_id      UUID         REFERENCES guest(id),
  contact_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  date          DATE         NOT NULL,
  status        VARCHAR(20)  DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now(),
  UNIQUE (bed_id, date)
);

CREATE INDEX IF NOT EXISTS idx_beach_booking_date    ON beach_booking(date);
CREATE INDEX IF NOT EXISTS idx_beach_booking_bed     ON beach_booking(bed_id);

-- ── Tours ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tour (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID          NOT NULL REFERENCES property(id),
  name           VARCHAR(100)  NOT NULL,
  description    TEXT,
  duration_mins  INT           NOT NULL,
  max_group_size INT           NOT NULL,
  price          NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tour_slot (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  tour_id     UUID         NOT NULL REFERENCES tour(id),
  slot_date   DATE         NOT NULL,
  slot_time   TIME         NOT NULL,
  status      VARCHAR(20)  DEFAULT 'active',
  UNIQUE (tour_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS tour_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  slot_id       UUID          NOT NULL REFERENCES tour_slot(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  group_size    INT           NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tour_slot_tour_date  ON tour_slot(tour_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_tour_booking_slot    ON tour_booking(slot_id);
CREATE INDEX IF NOT EXISTS idx_tour_property         ON tour(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_slot_property     ON tour_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_booking_property  ON tour_booking(property_id);

-- ── Golf ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS golf_course (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID          NOT NULL REFERENCES property(id),
  name             VARCHAR(100)  NOT NULL,
  description      TEXT,
  holes            INT           NOT NULL,
  price_per_player NUMERIC(10,2) NOT NULL,
  status           VARCHAR(20)   DEFAULT 'active',
  -- Tee-sheet schedule: when first_tee, last_tee, and tee_interval_minutes
  -- are all set, the boot/daily seeder (src/lib/teeTimeSeeder.js)
  -- materialises tee_time rows out to a rolling horizon and staff only
  -- manage exceptions -- same open-by-default philosophy as
  -- room_availability. All three NULL = manual tee sheet via
  -- POST /api/golf/tee-times/bulk.
  first_tee            TIME,
  last_tee             TIME,
  tee_interval_minutes INT,
  default_max_players  INT NOT NULL DEFAULT 4
);

CREATE TABLE IF NOT EXISTS tee_time (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  course_id   UUID         NOT NULL REFERENCES golf_course(id),
  tee_date    DATE         NOT NULL,
  tee_time    TIME         NOT NULL,
  max_players INT          NOT NULL DEFAULT 4,
  status      VARCHAR(20)  DEFAULT 'active',
  UNIQUE (course_id, tee_date, tee_time)
);

CREATE TABLE IF NOT EXISTS golf_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  tee_time_id   UUID          NOT NULL REFERENCES tee_time(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  players       INT           NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tee_time_course_date ON tee_time(course_id, tee_date);
CREATE INDEX IF NOT EXISTS idx_golf_booking_tee     ON golf_booking(tee_time_id);
CREATE INDEX IF NOT EXISTS idx_golf_course_property  ON golf_course(property_id);
CREATE INDEX IF NOT EXISTS idx_tee_time_property     ON tee_time(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_property ON golf_booking(property_id);

-- ── Equipment hire ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS equipment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID          NOT NULL REFERENCES property(id),
  name           VARCHAR(100)  NOT NULL,
  type           VARCHAR(50)   NOT NULL,
  description    TEXT,
  quantity       INT           NOT NULL,
  price_per_day  NUMERIC(10,2),
  price_per_hour NUMERIC(10,2),
  status         VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS equipment_hire (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  equipment_id  UUID          NOT NULL REFERENCES equipment(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  hire_date     DATE          NOT NULL,
  quantity      INT           NOT NULL,
  status           VARCHAR(20)   DEFAULT 'confirmed',
  notes            TEXT,
  start_time       TIME,
  rate_type        VARCHAR(10)   DEFAULT 'per_day',
  duration         NUMERIC(5,2)  DEFAULT 1,
  golf_booking_id  UUID          REFERENCES golf_booking(id),
  total_price      NUMERIC(10,2),
  created_at       TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_hire_date     ON equipment_hire(hire_date);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_eq       ON equipment_hire(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_property      ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_property ON equipment_hire(property_id);

-- ── Restaurant Orders ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS restaurant_menu_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  restaurant_id UUID          REFERENCES restaurant(id),
  name          VARCHAR(100)  NOT NULL,
  description   TEXT,
  category      VARCHAR(50),
  price         NUMERIC(10,2) NOT NULL,
  allergens     TEXT[]        NOT NULL DEFAULT '{}',
  variants      TEXT[]        NOT NULL DEFAULT '{}',
  status        VARCHAR(20)   DEFAULT 'active',
  translations  JSONB         NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS restaurant_order (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  booking_id  UUID         REFERENCES booking(id),
  table_id    UUID         REFERENCES restaurant_table(id),
  table_session_id UUID    REFERENCES restaurant_table_session(id),
  guest_id    UUID         REFERENCES guest(id),
  status         VARCHAR(20)  DEFAULT 'pending',
  notes          TEXT,
  scheduled_for  TIMESTAMPTZ,
  total_price    NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT restaurant_order_booking_or_table CHECK (booking_id IS NOT NULL OR table_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS restaurant_order_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID          NOT NULL REFERENCES restaurant_order(id) ON DELETE CASCADE,
  item_id     UUID          REFERENCES restaurant_menu_item(id),
  item_name   VARCHAR(100)  NOT NULL,
  quantity    INT           NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL,
  variant     VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_order_booking       ON restaurant_order(booking_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_guest         ON restaurant_order(guest_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_restaurant    ON restaurant_order(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_table_session ON restaurant_order(table_session_id);

-- ── Pro Shop ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shop (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS proshop_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  shop_id     UUID          REFERENCES shop(id),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  category    VARCHAR(50),
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS golf_booking_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES golf_booking(id) ON DELETE CASCADE,
  item_id     UUID          REFERENCES proshop_item(id),
  item_name   VARCHAR(100)  NOT NULL,
  quantity    INT           NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_golf_booking_item          ON golf_booking_item(booking_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
CREATE INDEX IF NOT EXISTS idx_shop_property               ON shop(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_property        ON proshop_item(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_shop            ON proshop_item(shop_id);

-- ── Event Inquiries ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_inquiry (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  restaurant_id UUID         REFERENCES restaurant(id),
  spa_id        UUID         REFERENCES spa(id), -- mirrors restaurant_id: optional, which module (if any) this enquiry is about
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(30),
  event_date    DATE, -- nullable since migrate-2026-08-30-event-inquiry-optional-date.sql: general enquiries need no date
  event_time    TIME, -- see migrate-2026-08-18-event-inquiry-time.sql
  guests        INT,
  event_type    VARCHAR(50),
  format        VARCHAR(50),
  message       TEXT,
  status        VARCHAR(20)  NOT NULL DEFAULT 'new',
  -- Email styling for a booking made later from this thread's AI reply --
  -- see migrate-2026-09-01-event-inquiry-branding.sql. Supplied by the
  -- website with the enquiry; the only place OTA keeps branding, and only
  -- for the life of the thread. cancel_url may contain {id} (appointment id).
  branding      JSONB,
  cancel_url    TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_property ON event_inquiry(property_id);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_spa      ON event_inquiry(spa_id);

-- ── Event Inquiry Messages ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_inquiry_message (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_inquiry_id  UUID NOT NULL REFERENCES event_inquiry(id),
  direction         VARCHAR(10) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body              TEXT NOT NULL,
  resend_email_id   TEXT,
  -- Staff attribution on outbound rows, captured at send time -- see
  -- migrate-2026-08-18-event-inquiry-message-sender.sql. NULL on inbound rows
  -- and on outbound rows sent before that migration.
  sent_by_user_id    VARCHAR(255),
  sent_by_name       VARCHAR(255),
  sent_by_avatar_url TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_message_inquiry ON event_inquiry_message(event_inquiry_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_inquiry_message_resend_id
  ON event_inquiry_message(resend_email_id) WHERE resend_email_id IS NOT NULL;

-- ── Event Inquiry AI Drafts ─────────────────────────────────────────────────
-- One row per Claude generation attempt for an inquiry (new inquiry, inbound
-- guest reply, or manual staff request) -- see
-- migrate-2026-08-29-event-inquiry-ai-replies.sql. Lifecycle:
--   pending -> sending -> sent      (approved by staff, or auto-sent)
--   pending -> rejected | superseded (a newer draft or a human reply replaced it)
--   failed                           (generation error; stored so the queue shows it)
-- 'sending' is claimed atomically before Resend is called so the same draft
-- can never email the guest twice.

CREATE TABLE IF NOT EXISTS event_inquiry_ai_draft (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id             UUID NOT NULL REFERENCES property(id),
  event_inquiry_id        UUID NOT NULL REFERENCES event_inquiry(id),
  trigger_type            VARCHAR(20) NOT NULL, -- 'trigger' alone is a Postgres keyword
  trigger_message_id      UUID REFERENCES event_inquiry_message(id), -- the inbound message that prompted it, if any
  body                    TEXT NOT NULL, -- '' on failed rows
  quality_score           INT NOT NULL, -- model's self-assessed 0-100; forced <= 40 when requires_human
  requires_human          BOOLEAN NOT NULL,
  requires_human_reason   TEXT,
  summary                 TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
  auto_sent               BOOLEAN NOT NULL DEFAULT false,
  sent_message_id         UUID REFERENCES event_inquiry_message(id),
  sent_body               TEXT, -- only set when the approver edited the text before sending
  reviewed_by_user_id     VARCHAR(255),
  reviewed_by_name        VARCHAR(255),
  reviewed_at             TIMESTAMPTZ,
  reject_reason           TEXT,
  model                   VARCHAR(50),
  input_tokens            INT,
  output_tokens           INT,
  cache_read_input_tokens INT,
  error                   TEXT,
  proposed_treatment_name VARCHAR(255), -- model-proposed slot; booked on approval (see aiReplyPipeline)
  proposed_date           DATE,
  proposed_time           TIME,
  booked_appointment_id   UUID REFERENCES spa_appointment(id), -- set once booked; guards send retries from double-booking
  created_at              TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT event_inquiry_ai_draft_trigger_type_check
    CHECK (trigger_type IN ('new_inquiry', 'inbound_reply', 'manual')),
  CONSTRAINT event_inquiry_ai_draft_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'superseded', 'failed')),
  CONSTRAINT event_inquiry_ai_draft_quality_score_check
    CHECK (quality_score BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_ai_draft_inquiry ON event_inquiry_ai_draft(event_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_ai_draft_property_pending
  ON event_inquiry_ai_draft(property_id) WHERE status = 'pending';

-- Added via ALTER, not baked into event_inquiry_message's CREATE TABLE above,
-- since the draft table references event_inquiry_message and didn't exist yet
-- at that point (same shape as restaurant_table_session.reservation_id).
-- Nullable -- human-written replies have no draft.
ALTER TABLE event_inquiry_message
  ADD COLUMN IF NOT EXISTS ai_draft_id UUID REFERENCES event_inquiry_ai_draft(id);
