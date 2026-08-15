# Golf Property Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `property_id` to `golf_course`/`tee_time`/`golf_booking`/`golf_booking_item`, scope every golf route to it, switch guest-facing booking creation to `authenticateOrApiKey`, and extend `updateBooking` to accept contact fields — per `docs/superpowers/specs/2026-08-15-golf-property-scoping-design.md`.

**Architecture:** Direct `property_id UUID NOT NULL REFERENCES property(id)` on all 4 tables (no parent-chain joins). `GET /courses` and `GET /tee-times/search` switch from fully public to `authenticate`-only. `POST /courses`, `PUT /courses/:id`, `POST /tee-times/bulk`, `GET /bookings`, `PUT /bookings/:id` switch from the old shared `requireApiKey` to `authenticate`. `POST /bookings` switches from `requireApiKey` to `authenticateOrApiKey`. No backfill — both databases have zero golf rows in all four tables.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-08-15-golf-property-scoping-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm run dev` server, matching every prior property-scoping plan (restaurant, tours, spa).
- **Confirm with the user before**: running the migration against the live database, and before `git push origin main` (triggers a live Render redeploy).
- Today's date: **2026-08-15**.
- **Test identity:** Robs (`a3e548af-a71d-46c0-ba61-f1f702e495be`), Clerk user `robooko7@gmail.com` → dev user id `user_3C7aK7SeaIKBPlgtuekEpSWhifn`, `org:admin`. Mint a token with (no browser needed, dev-instance-only):
  ```bash
  node -e "
  require('dotenv').config();
  const { createClerkClient } = require('@clerk/backend');
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  (async () => {
    const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
    const tok = await client.sessions.getToken(session.id);
    console.log(tok.jwt);
  })();
  "
  ```
  Tokens expire in ~60 seconds — mint fresh immediately before use.
- **Cross-property checks don't need a second staff identity** — insert a "foreign" course directly via SQL under a different existing property (e.g. BBYC, `e1000000-0000-0000-0000-000000000004`) and confirm Robs's token can't reach it. This avoids needing to mint a second Clerk user/org.
- Get Robs's current API key fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'` — it's been rotated multiple times in prior sessions.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`.
- **Scope:** exactly the 4 tables and 7 routes in the design doc, plus `updateBooking`'s extended fields. No change to `proshop.js` (still `requireApiKey`-only, unscoped — a documented follow-up, not this pass) or any other module.

---

### Task 1: Migration — add `property_id` to all 4 golf tables

**Files:**
- Create: `src/db/migrate-2026-08-15-golf-property-scoping.sql`
- Modify: `src/db/schema.sql` (the `golf_course`, `tee_time`, `golf_booking`, `golf_booking_item` table definitions)

**Interfaces:**
- Produces: `golf_course.property_id`, `tee_time.property_id`, `golf_booking.property_id`, `golf_booking_item.property_id` (all `UUID NOT NULL REFERENCES property(id)`) — Task 2's controller changes query these directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-15-golf-property-scoping.sql`:

```sql
-- One-time migration: add property_id to golf_course, tee_time,
-- golf_booking, and golf_booking_item, scoping the golf module to a
-- property for the first time. No backfill needed -- both the local
-- and live databases have zero rows in all four tables (confirmed
-- before writing this migration), so NOT NULL is safe to add directly
-- with no DEFAULT. Idempotent-safe via IF NOT EXISTS. Run ONCE
-- directly against an already-populated database (NOT part of the
-- normal reset pipeline).

ALTER TABLE golf_course       ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tee_time          ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking      ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking_item ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_golf_course_property       ON golf_course(property_id);
CREATE INDEX IF NOT EXISTS idx_tee_time_property          ON tee_time(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_property      ON golf_booking(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

```sql
CREATE TABLE IF NOT EXISTS golf_course (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100)  NOT NULL,
  description      TEXT,
  holes            INT           NOT NULL,
  price_per_player NUMERIC(10,2) NOT NULL,
  status           VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tee_time (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  UUID         NOT NULL REFERENCES golf_course(id),
  tee_date   DATE         NOT NULL,
  tee_time   TIME         NOT NULL,
  max_players INT         NOT NULL DEFAULT 4,
  status     VARCHAR(20)  DEFAULT 'active',
  UNIQUE (course_id, tee_date, tee_time)
);

CREATE TABLE IF NOT EXISTS golf_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tee_time_id   UUID          NOT NULL REFERENCES tee_time(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  players       INT           NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tee_time_course_date ON tee_time(course_id, tee_date);
CREATE INDEX IF NOT EXISTS idx_golf_booking_tee     ON golf_booking(tee_time_id);
```

with:

```sql
CREATE TABLE IF NOT EXISTS golf_course (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID          NOT NULL REFERENCES property(id),
  name             VARCHAR(100)  NOT NULL,
  description      TEXT,
  holes            INT           NOT NULL,
  price_per_player NUMERIC(10,2) NOT NULL,
  status           VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tee_time (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  course_id   UUID         NOT NULL REFERENCES golf_course(id),
  tee_date    DATE         NOT NULL,
  tee_time    TIME         NOT NULL,
  max_players INT          NOT NULL DEFAULT 4,
  status      VARCHAR(20)  DEFAULT 'active',
  UNIQUE (course_id, tee_date, tee_time)
);

CREATE TABLE IF NOT EXISTS golf_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  tee_time_id   UUID          NOT NULL REFERENCES tee_time(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  players       INT           NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tee_time_course_date ON tee_time(course_id, tee_date);
CREATE INDEX IF NOT EXISTS idx_golf_booking_tee     ON golf_booking(tee_time_id);
CREATE INDEX IF NOT EXISTS idx_golf_course_property  ON golf_course(property_id);
CREATE INDEX IF NOT EXISTS idx_tee_time_property     ON tee_time(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_property ON golf_booking(property_id);
```

Also replace the `golf_booking_item` table definition further down the file:

```sql
CREATE TABLE IF NOT EXISTS golf_booking_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID          NOT NULL REFERENCES golf_booking(id) ON DELETE CASCADE,
  item_id     UUID          REFERENCES proshop_item(id),
  item_name   VARCHAR(100)  NOT NULL,
  quantity    INT           NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_golf_booking_item ON golf_booking_item(booking_id);
```

with:

```sql
CREATE TABLE IF NOT EXISTS golf_booking_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  booking_id  UUID          NOT NULL REFERENCES golf_booking(id) ON DELETE CASCADE,
  item_id     UUID          REFERENCES proshop_item(id),
  item_name   VARCHAR(100)  NOT NULL,
  quantity    INT           NOT NULL DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_golf_booking_item          ON golf_booking_item(booking_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-15-golf-property-scoping.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify the columns exist and reject NULL**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('golf_course','tee_time','golf_booking','golf_booking_item') AND column_name = 'property_id' ORDER BY table_name\");
  console.log(JSON.stringify(cols.rows, null, 2));
  try {
    await pool.query(\"INSERT INTO golf_course (name, holes, price_per_player) VALUES ('Bad Course', 18, 50)\");
    console.log('UNEXPECTED: insert without property_id succeeded');
  } catch (e) {
    console.log('Expected rejection:', e.message);
  }
  await pool.end();
})();
"
```
Expected: 4 rows, all `is_nullable: 'NO'`; the insert attempt fails with a `null value in column "property_id"` (or equivalent) error.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-15-golf-property-scoping.sql
git commit -m "Add property_id to golf_course, tee_time, golf_booking, golf_booking_item"
```

---

### Task 2: Scope routes and controllers, extend updateBooking, verify locally

**Files:**
- Modify: `src/routes/golf.js`
- Modify: `src/controllers/golf.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate`/`authenticateOrApiKey` from `src/middleware/auth.js` (already exported, unchanged), `property_id` from Task 1.
- Produces: no new exports — existing routes gain property scoping, a changed auth requirement, and `updateBooking` gains 3 new editable fields.

- [ ] **Step 1: Update the routes**

Replace the full contents of `src/routes/golf.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/golf');
const { requireApiKey } = require('../middleware/apiKey');

// Courses
router.get('/courses', ctrl.listCourses);
router.post('/courses', requireApiKey, ctrl.createCourse);
router.put('/courses/:id', requireApiKey, ctrl.updateCourse);

// Tee times
router.post('/tee-times/bulk', requireApiKey, ctrl.bulkCreateTeeTimes);
router.get('/tee-times/search', ctrl.searchTeeTimes);

// Bookings
router.get('/bookings', requireApiKey, ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', requireApiKey, ctrl.updateBooking);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/golf');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Courses
router.get('/courses', authenticate, ctrl.listCourses);
router.post('/courses', authenticate, ctrl.createCourse);
router.put('/courses/:id', authenticate, ctrl.updateCourse);

// Tee times
router.post('/tee-times/bulk', authenticate, ctrl.bulkCreateTeeTimes);
router.get('/tee-times/search', authenticate, ctrl.searchTeeTimes);

// Bookings
router.get('/bookings', authenticate, ctrl.listBookings);
router.post('/bookings', authenticateOrApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticate, ctrl.updateBooking);

module.exports = router;
```

- [ ] **Step 2: Scope the controller functions and extend `updateBooking`**

Replace the full contents of `src/controllers/golf.js`:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Courses ───────────────────────────────────────────────────────────────────

async function listCourses(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM golf_course WHERE status = 'active'");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player } = req.body;
    if (!name || !holes || price_per_player == null) {
      return res.status(400).json({ error: 'name, holes, and price_per_player are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO golf_course (name, description, holes, price_per_player) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description ?? null, holes, price_per_player]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE golf_course SET
         name             = COALESCE($1, name),
         description      = COALESCE($2, description),
         holes            = COALESCE($3, holes),
         price_per_player = COALESCE($4, price_per_player),
         status           = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [name, description, holes, price_per_player, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Course not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tee times ─────────────────────────────────────────────────────────────────

async function bulkCreateTeeTimes(req, res, next) {
  try {
    const { course_id, from, to, times, max_players } = req.body;
    if (!course_id || !from || !to || !Array.isArray(times) || !times.length || !max_players) {
      return res.status(400).json({ error: 'course_id, from, to, times array, and max_players are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tee_time (course_id, tee_date, tee_time, max_players)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (course_id, tee_date, tee_time) DO NOTHING
           RETURNING *`,
          [course_id, date, time, max_players]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, tee_times: created });
  } catch (err) { next(err); }
}

async function searchTeeTimes(req, res, next) {
  try {
    const { date, from, to, course_id, players } = req.query;

    // Support single date or date range
    const start = from || date;
    const end = to || date;
    if (!start) return res.status(400).json({ error: 'date or from/to is required' });
    if (!isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT tt.*, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS booked_players,
             tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS available_spots
      FROM tee_time tt
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking gb ON gb.tee_time_id = tt.id
      WHERE tt.tee_date >= $1
        AND tt.tee_date <= $2
        AND tt.status = 'active'
        AND gc.status = 'active'
    `;
    const params = [start, end];
    if (course_id) { params.push(course_id); query += ` AND tt.course_id = $${params.length}`; }
    query += ' GROUP BY tt.id, gc.id';
    if (players) { query += ` HAVING tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) >= ${parseInt(players, 10)}`; }
    query += ' ORDER BY tt.tee_date, tt.tee_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id, skip, take } = req.query;
    let query = `
      SELECT gb.*, tt.tee_date, tt.tee_time, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(json_agg(json_build_object(
               'id', gbi.id, 'item_id', gbi.item_id, 'item_name', gbi.item_name,
               'quantity', gbi.quantity, 'unit_price', gbi.unit_price,
               'total', (gbi.quantity * gbi.unit_price)
             )) FILTER (WHERE gbi.id IS NOT NULL), '[]') AS proshop_items
      FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking_item gbi ON gbi.booking_id = gb.id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND tt.tee_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND gb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND gb.guest_id = $${params.length}`; }
    query += ' GROUP BY gb.id, tt.tee_date, tt.tee_time, gc.name, gc.holes, gc.price_per_player';
    query += ' ORDER BY tt.tee_date, tt.tee_time';

    const [{ rows: countRows }] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT gb.id) AS total FROM golf_booking gb
        JOIN tee_time tt ON tt.id = gb.tee_time_id
        WHERE 1=1
        ${date     ? ` AND tt.tee_date = $1` : ''}
        ${status   ? ` AND gb.status = $${date ? 2 : 1}` : ''}
        ${guest_id ? ` AND gb.guest_id = $${[date, status].filter(Boolean).length + 1}` : ''}
      `, [date, status, guest_id].filter(Boolean))
    ]);

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, notes } = req.body;
  if (!tee_time_id || !contact_name || !players) {
    return res.status(400).json({ error: 'tee_time_id, contact_name, and players are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ttRes = await client.query(
      `SELECT tt.*, gc.price_per_player FROM tee_time tt
       JOIN golf_course gc ON gc.id = tt.course_id WHERE tt.id = $1`, [tee_time_id]
    );
    if (!ttRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tee time not found' }); }

    const tt = ttRes.rows[0];
    const bookedRes = await client.query(
      `SELECT COALESCE(SUM(players), 0) AS booked FROM golf_booking WHERE tee_time_id = $1 AND status != 'cancelled'`,
      [tee_time_id]
    );
    const booked = parseInt(bookedRes.rows[0].booked, 10);
    const available = tt.max_players - booked;
    if (players > available) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${available} spots remaining` });
    }

    const total_price = parseFloat(tt.price_per_player) * players;
    const { rows } = await client.query(
      `INSERT INTO golf_booking (tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tee_time_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, players, total_price.toFixed(2), notes ?? null]
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

async function updateBooking(req, res, next) {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE golf_booking SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listCourses, createCourse, updateCourse,
  bulkCreateTeeTimes, searchTeeTimes,
  listBookings, createBooking, updateBooking,
};
```

with:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Courses ───────────────────────────────────────────────────────────────────

async function listCourses(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM golf_course WHERE status = 'active' AND property_id = $1",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player } = req.body;
    if (!name || !holes || price_per_player == null) {
      return res.status(400).json({ error: 'name, holes, and price_per_player are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO golf_course (property_id, name, description, holes, price_per_player) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, name, description ?? null, holes, price_per_player]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateCourse(req, res, next) {
  try {
    const { name, description, holes, price_per_player, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE golf_course SET
         name             = COALESCE($1, name),
         description      = COALESCE($2, description),
         holes            = COALESCE($3, holes),
         price_per_player = COALESCE($4, price_per_player),
         status           = COALESCE($5, status)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [name, description, holes, price_per_player, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Course not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tee times ─────────────────────────────────────────────────────────────────

async function bulkCreateTeeTimes(req, res, next) {
  try {
    const { course_id, from, to, times, max_players } = req.body;
    if (!course_id || !from || !to || !Array.isArray(times) || !times.length || !max_players) {
      return res.status(400).json({ error: 'course_id, from, to, times array, and max_players are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const courseRes = await pool.query('SELECT id FROM golf_course WHERE id = $1 AND property_id = $2', [course_id, req.property_id]);
    if (!courseRes.rows.length) return res.status(404).json({ error: 'Course not found' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (course_id, tee_date, tee_time) DO NOTHING
           RETURNING *`,
          [req.property_id, course_id, date, time, max_players]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, tee_times: created });
  } catch (err) { next(err); }
}

async function searchTeeTimes(req, res, next) {
  try {
    const { date, from, to, course_id, players } = req.query;

    // Support single date or date range
    const start = from || date;
    const end = to || date;
    if (!start) return res.status(400).json({ error: 'date or from/to is required' });
    if (!isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT tt.*, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS booked_players,
             tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) AS available_spots
      FROM tee_time tt
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking gb ON gb.tee_time_id = tt.id
      WHERE tt.tee_date >= $1
        AND tt.tee_date <= $2
        AND tt.status = 'active'
        AND gc.status = 'active'
        AND tt.property_id = $3
    `;
    const params = [start, end, req.property_id];
    if (course_id) { params.push(course_id); query += ` AND tt.course_id = $${params.length}`; }
    query += ' GROUP BY tt.id, gc.id';
    if (players) { query += ` HAVING tt.max_players - COALESCE(SUM(gb.players) FILTER (WHERE gb.status != 'cancelled'), 0) >= ${parseInt(players, 10)}`; }
    query += ' ORDER BY tt.tee_date, tt.tee_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id, skip, take } = req.query;
    let query = `
      SELECT gb.*, tt.tee_date, tt.tee_time, gc.name AS course_name, gc.holes, gc.price_per_player,
             COALESCE(json_agg(json_build_object(
               'id', gbi.id, 'item_id', gbi.item_id, 'item_name', gbi.item_name,
               'quantity', gbi.quantity, 'unit_price', gbi.unit_price,
               'total', (gbi.quantity * gbi.unit_price)
             )) FILTER (WHERE gbi.id IS NOT NULL), '[]') AS proshop_items
      FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      JOIN golf_course gc ON gc.id = tt.course_id
      LEFT JOIN golf_booking_item gbi ON gbi.booking_id = gb.id
      WHERE gb.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND tt.tee_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND gb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND gb.guest_id = $${params.length}`; }
    query += ' GROUP BY gb.id, tt.tee_date, tt.tee_time, gc.name, gc.holes, gc.price_per_player';
    query += ' ORDER BY tt.tee_date, tt.tee_time';

    const countParams = [req.property_id, date, status, guest_id].filter(Boolean);
    const { rows: countRows } = await pool.query(`SELECT COUNT(DISTINCT gb.id) AS total FROM golf_booking gb
      JOIN tee_time tt ON tt.id = gb.tee_time_id
      WHERE gb.property_id = $1
      ${date     ? ` AND tt.tee_date = $${[req.property_id, date].filter(Boolean).length}` : ''}
      ${status   ? ` AND gb.status = $${[req.property_id, date, status].filter(Boolean).length}` : ''}
      ${guest_id ? ` AND gb.guest_id = $${countParams.length}` : ''}
    `, countParams);

    if (take) { params.push(parseInt(take, 10)); query += ` LIMIT $${params.length}`; }
    if (skip) { params.push(parseInt(skip, 10)); query += ` OFFSET $${params.length}`; }
    const { rows } = await pool.query(query, params);
    res.json({ total: parseInt(countRows[0].total, 10), data: rows });
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, notes } = req.body;
  if (!tee_time_id || !contact_name || !players) {
    return res.status(400).json({ error: 'tee_time_id, contact_name, and players are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ttRes = await client.query(
      `SELECT tt.*, gc.price_per_player FROM tee_time tt
       JOIN golf_course gc ON gc.id = tt.course_id WHERE tt.id = $1 AND tt.property_id = $2`,
      [tee_time_id, req.property_id]
    );
    if (!ttRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tee time not found' }); }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

    const tt = ttRes.rows[0];
    const bookedRes = await client.query(
      `SELECT COALESCE(SUM(players), 0) AS booked FROM golf_booking WHERE tee_time_id = $1 AND status != 'cancelled'`,
      [tee_time_id]
    );
    const booked = parseInt(bookedRes.rows[0].booked, 10);
    const available = tt.max_players - booked;
    if (players > available) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${available} spots remaining` });
    }

    const total_price = parseFloat(tt.price_per_player) * players;
    const { rows } = await client.query(
      `INSERT INTO golf_booking (property_id, tee_time_id, guest_id, contact_name, contact_email, contact_phone, players, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, tee_time_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, players, total_price.toFixed(2), notes ?? null]
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

async function updateBooking(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE golf_booking SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listCourses, createCourse, updateCourse,
  bulkCreateTeeTimes, searchTeeTimes,
  listBookings, createBooking, updateBooking,
};
```

- [ ] **Step 3: Update Swagger**

Replace:

```js
    // ── Golf ─────────────────────────────────────────────────────────────────
    '/api/golf/courses': {
      get: { tags: ['Golf'], summary: 'List courses', responses: { 200: { description: 'Array of courses' } } },
      post: { tags: ['Golf'], summary: 'Create course', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'holes', 'price_per_player'], properties: { name: { type: 'string' }, description: { type: 'string' }, holes: { type: 'integer' }, price_per_player: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/golf/tee-times/bulk': {
      post: { tags: ['Golf'], summary: 'Bulk generate tee times', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['course_id', 'from', 'to', 'times', 'max_players'], properties: { course_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } }, max_players: { type: 'integer', default: 4 } } } } } }, responses: { 201: { description: 'Tee times created' } } },
    },
    '/api/golf/tee-times/search': {
      get: { tags: ['Golf'], summary: 'Search available tee times', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'course_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'players', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available tee times with spots' } } },
    },
    '/api/golf/bookings': {
      get: { tags: ['Golf'], summary: 'List golf bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Golf'], summary: 'Book a tee time', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tee_time_id', 'contact_name', 'players'], properties: { tee_time_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, players: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Not enough spots' } } },
    },
```

with:

```js
    // ── Golf ─────────────────────────────────────────────────────────────────
    '/api/golf/courses': {
      get: { tags: ['Golf'], summary: 'List courses', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of courses' } } },
      post: { tags: ['Golf'], summary: 'Create course', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'holes', 'price_per_player'], properties: { name: { type: 'string' }, description: { type: 'string' }, holes: { type: 'integer' }, price_per_player: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/golf/courses/{id}': {
      put: { tags: ['Golf'], summary: 'Update course', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, holes: { type: 'integer' }, price_per_player: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/golf/tee-times/bulk': {
      post: { tags: ['Golf'], summary: 'Bulk generate tee times', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['course_id', 'from', 'to', 'times', 'max_players'], properties: { course_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } }, max_players: { type: 'integer', default: 4 } } } } } }, responses: { 201: { description: 'Tee times created' }, 404: { description: 'Course not found' } } },
    },
    '/api/golf/tee-times/search': {
      get: { tags: ['Golf'], summary: 'Search available tee times', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'course_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'players', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available tee times with spots' } } },
    },
    '/api/golf/bookings': {
      get: { tags: ['Golf'], summary: 'List golf bookings', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Golf'], summary: 'Book a tee time', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tee_time_id', 'contact_name', 'players'], properties: { tee_time_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, players: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 404: { description: 'Tee time or guest not found' }, 409: { description: 'Not enough spots' } } },
    },
    '/api/golf/bookings/{id}': {
      put: { tags: ['Golf'], summary: 'Update golf booking', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Insert a "foreign" course under BBYC for cross-property checks**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  \"INSERT INTO golf_course (property_id, name, holes, price_per_player) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Course', 18, 50) RETURNING id\"
).then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_course_id.txt
cat /tmp/foreign_course_id.txt
```

- [ ] **Step 6: Mint a Robs token, verify `GET /courses` requires auth and is scoped**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- no auth (was public) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/golf/courses

echo "--- with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/golf/courses -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401 {"error":"Missing or invalid Authorization header"}`; with token → `200`, an array not containing "Foreign Course" (BBYC's course is invisible to Robs).

- [ ] **Step 7: Verify `POST /api/golf/courses` — creation, scoping, and old shared key rejected**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- create with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/courses -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Pirates Bight Links","holes":18,"price_per_player":85}'

echo "--- old shared API_KEY (X-Api-Key, no bearer) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/courses -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" -d '{"name":"Should Fail","holes":9,"price_per_player":20}'
```
Expected: Robs's token → `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"` — save the returned `id` as `COURSE_ID`. Old shared key → `401 {"error":"Missing or invalid Authorization header"}` (confirms full replacement, not additive).

- [ ] **Step 8: Verify `PUT /api/golf/courses/:id` — edit own course, cross-property 404**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)
COURSE_ID="<the id from Step 7>"
FOREIGN_COURSE_ID=$(cat /tmp/foreign_course_id.txt)

echo "--- edit own course ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/golf/courses/$COURSE_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"price_per_player":95}'

echo "--- edit the foreign (BBYC) course ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/golf/courses/$FOREIGN_COURSE_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"price_per_player":1}'
```
Expected: own course → `200`, `"price_per_player":"95.00"`; foreign course → `404 {"error":"Course not found"}`.

- [ ] **Step 9: Verify `POST /api/golf/tee-times/bulk` — success and cross-property 404**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)
COURSE_ID="<the id from Step 7>"
FOREIGN_COURSE_ID=$(cat /tmp/foreign_course_id.txt)

echo "--- bulk create for Robs's own course ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/tee-times/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"course_id\":\"$COURSE_ID\",\"from\":\"2026-09-01\",\"to\":\"2026-09-01\",\"times\":[\"08:00\",\"09:30\"],\"max_players\":4}"

echo "--- bulk create for the foreign (BBYC) course ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/tee-times/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"course_id\":\"$FOREIGN_COURSE_ID\",\"from\":\"2026-09-01\",\"to\":\"2026-09-01\",\"times\":[\"08:00\"],\"max_players\":4}"
```
Expected: own course → `201 {"created":2,...}`; foreign course → `404 {"error":"Course not found"}`.

- [ ] **Step 10: Verify `GET /api/golf/tee-times/search` — auth required, scoped**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- no auth (was public) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/golf/tee-times/search?date=2026-09-01"

echo "--- with token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/golf/tee-times/search?date=2026-09-01" -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401`; with token → `200`, array of 2 tee times from Step 9 (`08:00`, `09:30`), each with `available_spots: 4`. Save one tee time's `id` as `TEE_TIME_ID`.

- [ ] **Step 11: Verify `POST /api/golf/bookings` via `X-Api-Key` — success, fake tee time 404, cross-property guest 404**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)
TEE_TIME_ID="<a tee time id from Step 10>"

echo "--- book Robs's own tee time ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/bookings -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d "{\"tee_time_id\":\"$TEE_TIME_ID\",\"contact_name\":\"Golf Booking Test\",\"players\":2}"

echo "--- attempt to book a made-up tee_time_id (proxy for cross-property) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/bookings -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"tee_time_id":"00000000-0000-0000-0000-000000000000","contact_name":"Should Fail","players":2}'
```
Expected: own tee time → `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"`, `total_price` reflects `players * price_per_player`. Save the returned `id` as `BOOKING_ID`. Fake tee time → `404 {"error":"Tee time not found"}`.

For the guest cross-property check, find a real BBYC guest first:
```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id FROM guest WHERE property_id = 'e1000000-0000-0000-0000-000000000004' LIMIT 1\")
  .then(r => { console.log(r.rows.length ? r.rows[0].id : 'NO_BBYC_GUEST'); pool.end(); });
"
```
If a BBYC guest id is printed (not `NO_BBYC_GUEST`), run:
```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)
BBYC_GUEST_ID="<the id just printed>"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/golf/bookings -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d "{\"tee_time_id\":\"$TEE_TIME_ID\",\"guest_id\":\"$BBYC_GUEST_ID\",\"contact_name\":\"Cross Property Guest Test\",\"players\":1}"
```
Expected: `404 {"error":"Guest not found"}`. If no BBYC guest exists, skip this specific check and note it as skipped — not a blocker, the tee-time-ownership check (already verified) exercises the same `req.property_id` mechanism.

- [ ] **Step 12: Verify `PUT /api/golf/bookings/:id` — extended contact fields persist, cross-property 404**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)
BOOKING_ID="<the id from Step 11>"

echo "--- edit contact fields on own booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/golf/bookings/$BOOKING_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"contact_name":"Updated Name","contact_email":"updated@example.com","contact_phone":"555-0100","notes":"Prefers cart"}'

echo "--- attempt to edit a made-up booking id (proxy for cross-property) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/golf/bookings/00000000-0000-0000-0000-000000000000 -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"notes":"Should fail"}'
```
Expected: own booking → `200`, `contact_name`/`contact_email`/`contact_phone`/`notes` all reflect the new values (proves the field extension actually landed, not just `status`/`notes`). Made-up id → `404 {"error":"Booking not found"}`.

- [ ] **Step 13: Verify `GET /api/golf/bookings` — auth required, scoped**

```bash
node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  const tok = await client.sessions.getToken(session.id);
  console.log(tok.jwt);
})();
" > /tmp/tok.txt
CLERK_TOKEN=$(cat /tmp/tok.txt)

echo "--- old shared API_KEY (was requireApiKey) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/golf/bookings -H "X-Api-Key: $OLD_SHARED_KEY"

echo "--- with Robs's Clerk token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/golf/bookings -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: old shared key → `401` (confirms full replacement); Robs's token → `200`, `data` includes the booking from Step 11/12 with the updated contact fields, and `total` is a positive integer matching `data.length` (validates the hand-adjusted parameterized count query in `listBookings` — its `$N` placeholders were re-indexed to account for `req.property_id` always being `$1` — actually returns a correct count rather than erroring or silently mismatching `data`).

- [ ] **Step 14: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_key.txt /tmp/foreign_course_id.txt
git add src/routes/golf.js src/controllers/golf.js src/docs/swagger.js
git commit -m "Scope golf module to property_id, extend updateBooking contact fields, switch booking creation to authenticateOrApiKey"
```

---

### Task 3: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-2's commits and `src/db/migrate-2026-08-15-golf-property-scoping.sql`.

- [ ] **Step 1: Confirm with the user before altering the live schema**

Per Global Constraints.

- [ ] **Step 2: Apply the migration to the live database**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-15-golf-property-scoping.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify the columns on live**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('golf_course','tee_time','golf_booking','golf_booking_item') AND column_name = 'property_id' ORDER BY table_name\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: 4 rows, all `is_nullable: 'NO'`.

- [ ] **Step 4: Confirm with the user before pushing**

Per Global Constraints — triggers a live Render redeploy.

- [ ] **Step 5: Push**

```bash
git push origin main
```

- [ ] **Step 6: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log(j.paths['/api/golf/courses'].get.security ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 7: Verify live — auth required, and a booking round-trip via FORGE's key**

This needs a live Clerk admin token for FORGE, which requires the browser-based sign-in-ticket flow (the dev-only `sessions.createSession` shortcut doesn't work on live). Use whichever browser automation MCP tool is connected at execution time, following the same recipe used in every prior live-verification task this session (mint a sign-in ticket via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key from `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, navigate with `redirect_url=https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`).

If no browser tool is connected when this step is reached, stop and ask the user how to proceed (wait for reconnection, have them supply a token, or skip this specific step) rather than skipping silently.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/golf/courses

echo "--- create a course with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/golf/courses -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"name":"Live Verify Course","holes":18,"price_per_player":80}'
```
Expected: no-auth → `401`; create → `201`, `"property_id":"b7a4c969-5e82-4c26-a587-17d2ab74858e"` (FORGE).

- [ ] **Step 8: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
