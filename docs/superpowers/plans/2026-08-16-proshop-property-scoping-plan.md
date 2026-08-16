# Pro Shop Property Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `property_id` to `proshop_item`, scope every pro shop route (catalogue + golf-booking-item attachment) to it, and switch all 6 routes from the old shared `requireApiKey` to `authenticate` — per `docs/superpowers/specs/2026-08-16-proshop-property-scoping-design.md`.

**Architecture:** Direct `property_id UUID NOT NULL REFERENCES property(id)` on `proshop_item` (`golf_booking_item` already has it from the golf property-scoping pass). `GET /items` switches from fully public to `authenticate`-only. All 5 other routes switch from `requireApiKey` to `authenticate`. Unlike every prior phase (restaurant/tours/spa/golf), there is no guest-facing/`authenticateOrApiKey` route anywhere in this module — pro shop items are attached to an existing golf booking by staff, never created directly by a guest. No backfill — both databases have zero rows in `proshop_item` and `golf_booking_item`.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-08-16-proshop-property-scoping-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm run dev` server, matching every prior property-scoping plan.
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
- **This module's cross-property booking-item checks need a real golf booking** (`golf_booking_item.booking_id` references `golf_booking`, which requires a real `tee_time`, which requires a real `golf_course`) — Task 2 creates these as fixtures via direct SQL rather than through the golf API, since only the booking's existence and `property_id` matter here, not realistic tee-time data.
- Get Robs's current API key fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'` if needed — it's been rotated multiple times in prior sessions. (Not actually needed in this plan — this module has no `X-Api-Key`-accepting route.)
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`.
- **Scope:** exactly `proshop_item` and the 6 routes in the design doc. No change to `golf.js` (already scoped) or any other module.

---

### Task 1: Migration — add `property_id` to `proshop_item`

**Files:**
- Create: `src/db/migrate-2026-08-16-proshop-property-scoping.sql`
- Modify: `src/db/schema.sql` (the `proshop_item` table definition)

**Interfaces:**
- Produces: `proshop_item.property_id` (`UUID NOT NULL REFERENCES property(id)`) — Task 2's controller changes query this directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-16-proshop-property-scoping.sql`:

```sql
-- One-time migration: add property_id to proshop_item, scoping the
-- catalogue to a property for the first time. No backfill needed --
-- both the local and live databases have zero rows (confirmed before
-- writing this migration), so NOT NULL is safe to add directly with
-- no DEFAULT. Idempotent-safe via IF NOT EXISTS. Run ONCE directly
-- against an already-populated database (NOT part of the normal reset
-- pipeline). golf_booking_item already has property_id from the golf
-- property-scoping migration -- nothing to add there.

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_property ON proshop_item(property_id);
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

```sql
CREATE TABLE IF NOT EXISTS proshop_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  category    VARCHAR(50),
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);
```

with:

```sql
CREATE TABLE IF NOT EXISTS proshop_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  category    VARCHAR(50),
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);
```

Also add the new index near the existing `golf_booking_item` index
(they're adjacent in the file):

Replace:

```sql
CREATE INDEX IF NOT EXISTS idx_golf_booking_item          ON golf_booking_item(booking_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
```

with:

```sql
CREATE INDEX IF NOT EXISTS idx_golf_booking_item          ON golf_booking_item(booking_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_property      ON proshop_item(property_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-proshop-property-scoping.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify the column exists and rejects NULL**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name = 'proshop_item' AND column_name = 'property_id'\");
  console.log(JSON.stringify(cols.rows, null, 2));
  try {
    await pool.query(\"INSERT INTO proshop_item (name, price) VALUES ('Bad Item', 10)\");
    console.log('UNEXPECTED: insert without property_id succeeded');
  } catch (e) {
    console.log('Expected rejection:', e.message);
  }
  await pool.end();
})();
"
```
Expected: 1 row, `is_nullable: 'NO'`; the insert attempt fails with a `null value in column "property_id"` (or equivalent) error.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-16-proshop-property-scoping.sql
git commit -m "Add property_id to proshop_item"
```

---

### Task 2: Scope routes and controllers, verify locally

**Files:**
- Modify: `src/routes/proshop.js`
- Modify: `src/controllers/proshop.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate` from `src/middleware/auth.js` (already exported, unchanged), `property_id` from Task 1.
- Produces: no new exports — existing routes gain property scoping and a changed auth requirement.

- [ ] **Step 1: Update the routes**

Replace the full contents of `src/routes/proshop.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/proshop');
const { requireApiKey } = require('../middleware/apiKey');

// Catalogue
router.get('/items', ctrl.listItems);
router.post('/items', requireApiKey, ctrl.createItem);
router.put('/items/:id', requireApiKey, ctrl.updateItem);

// Booking items
router.get('/booking/:booking_id', requireApiKey, ctrl.listBookingItems);
router.post('/booking/:booking_id', requireApiKey, ctrl.addBookingItem);
router.delete('/booking/:booking_id/:id', requireApiKey, ctrl.removeBookingItem);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/proshop');
const { authenticate } = require('../middleware/auth');

// Catalogue
router.get('/items', authenticate, ctrl.listItems);
router.post('/items', authenticate, ctrl.createItem);
router.put('/items/:id', authenticate, ctrl.updateItem);

// Booking items
router.get('/booking/:booking_id', authenticate, ctrl.listBookingItems);
router.post('/booking/:booking_id', authenticate, ctrl.addBookingItem);
router.delete('/booking/:booking_id/:id', authenticate, ctrl.removeBookingItem);

module.exports = router;
```

- [ ] **Step 2: Scope the controller functions**

Replace the full contents of `src/controllers/proshop.js`:

```js
const pool = require('../db');

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category } = req.query;
    let query = `SELECT * FROM proshop_item WHERE status = 'active'`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO proshop_item (name, description, category, price) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || null, category || null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { name, description, category, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE proshop_item SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         category    = COALESCE($3, category),
         price       = COALESCE($4, price),
         status      = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [name, description, category, price, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Booking items ─────────────────────────────────────────────────────────────

async function listBookingItems(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT gbi.*, p.category
       FROM golf_booking_item gbi
       LEFT JOIN proshop_item p ON p.id = gbi.item_id
       WHERE gbi.booking_id = $1
       ORDER BY p.category, gbi.item_name`,
      [req.params.booking_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function addBookingItem(req, res, next) {
  try {
    const { booking_id } = req.params;
    const { item_id, quantity = 1 } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows: items } = await pool.query(
      `SELECT * FROM proshop_item WHERE id = $1 AND status = 'active'`, [item_id]
    );
    if (!items.length) return res.status(404).json({ error: 'Item not found' });

    const { rows: bookings } = await pool.query(
      `SELECT id FROM golf_booking WHERE id = $1`, [booking_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Golf booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO golf_booking_item (booking_id, item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [booking_id, item_id, items[0].name, quantity, items[0].price]
    );
    res.status(201).json({ ...rows[0], total: rows[0].quantity * rows[0].unit_price });
  } catch (err) { next(err); }
}

async function removeBookingItem(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM golf_booking_item WHERE id = $1 AND booking_id = $2 RETURNING id`,
      [req.params.id, req.params.booking_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.status(204).end();
  } catch (err) { next(err); }
}

module.exports = { listItems, createItem, updateItem, listBookingItems, addBookingItem, removeBookingItem };
```

with:

```js
const pool = require('../db');

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category } = req.query;
    let query = `SELECT * FROM proshop_item WHERE status = 'active'`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND property_id = $${params.length}`;
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO proshop_item (property_id, name, description, category, price) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.property_id, name, description || null, category || null, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateItem(req, res, next) {
  try {
    const { name, description, category, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE proshop_item SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         category    = COALESCE($3, category),
         price       = COALESCE($4, price),
         status      = COALESCE($5, status)
       WHERE id = $6 AND property_id = $7 RETURNING *`,
      [name, description, category, price, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Booking items ─────────────────────────────────────────────────────────────

async function listBookingItems(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT gbi.*, p.category
       FROM golf_booking_item gbi
       LEFT JOIN proshop_item p ON p.id = gbi.item_id
       WHERE gbi.booking_id = $1 AND gbi.property_id = $2
       ORDER BY p.category, gbi.item_name`,
      [req.params.booking_id, req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function addBookingItem(req, res, next) {
  try {
    const { booking_id } = req.params;
    const { item_id, quantity = 1 } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows: items } = await pool.query(
      `SELECT * FROM proshop_item WHERE id = $1 AND status = 'active' AND property_id = $2`,
      [item_id, req.property_id]
    );
    if (!items.length) return res.status(404).json({ error: 'Item not found' });

    const { rows: bookings } = await pool.query(
      `SELECT id FROM golf_booking WHERE id = $1 AND property_id = $2`, [booking_id, req.property_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Golf booking not found' });

    const { rows } = await pool.query(
      `INSERT INTO golf_booking_item (property_id, booking_id, item_id, item_name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, booking_id, item_id, items[0].name, quantity, items[0].price]
    );
    res.status(201).json({ ...rows[0], total: rows[0].quantity * rows[0].unit_price });
  } catch (err) { next(err); }
}

async function removeBookingItem(req, res, next) {
  try {
    const { rows } = await pool.query(
      `DELETE FROM golf_booking_item WHERE id = $1 AND booking_id = $2 AND property_id = $3 RETURNING id`,
      [req.params.id, req.params.booking_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.status(204).end();
  } catch (err) { next(err); }
}

module.exports = { listItems, createItem, updateItem, listBookingItems, addBookingItem, removeBookingItem };
```

- [ ] **Step 3: Update Swagger**

Replace:

```js
    // ── Pro Shop ──────────────────────────────────────────────────────────────
    '/api/proshop/items': {
      get: { tags: ['Pro Shop'], summary: 'List catalogue items', security: [], parameters: [{ name: 'category', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of items' } } },
      post: { tags: ['Pro Shop'], summary: 'Create catalogue item', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/proshop/items/{id}': {
      put: { tags: ['Pro Shop'], summary: 'Update catalogue item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/proshop/booking/{booking_id}': {
      get: { tags: ['Pro Shop'], summary: 'List items on a golf booking', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of items with totals' } } },
      post: { tags: ['Pro Shop'], summary: 'Add item to golf booking', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['item_id'], properties: { item_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } }, responses: { 201: { description: 'Item added with locked unit_price' }, 404: { description: 'Item or booking not found' } } },
    },
    '/api/proshop/booking/{booking_id}/{id}': {
      delete: { tags: ['Pro Shop'], summary: 'Remove item from golf booking', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Removed' }, 404: { description: 'Not found' } } },
    },
```

with:

```js
    // ── Pro Shop ──────────────────────────────────────────────────────────────
    '/api/proshop/items': {
      get: { tags: ['Pro Shop'], summary: 'List catalogue items', security: [{ bearerAuth: [] }], parameters: [{ name: 'category', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of items' } } },
      post: { tags: ['Pro Shop'], summary: 'Create catalogue item', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/proshop/items/{id}': {
      put: { tags: ['Pro Shop'], summary: 'Update catalogue item', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/proshop/booking/{booking_id}': {
      get: { tags: ['Pro Shop'], summary: 'List items on a golf booking', security: [{ bearerAuth: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of items with totals' } } },
      post: { tags: ['Pro Shop'], summary: 'Add item to golf booking', security: [{ bearerAuth: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['item_id'], properties: { item_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } }, responses: { 201: { description: 'Item added with locked unit_price' }, 404: { description: 'Item or booking not found' } } },
    },
    '/api/proshop/booking/{booking_id}/{id}': {
      delete: { tags: ['Pro Shop'], summary: 'Remove item from golf booking', security: [{ bearerAuth: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Removed' }, 404: { description: 'Not found' } } },
    },
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Create test fixtures — a Robs golf booking and a foreign (BBYC) golf booking**

These booking-item tests need real `golf_booking` rows to reference (the FK requires it), but the specific tee-time/course data doesn't need to be realistic — insert the whole chain directly:

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const robs = 'a3e548af-a71d-46c0-ba61-f1f702e495be';
  const bbyc = 'e1000000-0000-0000-0000-000000000004';

  const robsCourse = await pool.query(\"INSERT INTO golf_course (property_id, name, holes, price_per_player) VALUES (\$1, 'Fixture Course', 18, 50) RETURNING id\", [robs]);
  const robsTee = await pool.query(\"INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players) VALUES (\$1, \$2, '2026-10-01', '09:00', 4) RETURNING id\", [robs, robsCourse.rows[0].id]);
  const robsBooking = await pool.query(\"INSERT INTO golf_booking (property_id, tee_time_id, contact_name, players, total_price) VALUES (\$1, \$2, 'Fixture Booking', 1, 50) RETURNING id\", [robs, robsTee.rows[0].id]);

  const bbycCourse = await pool.query(\"INSERT INTO golf_course (property_id, name, holes, price_per_player) VALUES (\$1, 'Foreign Course', 18, 50) RETURNING id\", [bbyc]);
  const bbycTee = await pool.query(\"INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players) VALUES (\$1, \$2, '2026-10-01', '09:00', 4) RETURNING id\", [bbyc, bbycCourse.rows[0].id]);
  const bbycBooking = await pool.query(\"INSERT INTO golf_booking (property_id, tee_time_id, contact_name, players, total_price) VALUES (\$1, \$2, 'Foreign Fixture Booking', 1, 50) RETURNING id\", [bbyc, bbycTee.rows[0].id]);

  // A booking_item that already exists under BBYC's booking -- needed for
  // Step 11 to test the property_id check specifically. Using item_id NULL
  // is fine here; item_id is nullable (FK is optional) and this row's own
  // fields (item_name/quantity/unit_price) are what removeBookingItem's
  // WHERE clause actually keys off, not the item_id link.
  const bbycBookingItem = await pool.query(\"INSERT INTO golf_booking_item (property_id, booking_id, item_name, quantity, unit_price) VALUES (\$1, \$2, 'Foreign Fixture Item', 1, 10) RETURNING id\", [bbyc, bbycBooking.rows[0].id]);

  console.log(JSON.stringify({ robsBookingId: robsBooking.rows[0].id, bbycBookingId: bbycBooking.rows[0].id, bbycBookingItemId: bbycBookingItem.rows[0].id }));
  await pool.end();
})();
" > /tmp/fixtures.json
cat /tmp/fixtures.json
```
Save the three printed ids as `ROBS_BOOKING_ID`, `BBYC_BOOKING_ID`, and `BBYC_BOOKING_ITEM_ID`.

- [ ] **Step 6: Mint a Robs token, verify `GET /items` requires auth and is scoped**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/items

echo "--- with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/items -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no-auth → `401 {"error":"Missing or invalid Authorization header"}`; with token → `200`, `[]` (empty — no items created yet).

- [ ] **Step 7: Verify `POST /api/proshop/items` — creation, scoping, old shared key rejected**

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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/items -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Golf Glove","category":"Apparel","price":25}'

echo "--- old shared API_KEY (X-Api-Key, no bearer) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/items -H "Content-Type: application/json" -H "X-Api-Key: $OLD_SHARED_KEY" -d '{"name":"Should Fail","price":1}'
```
Expected: Robs's token → `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"` — save the returned `id` as `ITEM_ID`. Old shared key → `401` (confirms full replacement, not additive).

- [ ] **Step 8: Verify `PUT /api/proshop/items/:id` — edit own item, cross-property 404**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"INSERT INTO proshop_item (property_id, name, price) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Item', 10) RETURNING id\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_item_id.txt
FOREIGN_ITEM_ID=$(cat /tmp/foreign_item_id.txt)

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
ITEM_ID="<the id from Step 7>"

echo "--- edit own item ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/proshop/items/$ITEM_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"price":30}'

echo "--- edit the foreign (BBYC) item ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/proshop/items/$FOREIGN_ITEM_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"price":1}'
```
Expected: own item → `200`, `"price":"30.00"`; foreign item → `404 {"error":"Item not found"}`.

- [ ] **Step 9: Verify `POST /api/proshop/booking/:booking_id` — success, cross-property booking 404, cross-property item 404**

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
ITEM_ID="<the id from Step 7>"
FOREIGN_ITEM_ID=$(cat /tmp/foreign_item_id.txt)
ROBS_BOOKING_ID="<from Step 5>"
BBYC_BOOKING_ID="<from Step 5>"

echo "--- add Robs's own item to Robs's own booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/booking/$ROBS_BOOKING_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"item_id\":\"$ITEM_ID\",\"quantity\":2}"

echo "--- add to the foreign (BBYC) booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/booking/$BBYC_BOOKING_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"item_id\":\"$ITEM_ID\"}"

echo "--- add a foreign item to Robs's own booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/booking/$ROBS_BOOKING_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"item_id\":\"$FOREIGN_ITEM_ID\"}"
```
Expected: own booking + own item → `201`, `"property_id":"a3e548af-a71d-46c0-ba61-f1f702e495be"`, `"total":60` (2 × 30.00) — save the returned `id` as `BOOKING_ITEM_ID`. Foreign booking → `404 {"error":"Golf booking not found"}`. Foreign item → `404 {"error":"Item not found"}`.

- [ ] **Step 10: Verify `GET /api/proshop/booking/:booking_id` — scoped, and confirm the no-existence-check behavior is intentional**

`listBookingItems` filters by `gbi.property_id` but — matching this codebase's established convention for list-style GETs (e.g. golf's `searchTeeTimes`, which also doesn't verify the parent course exists) — has no explicit "does this booking exist / belong to me" check. A foreign `booking_id` therefore returns `200` with an **empty array**, not `404`: there's simply no `golf_booking_item` row where both `booking_id` matches AND `property_id` matches Robs, since any real items under that foreign booking carry BBYC's `property_id`. This differs from `addBookingItem`, which does explicitly check booking ownership before inserting — that asymmetry is intentional (write paths validate the parent; list-style reads just filter), not a gap.

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
ROBS_BOOKING_ID="<from Step 5>"
BBYC_BOOKING_ID="<from Step 5>"

echo "--- old shared API_KEY (was requireApiKey) ---"
OLD_SHARED_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/booking/$ROBS_BOOKING_ID -H "X-Api-Key: $OLD_SHARED_KEY"

echo "--- with Robs's Clerk token, own booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/booking/$ROBS_BOOKING_ID -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- with Robs's Clerk token, foreign (BBYC) booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/booking/$BBYC_BOOKING_ID -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: old shared key → `401` (confirms full replacement); own booking → `200`, array containing the item from Step 9; foreign booking → `200`, `[]` (empty — Robs's token can't see BBYC's booking_item even though the booking_id itself is real, because the property filter excludes it).

- [ ] **Step 11: Verify `DELETE /api/proshop/booking/:booking_id/:id` — property_id check specifically, own succeeds**

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
ROBS_BOOKING_ID="<from Step 5>"
BBYC_BOOKING_ID="<from Step 5>"
BBYC_BOOKING_ITEM_ID="<from Step 5>"
BOOKING_ITEM_ID="<the id from Step 9>"

echo "--- delete a real item, matching booking_id AND item id, but under BBYC's property (via Robs's token) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X DELETE http://localhost:3000/api/proshop/booking/$BBYC_BOOKING_ID/$BBYC_BOOKING_ITEM_ID -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- delete for real, own booking ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X DELETE http://localhost:3000/api/proshop/booking/$ROBS_BOOKING_ID/$BOOKING_ITEM_ID -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: the first delete — where `booking_id` and item `id` both correctly match a real row, and only `property_id` doesn't — → `404 {"error":"Item not found"}`. This isolates the *new* `AND property_id = $3` check specifically, unlike a plain booking_id/id mismatch (which would already 404 even without property scoping). Real delete → `204` (empty body).

- [ ] **Step 12: Commit**

```bash
rm -f /tmp/tok.txt /tmp/foreign_item_id.txt /tmp/fixtures.json
git add src/routes/proshop.js src/controllers/proshop.js src/docs/swagger.js
git commit -m "Scope pro shop module to property_id, switch all routes to authenticate"
```

---

### Task 3: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-2's commits and `src/db/migrate-2026-08-16-proshop-property-scoping.sql`.

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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-proshop-property-scoping.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify the column on live**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name = 'proshop_item' AND column_name = 'property_id'\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: 1 row, `is_nullable: 'NO'`.

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
    console.log(j.paths['/api/proshop/items'].get.security ? 'READY' : 'NOT_READY');
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
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/proshop/items

echo "--- create an item with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/proshop/items -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"name":"Live Verify Item","price":15}'
```
Expected: no-auth → `401`; create → `201`, `"property_id":"b7a4c969-5e82-4c26-a587-17d2ab74858e"` (FORGE).

- [ ] **Step 8: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
