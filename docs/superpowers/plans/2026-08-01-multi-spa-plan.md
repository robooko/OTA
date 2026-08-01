# Multi-Spa Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the spa module from one implicit global spa into multiple named spa locations — a new `spa` entity table, `spa_treatment`/`spa_therapist` each scoped to exactly one spa via `spa_id`, nested `/api/spa/:spa_id/...` routes mirroring `/api/restaurant/:restaurant_id/...`, and a real seeded spa for Pirates Bight — per `docs/superpowers/specs/2026-08-01-multi-spa-design.md`.

**Architecture:** A new `spa` table (`id`, `name`, `description`, `phone`) parallels `restaurant`. `spa_treatment` and `spa_therapist` each get a `spa_id UUID NOT NULL REFERENCES spa(id)`. `spa_slot` and `spa_appointment` are untouched — their spa is derived by joining through `therapist_id → spa_therapist.spa_id`. Routes move from flat (`/api/spa/treatments`) to nested (`/api/spa/:spa_id/treatments`), matching restaurant. `bulkCreateSlots` gains a same-spa check between the given `therapist_id` and `treatment_id`.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- No `property_id` on `spa` — stays unscoped like `restaurant` currently is (deferred multi-property scoping phase).
- No FK between `spa` and `restaurant` — the Pirates Bight spa is themed/named to match but is a fully independent row.
- `spa_therapist.spa_id` is a single required FK — a therapist belongs to exactly one spa, no join table.
- No automated test framework exists in this project. Every "verify" step is a manual check: `curl` against a running `npm run dev`, or a `psql`/`node` query.
- Two databases exist: local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance (what `https://ota-u6ii.onrender.com` actually uses). Both need the same in-place migration — do not reset either.
- `spa_treatment` and `spa_therapist` are confirmed empty in every environment (no seed file has ever populated them), so adding `spa_id UUID NOT NULL REFERENCES spa(id)` is a safe straight column add — no default, no backfill needed, and no existing row can violate the constraint.
- This breaks the current flat spa endpoints (`GET /api/spa/treatments` etc. stop existing in that form) — deliberate, matches how `/api/restaurant` is already structured.
- **Known gap, deliberately accepted (Task 5):** between running the remote migration and the new code finishing deployment, the *old* code's spa write endpoints (`createTreatment`/`createTherapist`, which don't set `spa_id`) will fail with a NOT NULL violation, since `spa_id` will already be required. Read endpoints (list/search) keep working. This is a brief, low-traffic gap — push immediately after migrating, verify afterward (Task 5) rather than trying to avoid it.
- Today's reference date for test dates in this plan: **2026-08-01**.

---

### Task 0: Commit the pre-existing, unrelated `restaurant_reservation.metadata` work first

**Context:** `src/db/schema.sql`, `src/controllers/restaurant.js`, and `src/docs/swagger.js` already have uncommitted changes in the working tree from separate, already-finished prior work (a `restaurant_reservation.metadata` JSONB column, mirroring `booking.metadata`), plus an untracked `src/db/migrate-2026-07-23-restaurant-reservation-metadata.sql`. None of this is part of the spa feature. Task 1 needs to edit `schema.sql` too, so this gets committed first to keep it out of the spa commits.

**Files:**
- Commit as-is: `src/db/schema.sql` (only the already-present `metadata JSONB NOT NULL DEFAULT '{}'` line on `restaurant_reservation` — nothing else has changed in this file yet), `src/controllers/restaurant.js`, `src/docs/swagger.js`, `src/db/migrate-2026-07-23-restaurant-reservation-metadata.sql`

**Interfaces:** none — this is a pre-existing, self-contained change being committed, not new work.

- [ ] **Step 1: Confirm the diff is exactly the metadata feature and nothing else**

```bash
git diff src/db/schema.sql src/controllers/restaurant.js src/docs/swagger.js
```
Expected: every hunk is about `restaurant_reservation.metadata` (the new column, `isValidMetadata` validation in `createReservation`/`updateReservation`, and the matching Swagger `metadata` properties + the previously-undocumented `GET`/`PUT /api/restaurant/{restaurant_id}/reservations/{id}` paths). If anything else shows up, stop and ask the user before committing — don't fold unrelated changes into this commit either.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema.sql src/controllers/restaurant.js src/docs/swagger.js src/db/migrate-2026-07-23-restaurant-reservation-metadata.sql
git commit -m "Add restaurant_reservation.metadata column, mirroring booking.metadata"
```

- [ ] **Step 3: Verify a clean tree before starting Task 1**

```bash
git status
```
Expected: `src/db/schema.sql` no longer shows as modified (no diff left before Task 1's spa edits begin).

---

### Task 1: Add `spa` table and scope `spa_treatment`/`spa_therapist` to it

**Files:**
- Modify: `src/db/schema.sql` (spa section, lines 223-264)
- Create: `src/db/migrate-2026-08-01-spa-scoping.sql`

**Interfaces:**
- Produces: `spa(id, name, description, phone, created_at)`; `spa_treatment.spa_id`, `spa_therapist.spa_id` (both `UUID NOT NULL REFERENCES spa(id)`). Task 2's controller and Task 4's seed file depend on this shape.

- [ ] **Step 1: Update `schema.sql` to the end state**

Replace:
```sql
-- ── Spa ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spa_treatment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(100)  NOT NULL,
  description  TEXT,
  duration_mins INT          NOT NULL,
  price        NUMERIC(10,2) NOT NULL,
  status       VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_therapist (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name   VARCHAR(100) NOT NULL,
  status VARCHAR(20)  DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_slot (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id  UUID         NOT NULL REFERENCES spa_therapist(id),
  treatment_id  UUID         NOT NULL REFERENCES spa_treatment(id),
  slot_date     DATE         NOT NULL,
  slot_time     TIME         NOT NULL,
  status        VARCHAR(20)  DEFAULT 'available',
  UNIQUE (therapist_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS spa_appointment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id      UUID         NOT NULL REFERENCES spa_slot(id),
  guest_id     UUID         REFERENCES guest(id),
  contact_name VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  status       VARCHAR(20)  DEFAULT 'confirmed',
  notes        TEXT,
  created_at   TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spa_slot_therapist_date ON spa_slot(therapist_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_spa_slot_treatment      ON spa_slot(treatment_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_slot    ON spa_appointment(slot_id);
```
with:
```sql
-- ── Spa ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spa (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  phone       VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spa_treatment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spa_id       UUID          NOT NULL REFERENCES spa(id),
  name         VARCHAR(100)  NOT NULL,
  description  TEXT,
  duration_mins INT          NOT NULL,
  price        NUMERIC(10,2) NOT NULL,
  status       VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_therapist (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spa_id UUID         NOT NULL REFERENCES spa(id),
  name   VARCHAR(100) NOT NULL,
  status VARCHAR(20)  DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_slot (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id  UUID         NOT NULL REFERENCES spa_therapist(id),
  treatment_id  UUID         NOT NULL REFERENCES spa_treatment(id),
  slot_date     DATE         NOT NULL,
  slot_time     TIME         NOT NULL,
  status        VARCHAR(20)  DEFAULT 'available',
  UNIQUE (therapist_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS spa_appointment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id      UUID         NOT NULL REFERENCES spa_slot(id),
  guest_id     UUID         REFERENCES guest(id),
  contact_name VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  status       VARCHAR(20)  DEFAULT 'confirmed',
  notes        TEXT,
  created_at   TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa       ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa       ON spa_therapist(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_therapist_date ON spa_slot(therapist_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_spa_slot_treatment      ON spa_slot(treatment_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_slot    ON spa_appointment(slot_id);
```

- [ ] **Step 2: Write the one-time migration script**

Create `src/db/migrate-2026-08-01-spa-scoping.sql`:
```sql
-- One-time migration: introduce spa as a top-level entity and scope
-- spa_treatment/spa_therapist to it via spa_id.
-- Run ONCE directly against an already-populated database (NOT part of
-- the normal reset pipeline). Safe as a straight NOT NULL column add (no
-- default, no backfill) because spa_treatment and spa_therapist are
-- confirmed empty in every environment - nothing has ever seeded them.
-- See docs/superpowers/plans/2026-08-01-multi-spa-plan.md.

CREATE TABLE IF NOT EXISTS spa (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  phone       VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE spa_treatment ADD COLUMN IF NOT EXISTS spa_id UUID NOT NULL REFERENCES spa(id);
ALTER TABLE spa_therapist ADD COLUMN IF NOT EXISTS spa_id UUID NOT NULL REFERENCES spa(id);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa ON spa_therapist(spa_id);
```

- [ ] **Step 3: Apply the migration against local Postgres**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query(fs.readFileSync('src/db/migrate-2026-08-01-spa-scoping.sql', 'utf8'));
  await client.end();
  console.log('migration applied');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `migration applied`, no errors.

- [ ] **Step 4: Verify the new shape**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  const spaCols = await client.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'spa' ORDER BY ordinal_position\");
  console.log('spa columns:', spaCols.rows.map(r => r.column_name));
  const treatmentCols = await client.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'spa_treatment' ORDER BY ordinal_position\");
  console.log('spa_treatment columns:', treatmentCols.rows.map(r => r.column_name));
  const therapistCols = await client.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'spa_therapist' ORDER BY ordinal_position\");
  console.log('spa_therapist columns:', therapistCols.rows.map(r => r.column_name));
  await client.end();
})();
"
```
Expected: `spa columns` is `[ 'id', 'name', 'description', 'phone', 'created_at' ]`; both `spa_treatment columns` and `spa_therapist columns` include `spa_id`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-01-spa-scoping.sql
git commit -m "Add spa table and scope spa_treatment/spa_therapist to it"
```

---

### Task 2: Rewrite the spa controller and routes for per-spa nesting

**Files:**
- Modify: `src/controllers/spa.js` (full rewrite)
- Modify: `src/routes/spa.js` (full rewrite)

**Interfaces:**
- Consumes: `spa` table and `spa_id` columns from Task 1.
- Produces: exported controller functions `listSpas, getSpa, createSpa, updateSpa, listTreatments, createTreatment, updateTreatment, listTherapists, createTherapist, listSlots, bulkCreateSlots, searchSlots, listAppointments, createAppointment, updateAppointment` — same names as before, now spa-scoped. Task 3's Swagger docs describe these same routes.

- [ ] **Step 1: Replace `src/controllers/spa.js` in full**

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Spas ──────────────────────────────────────────────────────────────────────

async function listSpas(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
}

async function getSpa(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createSpa(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa (name, description, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name, description ?? null, phone ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateSpa(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         phone       = COALESCE($3, phone)
       WHERE id = $4 RETURNING *`,
      [name, description, phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Treatments ────────────────────────────────────────────────────────────────

async function listTreatments(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_treatment WHERE spa_id = $1 AND status = 'active' ORDER BY name",
      [req.params.spa_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTreatment(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name, description, duration_mins, price } = req.body;
    if (!name || !duration_mins || !price) return res.status(400).json({ error: 'name, duration_mins, and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO spa_treatment (spa_id, name, description, duration_mins, price) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [spa_id, name, description ?? null, duration_mins, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTreatment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, description, duration_mins, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_treatment SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         duration_mins = COALESCE($3, duration_mins),
         price         = COALESCE($4, price),
         status        = COALESCE($5, status)
       WHERE id = $6 AND spa_id = $7 RETURNING *`,
      [name, description, duration_mins, price, status, id, spa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Treatment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Therapists ────────────────────────────────────────────────────────────────

async function listTherapists(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_therapist WHERE spa_id = $1 AND status = 'active' ORDER BY name",
      [req.params.spa_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTherapist(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa_therapist (spa_id, name) VALUES ($1, $2) RETURNING *`, [spa_id, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// ── Slots ─────────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, from, to, therapist_id, treatment_id } = req.query;
    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
    `;
    const params = [spa_id];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (from) { params.push(from); query += ` AND ss.slot_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND ss.slot_date <= $${params.length}`; }
    if (therapist_id) { params.push(therapist_id); query += ` AND ss.therapist_id = $${params.length}`; }
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function bulkCreateSlots(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { therapist_id, treatment_id, from, to, times } = req.body;
    if (!therapist_id || !treatment_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'therapist_id, treatment_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const therapistRes = await pool.query('SELECT spa_id FROM spa_therapist WHERE id = $1', [therapist_id]);
    if (!therapistRes.rows.length || therapistRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'therapist_id does not belong to this spa' });
    }
    const treatmentRes = await pool.query('SELECT spa_id FROM spa_treatment WHERE id = $1', [treatment_id]);
    if (!treatmentRes.rows.length || treatmentRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'treatment_id does not belong to this spa' });
    }

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO spa_slot (therapist_id, treatment_id, slot_date, slot_time)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (therapist_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [therapist_id, treatment_id, date, time]
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
    const { spa_id } = req.params;
    const { date, treatment_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
        AND ss.slot_date = $2
        AND ss.status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM spa_appointment sa
          WHERE sa.slot_id = ss.id AND sa.status != 'cancelled'
        )
    `;
    const params = [spa_id, date];
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_time, st.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Appointments ──────────────────────────────────────────────────────────────

async function listAppointments(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT sa.*, ss.slot_date, ss.slot_time,
             st.name AS therapist_name, tr.name AS treatment_name, tr.price
      FROM spa_appointment sa
      JOIN spa_slot ss ON ss.id = sa.slot_id
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
    `;
    const params = [spa_id];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND sa.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND sa.guest_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createAppointment(req, res, next) {
  const { spa_id } = req.params;
  const { slot_id, guest_id, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!slot_id || !contact_name) return res.status(400).json({ error: 'slot_id and contact_name are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ss.* FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE ss.id = $1 AND st.spa_id = $2`,
      [slot_id, spa_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slotRes.rows[0].status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is not available' }); }

    const conflictRes = await client.query(
      `SELECT id FROM spa_appointment WHERE slot_id = $1 AND status != 'cancelled'`, [slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot already booked' }); }

    const { rows } = await client.query(
      `INSERT INTO spa_appointment (slot_id, guest_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null]
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

async function updateAppointment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_appointment sa SET
         status = COALESCE($1, sa.status),
         notes  = COALESCE($2, sa.notes)
       FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE sa.slot_id = ss.id
         AND sa.id = $3
         AND st.spa_id = $4
       RETURNING sa.*`,
      [status, notes, id, spa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listSpas, getSpa, createSpa, updateSpa,
  listTreatments, createTreatment, updateTreatment,
  listTherapists, createTherapist,
  listSlots, bulkCreateSlots, searchSlots,
  listAppointments, createAppointment, updateAppointment,
};
```

- [ ] **Step 2: Replace `src/routes/spa.js` in full**

```js
const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { requireApiKey } = require('../middleware/apiKey');

// Spas
router.get('/', ctrl.listSpas);
router.get('/:id', ctrl.getSpa);
router.post('/', requireApiKey, ctrl.createSpa);
router.put('/:id', requireApiKey, ctrl.updateSpa);

// Treatments
router.get('/:spa_id/treatments', ctrl.listTreatments);
router.post('/:spa_id/treatments', requireApiKey, ctrl.createTreatment);
router.put('/:spa_id/treatments/:id', requireApiKey, ctrl.updateTreatment);

// Therapists
router.get('/:spa_id/therapists', ctrl.listTherapists);
router.post('/:spa_id/therapists', requireApiKey, ctrl.createTherapist);

// Slots
router.get('/:spa_id/slots', requireApiKey, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', ctrl.searchSlots);

// Appointments
router.get('/:spa_id/appointments', requireApiKey, ctrl.listAppointments);
router.post('/:spa_id/appointments', requireApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', requireApiKey, ctrl.updateAppointment);

module.exports = router;
```

- [ ] **Step 3: Restart the dev server**

```bash
npm run dev
```
Expected: `Server running on port 3000`, no errors (leave this running in the background for the next step).

- [ ] **Step 4: End-to-end verification — two throwaway spas, cross-spa isolation, and the bulk-slot same-spa check**

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

echo "--- create two throwaway spas ---"
SPA_A=$(curl -s -X POST http://localhost:3000/api/spa -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"name":"Test Spa A"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
SPA_B=$(curl -s -X POST http://localhost:3000/api/spa -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"name":"Test Spa B"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
echo "Spa A: $SPA_A"
echo "Spa B: $SPA_B"

echo "--- create a treatment and therapist under each spa ---"
TREAT_A=$(curl -s -X POST "http://localhost:3000/api/spa/$SPA_A/treatments" -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"name":"Test Massage A","duration_mins":60,"price":100}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
THER_A=$(curl -s -X POST "http://localhost:3000/api/spa/$SPA_A/therapists" -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"name":"Test Therapist A"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
TREAT_B=$(curl -s -X POST "http://localhost:3000/api/spa/$SPA_B/treatments" -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"name":"Test Massage B","duration_mins":60,"price":100}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")

echo "--- spa A treatment list excludes spa B's treatment ---"
curl -s "http://localhost:3000/api/spa/$SPA_A/treatments" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(t=>t.name)))"

echo "--- bulk-create slots with a cross-spa therapist/treatment pair (expect 400) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/spa/$SPA_A/slots/bulk" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d "{\"therapist_id\":\"$THER_A\",\"treatment_id\":\"$TREAT_B\",\"from\":\"2026-08-10\",\"to\":\"2026-08-10\",\"times\":[\"10:00\"]}"

echo "--- bulk-create slots with a matching same-spa pair (expect 201) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/spa/$SPA_A/slots/bulk" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d "{\"therapist_id\":\"$THER_A\",\"treatment_id\":\"$TREAT_A\",\"from\":\"2026-08-10\",\"to\":\"2026-08-10\",\"times\":[\"10:00\"]}"

echo "--- search spa A slots for that date ---"
SLOT_A=$(curl -s "http://localhost:3000/api/spa/$SPA_A/slots/search?date=2026-08-10" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].id))")
echo "Slot A: $SLOT_A"

echo "--- book the slot under spa A (expect 201) ---"
APPT_A=$(curl -s -X POST "http://localhost:3000/api/spa/$SPA_A/appointments" -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d "{\"slot_id\":\"$SLOT_A\",\"contact_name\":\"Test Guest\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")
echo "Appointment A: $APPT_A"

echo "--- spa A appointment list includes it; spa B's does not ---"
curl -s "http://localhost:3000/api/spa/$SPA_A/appointments" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(a=>a.id)))"
curl -s "http://localhost:3000/api/spa/$SPA_B/appointments" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(a=>a.id)))"

echo "--- update the appointment under spa A (expect 200) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/spa/$SPA_A/appointments/$APPT_A" -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"notes":"updated via test"}'

echo "--- update the same appointment via spa B (wrong spa, expect 404) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/spa/$SPA_B/appointments/$APPT_A" -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"notes":"should not apply"}'

echo "--- old flat route now falls through to GET /:id (expect 500, invalid UUID - same as any bogus /api/restaurant/:id today, not a new issue) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa/treatments
```
Expected, in order: two UUIDs printed for Spa A/B; `[ 'Test Massage A' ]` (not B's); `400` with `{"error":"treatment_id does not belong to this spa"}`; `201` with one created slot; a slot UUID; `201` appointment response; spa A's list shows `[APPT_A]`, spa B's list shows `[]`; the spa-A update returns `200`; the spa-B update returns `404` with `{"error":"Appointment not found"}`; the final call returns `HTTP_STATUS:500` with an "invalid input syntax for type uuid" error message.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/spa.js src/routes/spa.js
git commit -m "Scope spa treatments/therapists/slots/appointments to a spa, nest routes under /api/spa/:spa_id"
```

---

### Task 3: Update Swagger docs

**Files:**
- Modify: `src/docs/swagger.js:299-317`

**Interfaces:**
- Consumes: nothing from prior tasks (documentation only).
- Produces: docs matching Task 2's route shape.

- [ ] **Step 1: Replace the Spa section**

Replace:
```js
    // ── Spa ──────────────────────────────────────────────────────────────────
    '/api/spa/treatments': {
      get: { tags: ['Spa'], summary: 'List treatments', responses: { 200: { description: 'Array of treatments' } } },
      post: { tags: ['Spa'], summary: 'Create treatment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/therapists': {
      get: { tags: ['Spa'], summary: 'List therapists', responses: { 200: { description: 'Array of therapists' } } },
      post: { tags: ['Spa'], summary: 'Create therapist', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/slots/bulk': {
      post: { tags: ['Spa'], summary: 'Bulk generate spa slots', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['therapist_id', 'treatment_id', 'from', 'to', 'times'], properties: { therapist_id: { type: 'string', format: 'uuid' }, treatment_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'] } } } } } }, responses: { 201: { description: 'Slots created' } } },
    },
    '/api/spa/slots/search': {
      get: { tags: ['Spa'], summary: 'Search available spa slots', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available slots with therapist and treatment info' } } },
    },
    '/api/spa/appointments': {
      get: { tags: ['Spa'], summary: 'List appointments', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of appointments' } } },
      post: { tags: ['Spa'], summary: 'Book spa appointment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Appointment booked' }, 409: { description: 'Slot already booked' } } },
    },
```
with:
```js
    // ── Spa ──────────────────────────────────────────────────────────────────
    '/api/spa': {
      get: { tags: ['Spa'], summary: 'List all spas', responses: { 200: { description: 'Array of spas' } } },
      post: { tags: ['Spa'], summary: 'Create spa', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{id}': {
      get: { tags: ['Spa'], summary: 'Get spa by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Spa' } } },
      put: { tags: ['Spa'], summary: 'Update spa', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/spa/{spa_id}/treatments': {
      get: { tags: ['Spa'], summary: 'List treatments', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of treatments' } } },
      post: { tags: ['Spa'], summary: 'Create treatment', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{spa_id}/therapists': {
      get: { tags: ['Spa'], summary: 'List therapists', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of therapists' } } },
      post: { tags: ['Spa'], summary: 'Create therapist', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{spa_id}/slots': {
      get: { tags: ['Spa'], summary: 'List slots', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'therapist_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of slots' } } },
    },
    '/api/spa/{spa_id}/slots/bulk': {
      post: { tags: ['Spa'], summary: 'Bulk generate spa slots', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['therapist_id', 'treatment_id', 'from', 'to', 'times'], properties: { therapist_id: { type: 'string', format: 'uuid' }, treatment_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'] } } } } } }, responses: { 201: { description: 'Slots created' }, 400: { description: 'therapist_id or treatment_id does not belong to this spa' } } },
    },
    '/api/spa/{spa_id}/slots/search': {
      get: { tags: ['Spa'], summary: 'Search available spa slots', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available slots with therapist and treatment info' } } },
    },
    '/api/spa/{spa_id}/appointments': {
      get: { tags: ['Spa'], summary: 'List appointments', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of appointments' } } },
      post: { tags: ['Spa'], summary: 'Book spa appointment', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Appointment booked' }, 409: { description: 'Slot already booked' } } },
    },
    '/api/spa/{spa_id}/appointments/{id}': {
      put: { tags: ['Spa'], summary: 'Update appointment', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log(Object.keys(j.paths).filter(p => p.startsWith('/api/spa')).sort());
});
"
```
Expected: `[ '/api/spa', '/api/spa/{id}', '/api/spa/{spa_id}/appointments', '/api/spa/{spa_id}/appointments/{id}', '/api/spa/{spa_id}/slots', '/api/spa/{spa_id}/slots/bulk', '/api/spa/{spa_id}/slots/search', '/api/spa/{spa_id}/therapists', '/api/spa/{spa_id}/treatments' ]` — no `/api/spa/treatments`-style flat paths remain.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document nested per-spa Swagger paths"
```

---

### Task 4: Seed the Pirates Bight spa

**Files:**
- Create: `src/db/seed-spa-pirates-bight.sql`

**Interfaces:**
- Consumes: `spa`/`spa_id` shape from Task 1, API from Task 2 (verification only).
- Produces: a real "Pirates Bight Spa" row plus 3 treatments and 2 therapists, seeded into the local database.

- [ ] **Step 1: Create the seed file**

Create `src/db/seed-spa-pirates-bight.sql`:
```sql
-- Spa for Pirates Bight
-- Run after schema.sql (and the restaurant seed files, for consistent
-- ordering) during a fresh reset - or as a plain additive INSERT directly
-- against an already-populated database.
-- Note: spa has no property_id yet (out of scope for the multi-property
-- Phase 1 plan), and no FK link to the restaurant table - this is a fully
-- independent spa row, themed to match Pirates Bight but not tied to it
-- in the schema, same as every other unscoped restaurant/spa/tours/etc.
-- module.
--
-- No spa_slot rows are seeded here - bookable availability is generated
-- later via POST /api/spa/:spa_id/slots/bulk, the same way restaurant
-- seeds define tables/hours but never seed example reservations.

WITH new_spa AS (
  INSERT INTO spa (name, description, phone)
  VALUES (
    'Pirates Bight Spa',
    'A barefoot spa retreat steps from the dock on Norman Island, BVI - beachfront treatments beneath the palms.',
    '+1-284-443-1310'
  )
  RETURNING id
), new_treatments AS (
  INSERT INTO spa_treatment (spa_id, name, description, duration_mins, price)
  SELECT new_spa.id, t.name, t.description, t.duration_mins, t.price
  FROM new_spa, (VALUES
    ('Island Swedish Massage', 'A relaxing full-body massage with light-to-medium pressure.', 60, 140.00),
    ('Deep Tissue Massage', 'Firm-pressure massage targeting muscle tension.', 60, 155.00),
    ('Ocean Facial', 'A hydrating facial using marine-based products.', 50, 120.00)
  ) AS t(name, description, duration_mins, price)
)
INSERT INTO spa_therapist (spa_id, name)
SELECT new_spa.id, t.name
FROM new_spa, (VALUES
  ('Marisol Fahie'),
  ('Dwayne Christopher')
) AS t(name);
```

- [ ] **Step 2: Apply it against local Postgres**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query(fs.readFileSync('src/db/seed-spa-pirates-bight.sql', 'utf8'));
  await client.end();
  console.log('Pirates Bight spa seeded');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `Pirates Bight spa seeded`, no errors.

- [ ] **Step 3: Verify via the running API** (dev server from Task 2 still running)

```bash
PB_SPA=$(curl -s http://localhost:3000/api/spa | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(s=>s.name==='Pirates Bight Spa').id))")
echo "Pirates Bight Spa: $PB_SPA"

curl -s "http://localhost:3000/api/spa/$PB_SPA/treatments" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(t=>t.name)))"
curl -s "http://localhost:3000/api/spa/$PB_SPA/therapists" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(t=>t.name)))"
```
Expected: `Pirates Bight Spa: <uuid>`; treatments list is `[ 'Island Swedish Massage', 'Deep Tissue Massage', 'Ocean Facial' ]`; therapists list is `[ 'Marisol Fahie', 'Dwayne Christopher' ]`.

- [ ] **Step 4: Verify a fresh full reset also produces this spa, without touching the live local database**

This wraps a full reset+reseed in a transaction that gets rolled back, so the
real (preserved) local data is untouched afterward.

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('BEGIN');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-restaurant-bimini-betula-barry.sql', 'src/db/seed-restaurant-bbyc.sql', 'src/db/seed-restaurant-pirates-bight.sql', 'src/db/seed-spa-pirates-bight.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  const spas = await client.query('SELECT name FROM spa ORDER BY name');
  console.log('spas in scratch reset:', spas.rows.map(r => r.name));
  await client.query('ROLLBACK');
  console.log('rolled back - no changes kept');
  await client.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
"
```
Expected: `spas in scratch reset: [ 'Pirates Bight Spa' ]`; `rolled back - no changes kept`, no errors. (If `seed-extras.sql` or any other current seed file has been renamed/removed since this plan was written, drop it from the list and adjust — check `src/db/` first.)

- [ ] **Step 5: Commit**

```bash
git add src/db/seed-spa-pirates-bight.sql
git commit -m "Seed a spa for Pirates Bight"
```

---

### Task 5: Roll out to the remote `otadb` and push

**Files:** none (rollout only — code was already committed in Tasks 1-4).

**Interfaces:** none.

- [ ] **Step 1: Confirm with the user before touching the remote database**

Per this project's established practice, confirm with the user before running anything against the live `otadb`. Per the Global Constraints, mention the brief write-endpoint gap explicitly when asking.

- [ ] **Step 2: Run the migration against remote `otadb`, then immediately push**

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
  await client.query(fs.readFileSync('src/db/migrate-2026-08-01-spa-scoping.sql', 'utf8'));
  await client.end();
  console.log('remote migration applied');
})().catch(e => { console.error(e.message); process.exit(1); });
"
git push origin main
```
Expected: `remote migration applied`, no errors; the push succeeds.

- [ ] **Step 3: Seed the Pirates Bight spa on remote**

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
  await client.query(fs.readFileSync('src/db/seed-spa-pirates-bight.sql', 'utf8'));
  await client.end();
  console.log('Pirates Bight spa seeded on remote');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `Pirates Bight spa seeded on remote`, no errors.

- [ ] **Step 4: Wait for the code deploy, using nested-route behavior as the readiness signal**

```bash
for i in $(seq 1 20); do
  STATUS=$(curl -s --max-time 10 -o /tmp/spa-probe.json -w "%{http_code}" https://ota-u6ii.onrender.com/api/spa 2>/dev/null)
  echo "attempt $i: GET /api/spa HTTP $STATUS"
  if [ "$STATUS" = "200" ]; then
    HAS_PB=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/spa-probe.json','utf8')).some(s=>s.name==='Pirates Bight Spa'))")
    echo "has Pirates Bight Spa: $HAS_PB"
    if [ "$HAS_PB" = "true" ]; then echo "NEW CODE IS LIVE"; break; fi
  fi
  sleep 10
done
```
Expected: eventually `NEW CODE IS LIVE`.

- [ ] **Step 5: Live verification**

```bash
PB_SPA_LIVE=$(curl -s https://ota-u6ii.onrender.com/api/spa | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(s=>s.name==='Pirates Bight Spa').id))")
curl -s "https://ota-u6ii.onrender.com/api/spa/$PB_SPA_LIVE/treatments" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(t=>t.name)))"
```
Expected: treatments list is `[ 'Island Swedish Massage', 'Deep Tissue Massage', 'Ocean Facial' ]`.

- [ ] **Step 6: No commit needed** — this task is rollout/verification-only. If any live check fails, stop and investigate before considering this feature done.
