# Restaurant Multi-Window Service Periods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-window `restaurant.service_start`/`service_end` columns with a `service_period` table supporting any number of daily windows per restaurant, migrate the 4 existing restaurants in place (no data loss), and seed BBYC with its real lunch+dinner windows — per `docs/superpowers/specs/2026-07-19-restaurant-service-periods-design.md`.

**Architecture:** A new `service_period` table (`restaurant_id`, optional `label`, `start_time`, `end_time`). Availability search's `candidate_times` CTE now unions a `generate_series` per period row instead of using one flat window. Reservation creation checks the target `[start_time, end_time)` against every period for the restaurant, accepting if any one fully contains it. Rolled out via a one-time in-place migration (not this project's usual full reset), because this rollout must preserve existing data.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- **This rollout must not drop existing data** — the opposite of every prior schema change in this project, which used `DROP SCHEMA public CASCADE` + reseed. Do not run that against local or remote databases during this plan. Use the one-time migration script instead (Task 1).
- No automated test framework exists in this project. Every "verify" step is a manual check: `curl` against a running `npm run dev`, or a `psql`/`node` query.
- Two databases exist: local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance (what `https://ota-u6ii.onrender.com` actually uses). Both need the same in-place migration — do not reset either.
- No API CRUD for `service_period` — seed data only. `POST`/`PUT /api/restaurant` no longer accept or require `service_start`/`service_end` at all.
- `slot_interval_minutes`/`default_duration_minutes` stay shared on `restaurant` — not per-period.
- No overlap validation between a restaurant's periods — trusted seed data.
- **Known gap, deliberately accepted:** between running the remote migration (Task 6) and the code finishing deployment, the *old* code (which still queries `restaurant.service_start`/`service_end`) will error on every restaurant search/reservation request, since those columns will already be gone. This is a real but brief availability gap on a low-traffic dev/demo service — push immediately after migrating, and verify live behavior afterward (Task 6) rather than trying to avoid the gap.
- Today's reference date for test dates in this plan: **2026-07-19 (Sunday)**; `2026-07-20` is the following Monday.

---

### Task 1: Add `service_period` table and migrate existing restaurants in place

**Files:**
- Modify: `src/db/schema.sql` (remove `service_start`/`service_end` from `restaurant`; add `service_period` table + index — reflects the *end state*, for any future full reset)
- Create: `src/db/migrate-2026-07-19-service-period.sql` (the one-time script actually used for *this* rollout)

**Interfaces:**
- Produces: `service_period(id, restaurant_id, label, start_time, end_time)`. Task 2's search/reservation-creation queries and Task 4's seed files all depend on this table shape.

- [ ] **Step 1: Update `schema.sql` to the end state**

Replace:
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

CREATE TABLE IF NOT EXISTS restaurant_table (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_number  VARCHAR(10)  NOT NULL,
  seats         INT          NOT NULL,
  location      VARCHAR(50),
  status        VARCHAR(20)  DEFAULT 'active',
  UNIQUE (restaurant_id, table_number)
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS restaurant (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      VARCHAR(100) NOT NULL,
  description               TEXT,
  phone                     VARCHAR(30),
  slot_interval_minutes     INT          NOT NULL DEFAULT 15,
  default_duration_minutes  INT          NOT NULL,
  closed_days               SMALLINT[]   NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_table (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_number  VARCHAR(10)  NOT NULL,
  seats         INT          NOT NULL,
  location      VARCHAR(50),
  status        VARCHAR(20)  DEFAULT 'active',
  UNIQUE (restaurant_id, table_number)
);

CREATE TABLE IF NOT EXISTS service_period (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurant(id),
  label         VARCHAR(50),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (start_time < end_time)
);
```

Replace:
```sql
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant        ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time     ON restaurant_reservation(table_id, reservation_date, start_time);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_clerk_user          ON restaurant_reservation(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_rest   ON restaurant_seasonal_closure(restaurant_id);
```
with:
```sql
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant        ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time     ON restaurant_reservation(table_id, reservation_date, start_time);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_clerk_user          ON restaurant_reservation(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_rest   ON restaurant_seasonal_closure(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_service_period_restaurant          ON service_period(restaurant_id);
```

- [ ] **Step 2: Write the one-time migration script**

Create `src/db/migrate-2026-07-19-service-period.sql`:
```sql
-- One-time migration: introduce service_period, drop restaurant.service_start/service_end.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline, and NOT idempotent - the INSERT...SELECT and DROP
-- COLUMN steps would fail or duplicate data if run twice). Preserves every
-- existing restaurant, table, reservation, guest, and booking row.
-- See docs/superpowers/plans/2026-07-19-restaurant-service-periods-plan.md.

CREATE TABLE IF NOT EXISTS service_period (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurant(id),
  label         VARCHAR(50),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_service_period_restaurant ON service_period(restaurant_id);

INSERT INTO service_period (restaurant_id, start_time, end_time)
SELECT id, service_start, service_end FROM restaurant;

ALTER TABLE restaurant
  DROP COLUMN service_start,
  DROP COLUMN service_end;
```

- [ ] **Step 3: Snapshot row counts, then run the migration against local Postgres**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  for (const t of ['restaurant', 'restaurant_table', 'restaurant_reservation', 'guest', 'booking']) {
    const r = await client.query(\`SELECT COUNT(*) FROM \${t}\`);
    console.log(t, r.rows[0].count);
  }
  await client.end();
})();
"
```
Note these counts (you'll compare against them after the migration).

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query(fs.readFileSync('src/db/migrate-2026-07-19-service-period.sql', 'utf8'));
  await client.end();
  console.log('migration applied');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `migration applied`, no errors.

- [ ] **Step 4: Verify data preserved and correctly migrated**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  for (const t of ['restaurant', 'restaurant_table', 'restaurant_reservation', 'guest', 'booking']) {
    const r = await client.query(\`SELECT COUNT(*) FROM \${t}\`);
    console.log(t, r.rows[0].count);
  }
  const cols = await client.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'restaurant'\");
  console.log('restaurant columns:', cols.rows.map(r => r.column_name));
  const periods = await client.query('SELECT r.name, sp.start_time, sp.end_time FROM service_period sp JOIN restaurant r ON r.id = sp.restaurant_id ORDER BY r.name');
  console.log(periods.rows);
  await client.end();
})();
"
```
Expected: the 5 row counts match Step 3's snapshot exactly (no data lost); `restaurant columns` does **not** include `service_start`/`service_end`; the periods list has exactly 4 rows — one per existing restaurant (Bonito `19:00:00`–`22:30:00`, Bimini `12:00:00`–`15:00:00`, Betula `17:30:00`–`23:00:00`, Barry `17:30:00`–`23:00:00`).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-07-19-service-period.sql
git commit -m "Add service_period table and migrate existing restaurants in place"
```

---

### Task 2: Update availability search and reservation creation to use `service_period`

**Files:**
- Modify: `src/controllers/restaurant.js` (`searchAvailability`'s query; `createReservation`'s service-hours check; `createRestaurant`; `updateRestaurant`)

**Interfaces:**
- Consumes: `service_period` from Task 1.
- Produces: no change to any function's exported name or the `searchAvailability`/reservation-creation response shapes. `createRestaurant`/`updateRestaurant` no longer accept `service_start`/`service_end` in the request body (silently ignored if sent, since those columns no longer exist to bind to).

- [ ] **Step 1: Rework `searchAvailability`'s query to source `candidate_times` from `service_period`**

Replace:
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
           AND NOT EXISTS (
             SELECT 1 FROM restaurant_seasonal_closure sc
             WHERE sc.restaurant_id = $1
               AND ROW(EXTRACT(MONTH FROM gs)::int, EXTRACT(DAY FROM gs)::int)
                   BETWEEN ROW(sc.start_month, sc.start_day) AND ROW(sc.end_month, sc.end_day)
           )
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
         SELECT slot_interval_minutes, default_duration_minutes, closed_days
         FROM restaurant WHERE id = $1
       ),
       candidate_times AS (
         SELECT generate_series(
           DATE '2000-01-01' + sp.start_time,
           DATE '2000-01-01' + sp.end_time - (r.default_duration_minutes || ' minutes')::interval,
           (r.slot_interval_minutes || ' minutes')::interval
         )::time AS start_time
         FROM service_period sp
         CROSS JOIN r
         WHERE sp.restaurant_id = $1
       ),
       candidate_dates AS (
         SELECT gs::date AS reservation_date
         FROM generate_series($2::date, $3::date, '1 day') AS gs
         CROSS JOIN r
         WHERE NOT (EXTRACT(ISODOW FROM gs)::int = ANY(r.closed_days))
           AND NOT EXISTS (
             SELECT 1 FROM restaurant_seasonal_closure sc
             WHERE sc.restaurant_id = $1
               AND ROW(EXTRACT(MONTH FROM gs)::int, EXTRACT(DAY FROM gs)::int)
                   BETWEEN ROW(sc.start_month, sc.start_day) AND ROW(sc.end_month, sc.end_day)
           )
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

- [ ] **Step 2: Replace the single-window service-hours check in `createReservation`**

Replace:
```js
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
    const end_time = addMinutesToTime(start_time, restaurant.default_duration_minutes);
    const periodsRes = await client.query(
      'SELECT start_time, end_time FROM service_period WHERE restaurant_id = $1',
      [restaurant_id]
    );
    const fitsAPeriod = periodsRes.rows.some((p) => {
      const periodStart = p.start_time.slice(0, 5);
      const periodEnd = p.end_time.slice(0, 5);
      return start_time >= periodStart && end_time <= periodEnd;
    });
    if (!fitsAPeriod) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'start_time is outside service hours' });
    }
```

- [ ] **Step 3: Drop `service_start`/`service_end` from `createRestaurant`**

Replace:
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
with:
```js
async function createRestaurant(req, res, next) {
  try {
    const { name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days } = req.body;
    if (!name || !default_duration_minutes) {
      return res.status(400).json({ error: 'name and default_duration_minutes are required' });
    }
    if (closed_days !== undefined && !isValidClosedDays(closed_days)) {
      return res.status(400).json({ error: 'closed_days must contain integers between 1 and 7' });
    }
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, description ?? null, phone ?? null, slot_interval_minutes ?? 15, default_duration_minutes, closed_days ?? []]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 4: Drop `service_start`/`service_end` from `updateRestaurant`**

Replace:
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
with:
```js
async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days } = req.body;
    if (closed_days !== undefined && !isValidClosedDays(closed_days)) {
      return res.status(400).json({ error: 'closed_days must contain integers between 1 and 7' });
    }
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         phone                    = COALESCE($3, phone),
         slot_interval_minutes    = COALESCE($4, slot_interval_minutes),
         default_duration_minutes = COALESCE($5, default_duration_minutes),
         closed_days              = COALESCE($6, closed_days)
       WHERE id = $7 RETURNING *`,
      [name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 5: Verify no regression against the migrated data (server running against the DB from Task 1)**

```bash
npm run dev
```
Expected: `Server running on port 3000`, no errors.

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")

echo "--- Bonito search still excludes Sunday (regression check) ---"
curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-18&to=2026-07-20&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(r=>r.date)))"
```
Expected: `[ '2026-07-18', '2026-07-20' ]` — same result as before this refactor (Bonito is still closed Sundays via `closed_days`, now sourced through its single migrated `service_period` row instead of the old flat columns).

```bash
echo "--- create restaurant without service_start/service_end (no longer required) ---"
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"name":"Shell Case","default_duration_minutes":60}'
```
Expected: `201` — no `service_start`/`service_end` in the response body at all (column doesn't exist).

- [ ] **Step 6: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Source restaurant service hours from service_period"
```

---

### Task 3: Update Swagger docs

**Files:**
- Modify: `src/docs/swagger.js:270,274` (`/api/restaurant` POST and `/api/restaurant/{id}` PUT schemas)

**Interfaces:**
- Consumes: nothing from prior tasks (documentation only).
- Produces: docs matching Task 2's request shape.

- [ ] **Step 1: Remove `service_start`/`service_end` from the create-restaurant schema**

Replace:
```js
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'service_start', 'service_end', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [7] } } } } } }, responses: { 201: { description: 'Created' } } },
```
with:
```js
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [7] } } } } } }, responses: { 201: { description: 'Created' } } },
```

- [ ] **Step 2: Remove `service_start`/`service_end` from the update-restaurant schema**

Replace:
```js
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [1, 7] } } } } } }, responses: { 200: { description: 'Updated' } } },
```
with:
```js
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [1, 7] } } } } } }, responses: { 200: { description: 'Updated' } } },
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
Expected: neither printed array includes `'service_start'` or `'service_end'`.

- [ ] **Step 4: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Remove service_start/service_end from restaurant Swagger docs"
```

---

### Task 4: Update existing seed files, add BBYC's seed file, seed BBYC locally

**Files:**
- Modify: `src/db/seed-restaurant-bonito.sql`
- Modify: `src/db/seed-restaurant-bimini-betula-barry.sql`
- Create: `src/db/seed-restaurant-bbyc.sql`

**Interfaces:**
- Consumes: `service_period` table from Task 1.
- Produces: seed files that produce a correct fresh install (for any *future* full reset), plus BBYC actually added to the current local database.

- [ ] **Step 1: Update Bonito's seed file for the new schema**

Replace the entire contents of `src/db/seed-restaurant-bonito.sql` with:
```sql
-- Restaurant and tables for Bonito
-- Run after schema.sql (and seed.sql, for consistent ordering with other seed files)
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- Availability is computed on demand (no time_slot grid to seed) from the
-- restaurant's service_period row(s) plus its own slot_interval_minutes/
-- default_duration_minutes columns, set below.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
  VALUES (
    'Bonito',
    'Bonito''s signature restaurant, serving fresh local produce with seasonal tasting menus.',
    '+1-555-0199',
    15, 90, '{7}'
  )
  RETURNING id
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '19:00', '22:30'
  FROM new_restaurant
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Indoor'),
  ('T2', 2, 'Indoor'),
  ('T3', 4, 'Indoor'),
  ('T4', 4, 'Terrace'),
  ('T5', 6, 'Terrace')
) AS t(table_number, seats, location);
```

- [ ] **Step 2: Update Bimini/Betula/Barry's seed file for the new schema**

Replace the entire contents of `src/db/seed-restaurant-bimini-betula-barry.sql` with:
```sql
-- Restaurants and tables for Bimini, Betula, and Barry
-- Run after schema.sql (and seed.sql/seed-restaurant-bonito.sql, for consistent
-- ordering with other seed files)
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- Availability is computed on demand (no time_slot grid to seed) from each
-- restaurant's service_period row(s) plus its own slot_interval_minutes/
-- default_duration_minutes columns, set below.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Bimini',
    'A relaxed seafood shack serving the day''s catch with beachfront views.',
    '+1-555-0201',
    15, 75
  )
  RETURNING id
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '12:00', '15:00'
  FROM new_restaurant
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Beachfront'),
  ('T2', 2, 'Beachfront'),
  ('T3', 4, 'Indoor'),
  ('T4', 4, 'Indoor')
) AS t(table_number, seats, location);

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Betula',
    'A casual European bistro with a seasonal small-plates menu.',
    '+1-555-0202',
    15, 75
  )
  RETURNING id
), new_tables AS (
  INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
  SELECT new_restaurant.id, t.table_number, t.seats, t.location
  FROM new_restaurant, (VALUES
    ('T1', 2, 'Indoor'),
    ('T2', 2, 'Indoor'),
    ('T3', 4, 'Indoor'),
    ('T4', 4, 'Terrace')
  ) AS t(table_number, seats, location)
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '17:30', '23:00'
  FROM new_restaurant
)
INSERT INTO restaurant_seasonal_closure (restaurant_id, start_month, start_day, end_month, end_day)
SELECT new_restaurant.id, sc.start_month, sc.start_day, sc.end_month, sc.end_day
FROM new_restaurant, (VALUES
  (4, 15, 5, 25),
  (10, 1, 11, 25)
) AS sc(start_month, start_day, end_month, end_day);

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Barry',
    'A steakhouse and grill specialising in charcoal-fired cuts and cocktails.',
    '+1-555-0203',
    15, 90
  )
  RETURNING id
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '17:30', '23:00'
  FROM new_restaurant
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Indoor'),
  ('T2', 4, 'Indoor'),
  ('T3', 4, 'Indoor'),
  ('T4', 6, 'Terrace'),
  ('T5', 6, 'Terrace')
) AS t(table_number, seats, location);
```

- [ ] **Step 3: Create BBYC's seed file**

Create `src/db/seed-restaurant-bbyc.sql`:
```sql
-- Restaurant and tables for BBYC (Bora Bora Yacht Club)
-- Run after schema.sql and the other restaurant seed files during a fresh
-- reset - or as a plain additive INSERT directly against an
-- already-populated database (this is how it was actually rolled out; see
-- docs/superpowers/plans/2026-07-19-restaurant-service-periods-plan.md).
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- BBYC is open daily (no closed_days) with two separate service windows -
-- lunch and dinner - hence two service_period rows instead of one.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'BBYC',
    'Bora Bora Yacht Club - a waterfront clubhouse serving lunch and dinner daily.',
    '+1-555-0204',
    15, 90
  )
  RETURNING id
), new_tables AS (
  INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
  SELECT new_restaurant.id, t.table_number, t.seats, t.location
  FROM new_restaurant, (VALUES
    ('T1', 2, 'Marina'),
    ('T2', 2, 'Marina'),
    ('T3', 4, 'Indoor'),
    ('T4', 4, 'Indoor'),
    ('T5', 6, 'Terrace')
  ) AS t(table_number, seats, location)
)
INSERT INTO service_period (restaurant_id, label, start_time, end_time)
SELECT new_restaurant.id, sp.label, sp.start_time, sp.end_time
FROM new_restaurant, (VALUES
  ('Lunch', '11:30', '14:30'),
  ('Dinner', '17:30', '21:30')
) AS sp(label, start_time, end_time);
```

- [ ] **Step 4: Verify the updated seed files produce a correct fresh install — without touching the live local database**

This wraps a full reset+reseed in a transaction that gets rolled back, so the
real (preserved) local data is untouched afterward — Postgres DDL
(`DROP SCHEMA`, `CREATE TABLE`, etc.) is fully transactional.

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('BEGIN');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-restaurant-bimini-betula-barry.sql', 'src/db/seed-restaurant-bbyc.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  const names = await client.query('SELECT name FROM restaurant ORDER BY name');
  console.log('restaurants in scratch reset:', names.rows.map(r => r.name));
  const bbycPeriods = await client.query(\"SELECT label, start_time, end_time FROM service_period sp JOIN restaurant r ON r.id = sp.restaurant_id WHERE r.name = 'BBYC' ORDER BY start_time\");
  console.log('BBYC periods in scratch reset:', bbycPeriods.rows);
  await client.query('ROLLBACK');
  console.log('rolled back - no changes kept');
  await client.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"
```
Expected: `restaurants in scratch reset: [ 'BBYC', 'Barry', 'Betula', 'Bimini', 'Bonito' ]`; `BBYC periods in scratch reset` has 2 rows (`Lunch` `11:30:00`–`14:30:00`, `Dinner` `17:30:00`–`21:30:00`); `rolled back - no changes kept`, no errors.

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  const names = await client.query('SELECT name FROM restaurant ORDER BY name');
  console.log('real restaurants after rollback:', names.rows.map(r => r.name));
  await client.end();
})();
"
```
Expected: `real restaurants after rollback: [ 'Barry', 'Betula', 'Bimini', 'Bonito' ]` — no `BBYC`, confirming the scratch test didn't touch the real database.

- [ ] **Step 5: Actually add BBYC to the live local database (plain additive insert, no reset)**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query(fs.readFileSync('src/db/seed-restaurant-bbyc.sql', 'utf8'));
  await client.end();
  console.log('BBYC seeded');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `BBYC seeded`, no errors.

- [ ] **Step 6: Verify BBYC's multi-window behavior end-to-end** (dev server running against this same DB — restart it if needed so it picks up Task 2's code)

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='BBYC').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

echo "--- confirm 2 service_period rows and 5 tables on the live-seeded BBYC ---"
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  const periods = await client.query('SELECT label, start_time, end_time FROM service_period sp JOIN restaurant r ON r.id = sp.restaurant_id WHERE r.name = \$1 ORDER BY start_time', ['BBYC']);
  console.log('periods:', periods.rows);
  const tables = await client.query('SELECT COUNT(*) FROM restaurant_table rt JOIN restaurant r ON r.id = rt.restaurant_id WHERE r.name = \$1', ['BBYC']);
  console.log('table count:', tables.rows[0].count);
  await client.end();
})();
"

echo "--- search shows both lunch and dinner start times, with a gap between ---"
curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-20&to=2026-07-20&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d)[0];console.log([...new Set(r.slots.map(s=>s.time))].sort())})"

echo "--- reservation inside lunch window (expect 201) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"13:00","party_size":2,"contact_name":"Lunch Test"}'

echo "--- reservation inside dinner window (expect 201) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:00","party_size":2,"contact_name":"Dinner Test"}'

echo "--- reservation in the gap between lunch and dinner (expect 400) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"15:00","party_size":2,"contact_name":"Gap Test"}'
```
Expected: `periods` has exactly 2 rows (`Lunch` `11:30:00`–`14:30:00`, `Dinner` `17:30:00`–`21:30:00`); `table count` is `5`; the time list includes values from `11:30` through `13:00` and from `17:30` through `20:00`, with nothing between `13:00` and `17:30`; the lunch and dinner POSTs both return `201`; the gap POST returns `400 "start_time is outside service hours"`.

- [ ] **Step 7: Commit**

```bash
git add src/db/seed-restaurant-bonito.sql src/db/seed-restaurant-bimini-betula-barry.sql src/db/seed-restaurant-bbyc.sql
git commit -m "Update restaurant seed files for service_period and add BBYC"
```

---

### Task 5: Roll out to the remote `otadb` and push (preserving remote data)

**Files:** none (rollout only — code was already committed in Tasks 1-4).

**Interfaces:** none.

- [ ] **Step 1: Confirm with the user before touching the remote database**

Per this project's established practice this session, confirm with the user
before running anything against the live `otadb`. This step is a bigger
deviation than usual (an in-place migration, not a reset) specifically
because the ask was to preserve existing remote data — say so explicitly
when asking.

- [ ] **Step 2: Snapshot remote row counts**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({
    connectionString: 'postgresql://otadb_user:MRBEK2ocVbd2qFUqLGLcAZjYWoQE7SsE@dpg-d9a98smrnols739u2oc0-a.virginia-postgres.render.com/otadb',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  for (const t of ['restaurant', 'restaurant_table', 'restaurant_reservation', 'guest', 'booking']) {
    const r = await client.query(\`SELECT COUNT(*) FROM \${t}\`);
    console.log(t, r.rows[0].count);
  }
  await client.end();
})();
"
```
Note these counts.

- [ ] **Step 3: Run the migration against remote `otadb`, then immediately push**

Run both back-to-back — per the Global Constraints, the currently-deployed
(old) code will error on restaurant search/reservation requests between
the migration landing and the new code finishing deployment. Minimize that
window rather than trying to eliminate it.

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
  await client.query(fs.readFileSync('src/db/migrate-2026-07-19-service-period.sql', 'utf8'));
  await client.end();
  console.log('remote migration applied');
})().catch(e => { console.error(e.message); process.exit(1); });
"
git push origin main
```
Expected: `remote migration applied`, no errors; the push succeeds.

- [ ] **Step 4: Confirm remote data preserved**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({
    connectionString: 'postgresql://otadb_user:MRBEK2ocVbd2qFUqLGLcAZjYWoQE7SsE@dpg-d9a98smrnols739u2oc0-a.virginia-postgres.render.com/otadb',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  for (const t of ['restaurant', 'restaurant_table', 'restaurant_reservation', 'guest', 'booking']) {
    const r = await client.query(\`SELECT COUNT(*) FROM \${t}\`);
    console.log(t, r.rows[0].count);
  }
  await client.end();
})();
"
```
Expected: all 5 counts match Step 2's snapshot exactly.

- [ ] **Step 5: Seed BBYC on remote (plain additive insert)**

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
  await client.query(fs.readFileSync('src/db/seed-restaurant-bbyc.sql', 'utf8'));
  await client.end();
  console.log('BBYC seeded on remote');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `BBYC seeded on remote`, no errors.

- [ ] **Step 6: Wait for the code deploy, using actual multi-window behavior as the readiness signal**

Checking whether BBYC *exists* is not a valid readiness signal here — the
DB insert above happens instantly and independently of Render finishing
the code deploy. Poll using the behavior that only the *new* code provides
instead (a lunch-window reservation succeeding is a fine signal, but the
cleanest is checking that a `service_start` reference doesn't 500):

```bash
for i in $(seq 1 20); do
  RID_LIVE=$(curl -s --max-time 10 https://ota-u6ii.onrender.com/api/restaurant 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).find(r=>r.name==='BBYC').id)}catch(e){console.log('')}})" 2>/dev/null)
  if [ -z "$RID_LIVE" ]; then echo "attempt $i: BBYC not found yet"; sleep 10; continue; fi
  STATUS=$(curl -s --max-time 10 -o /tmp/bbyc-probe.json -w "%{http_code}" "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/availability/search?from=2026-07-20&to=2026-07-20&party_size=2" 2>/dev/null)
  echo "attempt $i: search HTTP $STATUS"
  if [ "$STATUS" = "200" ]; then echo "NEW CODE IS LIVE"; break; fi
  sleep 10
done
```
Expected: eventually `NEW CODE IS LIVE` (a `500` beforehand is the expected old-code gap, not a bug — keep polling).

- [ ] **Step 7: Live verification**

```bash
RID_LIVE=$(curl -s https://ota-u6ii.onrender.com/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='BBYC').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/availability/search?from=2026-07-20&to=2026-07-20&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d)[0];console.log([...new Set(r.slots.map(s=>s.time))].sort())})"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"15:00","party_size":2,"contact_name":"Live Gap Test"}'
```
Expected: the time list spans `11:30`–`13:00` and `17:30`–`20:00` with a gap; the `15:00` POST returns `400 "start_time is outside service hours"`.

- [ ] **Step 8: No commit needed** — this task is rollout/verification-only. If Step 4's counts don't match, or any live check fails, stop and investigate before considering this feature done — do not re-run the migration script (it is not idempotent).
