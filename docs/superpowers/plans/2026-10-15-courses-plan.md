# Courses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `courses` module: multi-session camps / season courses with dated runs, age bands, per-run capacity and enrolments carrying minimal participant data.

**Architecture:** Four new tables (`course`, `course_run`, `course_enrolment`, `course_participant`), one controller + router mounted at `/api/courses`, and a pure helper (`src/lib/courseSessions.js`) that derives a run's session dates from its date range, weekdays and skip dates. Enrolment follows `tours.createBooking`'s locking pattern: lock the run row, count seats, insert.

**Tech Stack:** Node.js, Express, `pg`, PostgreSQL. No test framework — checks are `scripts/check-*.js` run with `node -r dotenv/config`.

**Spec:** `docs/superpowers/specs/2026-10-15-courses-design.md`

## Global Constraints

- OTA stores only `first_name` and `date_of_birth` per participant — no other participant fields.
- OTA takes no payment; `total_price` is a record only.
- Whole course only: one enrolment = one seat per participant on every session of the run.
- All tables and queries are property-scoped by `req.property_id`; all routes use `authenticateOrApiKey`.
- Errors are `{ error }` JSON with 400 / 404 / 409; dates `YYYY-MM-DD`, times `HH:MM`.
- Weekdays are `0 = Sunday .. 6 = Saturday`.
- Tours must not change.
- Local DB only for checks; the live migration and `git push` need the user's go-ahead (Task 5).
- Commit directly on `main` (user preference); end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two parents booking the last place at the same moment** — exactly one succeeds, the other gets 409. (Task 3, parallel-enrolment check.)
2. **`skip_dates` coming back from Postgres as JS `Date`s** (pg parses `DATE[]` into local-midnight Dates, shifting days off UTC) — sessions must still exclude the skipped day and the API must return strings. (Task 1 parser + Task 2 check.)
3. **Editing a run so it has no sessions** (e.g. weekdays moved off the date range) — 400, not a silently empty course. (Task 2 check.)
4. **Another property's API key** — can't see, enrol in, or roster someone else's run (404). (Task 3 check.)
5. **Garbage participant data** (blank name, `2030-02-30`, birth date in the future) — 400, never a Postgres 500. (Task 1 `isValidDate` fix + Task 3 check.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrate-2026-10-15-courses.sql` | DDL for the four tables + indexes (idempotent) |
| `src/db/schema.sql` | Same DDL appended after the tours section |
| `src/db/index.js` | Parse `DATE[]` (OID 1182) as `'YYYY-MM-DD'` strings |
| `src/middleware/validate.js` | `isValidDate` rejects impossible dates (`2030-02-30`) |
| `src/lib/courseSessions.js` | Pure `sessionDates(run)`, `ageOn(dob, date)` |
| `src/controllers/courses.js` | Course, run, enrolment, search, roster handlers |
| `src/routes/courses.js` | Route table |
| `src/app.js` | Mount `/api/courses` |
| `src/controllers/property.js` | `'courses'` in `MODULE_KEYS` |
| `src/docs/swagger.js` | Courses tag + paths |
| `scripts/check-courses.js` | Pure + HTTP checks |

---

### Task 1: Tables, date parsing, session helper

**Files:**
- Create: `src/db/migrate-2026-10-15-courses.sql`, `src/lib/courseSessions.js`, `scripts/check-courses.js`
- Modify: `src/db/schema.sql` (after the tours indexes, before `-- ── Golf`), `src/db/index.js`, `src/middleware/validate.js:11-13`

**Interfaces:**
- Produces: `sessionDates({ start_date, end_date, weekdays, skip_dates }) -> string[]` (ascending `YYYY-MM-DD`); `ageOn(dob: string, date: string) -> number`. `DATE[]` columns read as `string[]`. `isValidDate('2030-02-30') === false`.

- [ ] **Step 1: Write the check script with pure checks**

`scripts/check-courses.js`:

```js
// Courses checks. Pure helpers are asserted directly; HTTP checks run the
// real app on an ephemeral port with fixtures committed under a throwaway
// property and deleted at the end (pass or fail). Local DB only, with
// migrate-2026-10-15-courses.sql applied.
//   node -r dotenv/config scripts/check-courses.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const { sessionDates, ageOn } = require('../src/lib/courseSessions');
const { isValidDate } = require('../src/middleware/validate');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Task 1: pure helpers ----
  await check('sessionDates: Mon-Fri camp week', async () => {
    assert.deepEqual(sessionDates({ start_date: '2030-07-01', end_date: '2030-07-05', weekdays: [1, 2, 3, 4, 5], skip_dates: [] }),
      ['2030-07-01', '2030-07-02', '2030-07-03', '2030-07-04', '2030-07-05']);
  });
  await check('sessionDates: Saturdays with a skip date', async () => {
    assert.deepEqual(sessionDates({ start_date: '2030-09-07', end_date: '2030-09-28', weekdays: [6], skip_dates: ['2030-09-14'] }),
      ['2030-09-07', '2030-09-21', '2030-09-28']);
  });
  await check('sessionDates: single-day run, and no matching weekday', async () => {
    assert.deepEqual(sessionDates({ start_date: '2030-07-01', end_date: '2030-07-01', weekdays: [1], skip_dates: [] }), ['2030-07-01']);
    assert.deepEqual(sessionDates({ start_date: '2030-07-01', end_date: '2030-07-01', weekdays: [0], skip_dates: [] }), []);
  });
  await check('ageOn: birthday on the date counts', async () => {
    assert.equal(ageOn('2018-07-01', '2030-07-01'), 12);
    assert.equal(ageOn('2018-07-02', '2030-07-01'), 11);
    assert.equal(ageOn('2017-07-01', '2030-07-01'), 13);
  });
  await check('isValidDate rejects impossible dates', async () => {
    assert.equal(isValidDate('2030-02-28'), true);
    assert.equal(isValidDate('2030-02-30'), false);
    assert.equal(isValidDate('2030-13-01'), false);
  });
  await check('DATE[] reads back as strings', async () => {
    const { rows: [r] } = await pool.query("SELECT ARRAY['2030-12-25','2030-12-26']::date[] AS d, '{}'::date[] AS e");
    assert.deepEqual(r.d, ['2030-12-25', '2030-12-26']);
    assert.deepEqual(r.e, []);
  });

  // HTTP_CHECKS (Tasks 2-4 insert their blocks here)

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: crashes with `Cannot find module '../src/lib/courseSessions'`.

- [ ] **Step 3: Write the helper**

`src/lib/courseSessions.js`:

```js
// A course run's sessions: every date in [start_date, end_date] on one of
// its weekdays (0 = Sunday) and not in skip_dates. Dates are 'YYYY-MM-DD'
// strings (see db/index.js); the walk is in UTC so it never slips a day.
function sessionDates({ start_date, end_date, weekdays, skip_dates = [] }) {
  const skip = new Set(skip_dates);
  const dates = [];
  const end = new Date(`${end_date}T00:00:00Z`);
  for (const d = new Date(`${start_date}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (weekdays.includes(d.getUTCDay()) && !skip.has(iso)) dates.push(iso);
  }
  return dates;
}

// Whole years old on `date`; a birthday falling on `date` counts.
function ageOn(dob, date) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

module.exports = { sessionDates, ageOn };
```

- [ ] **Step 4: Fix `isValidDate` and add the `DATE[]` parser**

`src/middleware/validate.js` — replace `isValidDate`:

```js
// Date.parse rolls '2030-02-30' over to 2 March, so also require the date
// to round-trip unchanged.
function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str))
    && new Date(str).toISOString().slice(0, 10) === str;
}
```

`src/db/index.js` — after the existing `types.setTypeParser(1082, ...)` line:

```js
// DATE[] (OID 1182) gets the same treatment: pg's default turns each
// element into a local-midnight Date. Elements are bare YYYY-MM-DD (no
// quotes or commas), so a split is enough; no column here stores NULLs.
types.setTypeParser(1182, (val) => (val === '{}' ? [] : val.slice(1, -1).split(',')));
```

- [ ] **Step 5: Write the migration and mirror it into schema.sql**

`src/db/migrate-2026-10-15-courses.sql`:

```sql
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
```

In `src/db/schema.sql`, insert the same statements (from `CREATE TABLE IF NOT EXISTS course (` through the last index, without the header comment's `node scripts/...` line) under a `-- ── Courses ──…` heading directly before `-- ── Golf ──`.

- [ ] **Step 6: Apply the migration locally (twice, to prove it's idempotent)**

Run (PowerShell): `$env:DATABASE_URL_LIVE=''; node scripts/run-migration.js src/db/migrate-2026-10-15-courses.sql; node scripts/run-migration.js src/db/migrate-2026-10-15-courses.sql`
Expected: `DATABASE_URL: ok` twice, `DATABASE_URL_LIVE: not set, skipped` twice.

- [ ] **Step 7: Run the checks**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: six `ok` lines, `all passed`.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrate-2026-10-15-courses.sql src/db/schema.sql src/db/index.js src/middleware/validate.js src/lib/courseSessions.js scripts/check-courses.js
git commit -m "Courses: tables, session-date helper; DATE[] parses to strings, isValidDate rejects 2030-02-30

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Courses and runs CRUD

**Files:**
- Create: `src/controllers/courses.js`, `src/routes/courses.js`
- Modify: `src/app.js` (require next to `toursRoutes`, mount after `/api/tours`), `src/controllers/property.js:17`, `scripts/check-courses.js`

**Interfaces:**
- Consumes: `sessionDates`, `ageOn` (Task 1); `isValidDate`, `isValidTime` from `src/middleware/validate.js`.
- Produces (in `src/controllers/courses.js`, used by Tasks 3-4): `withSessions(run) -> run & { sessions: string[] }`; `seatsTaken(client, runId) -> Promise<number>`; `lockRun(client, runId, propertyId) -> Promise<row|undefined>` returning the run joined with `course_name, course_price, min_age, max_age, course_status`, `started` (bool: `start_date < CURRENT_DATE`), locked `FOR UPDATE OF cr FOR SHARE OF c`. Responses: course rows as stored; run rows as stored plus `sessions`.

- [ ] **Step 1: Add HTTP scaffolding and Task 2 checks to the check script**

In `scripts/check-courses.js`, add after the existing requires:

```js
const app = require('../src/app');
```

Replace the `// HTTP_CHECKS (Tasks 2-4 insert their blocks here)` line with:

```js
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `courses_check_${tag}`;
  const OTHER_KEY = `courses_check_other_${tag}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, api_key) VALUES ('Course Check', $1) RETURNING id`, [KEY])).id;
  const Q = (await one(`INSERT INTO property (name, api_key) VALUES ('Course Check Other', $1) RETURNING id`, [OTHER_KEY])).id;
  // ponytail: ~60 requests on one key, under the 100/window API-key limit; split keys if checks grow past it.
  const api = async (method, path, body, key = KEY) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, text };
  };
  const camp = { start_date: '2030-07-01', end_date: '2030-07-05', weekdays: [1, 2, 3, 4, 5], start_time: '10:00', end_time: '14:00', capacity: 10 };

  try {
    // ---- Task 2: courses and runs ----
    let course, run;
    await check('create course; validation', async () => {
      assert.equal((await api('POST', '/api/courses', { name: 'Kids Sailing', price: -1 })).status, 400);
      assert.equal((await api('POST', '/api/courses', { name: 'Kids Sailing', price: 200, min_age: 12, max_age: 8 })).status, 400);
      const r = await api('POST', '/api/courses', { name: 'Kids Sailing', price: 200, min_age: 8, max_age: 12 });
      assert.equal(r.status, 201, r.text);
      course = r.body;
      assert.equal(course.min_age, 8);
    });
    await check('list courses; other property sees none', async () => {
      assert.ok((await api('GET', '/api/courses')).body.some((c) => c.id === course.id));
      assert.ok(!(await api('GET', '/api/courses', null, OTHER_KEY)).body.some((c) => c.id === course.id));
    });
    await check('update course: partial, null clears a bound, merged band validated', async () => {
      const r = await api('PUT', `/api/courses/${course.id}`, { max_age: null });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.max_age, null);
      assert.equal(r.body.name, 'Kids Sailing');
      assert.equal((await api('PUT', `/api/courses/${course.id}`, { max_age: 7 })).status, 400); // below min_age 8
      assert.equal((await api('PUT', `/api/courses/${course.id}`, { max_age: 12 })).status, 200);
      assert.equal((await api('PUT', `/api/courses/${course.id}`, { name: 'x' }, OTHER_KEY)).status, 404);
    });
    await check('create runs: sessions returned, skip_dates as strings', async () => {
      const r = await api('POST', `/api/courses/${course.id}/runs`, { runs: [
        camp,
        { start_date: '2030-09-07', end_date: '2030-09-28', weekdays: [6], skip_dates: ['2030-09-14'], start_time: '10:00', end_time: '13:00', capacity: 8, price: 150 },
      ] });
      assert.equal(r.status, 201, r.text);
      run = r.body[0];
      assert.equal(run.sessions.length, 5);
      assert.deepEqual(r.body[1].skip_dates, ['2030-09-14']);
      assert.deepEqual(r.body[1].sessions, ['2030-09-07', '2030-09-21', '2030-09-28']);
    });
    await check('create runs: bad input is 400 with the run index', async () => {
      const bad = await api('POST', `/api/courses/${course.id}/runs`, { runs: [camp, { ...camp, weekdays: [0] }] });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /^runs\[1\]/);
      assert.equal((await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, end_time: '09:00' }] })).status, 400);
      assert.equal((await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, end_date: '2031-08-01' }] })).status, 400); // > 366 days
      assert.equal((await api('POST', `/api/courses/${course.id}/runs`, { runs: [camp] }, OTHER_KEY)).status, 404);
    });
    await check('update run: edit that leaves no sessions is 400', async () => {
      assert.equal((await api('PUT', `/api/courses/runs/${run.id}`, { weekdays: [0, 6] })).status, 400);
      const r = await api('PUT', `/api/courses/runs/${run.id}`, { skip_dates: ['2030-07-03'] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.sessions.length, 4);
      assert.equal((await api('PUT', `/api/courses/runs/${run.id}`, { skip_dates: [] })).status, 200);
    });
    await check('delete run and course with no enrolments', async () => {
      const c = (await api('POST', '/api/courses', { name: 'Throwaway', price: 10 })).body;
      const [rn] = (await api('POST', `/api/courses/${c.id}/runs`, { runs: [camp] })).body;
      assert.equal((await api('DELETE', `/api/courses/runs/${rn.id}`, null, OTHER_KEY)).status, 404);
      assert.equal((await api('DELETE', `/api/courses/runs/${rn.id}`)).status, 204);
      assert.equal((await api('DELETE', `/api/courses/${c.id}`)).status, 204);
      assert.equal((await api('DELETE', `/api/courses/${c.id}`)).status, 404);
    });

    // TASK_3_CHECKS
  } finally {
    const props = [P, Q];
    await pool.query('DELETE FROM course_participant WHERE enrolment_id IN (SELECT id FROM course_enrolment WHERE property_id = ANY($1))', [props]);
    await pool.query('DELETE FROM course_enrolment WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM course_run WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM course WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    server.close();
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: the six Task 1 checks `ok`; Task 2 checks `FAIL` (404s — no `/api/courses` route).

- [ ] **Step 3: Write the controller (courses + runs)**

`src/controllers/courses.js`:

```js
const pool = require('../db');
const { isValidDate, isValidTime } = require('../middleware/validate');
const { sessionDates, ageOn } = require('../lib/courseSessions');

const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isAgeBound = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 120);
const STATUSES = ['active', 'inactive'];
const MAX_RUN_DAYS = 366;

const withSessions = (run) => ({ ...run, sessions: sessionDates(run) });

// Participants on the run's live enrolments -- one seat each.
async function seatsTaken(client, runId) {
  const { rows: [{ n }] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM course_participant cp
     JOIN course_enrolment ce ON ce.id = cp.enrolment_id
     WHERE ce.run_id = $1 AND ce.status != 'cancelled'`, [runId]
  );
  return n;
}

// Locks the run (serialising enrolments and capacity edits on it) and
// share-locks its course (so the course can't be deleted underneath).
async function lockRun(client, runId, propertyId) {
  const { rows: [run] } = await client.query(
    `SELECT cr.*, c.name AS course_name, c.price AS course_price, c.min_age, c.max_age,
            c.status AS course_status, cr.start_date < CURRENT_DATE AS started
     FROM course_run cr JOIN course c ON c.id = cr.course_id
     WHERE cr.id = $1 AND cr.property_id = $2
     FOR UPDATE OF cr FOR SHARE OF c`, [runId, propertyId]
  );
  return run;
}

// 400-message for a course, null when fine. `c` is the full course as it
// would be saved (for updates: current row overlaid with the request).
function courseError(c) {
  if (!c.name || typeof c.name !== 'string' || c.name.length > 100) return 'name is required (at most 100 characters)';
  if (!isMoney(c.price)) return 'price must be a non-negative number';
  if (!isAgeBound(c.min_age) || !isAgeBound(c.max_age)) return 'min_age and max_age must be whole years, or null for no limit';
  if (c.min_age !== null && c.max_age !== null && c.min_age > c.max_age) return "min_age can't be above max_age";
  if (!STATUSES.includes(c.status)) return "status must be 'active' or 'inactive'";
  return null;
}

// Same, for a run.
function runError(r) {
  if (!isValidDate(r.start_date) || !isValidDate(r.end_date)) return 'start_date and end_date must be YYYY-MM-DD';
  if (r.end_date < r.start_date) return 'end_date must be on or after start_date';
  if ((new Date(r.end_date) - new Date(r.start_date)) / 86400000 >= MAX_RUN_DAYS) return `a run can span at most ${MAX_RUN_DAYS} days`;
  if (!Array.isArray(r.weekdays) || !r.weekdays.length || !r.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return 'weekdays must be a non-empty array of 0-6 (0 = Sunday)';
  }
  if (!Array.isArray(r.skip_dates) || !r.skip_dates.every(isValidDate)) return 'skip_dates must be an array of YYYY-MM-DD dates';
  if (!isValidTime(r.start_time) || !isValidTime(r.end_time)) return 'start_time and end_time must be HH:MM';
  if (r.end_time <= r.start_time) return 'end_time must be after start_time';
  if (!Number.isInteger(r.capacity) || r.capacity < 1) return 'capacity must be a positive integer';
  if (r.price !== null && !isMoney(r.price)) return 'price must be a non-negative number, or null for the course price';
  if (!STATUSES.includes(r.status)) return "status must be 'active' or 'inactive'";
  if (!sessionDates(r).length) return 'this run has no sessions -- check weekdays and skip_dates against the dates';
  return null;
}

// ── Courses ───────────────────────────────────────────────────────────────────

async function listCourses(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM course WHERE status = 'active' AND property_id = $1 ORDER BY name", [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createCourse(req, res, next) {
  try {
    const b = req.body;
    const c = { name: b.name, description: b.description ?? null, price: b.price, min_age: b.min_age ?? null, max_age: b.max_age ?? null, status: 'active' };
    const error = courseError(c);
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(
      `INSERT INTO course (property_id, name, description, price, min_age, max_age)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, c.name, c.description, c.price, c.min_age, c.max_age]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

const COURSE_FIELDS = ['name', 'description', 'price', 'min_age', 'max_age', 'status'];

async function updateCourse(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT * FROM course WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]
    );
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Course not found' }); }
    // Merge, then validate the whole: an explicit null on min_age / max_age /
    // description clears it, and the band is checked against the other bound.
    const c = { ...current, price: parseFloat(current.price) };
    for (const f of COURSE_FIELDS) if (f in req.body) c[f] = req.body[f];
    const error = courseError(c);
    if (error) { await client.query('ROLLBACK'); return res.status(400).json({ error }); }
    const { rows } = await client.query(
      `UPDATE course SET name = $1, description = $2, price = $3, min_age = $4, max_age = $5, status = $6
       WHERE id = $7 RETURNING *`,
      [c.name, c.description, c.price, c.min_age, c.max_age, c.status, current.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// Hard delete of a course or one run, with their enrolments. Refuses while
// any run that hasn't ended still has a live enrolment -- cancel those first.
async function hardDelete(req, res, next, kind) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const table = kind === 'course' ? 'course' : 'course_run';
    const { rows: [target] } = await client.query(
      `SELECT id FROM ${table} WHERE id = $1 AND property_id = $2 FOR UPDATE`, [req.params.id, req.property_id]
    );
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: kind === 'course' ? 'Course not found' : 'Run not found' });
    }
    const runFilter = kind === 'course' ? 'cr.course_id = $1' : 'cr.id = $1';
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM course_enrolment ce JOIN course_run cr ON cr.id = ce.run_id
       WHERE ${runFilter} AND ce.status != 'cancelled' AND cr.end_date >= CURRENT_DATE`, [target.id]
    );
    if (n) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${n} enrolment(s) on runs that haven't finished are still active -- cancel them first` });
    }
    // course_participant goes with its enrolment (ON DELETE CASCADE).
    await client.query(`DELETE FROM course_enrolment ce USING course_run cr WHERE cr.id = ce.run_id AND ${runFilter}`, [target.id]);
    await client.query(`DELETE FROM course_run cr WHERE ${runFilter}`, [target.id]);
    if (kind === 'course') await client.query('DELETE FROM course WHERE id = $1', [target.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

const deleteCourse = (req, res, next) => hardDelete(req, res, next, 'course');
const deleteRun = (req, res, next) => hardDelete(req, res, next, 'run');

// ── Runs ──────────────────────────────────────────────────────────────────────

// { runs: [...] } -- all or nothing.
async function createRuns(req, res, next) {
  const { runs } = req.body;
  if (!Array.isArray(runs) || !runs.length) return res.status(400).json({ error: 'runs must be a non-empty array' });
  const full = runs.map((r) => ({ ...r, skip_dates: r.skip_dates ?? [], price: r.price ?? null, status: 'active' }));
  for (const [i, r] of full.entries()) {
    const error = runError(r);
    if (error) return res.status(400).json({ error: `runs[${i}]: ${error}` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [course] } = await client.query(
      'SELECT id FROM course WHERE id = $1 AND property_id = $2 FOR SHARE', [req.params.id, req.property_id]
    );
    if (!course) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Course not found' }); }
    const created = [];
    for (const r of full) {
      const { rows } = await client.query(
        `INSERT INTO course_run (property_id, course_id, start_date, end_date, weekdays, skip_dates, start_time, end_time, capacity, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [req.property_id, course.id, r.start_date, r.end_date, r.weekdays, r.skip_dates, r.start_time, r.end_time, r.capacity, r.price]
      );
      created.push(withSessions(rows[0]));
    }
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

const RUN_FIELDS = ['start_date', 'end_date', 'weekdays', 'skip_dates', 'start_time', 'end_time', 'capacity', 'price', 'status'];

async function updateRun(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT * FROM course_run WHERE id = $1 AND property_id = $2 FOR UPDATE', [req.params.id, req.property_id]
    );
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Run not found' }); }
    // TIME reads back as HH:MM:SS and NUMERIC as a string; normalise so the
    // merged run validates the same way a new one does.
    const r = {
      ...current,
      start_time: current.start_time.slice(0, 5),
      end_time: current.end_time.slice(0, 5),
      price: current.price === null ? null : parseFloat(current.price),
    };
    for (const f of RUN_FIELDS) if (f in req.body) r[f] = req.body[f];
    const error = runError(r);
    if (error) { await client.query('ROLLBACK'); return res.status(400).json({ error }); }
    const taken = await seatsTaken(client, current.id);
    if (r.capacity < taken) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${taken} places are already taken -- capacity can't go below that` });
    }
    const { rows } = await client.query(
      `UPDATE course_run SET start_date = $1, end_date = $2, weekdays = $3, skip_dates = $4, start_time = $5,
         end_time = $6, capacity = $7, price = $8, status = $9
       WHERE id = $10 RETURNING *`,
      [r.start_date, r.end_date, r.weekdays, r.skip_dates, r.start_time, r.end_time, r.capacity, r.price, r.status, current.id]
    );
    await client.query('COMMIT');
    res.json(withSessions(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = {
  listCourses, createCourse, updateCourse, deleteCourse,
  createRuns, updateRun, deleteRun,
};
```

(`ageOn` and `lockRun` are unused until Task 3; leave them in.)

- [ ] **Step 4: Routes, mount, module key**

`src/routes/courses.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/courses');
const { authenticateOrApiKey } = require('../middleware/auth');

// Courses
router.get('/', authenticateOrApiKey, ctrl.listCourses);
router.post('/', authenticateOrApiKey, ctrl.createCourse);
router.put('/:id', authenticateOrApiKey, ctrl.updateCourse);
router.delete('/:id', authenticateOrApiKey, ctrl.deleteCourse);

// Runs
router.post('/:id/runs', authenticateOrApiKey, ctrl.createRuns);
router.put('/runs/:id', authenticateOrApiKey, ctrl.updateRun);
router.delete('/runs/:id', authenticateOrApiKey, ctrl.deleteRun);

module.exports = router;
```

`src/app.js`: after `const toursRoutes = require('./routes/tours');` add `const coursesRoutes = require('./routes/courses');`; after `app.use('/api/tours', toursRoutes);` add `app.use('/api/courses', coursesRoutes);`.

`src/controllers/property.js:17`: add `'courses'` after `'tours'` in `MODULE_KEYS`.

- [ ] **Step 5: Run the checks**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: 13 `ok` lines, `all passed`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/courses.js src/routes/courses.js src/app.js src/controllers/property.js scripts/check-courses.js
git commit -m "Courses: course and run CRUD at /api/courses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Enrolments

**Files:**
- Modify: `src/controllers/courses.js`, `src/routes/courses.js`, `scripts/check-courses.js`

**Interfaces:**
- Consumes: `lockRun`, `seatsTaken`, `ageOn`, `isValidDate` (Tasks 1-2).
- Produces: `POST /api/courses/enrolments` → 201 enrolment row + `participants: [{ id, first_name, date_of_birth }]`; `GET /api/courses/enrolments` → enrolment rows + `start_date, end_date, course_name, participants`; `PUT /api/courses/enrolments/:id`.

- [ ] **Step 1: Add the Task 3 checks**

In `scripts/check-courses.js`, replace `// TASK_3_CHECKS` with:

```js
    // ---- Task 3: enrolments ----
    const kid = (first_name, date_of_birth) => ({ first_name, date_of_birth });
    const enrol = (participants, extra = {}, key) => api('POST', '/api/courses/enrolments',
      { run_id: run.id, contact_name: 'Ana', contact_email: 'ana@example.com', participants, ...extra }, key);
    let first;
    await check('enrol: priced from the course, participants returned', async () => {
      const r = await enrol([kid('Lucia', '2018-07-01'), kid('Mateo', '2019-01-15')]);
      assert.equal(r.status, 201, r.text);
      first = r.body;
      assert.equal(first.total_price, '400.00');
      assert.deepEqual(first.participants.map((p) => p.first_name).sort(), ['Lucia', 'Mateo']);
    });
    await check('enrol: run price overrides course price', async () => {
      const [sat] = (await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, price: 150 }] })).body;
      const r = await api('POST', '/api/courses/enrolments', { run_id: sat.id, contact_name: 'Ana', participants: [kid('Leo', '2019-01-01')] });
      assert.equal(r.body.total_price, '150.00');
      assert.equal((await api('DELETE', `/api/courses/runs/${sat.id}`)).status, 409); // live enrolment
      await api('PUT', `/api/courses/enrolments/${r.body.id}`, { status: 'cancelled' });
      assert.equal((await api('DELETE', `/api/courses/runs/${sat.id}`)).status, 204);
    });
    await check('enrol: supplied total_price wins', async () => {
      const r = await enrol([kid('Sofia', '2019-05-05')], { total_price: 99.5 });
      assert.equal(r.body.total_price, '99.50');
    });
    await check('enrol: age band names the child', async () => {
      const r = await enrol([kid('Lucia', '2018-07-01'), kid('Hugo', '2017-07-01')]);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Hugo is 13/);
    });
    await check('enrol: garbage participants are 400', async () => {
      assert.equal((await enrol([])).status, 400);
      assert.equal((await enrol([kid('', '2019-01-01')])).status, 400);
      assert.equal((await enrol([kid('Ana', '2019-02-30')])).status, 400);
      assert.equal((await enrol([kid('Ana', '2031-01-01')])).status, 400); // born after the course starts
      assert.equal((await enrol([kid('Ana', '2019-01-01')], { contact_name: '' })).status, 400);
      assert.equal((await enrol([kid('Ana', '2019-01-01')], { total_price: -1 })).status, 400);
    });
    await check('enrol: other property gets 404', async () => {
      assert.equal((await enrol([kid('Ana', '2019-01-01')], {}, OTHER_KEY)).status, 404);
      assert.equal((await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'cancelled' }, OTHER_KEY)).status, 404);
      assert.ok(!(await api('GET', '/api/courses/enrolments', null, OTHER_KEY)).body.length);
    });
    await check('seats: 3 taken of 10, 8 more is 409, 7 fits', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => kid(`K${i}`, '2019-01-01'));
      const full = await enrol(eight);
      assert.equal(full.status, 409);
      assert.match(full.body.error, /Only 7 places left/);
      assert.equal((await enrol(eight.slice(0, 7))).status, 201);
    });
    await check('seats: two parents racing for the last place -- one wins', async () => {
      await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'cancelled' }); // frees 2 -> 2 left
      await enrol([kid('Fill', '2019-01-01')]); // 1 left
      const [a, b] = await Promise.all([enrol([kid('A', '2019-01-01')]), enrol([kid('B', '2019-01-01')])]);
      assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    });
    await check('reinstate re-checks seats; capacity cut below taken is 409', async () => {
      const r = await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'confirmed' });
      assert.equal(r.status, 409, r.text); // run is full, Lucia + Mateo don't fit
      assert.equal((await api('PUT', `/api/courses/runs/${run.id}`, { capacity: 5 })).status, 409);
      assert.equal((await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'bogus' })).status, 400);
      assert.equal((await api('PUT', `/api/courses/enrolments/${first.id}`, { notes: 'called back' })).body.notes, 'called back');
    });
    await check('list enrolments: filter by run and status, participants included', async () => {
      const r = await api('GET', `/api/courses/enrolments?run_id=${run.id}&status=cancelled`);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body.length >= 1 && r.body.every((e) => e.status === 'cancelled'));
      assert.ok(r.body.find((e) => e.id === first.id).participants.some((p) => p.date_of_birth === '2018-07-01'));
    });
    await check('started run: 409 without total_price, 201 with it', async () => {
      const [old] = (await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, start_date: '2020-01-06', end_date: '2020-01-10' }] })).body;
      const late = { run_id: old.id, contact_name: 'Ana', participants: [kid('Late', '2010-01-01')] };
      assert.equal((await api('POST', '/api/courses/enrolments', late)).status, 409);
      assert.equal((await api('POST', '/api/courses/enrolments', { ...late, total_price: 50 })).status, 201);
    });
    await check('inactive run is not bookable', async () => {
      const [rn] = (await api('POST', `/api/courses/${course.id}/runs`, { runs: [camp] })).body;
      await api('PUT', `/api/courses/runs/${rn.id}`, { status: 'inactive' });
      assert.equal((await api('POST', '/api/courses/enrolments', { run_id: rn.id, contact_name: 'Ana', participants: [kid('X', '2019-01-01')] })).status, 409);
    });

    // TASK_4_CHECKS
```

- [ ] **Step 2: Run to verify the new checks fail**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: Task 1-2 checks `ok`; Task 3 checks `FAIL` (404 on `/api/courses/enrolments`).

- [ ] **Step 3: Add the enrolment handlers**

In `src/controllers/courses.js`, before `module.exports`:

```js
// ── Enrolments ───────────────────────────────────────────────────────────────

const ageBand = (min, max) => (min !== null && max !== null ? `ages ${min}-${max}` : min !== null ? `ages ${min} and over` : `ages up to ${max}`);

// 400-message for a participant list, null when fine. Ages are checked
// later, against the run's start date.
function participantsError(participants) {
  if (!Array.isArray(participants) || !participants.length) return 'participants must be a non-empty array';
  for (const p of participants) {
    if (!p || typeof p.first_name !== 'string' || !p.first_name.trim() || p.first_name.length > 100) {
      return 'every participant needs a first_name (at most 100 characters)';
    }
    if (!isValidDate(p.date_of_birth)) return `${p.first_name}: date_of_birth must be YYYY-MM-DD`;
  }
  return null;
}

async function createEnrolment(req, res, next) {
  const { run_id, guest_id, contact_name, contact_email, contact_phone, notes, participants, total_price } = req.body;
  if (!run_id || !contact_name || typeof contact_name !== 'string') return res.status(400).json({ error: 'run_id and contact_name are required' });
  const pError = participantsError(participants);
  if (pError) return res.status(400).json({ error: pError });
  if (total_price != null && !isMoney(total_price)) return res.status(400).json({ error: 'total_price must be a non-negative number' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await lockRun(client, run_id, req.property_id);
    if (!run) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Run not found' }); }
    if (run.status !== 'active' || run.course_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This course is not open for booking' });
    }
    if (guest_id) {
      const { rows } = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }
    // Whole course only: a late joiner goes through staff, who set the price.
    if (run.started && total_price == null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This course has already started' });
    }
    for (const p of participants) {
      if (p.date_of_birth > run.start_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${p.first_name}: date_of_birth is after the course starts` });
      }
      const age = ageOn(p.date_of_birth, run.start_date);
      if ((run.min_age !== null && age < run.min_age) || (run.max_age !== null && age > run.max_age)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${p.first_name} is ${age} on ${run.start_date}; this course is for ${ageBand(run.min_age, run.max_age)}` });
      }
    }
    const taken = await seatsTaken(client, run.id);
    if (taken + participants.length > run.capacity) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${Math.max(run.capacity - taken, 0)} places left` });
    }

    const price = total_price ?? parseFloat(run.price ?? run.course_price) * participants.length;
    const { rows: [enrolment] } = await client.query(
      `INSERT INTO course_enrolment (property_id, run_id, guest_id, contact_name, contact_email, contact_phone, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.property_id, run.id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, price.toFixed(2), notes ?? null]
    );
    const { rows: people } = await client.query(
      `INSERT INTO course_participant (enrolment_id, first_name, date_of_birth)
       SELECT $1::uuid, * FROM unnest($2::text[], $3::date[])
       RETURNING id, first_name, date_of_birth`,
      [enrolment.id, participants.map((p) => p.first_name.trim()), participants.map((p) => p.date_of_birth)]
    );
    await client.query('COMMIT');
    res.status(201).json({ ...enrolment, participants: people });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function listEnrolments(req, res, next) {
  try {
    const { run_id, status, guest_id } = req.query;
    let query = `
      SELECT ce.*, cr.start_date, cr.end_date, c.name AS course_name,
             COALESCE(json_agg(json_build_object('id', cp.id, 'first_name', cp.first_name, 'date_of_birth', cp.date_of_birth)
                      ORDER BY cp.first_name) FILTER (WHERE cp.id IS NOT NULL), '[]') AS participants
      FROM course_enrolment ce
      JOIN course_run cr ON cr.id = ce.run_id
      JOIN course c ON c.id = cr.course_id
      LEFT JOIN course_participant cp ON cp.enrolment_id = ce.id
      WHERE ce.property_id = $1
    `;
    const params = [req.property_id];
    if (run_id) { params.push(run_id); query += ` AND ce.run_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND ce.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND ce.guest_id = $${params.length}`; }
    query += ' GROUP BY ce.id, cr.id, c.id ORDER BY cr.start_date, ce.created_at';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

const ENROLMENT_STATUSES = ['confirmed', 'cancelled'];

async function updateEnrolment(req, res, next) {
  const { status, notes } = req.body;
  if (status != null && !ENROLMENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be 'confirmed' or 'cancelled'" });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [found] } = await client.query(
      'SELECT run_id FROM course_enrolment WHERE id = $1 AND property_id = $2', [req.params.id, req.property_id]
    );
    if (!found) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Enrolment not found' }); }
    // Run first, then the enrolment: the same order as createEnrolment and
    // run deletes, so these can't deadlock each other.
    const run = await lockRun(client, found.run_id, req.property_id);
    const { rows: [current] } = await client.query(
      'SELECT status FROM course_enrolment WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    // Reinstating a cancelled enrolment takes its places back.
    if (current.status === 'cancelled' && status === 'confirmed') {
      const { rows: [{ n }] } = await client.query('SELECT COUNT(*)::int AS n FROM course_participant WHERE enrolment_id = $1', [req.params.id]);
      const taken = await seatsTaken(client, run.id);
      if (taken + n > run.capacity) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Only ${Math.max(run.capacity - taken, 0)} places left` });
      }
    }
    const { rows } = await client.query(
      'UPDATE course_enrolment SET status = COALESCE($1, status), notes = COALESCE($2, notes) WHERE id = $3 RETURNING *',
      [status ?? null, notes ?? null, req.params.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```

Extend `module.exports` with `createEnrolment, listEnrolments, updateEnrolment`.

- [ ] **Step 4: Routes**

In `src/routes/courses.js`, add **above** the `// Courses` block (so `/enrolments` is never taken for `/:id`):

```js
// Enrolments
router.get('/enrolments', authenticateOrApiKey, ctrl.listEnrolments);
router.post('/enrolments', authenticateOrApiKey, ctrl.createEnrolment);
router.put('/enrolments/:id', authenticateOrApiKey, ctrl.updateEnrolment);
```

- [ ] **Step 5: Run the checks**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: 25 `ok` lines, `all passed`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/courses.js src/routes/courses.js scripts/check-courses.js
git commit -m "Courses: enrolments with age bands, seat locking and minimal participants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Search and roster

**Files:**
- Modify: `src/controllers/courses.js`, `src/routes/courses.js`, `scripts/check-courses.js`

**Interfaces:**
- Consumes: `withSessions`, `ageOn`, `isValidDate`.
- Produces: `GET /api/courses/runs/search?from=&to=&age=&course_id=` → `[{ id, course_id, start_date, end_date, weekdays, skip_dates, start_time, end_time, capacity, status, price, seats_left, course_name, description, min_age, max_age, sessions }]`; `GET /api/courses/runs/:id/roster` → `{ run: { ...run, course_name, sessions }, participants: [{ id, first_name, age, enrolment_id, contact_name, contact_email, contact_phone }] }`.

- [ ] **Step 1: Add the Task 4 checks**

In `scripts/check-courses.js`, replace `// TASK_4_CHECKS` with:

```js
    // ---- Task 4: search and roster ----
    await check('search: seats_left, effective price, sessions; age filter', async () => {
      const r = await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02');
      assert.equal(r.status, 200, r.text);
      const hit = r.body.find((x) => x.id === run.id);
      assert.equal(hit.seats_left, 0);
      assert.equal(hit.price, '200.00');
      assert.equal(hit.sessions.length, 5);
      assert.ok(!r.body.some((x) => x.start_date === '2030-09-07')); // starts outside [from, to)
      assert.ok(!(await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02&age=14')).body.some((x) => x.id === run.id));
      assert.ok((await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02&age=12')).body.some((x) => x.id === run.id));
    });
    await check('search: bad input is 400', async () => {
      assert.equal((await api('GET', '/api/courses/runs/search?from=2030-07-01')).status, 400);
      assert.equal((await api('GET', '/api/courses/runs/search?from=2030-07-02&to=2030-07-01')).status, 400);
      assert.equal((await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02&age=x')).status, 400);
    });
    await check('roster: live participants with ages; other property 404', async () => {
      const r = await api('GET', `/api/courses/runs/${run.id}/roster`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.participants.length, 10);
      assert.ok(!r.body.participants.some((p) => p.first_name === 'Lucia')); // her enrolment is cancelled
      assert.equal(r.body.participants.find((p) => p.first_name === 'Sofia').age, 11);
      assert.equal(r.body.run.sessions.length, 5);
      assert.equal((await api('GET', `/api/courses/runs/${run.id}/roster`, null, OTHER_KEY)).status, 404);
    });
```

- [ ] **Step 2: Run to verify the new checks fail**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: Task 1-3 checks `ok`; Task 4 checks `FAIL`.

- [ ] **Step 3: Add the handlers**

In `src/controllers/courses.js`, before `module.exports`:

```js
// ── Search and roster ────────────────────────────────────────────────────────

// Runs starting in [from, to), with places left and the price to charge.
// Full runs are included (seats_left 0) so a site can show "full".
async function searchRuns(req, res, next) {
  try {
    const { from, to, age, course_id } = req.query;
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'from and to are required, YYYY-MM-DD' });
    if (to <= from) return res.status(400).json({ error: 'to must be after from' });
    if (age != null && !/^\d{1,3}$/.test(age)) return res.status(400).json({ error: 'age must be a whole number' });
    let query = `
      SELECT cr.id, cr.course_id, cr.start_date, cr.end_date, cr.weekdays, cr.skip_dates, cr.start_time, cr.end_time,
             cr.capacity, cr.status, COALESCE(cr.price, c.price) AS price,
             cr.capacity - (SELECT COUNT(*)::int FROM course_participant cp JOIN course_enrolment ce ON ce.id = cp.enrolment_id
                            WHERE ce.run_id = cr.id AND ce.status != 'cancelled') AS seats_left,
             c.name AS course_name, c.description, c.min_age, c.max_age
      FROM course_run cr JOIN course c ON c.id = cr.course_id
      WHERE cr.property_id = $1 AND cr.status = 'active' AND c.status = 'active'
        AND cr.start_date >= $2 AND cr.start_date < $3
    `;
    const params = [req.property_id, from, to];
    if (course_id) { params.push(course_id); query += ` AND cr.course_id = $${params.length}`; }
    if (age != null) {
      params.push(parseInt(age, 10));
      query += ` AND (c.min_age IS NULL OR c.min_age <= $${params.length}) AND (c.max_age IS NULL OR c.max_age >= $${params.length})`;
    }
    query += ' ORDER BY cr.start_date, cr.start_time, c.name';
    const { rows } = await pool.query(query, params);
    res.json(rows.map(withSessions));
  } catch (err) { next(err); }
}

// Who's coming: everyone on the run's live enrolments, age as of the start.
async function getRoster(req, res, next) {
  try {
    const { rows: [run] } = await pool.query(
      `SELECT cr.*, c.name AS course_name FROM course_run cr JOIN course c ON c.id = cr.course_id
       WHERE cr.id = $1 AND cr.property_id = $2`, [req.params.id, req.property_id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const { rows } = await pool.query(
      `SELECT cp.id, cp.first_name, cp.date_of_birth, ce.id AS enrolment_id, ce.contact_name, ce.contact_email, ce.contact_phone
       FROM course_participant cp JOIN course_enrolment ce ON ce.id = cp.enrolment_id
       WHERE ce.run_id = $1 AND ce.status != 'cancelled'
       ORDER BY cp.first_name`, [run.id]
    );
    const participants = rows.map(({ date_of_birth, ...p }) => ({ ...p, age: ageOn(date_of_birth, run.start_date) }));
    res.json({ run: withSessions(run), participants });
  } catch (err) { next(err); }
}
```

Extend `module.exports` with `searchRuns, getRoster`.

- [ ] **Step 4: Routes**

In `src/routes/courses.js`, inside the `// Runs` block, add **before** `router.put('/runs/:id', …)`:

```js
router.get('/runs/search', authenticateOrApiKey, ctrl.searchRuns);
router.get('/runs/:id/roster', authenticateOrApiKey, ctrl.getRoster);
```

- [ ] **Step 5: Run the checks**

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: 28 `ok` lines, `all passed`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/courses.js src/routes/courses.js scripts/check-courses.js
git commit -m "Courses: run search with places left, and per-run roster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Swagger, final run, live-DB handoff

**Files:**
- Modify: `src/docs/swagger.js` (tag list near line 30; paths after the tours block ending ~line 554; description string line 9)

- [ ] **Step 1: Add the docs**

Line 9: change `tours, equipment hire, and golf` to `tours, courses, equipment hire, and golf`.

Tag list: add `{ name: 'Courses' },` after `{ name: 'Tours' },`.

After the last `'/api/tours/...'` path entry, add:

```js
    // ── Courses ──────────────────────────────────────────────────────────────
    '/api/courses': {
      get: { tags: ['Courses'], summary: 'List active courses', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of courses' } } },
      post: { tags: ['Courses'], summary: 'Create course', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number', description: 'Per participant, whole course' }, min_age: { type: 'integer', nullable: true }, max_age: { type: 'integer', nullable: true } } } } } }, responses: { 201: { description: 'Created' }, 400: { description: 'Invalid input' } } },
    },
    '/api/courses/{id}': {
      put: { tags: ['Courses'], summary: 'Update course. null clears min_age / max_age.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string', nullable: true }, price: { type: 'number' }, min_age: { type: 'integer', nullable: true }, max_age: { type: 'integer', nullable: true }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 400: { description: 'Invalid input' }, 404: { description: 'Course not found' } } },
      delete: { tags: ['Courses'], summary: 'Permanently delete a course with its runs and enrolments. 409 while a run that hasn\'t finished has an active enrolment.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Deleted' }, 404: { description: 'Course not found' }, 409: { description: 'Active enrolments' } } },
    },
    '/api/courses/{id}/runs': {
      post: { tags: ['Courses'], summary: 'Create dated runs of a course (all or nothing). Sessions are every date from start_date to end_date on one of weekdays, minus skip_dates.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['runs'], properties: { runs: { type: 'array', items: { type: 'object', required: ['start_date', 'end_date', 'weekdays', 'start_time', 'end_time', 'capacity'], properties: { start_date: { type: 'string', format: 'date' }, end_date: { type: 'string', format: 'date', description: 'Inclusive; at most 366 days after start_date' }, weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0 = Sunday' }, skip_dates: { type: 'array', items: { type: 'string', format: 'date' } }, start_time: { type: 'string', example: '10:00' }, end_time: { type: 'string', example: '14:00' }, capacity: { type: 'integer' }, price: { type: 'number', nullable: true, description: 'Per participant; omit for the course price' } } } } } } } } }, responses: { 201: { description: 'Created runs, each with sessions' }, 400: { description: 'Invalid run (error names the index)' }, 404: { description: 'Course not found' } } },
    },
    '/api/courses/runs/{id}': {
      put: { tags: ['Courses'], summary: 'Update a run. 409 if capacity would drop below places taken.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { start_date: { type: 'string', format: 'date' }, end_date: { type: 'string', format: 'date' }, weekdays: { type: 'array', items: { type: 'integer' } }, skip_dates: { type: 'array', items: { type: 'string', format: 'date' } }, start_time: { type: 'string' }, end_time: { type: 'string' }, capacity: { type: 'integer' }, price: { type: 'number', nullable: true }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated run with sessions' }, 400: { description: 'Invalid input' }, 404: { description: 'Run not found' }, 409: { description: 'Capacity below places taken' } } },
      delete: { tags: ['Courses'], summary: 'Permanently delete a run and its enrolments. 409 while it hasn\'t finished and has an active enrolment.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Deleted' }, 404: { description: 'Run not found' }, 409: { description: 'Active enrolments' } } },
    },
    '/api/courses/runs/search': {
      get: { tags: ['Courses'], summary: 'Runs starting in [from, to), with places left (full runs included), effective price and session dates', security: [{ bearerAuth: [] }], parameters: [{ name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' }, description: 'Exclusive' }, { name: 'age', in: 'query', schema: { type: 'integer' }, description: 'Only courses whose age band includes this age' }, { name: 'course_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of runs' }, 400: { description: 'Invalid input' } } },
    },
    '/api/courses/runs/{id}/roster': {
      get: { tags: ['Courses'], summary: 'Participants on a run\'s active enrolments, with age on the start date and the booker\'s contact details', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: '{ run, participants }' }, 404: { description: 'Run not found' } } },
    },
    '/api/courses/enrolments': {
      get: { tags: ['Courses'], summary: 'List enrolments with participants', security: [{ bearerAuth: [] }], parameters: [{ name: 'run_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['confirmed', 'cancelled'] } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of enrolments' } } },
      post: { tags: ['Courses'], summary: 'Enrol participants on a whole run. OTA records total_price but takes no payment. Only first name and birth date are stored per participant.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['run_id', 'contact_name', 'participants'], properties: { run_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' }, total_price: { type: 'number', description: 'Overrides price x participants; required to enrol on a run that has already started' }, participants: { type: 'array', items: { type: 'object', required: ['first_name', 'date_of_birth'], properties: { first_name: { type: 'string' }, date_of_birth: { type: 'string', format: 'date' } } } } } } } } }, responses: { 201: { description: 'Enrolment with participants' }, 400: { description: 'Invalid input, or a participant outside the age band' }, 404: { description: 'Run or guest not found' }, 409: { description: 'Not enough places, run inactive, or already started' } } },
    },
    '/api/courses/enrolments/{id}': {
      put: { tags: ['Courses'], summary: 'Cancel or reinstate an enrolment, or edit notes. Reinstating re-checks places.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['confirmed', 'cancelled'] }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 400: { description: 'Invalid status' }, 404: { description: 'Enrolment not found' }, 409: { description: 'Not enough places to reinstate' } } },
    },
```

- [ ] **Step 2: Verify the docs load and checks still pass**

Run: `node -e "const s=require('./src/docs/swagger');console.log(Object.keys(s.paths).filter(p=>p.startsWith('/api/courses')).length)"`
Expected: `8`

Run: `node -r dotenv/config scripts/check-courses.js`
Expected: 28 `ok` lines, `all passed`.

Also run the existing tours-adjacent check to confirm the `isValidDate` / `DATE[]` changes broke nothing: `node -r dotenv/config scripts/check-review-requests.js` — expected `all passed`.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Courses: API docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Ask the user** before applying the migration to the live DB (`node scripts/run-migration.js src/db/migrate-2026-10-15-courses.sql` — applies to local and `DATABASE_URL_LIVE`; local is already done and it's idempotent) and before `git push`. The migration must reach the live DB **before** the push, or every `/api/courses` call 500s on missing tables. Nothing else depends on it at boot.
