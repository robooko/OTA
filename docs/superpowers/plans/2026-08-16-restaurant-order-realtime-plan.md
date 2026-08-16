# Restaurant Order Realtime Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `new-order`/`order-status-changed` Ably events from `createOrder`/`updateOrderStatus`, and add a staff-only token-minting endpoint for the mobile ordering app to subscribe — per `docs/superpowers/specs/2026-08-16-restaurant-order-realtime-design.md`.

**Architecture:** `src/lib/ably.js` gains `publishNewOrder`/`publishOrderStatusChanged` (same best-effort, non-fatal shape as the existing `publishNewInquiry`) plus exports its module-level Ably `Rest` client directly, so `restaurantOrders.js` can mint tokens without a second Ably client instance. Both new publishes target a per-*restaurant* channel (`restaurant:{restaurant_id}:orders`), narrower than `event_inquiry`'s per-property scoping, since a kitchen/waitress screen only ever cares about one restaurant. `createOrder`/`updateOrderStatus` call the new publish functions right after their existing success path — no change to validation, response shape, or auth. A new `GET /api/restaurant-orders/ably-token?restaurant_id=X` (`authenticate`-only) mints a subscribe-only token scoped to that one restaurant's channel, after confirming the restaurant belongs to the caller's property.

**Tech Stack:** Node/Express, `pg`, PostgreSQL, `ably` (already a dependency from the event-inquiries work).

**Spec:** `docs/superpowers/specs/2026-08-16-restaurant-order-realtime-design.md`

## Global Constraints

- **No automated test framework.** Manual `curl` checks against a running `npm start` server, plus Ably channel history checks (same technique already used to verify `event_inquiry`'s publish), matching every prior plan.
- **Confirm with the user before**: pushing to `origin/main` (triggers a live Render redeploy). No new live schema change in this plan — no new tables/columns, so no separate "confirm before migration" step is needed.
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
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3` should print `200`. No auto-restart — kill and restart `npm start` (as a background task) after any controller/route edit.
- **Fixture data needed for order-creation checks**: an active `restaurant`, an active `restaurant_table` (or a `booking`), and an active `restaurant_menu_item`, all under Robs's property. Check whether any already exist (`SELECT * FROM restaurant WHERE property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be' AND status = 'active'` etc.) before creating new ones via direct SQL — this session has created restaurant/menu fixtures before; reuse them if present rather than assuming a clean slate.
- **Scope:** exactly `src/lib/ably.js`, `createOrder`/`updateOrderStatus`/new `getAblyToken` in `src/controllers/restaurantOrders.js`, the new route, and swagger. No change to `event_inquiry`'s own Ably wiring, no payment-tracking work (separate, spec-only, not this plan).

---

### Task 1: Ably publish wiring in `createOrder`/`updateOrderStatus`

**Files:**
- Modify: `src/lib/ably.js`
- Modify: `src/controllers/restaurantOrders.js`

**Interfaces:**
- Produces: `publishNewOrder(restaurantId, order)`, `publishOrderStatusChanged(restaurantId, payload)`, and a `client` export from `src/lib/ably.js` — Task 2's `getAblyToken` consumes `client` directly.

- [ ] **Step 1: Add the two publish functions and export `client`**

Replace the full contents of `src/lib/ably.js`:

```js
const Ably = require('ably');

// The Ably constructor throws synchronously on a malformed key (not just a
// wrong/revoked one) -- guarded so a bad ABLY_API_KEY disables realtime
// notifications instead of crashing the whole server at boot.
let client = null;
if (process.env.ABLY_API_KEY) {
  try {
    client = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  } catch (err) {
    console.error('Ably client init failed, notifications disabled:', err.message);
  }
}

async function publishNewInquiry(propertyId, inquiry) {
  if (!client) return; // no key configured -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-inquiry', inquiry);
}

module.exports = { publishNewInquiry };
```

with:

```js
const Ably = require('ably');

// The Ably constructor throws synchronously on a malformed key (not just a
// wrong/revoked one) -- guarded so a bad ABLY_API_KEY disables realtime
// notifications instead of crashing the whole server at boot.
let client = null;
if (process.env.ABLY_API_KEY) {
  try {
    client = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  } catch (err) {
    console.error('Ably client init failed, notifications disabled:', err.message);
  }
}

async function publishNewInquiry(propertyId, inquiry) {
  if (!client) return; // no key configured -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-inquiry', inquiry);
}

async function publishNewOrder(restaurantId, order) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('new-order', order);
}

async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}

module.exports = { publishNewInquiry, publishNewOrder, publishOrderStatusChanged, client };
```

- [ ] **Step 2: Wire the publishes into `createOrder`/`updateOrderStatus`**

Add the import near the top of `src/controllers/restaurantOrders.js`. Replace:

```js
const pool = require('../db');
```

with:

```js
const pool = require('../db');
const { publishNewOrder, publishOrderStatusChanged, client: ablyClient } = require('../lib/ably');
```

In `createOrder`, replace:

```js
      await client.query('COMMIT');
      res.status(201).json({ ...order[0], items: resolvedItems });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
```

with:

```js
      await client.query('COMMIT');
      publishNewOrder(restaurant_id, { ...order[0], items: resolvedItems }).catch((err) => console.error('Ably publish failed:', err.message));
      res.status(201).json({ ...order[0], items: resolvedItems });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
```

In `updateOrderStatus`, replace:

```js
    const { rows } = await pool.query(
      `UPDATE restaurant_order SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
```

with:

```js
    const { rows } = await pool.query(
      `UPDATE restaurant_order SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *`,
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    publishOrderStatusChanged(rows[0].restaurant_id, { id: rows[0].id, status: rows[0].status, restaurant_id: rows[0].restaurant_id }).catch((err) => console.error('Ably publish failed:', err.message));
    res.json(rows[0]);
```

- [ ] **Step 3: Restart the local server, confirm it's up**

Find and kill whatever `node src/server.js` process is currently listening on port 3000, then start it fresh with `npm start` (as a background task), then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 4: Locate or create fixture data**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const restaurants = await pool.query(\"SELECT id, name FROM restaurant WHERE property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be' AND status = 'active' LIMIT 1\");
  console.log('restaurant:', JSON.stringify(restaurants.rows));
  if (restaurants.rows.length) {
    const rid = restaurants.rows[0].id;
    const tables = await pool.query('SELECT id FROM restaurant_table WHERE restaurant_id = $1 AND status = \\'active\\' LIMIT 1', [rid]);
    console.log('table:', JSON.stringify(tables.rows));
    const items = await pool.query('SELECT id, name, price FROM restaurant_menu_item WHERE restaurant_id = $1 AND status = \\'active\\' LIMIT 1', [rid]);
    console.log('menu item:', JSON.stringify(items.rows));
  }
  await pool.end();
})();
"
```
If any of restaurant/table/menu-item is missing, create it directly via SQL (mirroring the shape used earlier this session for equipment/golf fixtures) before continuing — a restaurant needs `name`/`slot_interval_minutes`/`default_duration_minutes`; a table needs `restaurant_id`/`table_number`/`property_id`; a menu item needs `name`/`price`/`property_id`/`restaurant_id`. Save the resolved ids as `RESTAURANT_ID`, `TABLE_ID`, `MENU_ITEM_ID`.

- [ ] **Step 5: Verify `createOrder` still works and publishes**

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
RESTAURANT_ID="<from Step 4>"
TABLE_ID="<from Step 4>"
MENU_ITEM_ID="<from Step 4>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant-orders -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"restaurant_id\":\"$RESTAURANT_ID\",\"table_id\":\"$TABLE_ID\",\"items\":[{\"item_id\":\"$MENU_ITEM_ID\",\"quantity\":2}]}"
```
Expected: `201` as before (no regression) — save the returned `id` as `ORDER_ID`.

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
require('dotenv').config();
const Ably = require('ably');
const client = new Ably.Rest({ key: process.env.ABLY_API_KEY });
const channel = client.channels.get('restaurant:<RESTAURANT_ID>:orders');
(async () => {
  const page = await channel.history({ limit: 5, direction: 'backwards' });
  console.log(JSON.stringify(page.items.map(m => ({ name: m.name, data: m.data })), null, 2));
})();
"
```
(substitute `<RESTAURANT_ID>` with the real value). Expected: a `new-order` event whose `data.id` matches `ORDER_ID` and whose `data.items` matches what was ordered.

- [ ] **Step 6: Verify `updateOrderStatus` still works and publishes**

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
ORDER_ID="<from Step 5>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/restaurant-orders/$ORDER_ID/status -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"status":"confirmed"}'
```
Expected: `200`, `status: "confirmed"` as before.

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
require('dotenv').config();
const Ably = require('ably');
const client = new Ably.Rest({ key: process.env.ABLY_API_KEY });
const channel = client.channels.get('restaurant:<RESTAURANT_ID>:orders');
(async () => {
  const page = await channel.history({ limit: 5, direction: 'backwards' });
  console.log(JSON.stringify(page.items.map(m => ({ name: m.name, data: m.data })), null, 2));
})();
"
```
Expected: an `order-status-changed` event with `data.id` matching `ORDER_ID` and `data.status: "confirmed"`, alongside the earlier `new-order` event in the same channel's history.

- [ ] **Step 7: Verify best-effort framing — publish failure doesn't fail the request**

Temporarily edit `.env` to set `ABLY_API_KEY=invalid-key-value`, restart the server, then:
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
RESTAURANT_ID="<from Step 4>"
TABLE_ID="<from Step 4>"
MENU_ITEM_ID="<from Step 4>"

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant-orders -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"restaurant_id\":\"$RESTAURANT_ID\",\"table_id\":\"$TABLE_ID\",\"items\":[{\"item_id\":\"$MENU_ITEM_ID\",\"quantity\":1}]}"
```
Expected: still `201`. Check the server's console output for a logged `Ably publish failed: ...` line. Restore the real `ABLY_API_KEY` value in `.env` and restart the server before continuing.

- [ ] **Step 8: Commit**

```bash
rm -f /tmp/tok.txt
git add src/lib/ably.js src/controllers/restaurantOrders.js
git commit -m "Publish Ably events from restaurant order create/status-change"
```

---

### Task 2: `GET /api/restaurant-orders/ably-token`

**Files:**
- Modify: `src/controllers/restaurantOrders.js`
- Modify: `src/routes/restaurantOrders.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `ablyClient` (the raw Ably `Rest` client, imported in Task 1's Step 2) for `.auth.createTokenRequest`.
- Produces: `GET /api/restaurant-orders/ably-token?restaurant_id=X` → `{ tokenRequest, channel }` — the mobile app's own Ably client consumes this directly (outside this repo, no further dependents here).

- [ ] **Step 1: Add `getAblyToken`**

Add to `src/controllers/restaurantOrders.js`, right after `updateOrderStatus` and before the `module.exports` line. Replace:

```js
module.exports = { listMenuItems, createMenuItem, updateMenuItem, listOrders, getOrder, createOrder, updateOrderStatus };
```

with:

```js
async function getAblyToken(req, res, next) {
  try {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });

    const { rows } = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const channel = `restaurant:${restaurant_id}:orders`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}

module.exports = { listMenuItems, createMenuItem, updateMenuItem, listOrders, getOrder, createOrder, updateOrderStatus, getAblyToken };
```

- [ ] **Step 2: Add the route**

Route-matching order matters in Express — `/ably-token` must be
registered before any `/:id`-shaped route or it would be swallowed as
an `id` value. Replace the full contents of `src/routes/restaurantOrders.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/restaurantOrders');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Menu items
router.get('/menu', authenticateOrApiKey, ctrl.listMenuItems);
router.post('/menu', authenticateOrApiKey, ctrl.createMenuItem);
router.put('/menu/:id', authenticateOrApiKey, ctrl.updateMenuItem);

// Orders
router.get('/', authenticate, ctrl.listOrders);
router.get('/:id', authenticate, ctrl.getOrder);
router.post('/', authenticateOrApiKey, ctrl.createOrder);
router.put('/:id/status', authenticate, ctrl.updateOrderStatus);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/restaurantOrders');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Menu items
router.get('/menu', authenticateOrApiKey, ctrl.listMenuItems);
router.post('/menu', authenticateOrApiKey, ctrl.createMenuItem);
router.put('/menu/:id', authenticateOrApiKey, ctrl.updateMenuItem);

// Orders
router.get('/ably-token', authenticate, ctrl.getAblyToken);
router.get('/', authenticate, ctrl.listOrders);
router.get('/:id', authenticate, ctrl.getOrder);
router.post('/', authenticateOrApiKey, ctrl.createOrder);
router.put('/:id/status', authenticate, ctrl.updateOrderStatus);

module.exports = router;
```

- [ ] **Step 3: Update Swagger**

Replace:

```js
    '/api/restaurant-orders/{id}/status': {
      put: { tags: ['Restaurant Orders'], summary: 'Update order status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'] } } } } } }, responses: { 200: { description: 'Updated order' }, 404: { description: 'Not found' } } },
    },
```

with:

```js
    '/api/restaurant-orders/{id}/status': {
      put: { tags: ['Restaurant Orders'], summary: 'Update order status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'] } } } } } }, responses: { 200: { description: 'Updated order' }, 404: { description: 'Not found' } } },
    },
    '/api/restaurant-orders/ably-token': {
      get: { tags: ['Restaurant Orders'], summary: 'Mint a realtime subscribe token for one restaurant\'s order events', parameters: [{ name: 'restaurant_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Ably token request + channel name' }, 400: { description: 'restaurant_id missing' }, 404: { description: 'Restaurant not found' } } },
    },
```

- [ ] **Step 4: Restart the local server, confirm it's up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify `GET /api/restaurant-orders/ably-token`**

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
RESTAURANT_ID="<from Task 1 Step 4>"

echo "--- no auth ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant-orders/ably-token?restaurant_id=$RESTAURANT_ID"

echo "--- missing restaurant_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant-orders/ably-token -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- foreign restaurant_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant-orders/ably-token?restaurant_id=00000000-0000-0000-0000-000000000000" -H "Authorization: Bearer $CLERK_TOKEN"

echo "--- valid ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant-orders/ably-token?restaurant_id=$RESTAURANT_ID" -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: no auth → `401`. Missing `restaurant_id` → `400`. Foreign/nonexistent restaurant → `404`. Valid → `200`, `channel` equals `restaurant:$RESTAURANT_ID:orders`, `tokenRequest` has `keyName`/`mac` (a real signed request).

- [ ] **Step 6: Confirm `/ably-token` isn't swallowed by `/:id`**

This is what Step 2's route-ordering comment guards against — verify it directly rather than trusting the ordering was applied correctly:

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant-orders/ably-token?restaurant_id=$RESTAURANT_ID" -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `200` with a real `tokenRequest`/`channel` body — **not** a `404 {"error":"Order not found"}`, which is what `getOrder` would return if `/ably-token` were being matched as `GET /:id` with `id = "ably-token"` (i.e. registered in the wrong order). If this returns that specific 404 shape, the route order in Step 2 needs fixing before proceeding.

- [ ] **Step 7: Commit**

```bash
rm -f /tmp/tok.txt
git add src/controllers/restaurantOrders.js src/routes/restaurantOrders.js src/docs/swagger.js
git commit -m "Add GET /api/restaurant-orders/ably-token"
```

---

### Task 3: Push and verify live

**Files:** none (deploy and verification only — no schema change in this plan).

**Interfaces:**
- Consumes: Tasks 1-2's commits.

- [ ] **Step 1: Confirm with the user before pushing**

Per Global Constraints — triggers a live Render redeploy.

- [ ] **Step 2: Push**

```bash
git push origin main
```

- [ ] **Step 3: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log(j.paths['/api/restaurant-orders/ably-token'] ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 4: Verify live — token endpoint and a real order publish**

This needs a live Clerk admin token for FORGE, which requires the browser-based sign-in-ticket flow (the dev-only `sessions.createSession` shortcut doesn't work on live). Use whichever browser automation MCP tool is connected at execution time, following the same recipe used in every prior live-verification task this session (mint a sign-in ticket via `client.signInTokens.createSignInToken({ userId: 'user_3CLBg0yYT3odh00x09a2KnPiGr3', expiresInSeconds: 3600 })` using the live secret key from `dotenv.parse(fs.readFileSync('.env'))['old-CLERK_SECRET_KEY']`, navigate with `redirect_url=https://accounts.hotal.forge-build.co.uk/user`, evaluate `window.Clerk.session.getToken({ skipCache: true })`).

If no browser tool is connected when this step is reached, stop and ask the user how to proceed (wait for reconnection, have them supply a token, or skip this specific step) rather than skipping silently.

FORGE needs its own restaurant/table/menu-item fixtures if none exist yet — check first, matching Task 1 Step 4's approach, before assuming a clean slate.

```bash
LIVE_CLERK_TOKEN="<token from the browser flow>"
FORGE_RESTAURANT_ID="<resolved or created, matching Task 1 Step 4's approach for FORGE's property>"

echo "--- token endpoint ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "https://ota-u6ii.onrender.com/api/restaurant-orders/ably-token?restaurant_id=$FORGE_RESTAURANT_ID" -H "Authorization: Bearer $LIVE_CLERK_TOKEN"
```
Expected: `200`, real `tokenRequest`/`channel`.

If FORGE fixtures already support it, also verify a live order-create publish (optional if fixture setup is heavy — the token endpoint check above already exercises the new live code path; a full order-create round trip mainly re-confirms Task 1's already-proven-safe publish wiring on the live environment):
```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/restaurant-orders -H "Content-Type: application/json" -H "Authorization: Bearer $LIVE_CLERK_TOKEN" -d "{\"restaurant_id\":\"$FORGE_RESTAURANT_ID\",\"table_id\":\"<live table id>\",\"items\":[{\"item_id\":\"<live menu item id>\",\"quantity\":1}]}"
```
Expected: `201` as before.

- [ ] **Step 5: No further action**

This task is deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 2.
