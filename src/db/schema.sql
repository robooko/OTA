-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Guests
CREATE TABLE IF NOT EXISTS guest (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100)  NOT NULL,
  last_name  VARCHAR(100)  NOT NULL,
  email      VARCHAR(255)  NOT NULL UNIQUE,
  phone      VARCHAR(30),
  created_at TIMESTAMPTZ   DEFAULT now()
);

-- Room types
CREATE TABLE IF NOT EXISTS room_type (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(100)    NOT NULL,
  description    TEXT,
  max_occupancy  INT             NOT NULL,
  base_rate      NUMERIC(10,2)   NOT NULL
);

-- Rooms
CREATE TABLE IF NOT EXISTS room (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id UUID          NOT NULL REFERENCES room_type(id),
  room_number  VARCHAR(10)   NOT NULL UNIQUE,
  floor        INT,
  status       VARCHAR(20)   DEFAULT 'active'
);

-- Room availability
CREATE TABLE IF NOT EXISTS room_availability (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  guest_id    UUID          NOT NULL REFERENCES guest(id),
  room_id     UUID          NOT NULL REFERENCES room(id),
  check_in    DATE          NOT NULL,
  check_out   DATE          NOT NULL,
  guests      INT           NOT NULL DEFAULT 1,
  total_price NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'confirmed',
  created_at  TIMESTAMPTZ   DEFAULT now()
);

-- Payments
CREATE TABLE IF NOT EXISTS payment (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID          NOT NULL REFERENCES booking(id),
  amount     NUMERIC(10,2) NOT NULL,
  method     VARCHAR(30),
  status     VARCHAR(20)   DEFAULT 'pending',
  paid_at    TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_room_availability_room_date ON room_availability(room_id, date);
CREATE INDEX IF NOT EXISTS idx_booking_room_dates         ON booking(room_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_booking_guest              ON booking(guest_id);

-- Materialised view
CREATE MATERIALIZED VIEW IF NOT EXISTS room_type_availability AS
SELECT
  r.room_type_id,
  ra.date,
  COUNT(*)                                        AS total_rooms,
  COUNT(*) FILTER (WHERE ra.is_available = true)  AS available_rooms,
  MIN(COALESCE(ra.override_rate, rt.base_rate))   AS min_rate
FROM room_availability ra
JOIN room      r  ON r.id  = ra.room_id
JOIN room_type rt ON rt.id = r.room_type_id
GROUP BY r.room_type_id, ra.date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rta_room_type_date ON room_type_availability(room_type_id, date);

-- Restaurant tables
CREATE TABLE IF NOT EXISTS restaurant_table (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_number VARCHAR(10)  NOT NULL UNIQUE,
  seats        INT          NOT NULL,
  location     VARCHAR(50),
  status       VARCHAR(20)  DEFAULT 'active'
);

-- Time slots
CREATE TABLE IF NOT EXISTS time_slot (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_date        DATE         NOT NULL,
  slot_time        TIME         NOT NULL,
  available_seats  INT          NOT NULL,
  UNIQUE (slot_date, slot_time)
);

-- Restaurant reservations
CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      UUID         NOT NULL REFERENCES restaurant_table(id),
  time_slot_id  UUID         NOT NULL REFERENCES time_slot(id),
  guest_id      UUID         REFERENCES guest(id),
  contact_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  party_size    INT          NOT NULL,
  status        VARCHAR(20)  DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_reservation_table_slot ON restaurant_reservation(table_id, time_slot_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_reservation_date ON restaurant_reservation(time_slot_id);

-- Restaurant
CREATE TABLE IF NOT EXISTS restaurant (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ  DEFAULT now()
);

-- Restaurant tables
CREATE TABLE IF NOT EXISTS restaurant_table (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_number  VARCHAR(10)  NOT NULL,
  seats         INT          NOT NULL,
  location      VARCHAR(50),
  status        VARCHAR(20)  DEFAULT 'active',
  UNIQUE (restaurant_id, table_number)
);

-- Restaurant reservations
CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_id      UUID         NOT NULL REFERENCES restaurant_table(id),
  guest_id      UUID         REFERENCES guest(id),
  contact_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  date          DATE         NOT NULL,
  time_slot     TIME         NOT NULL,
  duration_mins INT          NOT NULL DEFAULT 120,
  party_size    INT          NOT NULL,
  status        VARCHAR(20)  DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_reservation_table_date ON restaurant_reservation(table_id, date);
CREATE INDEX IF NOT EXISTS idx_restaurant_reservation_date ON restaurant_reservation(date);
