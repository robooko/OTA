# Restaurant Module Property Scoping (Multi-Property Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope every restaurant-module table (`restaurant`, `restaurant_table`, `service_period`, `restaurant_reservation`, `restaurant_seasonal_closure`) to a `property_id`, require staff JWT auth for management endpoints, and switch guest-facing reservation creation to the existing `authenticateOrApiKey` pattern — per `docs/superpowers/specs/2026-08-09-restaurant-property-scoping-design.md`.

**Architecture:** Add `property_id UUID NOT NULL REFERENCES property(id)` directly to all 5 tables (no parent-chain joins). A non-destructive migration backfills existing production rows using a confirmed name→property mapping, then enforces `NOT NULL`. Routes swap the old shared `requireApiKey` gate for `authenticate` (staff JWT, sets `req.property_id`) on management endpoints and `authenticateOrApiKey` (JWT or `X-Api-Key` + explicit `property_id`) on the guest-facing create-reservation endpoint, mirroring `bookings.js`/`extras.js`.

**Tech Stack:** Node/Express, `pg` (plain SQL, no ORM), PostgreSQL (local dev + Neon production), `jsonwebtoken`.

## Global Constraints

- **No `psql` CLI in this environment.** Every DB step (running the migration, verifying data) uses a `node -e` one-liner with the `pg` package and `.env`'s `DATABASE_URL` (local) / `DATABASE_URL_LIVE` (production) — the same approach already used for `migrate-2026-08-08-restaurant-status.sql`. Do not write steps that assume `psql` exists.
- No automated test framework exists in this project. Every "verify" step is a manual check: a `curl` command against a running `npm run dev` server, or a `node -e` query — each with the exact expected output.
- Confirmed property backfill mapping (do not re-derive or guess — use exactly this):
  - `Bonito`, `Bimini`, `Betula`, `Barry` → `e1000000-0000-0000-0000-000000000003` (property `Bonito`)
  - `BBYC`, `Pirates Bight` → `e1000000-0000-0000-0000-000000000004` (property `BBYC`)
- Foreign/cross-property IDs return `404`, never `403` — never confirm another tenant's row exists.
- Inserts always set `property_id` from `req.property_id` server-side; any `property_id` in a request body is ignored (except in `authenticateOrApiKey`'s own body-read, which is existing middleware behavior, not something these tasks touch).
- The migration must run against local first (verify), then production, same two-step process used for `restaurant-status`. Do not run write queries against `DATABASE_URL_LIVE` without pausing to confirm with the user first — those commands need explicit user approval in this environment.
- `service_period` and `restaurant_seasonal_closure` get a `property_id` column (for consistency/indexing per the spec) but **no controller query changes** — they're only ever read by joining through an already-property-checked `restaurant_id`, so no additional filter is needed there.

---

### Task 1: Schema + migration — add `property_id` to all 5 restaurant tables, backfill, run locally

**Files:**
- Modify: `src/db/schema.sql:159-222` (the `-- ── Restaurant ──` section)
- Create: `src/db/migrate-2026-08-09-restaurant-property-scoping.sql`
- Modify: `src/db/seed-restaurant-bonito.sql`
- Modify: `src/db/seed-restaurant-bimini-betula-barry.sql`
- Modify: `src/db/seed-restaurant-pirates-bight.sql`

**Interfaces:**
- Consumes: `property.id` (existing table, already has rows `...003` Bonito and `...004` BBYC).
- Produces: `restaurant.property_id`, `restaurant_table.property_id`, `service_period.property_id`, `restaurant_reservation.property_id`, `restaurant_seasonal_closure.property_id` — all `NOT NULL`, all indexed. Later tasks' controller queries reference these columns directly.

- [ ] **Step 1: Update `schema.sql` for fresh installs**

In `src/db/schema.sql`, replace the `-- ── Restaurant ──` block:
```sql
CREATE TABLE IF NOT EXISTS restaurant (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      VARCHAR(100) NOT NULL,
  description               TEXT,
  phone                     VARCHAR(30),
  slot_interval_minutes     INT          NOT NULL DEFAULT 15,
  default_duration_minutes  INT          NOT NULL,
  closed_days               SMALLINT[]   NOT NULL DEFAULT '{}',
  status                    VARCHAR(20)  DEFAULT 'active',
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
  metadata         JSONB        NOT NULL DEFAULT '{}',
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
CREATE INDEX IF NOT EXISTS idx_service_period_restaurant          ON service_period(restaurant_id);
```
with:
```sql
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
  created_at                TIMESTAMPTZ DEFAULT now()
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
  created_at       TIMESTAMPTZ  DEFAULT now()
);

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
```

- [ ] **Step 2: Write the migration file**

Create `src/db/migrate-2026-08-09-restaurant-property-scoping.sql`:
```sql
-- One-time migration: add property_id to the restaurant module tables
-- (restaurant, restaurant_table, service_period, restaurant_reservation,
-- restaurant_seasonal_closure), mirroring how every Phase-1 core table
-- (guest, room, booking, extra, ...) already carries its own property_id
-- rather than being scoped via a parent-chain join. Backfills existing
-- rows using a confirmed name -> property mapping (there is no way to
-- derive this automatically; it was confirmed with the product owner),
-- then enforces NOT NULL. Idempotent-safe via IF NOT EXISTS on the column
-- adds/indexes; the UPDATE/backfill statements are naturally idempotent
-- (a no-op once every row already has the correct value). Run ONCE
-- directly against an already-populated database (NOT part of the normal
-- reset pipeline).

-- 1. Add nullable columns
ALTER TABLE restaurant                  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_table            ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE service_period              ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_reservation      ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_seasonal_closure ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);

-- 2. Backfill restaurant.property_id by name (confirmed mapping)
UPDATE restaurant SET property_id = 'e1000000-0000-0000-0000-000000000003'
  WHERE name IN ('Bonito', 'Bimini', 'Betula', 'Barry') AND property_id IS NULL;
UPDATE restaurant SET property_id = 'e1000000-0000-0000-0000-000000000004'
  WHERE name IN ('BBYC', 'Pirates Bight') AND property_id IS NULL;

-- 3. Backfill the child tables from their restaurant
UPDATE restaurant_table rt
  SET property_id = r.property_id
  FROM restaurant r
  WHERE r.id = rt.restaurant_id AND rt.property_id IS NULL;

UPDATE service_period sp
  SET property_id = r.property_id
  FROM restaurant r
  WHERE r.id = sp.restaurant_id AND sp.property_id IS NULL;

UPDATE restaurant_seasonal_closure sc
  SET property_id = r.property_id
  FROM restaurant r
  WHERE r.id = sc.restaurant_id AND sc.property_id IS NULL;

UPDATE restaurant_reservation rr
  SET property_id = rt.property_id
  FROM restaurant_table rt
  WHERE rt.id = rr.table_id AND rr.property_id IS NULL;

-- 4. Enforce NOT NULL now that every row is backfilled. If any of these
-- fail with "column contains null values", STOP -- it means a restaurant
-- exists outside the 6 named above and needs a mapping decision before
-- proceeding (see Step 4's pre-check, which catches this earlier).
ALTER TABLE restaurant                  ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE restaurant_table            ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE service_period              ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE restaurant_reservation      ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE restaurant_seasonal_closure ALTER COLUMN property_id SET NOT NULL;

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_restaurant_property             ON restaurant(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_table_property        ON restaurant_table(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_property          ON restaurant_reservation(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_prop ON restaurant_seasonal_closure(property_id);
CREATE INDEX IF NOT EXISTS idx_service_period_property          ON service_period(property_id);
```

- [ ] **Step 3: Pre-check locally — confirm every restaurant matches the mapping**

Run:
```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows } = await pool.query(\"SELECT name FROM restaurant WHERE name NOT IN ('Bonito','Bimini','Betula','Barry','BBYC','Pirates Bight')\");
  console.log('Unmapped restaurants:', rows);
  await pool.end();
})();
"
```
Expected: `Unmapped restaurants: []`. If this is not empty, STOP — the migration's backfill will leave that row's `property_id` NULL and Step 4 of the migration will fail on `SET NOT NULL`. Get a mapping decision for the new name before continuing (do not guess).

- [ ] **Step 4: Run the migration against the local database**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-09-restaurant-property-scoping.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`, no errors.

- [ ] **Step 5: Verify the backfill locally**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows } = await pool.query('SELECT name, property_id FROM restaurant ORDER BY name');
  console.log(rows);
  const counts = await pool.query(\`
    SELECT 'restaurant_table' AS t, COUNT(*) FROM restaurant_table WHERE property_id IS NULL
    UNION ALL SELECT 'service_period', COUNT(*) FROM service_period WHERE property_id IS NULL
    UNION ALL SELECT 'restaurant_reservation', COUNT(*) FROM restaurant_reservation WHERE property_id IS NULL
    UNION ALL SELECT 'restaurant_seasonal_closure', COUNT(*) FROM restaurant_seasonal_closure WHERE property_id IS NULL
  \`);
  console.log(counts.rows);
  await pool.end();
})();
"
```
Expected: every restaurant's `property_id` is `...003` (Bonito, Bimini, Betula, Barry) or `...004` (BBYC, Pirates Bight); every count in the second table is `0`.

- [ ] **Step 6: Update the 3 restaurant seed files with `property_id`**

In `src/db/seed-restaurant-bonito.sql`, replace:
```sql
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
  VALUES (
    'Bonito',
```
with:
```sql
  INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
  VALUES (
    'e1000000-0000-0000-0000-000000000003',
    'Bonito',
```

In `src/db/seed-restaurant-bimini-betula-barry.sql`, replace all three occurrences (Bimini, Betula, Barry each get their own `INSERT INTO restaurant (...) VALUES (...)` block):
```sql
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Bimini',
```
with:
```sql
  INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'e1000000-0000-0000-0000-000000000003',
    'Bimini',
```
and:
```sql
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Betula',
```
with:
```sql
  INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'e1000000-0000-0000-0000-000000000003',
    'Betula',
```
and:
```sql
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Barry',
```
with:
```sql
  INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'e1000000-0000-0000-0000-000000000003',
    'Barry',
```

In `src/db/seed-restaurant-pirates-bight.sql`, replace:
```sql
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Pirates Bight',
```
with:
```sql
  INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'e1000000-0000-0000-0000-000000000004',
    'Pirates Bight',
```

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-09-restaurant-property-scoping.sql src/db/seed-restaurant-bonito.sql src/db/seed-restaurant-bimini-betula-barry.sql src/db/seed-restaurant-pirates-bight.sql
git commit -m "Add property_id to restaurant module tables, backfill via confirmed mapping"
```

---

### Task 2: Scope `restaurant` + `restaurant_table` controllers and routes

**Files:**
- Modify: `src/controllers/restaurant.js` (`listRestaurants`, `getRestaurant`, `createRestaurant`, `updateRestaurant`, `listTables`, `createTable`, `updateTable`)
- Modify: `src/routes/restaurant.js:1-14` (imports + restaurant/table route lines)

**Interfaces:**
- Consumes: `req.property_id` (set by `authenticate`, Task 1's schema work, `middleware/auth.js` which already exists).
- Produces: no change to exported function names.

- [ ] **Step 1: Scope `listRestaurants`**

In `src/controllers/restaurant.js`, replace:
```js
async function listRestaurants(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM restaurant WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
async function listRestaurants(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM restaurant WHERE status = 'active' AND property_id = $1 ORDER BY name",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```

- [ ] **Step 2: Scope `getRestaurant`**

Replace:
```js
async function getRestaurant(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM restaurant WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function getRestaurant(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM restaurant WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 3: Scope `createRestaurant`'s insert**

Replace:
```js
    const { rows } = await pool.query(
      `INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, description ?? null, phone ?? null, slot_interval_minutes ?? 15, default_duration_minutes, closed_days ?? []]
    );
```
with:
```js
    const { rows } = await pool.query(
      `INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, name, description ?? null, phone ?? null, slot_interval_minutes ?? 15, default_duration_minutes, closed_days ?? []]
    );
```

- [ ] **Step 4: Scope `updateRestaurant`'s query**

Replace:
```js
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         phone                    = COALESCE($3, phone),
         slot_interval_minutes    = COALESCE($4, slot_interval_minutes),
         default_duration_minutes = COALESCE($5, default_duration_minutes),
         closed_days              = COALESCE($6, closed_days),
         status                   = COALESCE($7, status)
       WHERE id = $8 RETURNING *`,
      [name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, status, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE restaurant SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         phone                    = COALESCE($3, phone),
         slot_interval_minutes    = COALESCE($4, slot_interval_minutes),
         default_duration_minutes = COALESCE($5, default_duration_minutes),
         closed_days              = COALESCE($6, closed_days),
         status                   = COALESCE($7, status)
       WHERE id = $8 AND property_id = $9 RETURNING *`,
      [name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days, status, req.params.id, req.property_id]
    );
```

- [ ] **Step 5: Scope `listTables` — verify restaurant ownership, then list**

Replace:
```js
async function listTables(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM restaurant_table WHERE restaurant_id = $1 ORDER BY table_number',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
async function listTables(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      'SELECT * FROM restaurant_table WHERE restaurant_id = $1 ORDER BY table_number',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```

- [ ] **Step 6: Scope `createTable` — verify restaurant ownership, then insert with `property_id`**

Replace:
```js
async function createTable(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { table_number, seats, location } = req.body;
    if (!table_number || !seats) return res.status(400).json({ error: 'table_number and seats are required' });
    const { rows } = await pool.query(
      `INSERT INTO restaurant_table (restaurant_id, table_number, seats, location) VALUES ($1, $2, $3, $4) RETURNING *`,
      [restaurant_id, table_number, seats, location ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function createTable(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { table_number, seats, location } = req.body;
    if (!table_number || !seats) return res.status(400).json({ error: 'table_number and seats are required' });

    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      `INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats, location) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, restaurant_id, table_number, seats, location ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 7: Scope `updateTable`'s query**

Replace:
```js
    const { rows } = await pool.query(
      `UPDATE restaurant_table SET
         table_number = COALESCE($1, table_number),
         seats        = COALESCE($2, seats),
         location     = COALESCE($3, location),
         status       = COALESCE($4, status)
       WHERE id = $5 AND restaurant_id = $6 RETURNING *`,
      [table_number, seats, location, status, id, restaurant_id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE restaurant_table SET
         table_number = COALESCE($1, table_number),
         seats        = COALESCE($2, seats),
         location     = COALESCE($3, location),
         status       = COALESCE($4, status)
       WHERE id = $5 AND restaurant_id = $6 AND property_id = $7 RETURNING *`,
      [table_number, seats, location, status, id, restaurant_id, req.property_id]
    );
```

- [ ] **Step 8: Swap auth in `src/routes/restaurant.js` for restaurant + table routes**

Replace the top of `src/routes/restaurant.js`:
```js
const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { requireApiKey } = require('../middleware/apiKey');

// Restaurants
router.get('/', ctrl.listRestaurants);
router.get('/:id', ctrl.getRestaurant);
router.post('/', requireApiKey, ctrl.createRestaurant);
router.put('/:id', requireApiKey, ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', ctrl.listTables);
router.post('/:restaurant_id/tables', requireApiKey, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', requireApiKey, ctrl.updateTable);
```
with:
```js
const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate } = require('../middleware/auth');

// Restaurants
router.get('/', authenticate, ctrl.listRestaurants);
router.get('/:id', authenticate, ctrl.getRestaurant);
router.post('/', authenticate, ctrl.createRestaurant);
router.put('/:id', authenticate, ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', authenticate, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, ctrl.updateTable);
```
(Leave the `// Availability` and `// Reservations` sections below this untouched for now — Task 3 handles those.)

- [ ] **Step 9: Verify — start the server and get a staff token**

```bash
npm run dev
```
In a second terminal, log in as the Bonito admin (seeded in Task 2 of the Phase 1 plan, password `changeme123`... if that account doesn't exist locally, use whichever staff account exists locally for property `e1000000-0000-0000-0000-000000000003`):
```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bonito.example.com","password":"changeme123"}'
```
Expected: `200` with a `token` and `"property_id":"e1000000-0000-0000-0000-000000000003"`.

```bash
TOKEN="<paste token>"
curl -s http://localhost:3000/api/restaurant -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with exactly 4 restaurants: Bonito, Bimini, Betula, Barry (not BBYC or Pirates Bight).

```bash
curl -s http://localhost:3000/api/restaurant
```
Expected: `401 {"error":"Missing or invalid Authorization header"}`.

Cross-property check — fetch a BBYC restaurant id directly from the local DB, then try to `GET` it using the Bonito `$TOKEN`:
```bash
BBYC_RESTAURANT_ID=$(node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id FROM restaurant WHERE property_id = 'e1000000-0000-0000-0000-000000000004' LIMIT 1\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
")
curl -s -o /tmp/cross.json -w "HTTP %{http_code}\n" http://localhost:3000/api/restaurant/$BBYC_RESTAURANT_ID -H "Authorization: Bearer $TOKEN"
cat /tmp/cross.json
```
Expected: `HTTP 404 {"error":"Restaurant not found"}` — the Bonito token cannot see a BBYC restaurant, even by exact id.

- [ ] **Step 10: Commit**

```bash
git add src/controllers/restaurant.js src/routes/restaurant.js
git commit -m "Scope restaurant and table endpoints to property and require staff auth"
```

---

### Task 3: Scope `restaurant_reservation` controllers and routes

**Files:**
- Modify: `src/controllers/restaurant.js` (`listReservations`, `getReservation`, `createReservation`, `updateReservation`)
- Modify: `src/routes/restaurant.js` (reservation route lines + import)

**Interfaces:**
- Consumes: `req.property_id` (set by `authenticate` or `authenticateOrApiKey`).
- Produces: no change to exported function names.

- [ ] **Step 1: Scope `listReservations`**

Replace:
```js
async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id, clerk_user_id } = req.query;
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
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND rr.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY rr.reservation_date, rr.start_time';
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
    const { date, status, guest_id, clerk_user_id } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rt.restaurant_id = $1 AND rr.property_id = $2
    `;
    const params = [restaurant_id, req.property_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND rr.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY rr.reservation_date, rr.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}
```

- [ ] **Step 2: Scope `getReservation`**

Replace:
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
with:
```js
async function getReservation(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT rr.*, rt.table_number, rt.seats, rt.location
       FROM restaurant_reservation rr
       JOIN restaurant_table rt ON rt.id = rr.table_id
       WHERE rr.id = $1 AND rr.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 3: Scope `createReservation` — restaurant + guest ownership checks, `property_id` on insert**

Replace the restaurant lookup near the top of the transaction:
```js
    const restaurantRes = await client.query("SELECT * FROM restaurant WHERE id = $1 AND status = 'active'", [restaurant_id]);
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantRes.rows[0];
```
with:
```js
    const restaurantRes = await client.query(
      "SELECT * FROM restaurant WHERE id = $1 AND property_id = $2 AND status = 'active'",
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const restaurant = restaurantRes.rows[0];

    if (guest_id) {
      const guestRes = await client.query(
        'SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]
      );
      if (!guestRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Guest not found' });
      }
    }
```

Replace the final insert:
```js
    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, reservation_date, start_time, end_time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null, metadata ?? {}]
    );
```
with:
```js
    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (property_id, table_id, reservation_date, start_time, end_time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [req.property_id, assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null, metadata ?? {}]
    );
```

- [ ] **Step 4: Scope `updateReservation`'s query**

Replace:
```js
    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone),
         metadata      = COALESCE($6::jsonb, metadata)
       WHERE id = $7 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, metadata ?? null, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone),
         metadata      = COALESCE($6::jsonb, metadata)
       WHERE id = $7 AND property_id = $8 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, metadata ?? null, req.params.id, req.property_id]
    );
```

- [ ] **Step 5: Swap auth in `src/routes/restaurant.js` for reservation routes**

Replace:
```js
const { authenticate } = require('../middleware/auth');
```
with:
```js
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');
```

Replace:
```js
// Reservations
router.get('/:restaurant_id/reservations', requireApiKey, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', requireApiKey, ctrl.getReservation);
router.post('/:restaurant_id/reservations', requireApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', requireApiKey, ctrl.updateReservation);
```
with:
```js
// Reservations
router.get('/:restaurant_id/reservations', authenticate, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', authenticate, ctrl.getReservation);
router.post('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticate, ctrl.updateReservation);
```
(By this point `requireApiKey` is no longer referenced anywhere in this file — its import was already removed in Task 2 Step 8.)

- [ ] **Step 6: Verify — staff-authenticated reservation management**

With the server still running and `TOKEN` from Task 2's Bonito admin login:
```bash
BONITO_ID=$(curl -s http://localhost:3000/api/restaurant -H "Authorization: Bearer $TOKEN" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d.find(r=>r.name==='Bonito').id)")
curl -s http://localhost:3000/api/restaurant/$BONITO_ID/reservations -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with an array (may be empty locally, but must not error).

```bash
curl -s http://localhost:3000/api/restaurant/$BONITO_ID/reservations
```
Expected: `401 {"error":"Missing or invalid Authorization header"}`.

- [ ] **Step 7: Verify — guest-facing reservation creation via API key**

```bash
KEY=$(grep -E "^API_KEY" .env | cut -d= -f2)
curl -s -o /tmp/resv.json -w "HTTP %{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$BONITO_ID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $KEY" \
  -d '{"reservation_date":"2026-09-15","start_time":"19:30","contact_name":"Test Guest","party_size":2,"property_id":"e1000000-0000-0000-0000-000000000003"}'
cat /tmp/resv.json
```
Expected: `HTTP 201`, response body's `property_id` is `e1000000-0000-0000-0000-000000000003`.

```bash
BBYC_ID=$(curl -s http://localhost:3000/api/restaurant -H "Authorization: Bearer $TOKEN2" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d[0].id)")
```
(where `$TOKEN2` is a BBYC-property staff login, same pattern as Task 2 Step 9 but with `admin@bbyc.example.com`)
```bash
curl -s -o /tmp/resv2.json -w "HTTP %{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$BBYC_ID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $KEY" \
  -d '{"reservation_date":"2026-09-15","start_time":"19:30","contact_name":"Cross Tenant","party_size":2,"property_id":"e1000000-0000-0000-0000-000000000003"}'
cat /tmp/resv2.json
```
Expected: `HTTP 404` — `$BBYC_ID` belongs to property `...004`, but the supplied `property_id` is `...003`, so the restaurant lookup finds nothing.

- [ ] **Step 8: Verify — cross-property `guest_id` is rejected**

Find a guest belonging to a *different* property than Bonito, then try to attach it to a Bonito reservation via the API key path:
```bash
FOREIGN_GUEST_ID=$(node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id FROM guest WHERE property_id != 'e1000000-0000-0000-0000-000000000003' LIMIT 1\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
")
curl -s -o /tmp/resv3.json -w "HTTP %{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$BONITO_ID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $KEY" \
  -d "{\"reservation_date\":\"2026-09-15\",\"start_time\":\"20:00\",\"contact_name\":\"Wrong Guest\",\"party_size\":2,\"property_id\":\"e1000000-0000-0000-0000-000000000003\",\"guest_id\":\"$FOREIGN_GUEST_ID\"}"
cat /tmp/resv3.json
```
Expected: `HTTP 404 {"error":"Guest not found"}` — the guest belongs to a different property than the reservation's target restaurant.

- [ ] **Step 9: Verify — availability search is still fully public**

```bash
curl -s -o /tmp/search.json -w "HTTP %{http_code}\n" "http://localhost:3000/api/restaurant/$BONITO_ID/availability/search?from=2026-09-15&to=2026-09-16&party_size=2"
cat /tmp/search.json
```
Expected: `HTTP 200` with an array (no `Authorization` header or `X-Api-Key` sent at all) — confirms the search route wasn't accidentally gated by any of the routing changes in this task.

- [ ] **Step 10: Stop the dev server, commit**

```bash
git add src/controllers/restaurant.js src/routes/restaurant.js
git commit -m "Scope reservation endpoints to property; guest-facing create uses authenticateOrApiKey"
```

---

### Task 4: Swagger doc updates

**Files:**
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: nothing new. Purely documentation — no runtime behavior change.

- [ ] **Step 1: Mark the availability search route as public**

The GET/POST/PUT restaurant, table, and staff-facing reservation entries need no edit — they inherit the file's global default `security: [{ bearerAuth: [] }]` (see line 12), which is now accurate since these routes require `authenticate`. Only two entries need explicit changes.

In `src/docs/swagger.js`, replace:
```js
    '/api/restaurant/{restaurant_id}/availability/search': {
      get: { tags: ['Restaurant'], summary: 'Search available reservation times, grouped by date and location', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'party_size', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'location', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of { date, slots: [{ time, location, available_tables }] }' } } },
    },
```
with:
```js
    '/api/restaurant/{restaurant_id}/availability/search': {
      get: { tags: ['Restaurant'], summary: 'Search available reservation times, grouped by date and location (public)', security: [], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'party_size', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'location', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of { date, slots: [{ time, location, available_tables }] }' } } },
    },
```

- [ ] **Step 2: Document the reservation-create endpoint's dual auth**

Replace:
```js
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
```
with:
```js
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
```

- [ ] **Step 3: Verify**

```bash
npm run dev
```
```bash
curl -s http://localhost:3000/api-docs.json | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log(d.paths['/api/restaurant/{restaurant_id}/availability/search'].get.security);
console.log(d.paths['/api/restaurant/{restaurant_id}/reservations'].post.security);
"
```
Expected: first line `[]`, second line `[ { bearerAuth: [] }, { apiKeyAuth: [] } ]`.

(If the app doesn't expose `/api-docs.json`, check `src/app.js`/`src/docs/swagger.js` for the actual mounted path serving the raw spec — e.g. it may be `/api-docs/swagger.json` via `swagger-ui-express`. Use whichever path is actually configured.)

- [ ] **Step 4: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document restaurant module auth changes in swagger"
```

---

### Task 5: Run migration against production, deploy

**Files:** None (operational task).

**Interfaces:** None — this task applies Tasks 1–4's already-committed changes to production.

- [ ] **Step 1: Pause and confirm with the user before touching production**

This step writes to the live Neon database. Show the user the migration file and the local verification results from Task 1 Step 5, and get explicit confirmation before running Step 2. Do not proceed without it — this matches how the `restaurant-status` migration was handled earlier in this project.

- [ ] **Step 2: Pre-check production — confirm every restaurant matches the mapping**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const { rows } = await pool.query(\"SELECT name FROM restaurant WHERE name NOT IN ('Bonito','Bimini','Betula','Barry','BBYC','Pirates Bight')\");
  console.log('Unmapped restaurants:', rows);
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this"
```
Expected: `Unmapped restaurants: []`. If not empty, STOP — do not proceed; get a mapping decision first (a restaurant may have been created in production since this plan was written).

- [ ] **Step 3: Run the migration against production**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-09-restaurant-property-scoping.sql', 'utf8'));
  console.log('migration applied to prod OK');
  const { rows } = await pool.query('SELECT name, property_id FROM restaurant ORDER BY name');
  console.log(rows);
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this"
```
Expected: `migration applied to prod OK`, followed by all 6 restaurants each showing the correct `property_id` per the mapping table.

- [ ] **Step 4: Commit is already done (Tasks 1–4); push to `main`**

```bash
git push origin main
```
Render auto-deploys from `main` per `render.yaml`.

- [ ] **Step 5: Post-deploy smoke check against production**

Wait for the Render deploy to finish (check the Render dashboard, or poll the health of the deployed URL), then confirm the deployed API rejects unauthenticated restaurant list requests and accepts a valid staff login — same shape as Task 2 Step 9 and Task 3 Steps 6–7, but against the production URL instead of `localhost:3000`. Get the production URL from the user if it isn't already known (it isn't recorded anywhere in this plan).
