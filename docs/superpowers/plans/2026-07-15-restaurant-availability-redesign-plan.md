# Restaurant Availability & Reservations Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the restaurant module's pre-generated `time_slot` grid with on-the-fly computed availability (table capacity + reservation overlap), per `docs/superpowers/specs/2026-07-15-restaurant-availability-redesign-design.md`.

**Architecture:** Availability is computed per request — no stored slot grid. Candidate start times are generated from the restaurant's own `service_start`/`service_end`/`slot_interval_minutes` and checked against existing reservations for overlap via a single indexed SQL query (`generate_series` + `NOT EXISTS`). Reservations store their own `reservation_date`/`start_time`/`end_time` (duration snapshotted from `default_duration_minutes` at booking time) and are auto-assigned a table transactionally using `FOR UPDATE SKIP LOCKED` to prevent concurrent double-booking.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL (`generate_series`, correlated `NOT EXISTS`, `FOR UPDATE SKIP LOCKED`).

## Global Constraints

- No migrations tool exists — `schema.sql` is edited in place and applied to a **freshly reset** dev database (drop/recreate). Do not write ALTER TABLE migrations.
- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, or a `psql` query — each with the exact expected output. Do not introduce a test framework as part of this work.
- Two databases must be reset when rolling this out: the local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance, which is what the live deployed service (`https://ota-u6ii.onrender.com`) actually uses.
- Existing Bonito test reservations on both databases are **not preserved** — per the approved spec, this is a clean reset with no backfill.
- The restaurant module has no `property_id` scoping yet (out of scope for the multi-property Phase 1 rollout) — this plan does not add it.
- Postgres has no `generate_series` overload for the bare `time` type — candidate start times are generated in the `timestamp` domain (anchored to an arbitrary fixed date) and cast back to `::time`, since `generate_series(time, time, interval)` does not exist. This refines the spec's illustrative SQL for correctness; the approach and response shape are unchanged.

---

### Task 1: Schema + seed data for the new availability model

**Files:**
- Modify: `src/db/schema.sql:153-196` (`restaurant` table, drop `time_slot`, alter `restaurant_reservation`, update indexes)
- Modify: `src/db/seed-restaurant-bonito.sql` (rewrite: add restaurant service-config values, remove `time_slot` inserts)

**Interfaces:**
- Produces: `restaurant(service_start, service_end, slot_interval_minutes, default_duration_minutes)`; `restaurant_reservation(reservation_date, start_time, end_time)` replacing `time_slot_id`. Every later task's SQL/controller code depends on these exact column names.

- [ ] **Step 1: Add service-config columns to `restaurant`**

In `src/db/schema.sql`, replace:
```sql
CREATE TABLE IF NOT EXISTS restaurant (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  phone       VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT now()
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
  created_at                TIMESTAMPTZ DEFAULT now()
);
```

- [ ] **Step 2: Drop `time_slot` and rework `restaurant_reservation`**

Delete entirely:
```sql
CREATE TABLE IF NOT EXISTS time_slot (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID         NOT NULL REFERENCES restaurant(id),
  slot_date        DATE         NOT NULL,
  slot_time        TIME         NOT NULL,
  available_seats  INT          NOT NULL,
  UNIQUE (restaurant_id, slot_date, slot_time)
);
```

Replace:
```sql
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
  contact_name     VARCHAR(100) NOT NULL,
  contact_email    VARCHAR(255),
  contact_phone    VARCHAR(30),
  party_size       INT          NOT NULL,
  status           VARCHAR(20)  DEFAULT 'confirmed',
  notes            TEXT,
  created_at       TIMESTAMPTZ  DEFAULT now()
);
```

Replace the index block:
```sql
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant   ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_time_slot_restaurant          ON time_slot(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_slot     ON restaurant_reservation(table_id, time_slot_id);
```
with:
```sql
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant    ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time ON restaurant_reservation(table_id, reservation_date, start_time);
```

- [ ] **Step 3: Rewrite `seed-restaurant-bonito.sql`**

`service_end` is `22:30`, not `21:00` — with a 90-minute `default_duration_minutes`,
a `19:00`-`21:00` window only yields 3 bookable start times (`19:00`-`19:30`,
since the last start must be `service_end - duration`). Widening to `22:30`
restores 9 start times (`19:00`-`21:00` every 15 min), matching the slot
count this restaurant had before the redesign.

Replace the entire file with:
```sql
-- Restaurant and tables for Bonito
-- Run after schema.sql (and seed.sql, for consistent ordering with other seed files)
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- Availability is computed on demand (no time_slot grid to seed) from the
-- restaurant's own service_start/service_end/slot_interval_minutes/
-- default_duration_minutes columns, set below.

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

- [ ] **Step 4: Reset local dev DB and verify**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
    console.log('applied', f);
  }
  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `applied src/db/schema.sql`, `applied src/db/seed.sql`, `applied src/db/seed-restaurant-bonito.sql`, `applied src/db/seed-extras.sql` — no errors.

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  const r = await client.query(\"SELECT name, service_start, service_end, slot_interval_minutes, default_duration_minutes FROM restaurant WHERE name = 'Bonito'\");
  console.log(r.rows);
  await client.end();
})();
"
```
Expected: one row — `service_start: '19:00:00'`, `service_end: '22:30:00'`, `slot_interval_minutes: 15`, `default_duration_minutes: 90`.

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query('SELECT 1 FROM time_slot LIMIT 1');
    console.log('ERROR: time_slot still exists');
  } catch (e) {
    console.log('OK:', e.message);
  }
  await client.end();
})();
"
```
Expected: `OK: relation "time_slot" does not exist`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/seed-restaurant-bonito.sql
git commit -m "Replace restaurant time_slot grid with service-config columns on restaurant"
```

---

### Task 2: Restaurant CRUD gains service-config fields

**Files:**
- Modify: `src/controllers/restaurant.js:21-47` (`createRestaurant`, `updateRestaurant`)

**Interfaces:**
- Consumes: `restaurant(service_start, service_end, slot_interval_minutes, default_duration_minutes)` from Task 1.
- Produces: no change to exported function names.

- [ ] **Step 1: Require the new fields on create**

Replace:
```js
async function createRestaurant(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name, description ?? null, phone ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
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

- [ ] **Step 2: Allow updating the new fields**

Replace:
```js
async function updateRestaurant(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         phone       = COALESCE($3, phone)
       WHERE id = $4 RETURNING *`,
      [name, description, phone, req.params.id]
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

- [ ] **Step 3: Verify** (server running against the reset local DB from Task 1; `API_KEY` from `.env`)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"name":"Test Grill"}'
```
Expected: `400 {"error":"name, service_start, service_end, and default_duration_minutes are required"}`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"name":"Test Grill","service_start":"12:00","service_end":"14:00","default_duration_minutes":60}'
```
Expected: `201` with `service_start:"12:00:00"`, `service_end:"14:00:00"`, `slot_interval_minutes:15`, `default_duration_minutes:60`.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Add service-config fields to restaurant create/update"
```

---

### Task 3: Replace slot-grid endpoints with computed availability search

**Files:**
- Modify: `src/controllers/restaurant.js` (delete `listSlots`/`createSlot`/`bulkCreateSlots`; replace `searchSlots` with `searchAvailability`; update `module.exports`)
- Modify: `src/routes/restaurant.js` (remove slot routes, add the new search route)

**Interfaces:**
- Consumes: `restaurant(service_start, service_end, slot_interval_minutes, default_duration_minutes)`, `restaurant_reservation(reservation_date, start_time, end_time)` from Task 1.
- Produces: `searchAvailability(req, res, next)` — later tasks (and the frontend) call `GET /:restaurant_id/availability/search?from=&to=&party_size=&location=`.

- [ ] **Step 1: Delete the "Time slots" section and replace `searchSlots`**

Delete entirely (the whole `// ── Time slots ──` section through the end of `searchSlots`):
```js
// ── Time slots ────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, from, to } = req.query;
    let query = 'SELECT * FROM time_slot WHERE restaurant_id = $1';
    const params = [restaurant_id];

    if (date) {
      if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });
      params.push(date); query += ` AND slot_date = $${params.length}`;
    }
    if (from) {
      if (!isValidDate(from)) return res.status(400).json({ error: 'Invalid from date' });
      params.push(from); query += ` AND slot_date >= $${params.length}`;
    }
    if (to) {
      if (!isValidDate(to)) return res.status(400).json({ error: 'Invalid to date' });
      params.push(to); query += ` AND slot_date <= $${params.length}`;
    }

    query += ' ORDER BY slot_date, slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createSlot(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { slot_date, slot_time, available_seats } = req.body;
    if (!slot_date || !slot_time || !available_seats) {
      return res.status(400).json({ error: 'slot_date, slot_time, and available_seats are required' });
    }
    if (!isValidDate(slot_date)) return res.status(400).json({ error: 'Invalid date format' });
    const { rows } = await pool.query(
      `INSERT INTO time_slot (restaurant_id, slot_date, slot_time, available_seats) VALUES ($1, $2, $3, $4) RETURNING *`,
      [restaurant_id, slot_date, slot_time, available_seats]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function bulkCreateSlots(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { from, to, times, available_seats } = req.body;

    if (!from || !to || !Array.isArray(times) || !times.length || !available_seats) {
      return res.status(400).json({ error: 'from, to, times array, and available_seats are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });
    if (from > to) return res.status(400).json({ error: 'from must be before or equal to to' });

    const rows = [];
    const d = new Date(from);
    const end = new Date(to);

    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows: inserted } = await pool.query(
          `INSERT INTO time_slot (restaurant_id, slot_date, slot_time, available_seats)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (restaurant_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [restaurant_id, date, time, available_seats]
        );
        if (inserted.length) rows.push(inserted[0]);
      }
      d.setDate(d.getDate() + 1);
    }

    res.status(201).json({ created: rows.length, slots: rows });
  } catch (err) { next(err); }
}

// ── Search available slots ────────────────────────────────────────────────────

async function searchSlots(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, party_size } = req.query;
    if (!date || !party_size) return res.status(400).json({ error: 'date and party_size are required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    const { rows } = await pool.query(
      `SELECT ts.*,
              COUNT(rt.id) FILTER (WHERE rt.status = 'active') AS total_tables,
              COUNT(rt.id) FILTER (WHERE rt.status = 'active' AND rt.seats >= $3
                AND NOT EXISTS (
                  SELECT 1 FROM restaurant_reservation rr
                  WHERE rr.table_id = rt.id
                    AND rr.time_slot_id = ts.id
                    AND rr.status != 'cancelled'
                )
              ) AS available_tables
       FROM time_slot ts
       CROSS JOIN restaurant_table rt
       WHERE ts.restaurant_id = $1
         AND rt.restaurant_id = $1
         AND ts.slot_date = $2
         AND ts.available_seats >= $3
       GROUP BY ts.id
       HAVING COUNT(rt.id) FILTER (WHERE rt.status = 'active' AND rt.seats >= $3
                AND NOT EXISTS (
                  SELECT 1 FROM restaurant_reservation rr
                  WHERE rr.table_id = rt.id
                    AND rr.time_slot_id = ts.id
                    AND rr.status != 'cancelled'
                )
              ) > 0
       ORDER BY ts.slot_time`,
      [restaurant_id, date, parseInt(party_size, 10)]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
// ── Availability search ─────────────────────────────────────────────────────

async function searchAvailability(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { from, to, party_size, location } = req.query;

    if (!from || !to || !party_size) {
      return res.status(400).json({ error: 'from, to, and party_size are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });
    if (from > to) return res.status(400).json({ error: 'from must be before or equal to to' });
    const partySize = parseInt(party_size, 10);
    if (!Number.isInteger(partySize) || partySize <= 0) {
      return res.status(400).json({ error: 'party_size must be a positive integer' });
    }

    const restaurantRes = await pool.query('SELECT id FROM restaurant WHERE id = $1', [restaurant_id]);
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

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

    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.reservation_date)) byDate.set(row.reservation_date, []);
      byDate.get(row.reservation_date).push({
        time: row.start_time.slice(0, 5),
        location: row.location,
        available_tables: parseInt(row.available_tables, 10),
      });
    }
    res.json([...byDate.entries()].map(([date, slots]) => ({ date, slots })));
  } catch (err) { next(err); }
}
```

- [ ] **Step 2: Update `module.exports`**

Replace:
```js
module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  listSlots, createSlot, bulkCreateSlots, searchSlots,
  listReservations, getReservation, createReservation, updateReservation,
};
```
with:
```js
module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  searchAvailability,
  listReservations, getReservation, createReservation, updateReservation,
};
```

- [ ] **Step 3: Update routes**

In `src/routes/restaurant.js`, replace:
```js
// Slots
router.get('/:restaurant_id/slots', ctrl.listSlots);
router.post('/:restaurant_id/slots', requireApiKey, ctrl.createSlot);
router.post('/:restaurant_id/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/:restaurant_id/slots/search', ctrl.searchSlots);
```
with:
```js
// Availability
router.get('/:restaurant_id/availability/search', ctrl.searchAvailability);
```

- [ ] **Step 4: Verify** (restart `npm run dev`; `$RID` = Bonito's restaurant id from Task 1's Step 4 query)

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-16&to=2026-07-17&party_size=2"
```
Expected: `200` with an array of two date objects (`2026-07-16`, `2026-07-17`), each with a `slots` array containing entries like `{"time":"19:00","location":"Indoor","available_tables":3}` (T1, T2, T3 all qualify for `party_size=2`) and `{"time":"19:00","location":"Terrace","available_tables":2}` (T4, T5), continuing every 15 minutes through `21:00` (the last start time that still ends by `service_end` `22:30`, given the 90-minute duration) — 9 distinct times per location.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/slots/search?date=2026-07-16&party_size=2"
```
Expected: `404` (route no longer exists).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/restaurant.js src/routes/restaurant.js
git commit -m "Replace time_slot grid endpoints with computed availability search"
```

---

### Task 4: Reservation creation — auto-assign + overlap protection

**Files:**
- Modify: `src/middleware/validate.js` (add `isValidTime`)
- Modify: `src/controllers/restaurant.js` (rewrite `createReservation`)

**Interfaces:**
- Consumes: `restaurant(service_start, service_end, default_duration_minutes)`, `restaurant_table(seats, location, status)` from Task 1.
- Produces: `isValidTime(str)` — used by `createReservation` in this task; exported alongside the existing `requireFields`/`isValidDate`/`isValidUuid`.

- [ ] **Step 1: Add `isValidTime` to `validate.js`**

Replace:
```js
module.exports = { requireFields, isValidDate, isValidUuid };
```
with:
```js
function isValidTime(str) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

module.exports = { requireFields, isValidDate, isValidUuid, isValidTime };
```
(add the `isValidTime` function directly above this `module.exports` line, which currently sits at the end of the file)

- [ ] **Step 2: Import it in the restaurant controller**

Replace:
```js
const { isValidDate } = require('../middleware/validate');
```
with:
```js
const { isValidDate, isValidTime } = require('../middleware/validate');
```

- [ ] **Step 3: Add a small time-arithmetic helper**

Add directly below the `require` lines at the top of `src/controllers/restaurant.js`:
```js
function addMinutesToTime(timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Rewrite `createReservation`**

Replace:
```js
async function createReservation(req, res, next) {
  const { restaurant_id } = req.params;
  const { table_id, time_slot_id, guest_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;

  if (!table_id || !time_slot_id || !contact_name || !party_size) {
    return res.status(400).json({ error: 'table_id, time_slot_id, contact_name, and party_size are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tableRes = await client.query(
      'SELECT * FROM restaurant_table WHERE id = $1 AND restaurant_id = $2', [table_id, restaurant_id]
    );
    if (!tableRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Table not found' }); }
    if (tableRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table is not active' }); }
    if (tableRes.rows[0].seats < party_size) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table does not have enough seats' }); }

    const slotRes = await client.query(
      'SELECT * FROM time_slot WHERE id = $1 AND restaurant_id = $2', [time_slot_id, restaurant_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Time slot not found' }); }
    if (slotRes.rows[0].available_seats < party_size) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Not enough available seats in this slot' }); }

    const conflictRes = await client.query(
      `SELECT id FROM restaurant_reservation WHERE table_id = $1 AND time_slot_id = $2 AND status != 'cancelled'`,
      [table_id, time_slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Table already reserved for this time slot' }); }

    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, time_slot_id, guest_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [table_id, time_slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
    );

    await client.query(
      'UPDATE time_slot SET available_seats = available_seats - $1 WHERE id = $2',
      [party_size, time_slot_id]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```
with:
```js
async function createReservation(req, res, next) {
  const { restaurant_id } = req.params;
  const { reservation_date, start_time, location, guest_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;

  if (!reservation_date || !start_time || !contact_name || !party_size) {
    return res.status(400).json({ error: 'reservation_date, start_time, contact_name, and party_size are required' });
  }
  if (!isValidDate(reservation_date)) return res.status(400).json({ error: 'Invalid date format' });
  if (!isValidTime(start_time)) return res.status(400).json({ error: 'Invalid start_time format, use HH:MM' });
  if (!Number.isInteger(party_size) || party_size <= 0) {
    return res.status(400).json({ error: 'party_size must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    const { rows: candidates } = await client.query(
      `SELECT id FROM restaurant_table
       WHERE restaurant_id = $1
         AND status = 'active'
         AND seats >= $2
         AND ($3::varchar IS NULL OR location = $3)
       ORDER BY seats ASC
       FOR UPDATE SKIP LOCKED`,
      [restaurant_id, party_size, location ?? null]
    );

    let assignedTableId = null;
    for (const table of candidates) {
      const overlapRes = await client.query(
        `SELECT id FROM restaurant_reservation
         WHERE table_id = $1
           AND reservation_date = $2
           AND status != 'cancelled'
           AND start_time < $4
           AND end_time   > $3`,
        [table.id, reservation_date, start_time, end_time]
      );
      if (!overlapRes.rows.length) { assignedTableId = table.id; break; }
    }

    if (!assignedTableId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No tables available for this time' });
    }

    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, reservation_date, start_time, end_time, guest_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```

- [ ] **Step 5: Verify** (`$RID` = Bonito's restaurant id, as in Task 3)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" \
  -d '{"reservation_date":"2026-07-16","start_time":"19:00","party_size":2,"contact_name":"Alice"}'
```
Expected: `201` with `reservation_date:"2026-07-16"`, `start_time:"19:00:00"`, `end_time:"20:30:00"`, and a `table_id` UUID.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" \
  -d '{"reservation_date":"2026-07-16","start_time":"21:15","party_size":2,"contact_name":"Bob"}'
```
Expected: `400 {"error":"start_time is outside service hours"}` — `21:15 + 90min = 22:45`, past `service_end` (`22:30`).

- [ ] **Step 6: Commit**

```bash
git add src/middleware/validate.js src/controllers/restaurant.js
git commit -m "Auto-assign table and prevent overlapping reservations on create"
```

---

### Task 5: Simplify reservation read/update endpoints

**Files:**
- Modify: `src/controllers/restaurant.js` (`listReservations`, `getReservation`, `updateReservation`)

**Interfaces:**
- Consumes: `restaurant_reservation(reservation_date, start_time, end_time)` from Task 1.
- Produces: no change to exported function names.

- [ ] **Step 1: Join on the reservation's own date/time instead of `time_slot`**

Replace `listReservations`:
```js
async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT rr.*, ts.slot_date, ts.slot_time, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN time_slot ts ON ts.id = rr.time_slot_id
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE ts.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (date) { params.push(date); query += ` AND ts.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    query += ' ORDER BY ts.slot_date, ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rt.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    query += ' ORDER BY rr.reservation_date, rr.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}
```

Replace `getReservation`:
```js
async function getReservation(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, ts.slot_date, ts.slot_time, rt.table_number, rt.seats, rt.location
       FROM restaurant_reservation rr
       JOIN time_slot ts ON ts.id = rr.time_slot_id
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function getReservation(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 2: Remove the `available_seats` restore from `updateReservation`**

Replace:
```js
async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone)
       WHERE id = $6 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    if (status === 'cancelled') {
      await pool.query(
        'UPDATE time_slot SET available_seats = available_seats + $1 WHERE id = $2',
        [rows[0].party_size, rows[0].time_slot_id]
      );
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone)
       WHERE id = $6 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 3: Verify** (`$RID` = Bonito's restaurant id; use the reservation `id` returned by Task 4's Step 5 curl)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/reservations?date=2026-07-16"
```
Expected: `200` with an array including the reservation created in Task 4, showing `table_number`, `seats`, `location` alongside `reservation_date`/`start_time`/`end_time`.

```bash
RESID="<paste the reservation id from the previous response>"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/restaurant/$RID/reservations/$RESID" \
  -H "Content-Type: application/json" -d '{"status":"cancelled"}'
curl -s "http://localhost:3000/api/restaurant/$RID/availability/search?from=2026-07-16&to=2026-07-16&party_size=2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const day=JSON.parse(d)[0];console.log(day.slots.find(s=>s.time==='19:00'));})"
```
Expected: the PUT returns `200` with `status:"cancelled"`; the search result for `19:00` now shows `available_tables` back to its original count (the cancelled reservation no longer blocks its table — no counter was touched, availability is recomputed live).

- [ ] **Step 4: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Simplify reservation reads and cancellation for the computed-availability model"
```

---

### Task 6: Update Swagger docs

**Files:**
- Modify: `src/docs/swagger.js:268-288`

**Interfaces:**
- Consumes: nothing from prior tasks (documentation only).
- Produces: docs matching the new endpoint shapes from Tasks 2-5.

- [ ] **Step 1: Update restaurant CRUD schemas**

Replace:
```js
    '/api/restaurant': {
      get: { tags: ['Restaurant'], summary: 'List all restaurants', responses: { 200: { description: 'Array of restaurants' } } },
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get restaurant by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Restaurant' } } },
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```
with:
```js
    '/api/restaurant': {
      get: { tags: ['Restaurant'], summary: 'List all restaurants', responses: { 200: { description: 'Array of restaurants' } } },
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'service_start', 'service_end', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get restaurant by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Restaurant' } } },
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, service_start: { type: 'string', example: '19:00' }, service_end: { type: 'string', example: '22:30' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```

- [ ] **Step 2: Replace the slots docs with availability/search**

Replace:
```js
    '/api/restaurant/{restaurant_id}/slots/bulk': {
      post: { tags: ['Restaurant'], summary: 'Bulk generate time slots', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['from', 'to', 'times', 'available_seats'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['12:00', '14:00', '18:00', '19:30', '21:00'] }, available_seats: { type: 'integer' } } } } } }, responses: { 201: { description: 'Slots created' } } },
    },
    '/api/restaurant/{restaurant_id}/slots/search': {
      get: { tags: ['Restaurant'], summary: 'Search available slots', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'party_size', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Available slots with table counts' } } },
    },
```
with:
```js
    '/api/restaurant/{restaurant_id}/availability/search': {
      get: { tags: ['Restaurant'], summary: 'Search available reservation times, grouped by date and location', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'party_size', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'location', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of { date, slots: [{ time, location, available_tables }] }' } } },
    },
```

- [ ] **Step 3: Update the create-reservation request schema**

Replace:
```js
      post: { tags: ['Restaurant'], summary: 'Create reservation', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_id', 'time_slot_id', 'contact_name', 'party_size'], properties: { table_id: { type: 'string', format: 'uuid' }, time_slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'Table already booked' } } },
```
with:
```js
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
```

- [ ] **Step 4: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(Object.keys(j.paths).filter(p=>p.startsWith('/api/restaurant')));})"
```
Expected: the printed array includes `/api/restaurant/{restaurant_id}/availability/search` and does **not** include any path containing `/slots`.

- [ ] **Step 5: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Update Swagger docs for the redesigned availability/reservation endpoints"
```

---

### Task 7: Full reset, reseed, and live verification (local + remote)

**Files:** none (verification only — no code changes).

**Interfaces:** none.

- [ ] **Step 1: Full reset and reseed — local**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
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

- [ ] **Step 2: Concurrency check — two simultaneous bookings for the last available table**

Set up a restaurant with exactly one qualifying table for a 6-person party (Bonito's `T5`, 6 seats, is the only table `>= 6`), then fire two requests at once:

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
(curl -s -w "\nSTATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:00","party_size":6,"contact_name":"Party A"}' &
curl -s -w "\nSTATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:00","party_size":6,"contact_name":"Party B"}' &
wait)
```
Expected: exactly one response shows `STATUS:201`, the other shows `STATUS:409 {"error":"No tables available for this time"}`.

- [ ] **Step 3: Boundary check**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" \
  -d '{"reservation_date":"2026-07-21","start_time":"21:30","party_size":2,"contact_name":"Late Party"}'
```
Expected: `400 {"error":"start_time is outside service hours"}` (`21:30 + 90min = 23:00`, past `service_end` `22:30`).

- [ ] **Step 4: Repeat the reset against the remote `otadb` instance**

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
Expected: `done`, no errors. (This is the database the live Render service at `https://ota-u6ii.onrender.com` uses — its own process does not need restarting, since it reconnects to the same `DATABASE_URL` and issues plain, unprepared queries.)

- [ ] **Step 5: Confirm the live service reflects the reset**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "https://ota-u6ii.onrender.com/api/restaurant"
```
Expected: `200` with exactly one restaurant, `"name":"Bonito"`, and no `time_slot`-era leftovers.

```bash
RID_LIVE=$(curl -s https://ota-u6ii.onrender.com/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].id))")
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/availability/search?from=2026-07-16&to=2026-07-16&party_size=2"
```
Expected: `200` with a populated `slots` array for `2026-07-16`, matching the local search shape from Task 3.

- [ ] **Step 6: No commit needed** — this task is verification-only. If any step's actual output didn't match, go back to the relevant earlier task and fix it before considering this redesign done.
