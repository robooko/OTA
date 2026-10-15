-- Courses: multi-session camps and season courses (spec
-- docs/superpowers/specs/2026-10-15-courses-design.md). New tables only;
-- safe to run twice.
--   node scripts/run-migration.js src/db/migrate-2026-10-15-courses.sql

CREATE TABLE IF NOT EXISTS course (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  price       NUMERIC(10,2) NOT NULL,       -- per participant, whole course
  min_age     SMALLINT,                     -- NULL = no lower bound
  max_age     SMALLINT,                     -- NULL = no upper bound
  status      VARCHAR(20)   DEFAULT 'active'
);

-- One dated instance of a course. Sessions aren't stored: they're every
-- date in [start_date, end_date] on one of `weekdays`, minus skip_dates
-- (src/lib/courseSessions.js). Everyone attends every session, so capacity
-- lives here.
CREATE TABLE IF NOT EXISTS course_run (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  course_id   UUID          NOT NULL REFERENCES course(id),
  start_date  DATE          NOT NULL,
  end_date    DATE          NOT NULL,       -- inclusive
  weekdays    SMALLINT[]    NOT NULL,       -- 0 = Sunday .. 6 = Saturday
  skip_dates  DATE[]        NOT NULL DEFAULT '{}',
  start_time  TIME          NOT NULL,
  end_time    TIME          NOT NULL,
  capacity    INT           NOT NULL,
  price       NUMERIC(10,2),                -- NULL = course.price
  status      VARCHAR(20)   DEFAULT 'active',
  CHECK (end_date >= start_date),
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS course_enrolment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  run_id        UUID          NOT NULL REFERENCES course_run(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',   -- confirmed / cancelled
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);

-- Minimal on purpose: name and birth date only (age bands + roster).
-- Medical, pickup and waiver details stay on the booking site.
CREATE TABLE IF NOT EXISTS course_participant (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  UUID         NOT NULL REFERENCES course_enrolment(id) ON DELETE CASCADE,
  first_name    VARCHAR(100) NOT NULL,
  date_of_birth DATE         NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_course_property               ON course(property_id);
CREATE INDEX IF NOT EXISTS idx_course_run_course_start       ON course_run(course_id, start_date);
CREATE INDEX IF NOT EXISTS idx_course_run_property           ON course_run(property_id);
CREATE INDEX IF NOT EXISTS idx_course_enrolment_run          ON course_enrolment(run_id);
CREATE INDEX IF NOT EXISTS idx_course_enrolment_property     ON course_enrolment(property_id);
CREATE INDEX IF NOT EXISTS idx_course_participant_enrolment  ON course_participant(enrolment_id);
