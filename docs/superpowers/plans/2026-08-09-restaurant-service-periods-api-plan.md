# Public API for Restaurant Service Periods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET`/`PUT /api/restaurant/:restaurant_id/service-periods` so a caller can read and set a restaurant's bookable time windows through the API — per `docs/superpowers/specs/2026-08-09-restaurant-service-periods-api-design.md`.

**Architecture:** Two new controller functions (`listServicePeriods`, `setServicePeriods`) added to the existing `src/controllers/restaurant.js`, two new routes added to `src/routes/restaurant.js`, both `authenticate`-gated (no role restriction), matching the existing `Tables` sibling resource. `PUT` replaces the restaurant's entire `service_period` set in one transaction (delete all, insert the new list). No schema change — `service_period` already exists.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- **No automated test framework** exists in this project. Every "verify" step is a **manual check**: `curl` against a running `npm run dev` server, with exact expected output.
- **Two databases:** local Postgres (`hotel_booking`, `DATABASE_URL`) and the live Render/Neon database (`DATABASE_URL_LIVE` in local `.env`, same DB Render's own `DATABASE_URL` points at).
- **Confirm with the user before** `git push origin main` (triggers a live Render redeploy). Per this project's established practice. No live schema change in this plan (no migration needed), so no separate schema-change confirmation gate.
- Today's date: **2026-08-09**.
- **`.env`'s `CLERK_SECRET_KEY` is the DEV Clerk instance's key** (`valid-oriole-82.clerk.accounts.dev`). The LIVE instance's secret key is under the differently-named `old-CLERK_SECRET_KEY` in the same `.env` — read via `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, not `process.env`.
- **Test identities:**
  - Local/dev: property **"Robs"** (`a3e548af-a71d-46c0-ba61-f1f702e495be`), Clerk user `robooko7@gmail.com` → dev user id `user_3C7aK7SeaIKBPlgtuekEpSWhifn`, `org:admin` of `org_3HgaHm8lBYjrFnHmIjIebQjtDx2`. Robs has **zero restaurants** — Task 1 creates one for testing.
  - Live: property **"FORGE"** (`b7a4c969-5e82-4c26-a587-17d2ab74858e`), same email → live user id `user_3CLBg0yYT3odh00x09a2KnPiGr3`, `org:admin` of `org_3HgczASlL7aWmKNREJPFxhrKkNd`. FORGE already has a restaurant with **zero** `service_period` rows — `"Sally Smith"`, id `2f0551f5-1627-492f-b6ba-83b3828d5e37` — this is the exact real-world case the design doc describes; Task 2 uses it directly instead of creating a new one.
- Clerk session tokens expire in **~60 seconds** — mint a fresh one immediately before use.
- Before any local verification block, confirm the dev server is actually responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`. `nodemon` auto-reloads on file changes but does NOT auto-restart a crashed process — if it's not responding, start it fresh (`npm run dev`, background) and wait for `Server running on port 3000`.
- **Scope:** `service_period` only. `restaurant_seasonal_closure` (a similar seed-only gap) is explicitly out of scope — do not add routes for it.

---

### Task 1: Add `listServicePeriods`/`setServicePeriods`, wire routes, verify locally

**Files:**
- Modify: `src/controllers/restaurant.js:144-146` (insert new section between `updateTable` and the `// ── Availability search` comment)
- Modify: `src/controllers/restaurant.js:411-416` (`module.exports`)
- Modify: `src/routes/restaurant.js` (insert new routes between `Tables` and `Availability`)

**Interfaces:**
- Consumes: `pool` from `src/db/index.js` (already imported in `restaurant.js`), `isValidTime` from `src/middleware/validate.js` (already imported in `restaurant.js`), `authenticate` from `src/middleware/auth.js` (already imported in `routes/restaurant.js`).
- Produces: `listServicePeriods(req, res, next)` and `setServicePeriods(req, res, next)`, exported from `src/controllers/restaurant.js` — nothing else in this plan depends on them beyond Task 2's Swagger docs (which don't call them directly).

- [ ] **Step 1: Add the two controller functions**

In `src/controllers/restaurant.js`, replace:

```js
  } catch (err) { next(err); }
}

// ── Availability search ─────────────────────────────────────────────────────
```

with:

```js
  } catch (err) { next(err); }
}

// ── Service Periods ──────────────────────────────────────────────────────────

async function listServicePeriods(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      'SELECT id, label, start_time, end_time FROM service_period WHERE restaurant_id = $1 ORDER BY start_time',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function setServicePeriods(req, res, next) {
  const { restaurant_id } = req.params;
  const { periods } = req.body;

  if (!Array.isArray(periods)) {
    return res.status(400).json({ error: 'periods must be an array' });
  }
  for (const p of periods) {
    if (!p.start_time || !p.end_time) {
      return res.status(400).json({ error: 'Each period requires start_time and end_time' });
    }
    if (!isValidTime(p.start_time) || !isValidTime(p.end_time)) {
      return res.status(400).json({ error: 'Invalid time format, use HH:MM' });
    }
    if (p.start_time >= p.end_time) {
      return res.status(400).json({ error: 'Each period\'s start_time must be before its end_time' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const restaurantRes = await client.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    await client.query('DELETE FROM service_period WHERE restaurant_id = $1', [restaurant_id]);

    const inserted = [];
    for (const p of periods) {
      const { rows } = await client.query(
        `INSERT INTO service_period (property_id, restaurant_id, label, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, label, start_time, end_time`,
        [req.property_id, restaurant_id, p.label ?? null, p.start_time, p.end_time]
      );
      inserted.push(rows[0]);
    }

    await client.query('COMMIT');
    res.json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// ── Availability search ─────────────────────────────────────────────────────
```

- [ ] **Step 2: Export the two new functions**

Replace:

```js
module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  searchAvailability,
  listReservations, getReservation, createReservation, updateReservation,
};
```

with:

```js
module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  listServicePeriods, setServicePeriods,
  searchAvailability,
  listReservations, getReservation, createReservation, updateReservation,
};
```

- [ ] **Step 3: Wire the routes**

In `src/routes/restaurant.js`, replace:

```js
// Tables
router.get('/:restaurant_id/tables', authenticate, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, ctrl.updateTable);

// Availability
router.get('/:restaurant_id/availability/search', ctrl.searchAvailability);
```

with:

```js
// Tables
router.get('/:restaurant_id/tables', authenticate, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, ctrl.updateTable);

// Service Periods
router.get('/:restaurant_id/service-periods', authenticate, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticate, ctrl.setServicePeriods);

// Availability
router.get('/:restaurant_id/availability/search', ctrl.searchAvailability);
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`. `nodemon` picks up the file changes automatically.

- [ ] **Step 5: Mint a real Clerk session token for Robs's admin (self-service)**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
client.signInTokens.createSignInToken({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn', expiresInSeconds: 3600 })
  .then(t => console.log(t.url + '&redirect_url=' + encodeURIComponent('https://valid-oriole-82.accounts.dev/user')))
  .catch(e => console.error('ERR:', e.message));
"
```
1. Use your browser automation tool to open a new page and navigate to the printed URL.
2. Evaluate this JavaScript on the page:
```js
async () => {
  await window.Clerk.load();
  const token = await window.Clerk.session.getToken({ skipCache: true });
  return { token, orgId: window.Clerk.organization?.id };
}
```
Expected: `orgId` is `org_3HgaHm8lBYjrFnHmIjIebQjtDx2`. Capture `token` — **it expires in ~60 seconds**, use it immediately in the next step.

- [ ] **Step 6: Create a test restaurant under Robs (Robs has none today)**

```bash
CLERK_TOKEN="<token from Step 5>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" \
  -d '{"name":"Test Bistro","default_duration_minutes":90}'
```
Expected: `201`. Save the returned `id` as `TEST_RESTAURANT_ID`.

- [ ] **Step 7: Verify — `GET` on a restaurant with no periods returns an empty array**

(Mint a fresh token per Step 5 if more than ~60 seconds have passed.)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `200 []`.

- [ ] **Step 8: Verify — `PUT` with two periods creates them, and a follow-up `GET` confirms persistence**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" \
  -d '{"periods":[{"label":"Lunch","start_time":"11:30","end_time":"14:30"},{"label":"Dinner","start_time":"17:30","end_time":"21:30"}]}'
```
Expected: `200`, array of 2 rows, each with a generated `id`, correct `label`/`start_time`/`end_time`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `200`, same 2 rows (order: Lunch then Dinner, since `ORDER BY start_time`).

- [ ] **Step 9: Verify — a reservation inside the new window now succeeds (previously impossible)**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/reservations \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" \
  -d '{"reservation_date":"2026-09-01","start_time":"12:00","contact_name":"Verify Test","party_size":2}'
```
Expected: NOT the old `400 "start_time is outside service hours"`. Since `Test Bistro` has zero tables, expect `409 {"error":"No tables available for this time"}` instead — this specific error proves the service-hours check passed and it got to the table-availability check.

- [ ] **Step 10: Verify — `PUT` again fully replaces (old rows gone, not merged)**

(Mint a fresh token per Step 5 if needed.)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" \
  -d '{"periods":[{"start_time":"09:00","end_time":"10:00"}]}'
```
Expected: `200`, array of exactly 1 row (`label: null`, `09:00`–`10:00`).

```bash
curl -s http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: exactly 1 row — confirms the previous 2 (Lunch/Dinner) are gone, not accumulated to 3.

- [ ] **Step 11: Verify — `periods: []` clears all hours**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" \
  -d '{"periods":[]}'
```
Expected: `200 []`.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/reservations \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" \
  -d '{"reservation_date":"2026-09-01","start_time":"12:00","contact_name":"Verify Test 2","party_size":2}'
```
Expected: `400 {"error":"start_time is outside service hours"}` — back to the original error, since there are no periods again.

- [ ] **Step 12: Verify the error cases**

```bash
echo "--- non-array periods ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"periods":"not-an-array"}'

echo "--- start_time >= end_time ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"periods":[{"start_time":"14:00","end_time":"12:00"}]}'

echo "--- malformed time ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$TEST_RESTAURANT_ID/service-periods -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"periods":[{"start_time":"25:00","end_time":"12:00"}]}'

echo "--- nonexistent restaurant_id (GET) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/00000000-0000-0000-0000-000000000000/service-periods -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected in order: `400 {"error":"periods must be an array"}`; `400 {"error":"Each period's start_time must be before its end_time"}`; `400 {"error":"Invalid time format, use HH:MM"}`; `404 {"error":"Restaurant not found"}`.

(Mint a fresh token per Step 5 between these if more than ~60 seconds elapse between calls.)

- [ ] **Step 13: Regression check — an existing seeded restaurant is unaffected**

```bash
curl -s http://localhost:3000/api/restaurant | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const rows = JSON.parse(d);
  const bonito = rows.find(r => r.name === 'Bonito');
  console.log(bonito ? bonito.id : 'NOT FOUND (expected on Robs\\'s property — this is fine, Bonito belongs to a different property)');
});
"
```
This is expected to print `NOT FOUND...` — `Bonito` belongs to a different property than Robs, and `GET /api/restaurant` is property-scoped. This step exists to confirm that fact, not to actually test Bonito (cross-property regression testing isn't meaningful here since Robs's token can't see or touch Bonito's data at all — that's the property-scoping behavior working correctly, unrelated to this change).

- [ ] **Step 14: Commit**

```bash
git add src/controllers/restaurant.js src/routes/restaurant.js
git commit -m "Add GET/PUT /api/restaurant/:restaurant_id/service-periods"
```

---

### Task 2: Document in Swagger, push, verify live on the real broken restaurant

**Files:**
- Modify: `src/docs/swagger.js:284-287` (insert new path after `/api/restaurant/{restaurant_id}/tables`)

**Interfaces:**
- Consumes: Task 1's commit.

- [ ] **Step 1: Add the Swagger path**

In `src/docs/swagger.js`, replace:

```js
    '/api/restaurant/{restaurant_id}/tables': {
      get: { tags: ['Restaurant'], summary: 'List tables', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of tables' } } },
      post: { tags: ['Restaurant'], summary: 'Create table', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_number', 'seats'], properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{restaurant_id}/availability/search': {
```

with:

```js
    '/api/restaurant/{restaurant_id}/tables': {
      get: { tags: ['Restaurant'], summary: 'List tables', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of tables' } } },
      post: { tags: ['Restaurant'], summary: 'Create table', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_number', 'seats'], properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{restaurant_id}/service-periods': {
      get: { tags: ['Restaurant'], summary: "List a restaurant's service periods (bookable windows)", parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of service periods' }, 404: { description: 'Restaurant not found' } } },
      put: { tags: ['Restaurant'], summary: "Replace all of a restaurant's service periods", parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['periods'], properties: { periods: { type: 'array', items: { type: 'object', required: ['start_time', 'end_time'], properties: { label: { type: 'string', nullable: true, example: 'Lunch' }, start_time: { type: 'string', example: '11:30' }, end_time: { type: 'string', example: '14:30' } } } } } } } } }, responses: { 200: { description: 'The new array of service periods' }, 400: { description: 'Invalid periods' }, 404: { description: 'Restaurant not found' } } },
    },
    '/api/restaurant/{restaurant_id}/availability/search': {
```

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log('has GET:', !!j.paths['/api/restaurant/{restaurant_id}/service-periods']?.get);
  console.log('has PUT:', !!j.paths['/api/restaurant/{restaurant_id}/service-periods']?.put);
});
"
```
Expected: both `true`.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document GET/PUT /api/restaurant/:restaurant_id/service-periods in Swagger"
```

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
    console.log(j.paths['/api/restaurant/{restaurant_id}/service-periods'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually prints `READY`.

- [ ] **Step 7: Mint a live Clerk session token for FORGE's admin**

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
Navigate there with your browser tool, then evaluate the same `window.Clerk.session.getToken({ skipCache: true })` snippet as Task 1 Step 5. Confirm `orgId` is `org_3HgczASlL7aWmKNREJPFxhrKkNd` before proceeding.

- [ ] **Step 8: Verify live — the real broken restaurant ("Sally Smith") currently has zero periods and fails reservations**

```bash
LIVE_CLERK_TOKEN="<token from Step 7>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/restaurant/2f0551f5-1627-492f-b6ba-83b3828d5e37/service-periods -H "Authorization: Bearer $LIVE_CLERK_TOKEN"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/restaurant/2f0551f5-1627-492f-b6ba-83b3828d5e37/reservations \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" \
  -d '{"reservation_date":"2026-09-01","start_time":"12:00","contact_name":"Pre-fix check","party_size":2}'
```
Expected: `GET` → `200 []`. `POST` reservation → `400 {"error":"start_time is outside service hours"}` — confirms this is the exact real bug from the spec's Context section, still present until the next step.

- [ ] **Step 9: Fix it — set Sally Smith's service periods**

(Mint a fresh token per Step 7 if needed.)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT https://ota-u6ii.onrender.com/api/restaurant/2f0551f5-1627-492f-b6ba-83b3828d5e37/service-periods \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" \
  -d '{"periods":[{"label":"Lunch","start_time":"11:30","end_time":"14:30"},{"label":"Dinner","start_time":"17:30","end_time":"21:30"}]}'
```
Expected: `200`, array of 2 rows.

- [ ] **Step 10: Verify live — reservation creation now works for Sally Smith**

(Mint a fresh token per Step 7 if needed.)

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/restaurant/2f0551f5-1627-492f-b6ba-83b3828d5e37/reservations \
  -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" \
  -d '{"reservation_date":"2026-09-01","start_time":"12:00","contact_name":"Post-fix check","party_size":2}'
```
Expected: NOT `400`. Sally Smith likely has zero tables (it's a leftover test entry) — expect `409 {"error":"No tables available for this time"}`, proving the service-hours check now passes; the remaining 409 is a separate, pre-existing condition (no tables), not something this plan is responsible for fixing.

- [ ] **Step 11: No further action** — this task is Swagger docs + deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 5.
