# Multi-Property Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope every core hotel-booking table (property, api_user, guest, room_type, room, room_availability, booking, payment, extra/booking_extra) to a `property_id`, identify the tenant from the caller's JWT, and remove the old global `X-Api-Key` gate — per `docs/superpowers/specs/2026-07-12-multi-property-design.md`.

**Architecture:** One new `property` table; every scoped table gets a `property_id UUID NOT NULL REFERENCES property(id)`. `authenticate` (JWT) sets `req.property_id`; every controller query for a scoped table filters/sets by it. `GET /api/availability/search` is the only route that stays public, taking `?property_id=` explicitly.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL, `jsonwebtoken`, `bcrypt`.

## Global Constraints

- No migrations tool exists — `schema.sql` is edited in place and applied to a **freshly reset** dev database (drop/recreate), per spec. Do not write ALTER TABLE migrations.
- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, or a `psql` query — each with the exact expected output. Do not introduce a test framework as part of this work.
- Every scoped-table query must filter by `property_id`; a valid ID belonging to another property must return `404`, never `403` or a body that reveals the row exists.
- Inserts always set `property_id` from `req.property_id` server-side; any `property_id` in a request body is ignored.
- `apiKey.js` / `requireApiKey` is **not deleted** in this plan — modules not yet converted (restaurant, spa, beach club, tours, equipment, golf, room service, pro shop) still import it. It will be deleted in the final phase of the overall multi-property rollout, once no route references it.
- `DATABASE_URL` and `JWT_SECRET` env vars are assumed already set locally (existing `.env`); no new env vars are introduced.

---

### Task 1: `property` table + seed two sample properties

**Files:**
- Modify: `src/db/schema.sql:1-13` (insert `property` table right after the `pgcrypto` extension line, before `guest`)
- Modify: `src/db/seed.sql:1-3` (add property inserts at the very top)

**Interfaces:**
- Produces: `property(id, name, status, created_at)` — later tasks reference `property.id` as the FK target for every scoped table, and seed rows with fixed UUIDs `e1000000-0000-0000-0000-000000000001` ("Ocean View Resort") and `e1000000-0000-0000-0000-000000000002` ("Mountain Lodge") that later seed tasks tag rows with.

- [ ] **Step 1: Add the `property` table to schema.sql**

In `src/db/schema.sql`, immediately after:
```sql
-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```
insert:
```sql

-- Properties (tenants)
CREATE TABLE IF NOT EXISTS property (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  status     VARCHAR(20)  DEFAULT 'active',
  created_at TIMESTAMPTZ  DEFAULT now()
);
```

- [ ] **Step 2: Add seed properties to seed.sql**

At the very top of `src/db/seed.sql` (before the `-- Room types` comment), insert:
```sql
-- Properties
INSERT INTO property (id, name, status) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'Ocean View Resort', 'active'),
  ('e1000000-0000-0000-0000-000000000002', 'Mountain Lodge',    'active');

```

- [ ] **Step 3: Reset the dev database and apply**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
```
Expected: no errors; last line of seed output shows `REFRESH MATERIALIZED VIEW` (harmless — later tasks fix the view's columns).

- [ ] **Step 4: Verify**

```bash
psql "$DATABASE_URL" -c "SELECT id, name, status FROM property ORDER BY name;"
```
Expected:
```
                  id                  |        name        | status
--------------------------------------+---------------------+--------
 e1000000-0000-0000-0000-000000000002 | Mountain Lodge      | active
 e1000000-0000-0000-0000-000000000001 | Ocean View Resort   | active
```

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/seed.sql
git commit -m "Add property table and seed two sample properties"
```

---

### Task 2: `api_user` scoping + JWT/auth rewiring + seed bootstrap admins

**Files:**
- Modify: `src/db/schema.sql` (the `api_user` table, in the `-- Auth` section)
- Modify: `src/db/seed.sql` (add bootstrap admin accounts)
- Modify: `src/middleware/auth.js:5-17` (`authenticate` sets `req.property_id`)
- Modify: `src/controllers/auth.js` (register/login/me/listUsers/updateUser)
- Modify: `src/routes/auth.js` (register becomes `authenticate + requireRole('admin')`)

**Interfaces:**
- Consumes: `property.id` from Task 1.
- Produces: JWT payload shape `{ id, role, property_id }`; `req.property_id` set by `authenticate` for every later task's controllers to read.

- [ ] **Step 1: Add `property_id` to `api_user` in schema.sql**

Replace:
```sql
CREATE TABLE IF NOT EXISTS api_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'staff',
  created_at    TIMESTAMPTZ  DEFAULT now()
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS api_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'staff',
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_user_property ON api_user(property_id);
```
Note: `email` stays globally `UNIQUE` — see spec's "Amendment"-adjacent Auth section for why (login must find the account by email alone, before the property is known).

- [ ] **Step 2: Seed one bootstrap admin per property**

Add to `src/db/seed.sql`, after the property inserts from Task 1:
```sql
-- Bootstrap admin per property (password: "changeme123")
INSERT INTO api_user (id, property_id, name, email, password_hash, role) VALUES
  ('f1000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000001',
   'Ocean View Admin', 'admin@oceanview.example.com',
   '$2b$12$AeG.yVLwhNPTxp2WeowJ8OZ6J9m4Kyn/sasVTECO/nHbxaBXMzycu', 'admin'),
  ('f1000000-0000-0000-0000-000000000002',
   'e1000000-0000-0000-0000-000000000002',
   'Mountain Lodge Admin', 'admin@mountainlodge.example.com',
   '$2b$12$AeG.yVLwhNPTxp2WeowJ8OZ6J9m4Kyn/sasVTECO/nHbxaBXMzycu', 'admin');

```
The hash above is a real `bcrypt.hashSync('changeme123', 12)` output — both bootstrap admins log in with password `changeme123`.

- [ ] **Step 3: `authenticate` sets `req.property_id`**

In `src/middleware/auth.js`, replace:
```js
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
```
with:
```js
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.property_id = req.user.property_id;
    next();
  } catch (err) {
```

- [ ] **Step 4: Rewire `register` to be admin-gated and property-scoped**

In `src/controllers/auth.js`, replace the whole `register` function with:
```js
async function register(req, res, next) {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const validRoles = ['admin', 'staff', 'guest'];
    const assignedRole = validRoles.includes(role) ? role : 'staff';

    const existing = await pool.query('SELECT id FROM api_user WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO api_user (property_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, property_id, name, email, role, created_at`,
      [req.property_id, name, email, password_hash, assignedRole]
    );

    const token = jwt.sign(
      { id: rows[0].id, role: rows[0].role, property_id: rows[0].property_id },
      JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }
    );
    res.status(201).json({ user: rows[0], token });
  } catch (err) { next(err); }
}
```

- [ ] **Step 5: Rewire `login` to include `property_id` in the JWT**

Replace the `login` function's token/response lines:
```js
    const token = jwt.sign({ id: rows[0].id, role: rows[0].role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role }, token });
```
with:
```js
    const token = jwt.sign(
      { id: rows[0].id, role: rows[0].role, property_id: rows[0].property_id },
      JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({
      user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role, property_id: rows[0].property_id },
      token,
    });
```

- [ ] **Step 6: Scope `me`, `listUsers`, `updateUser` to `req.property_id`**

Replace `me`:
```js
async function me(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at FROM api_user WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```
with:
```js
async function me(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, property_id, name, email, role, created_at FROM api_user WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

Replace `listUsers`:
```js
async function listUsers(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT id, name, email, role, created_at FROM api_user ORDER BY created_at');
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
async function listUsers(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at FROM api_user WHERE property_id = $1 ORDER BY created_at',
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```

Replace `updateUser`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE api_user SET
         name = COALESCE($1, name),
         role = COALESCE($2, role)
       WHERE id = $3 RETURNING id, name, email, role`,
      [name, role, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE api_user SET
         name = COALESCE($1, name),
         role = COALESCE($2, role)
       WHERE id = $3 AND property_id = $4 RETURNING id, name, email, role`,
      [name, role, req.params.id, req.property_id]
    );
```

- [ ] **Step 7: Gate `/register` behind admin auth**

In `src/routes/auth.js`, replace:
```js
router.post('/register', ctrl.register);
```
with:
```js
router.post('/register', authenticate, requireRole('admin'), ctrl.register);
```

- [ ] **Step 8: Reset, reseed, verify**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
npm run dev
```

In a second terminal:
```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@oceanview.example.com","password":"changeme123"}'
```
Expected: `200` with a JSON body containing `"property_id":"e1000000-0000-0000-0000-000000000001"` and a `token`.

```bash
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"No Auth","email":"x@example.com","password":"x12345678"}'
```
Expected: `401 {"error":"Missing or invalid Authorization header"}` — registration without a token is rejected.

Using the `token` from the login response:
```bash
TOKEN="<paste token>"
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"New Staff","email":"staff1@oceanview.example.com","password":"x12345678","role":"staff"}'
```
Expected: `201` with `"user":{"property_id":"e1000000-0000-0000-0000-000000000001", ...}` — the new user is tagged with the admin's own property regardless of no `property_id` being sent in the body.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/seed.sql src/middleware/auth.js src/controllers/auth.js src/routes/auth.js
git commit -m "Scope api_user to property and thread property_id through JWT auth"
```

---

### Task 3: Scope `guest`, `room_type`, `room`, `room_availability` (schema + seed)

**Files:**
- Modify: `src/db/schema.sql` (`guest`, `room_type`, `room`, `room_availability` tables)
- Modify: `src/db/seed.sql` (tag every room type / room / availability / guest row with a `property_id`)

**Interfaces:**
- Consumes: `property.id` seeded in Task 1.
- Produces: `guest(property_id, ...)` with `UNIQUE(property_id, email)` and `UNIQUE(property_id, clerk_user_id)`; `room_type(property_id, ...)`; `room(property_id, ...)` with `UNIQUE(property_id, room_number)`; `room_availability(property_id, room_id, date, ...)`.

- [ ] **Step 1: Scope `guest`**

Replace:
```sql
CREATE TABLE IF NOT EXISTS guest (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id VARCHAR(100) UNIQUE,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  phone         VARCHAR(30),
  created_at    TIMESTAMPTZ  DEFAULT now()
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS guest (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES property(id),
  clerk_user_id VARCHAR(100),
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(30),
  created_at    TIMESTAMPTZ  DEFAULT now(),
  UNIQUE (property_id, email),
  UNIQUE (property_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_guest_property ON guest(property_id);
```

- [ ] **Step 2: Scope `room_type`**

Replace:
```sql
CREATE TABLE IF NOT EXISTS room_type (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(100)    NOT NULL,
  description    TEXT,
  max_occupancy  INT             NOT NULL,
  base_rate      NUMERIC(10,2)   NOT NULL
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS room_type (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID            NOT NULL REFERENCES property(id),
  name           VARCHAR(100)    NOT NULL,
  description    TEXT,
  max_occupancy  INT             NOT NULL,
  base_rate      NUMERIC(10,2)   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_type_property ON room_type(property_id);
```

- [ ] **Step 3: Scope `room`**

Replace:
```sql
CREATE TABLE IF NOT EXISTS room (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id UUID          NOT NULL REFERENCES room_type(id),
  room_number  VARCHAR(10)   NOT NULL UNIQUE,
  floor        INT,
  status       VARCHAR(20)   DEFAULT 'active'
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS room (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID          NOT NULL REFERENCES property(id),
  room_type_id UUID          NOT NULL REFERENCES room_type(id),
  room_number  VARCHAR(10)   NOT NULL,
  floor        INT,
  status       VARCHAR(20)   DEFAULT 'active',
  UNIQUE (property_id, room_number)
);

CREATE INDEX IF NOT EXISTS idx_room_property ON room(property_id);
```

- [ ] **Step 4: Scope `room_availability`**

Replace:
```sql
CREATE TABLE IF NOT EXISTS room_availability (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       UUID          NOT NULL REFERENCES room(id),
  date          DATE          NOT NULL,
  is_available  BOOLEAN       DEFAULT true,
  override_rate NUMERIC(10,2),
  block_reason  VARCHAR(100),
  UNIQUE (room_id, date)
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS room_availability (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  room_id       UUID          NOT NULL REFERENCES room(id),
  date          DATE          NOT NULL,
  is_available  BOOLEAN       DEFAULT true,
  override_rate NUMERIC(10,2),
  block_reason  VARCHAR(100),
  UNIQUE (room_id, date)
);
```

And update the existing index line:
```sql
CREATE INDEX IF NOT EXISTS idx_room_availability_room_date ON room_availability(room_id, date);
```
to also add:
```sql
CREATE INDEX IF NOT EXISTS idx_room_availability_property_date ON room_availability(property_id, date);
```
(keep the original line too — both indexes coexist.)

- [ ] **Step 5: Re-tag seed data with `property_id`**

All seed rooms/room types in `src/db/seed.sql` belong to **Ocean View Resort** (`e1000000-0000-0000-0000-000000000001`). Update the room type insert:
```sql
INSERT INTO room_type (id, name, description, max_occupancy, base_rate) VALUES
```
to:
```sql
INSERT INTO room_type (id, property_id, name, description, max_occupancy, base_rate) VALUES
```
and prefix every value tuple with `'e1000000-0000-0000-0000-000000000001', ` right after the row's own `id`, e.g.:
```sql
  ('a1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'Standard', 'Comfortable room with queen bed, en-suite bathroom and city view', 2, 120.00),
```
Apply the same edit (insert `'e1000000-0000-0000-0000-000000000001', ` as the second column) to all 5 `room_type` rows.

Update the room insert header:
```sql
INSERT INTO room (id, room_type_id, room_number, floor, status) VALUES
```
to:
```sql
INSERT INTO room (id, property_id, room_type_id, room_number, floor, status) VALUES
```
and insert `'e1000000-0000-0000-0000-000000000001', ` as the second column in all 13 `room` rows.

Update the availability generation query:
```sql
INSERT INTO room_availability (room_id, date, is_available)
SELECT
  r.id,
  generate_series('2026-04-03'::date, '2026-07-01'::date, '1 day'::interval)::date AS date,
  true
FROM room r
WHERE r.status = 'active'
ON CONFLICT (room_id, date) DO NOTHING;
```
to:
```sql
INSERT INTO room_availability (property_id, room_id, date, is_available)
SELECT
  r.property_id,
  r.id,
  generate_series('2026-04-03'::date, '2026-07-01'::date, '1 day'::interval)::date AS date,
  true
FROM room r
WHERE r.status = 'active'
ON CONFLICT (room_id, date) DO NOTHING;
```

Update the guest insert header:
```sql
INSERT INTO guest (id, first_name, last_name, email, phone) VALUES
```
to:
```sql
INSERT INTO guest (id, property_id, first_name, last_name, email, phone) VALUES
```
and insert `'e1000000-0000-0000-0000-000000000001', ` as the second column in all 5 `guest` rows.

- [ ] **Step 6: Reset, reseed, verify**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
```
Expected: no errors (no `null value in column "property_id" violates not-null constraint`).

```bash
psql "$DATABASE_URL" -c "SELECT rt.name, COUNT(*) FROM room r JOIN room_type rt ON rt.id = r.room_type_id WHERE r.property_id = 'e1000000-0000-0000-0000-000000000001' GROUP BY rt.name ORDER BY rt.name;"
```
Expected: 5 room-type groups totalling 13 rooms, matching the original seed counts (2 Standard-floor-1, 2 Standard-floor-2, 1 Standard-floor-3 = 5 Standard, 3 Deluxe, 2 Family, 2 Suite, 1 Penthouse).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/seed.sql
git commit -m "Scope guest, room_type, room, and room_availability to property"
```

---

### Task 4: Scope `guests` controller + routes

**Files:**
- Modify: `src/controllers/guests.js` (all 7 functions)
- Modify: `src/routes/guests.js`

**Interfaces:**
- Consumes: `req.property_id` (set by `authenticate`, Task 2).
- Produces: no change to exported function names (`listGuests, getGuest, lookupGuest, getGuestSummary, createGuest, updateGuest, deleteGuest`).

- [ ] **Step 1: Scope every query in `src/controllers/guests.js`**

Replace `listGuests`:
```js
async function listGuests(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM guest ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
}
```
with:
```js
async function listGuests(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM guest WHERE property_id = $1 ORDER BY created_at DESC',
      [req.property_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}
```

Replace `getGuest`:
```js
async function getGuest(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM guest WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}
```
with:
```js
async function getGuest(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM guest WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}
```

Replace `createGuest`'s insert:
```js
    const { rows } = await pool.query(
      `INSERT INTO guest (clerk_user_id, first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [clerk_user_id || null, first_name, last_name, email, phone || null]
    );
```
with:
```js
    const { rows } = await pool.query(
      `INSERT INTO guest (property_id, clerk_user_id, first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, clerk_user_id || null, first_name, last_name, email, phone || null]
    );
```

Replace both `SELECT * FROM guest WHERE clerk_user_id = $1` / `WHERE email = $1` lines inside `lookupGuest`:
```js
      const { rows } = await pool.query(
        'SELECT * FROM guest WHERE clerk_user_id = $1',
        [clerk_user_id]
      );
```
with:
```js
      const { rows } = await pool.query(
        'SELECT * FROM guest WHERE clerk_user_id = $1 AND property_id = $2',
        [clerk_user_id, req.property_id]
      );
```
and:
```js
      const { rows } = await pool.query(
        'SELECT * FROM guest WHERE email = $1',
        [email]
      );
```
with:
```js
      const { rows } = await pool.query(
        'SELECT * FROM guest WHERE email = $1 AND property_id = $2',
        [email, req.property_id]
      );
```

Replace `updateGuest`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE guest SET
         clerk_user_id = COALESCE($1, clerk_user_id),
         first_name    = COALESCE($2, first_name),
         last_name     = COALESCE($3, last_name),
         email         = COALESCE($4, email),
         phone         = COALESCE($5, phone)
       WHERE id = $6 RETURNING *`,
      [clerk_user_id, first_name, last_name, email, phone, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE guest SET
         clerk_user_id = COALESCE($1, clerk_user_id),
         first_name    = COALESCE($2, first_name),
         last_name     = COALESCE($3, last_name),
         email         = COALESCE($4, email),
         phone         = COALESCE($5, phone)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [clerk_user_id, first_name, last_name, email, phone, req.params.id, req.property_id]
    );
```

Replace `getGuestSummary`'s query — every `SELECT id FROM booking WHERE guest_id = $1` subquery must also require the booking's own `property_id`, and the outer query must confirm the guest itself belongs to the caller's property:
```js
async function getGuestSummary(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                            AS total_stays,
         COALESCE(SUM(b.total_price), 0)                    AS total_spent,
         COALESCE(AVG(b.check_out - b.check_in), 0)         AS avg_nights,
         COALESCE(SUM(b.check_out - b.check_in), 0)         AS total_nights,
         MAX(b.check_in)                                    AS last_stay,
         COUNT(*) FILTER (WHERE b.status = 'confirmed')     AS confirmed,
         COUNT(*) FILTER (WHERE b.status = 'cancelled')     AS cancelled,
         COALESCE((
           SELECT SUM(be.quantity * be.unit_price)
           FROM booking_extra be
           WHERE be.booking_id IN (SELECT id FROM booking WHERE guest_id = $1)
         ), 0)                                              AS total_extras_spent,
         COALESCE((
           SELECT COUNT(*)
           FROM booking_extra be
           WHERE be.booking_id IN (SELECT id FROM booking WHERE guest_id = $1)
         ), 0)                                              AS total_extras
       FROM booking b
       WHERE b.guest_id = $1`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}
```
with:
```js
async function getGuestSummary(req, res, next) {
  try {
    const guestRes = await pool.query(
      'SELECT id FROM guest WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!guestRes.rows.length) return res.status(404).json({ error: 'Guest not found' });

    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                            AS total_stays,
         COALESCE(SUM(b.total_price), 0)                    AS total_spent,
         COALESCE(AVG(b.check_out - b.check_in), 0)         AS avg_nights,
         COALESCE(SUM(b.check_out - b.check_in), 0)         AS total_nights,
         MAX(b.check_in)                                    AS last_stay,
         COUNT(*) FILTER (WHERE b.status = 'confirmed')     AS confirmed,
         COUNT(*) FILTER (WHERE b.status = 'cancelled')     AS cancelled,
         COALESCE((
           SELECT SUM(be.quantity * be.unit_price)
           FROM booking_extra be
           WHERE be.booking_id IN (SELECT id FROM booking WHERE guest_id = $1 AND property_id = $2)
         ), 0)                                              AS total_extras_spent,
         COALESCE((
           SELECT COUNT(*)
           FROM booking_extra be
           WHERE be.booking_id IN (SELECT id FROM booking WHERE guest_id = $1 AND property_id = $2)
         ), 0)                                              AS total_extras
       FROM booking b
       WHERE b.guest_id = $1 AND b.property_id = $2`,
      [req.params.id, req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}
```
(`booking.property_id` doesn't exist until Task 8 — this task and Task 8 land together before either is exercised end-to-end; see Task 8's own verification.)

Replace `deleteGuest`:
```js
    const { rows } = await pool.query('DELETE FROM guest WHERE id = $1 RETURNING id', [req.params.id]);
```
with:
```js
    const { rows } = await pool.query(
      'DELETE FROM guest WHERE id = $1 AND property_id = $2 RETURNING id',
      [req.params.id, req.property_id]
    );
```

- [ ] **Step 2: Swap `requireApiKey` for `authenticate` in routes**

Replace `src/routes/guests.js` entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listGuests);
router.get('/lookup', authenticate, ctrl.lookupGuest);
router.get('/:id', authenticate, ctrl.getGuest);
router.get('/:id/summary', authenticate, ctrl.getGuestSummary);
router.post('/', authenticate, ctrl.createGuest);
router.put('/:id', authenticate, ctrl.updateGuest);
router.delete('/:id', authenticate, ctrl.deleteGuest);

module.exports = router;
```

- [ ] **Step 3: Verify** (server running from Task 2, `TOKEN` = Ocean View admin's token)

```bash
curl -s http://localhost:3000/api/guests -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with the 5 seeded Ocean View guests (Alice, Bob, Carol, David, Emma).

```bash
curl -s http://localhost:3000/api/guests
```
Expected: `401 {"error":"Missing or invalid Authorization header"}`.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/guests.js src/routes/guests.js
git commit -m "Scope guests endpoints to property and require auth"
```

---

### Task 5: Scope `room_type` and `room` controllers + routes

**Files:**
- Modify: `src/controllers/roomTypes.js` (all 4 functions)
- Modify: `src/routes/roomTypes.js`
- Modify: `src/controllers/rooms.js` (all 4 functions)
- Modify: `src/routes/rooms.js`

**Interfaces:**
- Consumes: `req.property_id`.
- Produces: no change to exported function names in either controller.

- [ ] **Step 1: Scope `src/controllers/roomTypes.js`**

Replace `listRoomTypes`:
```js
    const { rows } = await pool.query('SELECT * FROM room_type ORDER BY name');
```
with:
```js
    const { rows } = await pool.query(
      'SELECT * FROM room_type WHERE property_id = $1 ORDER BY name',
      [req.property_id]
    );
```

Replace `getRoomType`:
```js
    const { rows } = await pool.query('SELECT * FROM room_type WHERE id = $1', [req.params.id]);
```
with:
```js
    const { rows } = await pool.query(
      'SELECT * FROM room_type WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
```

Replace `createRoomType`'s insert:
```js
    const { rows } = await pool.query(
      `INSERT INTO room_type (name, description, max_occupancy, base_rate)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, max_occupancy, base_rate]
    );
```
with:
```js
    const { rows } = await pool.query(
      `INSERT INTO room_type (property_id, name, description, max_occupancy, base_rate)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, name, description || null, max_occupancy, base_rate]
    );
```

Replace `updateRoomType`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE room_type SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         max_occupancy = COALESCE($3, max_occupancy),
         base_rate     = COALESCE($4, base_rate)
       WHERE id = $5 RETURNING *`,
      [name, description, max_occupancy, base_rate, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE room_type SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         max_occupancy = COALESCE($3, max_occupancy),
         base_rate     = COALESCE($4, base_rate)
       WHERE id = $5 AND property_id = $6 RETURNING *`,
      [name, description, max_occupancy, base_rate, req.params.id, req.property_id]
    );
```

- [ ] **Step 2: Swap auth in `src/routes/roomTypes.js`**

Replace entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listRoomTypes);
router.get('/:id', authenticate, ctrl.getRoomType);
router.post('/', authenticate, ctrl.createRoomType);
router.put('/:id', authenticate, ctrl.updateRoomType);

module.exports = router;
```

- [ ] **Step 3: Scope `src/controllers/rooms.js`**

Replace `listRooms`:
```js
async function listRooms(req, res, next) {
  try {
    const { room_type_id } = req.query;
    let query = `
      SELECT r.*, rt.name AS room_type_name
      FROM room r
      JOIN room_type rt ON rt.id = r.room_type_id
    `;
    const params = [];
    if (room_type_id) {
      query += ' WHERE r.room_type_id = $1';
      params.push(room_type_id);
    }
    query += ' ORDER BY r.room_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}
```
with:
```js
async function listRooms(req, res, next) {
  try {
    const { room_type_id } = req.query;
    let query = `
      SELECT r.*, rt.name AS room_type_name
      FROM room r
      JOIN room_type rt ON rt.id = r.room_type_id
      WHERE r.property_id = $1
    `;
    const params = [req.property_id];
    if (room_type_id) {
      params.push(room_type_id);
      query += ` AND r.room_type_id = $${params.length}`;
    }
    query += ' ORDER BY r.room_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}
```

Replace `getRoom`:
```js
    const { rows } = await pool.query(
      `SELECT r.*, rt.name AS room_type_name
       FROM room r
       JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1`,
      [req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `SELECT r.*, rt.name AS room_type_name
       FROM room r
       JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1 AND r.property_id = $2`,
      [req.params.id, req.property_id]
    );
```

Replace `createRoom`'s insert (and keep both existing `catch` branches):
```js
    const { rows } = await pool.query(
      `INSERT INTO room (room_type_id, room_number, floor, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [room_type_id, room_number, floor || null, status || 'active']
    );
```
with:
```js
    const { rows } = await pool.query(
      `INSERT INTO room (property_id, room_type_id, room_number, floor, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, room_type_id, room_number, floor || null, status || 'active']
    );
```

Replace `updateRoom`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE room SET
         room_type_id = COALESCE($1, room_type_id),
         room_number  = COALESCE($2, room_number),
         floor        = COALESCE($3, floor),
         status       = COALESCE($4, status)
       WHERE id = $5 RETURNING *`,
      [room_type_id, room_number, floor, status, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE room SET
         room_type_id = COALESCE($1, room_type_id),
         room_number  = COALESCE($2, room_number),
         floor        = COALESCE($3, floor),
         status       = COALESCE($4, status)
       WHERE id = $5 AND property_id = $6 RETURNING *`,
      [room_type_id, room_number, floor, status, req.params.id, req.property_id]
    );
```

- [ ] **Step 4: Swap auth in `src/routes/rooms.js`**

Replace entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listRooms);
router.get('/:id', authenticate, ctrl.getRoom);
router.post('/', authenticate, ctrl.createRoom);
router.put('/:id', authenticate, ctrl.updateRoom);

module.exports = router;
```

- [ ] **Step 5: Verify**

```bash
curl -s http://localhost:3000/api/room-types -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with the 5 seeded Ocean View room types (Standard, Deluxe, Family, Suite, Penthouse).

```bash
curl -s http://localhost:3000/api/rooms -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with all 13 seeded Ocean View rooms.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/roomTypes.js src/routes/roomTypes.js src/controllers/rooms.js src/routes/rooms.js
git commit -m "Scope room-type and room endpoints to property and require auth"
```

---

### Task 6: Scope `availability` controller/routes + fix the materialized view

**Files:**
- Modify: `src/db/schema.sql` (`room_type_availability` materialized view + its unique index)
- Modify: `src/controllers/availability.js` (all 7 functions)
- Modify: `src/routes/availability.js`

**Interfaces:**
- Consumes: `req.property_id` for every route except `searchAvailability`, which reads `req.query.property_id` since it stays public.
- Produces: `room_type_availability(property_id, room_type_id, date, total_rooms, available_rooms, min_rate)`.

- [ ] **Step 1: Add `property_id` to the materialized view**

Replace:
```sql
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
```
with:
```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS room_type_availability AS
SELECT
  r.property_id,
  r.room_type_id,
  ra.date,
  COUNT(*)                                        AS total_rooms,
  COUNT(*) FILTER (WHERE ra.is_available = true)  AS available_rooms,
  MIN(COALESCE(ra.override_rate, rt.base_rate))   AS min_rate
FROM room_availability ra
JOIN room      r  ON r.id  = ra.room_id
JOIN room_type rt ON rt.id = r.room_type_id
GROUP BY r.property_id, r.room_type_id, ra.date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rta_property_type_date ON room_type_availability(property_id, room_type_id, date);
```

- [ ] **Step 2: Scope `getRoomAvailability`, `listOverrides`, `deleteOverride`, `upsertRoomAvailability`, `refreshView`**

Replace `getRoomAvailability`:
```js
async function getRoomAvailability(req, res, next) {
  try {
    const { room_id } = req.params;
    const { from, to } = req.query;

    let query = 'SELECT * FROM room_availability WHERE room_id = $1';
    const params = [room_id];
```
with:
```js
async function getRoomAvailability(req, res, next) {
  try {
    const { room_id } = req.params;
    const { from, to } = req.query;

    const roomCheck = await pool.query(
      'SELECT id FROM room WHERE id = $1 AND property_id = $2', [room_id, req.property_id]
    );
    if (!roomCheck.rows.length) return res.status(404).json({ error: 'Room not found' });

    let query = 'SELECT * FROM room_availability WHERE room_id = $1';
    const params = [room_id];
```
(rest of the function is unchanged — the room-ownership check above is what makes it property-safe).

Replace `getRoomTypeAvailability`'s query construction:
```js
    let query = 'SELECT * FROM room_type_availability WHERE 1=1';
    const params = [];

    if (from) {
```
with:
```js
    let query = 'SELECT * FROM room_type_availability WHERE property_id = $1';
    const params = [req.property_id];

    if (from) {
```

Replace `upsertRoomAvailability`'s insert loop preamble — add a room-ownership check before the transaction starts:
```js
async function upsertRoomAvailability(req, res, next) {
  try {
    const { room_id } = req.params;
    const { dates } = req.body;

    if (!Array.isArray(dates) || !dates.length) {
      return res.status(400).json({ error: 'dates array is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const entry of dates) {
        const { date, is_available, override_rate, block_reason } = entry;
        if (!isValidDate(date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Invalid date: ${date}` });
        }
        const { rows } = await client.query(
          `INSERT INTO room_availability (room_id, date, is_available, override_rate, block_reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (room_id, date) DO UPDATE SET
             is_available  = EXCLUDED.is_available,
             override_rate = EXCLUDED.override_rate,
             block_reason  = EXCLUDED.block_reason
           RETURNING *`,
          [room_id, date, is_available ?? true, override_rate ?? null, block_reason ?? null]
        );
        results.push(rows[0]);
      }
```
with:
```js
async function upsertRoomAvailability(req, res, next) {
  try {
    const { room_id } = req.params;
    const { dates } = req.body;

    if (!Array.isArray(dates) || !dates.length) {
      return res.status(400).json({ error: 'dates array is required' });
    }

    const roomCheck = await pool.query(
      'SELECT id FROM room WHERE id = $1 AND property_id = $2', [room_id, req.property_id]
    );
    if (!roomCheck.rows.length) return res.status(404).json({ error: 'Room not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const entry of dates) {
        const { date, is_available, override_rate, block_reason } = entry;
        if (!isValidDate(date)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Invalid date: ${date}` });
        }
        const { rows } = await client.query(
          `INSERT INTO room_availability (property_id, room_id, date, is_available, override_rate, block_reason)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (room_id, date) DO UPDATE SET
             is_available  = EXCLUDED.is_available,
             override_rate = EXCLUDED.override_rate,
             block_reason  = EXCLUDED.block_reason
           RETURNING *`,
          [req.property_id, room_id, date, is_available ?? true, override_rate ?? null, block_reason ?? null]
        );
        results.push(rows[0]);
      }
```

Replace `listOverrides`:
```js
    const { room_id, from, to } = req.query;
    let query = `
      SELECT ra.*, r.room_number, rt.name AS room_type_name, rt.base_rate
      FROM room_availability ra
      JOIN room r ON r.id = ra.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      WHERE ra.override_rate IS NOT NULL
    `;
    const params = [];
    if (room_id) { params.push(room_id); query += ` AND ra.room_id = $${params.length}`; }
```
with:
```js
    const { room_id, from, to } = req.query;
    let query = `
      SELECT ra.*, r.room_number, rt.name AS room_type_name, rt.base_rate
      FROM room_availability ra
      JOIN room r ON r.id = ra.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      WHERE ra.override_rate IS NOT NULL AND ra.property_id = $1
    `;
    const params = [req.property_id];
    if (room_id) { params.push(room_id); query += ` AND ra.room_id = $${params.length}`; }
```

Replace `deleteOverride`:
```js
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE room_availability
       SET override_rate = NULL, block_reason = NULL
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Availability record not found' });
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    res.json(rows[0]);
```
with:
```js
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE room_availability
       SET override_rate = NULL, block_reason = NULL
       WHERE id = $1 AND property_id = $2 RETURNING *`,
      [id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Availability record not found' });
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    res.json(rows[0]);
```

`refreshView` needs no query change — refreshing the shared materialized view is not property-scoped data access.

- [ ] **Step 3: `searchAvailability` requires an explicit `?property_id=`**

Replace:
```js
async function searchAvailability(req, res, next) {
  try {
    const { check_in, check_out, guests } = req.query;

    if (!check_in || !check_out || !guests) {
      return res.status(400).json({ error: 'check_in, check_out, and guests are required' });
    }
    if (!isValidDate(check_in) || !isValidDate(check_out)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    if (check_in >= check_out) {
      return res.status(400).json({ error: 'check_in must be before check_out' });
    }

    const { rows } = await pool.query(
      `SELECT
         rta.room_type_id,
         rt.name,
         rt.description,
         rt.max_occupancy,
         MIN(rta.available_rooms) AS min_available,
         MIN(rta.min_rate)        AS from_rate
       FROM room_type_availability rta
       JOIN room_type rt ON rt.id = rta.room_type_id
       WHERE rta.date >= $1
         AND rta.date <  $2
         AND rt.max_occupancy >= $3
       GROUP BY rta.room_type_id, rt.name, rt.description, rt.max_occupancy
       HAVING MIN(rta.available_rooms) > 0
       ORDER BY from_rate ASC`,
      [check_in, check_out, parseInt(guests, 10)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}
```
with:
```js
async function searchAvailability(req, res, next) {
  try {
    const { check_in, check_out, guests, property_id } = req.query;

    if (!check_in || !check_out || !guests || !property_id) {
      return res.status(400).json({ error: 'check_in, check_out, guests, and property_id are required' });
    }
    if (!isValidDate(check_in) || !isValidDate(check_out)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    if (check_in >= check_out) {
      return res.status(400).json({ error: 'check_in must be before check_out' });
    }

    const { rows } = await pool.query(
      `SELECT
         rta.room_type_id,
         rt.name,
         rt.description,
         rt.max_occupancy,
         MIN(rta.available_rooms) AS min_available,
         MIN(rta.min_rate)        AS from_rate
       FROM room_type_availability rta
       JOIN room_type rt ON rt.id = rta.room_type_id
       WHERE rta.property_id = $1
         AND rta.date >= $2
         AND rta.date <  $3
         AND rt.max_occupancy >= $4
       GROUP BY rta.room_type_id, rt.name, rt.description, rt.max_occupancy
       HAVING MIN(rta.available_rooms) > 0
       ORDER BY from_rate ASC`,
      [property_id, check_in, check_out, parseInt(guests, 10)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 4: Swap auth in `src/routes/availability.js`**

Replace entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/availability');
const { authenticate } = require('../middleware/auth');

router.get('/search', ctrl.searchAvailability);
router.get('/types', authenticate, ctrl.getRoomTypeAvailability);
router.get('/overrides', authenticate, ctrl.listOverrides);
router.delete('/overrides/:id', authenticate, ctrl.deleteOverride);
router.get('/rooms/:room_id', authenticate, ctrl.getRoomAvailability);
router.put('/rooms/:room_id', authenticate, ctrl.upsertRoomAvailability);
router.post('/refresh', authenticate, ctrl.refreshView);

module.exports = router;
```

- [ ] **Step 5: Reset, reseed, verify**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
npm run dev
```

```bash
curl -s "http://localhost:3000/api/availability/search?check_in=2026-04-15&check_out=2026-04-18&guests=2&property_id=e1000000-0000-0000-0000-000000000001"
```
Expected: `200` with an array of Ocean View room types available for those dates (no `Authorization` header needed).

```bash
curl -s "http://localhost:3000/api/availability/search?check_in=2026-04-15&check_out=2026-04-18&guests=2"
```
Expected: `400 {"error":"check_in, check_out, guests, and property_id are required"}`.

```bash
curl -s http://localhost:3000/api/availability/types -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with only Ocean View rows.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/controllers/availability.js src/routes/availability.js
git commit -m "Scope availability endpoints to property, require property_id on public search"
```

---

### Task 7: Scope `booking`, `payment`, `extra` (schema + seed)

**Files:**
- Modify: `src/db/schema.sql` (`booking`, `payment`, `extra` tables + their indexes)
- Modify: `src/db/seed.sql` (tag bookings/payments/extras with `property_id`)

**Interfaces:**
- Consumes: `property.id` from Task 1.
- Produces: `booking(property_id, ...)`, `payment(property_id, ...)`, `extra(property_id, ...)`. `booking_extra` is unchanged (scoped transitively via `booking_id`).

- [ ] **Step 1: Scope `booking`**

Replace:
```sql
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
```
with:
```sql
CREATE TABLE IF NOT EXISTS booking (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  guest_id    UUID          NOT NULL REFERENCES guest(id),
  room_id     UUID          NOT NULL REFERENCES room(id),
  check_in    DATE          NOT NULL,
  check_out   DATE          NOT NULL,
  guests      INT           NOT NULL DEFAULT 1,
  total_price NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'confirmed',
  created_at  TIMESTAMPTZ   DEFAULT now()
);
```

- [ ] **Step 2: Scope `payment` and `extra`**

Replace:
```sql
CREATE TABLE IF NOT EXISTS payment (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID          NOT NULL REFERENCES booking(id),
  amount     NUMERIC(10,2) NOT NULL,
  method     VARCHAR(30),
  status     VARCHAR(20)   DEFAULT 'pending',
  paid_at    TIMESTAMPTZ
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS payment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES booking(id),
  amount      NUMERIC(10,2) NOT NULL,
  method      VARCHAR(30),
  status      VARCHAR(20)   DEFAULT 'pending',
  paid_at     TIMESTAMPTZ
);
```

Replace (in the `-- Extras` section):
```sql
CREATE TABLE IF NOT EXISTS extra (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS extra (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_extra_property ON extra(property_id);
```

- [ ] **Step 3: Update the booking/payment indexes**

Replace:
```sql
CREATE INDEX IF NOT EXISTS idx_booking_room_dates         ON booking(room_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_booking_guest              ON booking(guest_id);
```
with:
```sql
CREATE INDEX IF NOT EXISTS idx_booking_room_dates         ON booking(property_id, room_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_booking_guest              ON booking(property_id, guest_id);
CREATE INDEX IF NOT EXISTS idx_payment_property           ON payment(property_id);
```

- [ ] **Step 4: Re-tag seed bookings, payments, extras with `property_id`**

Update each of the 4 booking inserts in `src/db/seed.sql`, e.g.:
```sql
INSERT INTO booking (id, guest_id, room_id, check_in, check_out, guests, total_price, status) VALUES
  ('d1000000-0000-0000-0000-000000000001',
   'c1000000-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000002',
   '2026-04-15', '2026-04-18', 1, 360.00, 'confirmed');
```
becomes:
```sql
INSERT INTO booking (id, property_id, guest_id, room_id, check_in, check_out, guests, total_price, status) VALUES
  ('d1000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000001',
   'c1000000-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000002',
   '2026-04-15', '2026-04-18', 1, 360.00, 'confirmed');
```
Apply the same `property_id` column + value (always `'e1000000-0000-0000-0000-000000000001'`) to the other 3 booking inserts (Bob's, Carol's, David's).

Update the payment insert:
```sql
INSERT INTO payment (booking_id, amount, method, status, paid_at) VALUES
  ('d1000000-0000-0000-0000-000000000001', 360.00, 'card',          'completed', '2026-04-14 10:00:00+00'),
  ('d1000000-0000-0000-0000-000000000002', 540.00, 'card',          'completed', '2026-04-19 14:30:00+00'),
  ('d1000000-0000-0000-0000-000000000003', 875.00, 'bank_transfer', 'completed', '2026-05-01 09:00:00+00'),
  ('d1000000-0000-0000-0000-000000000003', 875.00, 'bank_transfer', 'completed', '2026-05-04 09:00:00+00'),
  ('d1000000-0000-0000-0000-000000000004', 480.00, 'cash',          'completed', '2026-04-07 11:00:00+00');
```
to:
```sql
INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 360.00, 'card',          'completed', '2026-04-14 10:00:00+00'),
  ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 540.00, 'card',          'completed', '2026-04-19 14:30:00+00'),
  ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003', 875.00, 'bank_transfer', 'completed', '2026-05-01 09:00:00+00'),
  ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003', 875.00, 'bank_transfer', 'completed', '2026-05-04 09:00:00+00'),
  ('e1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000004', 480.00, 'cash',          'completed', '2026-04-07 11:00:00+00');
```

In `src/db/seed-extras.sql`, replace:
```sql
INSERT INTO extra (name, description, price) VALUES
```
with:
```sql
INSERT INTO extra (property_id, name, description, price) VALUES
```
and insert `'e1000000-0000-0000-0000-000000000001', ` as the first value in each of the 10 tuples, e.g.:
```sql
  ('e1000000-0000-0000-0000-000000000001', 'Flowers', 'A curated arrangement of tropical blooms placed in your room on arrival.', 75.00),
```

- [ ] **Step 5: Reset, reseed, verify**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
psql "$DATABASE_URL" -f src/db/seed-extras.sql
```
Expected: no errors.

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM booking WHERE property_id = 'e1000000-0000-0000-0000-000000000001';"
```
Expected: `4`.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/seed.sql src/db/seed-extras.sql
git commit -m "Scope booking, payment, and extra tables to property"
```

---

### Task 8: Scope `bookings` controller + routes

**Files:**
- Modify: `src/controllers/bookings.js` (all 5 functions)
- Modify: `src/routes/bookings.js`

**Interfaces:**
- Consumes: `req.property_id`.
- Produces: no change to exported function names.

- [ ] **Step 1: Scope `listBookings`**

Replace the whole function body's query construction and count query:
```js
    let query = `
      SELECT b.*, g.first_name, g.last_name, g.email,
             r.room_number, r.floor,
             rt.id AS room_type_id, rt.name AS room_type_name,
             rt.description AS room_type_description, rt.max_occupancy, rt.base_rate,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', be.id,
                   'extra_id', be.extra_id,
                   'name', e.name,
                   'quantity', be.quantity,
                   'unit_price', be.unit_price,
                   'total', (be.quantity * be.unit_price)
                 )
               ) FILTER (WHERE be.id IS NOT NULL), '[]'
             ) AS extras
      FROM booking b
      JOIN guest g      ON g.id  = b.guest_id
      JOIN room r       ON r.id  = b.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      LEFT JOIN booking_extra be ON be.booking_id = b.id
      LEFT JOIN extra e          ON e.id = be.extra_id
      WHERE 1=1
    `;
    const params = [];

    if (status) { params.push(status); query += ` AND b.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND b.guest_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND b.check_in >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND b.check_out <= $${params.length}`; }

    // Count query (same filters, no pagination)
    const countQuery = `SELECT COUNT(DISTINCT b.id) FROM booking b
      JOIN guest g      ON g.id  = b.guest_id
      JOIN room r       ON r.id  = b.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      WHERE 1=1
      ${status  ? `AND b.status = $1` : ''}
      ${guest_id ? `AND b.guest_id = $${status ? 2 : 1}` : ''}
      ${from    ? `AND b.check_in >= $${params.filter((_, i) => i < (status ? 1 : 0) + (guest_id ? 1 : 0)).length + 1}` : ''}
      ${to      ? `AND b.check_out <= $${params.filter((_, i) => i < (status ? 1 : 0) + (guest_id ? 1 : 0) + (from ? 1 : 0)).length + 1}` : ''}
    `;

    query += ' GROUP BY b.id, g.first_name, g.last_name, g.email, r.room_number, r.floor, rt.id, rt.name, rt.description, rt.max_occupancy, rt.base_rate';
    query += ' ORDER BY b.created_at DESC';

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(query, params),
      pool.query(`SELECT COUNT(DISTINCT b.id) AS total FROM booking b WHERE 1=1
        ${status   ? ` AND b.status = $1` : ''}
        ${guest_id ? ` AND b.guest_id = $${status ? 2 : 1}` : ''}
        ${from     ? ` AND b.check_in >= $${[status, guest_id].filter(Boolean).length + 1}` : ''}
        ${to       ? ` AND b.check_out <= $${[status, guest_id, from].filter(Boolean).length + 1}` : ''}
      `, [status, guest_id, from, to].filter(Boolean))
    ]);

    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
```
with (the pre-existing manual `$N` index arithmetic for the count query is replaced with the same incremental-`params` pattern used for the main query, applied to its own independent `filterParams` array — this fixes the fragility of the original approach as much as it adds `property_id` scoping, since a 5th always-present filter breaks the old arithmetic):
```js
    let query = `
      SELECT b.*, g.first_name, g.last_name, g.email,
             r.room_number, r.floor,
             rt.id AS room_type_id, rt.name AS room_type_name,
             rt.description AS room_type_description, rt.max_occupancy, rt.base_rate,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', be.id,
                   'extra_id', be.extra_id,
                   'name', e.name,
                   'quantity', be.quantity,
                   'unit_price', be.unit_price,
                   'total', (be.quantity * be.unit_price)
                 )
               ) FILTER (WHERE be.id IS NOT NULL), '[]'
             ) AS extras
      FROM booking b
      JOIN guest g      ON g.id  = b.guest_id
      JOIN room r       ON r.id  = b.room_id
      JOIN room_type rt ON rt.id = r.room_type_id
      LEFT JOIN booking_extra be ON be.booking_id = b.id
      LEFT JOIN extra e          ON e.id = be.extra_id
      WHERE b.property_id = $1
    `;
    const params = [req.property_id];
    let countQuery = 'SELECT COUNT(*) AS total FROM booking b WHERE b.property_id = $1';

    if (status) { params.push(status); query += ` AND b.status = $${params.length}`; countQuery += ` AND b.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND b.guest_id = $${params.length}`; countQuery += ` AND b.guest_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND b.check_in >= $${params.length}`; countQuery += ` AND b.check_in >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND b.check_out <= $${params.length}`; countQuery += ` AND b.check_out <= $${params.length}`; }

    const filterParams = [...params]; // snapshot before pagination params are appended below

    query += ' GROUP BY b.id, g.first_name, g.last_name, g.email, r.room_number, r.floor, rt.id, rt.name, rt.description, rt.max_occupancy, rt.base_rate';
    query += ' ORDER BY b.created_at DESC';

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, filterParams),
    ]);

    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
```

- [ ] **Step 2: Scope `getBooking`**

Replace:
```js
    const { rows } = await pool.query(
      `SELECT b.*,
              g.first_name, g.last_name, g.email, g.phone,
              r.room_number, r.floor, r.status AS room_status,
              rt.name AS room_type_name, rt.base_rate
       FROM booking b
       JOIN guest     g  ON g.id  = b.guest_id
       JOIN room      r  ON r.id  = b.room_id
       JOIN room_type rt ON rt.id = r.room_type_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows: extras } = await pool.query(
      `SELECT be.id, be.extra_id, be.quantity, be.unit_price,
              e.name, e.description,
              (be.quantity * be.unit_price) AS total
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `SELECT b.*,
              g.first_name, g.last_name, g.email, g.phone,
              r.room_number, r.floor, r.status AS room_status,
              rt.name AS room_type_name, rt.base_rate
       FROM booking b
       JOIN guest     g  ON g.id  = b.guest_id
       JOIN room      r  ON r.id  = b.room_id
       JOIN room_type rt ON rt.id = r.room_type_id
       WHERE b.id = $1 AND b.property_id = $2`,
      [req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows: extras } = await pool.query(
      `SELECT be.id, be.extra_id, be.quantity, be.unit_price,
              e.name, e.description,
              (be.quantity * be.unit_price) AS total
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.id]
    );
```

- [ ] **Step 3: Scope `createBooking`'s transaction**

Replace the room-lookup:
```js
    // Check room exists and is active
    const roomRes = await client.query(
      `SELECT r.id, r.status, rt.base_rate
       FROM room r JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1`,
      [room_id]
    );
```
with:
```js
    // Check room exists, is active, and belongs to the caller's property
    const roomRes = await client.query(
      `SELECT r.id, r.status, rt.base_rate
       FROM room r JOIN room_type rt ON rt.id = r.room_type_id
       WHERE r.id = $1 AND r.property_id = $2`,
      [room_id, req.property_id]
    );
```

Replace the guest-ownership gap (there is currently no check that `guest_id` belongs to this property at all — add one right after the room check):
```js
    if (roomRes.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Room is not active' });
    }

    // Check availability for every night
```
with:
```js
    if (roomRes.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Room is not active' });
    }

    const guestRes = await client.query(
      'SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]
    );
    if (!guestRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Guest not found' });
    }

    // Check availability for every night
```

Replace the overlap check:
```js
    const overlapRes = await client.query(
      `SELECT id FROM booking
       WHERE room_id = $1
         AND status = 'confirmed'
         AND check_in  < $3
         AND check_out > $2`,
      [room_id, check_in, check_out]
    );
```
with:
```js
    const overlapRes = await client.query(
      `SELECT id FROM booking
       WHERE room_id = $1
         AND property_id = $4
         AND status = 'confirmed'
         AND check_in  < $3
         AND check_out > $2`,
      [room_id, check_in, check_out, req.property_id]
    );
```

Replace the insert:
```js
    const bookingRes = await client.query(
      `INSERT INTO booking (guest_id, room_id, check_in, check_out, guests, total_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [guest_id, room_id, check_in, check_out, guests || 1, total.toFixed(2)]
    );
```
with:
```js
    const bookingRes = await client.query(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, guests, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, guest_id, room_id, check_in, check_out, guests || 1, total.toFixed(2)]
    );
```

- [ ] **Step 4: Scope `updateBooking` and `cancelBooking`**

Replace `updateBooking`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE booking SET
         status = COALESCE($1, status),
         guests = COALESCE($2, guests)
       WHERE id = $3 RETURNING *`,
      [status, guests, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE booking SET
         status = COALESCE($1, status),
         guests = COALESCE($2, guests)
       WHERE id = $3 AND property_id = $4 RETURNING *`,
      [status, guests, req.params.id, req.property_id]
    );
```

Replace `cancelBooking`'s update:
```js
    const { rows } = await client.query(
      `UPDATE booking SET status = 'cancelled' WHERE id = $1 AND status != 'cancelled' RETURNING *`,
      [req.params.id]
    );
```
with:
```js
    const { rows } = await client.query(
      `UPDATE booking SET status = 'cancelled' WHERE id = $1 AND property_id = $2 AND status != 'cancelled' RETURNING *`,
      [req.params.id, req.property_id]
    );
```

- [ ] **Step 5: Swap auth in `src/routes/bookings.js`**

Replace entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', authenticate, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticate, ctrl.cancelBooking);

module.exports = router;
```

- [ ] **Step 6: Reset, reseed, verify (including cross-property 404)**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
psql "$DATABASE_URL" -f src/db/seed-extras.sql
npm run dev
```

Log in as the Ocean View admin (as in Task 2 Step 8) to get `TOKEN`, then:
```bash
curl -s http://localhost:3000/api/bookings -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with `"total":4` and 4 Ocean View bookings.

Log in as the Mountain Lodge admin (`admin@mountainlodge.example.com` / `changeme123`) to get `TOKEN2`, then try to fetch one of Ocean View's seeded booking IDs:
```bash
curl -s http://localhost:3000/api/bookings/d1000000-0000-0000-0000-000000000001 -H "Authorization: Bearer $TOKEN2"
```
Expected: `404 {"error":"Booking not found"}` — a real booking ID belonging to a different property is invisible, not forbidden.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/bookings.js src/routes/bookings.js
git commit -m "Scope bookings endpoints to property, including cross-property 404s"
```

---

### Task 9: Scope `payments` and `extras` controllers + routes

**Files:**
- Modify: `src/controllers/payments.js` (all 3 functions)
- Modify: `src/routes/payments.js`
- Modify: `src/controllers/extras.js` (all 6 functions)
- Modify: `src/routes/extras.js`

**Interfaces:**
- Consumes: `req.property_id`.
- Produces: no change to exported function names in either controller.

- [ ] **Step 1: Scope `src/controllers/payments.js`**

Replace `listPayments`:
```js
    const { rows } = await pool.query(
      'SELECT * FROM payment WHERE booking_id = $1 ORDER BY paid_at DESC NULLS LAST',
      [req.params.booking_id]
    );
```
with:
```js
    const { rows } = await pool.query(
      'SELECT * FROM payment WHERE booking_id = $1 AND property_id = $2 ORDER BY paid_at DESC NULLS LAST',
      [req.params.booking_id, req.property_id]
    );
```

Replace `createPayment`'s booking check and insert:
```js
    // Verify booking exists
    const bookingCheck = await pool.query('SELECT id FROM booking WHERE id = $1', [booking_id]);
    if (!bookingCheck.rows.length) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO payment (booking_id, amount, method, status, paid_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        booking_id,
        amount,
        method || null,
        status || 'pending',
        status === 'completed' ? new Date() : null,
      ]
    );
```
with:
```js
    // Verify booking exists and belongs to the caller's property
    const bookingCheck = await pool.query(
      'SELECT id FROM booking WHERE id = $1 AND property_id = $2', [booking_id, req.property_id]
    );
    if (!bookingCheck.rows.length) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.property_id,
        booking_id,
        amount,
        method || null,
        status || 'pending',
        status === 'completed' ? new Date() : null,
      ]
    );
```

Replace `updatePayment`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE payment SET
         status  = COALESCE($1, status),
         method  = COALESCE($2, method),
         paid_at = COALESCE($3, paid_at)
       WHERE id = $4 RETURNING *`,
      [status, method, paidAt ?? null, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE payment SET
         status  = COALESCE($1, status),
         method  = COALESCE($2, method),
         paid_at = COALESCE($3, paid_at)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [status, method, paidAt ?? null, req.params.id, req.property_id]
    );
```

- [ ] **Step 2: Swap auth in `src/routes/payments.js`**

Replace entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/payments');
const { authenticate } = require('../middleware/auth');

router.get('/booking/:booking_id', authenticate, ctrl.listPayments);
router.post('/', authenticate, ctrl.createPayment);
router.put('/:id', authenticate, ctrl.updatePayment);

module.exports = router;
```

- [ ] **Step 3: Scope `src/controllers/extras.js`**

Replace `listExtras`:
```js
    const { rows } = await pool.query("SELECT * FROM extra WHERE status = 'active' ORDER BY name");
```
with:
```js
    const { rows } = await pool.query(
      "SELECT * FROM extra WHERE status = 'active' AND property_id = $1 ORDER BY name",
      [req.property_id]
    );
```

Replace `createExtra`'s insert:
```js
    const { rows } = await pool.query(
      `INSERT INTO extra (name, description, price) VALUES ($1, $2, $3) RETURNING *`,
      [name, description ?? null, price]
    );
```
with:
```js
    const { rows } = await pool.query(
      `INSERT INTO extra (property_id, name, description, price) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.property_id, name, description ?? null, price]
    );
```

Replace `updateExtra`'s query:
```js
    const { rows } = await pool.query(
      `UPDATE extra SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         price       = COALESCE($3, price),
         status      = COALESCE($4, status)
       WHERE id = $5 RETURNING *`,
      [name, description, price, status, req.params.id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `UPDATE extra SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         price       = COALESCE($3, price),
         status      = COALESCE($4, status)
       WHERE id = $5 AND property_id = $6 RETURNING *`,
      [name, description, price, status, req.params.id, req.property_id]
    );
```

Replace `listBookingExtras` — the booking must belong to the caller's property:
```js
async function listBookingExtras(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT be.*, e.name, e.description
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
async function listBookingExtras(req, res, next) {
  try {
    const bookingCheck = await pool.query(
      'SELECT id FROM booking WHERE id = $1 AND property_id = $2', [req.params.booking_id, req.property_id]
    );
    if (!bookingCheck.rows.length) return res.status(404).json({ error: 'Booking not found' });

    const { rows } = await pool.query(
      `SELECT be.*, e.name, e.description
       FROM booking_extra be
       JOIN extra e ON e.id = be.extra_id
       WHERE be.booking_id = $1
       ORDER BY e.name`,
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}
```

Replace `addBookingExtra`'s two lookups:
```js
    const extraRes = await pool.query("SELECT * FROM extra WHERE id = $1 AND status = 'active'", [extra_id]);
    if (!extraRes.rows.length) return res.status(404).json({ error: 'Extra not found' });

    const bookingRes = await pool.query('SELECT id FROM booking WHERE id = $1', [booking_id]);
    if (!bookingRes.rows.length) return res.status(404).json({ error: 'Booking not found' });
```
with:
```js
    const extraRes = await pool.query(
      "SELECT * FROM extra WHERE id = $1 AND status = 'active' AND property_id = $2",
      [extra_id, req.property_id]
    );
    if (!extraRes.rows.length) return res.status(404).json({ error: 'Extra not found' });

    const bookingRes = await pool.query(
      'SELECT id FROM booking WHERE id = $1 AND property_id = $2', [booking_id, req.property_id]
    );
    if (!bookingRes.rows.length) return res.status(404).json({ error: 'Booking not found' });
```

Replace `removeBookingExtra` — join through `booking` to enforce property ownership since `booking_extra` itself carries no `property_id`:
```js
    const { rows } = await pool.query(
      'DELETE FROM booking_extra WHERE id = $1 AND booking_id = $2 RETURNING id',
      [req.params.id, req.params.booking_id]
    );
```
with:
```js
    const { rows } = await pool.query(
      `DELETE FROM booking_extra be
       USING booking b
       WHERE be.id = $1 AND be.booking_id = $2
         AND b.id = be.booking_id AND b.property_id = $3
       RETURNING be.id`,
      [req.params.id, req.params.booking_id, req.property_id]
    );
```

- [ ] **Step 4: Swap auth in `src/routes/extras.js`**

Replace entirely:
```js
const router = require('express').Router();
const ctrl = require('../controllers/extras');
const { authenticate } = require('../middleware/auth');

// Extras catalogue
router.get('/', authenticate, ctrl.listExtras);
router.post('/', authenticate, ctrl.createExtra);
router.put('/:id', authenticate, ctrl.updateExtra);

// Booking extras
router.get('/booking/:booking_id', authenticate, ctrl.listBookingExtras);
router.post('/booking/:booking_id', authenticate, ctrl.addBookingExtra);
router.delete('/booking/:booking_id/:id', authenticate, ctrl.removeBookingExtra);

module.exports = router;
```

- [ ] **Step 5: Verify**

```bash
curl -s http://localhost:3000/api/extras -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with the 10 seeded Ocean View extras.

```bash
curl -s http://localhost:3000/api/payments/booking/d1000000-0000-0000-0000-000000000001 -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with 1 payment (Alice's $360 card payment).

- [ ] **Step 6: Commit**

```bash
git add src/controllers/payments.js src/routes/payments.js src/controllers/extras.js src/routes/extras.js
git commit -m "Scope payments and extras endpoints to property"
```

---

### Task 10: Update Swagger docs for the core module

**Files:**
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: nothing from prior tasks (documentation only).
- Produces: `components.securitySchemes.bearerAuth`, applied as the default `security`, with per-path overrides only where a route is genuinely public.

- [ ] **Step 1: Replace the `apiKey` security scheme with `bearerAuth`**

Replace:
```js
  security: [{ apiKey: [] }],
```
with:
```js
  security: [{ bearerAuth: [] }],
```

Replace:
```js
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
```
with:
```js
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
```

- [ ] **Step 2: Fix up per-path `security: [{ apiKey: [] }]` / `security: []` overrides for the core module's paths**

Replace, in `/api/guests/lookup`:
```js
      get: { tags: ['Guests'], summary: 'Look up guest by email', security: [{ apiKey: [] }], parameters:
```
with:
```js
      get: { tags: ['Guests'], summary: 'Look up guest by email', parameters:
```
(no explicit `security` override needed — it now correctly inherits the default `bearerAuth`.)

Replace, in `/api/auth/register`:
```js
      post: { tags: ['Auth'], summary: 'Register a new user', security: [], requestBody:
```
with:
```js
      post: { tags: ['Auth'], summary: 'Register a new staff/admin account for the caller\'s own property (admin only)', requestBody:
```

Replace, in `/api/availability/search`:
```js
      get: { tags: ['Availability'], summary: 'Search available room types', parameters: [{ name: 'check_in', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'check_out', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'guests', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Available room types with rates' } } },
```
with:
```js
      get: { tags: ['Availability'], summary: 'Search available room types (public)', security: [], parameters: [{ name: 'check_in', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'check_out', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'guests', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'property_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available room types with rates' } } },
```

Replace, in `/api/extras/booking/{booking_id}` (both `get` and `post` currently say `security: [{ apiKey: [] }]`):
```js
      get: { tags: ['Extras'], summary: 'List extras on a booking (API key)', security: [{ apiKey: [] }], parameters:
```
with:
```js
      get: { tags: ['Extras'], summary: 'List extras on a booking', parameters:
```
and:
```js
      post: { tags: ['Extras'], summary: 'Add extra to booking (API key)', security: [{ apiKey: [] }], parameters:
```
with:
```js
      post: { tags: ['Extras'], summary: 'Add extra to booking', parameters:
```

Note: `/api/room-service/menu` and `/api/proshop/items` also have a stray `security: []` — leave those untouched, they belong to Phase 4 modules not covered by this plan.

- [ ] **Step 3: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(Object.keys(j.components.securitySchemes));console.log(j.paths['/api/availability/search'].get.security);})"
```
Expected output:
```
[ 'bearerAuth' ]
[]
```

- [ ] **Step 4: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Update Swagger docs: bearer JWT auth for core module, property_id on search"
```

---

### Task 11: Full end-to-end cross-tenant verification

**Files:** none (verification only — no code changes).

**Interfaces:** none.

- [ ] **Step 1: Full reset and reseed**

```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f src/db/schema.sql
psql "$DATABASE_URL" -f src/db/seed.sql
psql "$DATABASE_URL" -f src/db/seed-extras.sql
npm run dev
```
Expected: server starts with no errors on port 3000.

- [ ] **Step 2: Create a Mountain Lodge room type + room as its own admin**

```bash
TOKEN2=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@mountainlodge.example.com","password":"changeme123"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

curl -s -X POST http://localhost:3000/api/room-types -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN2" -d '{"name":"Cabin","max_occupancy":4,"base_rate":200}'
```
Expected: `201` with a new room type owned by Mountain Lodge.

- [ ] **Step 3: Confirm Ocean View cannot see Mountain Lodge's new room type**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@oceanview.example.com","password":"changeme123"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

curl -s http://localhost:3000/api/room-types -H "Authorization: Bearer $TOKEN"
```
Expected: `200` with exactly the 5 original Ocean View room types — no "Cabin".

- [ ] **Step 4: Confirm Mountain Lodge cannot fetch an Ocean View guest by ID**

```bash
curl -s http://localhost:3000/api/guests/c1000000-0000-0000-0000-000000000001 -H "Authorization: Bearer $TOKEN2"
```
Expected: `404 {"error":"Guest not found"}`.

- [ ] **Step 5: Confirm the public search endpoint is property-scoped**

```bash
curl -s "http://localhost:3000/api/availability/search?check_in=2026-04-15&check_out=2026-04-18&guests=2&property_id=e1000000-0000-0000-0000-000000000002"
```
Expected: `200` with an empty array `[]` — Mountain Lodge has no `room_availability` rows seeded yet, so nothing matches (proves the property filter is actually applied, not just the date/occupancy filters).

- [ ] **Step 6: No commit needed** — this task is verification-only. If any step's actual output didn't match, go back to the relevant earlier task and fix it before considering Phase 1 done.
