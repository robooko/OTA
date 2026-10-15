# Courses: multi-session camps and season courses

Agreed with Robert, 15 Oct 2026. Modelled on Escuela Puerto Portals
(escuelapuertoportals.com): weekly age-banded summer camps (22 Jun–28 Aug,
Mon–Fri 9–16 or 10–14) and Sep–Jun Saturday courses. Applies equally to golf
academies (4-week beginner courses, junior camps).

## Problem

Tours sells one dated slot per booking; spa sells one appointment. Neither
models "one purchase, many dated sessions, one roster", and neither records
who the participants are, so age bands (children / teenagers) can't be
enforced and staff have no roster.

## Decisions

1. **Participant data is minimal.** OTA stores each participant's
   `first_name` and `date_of_birth` only — enough to enforce age bands and
   print a roster. Medical notes, allergies, swim ability, emergency
   contacts, pickups and waivers stay on the booking site, linked by
   enrolment id. (Per the OTA-holds-minimal-data principle; avoids holding
   minors' medical data.)
2. **OTA does not take payment.** Same as tours: OTA records `total_price`;
   the booking site charges the card. Monthly instalments for season courses
   are the site's concern.
3. **Whole course only.** One enrolment takes a seat on every session of a
   run. No drop-ins, no pro-rata. Per-day selling = one-day runs. Late
   joiners are handled by the caller passing `total_price` (see flow).
4. **New `courses` module**, not a branch inside tours. Tours stays untouched.
5. **No session table.** A run's sessions are derived from its date range,
   weekdays and skip dates. Capacity lives on the run, because every
   participant attends every session.

## Data model

All tables are property-scoped like tours.

```sql
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

CREATE TABLE IF NOT EXISTS course_run (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  course_id   UUID          NOT NULL REFERENCES course(id),
  start_date  DATE          NOT NULL,
  end_date    DATE          NOT NULL,       -- inclusive
  weekdays    SMALLINT[]    NOT NULL,       -- 0 = Sun .. 6 = Sat
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

CREATE TABLE IF NOT EXISTS course_participant (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  UUID         NOT NULL REFERENCES course_enrolment(id) ON DELETE CASCADE,
  first_name    VARCHAR(100) NOT NULL,
  date_of_birth DATE         NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_course_property          ON course(property_id);
CREATE INDEX IF NOT EXISTS idx_course_run_course_start  ON course_run(course_id, start_date);
CREATE INDEX IF NOT EXISTS idx_course_run_property      ON course_run(property_id);
CREATE INDEX IF NOT EXISTS idx_course_enrolment_run     ON course_enrolment(run_id);
CREATE INDEX IF NOT EXISTS idx_course_enrolment_property ON course_enrolment(property_id);
CREATE INDEX IF NOT EXISTS idx_course_participant_enrolment ON course_participant(enrolment_id);
```

**Rules**

- **Sessions** of a run = every date in `[start_date, end_date]` whose
  weekday is in `weekdays` and which is not in `skip_dates`. A run with zero
  sessions is rejected at create/update (400).
- **Seats taken** = count of `course_participant` rows on the run's
  non-cancelled enrolments.
- **Age** is a participant's age in whole years on the run's `start_date`,
  checked inclusively against `min_age` / `max_age`.
- **Effective price** per participant = `course_run.price ?? course.price`.

## API — `/api/courses`

All routes use `authenticateOrApiKey` and scope by `req.property_id`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List courses |
| POST | `/` | Create course |
| PUT | `/:id` | Update course |
| DELETE | `/:id` | Hard delete course with its runs/enrolments; 409 while any run that hasn't ended has a non-cancelled enrolment |
| POST | `/:id/runs` | Bulk create runs: `{ runs: [{ start_date, end_date, weekdays, skip_dates?, start_time, end_time, capacity, price? }] }` |
| PUT | `/runs/:id` | Update run; 409 if `capacity` would drop below seats taken |
| DELETE | `/runs/:id` | Hard delete run; same live-enrolment rule as course delete |
| GET | `/runs/search` | `?from=&to=&age=&course_id=` — active runs of active courses with `start_date` in `[from, to)`; `age` filters by band. Each result: run fields, course name/description/ages, `price` (effective), `seats_left`, `sessions` (date array) |
| POST | `/enrolments` | Enrol participants (flow below) |
| GET | `/enrolments` | `?run_id=&status=&guest_id=` — enrolments with participants |
| PUT | `/enrolments/:id` | `{ status?, notes? }`; reinstating a cancelled enrolment re-runs the seat check |
| GET | `/runs/:id/roster` | Run, its `sessions`, and every participant on non-cancelled enrolments: `first_name`, `age` (on start date), enrolment contact name/email/phone |

Errors follow the house shape `{ error, details? }` with 400 / 404 / 409.
Dates are `YYYY-MM-DD`; invalid dates, weekdays outside 0–6, or negative
capacity/prices are 400.

### `POST /api/courses/enrolments`

```json
{
  "run_id": "uuid",
  "contact_name": "Ana García",
  "contact_email": "ana@example.com",
  "contact_phone": "+34…",
  "guest_id": "uuid (optional)",
  "notes": "optional",
  "total_price": 480.00,
  "participants": [{ "first_name": "Lucia", "date_of_birth": "2016-03-02" }]
}
```

One transaction:

1. Validate: `run_id`, `contact_name`, ≥1 participant, each with
   `first_name` and a valid `date_of_birth`; `total_price` if present is a
   non-negative number → else 400.
2. `SELECT … FROM course_run JOIN course … FOR UPDATE OF course_run FOR
   SHARE OF course` scoped to the property → 404 if missing; 409 if run or
   course not active. The run lock serialises enrolments on one run.
3. If `guest_id` is given it must belong to the property → else 404.
4. If the run's `start_date` is before today and no `total_price` was
   supplied → 409 "This course has already started". (Supplying
   `total_price` is the late-joiner path.)
5. Each participant's age must fit the band → 400 naming the participant,
   e.g. "Lucia is 13 on 6 Jul 2026; this course is for ages 8–12".
6. Seats taken + new participants ≤ `capacity` → else 409
   "Only N places left".
7. `total_price` = supplied value, else effective price × participants.
8. Insert enrolment and participants; commit; 201 with the enrolment and
   its `participants` array.

`PUT /api/courses/runs/:id` locks the run `FOR UPDATE` before the capacity
check, so it can't race an enrolment.

## Files

- `src/db/migrate-2026-10-15-courses.sql` — the DDL above; same statements
  appended to `src/db/schema.sql`.
- `src/lib/courseSessions.js` — pure `sessionDates(run)` and
  `ageOn(dob, date)`; used by search, roster, run validation and checks.
- `src/controllers/courses.js`, `src/routes/courses.js`; mounted at
  `/api/courses` in `src/app.js`.
- `src/controllers/property.js` — add `'courses'` to `MODULE_KEYS`.
  No per-request module gating (tours has none either).
- `src/docs/swagger.js` — entries alongside tours.

## Testing

`scripts/check-courses.js`, run with
`node -r dotenv/config scripts/check-courses.js`, following
`check-marina-http.js`: the real app on an ephemeral port, local DB only
(refuses remote hosts), fixtures committed under a throwaway property and
deleted at the end pass or fail, `ok` / `FAIL` lines, non-zero exit on
failure. (Controllers open their own transactions, so the rolled-back
single-transaction pattern can't wrap them.) `sessionDates` / `ageOn` are
asserted directly.

Checks:

- `sessionDates`: weekday filter, skip dates, single-day run, zero-session
  run rejected.
- `ageOn`: birthday on the start date counts as the new age.
- Age band: 12-year-old accepted on 8–12; 13-year-old rejected with name.
- Seats: 9/10 taken + 2 → 409; cancel frees seats; reinstate re-checks.
- Price: run price overrides course price × participants; supplied
  `total_price` wins.
- Started run: 409 without `total_price`, 201 with it.
- Run capacity below seats taken → 409.
- Course/run delete with live enrolments → 409; without → deleted.
- Search: `age` filter and `seats_left`.

## Out of scope

Waitlists; sibling / multi-week discounts (caller passes `total_price`);
confirmation emails, reminders and review requests; MCP / agent tools;
payments and instalments; instructor assignment; prerequisites and
certifications. Each can be layered on these tables later.
