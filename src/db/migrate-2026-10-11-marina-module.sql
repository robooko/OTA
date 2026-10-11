-- Marina module: sidon-marina's berths, bookings, pricing, documents and
-- contracts as a property-scoped OTA module. See
-- docs/superpowers/specs/2026-10-10-ota-marina-unification-design.md.
--
-- Children of marina cascade on delete: rows are soft-deleted through
-- status in normal use, and the only hard delete is the Sidon import's
-- re-run (delete everything under the mapped marinas, then re-insert).

CREATE TABLE IF NOT EXISTS marina (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID NOT NULL REFERENCES property(id),
  name                  VARCHAR(100) NOT NULL,
  slug                  VARCHAR(100) NOT NULL,
  description           TEXT,
  phone                 VARCHAR(30),
  email                 VARCHAR(255),
  website               TEXT,
  lat                   DOUBLE PRECISION,
  lng                   DOUBLE PRECISION,
  layout_svg            TEXT,
  layout_sw_lat         DOUBLE PRECISION,
  layout_sw_lng         DOUBLE PRECISION,
  layout_ne_lat         DOUBLE PRECISION,
  layout_ne_lng         DOUBLE PRECISION,
  layout_rotation       DOUBLE PRECISION,
  -- Stripe releases an uncaptured online card hold after ~7 days, so the
  -- staff response window has to end well before that.
  response_window_hours INT NOT NULL DEFAULT 24 CHECK (response_window_hours BETWEEN 1 AND 144),
  auto_confirm          BOOLEAN NOT NULL DEFAULT false,
  booking_url           TEXT,
  sidon_owner_id        TEXT UNIQUE, -- import mapping only; dropped at cleanup
  status                VARCHAR(20) DEFAULT 'active',
  created_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (property_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_marina_property ON marina (property_id);

CREATE TABLE IF NOT EXISTS marina_pontoon (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  marina_id   UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL DEFAULT 'Dock',
  svg_data    TEXT,
  sw_lat      DOUBLE PRECISION,
  sw_lng      DOUBLE PRECISION,
  ne_lat      DOUBLE PRECISION,
  ne_lng      DOUBLE PRECISION,
  rotation    DOUBLE PRECISION,
  sort_order  INT NOT NULL DEFAULT 0,
  status      VARCHAR(20) DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marina_pontoon_property ON marina_pontoon (property_id);

-- Occupancy is never stored on a berth: it comes from marina_booking only.
CREATE TABLE IF NOT EXISTS marina_berth (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES property(id),
  marina_id       UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  pontoon_id      UUID REFERENCES marina_pontoon(id) ON DELETE SET NULL,
  label           VARCHAR(30) NOT NULL,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  rotation        DOUBLE PRECISION,
  length_m        NUMERIC(6,2),
  min_length_m    NUMERIC(6,2),
  beam_m          NUMERIC(6,2),
  depth_m         NUMERIC(6,2),
  price_per_night NUMERIC(10,2),
  price_mode      VARCHAR(10) NOT NULL DEFAULT 'per_metre' CHECK (price_mode IN ('per_metre', 'fixed')),
  notes           TEXT,
  status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (marina_id, label)
);
CREATE INDEX IF NOT EXISTS idx_marina_berth_property ON marina_berth (property_id);

-- valid_to is inclusive (the last night the tier covers).
CREATE TABLE IF NOT EXISTS marina_price_tier (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES property(id),
  marina_id       UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  valid_from      DATE NOT NULL,
  valid_to        DATE NOT NULL,
  max_length_m    NUMERIC(6,2) NOT NULL,
  max_beam_m      NUMERIC(6,2),
  price_per_night NUMERIC(10,2) NOT NULL,
  price_per_month NUMERIC(10,2),
  price_per_year  NUMERIC(10,2),
  status          VARCHAR(20) DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS idx_marina_price_tier_property ON marina_price_tier (property_id);

CREATE TABLE IF NOT EXISTS marina_booking (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID NOT NULL REFERENCES property(id),
  marina_id                UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  berth_id                 UUID NOT NULL REFERENCES marina_berth(id) ON DELETE CASCADE,
  guest_id                 UUID REFERENCES guest(id), -- phase 2
  contact_name             VARCHAR(100) NOT NULL,
  contact_email            VARCHAR(255),
  contact_phone            VARCHAR(30),
  contact_email_key        VARCHAR(255),
  boat_name                VARCHAR(100),
  boat_length_m            NUMERIC(6,2),
  boat_beam_m              NUMERIC(6,2),
  arrival                  DATE NOT NULL,
  departure                DATE, -- exclusive; NULL = open-ended (staff/import only)
  status                   VARCHAR(20) NOT NULL CHECK (status IN ('hold', 'pending', 'confirmed', 'declined', 'cancelled')),
  source                   VARCHAR(10) NOT NULL CHECK (source IN ('guest', 'staff', 'import')),
  locale                   VARCHAR(5) NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'it', 'fr', 'es')),
  total_price              NUMERIC(10,2),
  currency                 CHAR(3),
  stripe_payment_intent_id VARCHAR(255),
  payment_status           VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none', 'held', 'captured', 'released', 'refunded')),
  payment_error            TEXT,
  hold_expires_at          TIMESTAMPTZ, -- guest rows only; staff/import never swept
  confirm_token_hash       VARCHAR(64),
  client_ip                VARCHAR(64),
  user_agent               TEXT,
  notes                    TEXT,
  cancel_reason            TEXT,
  legacy_payment_intent_id VARCHAR(255), -- import only (Sidon Connect PI), reference only
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now(),
  CHECK (departure IS NULL OR departure > arrival)
);
CREATE INDEX IF NOT EXISTS idx_marina_booking_property ON marina_booking (property_id);
CREATE INDEX IF NOT EXISTS idx_marina_booking_berth ON marina_booking (berth_id, arrival);
CREATE INDEX IF NOT EXISTS idx_marina_booking_email_key ON marina_booking (property_id, contact_email_key);
CREATE INDEX IF NOT EXISTS idx_marina_booking_hold
  ON marina_booking (hold_expires_at) WHERE source = 'guest' AND status IN ('hold', 'pending');

-- daterange(arrival, NULL) is unbounded above, so an open-ended booking
-- blocks every later date; adjacent stays don't overlap under [).
-- btree_gist is already installed (migrate-2026-07-22-booking-no-overlap.sql).
DO $$ BEGIN
  ALTER TABLE marina_booking ADD CONSTRAINT marina_booking_no_overlap
    EXCLUDE USING gist (berth_id WITH =, daterange(arrival, departure) WITH &&)
    WHERE (status IN ('hold', 'pending', 'confirmed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS marina_doc_requirement (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  marina_id   UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  fields      JSONB NOT NULL DEFAULT '[]', -- [{name,label,type}]
  mandatory   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 0,
  status      VARCHAR(20) DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marina_doc_requirement_property ON marina_doc_requirement (property_id);

-- blob_pathname is a private-store path, never a URL: files are only ever
-- streamed through the bearer-only GET /api/marina/documents/:id/file.
CREATE TABLE IF NOT EXISTS marina_document (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES property(id),
  marina_id       UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  booking_id      UUID NOT NULL REFERENCES marina_booking(id) ON DELETE CASCADE,
  requirement_id  UUID REFERENCES marina_doc_requirement(id) ON DELETE SET NULL,
  type            VARCHAR(30),
  blob_pathname   TEXT NOT NULL,
  file_name       VARCHAR(255),
  content_type    VARCHAR(50) NOT NULL,
  size_bytes      INT NOT NULL,
  extracted_data  JSONB,
  expiry_date     DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  notes           TEXT,
  submitted_at    TIMESTAMPTZ DEFAULT now(),
  verified_at     TIMESTAMPTZ,
  verified_by     VARCHAR(255),
  file_deleted_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marina_document_property ON marina_document (property_id);
CREATE INDEX IF NOT EXISTS idx_marina_document_booking ON marina_document (booking_id);

CREATE TABLE IF NOT EXISTS marina_contract_template (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  marina_id     UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  body_markdown TEXT NOT NULL,
  min_nights    INT NOT NULL DEFAULT 0,
  status        VARCHAR(20) DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marina_contract_template_property ON marina_contract_template (property_id);

CREATE TABLE IF NOT EXISTS marina_contract_signature (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  booking_id    UUID NOT NULL REFERENCES marina_booking(id) ON DELETE CASCADE,
  template_id   UUID REFERENCES marina_contract_template(id) ON DELETE SET NULL,
  rendered_body TEXT NOT NULL,
  signer_email  VARCHAR(255),
  agreed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address    VARCHAR(64),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (booking_id)
);
CREATE INDEX IF NOT EXISTS idx_marina_contract_signature_property ON marina_contract_signature (property_id);

CREATE TABLE IF NOT EXISTS marina_poi (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  marina_id   UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  label       VARCHAR(100) NOT NULL,
  type        VARCHAR(30),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  status      VARCHAR(20) DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marina_poi_property ON marina_poi (property_id);

CREATE TABLE IF NOT EXISTS marina_image (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property(id),
  marina_id   UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  url         TEXT NOT NULL, -- OTA's public blob store
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  status      VARCHAR(20) DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marina_image_property ON marina_image (property_id);

ALTER TABLE event_inquiry ADD COLUMN IF NOT EXISTS marina_id UUID REFERENCES marina(id);
-- Public: returned to guest routes so the widget can mount Stripe's
-- Payment Element on the property's own account.
ALTER TABLE property ADD COLUMN IF NOT EXISTS stripe_publishable_key TEXT;
