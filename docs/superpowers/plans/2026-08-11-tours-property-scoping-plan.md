# Tours Property Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `property_id` to `tour`/`tour_slot`/`tour_booking`, scope every tours route to it, and switch guest-facing booking creation to `authenticateOrApiKey` — per `docs/superpowers/specs/2026-08-10-tours-property-scoping-design.md`.

**Architecture:** Direct `property_id UUID NOT NULL REFERENCES property(id)` on all 3 tables (no parent-chain joins). `GET /` and `GET /slots/search` switch from fully public to `authenticate`-only. `POST /`, `PUT /:id`, `POST /slots/bulk`, `GET /bookings`, `PUT /bookings/:id` switch from the old shared `requireApiKey` to `authenticate`. `POST /bookings` switches from `requireApiKey` to `authenticateOrApiKey`. No backfill — both databases have zero tour rows.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL.

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm run dev` server, matching every prior plan.
- **Confirm with the user before**: running the migration against the live database, and before `git push origin main` (triggers a live Render redeploy).
- Today's date: **2026-08-11**.
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
- **Cross-property checks don't need a second staff identity** — insert a "foreign" tour directly via SQL under a different existing property (e.g. BBYC, `e1000000-0000-0000-0000-000000000004`) and confirm Robs's token can't reach it. This avoids needing to mint a second Clerk user/org.
- Get Robs's current API key fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'` — it's been rotated multiple times in prior sessions.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`.
- **Scope:** exactly the 3 tables and 8 routes in the design doc. No change to any other module.

---

### Task 1: Migration — add `property_id` to all 3 tour tables

**Files:**
- Create: `src/db/migrate-2026-08-11-tours-property-scoping.sql`
- Modify: `src/db/schema.sql` (the `tour`, `tour_slot`, `tour_booking` table definitions)

**Interfaces:**
- Produces: `tour.property_id`, `tour_slot.property_id`, `tour_booking.property_id` (all `UUID NOT NULL REFERENCES property(id)`) — Task 2's controller changes query these directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-11-tours-property-scoping.sql`:

```sql
-- One-time migration: add property_id to tour, tour_slot, and tour_booking,
-- scoping the tours module to a property for the first time. No backfill
-- needed -- both the local and live databases have zero rows in all three
-- tables (confirmed before writing this migration), so NOT NULL is safe
-- to add directly with no DEFAULT. Idempotent-safe via IF NOT EXISTS. Run
-- ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline).

ALTER TABLE tour         ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_slot    ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_booking ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_tour_property         ON tour(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_slot_property     ON tour_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_booking_property  ON tour_booking(property_id);
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

```sql
CREATE TABLE IF NOT EXISTS tour (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(100)  NOT NULL,
  description    TEXT,
  duration_mins  INT           NOT NULL,
  max_group_size INT           NOT NULL,
  price          NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tour_slot (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id   UUID         NOT NULL REFERENCES tour(id),
  slot_date DATE         NOT NULL,
  slot_time TIME         NOT NULL,
  status    VARCHAR(20)  DEFAULT 'active',
  UNIQUE (tour_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS tour_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id       UUID          NOT NULL REFERENCES tour_slot(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  group_size    INT           NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);
```

with:

```sql
CREATE TABLE IF NOT EXISTS tour (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID          NOT NULL REFERENCES property(id),
  name           VARCHAR(100)  NOT NULL,
  description    TEXT,
  duration_mins  INT           NOT NULL,
  max_group_size INT           NOT NULL,
  price          NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tour_slot (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  tour_id     UUID         NOT NULL REFERENCES tour(id),
  slot_date   DATE         NOT NULL,
  slot_time   TIME         NOT NULL,
  status      VARCHAR(20)  DEFAULT 'active',
  UNIQUE (tour_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS tour_booking (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  slot_id       UUID          NOT NULL REFERENCES tour_slot(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  group_size    INT           NOT NULL,
  total_price   NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ   DEFAULT now()
);
```

Also add the 3 new indexes near the existing tour indexes — replace:

```sql
CREATE INDEX IF NOT EXISTS idx_tour_slot_tour_date  ON tour_slot(tour_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_tour_booking_slot    ON tour_booking(slot_id);
```

with:

```sql
CREATE INDEX IF NOT EXISTS idx_tour_slot_tour_date  ON tour_slot(tour_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_tour_booking_slot    ON tour_booking(slot_id);
CREATE INDEX IF NOT EXISTS idx_tour_property         ON tour(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_slot_property     ON tour_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_booking_property  ON tour_booking(property_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-11-tours-property-scoping.sql', 'utf8'));
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
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('tour','tour_slot','tour_booking') AND column_name = 'property_id' ORDER BY table_name\");
  console.log(JSON.stringify(cols.rows, null, 2));
  try {
    await pool.query(\"INSERT INTO tour (name, duration_mins, max_group_size, price) VALUES ('Bad Tour', 60, 4, 50)\");
    console.log('UNEXPECTED: insert without property_id succeeded');
  } catch (e) {
    console.log('Expected rejection:', e.message);
  }
  await pool.end();
})();
"
```
Expected: 3 rows, all `is_nullable: 'NO'`; the insert attempt fails with a `null value in column "property_id"` (or equivalent) error.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-11-tours-property-scoping.sql
git commit -m "Add property_id to tour, tour_slot, tour_booking"
```

---

### Task 2: Scope routes and controllers, verify locally

**Files:**
- Modify: `src/routes/tours.js`
- Modify: `src/controllers/tours.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate`/`authenticateOrApiKey` from `src/middleware/auth.js` (already exported, unchanged), `property_id` from Task 1.
- Produces: no new exports — existing routes gain property scoping and a changed auth requirement.

- [ ] **Step 1: Update the routes**

Replace the full contents of `src/routes/tours.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/tours');
const { requireApiKey } = require('../middleware/apiKey');

// Tours
router.get('/', ctrl.listTours);
router.post('/', requireApiKey, ctrl.createTour);
router.put('/:id', requireApiKey, ctrl.updateTour);

// Slots
router.post('/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Bookings
router.get('/bookings', requireApiKey, ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', requireApiKey, ctrl.updateBooking);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/tours');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Tours
router.get('/', authenticate, ctrl.listTours);
router.post('/', authenticate, ctrl.createTour);
router.put('/:id', authenticate, ctrl.updateTour);

// Slots
router.post('/slots/bulk', authenticate, ctrl.bulkCreateSlots);
router.get('/slots/search', authenticate, ctrl.searchSlots);

// Bookings
router.get('/bookings', authenticate, ctrl.listBookings);
router.post('/bookings', authenticateOrApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticate, ctrl.updateBooking);

module.exports = router;
```

- [ ] **Step 2: Scope the controller functions**

Replace the full contents of `src/controllers/tours.js`:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Tours ─────────────────────────────────────────────────────────────────────

async function listTours(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM tour WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price } = req.body;
    if (!name || !duration_mins || !max_group_size || !price) {
      return res.status(400).json({ error: 'name, duration_mins, max_group_size, and price are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO tour (name, description, duration_mins, max_group_size, price)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, description ?? null, duration_mins, max_group_size, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE tour SET
         name           = COALESCE($1, name),
         description    = COALESCE($2, description),
         duration_mins  = COALESCE($3, duration_mins),
         max_group_size = COALESCE($4, max_group_size),
         price          = COALESCE($5, price),
         status         = COALESCE($6, status)
       WHERE id = $7 RETURNING *`,
      [name, description, duration_mins, max_group_size, price, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tour not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tour slots ────────────────────────────────────────────────────────────────

async function bulkCreateSlots(req, res, next) {
  try {
    const { tour_id, from, to, times } = req.body;
    if (!tour_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'tour_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tour_slot (tour_id, slot_date, slot_time)
           VALUES ($1, $2, $3)
           ON CONFLICT (tour_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [tour_id, date, time]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, slots: created });
  } catch (err) { next(err); }
}

async function searchSlots(req, res, next) {
  try {
    const { date, tour_id, group_size } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ts.*, t.name AS tour_name, t.description, t.duration_mins,
             t.max_group_size, t.price,
             COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) AS booked_seats,
             t.max_group_size - COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) AS available_seats
      FROM tour_slot ts
      JOIN tour t ON t.id = ts.tour_id
      LEFT JOIN tour_booking tb ON tb.slot_id = ts.id
      WHERE ts.slot_date = $1
        AND ts.status = 'active'
        AND t.status = 'active'
    `;
    const params = [date];
    if (tour_id) { params.push(tour_id); query += ` AND ts.tour_id = $${params.length}`; }
    query += ` GROUP BY ts.id, t.id`;
    if (group_size) { query += ` HAVING t.max_group_size - COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) >= ${parseInt(group_size, 10)}`; }
    query += ' ORDER BY ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT tb.*, ts.slot_date, ts.slot_time, t.name AS tour_name, t.price
      FROM tour_booking tb
      JOIN tour_slot ts ON ts.id = tb.slot_id
      JOIN tour t ON t.id = ts.tour_id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND ts.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND tb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND tb.guest_id = $${params.length}`; }
    query += ' ORDER BY ts.slot_date, ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, notes } = req.body;
  if (!slot_id || !contact_name || !group_size) {
    return res.status(400).json({ error: 'slot_id, contact_name, and group_size are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ts.*, t.max_group_size, t.price
       FROM tour_slot ts JOIN tour t ON t.id = ts.tour_id
       WHERE ts.id = $1`, [slot_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }

    const slot = slotRes.rows[0];
    const bookedRes = await client.query(
      `SELECT COALESCE(SUM(group_size), 0) AS booked FROM tour_booking WHERE slot_id = $1 AND status != 'cancelled'`,
      [slot_id]
    );
    const booked = parseInt(bookedRes.rows[0].booked, 10);
    if (booked + group_size > slot.max_group_size) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${slot.max_group_size - booked} spots remaining` });
    }

    const total_price = parseFloat(slot.price) * group_size;
    const { rows } = await client.query(
      `INSERT INTO tour_booking (slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, group_size, total_price.toFixed(2), notes ?? null]
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
      `UPDATE tour_booking SET
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
  listTours, createTour, updateTour,
  bulkCreateSlots, searchSlots,
  listBookings, createBooking, updateBooking,
};
```

with:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Tours ─────────────────────────────────────────────────────────────────────

async function listTours(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM tour WHERE status = 'active' AND property_id = $1 ORDER BY name",
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price } = req.body;
    if (!name || !duration_mins || !max_group_size || !price) {
      return res.status(400).json({ error: 'name, duration_mins, max_group_size, and price are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO tour (property_id, name, description, duration_mins, max_group_size, price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, name, description ?? null, duration_mins, max_group_size, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTour(req, res, next) {
  try {
    const { name, description, duration_mins, max_group_size, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE tour SET
         name           = COALESCE($1, name),
         description    = COALESCE($2, description),
         duration_mins  = COALESCE($3, duration_mins),
         max_group_size = COALESCE($4, max_group_size),
         price          = COALESCE($5, price),
         status         = COALESCE($6, status)
       WHERE id = $7 AND property_id = $8 RETURNING *`,
      [name, description, duration_mins, max_group_size, price, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tour not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Tour slots ────────────────────────────────────────────────────────────────

async function bulkCreateSlots(req, res, next) {
  try {
    const { tour_id, from, to, times } = req.body;
    if (!tour_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'tour_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const tourRes = await pool.query('SELECT id FROM tour WHERE id = $1 AND property_id = $2', [tour_id, req.property_id]);
    if (!tourRes.rows.length) return res.status(404).json({ error: 'Tour not found' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO tour_slot (property_id, tour_id, slot_date, slot_time)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tour_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [req.property_id, tour_id, date, time]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, slots: created });
  } catch (err) { next(err); }
}

async function searchSlots(req, res, next) {
  try {
    const { date, tour_id, group_size } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ts.*, t.name AS tour_name, t.description, t.duration_mins,
             t.max_group_size, t.price,
             COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) AS booked_seats,
             t.max_group_size - COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) AS available_seats
      FROM tour_slot ts
      JOIN tour t ON t.id = ts.tour_id
      LEFT JOIN tour_booking tb ON tb.slot_id = ts.id
      WHERE ts.slot_date = $1
        AND ts.status = 'active'
        AND t.status = 'active'
        AND ts.property_id = $2
    `;
    const params = [date, req.property_id];
    if (tour_id) { params.push(tour_id); query += ` AND ts.tour_id = $${params.length}`; }
    query += ` GROUP BY ts.id, t.id`;
    if (group_size) { query += ` HAVING t.max_group_size - COALESCE(SUM(tb.group_size) FILTER (WHERE tb.status != 'cancelled'), 0) >= ${parseInt(group_size, 10)}`; }
    query += ' ORDER BY ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT tb.*, ts.slot_date, ts.slot_time, t.name AS tour_name, t.price
      FROM tour_booking tb
      JOIN tour_slot ts ON ts.id = tb.slot_id
      JOIN tour t ON t.id = ts.tour_id
      WHERE tb.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND ts.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND tb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND tb.guest_id = $${params.length}`; }
    query += ' ORDER BY ts.slot_date, ts.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, notes } = req.body;
  if (!slot_id || !contact_name || !group_size) {
    return res.status(400).json({ error: 'slot_id, contact_name, and group_size are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ts.*, t.max_group_size, t.price
       FROM tour_slot ts JOIN tour t ON t.id = ts.tour_id
       WHERE ts.id = $1 AND ts.property_id = $2`, [slot_id, req.property_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

    const slot = slotRes.rows[0];
    const bookedRes = await client.query(
      `SELECT COALESCE(SUM(group_size), 0) AS booked FROM tour_booking WHERE slot_id = $1 AND status != 'cancelled'`,
      [slot_id]
    );
    const booked = parseInt(bookedRes.rows[0].booked, 10);
    if (booked + group_size > slot.max_group_size) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${slot.max_group_size - booked} spots remaining` });
    }

    const total_price = parseFloat(slot.price) * group_size;
    const { rows } = await client.query(
      `INSERT INTO tour_booking (property_id, slot_id, guest_id, contact_name, contact_email, contact_phone, group_size, total_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.property_id, slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, group_size, total_price.toFixed(2), notes ?? null]
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
      `UPDATE tour_booking SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 AND property_id = $4 RETURNING *`,
      [status, notes, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listTours, createTour, updateTour,
  bulkCreateSlots, searchSlots,
  listBookings, createBooking, updateBooking,
};
```

- [ ] **Step 3: Update Swagger**

Replace:

```js
    // ── Tours ────────────────────────────────────────────────────────────────
    '/api/tours': {
      get: { tags: ['Tours'], summary: 'List tours', responses: { 200: { description: 'Array of tours' } } },
      post: { tags: ['Tours'], summary: 'Create tour', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'max_group_size', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, max_group_size: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/tours/slots/bulk': {
      post: { tags: ['Tours'], summary: 'Bulk generate tour slots', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tour_id', 'from', 'to', 'times'], properties: { tour_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } } } } } } }, responses: { 201: { description: 'Slots created' } } },
    },
    '/api/tours/slots/search': {
      get: { tags: ['Tours'], summary: 'Search available tour slots', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'tour_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'group_size', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available slots with capacity info' } } },
    },
    '/api/tours/bookings': {
      get: { tags: ['Tours'], summary: 'List tour bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Tours'], summary: 'Book a tour', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name', 'group_size'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, group_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Not enough spots' } } },
    },
```

with:

```js
    // ── Tours ────────────────────────────────────────────────────────────────
    '/api/tours': {
      get: { tags: ['Tours'], summary: 'List tours', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of tours' } } },
      post: { tags: ['Tours'], summary: 'Create tour', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'max_group_size', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, max_group_size: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/tours/slots/bulk': {
      post: { tags: ['Tours'], summary: 'Bulk generate tour slots', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tour_id', 'from', 'to', 'times'], properties: { tour_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } } } } } } }, responses: { 201: { description: 'Slots created' }, 404: { description: 'Tour not found' } } },
    },
    '/api/tours/slots/search': {
      get: { tags: ['Tours'], summary: 'Search available tour slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'tour_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'group_size', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available slots with capacity info' } } },
    },
    '/api/tours/bookings': {
      get: { tags: ['Tours'], summary: 'List tour bookings', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Tours'], summary: 'Book a tour', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name', 'group_size'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, group_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 404: { description: 'Slot or guest not found' }, 409: { description: 'Not enough spots' } } },
    },
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Insert a "foreign" tour under BBYC for cross-property checks**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  \"INSERT INTO tour (property_id, name, duration_mins, max_group_size, price) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Tour', 60, 4, 50) RETURNING id\"
).then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_tour_id.txt
cat /tmp/foreign_tour_id.txt
```

- [ ] **Step 6: Mint a Robs token, verify `GET /` requires auth and is scoped**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/tours

echo "--- with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/tours -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401 {"error":"Missing or invalid Authorization header"}`; with token → `200`, an array not containing "Foreign Tour" (BBYC's tour is invisible to Robs).

- [ ] **Step 7: Verify `POST /api/tours` — creation, scoping, and old shared key rejected**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Snorkel Tour","duration_mins":120,"max_group_size":8,"price":75}'

echo "--- old shared API_KEY (X-Api-Key, no bearer) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" -d '{"name":"Should Fail","duration_mins":60,"max_group_size":4,"price":50}'
```
Expected: Robs's token → `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"` — save the returned `id` as `TOUR_ID`. Old shared key → `401 {"error":"Missing or invalid Authorization header"}` (confirms full replacement, not additive — this route no longer recognizes `X-Api-Key` at all, unlike the `authenticateOrApiKey` routes).

- [ ] **Step 8: Verify `POST /api/tours/slots/bulk` — success and cross-property 404**

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
TOUR_ID="<the id from Step 7>"
FOREIGN_TOUR_ID=$(cat /tmp/foreign_tour_id.txt)

echo "--- bulk create for Robs's own tour ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours/slots/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"tour_id\":\"$TOUR_ID\",\"from\":\"2026-09-01\",\"to\":\"2026-09-01\",\"times\":[\"10:00\",\"14:00\"]}"

echo "--- bulk create for the foreign (BBYC) tour ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours/slots/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"tour_id\":\"$FOREIGN_TOUR_ID\",\"from\":\"2026-09-01\",\"to\":\"2026-09-01\",\"times\":[\"10:00\"]}"
```
Expected: own tour → `201 {"created":2,...}`; foreign tour → `404 {"error":"Tour not found"}`.

- [ ] **Step 9: Verify `GET /api/tours/slots/search` — auth required, scoped**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/tours/slots/search?date=2026-09-01"

echo "--- with token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/tours/slots/search?date=2026-09-01" -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401`; with token → `200`, array of 2 slots from Step 8 (`10:00`, `14:00`), each with `available_seats: 8`. Save one slot's `id` as `SLOT_ID`.

- [ ] **Step 10: Verify `POST /api/tours/bookings` via `X-Api-Key` — success, cross-property slot 404, cross-property guest 404**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)
SLOT_ID="<a slot id from Step 9>"

echo "--- book Robs's own slot ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours/bookings -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d "{\"slot_id\":\"$SLOT_ID\",\"contact_name\":\"Tour Booking Test\",\"group_size\":2}"

echo "--- attempt to book a made-up slot_id (proxy for cross-property, since we don't have a real foreign slot) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours/bookings -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"slot_id":"00000000-0000-0000-0000-000000000000","contact_name":"Should Fail","group_size":2}'

echo "--- with a cross-property guest_id (a real guest belonging to BBYC, not Robs) ---"
```
Expected: own slot → `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"`, `total_price` reflects `group_size * price`. Fake slot → `404 {"error":"Slot not found"}`.

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/tours/bookings -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d "{\"slot_id\":\"$SLOT_ID\",\"guest_id\":\"$BBYC_GUEST_ID\",\"contact_name\":\"Cross Property Guest Test\",\"group_size\":1}"
```
Expected: `404 {"error":"Guest not found"}`. If no BBYC guest exists, skip this specific check and note it as skipped — not a blocker, the slot-ownership check (already verified) exercises the same `req.property_id` mechanism.

- [ ] **Step 11: Verify `GET /api/tours/bookings` — auth required, scoped**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/tours/bookings -H "X-Api-Key: $OLD_SHARED_KEY"

echo "--- with Robs's Clerk token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/tours/bookings -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: old shared key → `401` (confirms full replacement); Robs's token → `200`, includes the booking from Step 10.

- [ ] **Step 12: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_key.txt /tmp/foreign_tour_id.txt
git add src/routes/tours.js src/controllers/tours.js src/docs/swagger.js
git commit -m "Scope tours module to property_id, switch booking creation to authenticateOrApiKey"
```

---

### Task 3: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-2's commits and `src/db/migrate-2026-08-11-tours-property-scoping.sql`.

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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-11-tours-property-scoping.sql', 'utf8'));
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
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('tour','tour_slot','tour_booking') AND column_name = 'property_id' ORDER BY table_name\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: 3 rows, all `is_nullable: 'NO'`.

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
    console.log(j.paths['/api/tours'].get.security ? 'READY' : 'NOT_READY');
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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/tours

echo "--- create a tour with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/tours -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"name":"Live Verify Tour","duration_mins":90,"max_group_size":6,"price":60}'
```
Expected: no-auth → `401`; create → `201`, `"property_id":"b7a4c969-5e82-4c26-a587-17d2ab74858e"` (FORGE).

- [ ] **Step 8: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
