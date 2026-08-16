# Equipment Property Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `property_id` to `equipment` and `equipment_hire`, scope every equipment route to it, switch all routes from public/`requireApiKey` to `authenticate`, and add an `equipment_id` filter to `GET /api/equipment/hires` — per `docs/superpowers/specs/2026-08-16-equipment-property-scoping-design.md`.

**Architecture:** Direct `property_id UUID NOT NULL REFERENCES property(id)` on both `equipment` and `equipment_hire` (both tables are empty locally and live, confirmed before writing the spec — no backfill). `GET /` and `GET /search` switch from fully public to `authenticate`-only. The 4 write/hire routes switch from `requireApiKey` to `authenticate`. `listHires` gains a new optional `equipment_id` query filter alongside its existing `date`/`status`/`guest_id`/`golf_booking_id` filters — a genuine column on the table, unlike golf's `course_id`-on-bookings gap.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-08-16-equipment-property-scoping-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm start` server, matching every prior property-scoping plan.
- **Confirm with the user before**: running the migration against the live database, and before `git push origin main` (triggers a live Render redeploy).
- Today's date: **2026-08-16**.
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
- **Cross-property checks don't need a second staff identity** — insert "foreign" rows directly via SQL under a different existing property (e.g. BBYC, `e1000000-0000-0000-0000-000000000004`) and confirm Robs's token can't reach them.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3` should print `200`. The backend has no auto-restart (`npm start` runs plain `node src/server.js`) — find and kill whatever process is listening on port 3000, then restart with `npm start` (as a background task) after any controller/route edit, before verifying.
- **Scope:** exactly `equipment`, `equipment_hire`, and the 7 routes in the design doc. No change to any other module.

---

### Task 1: Migration — add `property_id` to `equipment` and `equipment_hire`

**Files:**
- Create: `src/db/migrate-2026-08-16-equipment-property-scoping.sql`
- Modify: `src/db/schema.sql`

**Interfaces:**
- Produces: `equipment.property_id`, `equipment_hire.property_id` (both `UUID NOT NULL REFERENCES property(id)`) — Task 2's controller changes query both directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-16-equipment-property-scoping.sql`:

```sql
-- One-time migration: adds property_id to equipment and equipment_hire,
-- scoping the module to a property for the first time. No backfill
-- needed -- both tables have zero rows on both local and live
-- (confirmed before writing this migration), so NOT NULL is safe to
-- add directly with no DEFAULT. Idempotent-safe via IF NOT EXISTS.

ALTER TABLE equipment      ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE equipment_hire ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_equipment_property      ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_property ON equipment_hire(property_id);
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

```sql
CREATE TABLE IF NOT EXISTS equipment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(100)  NOT NULL,
  type           VARCHAR(50)   NOT NULL,
  description    TEXT,
  quantity       INT           NOT NULL,
  price_per_day  NUMERIC(10,2),
  price_per_hour NUMERIC(10,2),
  status         VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS equipment_hire (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id  UUID          NOT NULL REFERENCES equipment(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  hire_date     DATE          NOT NULL,
  quantity      INT           NOT NULL,
  status           VARCHAR(20)   DEFAULT 'confirmed',
  notes            TEXT,
  start_time       TIME,
  rate_type        VARCHAR(10)   DEFAULT 'per_day',
  duration         NUMERIC(5,2)  DEFAULT 1,
  golf_booking_id  UUID          REFERENCES golf_booking(id),
  total_price      NUMERIC(10,2),
  created_at       TIMESTAMPTZ   DEFAULT now()
);
```

with:

```sql
CREATE TABLE IF NOT EXISTS equipment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID          NOT NULL REFERENCES property(id),
  name           VARCHAR(100)  NOT NULL,
  type           VARCHAR(50)   NOT NULL,
  description    TEXT,
  quantity       INT           NOT NULL,
  price_per_day  NUMERIC(10,2),
  price_per_hour NUMERIC(10,2),
  status         VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS equipment_hire (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  equipment_id  UUID          NOT NULL REFERENCES equipment(id),
  guest_id      UUID          REFERENCES guest(id),
  contact_name  VARCHAR(100)  NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  hire_date     DATE          NOT NULL,
  quantity      INT           NOT NULL,
  status           VARCHAR(20)   DEFAULT 'confirmed',
  notes            TEXT,
  start_time       TIME,
  rate_type        VARCHAR(10)   DEFAULT 'per_day',
  duration         NUMERIC(5,2)  DEFAULT 1,
  golf_booking_id  UUID          REFERENCES golf_booking(id),
  total_price      NUMERIC(10,2),
  created_at       TIMESTAMPTZ   DEFAULT now()
);
```

Also add the two new indexes right after the existing equipment-hire
indexes (they're adjacent in the file):

Replace:

```sql
CREATE INDEX IF NOT EXISTS idx_equipment_hire_date ON equipment_hire(hire_date);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_eq   ON equipment_hire(equipment_id);
```

with:

```sql
CREATE INDEX IF NOT EXISTS idx_equipment_hire_date     ON equipment_hire(hire_date);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_eq       ON equipment_hire(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_property      ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_property ON equipment_hire(property_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-equipment-property-scoping.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify both columns exist and reject NULL**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('equipment','equipment_hire') AND column_name = 'property_id'\");
  console.log(JSON.stringify(cols.rows, null, 2));
  try {
    await pool.query(\"INSERT INTO equipment (name, type, quantity) VALUES ('Bad Equipment', 'test', 1)\");
    console.log('UNEXPECTED: insert without property_id succeeded');
  } catch (e) {
    console.log('Expected rejection:', e.message);
  }
  await pool.end();
})();
"
```
Expected: 2 rows, both `is_nullable: 'NO'`; the insert attempt fails with a `null value in column "property_id"` (or equivalent) error.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-16-equipment-property-scoping.sql
git commit -m "Add property_id to equipment and equipment_hire"
```

---

### Task 2: Scope routes and controllers, add equipment_id filter, verify locally

**Files:**
- Modify: `src/routes/equipment.js`
- Modify: `src/controllers/equipment.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate` from `src/middleware/auth.js` (already exported, unchanged), `property_id` from Task 1.
- Produces: no new exports — existing routes gain property scoping, a changed auth requirement, and `listHires` gains an `equipment_id` filter.

- [ ] **Step 1: Update the routes**

Replace the full contents of `src/routes/equipment.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { requireApiKey } = require('../middleware/apiKey');

// Equipment
router.get('/', ctrl.listEquipment);
router.post('/', requireApiKey, ctrl.createEquipment);
router.put('/:id', requireApiKey, ctrl.updateEquipment);

// Search
router.get('/search', ctrl.searchEquipment);

// Hires
router.get('/hires', requireApiKey, ctrl.listHires);
router.post('/hires', requireApiKey, ctrl.createHire);
router.put('/hires/:id', requireApiKey, ctrl.updateHire);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { authenticate } = require('../middleware/auth');

// Equipment
router.get('/', authenticate, ctrl.listEquipment);
router.post('/', authenticate, ctrl.createEquipment);
router.put('/:id', authenticate, ctrl.updateEquipment);

// Search
router.get('/search', authenticate, ctrl.searchEquipment);

// Hires
router.get('/hires', authenticate, ctrl.listHires);
router.post('/hires', authenticate, ctrl.createHire);
router.put('/hires/:id', authenticate, ctrl.updateHire);

module.exports = router;
```

- [ ] **Step 2: Scope the controller functions, add the `equipment_id` filter**

Replace the full contents of `src/controllers/equipment.js`:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Equipment ─────────────────────────────────────────────────────────────────

async function listEquipment(req, res, next) {
  try {
    const { type } = req.query;
    let query = "SELECT * FROM equipment WHERE status = 'active'";
    const params = [];
    if (type) { params.push(type); query += ` AND type = $${params.length}`; }
    query += ' ORDER BY name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createEquipment(req, res, next) {
  try {
    const { name, type, description, quantity, price_per_day, price_per_hour } = req.body;
    if (!name || !type || !quantity) {
      return res.status(400).json({ error: 'name, type, and quantity are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO equipment (name, type, description, quantity, price_per_day, price_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, type, description ?? null, quantity, price_per_day ?? null, price_per_hour ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateEquipment(req, res, next) {
  try {
    const { name, type, description, quantity, price_per_day, price_per_hour, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE equipment SET
         name           = COALESCE($1, name),
         type           = COALESCE($2, type),
         description    = COALESCE($3, description),
         quantity       = COALESCE($4, quantity),
         price_per_day  = COALESCE($5, price_per_day),
         price_per_hour = COALESCE($6, price_per_hour),
         status         = COALESCE($7, status)
       WHERE id = $8 RETURNING *`,
      [name, type, description, quantity, price_per_day, price_per_hour, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Search availability ───────────────────────────────────────────────────────

async function searchEquipment(req, res, next) {
  try {
    const { date, type, quantity } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT e.*,
             e.quantity - COALESCE(SUM(eh.quantity) FILTER (WHERE eh.status != 'cancelled'), 0) AS available_quantity
      FROM equipment e
      LEFT JOIN equipment_hire eh ON eh.equipment_id = e.id AND eh.hire_date = $1
      WHERE e.status = 'active'
    `;
    const params = [date];
    if (type) { params.push(type); query += ` AND e.type = $${params.length}`; }
    query += ' GROUP BY e.id';
    if (quantity) { query += ` HAVING e.quantity - COALESCE(SUM(eh.quantity) FILTER (WHERE eh.status != 'cancelled'), 0) >= ${parseInt(quantity, 10)}`; }
    query += ' ORDER BY e.type, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Hire bookings ─────────────────────────────────────────────────────────────

async function listHires(req, res, next) {
  try {
    const { date, status, guest_id, golf_booking_id } = req.query;
    let query = `
      SELECT eh.*, e.name AS equipment_name, e.type, e.price_per_day, e.price_per_hour
      FROM equipment_hire eh
      JOIN equipment e ON e.id = eh.equipment_id
      WHERE 1=1
    `;
    const params = [];
    if (date)            { params.push(date);            query += ` AND eh.hire_date = $${params.length}`; }
    if (status)          { params.push(status);          query += ` AND eh.status = $${params.length}`; }
    if (guest_id)        { params.push(guest_id);        query += ` AND eh.guest_id = $${params.length}`; }
    if (golf_booking_id) { params.push(golf_booking_id); query += ` AND eh.golf_booking_id = $${params.length}`; }
    query += ' ORDER BY eh.hire_date, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createHire(req, res, next) {
  const { equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, start_time, quantity, notes, golf_booking_id, rate_type = 'per_day', duration = 1 } = req.body;
  if (!equipment_id || !contact_name || !hire_date || !quantity) {
    return res.status(400).json({ error: 'equipment_id, contact_name, hire_date, and quantity are required' });
  }
  if (!isValidDate(hire_date)) return res.status(400).json({ error: 'Invalid date format' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eqRes = await client.query('SELECT * FROM equipment WHERE id = $1', [equipment_id]);
    if (!eqRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
    if (eqRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Equipment not available' }); }

    const hiredRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS hired FROM equipment_hire
       WHERE equipment_id = $1 AND hire_date = $2 AND status != 'cancelled'`,
      [equipment_id, hire_date]
    );
    const hired = parseInt(hiredRes.rows[0].hired, 10);
    const available = eqRes.rows[0].quantity - hired;
    if (quantity > available) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${available} available on this date` });
    }

    const eq = eqRes.rows[0];
    const rate = rate_type === 'per_hour' ? parseFloat(eq.price_per_hour || 0) : parseFloat(eq.price_per_day || 0);
    const total_price = (rate * quantity * duration).toFixed(2);

    const { rows } = await client.query(
      `INSERT INTO equipment_hire (equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, start_time, quantity, rate_type, duration, notes, golf_booking_id, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [equipment_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, hire_date, start_time ?? null, quantity, rate_type, duration, notes ?? null, golf_booking_id ?? null, total_price]
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

async function updateHire(req, res, next) {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE equipment_hire SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Hire not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listEquipment, createEquipment, updateEquipment,
  searchEquipment,
  listHires, createHire, updateHire,
};
```

with:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Equipment ─────────────────────────────────────────────────────────────────

async function listEquipment(req, res, next) {
  try {
    const { type } = req.query;
    let query = "SELECT * FROM equipment WHERE status = 'active'";
    const params = [];
    if (type) { params.push(type); query += ` AND type = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND property_id = $${params.length}`;
    query += ' ORDER BY name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createEquipment(req, res, next) {
  try {
    const { name, type, description, quantity, price_per_day, price_per_hour } = req.body;
    if (!name || !type || !quantity) {
      return res.status(400).json({ error: 'name, type, and quantity are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO equipment (property_id, name, type, description, quantity, price_per_day, price_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.property_id, name, type, description ?? null, quantity, price_per_day ?? null, price_per_hour ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateEquipment(req, res, next) {
  try {
    const { name, type, description, quantity, price_per_day, price_per_hour, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE equipment SET
         name           = COALESCE($1, name),
         type           = COALESCE($2, type),
         description    = COALESCE($3, description),
         quantity       = COALESCE($4, quantity),
         price_per_day  = COALESCE($5, price_per_day),
         price_per_hour = COALESCE($6, price_per_hour),
         status         = COALESCE($7, status)
       WHERE id = $8 AND property_id = $9 RETURNING *`,
      [name, type, description, quantity, price_per_day, price_per_hour, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Equipment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Search availability ───────────────────────────────────────────────────────

async function searchEquipment(req, res, next) {
  try {
    const { date, type, quantity } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT e.*,
             e.quantity - COALESCE(SUM(eh.quantity) FILTER (WHERE eh.status != 'cancelled'), 0) AS available_quantity
      FROM equipment e
      LEFT JOIN equipment_hire eh ON eh.equipment_id = e.id AND eh.hire_date = $1 AND eh.property_id = $2
      WHERE e.status = 'active' AND e.property_id = $2
    `;
    const params = [date, req.property_id];
    if (type) { params.push(type); query += ` AND e.type = $${params.length}`; }
    query += ' GROUP BY e.id';
    if (quantity) { query += ` HAVING e.quantity - COALESCE(SUM(eh.quantity) FILTER (WHERE eh.status != 'cancelled'), 0) >= ${parseInt(quantity, 10)}`; }
    query += ' ORDER BY e.type, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Hire bookings ─────────────────────────────────────────────────────────────

async function listHires(req, res, next) {
  try {
    const { date, status, guest_id, golf_booking_id, equipment_id } = req.query;
    let query = `
      SELECT eh.*, e.name AS equipment_name, e.type, e.price_per_day, e.price_per_hour
      FROM equipment_hire eh
      JOIN equipment e ON e.id = eh.equipment_id
      WHERE 1=1
    `;
    const params = [];
    if (date)            { params.push(date);            query += ` AND eh.hire_date = $${params.length}`; }
    if (status)          { params.push(status);          query += ` AND eh.status = $${params.length}`; }
    if (guest_id)        { params.push(guest_id);        query += ` AND eh.guest_id = $${params.length}`; }
    if (golf_booking_id) { params.push(golf_booking_id); query += ` AND eh.golf_booking_id = $${params.length}`; }
    if (equipment_id)    { params.push(equipment_id);    query += ` AND eh.equipment_id = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND eh.property_id = $${params.length}`;
    query += ' ORDER BY eh.hire_date, e.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createHire(req, res, next) {
  const { equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, start_time, quantity, notes, golf_booking_id, rate_type = 'per_day', duration = 1 } = req.body;
  if (!equipment_id || !contact_name || !hire_date || !quantity) {
    return res.status(400).json({ error: 'equipment_id, contact_name, hire_date, and quantity are required' });
  }
  if (!isValidDate(hire_date)) return res.status(400).json({ error: 'Invalid date format' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eqRes = await client.query('SELECT * FROM equipment WHERE id = $1 AND property_id = $2', [equipment_id, req.property_id]);
    if (!eqRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
    if (eqRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Equipment not available' }); }

    const hiredRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS hired FROM equipment_hire
       WHERE equipment_id = $1 AND hire_date = $2 AND status != 'cancelled' AND property_id = $3`,
      [equipment_id, hire_date, req.property_id]
    );
    const hired = parseInt(hiredRes.rows[0].hired, 10);
    const available = eqRes.rows[0].quantity - hired;
    if (quantity > available) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${available} available on this date` });
    }

    const eq = eqRes.rows[0];
    const rate = rate_type === 'per_hour' ? parseFloat(eq.price_per_hour || 0) : parseFloat(eq.price_per_day || 0);
    const total_price = (rate * quantity * duration).toFixed(2);

    const { rows } = await client.query(
      `INSERT INTO equipment_hire (property_id, equipment_id, guest_id, contact_name, contact_email, contact_phone, hire_date, start_time, quantity, rate_type, duration, notes, golf_booking_id, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [req.property_id, equipment_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, hire_date, start_time ?? null, quantity, rate_type, duration, notes ?? null, golf_booking_id ?? null, total_price]
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

async function updateHire(req, res, next) {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE equipment_hire SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 AND property_id = $4 RETURNING *`,
      [status, notes, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Hire not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listEquipment, createEquipment, updateEquipment,
  searchEquipment,
  listHires, createHire, updateHire,
};
```

- [ ] **Step 3: Update Swagger**

Replace:

```js
    // ── Equipment ────────────────────────────────────────────────────────────
    '/api/equipment': {
      get: { tags: ['Equipment'], summary: 'List equipment', parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of equipment' } } },
      post: { tags: ['Equipment'], summary: 'Create equipment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'type', 'quantity'], properties: { name: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'integer' }, price_per_day: { type: 'number' }, price_per_hour: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/equipment/search': {
      get: { tags: ['Equipment'], summary: 'Search available equipment', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'quantity', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available equipment with quantities' } } },
    },
    '/api/equipment/hires': {
      get: { tags: ['Equipment'], summary: 'List hire bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'golf_booking_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of hires' } } },
      post: { tags: ['Equipment'], summary: 'Hire equipment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['equipment_id', 'contact_name', 'hire_date', 'quantity'], properties: { equipment_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, hire_date: { type: 'string', format: 'date' }, quantity: { type: 'integer' }, notes: { type: 'string' }, rate_type: { type: 'string', enum: ['per_day', 'per_hour'], default: 'per_day' }, duration: { type: 'number', default: 1, description: 'Days or hours depending on rate_type' }, golf_booking_id: { type: 'string', format: 'uuid', description: 'Link to a golf booking' }, total_price: { type: 'number', readOnly: true, description: 'rate × quantity × duration' } } } } } }, responses: { 201: { description: 'Hire created with total_price' }, 409: { description: 'Not enough available' } } },
    },
```

with:

```js
    // ── Equipment ────────────────────────────────────────────────────────────
    '/api/equipment': {
      get: { tags: ['Equipment'], summary: 'List equipment', security: [{ bearerAuth: [] }], parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of equipment' } } },
      post: { tags: ['Equipment'], summary: 'Create equipment', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'type', 'quantity'], properties: { name: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'integer' }, price_per_day: { type: 'number' }, price_per_hour: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/equipment/search': {
      get: { tags: ['Equipment'], summary: 'Search available equipment', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'quantity', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available equipment with quantities' } } },
    },
    '/api/equipment/hires': {
      get: { tags: ['Equipment'], summary: 'List hire bookings', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'golf_booking_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'equipment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of hires' } } },
      post: { tags: ['Equipment'], summary: 'Hire equipment', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['equipment_id', 'contact_name', 'hire_date', 'quantity'], properties: { equipment_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, hire_date: { type: 'string', format: 'date' }, quantity: { type: 'integer' }, notes: { type: 'string' }, rate_type: { type: 'string', enum: ['per_day', 'per_hour'], default: 'per_day' }, duration: { type: 'number', default: 1, description: 'Days or hours depending on rate_type' }, golf_booking_id: { type: 'string', format: 'uuid', description: 'Link to a golf booking' }, total_price: { type: 'number', readOnly: true, description: 'rate × quantity × duration' } } } } } }, responses: { 201: { description: 'Hire created with total_price' }, 409: { description: 'Not enough available' } } },
    },
```

- [ ] **Step 4: Restart the local server, confirm it's up**

Find and kill whatever `node src/server.js` process is currently listening on port 3000, then start it fresh with `npm start` (as a background task), then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify auth is now required on the previously-public routes**

```bash
echo "--- GET / with no auth (was public) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/equipment

echo "--- GET /search with no auth (was public) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/equipment/search?date=2026-10-01"
```
Expected: both `401 {"error":"Missing or invalid Authorization header"}`.

- [ ] **Step 6: Verify equipment CRUD, scoped and authenticated**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
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

echo "--- list equipment (should be empty) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/equipment -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- create Mountain Bike ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/equipment -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Mountain Bike","type":"Bike","quantity":5,"price_per_day":20}'

echo "--- old shared API_KEY (was requireApiKey) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/equipment -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" -d '{"name":"Should Fail","type":"test","quantity":1}'
```
Expected: empty list first; create → `201`, `property_id` matches Robs — save the `id` as `EQUIPMENT_ID`. Old shared key → `401` (confirms full replacement, not additive).

- [ ] **Step 7: Verify cross-property 404s on `PUT /api/equipment/:id`**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"INSERT INTO equipment (property_id, name, type, quantity) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Kayak', 'Watersport', 2) RETURNING id\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_equipment_id.txt
FOREIGN_EQUIPMENT_ID=$(cat /tmp/foreign_equipment_id.txt)

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
EQUIPMENT_ID="<from Step 6>"

echo "--- edit own equipment ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/equipment/$EQUIPMENT_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"quantity":8}'

echo "--- edit the foreign equipment ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/equipment/$FOREIGN_EQUIPMENT_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"quantity":1}'
```
Expected: own equipment → `200`, `quantity: 8`; foreign equipment → `404 {"error":"Equipment not found"}`.

- [ ] **Step 8: Verify hire creation — success, cross-property 404, availability math**

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
EQUIPMENT_ID="<from Step 6>"
FOREIGN_EQUIPMENT_ID=$(cat /tmp/foreign_equipment_id.txt)

echo "--- hire 2 of Robs's own equipment for 3 days ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/equipment/hires -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"equipment_id\":\"$EQUIPMENT_ID\",\"contact_name\":\"Test Guest\",\"hire_date\":\"2026-10-01\",\"quantity\":2,\"rate_type\":\"per_day\",\"duration\":3}"

echo "--- hire the foreign equipment ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/equipment/hires -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"equipment_id\":\"$FOREIGN_EQUIPMENT_ID\",\"contact_name\":\"Test Guest\",\"hire_date\":\"2026-10-01\",\"quantity\":1}"

echo "--- hire more than available (8 available after Step 7's edit, minus 2 already hired = 6 left) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/equipment/hires -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"equipment_id\":\"$EQUIPMENT_ID\",\"contact_name\":\"Test Guest 2\",\"hire_date\":\"2026-10-01\",\"quantity\":7}"
```
Expected: own equipment hire → `201`, `total_price: "120.00"` (20 × 2 × 3) — save the returned `id` as `HIRE_ID`. Foreign equipment → `404 {"error":"Equipment not found"}`. Over-quantity hire → `409 {"error":"Only 6 available on this date"}`.

- [ ] **Step 9: Verify `listHires`'s new `equipment_id` filter and property scoping**

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
EQUIPMENT_ID="<from Step 6>"

echo "--- hires filtered by equipment_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/equipment/hires?equipment_id=$EQUIPMENT_ID" -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- old shared API_KEY (was requireApiKey) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/equipment/hires -H "X-Api-Key: $OLD_SHARED_KEY"
```
Expected: equipment_id filter → array containing the hire from Step 8 (not the foreign one, which failed to create anyway). Old shared key → `401`.

- [ ] **Step 10: Verify `PUT /api/equipment/hires/:id` — cancel own, cross-property 404**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"INSERT INTO equipment_hire (property_id, equipment_id, contact_name, hire_date, quantity) SELECT 'e1000000-0000-0000-0000-000000000004', id, 'Foreign Hire', '2026-10-01', 1 FROM equipment WHERE property_id = 'e1000000-0000-0000-0000-000000000004' LIMIT 1 RETURNING id\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_hire_id.txt
FOREIGN_HIRE_ID=$(cat /tmp/foreign_hire_id.txt)

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
HIRE_ID="<from Step 8>"

echo "--- cancel own hire ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/equipment/hires/$HIRE_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"cancelled"}'

echo "--- cancel the foreign hire ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/equipment/hires/$FOREIGN_HIRE_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"cancelled"}'
```
Expected: own hire → `200`, `status: "cancelled"`. Foreign hire → `404 {"error":"Hire not found"}`.

- [ ] **Step 11: Commit**

```bash
rm -f /tmp/tok.txt /tmp/foreign_equipment_id.txt /tmp/foreign_hire_id.txt
git add src/routes/equipment.js src/controllers/equipment.js src/docs/swagger.js
git commit -m "Scope equipment module to property_id, switch to authenticate, add equipment_id filter"
```

---

### Task 3: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-2's commits and `src/db/migrate-2026-08-16-equipment-property-scoping.sql`.

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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-equipment-property-scoping.sql', 'utf8'));
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
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('equipment','equipment_hire') AND column_name = 'property_id'\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: 2 rows, both `is_nullable: 'NO'`.

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
    console.log(j.paths['/api/equipment'].get.security ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 7: Verify live — auth required, and a create round-trip via FORGE's token**

This needs a live Clerk admin token for FORGE, which requires the browser-based sign-in-ticket flow (the dev-only `sessions.createSession` shortcut doesn't work on live). Use whichever browser automation MCP tool is connected at execution time, following the same recipe used in every prior live-verification task this session (mint a sign-in ticket via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key from `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, navigate with `redirect_url=https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`).

If no browser tool is connected when this step is reached, stop and ask the user how to proceed (wait for reconnection, have them supply a token, or skip this specific step) rather than skipping silently.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/equipment

echo "--- create equipment with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/equipment -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"name":"Live Verify Equipment","type":"test","quantity":1}'
```
Expected: no-auth → `401`; create → `201`, `property_id` matches FORGE (`b7a4c969-5e82-4c26-a587-17d2ab74858e`).

- [ ] **Step 8: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
