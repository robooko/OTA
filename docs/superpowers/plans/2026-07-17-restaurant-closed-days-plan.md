# Restaurant Closed Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each restaurant declare a set of recurring closed weekdays, have availability search and reservation creation both respect it, and seed Bonito as closed on Sundays — per `docs/superpowers/specs/2026-07-17-restaurant-closed-days-design.md`.

**Architecture:** One `closed_days SMALLINT[]` column on `restaurant` (ISO day-of-week values, 1=Monday…7=Sunday). Availability search excludes closed weekdays at the SQL level (a `WHERE` filter in the `candidate_dates` CTE); reservation creation rejects a closed-weekday `reservation_date` in JS before the existing service-hours check. Restaurant CRUD accepts and validates the new field.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- No migrations tool exists — `schema.sql` is edited in place and applied to a **freshly reset** dev database (drop/recreate). Do not write ALTER TABLE migrations as a separate file; the reset+reapply cycle is how this project rolls out schema changes.
- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, or a `psql`/`node` query — each with the exact expected output.
- Two databases must be reset when rolling this out: the local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance, which is what the live deployed service (`https://ota-u6ii.onrender.com`) actually uses.
- `closed_days` values are ISO day-of-week integers, `1`=Monday…`7`=Sunday (matching Postgres's `EXTRACT(ISODOW FROM date)`). Reject anything outside `1..7`.
- This feature is restaurant-module only — do not touch golf, spa, tours, or beach club.
- No holiday/exception-date overrides — pure recurring weekday pattern only (see spec's Non-goals).
- Closed dates are simply omitted from the availability search response — no `closed: true` flag or other shape change.
- Today's date for choosing test dates in this plan: **2026-07-17 (Friday)**. `2026-07-19` is the next Sunday, `2026-07-18` the preceding Saturday, `2026-07-20` the following Monday.

---

### Task 1: Add `closed_days` column to `restaurant`, seed Bonito closed on Sundays

**Files:**
- Modify: `src/db/schema.sql:153-163` (`restaurant` table definition)
- Modify: `src/db/seed-restaurant-bonito.sql:11-20` (Bonito's INSERT)

**Interfaces:**
- Produces: `restaurant(closed_days)` — a `SMALLINT[]` column, `NOT NULL DEFAULT '{}'`. Task 2 and Task 3's SQL/JS read this column; Task 4's controller code writes it.

- [ ] **Step 1: Add the column**

In `src/db/schema.sql`, replace:
```sql
CREATE TABLE IF NOT EXISTS restaurant (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      VARCHAR(100) NOT NULL,
  description               TEXT,
  phone                     VARCHAR(30),
  service_start             TIME         NOT NULL,
  service_end               TIME         NOT NULL,
  slot_interval_minutes     INT          NOT NULL DEFAULT 15,
  default_duration_minutes  INT          NOT NULL,
  created_at                TIMESTAMPTZ DEFAULT now()
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS restaurant (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      VARCHAR(100) NOT NULL,
  description               TEXT,
  phone                     VARCHAR(30),
  service_start             TIME         NOT NULL,
  service_end               TIME         NOT NULL,
  slot_interval_minutes     INT          NOT NULL DEFAULT 15,
  default_duration_minutes  INT          NOT NULL,
  closed_days               SMALLINT[]   NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ DEFAULT now()
);
```

- [ ] **Step 2: Seed Bonito as closed on Sundays**

In `src/db/seed-restaurant-bonito.sql`, replace:
```sql
WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Bonito',
    'Bonito''s signature restaurant, serving fresh local produce with seasonal tasting menus.',
    '+1-555-0199',
    '19:00', '22:30', 15, 90
  )
  RETURNING id
)
```
with:
```sql
WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, closed_days)
  VALUES (
    'Bonito',
    'Bonito''s signature restaurant, serving fresh local produce with seasonal tasting menus.',
    '+1-555-0199',
    '19:00', '22:30', 15, 90, '{7}'
  )
  RETURNING id
)
```

- [ ] **Step 3: Reset local dev DB and verify**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `done`, no errors.

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  const col = await client.query(\"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'restaurant' AND column_name = 'closed_days'\");
  console.log(col.rows);
  const bonito = await client.query(\"SELECT name, closed_days FROM restaurant WHERE name = 'Bonito'\");
  console.log(bonito.rows);
  await client.end();
})();
"
```
Expected: first line `[ { column_name: 'closed_days', data_type: 'ARRAY' } ]`; second line `[ { name: 'Bonito', closed_days: [ 7 ] } ]`.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql src/db/seed-restaurant-bonito.sql
git commit -m "Add closed_days column to restaurant and seed Bonito closed on Sundays"
```

---

### Task 2: Exclude closed weekdays from availability search

**Files:**
- Modify: `src/controllers/restaurant.js` (`searchAvailability`'s query, originally lines 128-169)

**Interfaces:**
- Consumes: `restaurant.closed_days` from Task 1.
- Produces: no change to `searchAvailability`'s exported behavior/shape — closed dates are simply absent from the response array, same as any date with zero available slots.

- [ ] **Step 1: Filter closed weekdays out of `candidate_dates`**

Replace:
```js
    const { rows } = await pool.query(
      `WITH r AS (
         SELECT service_start, service_end, slot_interval_minutes, default_duration_minutes
         FROM restaurant WHERE id = $1
       ),
       candidate_times AS (
         SELECT generate_series(
           DATE '2000-01-01' + r.service_start,
           DATE '2000-01-01' + r.service_end - (r.default_duration_minutes || ' minutes')::interval,
           (r.slot_interval_minutes || ' minutes')::interval
         )::time AS start_time
         FROM r
       ),
       candidate_dates AS (
         SELECT generate_series($2::date, $3::date, '1 day')::date AS reservation_date
       )
       SELECT
         to_char(cd.reservation_date, 'YYYY-MM-DD') AS reservation_date,
         ct.start_time,
         rt.location,
         COUNT(rt.id) AS available_tables
       FROM candidate_dates cd
       CROSS JOIN candidate_times ct
       CROSS JOIN restaurant_table rt
       WHERE rt.restaurant_id = $1
         AND rt.status = 'active'
         AND rt.seats >= $4
         AND ($5::varchar IS NULL OR rt.location = $5)
         AND NOT EXISTS (
           SELECT 1 FROM restaurant_reservation rr
           CROSS JOIN r
           WHERE rr.table_id = rt.id
             AND rr.reservation_date = cd.reservation_date
             AND rr.status != 'cancelled'
             AND rr.start_time < ct.start_time + (r.default_duration_minutes || ' minutes')::interval
             AND rr.end_time   > ct.start_time
         )
       GROUP BY cd.reservation_date, ct.start_time, rt.location
       HAVING COUNT(rt.id) > 0
       ORDER BY cd.reservation_date, ct.start_time, rt.location`,
      [restaurant_id, from, to, partySize, location ?? null]
    );
```
with:
```js
    const { rows } = await pool.query(
      `WITH r AS (
         SELECT service_start, service_end, slot_interval_minutes, default_duration_minutes, closed_days
         FROM restaurant WHERE id = $1
       ),
       candidate_times AS (
         SELECT generate_series(
           DATE '2000-01-01' + r.service_start,
           DATE '2000-01-01' + r.service_end - (r.default_duration_minutes || ' minutes')::interval,
           (r.slot_interval_minutes || ' minutes')::interval
         )::time AS start_time
         FROM r
       ),
       candidate_dates AS (
         SELECT gs::date AS reservation_date
         FROM generate_series($2::date, $3::date, '1 day') AS gs
         CROSS JOIN r
         WHERE NOT (EXTRACT(ISODOW FROM gs)::int = ANY(r.closed_days))
       )
       SELECT
         to_char(cd.reservation_date, 'YYYY-MM-DD') AS reservation_date,
         ct.start_time,
         rt.location,
         COUNT(rt.id) AS available_tables
       FROM candidate_dates cd
       CROSS JOIN candidate_times ct
       CROSS JOIN restaurant_table rt
       WHERE rt.restaurant_id = $1
         AND rt.status = 'active'
         AND rt.seats >= $4
         AND ($5::varchar IS NULL OR rt.location = $5)
         AND NOT EXISTS (
           SELECT 1 FROM restaurant_reservation rr
           CROSS JOIN r
           WHERE rr.table_id = rt.id
             AND rr.reservation_date = cd.reservation_date
             AND rr.status != 'cancelled'
             AND rr.start_time < ct.start_time + (r.default_duration_minutes || ' minutes')::interval
             AND rr.end_time   > ct.start_time
         )
       GROUP BY cd.reservation_date, ct.start_time, rt.location
       HAVING COUNT(rt.id) > 0
       ORDER BY cd.reservation_date, ct.start_time, rt.location`,
      [restaurant_id, from, to, partySize, location ?? null]
    );
```

- [ ] **Step 2: Verify** (server running against the DB reset in Task 1)

```bash
npm run dev
```
Expected: `Server running on port 3000`, no errors. Leave it running for the curl checks below (use a second terminal, or background it).

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-18&to=2026-07-20&party_size=2"
```
Expected: `200`, a JSON array with entries for `"date":"2026-07-18"` (Saturday) and `"date":"2026-07-20"` (Monday), each with a non-empty `slots` array — but **no entry at all** for `"date":"2026-07-19"` (Sunday, Bonito's closed day).

- [ ] **Step 3: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Exclude closed weekdays from restaurant availability search"
```

---

### Task 3: Reject reservation creation on closed weekdays

**Files:**
- Modify: `src/controllers/restaurant.js` (top helper section, originally lines 4-10; `createReservation`, originally lines 221-298)

**Interfaces:**
- Consumes: `restaurant.closed_days` from Task 1 (as a plain JS array of numbers — `pg` parses `SMALLINT[]` natively, no custom type parser involved).
- Produces: `isoDayOfWeek(dateStr: string): number` (1=Monday…7=Sunday) — a new local helper in `restaurant.js`, used only by `createReservation`. New `400` error case: `{ error: "Restaurant is closed on this day" }`.

- [ ] **Step 1: Add the `isoDayOfWeek` helper**

Replace:
```js
function addMinutesToTime(timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
```
with:
```js
function addMinutesToTime(timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function isoDayOfWeek(dateStr) {
  const jsDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}
```

- [ ] **Step 2: Reject closed-weekday reservations before the service-hours check**

Replace:
```js
    const restaurantRes = await client.query('SELECT * FROM restaurant WHERE id = $1', [restaurant_id]);
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantRes.rows[0];
    const serviceStart = restaurant.service_start.slice(0, 5);
    const serviceEnd = restaurant.service_end.slice(0, 5);
    const end_time = addMinutesToTime(start_time, restaurant.default_duration_minutes);

    if (start_time < serviceStart || end_time > serviceEnd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'start_time is outside service hours' });
    }
```
with:
```js
    const restaurantRes = await client.query('SELECT * FROM restaurant WHERE id = $1', [restaurant_id]);
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantRes.rows[0];

    if (restaurant.closed_days.includes(isoDayOfWeek(reservation_date))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restaurant is closed on this day' });
    }

    const serviceStart = restaurant.service_start.slice(0, 5);
    const serviceEnd = restaurant.service_end.slice(0, 5);
    const end_time = addMinutesToTime(start_time, restaurant.default_duration_minutes);

    if (start_time < serviceStart || end_time > serviceEnd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'start_time is outside service hours' });
    }
```

- [ ] **Step 3: Verify** (server running against the DB reset in Task 1; restart it to pick up Task 2 + this step's changes if it's still running from Task 2)

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-19","start_time":"19:00","party_size":2,"contact_name":"Sunday Test"}'
```
Expected: `400`, body `{"error":"Restaurant is closed on this day"}`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:00","party_size":2,"contact_name":"Monday Test"}'
```
Expected: `201`, body includes `"reservation_date":"2026-07-20"` — confirms the closed-day check doesn't false-positive on an open day.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Reject reservations on a restaurant's closed weekdays"
```

---

### Task 4: Restaurant CRUD accepts and validates `closed_days`

**Files:**
- Modify: `src/controllers/restaurant.js` (top helper section, after Task 3's `isoDayOfWeek`; `createRestaurant`, originally lines 29-42; `updateRestaurant`, originally lines 44-62)

**Interfaces:**
- Consumes: `restaurant.closed_days` column from Task 1.
- Produces: `isValidClosedDays(arr): boolean` — a new local helper in `restaurant.js`. New `400` error case: `{ error: "closed_days must contain integers between 1 and 7" }` on both create and update.

- [ ] **Step 1: Add the `isValidClosedDays` helper**

Replace:
```js
function isoDayOfWeek(dateStr) {
  const jsDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}
```
with:
```js
function isoDayOfWeek(dateStr) {
  const jsDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function isValidClosedDays(arr) {
  return Array.isArray(arr) && arr.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}
```

- [ ] **Step 2: Accept and validate `closed_days` on create**

Replace:
```js
async function createRestaurant(req, res, next) {
  try {
    const { name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes } = req.body;
    if (!name || !service_start || !service_end || !default_duration_minutes) {
      return res.status(400).json({ error: 'name, service_start, service_end, and default_duration_minutes are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, description ?? null, phone ?? null, service_start, service_end, slot_interval_minutes ?? 15, default_duration_minutes]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function createRestaurant(req, res, next) {
  try {
    const { name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, closed_days } = req.body;
    if (!name || !service_start || !service_end || !default_duration_minutes) {
      return res.status(400).json({ error: 'name, service_start, service_end, and default_duration_minutes are required' });
    }
    if (closed_days !== undefined && !isValidClosedDays(closed_days)) {
      return res.status(400).json({ error: 'closed_days must contain integers between 1 and 7' });
    }
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, closed_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, description ?? null, phone ?? null, service_start, service_end, slot_interval_minutes ?? 15, default_duration_minutes, closed_days ?? []]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 3: Accept and validate `closed_days` on update**

Replace:
```js
async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         phone                    = COALESCE($3, phone),
         service_start            = COALESCE($4, service_start),
         service_end              = COALESCE($5, service_end),
         slot_interval_minutes    = COALESCE($6, slot_interval_minutes),
         default_duration_minutes = COALESCE($7, default_duration_minutes)
       WHERE id = $8 RETURNING *`,
      [name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, closed_days } = req.body;
    if (closed_days !== undefined && !isValidClosedDays(closed_days)) {
      return res.status(400).json({ error: 'closed_days must contain integers between 1 and 7' });
    }
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         phone                    = COALESCE($3, phone),
         service_start            = COALESCE($4, service_start),
         service_end              = COALESCE($5, service_end),
         slot_interval_minutes    = COALESCE($6, slot_interval_minutes),
         default_duration_minutes = COALESCE($7, default_duration_minutes),
         closed_days              = COALESCE($8, closed_days)
       WHERE id = $9 RETURNING *`,
      [name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes, closed_days, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 4: Verify** (server running against the DB reset in Task 1; restart to pick up all changes so far)

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"name":"Test Grill","service_start":"12:00","service_end":"14:00","default_duration_minutes":60,"closed_days":[3]}'
```
Expected: `201`, response includes `"closed_days":[3]`. Note the returned `id` as `TEST_RID` for the next two checks.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"name":"Bad Restaurant","service_start":"12:00","service_end":"14:00","default_duration_minutes":60,"closed_days":[0]}'
```
Expected: `400`, body `{"error":"closed_days must contain integers between 1 and 7"}`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/restaurant/$TEST_RID" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"closed_days":[1,7]}'
```
(Replace `$TEST_RID` with the id captured above.) Expected: `200`, response includes `"closed_days":[1,7]`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/restaurant/$TEST_RID" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"closed_days":[8]}'
```
Expected: `400`, body `{"error":"closed_days must contain integers between 1 and 7"}`.

Finally, confirm an updated `closed_days` actually changes search results (not just the stored row) — using Bonito, since `Test Grill` has no tables and would show empty search results regardless of `closed_days`:

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/restaurant/$RID" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"closed_days":[1,7]}'

curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-18&to=2026-07-21&party_size=2"
```
Expected: the PUT returns `200` with `"closed_days":[1,7]`; the search response now has entries only for `2026-07-18` (Saturday) and `2026-07-21` (Tuesday) — both `2026-07-19` (Sunday) and the newly-closed `2026-07-20` (Monday) are absent. (Bonito's `closed_days` reverts to `{7}` in Task 6's full reseed, so this mutation doesn't leak into later verification.)

- [ ] **Step 5: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Accept and validate closed_days on restaurant create/update"
```

---

### Task 5: Document `closed_days` in Swagger docs

**Files:**
- Modify: `src/docs/swagger.js:269-274` (`/api/restaurant` POST and `/api/restaurant/{id}` PUT schemas)

**Interfaces:**
- Consumes: nothing from prior tasks (documentation only).
- Produces: docs matching Task 4's request shape.

- [ ] **Step 1: Add `closed_days` to the create-restaurant request schema**

Replace:
```js
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'service_start', 'service_end', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 } } } } } }, responses: { 201: { description: 'Created' } } },
```
with:
```js
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'service_start', 'service_end', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [7] } } } } } }, responses: { 201: { description: 'Created' } } },
```

- [ ] **Step 2: Add `closed_days` to the update-restaurant request schema**

Replace:
```js
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' } } } } } }, responses: { 200: { description: 'Updated' } } },
```
with:
```js
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [1, 7] } } } } } }, responses: { 200: { description: 'Updated' } } },
```

- [ ] **Step 3: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log(Object.keys(j.paths['/api/restaurant'].post.requestBody.content['application/json'].schema.properties));
  console.log(Object.keys(j.paths['/api/restaurant/{id}'].put.requestBody.content['application/json'].schema.properties));
});
"
```
Expected: both printed arrays include `'closed_days'`.

- [ ] **Step 4: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document closed_days in restaurant Swagger docs"
```

---

### Task 6: Full reset, reseed, and live verification (local + remote)

**Files:** none (verification only — no code changes).

**Interfaces:** none.

- [ ] **Step 1: Full reset and reseed — local**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
npm run dev
```
Expected: `done`, then `Server running on port 3000` with no errors.

- [ ] **Step 2: End-to-end closed-day check against the fresh local DB**

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-18&to=2026-07-20&party_size=2"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-19","start_time":"19:00","party_size":2,"contact_name":"Final Sunday Check"}'

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:00","party_size":2,"contact_name":"Final Monday Check"}'
```
Expected: the search response has entries for `2026-07-18` and `2026-07-20` but not `2026-07-19`; the Sunday POST returns `400 "Restaurant is closed on this day"`; the Monday POST returns `201`.

- [ ] **Step 3: Repeat the reset against the remote `otadb` instance**

Confirm with the user before running this against the live database, per this project's established practice for any schema reset against `otadb`.

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({
    connectionString: 'postgresql://otadb_user:MRBEK2ocVbd2qFUqLGLcAZjYWoQE7SsE@dpg-d9a98smrnols739u2oc0-a.virginia-postgres.render.com/otadb',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `done`, no errors.

- [ ] **Step 4: Push to origin and confirm the live service picks up the change**

Confirm with the user before pushing to `origin/main`, per this project's established practice for any push that triggers a live Render redeploy.

```bash
git push origin main
```
Wait for Render to finish redeploying (poll `https://ota-u6ii.onrender.com/api/docs.json` until its `/api/restaurant` `post.requestBody...properties` includes `closed_days`), then:

```bash
RID_LIVE=$(curl -s https://ota-u6ii.onrender.com/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/availability/search?from=2026-07-18&to=2026-07-20&party_size=2"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-19","start_time":"19:00","party_size":2,"contact_name":"Live Sunday Check"}'
```
Expected: the search response has no entry for `2026-07-19`; the POST returns `400 "Restaurant is closed on this day"`.

- [ ] **Step 5: No commit needed** — this task is verification-only. If any step's actual output didn't match, go back to the relevant earlier task and fix it before considering this feature done.
