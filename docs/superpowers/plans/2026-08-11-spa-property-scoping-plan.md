# Spa Property Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `property_id` to all 5 spa tables with a backfill migration, scope every spa route to it, and switch appointment creation to `authenticateOrApiKey` — per `docs/superpowers/specs/2026-08-11-spa-property-scoping-design.md`.

**Architecture:** Direct `property_id UUID NOT NULL REFERENCES property(id)` on `spa`, `spa_treatment`, `spa_therapist`, `spa_slot`, `spa_appointment` (no parent-chain joins). Unlike tours, real data exists on both databases, so this uses the restaurant module's nullable-then-backfill-then-lock migration sequence, with an explicit id-based mapping (not name-based, to stay unambiguous across two databases where the same spa name maps to different properties). `GET`s that were previously public become `authenticate`-only; every `requireApiKey` write becomes `authenticate`-only except appointment creation, which becomes `authenticateOrApiKey`.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL.

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm run dev` server.
- **Confirm with the user before**: running the migration against the live database, and before `git push origin main` (triggers a live Render redeploy).
- Today's date: **2026-08-11**.
- **Test identity:** Robs (`a3e548af-a71d-46c0-ba61-f1f702e495be`) locally, FORGE (`b7a4c969-5e82-4c26-a587-17d2ab74858e`) live. Mint a Robs Clerk token (dev-only shortcut) with:
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
  Tokens expire in ~60 seconds. For live, the dev-only shortcut doesn't work — live verification needs the browser-based sign-in-ticket flow (mint via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key, navigate with `redirect_url=https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`). If no browser tool is connected when Task 4 reaches that step, stop and ask the user rather than skipping silently.
- **Known IDs for this migration:**
  - Local spas: Pirates Bight Spa `d16f1ce4-65a7-40f4-b0d5-876c6e6eea4c`, Test Spa A `537361b2-b771-408e-99fe-026eb055dc8a`, Test Spa B `3de2c0e5-c1dd-4f4a-b10f-cadc481e8d1e` — all map to Robs `a3e548af-a71d-46c0-ba61-f1f702e495be`.
  - Live spa: Pirates Bight Spa `6ecb0669-d3f5-4765-82f8-53fb5d6eb116` — maps to FORGE `b7a4c969-5e82-4c26-a587-17d2ab74858e`.
- **Cross-property checks** don't need a second staff identity — insert a "foreign" spa directly via SQL under a different existing property (e.g. BBYC, `e1000000-0000-0000-0000-000000000004`), matching the technique used in the tours plan.
- Get Robs's/FORGE's current API key fresh via `SELECT api_key FROM property WHERE id = '...'`.
- **Shell gotcha:** extract a captured key by matching the `prop_` prefix line (`grep '^prop_' raw.txt > clean.txt`), not a blanket warning-filter — leftover blank lines corrupt header values built from `$(cat file)`.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`.
- **Scope:** exactly the 5 tables and routes in the design doc. No MCP tools in this plan (explicitly deferred, matching how tours got its tool later as a separate pass).

---

### Task 1: Migration — backfill and scope all 5 spa tables

**Files:**
- Create: `src/db/migrate-2026-08-11-spa-property-scoping.sql`
- Modify: `src/db/schema.sql` (the `spa`, `spa_treatment`, `spa_therapist`, `spa_slot`, `spa_appointment` table definitions and their indexes)

**Interfaces:**
- Produces: `property_id` (`NOT NULL`) on all 5 spa tables — Task 2's controller changes query these directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-11-spa-property-scoping.sql`:

```sql
-- One-time migration: add property_id to spa, spa_treatment, spa_therapist,
-- spa_slot, and spa_appointment. Unlike tours, real data exists on both
-- databases (confirmed before writing this migration: local has 3 spas,
-- live has 1 with 6 real appointments and 740 slots), so this uses the
-- restaurant module's nullable -> backfill -> NOT NULL sequence, not a
-- direct NOT NULL add.
--
-- Backfill is id-based, not name-based: "Pirates Bight Spa" exists on
-- both databases but maps to a DIFFERENT property on each (FORGE live,
-- Robs local), so matching by name would be ambiguous/wrong depending on
-- which database this runs against. Each UPDATE below targets a specific
-- known id; on a database where that id doesn't exist, the UPDATE is a
-- harmless no-op (0 rows matched) -- this makes the same file safe to run
-- unchanged against both local and live.
--
-- Idempotent-safe throughout. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).

ALTER TABLE spa             ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_treatment   ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_therapist   ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_slot        ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);

-- Live's Pirates Bight Spa -> FORGE (no-op on local, that id doesn't exist there)
UPDATE spa SET property_id = 'b7a4c969-5e82-4c26-a587-17d2ab74858e'
WHERE id = '6ecb0669-d3f5-4765-82f8-53fb5d6eb116' AND property_id IS NULL;

-- Everything else still unmapped (all 3 local spas, on local; nothing left on live) -> Robs
UPDATE spa SET property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'
WHERE property_id IS NULL;

UPDATE spa_treatment st SET property_id = s.property_id
FROM spa s WHERE s.id = st.spa_id AND st.property_id IS NULL;

UPDATE spa_therapist th SET property_id = s.property_id
FROM spa s WHERE s.id = th.spa_id AND th.property_id IS NULL;

UPDATE spa_slot ss SET property_id = th.property_id
FROM spa_therapist th WHERE th.id = ss.therapist_id AND ss.property_id IS NULL;

UPDATE spa_appointment sa SET property_id = ss.property_id
FROM spa_slot ss WHERE ss.id = sa.slot_id AND sa.property_id IS NULL;

ALTER TABLE spa             ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_treatment   ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_therapist   ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_slot        ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN property_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spa_property             ON spa(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_treatment_property    ON spa_treatment(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_property    ON spa_therapist(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_property         ON spa_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_property  ON spa_appointment(property_id);
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

```sql
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
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id       UUID         NOT NULL REFERENCES spa_slot(id),
  guest_id      UUID         REFERENCES guest(id),
  clerk_user_id VARCHAR(100),
  contact_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  status        VARCHAR(20)  DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa       ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa       ON spa_therapist(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_therapist_date ON spa_slot(therapist_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_spa_slot_treatment      ON spa_slot(treatment_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_slot    ON spa_appointment(slot_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_clerk_user ON spa_appointment(clerk_user_id);
```

with:

```sql
CREATE TABLE IF NOT EXISTS spa (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  phone       VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spa_treatment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  spa_id        UUID          NOT NULL REFERENCES spa(id),
  name          VARCHAR(100)  NOT NULL,
  description   TEXT,
  duration_mins INT           NOT NULL,
  price         NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20)   DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_therapist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  spa_id      UUID         NOT NULL REFERENCES spa(id),
  name        VARCHAR(100) NOT NULL,
  status      VARCHAR(20)  DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS spa_slot (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID         NOT NULL REFERENCES property(id),
  therapist_id UUID         NOT NULL REFERENCES spa_therapist(id),
  treatment_id UUID         NOT NULL REFERENCES spa_treatment(id),
  slot_date    DATE         NOT NULL,
  slot_time    TIME         NOT NULL,
  status       VARCHAR(20)  DEFAULT 'available',
  UNIQUE (therapist_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS spa_appointment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  slot_id       UUID         NOT NULL REFERENCES spa_slot(id),
  guest_id      UUID         REFERENCES guest(id),
  clerk_user_id VARCHAR(100),
  contact_name  VARCHAR(100) NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(30),
  status        VARCHAR(20)  DEFAULT 'confirmed',
  notes         TEXT,
  created_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa       ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa       ON spa_therapist(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_therapist_date ON spa_slot(therapist_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_spa_slot_treatment      ON spa_slot(treatment_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_slot    ON spa_appointment(slot_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_clerk_user ON spa_appointment(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_spa_property             ON spa(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_treatment_property    ON spa_treatment(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_property    ON spa_therapist(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_property         ON spa_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_property  ON spa_appointment(property_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-11-spa-property-scoping.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify the backfill and NOT NULL constraint**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const spas = await pool.query('SELECT id, name, property_id FROM spa ORDER BY name');
  console.log(JSON.stringify(spas.rows, null, 2));
  const cols = await pool.query(\"SELECT table_name, is_nullable FROM information_schema.columns WHERE table_name IN ('spa','spa_treatment','spa_therapist','spa_slot','spa_appointment') AND column_name = 'property_id' ORDER BY table_name\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
"
```
Expected: all 3 local spas have `property_id: 'a3e548af-a71d-46c0-ba61-f1f702e495be'`; all 5 tables show `is_nullable: 'NO'`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-11-spa-property-scoping.sql
git commit -m "Add property_id to spa tables, backfill existing data"
```

---

### Task 2: Scope routes and controllers

**Files:**
- Modify: `src/routes/spa.js`
- Modify: `src/controllers/spa.js`

**Interfaces:**
- Consumes: `authenticate`/`authenticateOrApiKey` from `src/middleware/auth.js` (already exported).
- Produces: no new exports — existing routes gain property scoping and a changed auth requirement.

- [ ] **Step 1: Update the routes**

Replace the full contents of `src/routes/spa.js`:

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
router.put('/:spa_id/therapists/:id', requireApiKey, ctrl.updateTherapist);

// Slots
router.get('/:spa_id/slots', requireApiKey, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', ctrl.searchSlots);

// Appointments
router.get('/:spa_id/appointments', requireApiKey, ctrl.listAppointments);
router.get('/:spa_id/appointments/:id', requireApiKey, ctrl.getAppointment);
router.post('/:spa_id/appointments', requireApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', requireApiKey, ctrl.updateAppointment);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Spas
router.get('/', authenticate, ctrl.listSpas);
router.get('/:id', authenticate, ctrl.getSpa);
router.post('/', authenticate, ctrl.createSpa);
router.put('/:id', authenticate, ctrl.updateSpa);

// Treatments
router.get('/:spa_id/treatments', authenticate, ctrl.listTreatments);
router.post('/:spa_id/treatments', authenticate, ctrl.createTreatment);
router.put('/:spa_id/treatments/:id', authenticate, ctrl.updateTreatment);

// Therapists
router.get('/:spa_id/therapists', authenticate, ctrl.listTherapists);
router.post('/:spa_id/therapists', authenticate, ctrl.createTherapist);
router.put('/:spa_id/therapists/:id', authenticate, ctrl.updateTherapist);

// Slots
router.get('/:spa_id/slots', authenticate, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', authenticate, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', authenticate, ctrl.searchSlots);

// Appointments
router.get('/:spa_id/appointments', authenticate, ctrl.listAppointments);
router.get('/:spa_id/appointments/:id', authenticate, ctrl.getAppointment);
router.post('/:spa_id/appointments', authenticateOrApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', authenticate, ctrl.updateAppointment);

module.exports = router;
```

- [ ] **Step 2: Scope the controller functions**

Replace the full contents of `src/controllers/spa.js` with:

```js
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Spas ──────────────────────────────────────────────────────────────────────

async function listSpas(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa WHERE property_id = $1 ORDER BY name', [req.property_id]);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getSpa(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa WHERE id = $1 AND property_id = $2', [req.params.id, req.property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createSpa(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa (property_id, name, description, phone) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.property_id, name, description ?? null, phone ?? null]
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
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [name, description, phone, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Treatments ────────────────────────────────────────────────────────────────

async function listTreatments(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_treatment WHERE spa_id = $1 AND property_id = $2 AND status = 'active' ORDER BY name",
      [req.params.spa_id, req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTreatment(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name, description, duration_mins, price } = req.body;
    if (!name || !duration_mins || !price) return res.status(400).json({ error: 'name, duration_mins, and price are required' });

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_treatment (property_id, spa_id, name, description, duration_mins, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, spa_id, name, description ?? null, duration_mins, price]
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
       WHERE id = $6 AND spa_id = $7 AND property_id = $8 RETURNING *`,
      [name, description, duration_mins, price, status, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Treatment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Therapists ────────────────────────────────────────────────────────────────

async function listTherapists(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_therapist WHERE spa_id = $1 AND property_id = $2 AND status = 'active' ORDER BY name",
      [req.params.spa_id, req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTherapist(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

    const { rows } = await pool.query(
      `INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, $3) RETURNING *`, [req.property_id, spa_id, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTherapist(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_therapist SET
         name   = COALESCE($1, name),
         status = COALESCE($2, status)
       WHERE id = $3 AND spa_id = $4 AND property_id = $5 RETURNING *`,
      [name, status, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found' });
    res.json(rows[0]);
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
      WHERE st.spa_id = $1 AND ss.property_id = $2
    `;
    const params = [spa_id, req.property_id];
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

    const spaRes = await pool.query('SELECT id FROM spa WHERE id = $1 AND property_id = $2', [spa_id, req.property_id]);
    if (!spaRes.rows.length) return res.status(404).json({ error: 'Spa not found' });

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
          `INSERT INTO spa_slot (property_id, therapist_id, treatment_id, slot_date, slot_time)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (therapist_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [req.property_id, therapist_id, treatment_id, date, time]
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
        AND ss.property_id = $2
        AND ss.slot_date = $3
        AND ss.status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM spa_appointment sa
          WHERE sa.slot_id = ss.id AND sa.status != 'cancelled'
        )
    `;
    const params = [spa_id, req.property_id, date];
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
    const { date, status, guest_id, clerk_user_id } = req.query;
    let query = `
      SELECT sa.*, ss.slot_date, ss.slot_time,
             st.name AS therapist_name, tr.name AS treatment_name, tr.price
      FROM spa_appointment sa
      JOIN spa_slot ss ON ss.id = sa.slot_id
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1 AND sa.property_id = $2
    `;
    const params = [spa_id, req.property_id];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND sa.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND sa.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND sa.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getAppointment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { rows } = await pool.query(
      `SELECT sa.*, ss.slot_date, ss.slot_time,
              st.name AS therapist_name, tr.name AS treatment_name, tr.price
       FROM spa_appointment sa
       JOIN spa_slot ss ON ss.id = sa.slot_id
       JOIN spa_therapist st ON st.id = ss.therapist_id
       JOIN spa_treatment tr ON tr.id = ss.treatment_id
       WHERE sa.id = $1 AND st.spa_id = $2 AND sa.property_id = $3`,
      [id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createAppointment(req, res, next) {
  const { spa_id } = req.params;
  const { slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!slot_id || !contact_name) return res.status(400).json({ error: 'slot_id and contact_name are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ss.* FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE ss.id = $1 AND st.spa_id = $2 AND ss.property_id = $3`,
      [slot_id, spa_id, req.property_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slotRes.rows[0].status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is not available' }); }

    if (guest_id) {
      const guestRes = await client.query('SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!guestRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

    const conflictRes = await client.query(
      `SELECT id FROM spa_appointment WHERE slot_id = $1 AND status != 'cancelled'`, [slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot already booked' }); }

    const { rows } = await client.query(
      `INSERT INTO spa_appointment (property_id, slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.property_id, slot_id, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null]
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
         AND sa.property_id = $5
       RETURNING sa.*`,
      [status, notes, id, spa_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listSpas, getSpa, createSpa, updateSpa,
  listTreatments, createTreatment, updateTreatment,
  listTherapists, createTherapist, updateTherapist,
  listSlots, bulkCreateSlots, searchSlots,
  listAppointments, getAppointment, createAppointment, updateAppointment,
};
```

- [ ] **Step 3: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 4: Insert a "foreign" spa under BBYC for cross-property checks**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  \"INSERT INTO spa (property_id, name) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Spa') RETURNING id\"
).then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_spa_id.txt
cat /tmp/foreign_spa_id.txt
```

- [ ] **Step 5: Verify `GET /api/spa` — auth required, scoped**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa

echo "--- with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401`; with token → `200`, the 3 local spas, not "Foreign Spa".

- [ ] **Step 6: Verify `GET /api/spa/:id` cross-property 404**

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
FOREIGN_SPA_ID=$(cat /tmp/foreign_spa_id.txt)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa/$FOREIGN_SPA_ID -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `404 {"error":"Spa not found"}`.

- [ ] **Step 7: Verify `POST /api/spa`, and old shared key rejected**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"New Test Spa"}'

echo "--- old shared API_KEY ---"
cd "c:\Users\robert\source\repos\OTA"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" -d '{"name":"Should Fail"}'
```
Expected: Robs's token → `201`, `property_id` matches Robs. Save `id` as `SPA_ID`. Old shared key → `401`.

- [ ] **Step 8: Verify treatment/therapist creation ownership check (cross-property 404)**

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
SPA_ID="<SPA_ID from Step 7>"
FOREIGN_SPA_ID=$(cat /tmp/foreign_spa_id.txt)

echo "--- create treatment on Robs's own spa ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$SPA_ID/treatments -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Massage","duration_mins":60,"price":100}'

echo "--- create treatment on the foreign spa ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$FOREIGN_SPA_ID/treatments -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Should Fail","duration_mins":60,"price":100}'

echo "--- create therapist on Robs's own spa ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$SPA_ID/therapists -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Jamie"}'
```
Expected: own spa → both `201`; foreign spa → `404 {"error":"Spa not found"}`. Save the treatment's `id` as `TREATMENT_ID` and the therapist's `id` as `THERAPIST_ID`.

- [ ] **Step 9: Verify `POST /:spa_id/slots/bulk` cross-property 404**

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
SPA_ID="<SPA_ID from Step 7>"
FOREIGN_SPA_ID=$(cat /tmp/foreign_spa_id.txt)
THERAPIST_ID="<THERAPIST_ID from Step 8>"
TREATMENT_ID="<TREATMENT_ID from Step 8>"

echo "--- bulk create on Robs's own spa ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$SPA_ID/slots/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"therapist_id\":\"$THERAPIST_ID\",\"treatment_id\":\"$TREATMENT_ID\",\"from\":\"2026-10-01\",\"to\":\"2026-10-01\",\"times\":[\"09:00\"]}"

echo "--- bulk create on the foreign spa ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$FOREIGN_SPA_ID/slots/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"therapist_id\":\"$THERAPIST_ID\",\"treatment_id\":\"$TREATMENT_ID\",\"from\":\"2026-10-01\",\"to\":\"2026-10-01\",\"times\":[\"09:00\"]}"
```
Expected: own spa → `201 {"created":1,...}`. Save the slot's `id` as `SLOT_ID`. Foreign spa → `404 {"error":"Spa not found"}`.

- [ ] **Step 10: Verify `GET /:spa_id/slots/search` requires auth**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/spa/<SPA_ID>/slots/search?date=2026-10-01"
```
Expected: `401` (previously public).

- [ ] **Step 11: Verify `POST /:spa_id/appointments` via `X-Api-Key` — success, cross-property slot 404, cross-property guest 404**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)
SPA_ID="<SPA_ID from Step 7>"
SLOT_ID="<SLOT_ID from Step 9>"

echo "--- book own slot ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$SPA_ID/appointments -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d "{\"slot_id\":\"$SLOT_ID\",\"contact_name\":\"Spa Appt Test\"}"

echo "--- fake slot_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$SPA_ID/appointments -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"slot_id":"00000000-0000-0000-0000-000000000000","contact_name":"Should Fail"}'
```
Expected: own slot → `201`, `property_id` matches Robs. Fake slot → `404 {"error":"Slot not found"}`.

For the guest cross-property check:
```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id FROM guest WHERE property_id = 'e1000000-0000-0000-0000-000000000004' LIMIT 1\")
  .then(r => { console.log(r.rows.length ? r.rows[0].id : 'NO_BBYC_GUEST'); pool.end(); });
"
```
If a BBYC guest id is printed, create one more slot (repeat Step 9's own-spa bulk-create with a different date) and:
```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)
SPA_ID="<SPA_ID>"
NEW_SLOT_ID="<a fresh slot id>"
BBYC_GUEST_ID="<the id just printed>"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/spa/$SPA_ID/appointments -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d "{\"slot_id\":\"$NEW_SLOT_ID\",\"guest_id\":\"$BBYC_GUEST_ID\",\"contact_name\":\"Cross Property Guest Test\"}"
```
Expected: `404 {"error":"Guest not found"}`. If no BBYC guest exists, skip and note it as skipped — not a blocker, the slot-ownership check already exercises the same mechanism.

- [ ] **Step 12: Verify `GET /:spa_id/appointments` — old shared key rejected, staff token scoped**

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
SPA_ID="<SPA_ID from Step 7>"

cd "c:\Users\robert\source\repos\OTA"
echo "--- old shared API_KEY ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa/$SPA_ID/appointments -H "X-Api-Key: $OLD_SHARED_KEY"

echo "--- with Robs's Clerk token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/spa/$SPA_ID/appointments -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: old shared key → `401`; Robs's token → `200`, includes the appointment from Step 11.

- [ ] **Step 13: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_key.txt /tmp/foreign_spa_id.txt
git add src/routes/spa.js src/controllers/spa.js
git commit -m "Scope spa module to property_id, switch appointment creation to authenticateOrApiKey"
```

---

### Task 3: Document in Swagger

**Files:**
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: nothing from Task 2 (documentation only).

- [ ] **Step 1: Add `security` to every spa path**

Replace the full contents of the `// ── Spa ──` section in `src/docs/swagger.js`:

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
    '/api/spa/{spa_id}/therapists/{id}': {
      put: { tags: ['Spa'], summary: 'Update therapist (e.g. activate/deactivate)', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Therapist not found' } } },
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
      get: { tags: ['Spa'], summary: 'List appointments', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of appointments' } } },
      post: { tags: ['Spa'], summary: 'Book spa appointment', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Appointment booked' }, 409: { description: 'Slot already booked' } } },
    },
    '/api/spa/{spa_id}/appointments/{id}': {
      get: { tags: ['Spa'], summary: 'Get appointment by ID', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Appointment with therapist and treatment details' }, 404: { description: 'Appointment not found' } } },
      put: { tags: ['Spa'], summary: 'Update appointment', parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```

with:

```js
    // ── Spa ──────────────────────────────────────────────────────────────────
    '/api/spa': {
      get: { tags: ['Spa'], summary: 'List all spas', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of spas' } } },
      post: { tags: ['Spa'], summary: 'Create spa', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{id}': {
      get: { tags: ['Spa'], summary: 'Get spa by ID', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Spa' } } },
      put: { tags: ['Spa'], summary: 'Update spa', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/spa/{spa_id}/treatments': {
      get: { tags: ['Spa'], summary: 'List treatments', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of treatments' } } },
      post: { tags: ['Spa'], summary: 'Create treatment', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{spa_id}/therapists': {
      get: { tags: ['Spa'], summary: 'List therapists', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of therapists' } } },
      post: { tags: ['Spa'], summary: 'Create therapist', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{spa_id}/therapists/{id}': {
      put: { tags: ['Spa'], summary: 'Update therapist (e.g. activate/deactivate)', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Therapist not found' } } },
    },
    '/api/spa/{spa_id}/slots': {
      get: { tags: ['Spa'], summary: 'List slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'therapist_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of slots' } } },
    },
    '/api/spa/{spa_id}/slots/bulk': {
      post: { tags: ['Spa'], summary: 'Bulk generate spa slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['therapist_id', 'treatment_id', 'from', 'to', 'times'], properties: { therapist_id: { type: 'string', format: 'uuid' }, treatment_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'] } } } } } }, responses: { 201: { description: 'Slots created' }, 400: { description: 'therapist_id or treatment_id does not belong to this spa' } } },
    },
    '/api/spa/{spa_id}/slots/search': {
      get: { tags: ['Spa'], summary: 'Search available spa slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available slots with therapist and treatment info' } } },
    },
    '/api/spa/{spa_id}/appointments': {
      get: { tags: ['Spa'], summary: 'List appointments', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of appointments' } } },
      post: { tags: ['Spa'], summary: 'Book spa appointment', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Appointment booked' }, 409: { description: 'Slot already booked' } } },
    },
    '/api/spa/{spa_id}/appointments/{id}': {
      get: { tags: ['Spa'], summary: 'Get appointment by ID', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Appointment with therapist and treatment details' }, 404: { description: 'Appointment not found' } } },
      put: { tags: ['Spa'], summary: 'Update appointment', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log('spa GET security:', JSON.stringify(j.paths['/api/spa'].get.security));
  console.log('appointments POST security:', JSON.stringify(j.paths['/api/spa/{spa_id}/appointments'].post.security));
});
"
```
Expected: `spa GET security: [{\"bearerAuth\":[]}]`; `appointments POST security: [{\"bearerAuth\":[]},{\"apiKeyAuth\":[]}]`.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document spa module's auth requirements in Swagger"
```

---

### Task 4: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-3's commits and `src/db/migrate-2026-08-11-spa-property-scoping.sql`.

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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-11-spa-property-scoping.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify the live backfill**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const spas = await pool.query('SELECT id, name, property_id FROM spa');
  console.log(JSON.stringify(spas.rows, null, 2));
  const cols = await pool.query(\"SELECT table_name, is_nullable FROM information_schema.columns WHERE table_name IN ('spa','spa_treatment','spa_therapist','spa_slot','spa_appointment') AND column_name = 'property_id' ORDER BY table_name\");
  console.log('all NOT NULL:', cols.rows.every(r => r.is_nullable === 'NO'));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: Pirates Bight Spa has `property_id: 'b7a4c969-5e82-4c26-a587-17d2ab74858e'` (FORGE); `all NOT NULL: true`.

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
    console.log(j.paths['/api/spa'].get.security ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 7: Mint a live Clerk session token for FORGE's admin**

Requires the browser-based sign-in-ticket flow (per Global Constraints). If no browser tool is connected, stop and ask the user rather than skipping silently.

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const dotenv = require('dotenv');
const parsed = dotenv.parse(fs.readFileSync('.env'));
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: parsed['old-CLERK_SECRET_KEY'] });
client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })
  .then(t => console.log(t.url + '&redirect_url=' + encodeURIComponent('https://accounts.hotal.forge-build.co.uk/user')))
  .catch(e => console.error('ERR:', e.message));
"
```
Navigate there with your browser tool, evaluate `window.Clerk.session.getToken({ skipCache: true })`.

- [ ] **Step 8: Verify live — no-auth 401, and a real read with FORGE's token**

```bash
LIVE_CLERK_TOKEN="<token from Step 7>"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/spa

echo "--- list spas with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/spa -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
```
Expected: no-auth → `401`; with token → `200`, includes "Pirates Bight Spa". This is deliberately read-only against live given the real appointment/slot data there — no write operations are exercised against production in this step.

- [ ] **Step 9: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
