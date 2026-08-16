# Shop Entities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `shop` parent entity (Dive/Gift/Pro Shop, etc.), scope `proshop_item` under it via a nullable `shop_id`, and add shop CRUD routes alongside the existing catalogue routes — per `docs/superpowers/specs/2026-08-16-shop-entities-design.md`.

**Architecture:** New `shop` table mirrors `restaurant`/`golf_course`'s minimal shape (`id`, `property_id`, `name`, `description`, `status`). `proshop_item.shop_id` is a nullable FK — nullable because the 4 existing rows can't be auto-assigned with confidence (confirmed with the user: left NULL, fixed by hand later, out of scope for this plan). `listItems`/`createItem` gain `shop_id` scoping; `createItem` requires it in the body (`400` without it) and verifies the shop belongs to the caller's property (`404` otherwise) — this is what keeps new items from ever landing with a NULL `shop_id`. New `listShops`/`createShop`/`updateShop` controller functions follow the exact `listItems`/`createItem`/`updateItem` shape already in this file.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-08-16-shop-entities-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm start` server, matching every prior plan in this repo.
- **Confirm with the user before**: running the migration against the live database, and before `git push origin main` (triggers a live Render redeploy).
- Today's date: **2026-08-16**.
- **No backfill of the 4 existing `proshop_item` rows in this plan** — confirmed with the user (see spec's Non-goals). They stay `shop_id = NULL`. Do not add a step that assigns them to a shop.
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
- **Cross-property checks don't need a second staff identity** — insert a "foreign" shop/item directly via SQL under a different existing property (e.g. BBYC, `e1000000-0000-0000-0000-000000000004`) and confirm Robs's token can't reach it.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`. The backend has no auto-restart (`npm start` runs plain `node src/server.js`) — kill and restart it after any controller/route edit before verifying.
- **Scope:** exactly the `shop` table, `proshop_item.shop_id`, and the routes/controller functions in the design doc. No change to `golf_booking_item` or any other module.

---

### Task 1: Migration — create `shop`, add `shop_id` to `proshop_item`

**Files:**
- Create: `src/db/migrate-2026-08-16-shop-entities.sql`
- Modify: `src/db/schema.sql`

**Interfaces:**
- Produces: `shop` table (`id`, `property_id`, `name`, `description`, `status`); `proshop_item.shop_id` (`UUID REFERENCES shop(id)`, nullable) — Task 2's controller changes query both directly.

- [ ] **Step 1: Write the migration**

Create `src/db/migrate-2026-08-16-shop-entities.sql`:

```sql
-- One-time migration: adds the `shop` parent entity (a property can run
-- several shops -- Dive, Gift, Pro Shop, etc.) and scopes proshop_item
-- underneath it. shop_id is left NULLABLE: there are already 4 real
-- proshop_item rows locally with no shop to assign them to with any
-- confidence, and the user explicitly ruled out auto-creating a default
-- shop to backfill into. Those rows stay shop_id = NULL and get fixed by
-- hand, out of band -- this migration does not touch them. Going forward
-- the API requires shop_id on create (enforced in the controller, not
-- the DB, since a DB-level NOT NULL would reject the existing rows).
-- Idempotent-safe via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS shop (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_shop_property ON shop(property_id);

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shop(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_shop ON proshop_item(shop_id);
```

- [ ] **Step 2: Update `schema.sql`**

Replace:

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

with:

```sql
CREATE TABLE IF NOT EXISTS shop (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS proshop_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  shop_id     UUID          REFERENCES shop(id),
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  category    VARCHAR(50),
  price       NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'active'
);
```

Also add the two new indexes near the existing `proshop_item` index (they're adjacent in the file):

Replace:

```sql
CREATE INDEX IF NOT EXISTS idx_proshop_item_property      ON proshop_item(property_id);
```

with:

```sql
CREATE INDEX IF NOT EXISTS idx_shop_property               ON shop(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_property        ON proshop_item(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_shop            ON proshop_item(shop_id);
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-shop-entities.sql', 'utf8'));
  console.log('migration applied locally OK');
  await pool.end();
})();
"
```
Expected: `migration applied locally OK`.

- [ ] **Step 4: Verify the new column/table and that the 4 existing rows are untouched**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE (table_name = 'proshop_item' AND column_name = 'shop_id') OR (table_name = 'shop')\");
  console.log(JSON.stringify(cols.rows, null, 2));
  const items = await pool.query('SELECT id, name, shop_id FROM proshop_item');
  console.log(JSON.stringify(items.rows, null, 2));
  await pool.end();
})();
"
```
Expected: `shop_id` on `proshop_item` shows `is_nullable: 'YES'`; all 4 existing `proshop_item` rows show `shop_id: null`; `shop` table's columns listed (`id`, `property_id`, `name`, `description`, `status`).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-08-16-shop-entities.sql
git commit -m "Add shop entity, scope proshop_item to it"
```

---

### Task 2: Shop CRUD routes + item scoping, verify locally

**Files:**
- Modify: `src/routes/proshop.js`
- Modify: `src/controllers/proshop.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate` from `src/middleware/auth.js` (unchanged), `shop`/`proshop_item.shop_id` from Task 1.
- Produces: `GET/POST /api/proshop/shops`, `PUT /api/proshop/shops/:id`; `listItems`/`createItem` now shop-aware.

- [ ] **Step 1: Update the routes**

Replace the full contents of `src/routes/proshop.js`:

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

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/proshop');
const { authenticate } = require('../middleware/auth');

// Shops
router.get('/shops', authenticate, ctrl.listShops);
router.post('/shops', authenticate, ctrl.createShop);
router.put('/shops/:id', authenticate, ctrl.updateShop);

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

- [ ] **Step 2: Add shop CRUD + scope item routes in the controller**

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

with:

```js
const pool = require('../db');

// ── Shops ─────────────────────────────────────────────────────────────────────

async function listShops(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM shop WHERE status = 'active' AND property_id = $1 ORDER BY name`,
      [req.property_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createShop(req, res, next) {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO shop (property_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
      [req.property_id, name, description || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateShop(req, res, next) {
  try {
    const { name, description, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE shop SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         status      = COALESCE($3, status)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [name, description, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function listItems(req, res, next) {
  try {
    const { category, shop_id } = req.query;
    let query = `SELECT * FROM proshop_item WHERE status = 'active'`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (shop_id) { params.push(shop_id); query += ` AND shop_id = $${params.length}`; }
    params.push(req.property_id);
    query += ` AND property_id = $${params.length}`;
    query += ' ORDER BY category, name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createItem(req, res, next) {
  try {
    const { name, description, category, price, shop_id } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

    const { rows: shops } = await pool.query(
      `SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]
    );
    if (!shops.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows } = await pool.query(
      `INSERT INTO proshop_item (property_id, shop_id, name, description, category, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.property_id, shop_id, name, description || null, category || null, price]
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

module.exports = { listShops, createShop, updateShop, listItems, createItem, updateItem, listBookingItems, addBookingItem, removeBookingItem };
```

- [ ] **Step 3: Update Swagger**

Replace:

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

with:

```js
    // ── Pro Shop ──────────────────────────────────────────────────────────────
    '/api/proshop/shops': {
      get: { tags: ['Pro Shop'], summary: 'List shops', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of shops' } } },
      post: { tags: ['Pro Shop'], summary: 'Create shop', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/proshop/shops/{id}': {
      put: { tags: ['Pro Shop'], summary: 'Update shop', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/proshop/items': {
      get: { tags: ['Pro Shop'], summary: 'List catalogue items', security: [{ bearerAuth: [] }], parameters: [{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'shop_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of items' } } },
      post: { tags: ['Pro Shop'], summary: 'Create catalogue item', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price', 'shop_id'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, shop_id: { type: 'string', format: 'uuid' } } } } } }, responses: { 201: { description: 'Created' } } },
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

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
cd "c:\Users\robert\source\repos\OTA" && (tasklist //FI "WINDOWTITLE eq node*" 2>/dev/null; true)
```
Kill whatever local `node src/server.js` process is running (however it was started this session) and restart it with `npm start`, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify shop CRUD**

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

echo "--- list shops (should be empty) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/shops -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- create Dive Shop ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/shops -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Dive Shop","description":"Scuba and snorkel gear"}'

echo "--- create Gift Shop ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/shops -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Gift Shop"}'
```
Expected: empty list first (`[]`, unless earlier manual testing left rows — fine either way); both creates → `201` with `property_id` matching Robs. Save the Dive Shop `id` as `DIVE_SHOP_ID` and Gift Shop `id` as `GIFT_SHOP_ID`.

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
DIVE_SHOP_ID="<from above>"

echo "--- rename Dive Shop ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/proshop/shops/$DIVE_SHOP_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"description":"Updated description"}'

echo "--- list shops again ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/shops -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: rename → `200`, `description` updated. List → both shops present.

- [ ] **Step 6: Verify item creation requires and validates `shop_id`**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"INSERT INTO shop (property_id, name) VALUES ('e1000000-0000-0000-0000-000000000004', 'Foreign Shop') RETURNING id\")
  .then(r => { console.log(r.rows[0].id); pool.end(); });
" > /tmp/foreign_shop_id.txt
FOREIGN_SHOP_ID=$(cat /tmp/foreign_shop_id.txt)

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
DIVE_SHOP_ID="<Dive Shop id from Step 5>"

echo "--- create item with no shop_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/items -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Wetsuit","price":80}'

echo "--- create item with a foreign shop_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/items -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"name\":\"Wetsuit\",\"price\":80,\"shop_id\":\"$FOREIGN_SHOP_ID\"}"

echo "--- create item with Dive Shop's own shop_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/proshop/items -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"name\":\"Wetsuit\",\"price\":80,\"shop_id\":\"$DIVE_SHOP_ID\",\"category\":\"Wetsuits\"}"
```
Expected: no `shop_id` → `400 {"error":"shop_id is required"}`; foreign `shop_id` → `404 {"error":"Shop not found"}`; own `shop_id` → `201`, `shop_id` matches `DIVE_SHOP_ID`. Save the returned `id` as `DIVE_ITEM_ID`.

- [ ] **Step 7: Verify `GET /api/proshop/items?shop_id=X` scoping, and that legacy NULL-shop_id rows never appear**

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
DIVE_SHOP_ID="<from Step 5>"
GIFT_SHOP_ID="<from Step 5>"

echo "--- items for Dive Shop ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/proshop/items?shop_id=$DIVE_SHOP_ID" -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- items for Gift Shop (should be empty) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/proshop/items?shop_id=$GIFT_SHOP_ID" -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- all items for the property, unfiltered ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/items -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: Dive Shop filter → array containing the Wetsuit item from Step 6, no others. Gift Shop filter → `[]`. Unfiltered → includes the Wetsuit item plus the pre-existing legacy items (Golf Glove, Golf Balls, Golf Tees — these have `shop_id: null`, confirming they're still reachable unfiltered but never match a `shop_id` filter).

- [ ] **Step 8: Verify `PUT /api/proshop/items/:id` is unchanged (no `shop_id` edit support)**

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
DIVE_ITEM_ID="<from Step 6>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/proshop/items/$DIVE_ITEM_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"price":95}'
```
Expected: `200`, `price` updated to `95.00`, `shop_id` still the Dive Shop's id (proves `updateItem` is untouched — no accidental `shop_id` field added to its `UPDATE`).

- [ ] **Step 9: Verify deleting a shop doesn't cascade to its items**

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
DIVE_SHOP_ID="<from Step 5>"
DIVE_ITEM_ID="<from Step 6>"

echo "--- soft-delete Dive Shop ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/proshop/shops/$DIVE_SHOP_ID -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"inactive"}'

echo "--- Dive Shop no longer in the active list ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/proshop/shops -H "Authorization: Bearer $CLERK_TOKEN"
```
```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DIVE_ITEM_ID = process.argv[1];
pool.query('SELECT id, shop_id, status FROM proshop_item WHERE id = \$1', [DIVE_ITEM_ID])
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); pool.end(); });
" "<DIVE_ITEM_ID from Step 6>"
```
Expected: shop soft-delete → `200`; Dive Shop absent from the active shops list; the item row directly queried from Postgres still has `shop_id` set to the (now-inactive) Dive Shop's id and `status: 'active'` — unchanged, no cascade.

- [ ] **Step 10: Commit**

```bash
rm -f /tmp/tok.txt /tmp/foreign_shop_id.txt
git add src/routes/proshop.js src/controllers/proshop.js src/docs/swagger.js
git commit -m "Add shop CRUD routes, scope catalogue items to shop_id"
```

---

### Task 3: Push and verify live

**Files:** none (migration execution, deploy, and verification only).

**Interfaces:**
- Consumes: Tasks 1-2's commits and `src/db/migrate-2026-08-16-shop-entities.sql`.

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
  await pool.query(fs.readFileSync('src/db/migrate-2026-08-16-shop-entities.sql', 'utf8'));
  console.log('migration applied to prod OK');
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `migration applied to prod OK`.

- [ ] **Step 3: Verify on live**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = await pool.query(\"SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'proshop_item' AND column_name = 'shop_id') OR (table_name = 'shop')\");
  console.log(JSON.stringify(cols.rows, null, 2));
  await pool.end();
})();
" 2>&1 | grep -v -E "Warning|next major|libpq|postgresql.org|trace-warnings|prepare for this|sslmode=verify-full"
```
Expected: `shop` table's columns, and `proshop_item.shop_id`, both present.

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
    console.log(j.paths['/api/proshop/shops'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 7: Verify live — shop create + item create round-trip**

This needs a live Clerk admin token for FORGE, which requires the browser-based sign-in-ticket flow (the dev-only `sessions.createSession` shortcut doesn't work on live). Use whichever browser automation MCP tool is connected at execution time, following the same recipe used in prior live-verification tasks this session (mint a sign-in ticket via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key from `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, navigate with `redirect_url=https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`).

If no browser tool is connected when this step is reached, stop and ask the user how to proceed (wait for reconnection, have them supply a token, or skip this specific step) rather than skipping silently.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"

echo "--- create a shop ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/proshop/shops -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d '{"name":"Live Verify Shop"}'
```
Save the returned `id` as `LIVE_SHOP_ID`, then:
```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/proshop/items -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d "{\"name\":\"Live Verify Item\",\"price\":15,\"shop_id\":\"$LIVE_SHOP_ID\"}"
```
Expected: shop create → `201`; item create → `201`, `shop_id` matches `LIVE_SHOP_ID`.

- [ ] **Step 8: No further action**

This task is migration + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
