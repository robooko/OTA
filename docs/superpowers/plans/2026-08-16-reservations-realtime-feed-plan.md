# Reservations Realtime Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `new-reservation`/`reservation-status-changed` Ably events on reservation create/status-change, and add a new property-wide `GET /api/restaurant/reservations` endpoint, so the Dashboard can show a live cross-restaurant reservations feed — per `docs/superpowers/specs/2026-08-16-reservations-realtime-feed-design.md`.

**Architecture:** `src/lib/ably.js` gains two publish functions, same shape as the existing three, on a new `property:{property_id}:reservations` channel. `createReservation` publishes after its existing transaction commits (mirroring `restaurantOrders.js`'s `publishNewOrder` placement). `updateReservation` reads the reservation's status before applying its update, and only publishes `reservation-status-changed` if the value actually changed — a fix versus the original companion-session proposal, since this is a combined update endpoint (status/notes/contact fields together), not a dedicated status-only endpoint like orders has. `listPropertyReservations` is a new controller function reusing the existing `restaurant_table` join, added as a new route at the fixed one-segment path `/reservations`. **Route ordering matters:** `src/routes/restaurant.js` already has `router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant)` registered near the top of the file (single segment, same depth as `/reservations`) — Express matches same-depth routes in registration order, so `/reservations` MUST be registered before that `/:id` route, or every request to it would instead hit `getRestaurant` with `id="reservations"` (confirmed as a live bug during this session: that exact request crashes the whole server, since `getRestaurant` doesn't validate its `:id` param is a UUID before querying). This is unrelated to the two-segment `/:restaurant_id/reservations` route, which never collides regardless of ordering.

**Tech Stack:** Node/Express, `pg` (plain SQL), PostgreSQL, `ably` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-08-16-reservations-realtime-feed-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm start` server, plus the Ably dashboard/log for the publish side, matching every prior plan in this repo.
- **Confirm with the user before**: pushing to `origin/main` (triggers a live Render redeploy).
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
- **Robs's API key**: fetch fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'` — don't assume a previously-seen value is current.
- **A restaurant + table to book against**: `SELECT id FROM restaurant WHERE property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be' AND status = 'active' LIMIT 1` for the restaurant, then confirm it has at least one active table with `SELECT id, seats FROM restaurant_table WHERE restaurant_id = '<restaurant_id>' AND status = 'active'`.
- `ABLY_API_KEY` is already present in `OTA/.env` (added for the Event Inquiries module).
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3` should print `200`. No auto-restart — kill and restart `npm start` (as a background task) after any controller/route change.
- **Scope:** exactly the two new `src/lib/ably.js` exports, the `createReservation`/`updateReservation` publish wiring, and the new `listPropertyReservations` endpoint. No other change to `restaurant.js`.

---

### Task 1: Ably publish wiring — create and status-change

**Files:**
- Modify: `src/lib/ably.js`
- Modify: `src/controllers/restaurant.js`

**Interfaces:**
- Produces: `publishNewReservation(propertyId, reservation)`, `publishReservationStatusChanged(propertyId, reservation)` in `src/lib/ably.js`, both publishing to `property:{property_id}:reservations`.

- [ ] **Step 1: Add the two publish functions**

In `src/lib/ably.js`, replace:

```js
async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}

module.exports = { publishNewInquiry, publishNewOrder, publishOrderStatusChanged, client };
```

with:

```js
async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}

async function publishNewReservation(propertyId, reservation) {
  if (!client) return; // no key configured -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:reservations`);
  await channel.publish('new-reservation', reservation);
}

async function publishReservationStatusChanged(propertyId, reservation) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:reservations`);
  await channel.publish('reservation-status-changed', reservation);
}

module.exports = {
  publishNewInquiry, publishNewOrder, publishOrderStatusChanged,
  publishNewReservation, publishReservationStatusChanged,
  client,
};
```

(If the Event Inquiry Replies plan has already landed and added `publishNewReply` to this same file, merge both additions into the same `module.exports` block rather than overwriting each other.)

- [ ] **Step 2: Wire the publish into `createReservation`**

In `src/controllers/restaurant.js`, replace the top import line:

```js
const pool = require('../db');
const { isValidDate, isValidTime } = require('../middleware/validate');
```

with:

```js
const pool = require('../db');
const { isValidDate, isValidTime } = require('../middleware/validate');
const { publishNewReservation, publishReservationStatusChanged } = require('../lib/ably');
```

Then, inside `createReservation`, replace:

```js
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```

with:

```js
    await client.query('COMMIT');
    publishNewReservation(req.property_id, { ...rows[0], restaurant_id }).catch(
      (err) => console.error('Ably publish failed:', err.message)
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```

(`restaurant_id` is already destructured from `req.params` at the top of `createReservation` — `restaurant_reservation` has no `restaurant_id` column of its own, only `table_id`, so this patches it onto the published payload rather than adding a join.)

- [ ] **Step 3: Wire the conditional publish into `updateReservation`**

Replace the full body of `updateReservation`:

```js
async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone, metadata } = req.body;
    if (metadata !== undefined && !isValidMetadata(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }
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
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

with:

```js
async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone, metadata } = req.body;
    if (metadata !== undefined && !isValidMetadata(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }

    const { rows: beforeRows } = await pool.query(
      'SELECT status FROM restaurant_reservation WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!beforeRows.length) return res.status(404).json({ error: 'Reservation not found' });
    const previousStatus = beforeRows[0].status;

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
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    if (status && status !== previousStatus) {
      publishReservationStatusChanged(rows[0].property_id, { ...rows[0], restaurant_id: req.params.restaurant_id }).catch(
        (err) => console.error('Ably publish failed:', err.message)
      );
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify `new-reservation` publishes on create**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows: r } = await pool.query(\"SELECT id FROM restaurant WHERE property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be' AND status = 'active' LIMIT 1\");
  const { rows: k } = await pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\");
  console.log(JSON.stringify({ restaurant_id: r[0]?.id, api_key: k[0]?.api_key }));
  await pool.end();
})();
" > /tmp/setup.json
cat /tmp/setup.json
RESTAURANT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/setup.json')).restaurant_id)")
ROBS_API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/setup.json')).api_key)")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant/$RESTAURANT_ID/reservations \
  -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_API_KEY" \
  -d '{"reservation_date":"2026-12-10","start_time":"19:00","contact_name":"Reservations Feed Test","contact_email":"test@example.com","party_size":2}'
```
Expected: `201`. Check the Ably dashboard's channel log for `property:a3e548af-a71d-46c0-ba61-f1f702e495be:reservations` (or `npx ably channels:log` if available), confirm a `new-reservation` event with `restaurant_id` matching `$RESTAURANT_ID` in its payload — this is the fix from the spec, verifying `restaurant_id` actually made it onto the published data despite not being a column on the row itself. Save the returned reservation `id` as `RESERVATION_ID`.

- [ ] **Step 6: Verify `reservation-status-changed` publishes only when status actually changes**

```bash
CLERK_TOKEN=$(node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  console.log((await client.sessions.getToken(session.id)).jwt);
})();
")
RESTAURANT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/setup.json')).restaurant_id)")
RESERVATION_ID="<from Step 5>"

echo "--- change status: confirmed -> cancelled ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$RESTAURANT_ID/reservations/$RESERVATION_ID \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"cancelled"}'
```
Expected: `200`, `status: "cancelled"`. Check the Ably channel log — a `reservation-status-changed` event should appear with `status: "cancelled"`.

```bash
echo "--- notes-only edit, no status in body ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$RESTAURANT_ID/reservations/$RESERVATION_ID \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"notes":"just a note, no status change"}'

echo "--- status set to its current value (no real change) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant/$RESTAURANT_ID/reservations/$RESERVATION_ID \
  -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"cancelled"}'
```
Expected: both `200`. Check the Ably channel log after each — **no** new `reservation-status-changed` event for either call. This is the core fix from the spec: confirm the channel log's event count after this step equals the count right after the first status change above (one event total for this reservation, not three).

- [ ] **Step 7: Verify the best-effort Ably framing — publish failure doesn't fail the request**

Temporarily edit `.env` to set `ABLY_API_KEY=invalid-key-value`, restart the server, then:
```bash
RESTAURANT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/setup.json')).restaurant_id)")
ROBS_API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/setup.json')).api_key)")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant/$RESTAURANT_ID/reservations \
  -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_API_KEY" \
  -d '{"reservation_date":"2026-12-11","start_time":"19:00","contact_name":"Ably Failure Test","contact_email":"test@example.com","party_size":2}'
```
Expected: still `201` — the create succeeds regardless of Ably's state. Check the server's console output for a logged `Ably publish failed: ...` line, confirming the failure was caught, not swallowed silently or left unhandled.

Restore the real `ABLY_API_KEY` value in `.env` and restart the server before continuing.

- [ ] **Step 8: Commit**

```bash
rm -f /tmp/setup.json
git add src/lib/ably.js src/controllers/restaurant.js
git commit -m "Publish reservation realtime events (create, conditional status-change)"
```

---

### Task 2: Property-wide reservations endpoint

**Files:**
- Modify: `src/routes/restaurant.js`
- Modify: `src/controllers/restaurant.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticate` from `src/middleware/auth.js`.
- Produces: `GET /api/restaurant/reservations` → `Reservation[]` (property-wide, `restaurant_id`/`table_number`/`seats`/`location` included via join) — the companion frontend plan's `fetchReservations` calls this directly.

- [ ] **Step 1: Add `listPropertyReservations` to the controller**

In `src/controllers/restaurant.js`, replace:

```js
module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  listServicePeriods, setServicePeriods,
  searchAvailability,
  listReservations, getReservation, createReservation, updateReservation,
};
```

with:

```js
async function listPropertyReservations(req, res, next) {
  try {
    const { date, status } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rr.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    query += ' ORDER BY rr.created_at DESC LIMIT 50';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = {
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant,
  listTables, createTable, updateTable,
  listServicePeriods, setServicePeriods,
  searchAvailability,
  listReservations, getReservation, createReservation, updateReservation,
  listPropertyReservations,
};
```

- [ ] **Step 2: Add the route — BEFORE the `/:id` restaurant route, not in the Reservations section**

**This exact placement matters and is not optional.** `src/routes/restaurant.js` already has, near the top of the file:

```js
// Restaurants
router.get('/', authenticateOrApiKey, ctrl.listRestaurants);
router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant);
```

`/:id` is a single dynamic segment, the same depth as the new `/reservations` route. Express matches same-depth routes in registration order, so if `/reservations` were registered anywhere after `/:id` (e.g. down in the "Reservations" section, where it might seem to belong visually), every request to `GET /api/restaurant/reservations` would instead match `/:id` first, with `id` literally set to the string `"reservations"` — `getRestaurant` would then try to query with that as a UUID and crash (confirmed live during this session: this exact request pattern takes down the whole server, since `getRestaurant` doesn't validate `:id` is a UUID before querying Postgres with it). The new route must be registered in the "Restaurants" block itself, immediately after `listRestaurants` and before `getRestaurant`.

In `src/routes/restaurant.js`, replace:

```js
// Restaurants
router.get('/', authenticateOrApiKey, ctrl.listRestaurants);
router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant);
router.post('/', authenticate, ctrl.createRestaurant);
router.put('/:id', authenticate, ctrl.updateRestaurant);
```

with:

```js
// Restaurants
router.get('/', authenticateOrApiKey, ctrl.listRestaurants);
router.get('/reservations', authenticate, ctrl.listPropertyReservations);
router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant);
router.post('/', authenticate, ctrl.createRestaurant);
router.put('/:id', authenticate, ctrl.updateRestaurant);
```

The existing "Reservations" section further down stays completely unchanged:

```js
// Reservations
router.get('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.getReservation);
router.post('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.updateReservation);

module.exports = router;
```

(That two-segment `/:restaurant_id/reservations` shape never collides with the new one-segment `/reservations` route regardless of ordering — only same-depth routes compete. The collision is specifically with `/:id`, which is why the fix has to go where `/:id` is, not where the other reservation routes are.)

- [ ] **Step 3: Update Swagger**

In `src/docs/swagger.js`, find the Reservations paths (search for `'/api/restaurant/{restaurant_id}/reservations'`) and add a new path entry directly above it:

```js
    '/api/restaurant/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations across all of the property\'s restaurants', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reservations, newest first, max 50' } } },
    },
```

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify auth, cross-restaurant results, and filters**

```bash
CLERK_TOKEN=$(node -e "
require('dotenv').config();
const { createClerkClient } = require('@clerk/backend');
const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
(async () => {
  const session = await client.sessions.createSession({ userId: 'user_3C7aK7SeaIKBPlgtuekEpSWhifn' });
  console.log((await client.sessions.getToken(session.id)).jwt);
})();
")

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/reservations

echo "--- with Robs's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/reservations -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- confirm this hit listPropertyReservations, not getRestaurant (the route-collision check) ---"
curl -s http://localhost:3000/api/restaurant/reservations -H "Authorization: Bearer $CLERK_TOKEN" | node -e "
let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
  const body = JSON.parse(d);
  console.log('Is array:', Array.isArray(body));
  console.log('Has a bare .name/.status at top level (would indicate a single restaurant object, i.e. the collision bug):', typeof body === 'object' && !Array.isArray(body) && 'name' in body);
});
"

echo "--- filtered by status=cancelled ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/reservations?status=cancelled" -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- filtered by date=2026-12-10 (Task 1's test reservation's date) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/reservations?date=2026-12-10" -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- filtered by an unrelated date ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/reservations?date=2099-01-01" -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no auth → `401`. With token → `200`, includes Task 1's test reservation(s), each row has `table_number`/`seats`/`location`/`restaurant_id` populated from the join (not `null`). Filtered by `status=cancelled` → only includes the reservation from Task 1 Step 6 (which was set to `cancelled`), not any `confirmed` ones. Filtered by `date=2026-12-10` → includes it; filtered by `date=2099-01-01` → empty array, proving the date filter is actually applied, not ignored.

- [ ] **Step 6: Verify property scoping — a different property's reservations don't leak in**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id FROM restaurant WHERE property_id = 'e1000000-0000-0000-0000-000000000004' AND status = 'active' LIMIT 1\")
  .then(r => { console.log(r.rows[0]?.id ?? 'NONE'); pool.end(); });
"
```
If that prints a real id, create a reservation for it (via its own property's API key) and confirm it does **not** appear in Robs's `GET /api/restaurant/reservations` response from Step 5. If it prints `NONE` (no active restaurant for that property), skip this check and note it as unverified rather than fabricating data.

- [ ] **Step 7: Commit**

```bash
git add src/routes/restaurant.js src/controllers/restaurant.js src/docs/swagger.js
git commit -m "Add property-wide GET /api/restaurant/reservations"
```

---

### Task 3: Push and verify live

**Files:** none (deploy and verification only — no schema change in this plan, so no migration step).

**Interfaces:**
- Consumes: Tasks 1-2's commits.

- [ ] **Step 1: Push**

Per Global Constraints, confirm with the user before pushing.

```bash
git push origin main
```

- [ ] **Step 2: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log(j.paths['/api/restaurant/reservations'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 3: Verify live — auth, create+publish, property-wide list**

Needs a live Clerk admin token for FORGE (browser-based sign-in-ticket flow, same recipe as every prior live-verification task this session).

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/restaurant/reservations

echo "--- with FORGE's token ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" https://ota-u6ii.onrender.com/api/restaurant/reservations -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
```
Expected: no-auth → `401`; with token → `200`. Check the Ably dashboard's channel log for `property:b7a4c969-5e82-4c26-a587-17d2ab74858e:reservations` to confirm live publishes reach Ably once a live reservation is created/updated through the normal app UI (this endpoint is read-only — creating a reservation to trigger a live publish check should go through the existing `/reservations` staff page or a `curl -X POST` with FORGE's own API key, not fabricated data).

- [ ] **Step 4: No further action**

This task is deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 1.
