# Restaurant Seasonal Closures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a restaurant have recurring annual closure windows (month/day ranges, no year), have availability search and reservation creation both respect them, and seed Betula's two actual closures plus its corrected service hours — per `docs/superpowers/specs/2026-07-19-restaurant-seasonal-closures-design.md`.

**Architecture:** A new `restaurant_seasonal_closure` table (`restaurant_id`, `start_month`, `start_day`, `end_month`, `end_day`, all non-wrapping via a `CHECK` constraint). Availability search excludes matching dates via a `NOT EXISTS` filter in the `candidate_dates` CTE (alongside the existing `closed_days` filter); reservation creation runs an equivalent query and rejects with the same `400 "Restaurant is closed on this day"` used for weekday closures. No new routes — seed data only.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- No migrations tool exists — `schema.sql` is edited in place and applied to a **freshly reset** dev database (drop/recreate). Do not write ALTER TABLE migrations as a separate file.
- No automated test framework exists in this project. Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, or a `psql`/`node` query — each with the exact expected output.
- Two databases must be reset when rolling this out: the local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance, which is what the live deployed service (`https://ota-u6ii.onrender.com`) actually uses.
- `restaurant_seasonal_closure` rows are non-wrapping only: `(start_month, start_day) <= (end_month, end_day)`, enforced by a `CHECK` constraint. No year-wrapping windows (e.g. Dec→Jan) in this version.
- No new API routes/CRUD for seasonal closures — seed data only.
- This feature is restaurant-module only — do not touch golf, spa, tours, or beach club.
- The `400 "Restaurant is closed on this day"` error message is deliberately reused for both weekday closures (`closed_days`) and seasonal closures — do not introduce a second message.
- Test dates used in this plan are year-independent (`start_month`/`start_day` recurs every year) — `2026-04-*`, `2026-05-*`, `2026-11-*` are used below purely as concrete examples for `2026`.

---

### Task 1: Add `restaurant_seasonal_closure` table, fix Betula's seed data

**Files:**
- Modify: `src/db/schema.sql:176-195` (add table after `restaurant_reservation`, add its index alongside the existing restaurant indexes)
- Modify: `src/db/seed-restaurant-bimini-betula-barry.sql:31-48` (Betula's block: fix service hours, chain a seasonal-closure insert)

**Interfaces:**
- Produces: `restaurant_seasonal_closure(id, restaurant_id, start_month, start_day, end_month, end_day)`. Task 2's search query and Task 3's reservation-creation check both query this table by `restaurant_id` and compare `(month, day)` via `ROW(...) BETWEEN ROW(...) AND ROW(...)`.

- [ ] **Step 1: Add the table and index**

In `src/db/schema.sql`, replace:
```sql
CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  created_at       TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant    ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time ON restaurant_reservation(table_id, reservation_date, start_time);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_clerk_user      ON restaurant_reservation(clerk_user_id);
```
with:
```sql
CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  created_at       TIMESTAMPTZ  DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_seasonal_closure (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID     NOT NULL REFERENCES restaurant(id),
  start_month   SMALLINT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_day     SMALLINT NOT NULL CHECK (start_day BETWEEN 1 AND 31),
  end_month     SMALLINT NOT NULL CHECK (end_month BETWEEN 1 AND 12),
  end_day       SMALLINT NOT NULL CHECK (end_day BETWEEN 1 AND 31),
  CHECK (ROW(start_month, start_day) <= ROW(end_month, end_day))
);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant        ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time     ON restaurant_reservation(table_id, reservation_date, start_time);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_clerk_user          ON restaurant_reservation(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_rest   ON restaurant_seasonal_closure(restaurant_id);
```

- [ ] **Step 2: Fix Betula's service hours and add its two closures**

In `src/db/seed-restaurant-bimini-betula-barry.sql`, replace:
```sql
WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Betula',
    'A casual European bistro with a seasonal small-plates menu.',
    '+1-555-0202',
    '18:00', '22:00', 15, 75
  )
  RETURNING id
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Indoor'),
  ('T2', 2, 'Indoor'),
  ('T3', 4, 'Indoor'),
  ('T4', 4, 'Terrace')
) AS t(table_number, seats, location);
```
with:
```sql
WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, service_start, service_end, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Betula',
    'A casual European bistro with a seasonal small-plates menu.',
    '+1-555-0202',
    '17:30', '23:00', 15, 75
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
)
INSERT INTO restaurant_seasonal_closure (restaurant_id, start_month, start_day, end_month, end_day)
SELECT new_restaurant.id, sc.start_month, sc.start_day, sc.end_month, sc.end_day
FROM new_restaurant, (VALUES
  (4, 15, 5, 25),
  (10, 1, 11, 25)
) AS sc(start_month, start_day, end_month, end_day);
```

This chains three data-modifying CTEs in one statement (restaurant → tables → closures), all sharing `new_restaurant.id`. Data-modifying CTEs always execute to completion even when not referenced by the final statement, so `new_tables` doesn't need a `RETURNING` clause.

- [ ] **Step 3: Reset local dev DB and verify**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-restaurant-bimini-betula-barry.sql', 'src/db/seed-extras.sql']) {
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
  const tbl = await client.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'restaurant_seasonal_closure' ORDER BY ordinal_position\");
  console.log(tbl.rows.map(r => r.column_name));
  const betula = await client.query(\"SELECT service_start, service_end FROM restaurant WHERE name = 'Betula'\");
  console.log(betula.rows);
  const closures = await client.query(\"SELECT start_month, start_day, end_month, end_day FROM restaurant_seasonal_closure sc JOIN restaurant r ON r.id = sc.restaurant_id WHERE r.name = 'Betula' ORDER BY start_month\");
  console.log(closures.rows);
  await client.end();
})();
"
```
Expected: first line includes `'id'`, `'restaurant_id'`, `'start_month'`, `'start_day'`, `'end_month'`, `'end_day'`; second line `[ { service_start: '17:30:00', service_end: '23:00:00' } ]`; third line two rows — `{ start_month: 4, start_day: 15, end_month: 5, end_day: 25 }` and `{ start_month: 10, start_day: 1, end_month: 11, end_day: 25 }`.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql src/db/seed-restaurant-bimini-betula-barry.sql
git commit -m "Add restaurant_seasonal_closure table and seed Betula's seasonal closures"
```

---

### Task 2: Exclude seasonal closures from availability search

**Files:**
- Modify: `src/controllers/restaurant.js` (`searchAvailability`'s `candidate_dates` CTE)

**Interfaces:**
- Consumes: `restaurant_seasonal_closure` from Task 1.
- Produces: no change to `searchAvailability`'s exported behavior/shape — dates inside a closure window are simply absent from the response, same as any date with zero available slots.

- [ ] **Step 1: Add the seasonal-closure exclusion to `candidate_dates`**

Replace:
```js
       candidate_dates AS (
         SELECT gs::date AS reservation_date
         FROM generate_series($2::date, $3::date, '1 day') AS gs
         CROSS JOIN r
         WHERE NOT (EXTRACT(ISODOW FROM gs)::int = ANY(r.closed_days))
       )
```
with:
```js
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
```

- [ ] **Step 2: Verify** (server running against the DB reset in Task 1)

```bash
npm run dev
```
Expected: `Server running on port 3000`, no errors. Leave it running for the curl checks below.

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Betula').id))")

echo "--- spring closure boundary (expect 04-10..04-14 present, 04-15 on absent) ---"
curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-04-10&to=2026-04-20&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(r=>r.date)))"

echo "--- fall closure boundary (expect 11-20..11-25 absent, 11-26..11-30 present) ---"
curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-11-20&to=2026-11-30&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(r=>r.date)))"

echo "--- outside both closures (expect all of 07-13..07-17 present) ---"
curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-13&to=2026-07-17&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(r=>r.date)))"
```
Expected:
- First line: `[ '2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13', '2026-04-14' ]` (04-15 through 04-20 all fall inside the Apr 15–May 25 closure, so absent).
- Second line: `[ '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30' ]` (11-20 through 11-25 fall inside the Oct 1–Nov 25 closure, so absent).
- Third line: `[ '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17' ]` (fully outside both closures — no false-positive exclusion).

- [ ] **Step 3: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Exclude seasonal closures from restaurant availability search"
```

---

### Task 3: Reject reservation creation during seasonal closures

**Files:**
- Modify: `src/controllers/restaurant.js` (`createReservation`)

**Interfaces:**
- Consumes: `restaurant_seasonal_closure` from Task 1.
- Produces: no new error message — reuses the existing `400 "Restaurant is closed on this day"` from the `closed_days` check.

- [ ] **Step 1: Add the seasonal-closure check after the `closed_days` check**

Replace:
```js
    if (restaurant.closed_days.includes(isoDayOfWeek(reservation_date))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restaurant is closed on this day' });
    }

    const serviceStart = restaurant.service_start.slice(0, 5);
```
with:
```js
    if (restaurant.closed_days.includes(isoDayOfWeek(reservation_date))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restaurant is closed on this day' });
    }

    const seasonRes = await client.query(
      `SELECT 1 FROM restaurant_seasonal_closure
       WHERE restaurant_id = $1
         AND ROW(EXTRACT(MONTH FROM $2::date)::int, EXTRACT(DAY FROM $2::date)::int)
             BETWEEN ROW(start_month, start_day) AND ROW(end_month, end_day)`,
      [restaurant_id, reservation_date]
    );
    if (seasonRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Restaurant is closed on this day' });
    }

    const serviceStart = restaurant.service_start.slice(0, 5);
```

- [ ] **Step 2: Verify** (server running against the DB reset in Task 1; nodemon auto-reloads on the file change from Step 1)

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Betula').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

echo "--- inside spring closure (expect 400) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-05-01","start_time":"18:00","party_size":2,"contact_name":"Closure Test"}'

echo "--- outside any closure (expect 201) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-15","start_time":"18:00","party_size":2,"contact_name":"Open Season Test"}'
```
Expected: first response `400`, body `{"error":"Restaurant is closed on this day"}`; second response `201`, body includes `"reservation_date":"2026-07-15"`.

- [ ] **Step 3: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Reject reservations during a restaurant's seasonal closures"
```

---

### Task 4: Full reset, reseed, and live verification (local + remote)

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
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-restaurant-bimini-betula-barry.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
npm run dev
```
Expected: `done`, then `Server running on port 3000` with no errors.

- [ ] **Step 2: End-to-end check against the fresh local DB**

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Betula').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-04-10&to=2026-04-20&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(r=>r.date)))"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-05-01","start_time":"18:00","party_size":2,"contact_name":"Final Closure Check"}'
```
Expected: the search response has no dates from `2026-04-15` onward; the POST returns `400 "Restaurant is closed on this day"`.

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
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-restaurant-bimini-betula-barry.sql', 'src/db/seed-extras.sql']) {
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
Wait for Render to finish redeploying, then poll until the live search reflects the new exclusion (or just wait ~60-90s and retry), then:

```bash
RID_LIVE=$(curl -s https://ota-u6ii.onrender.com/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Betula').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/availability/search?from=2026-04-10&to=2026-04-20&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(r=>r.date)))"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-05-01","start_time":"18:00","party_size":2,"contact_name":"Live Closure Check"}'
```
Expected: the search response has no dates from `2026-04-15` onward; the POST returns `400 "Restaurant is closed on this day"`.

- [ ] **Step 5: No commit needed** — this task is verification-only. If any step's actual output didn't match, go back to the relevant earlier task and fix it before considering this feature done.
