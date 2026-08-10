# MCP Restaurant Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden `authenticateOrApiKey` to 5 restaurant browsing/reservation routes and add 5 matching MCP tools (`list_restaurants`, `get_restaurant`, `list_restaurant_reservations`, `get_restaurant_reservation`, `update_restaurant_reservation`), bringing the MCP tool count to 20 — per `docs/superpowers/specs/2026-08-10-mcp-restaurant-tools-design.md`.

**Architecture:** Same pattern as every prior auth-broadening pass this session — swap middleware on existing routes (no controller changes, `src/controllers/restaurant.js` already scopes every query by `req.property_id`), then append tool definitions to the `createTools` factory in `mcp-server/tools.js`.

**Tech Stack:** Node/Express, `@modelcontextprotocol/sdk`, `zod` — all already in place, no new dependencies.

## Global Constraints

- **No automated test framework.** Manual `curl` for the route broadening, the SDK's `Client`/`StreamableHTTPClientTransport` (pointed at `POST /api/mcp`) for the tools.
- **Confirm with the user before** `git push origin main` (triggers a live Render redeploy). No database migration in this plan.
- Today's date: **2026-08-10**.
- **Test identities:** local — Robs (`a3e548af-a71d-46c0-ba61-f1f702e495be`), get its current `api_key` fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'`. Live — FORGE (`b7a4c969-5e82-4c26-a587-17d2ab74858e`), same rule against `DATABASE_URL_LIVE`. The restaurant `65d3fbb7-7b05-49ea-b67b-02f9b83fd245` ("BBYC") was reassigned to Robs's property earlier this session — use it as the known-good local restaurant for these tests. `641efadd-3dba-492d-b78a-0ebd7083a575` ("Bonito") is a known-good FORGE restaurant on live.
- **Shell gotcha:** when capturing a DB query's output to a file for reuse in a shell variable, extract just the matching line (`grep '^prop_' raw.txt > clean.txt`), not a blanket warning-filter — leftover blank lines from filtering get embedded into `$(cat file)` command substitution and corrupt header values built from it.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`.
- **Scope:** exactly the 5 routes and 5 tools in the design doc. No `create_restaurant`/`update_restaurant`/table/service-period tools, no cancel-specific tool (covered by `update_restaurant_reservation`).

---

### Task 1: Broaden routes, add tools, document in Swagger, verify locally

**Files:**
- Modify: `src/routes/restaurant.js`
- Modify: `mcp-server/tools.js`
- Modify: `src/docs/swagger.js`

**Interfaces:**
- Consumes: `authenticateOrApiKey` from `src/middleware/auth.js` (already exported, unchanged), `apiRequest` parameter already threaded through `createTools` (Task unaffected by the HTTP-transport refactor — `tools.js`'s per-tool `run` signature is unchanged).
- Produces: 5 new tool names (`list_restaurants`, `get_restaurant`, `list_restaurant_reservations`, `get_restaurant_reservation`, `update_restaurant_reservation`) — nothing else in this plan depends on them.

- [ ] **Step 1: Broaden the 5 routes**

Replace the full contents of `src/routes/restaurant.js`:

```js
const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Restaurants
router.get('/', authenticate, ctrl.listRestaurants);
router.get('/:id', authenticate, ctrl.getRestaurant);
router.post('/', authenticate, ctrl.createRestaurant);
router.put('/:id', authenticate, ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', authenticate, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, ctrl.updateTable);

// Service Periods
router.get('/:restaurant_id/service-periods', authenticate, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticate, ctrl.setServicePeriods);

// Availability
router.get('/:restaurant_id/availability/search', ctrl.searchAvailability);

// Reservations
router.get('/:restaurant_id/reservations', authenticate, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', authenticate, ctrl.getReservation);
router.post('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticate, ctrl.updateReservation);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Restaurants
router.get('/', authenticateOrApiKey, ctrl.listRestaurants);
router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant);
router.post('/', authenticate, ctrl.createRestaurant);
router.put('/:id', authenticate, ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', authenticate, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, ctrl.updateTable);

// Service Periods
router.get('/:restaurant_id/service-periods', authenticate, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticate, ctrl.setServicePeriods);

// Availability
router.get('/:restaurant_id/availability/search', ctrl.searchAvailability);

// Reservations
router.get('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.getReservation);
router.post('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.updateReservation);

module.exports = router;
```

- [ ] **Step 2: Add the 5 tools to `mcp-server/tools.js`**

Replace:

```js
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/reservations`, { body }),
  },
  ];
}

module.exports = { createTools };
```

with:

```js
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/reservations`, { body }),
  },
  {
    name: 'list_restaurants',
    description: 'List all restaurants',
    inputSchema: {},
    run: () => apiRequest('GET', '/api/restaurant'),
  },
  {
    name: 'get_restaurant',
    description: 'Get a restaurant by id',
    inputSchema: { id: z.string() },
    run: ({ id }) => apiRequest('GET', `/api/restaurant/${id}`),
  },
  {
    name: 'list_restaurant_reservations',
    description: 'List reservations for a restaurant, optionally filtered by date, status, or guest',
    inputSchema: {
      restaurant_id: z.string(),
      date: z.string().optional(),
      status: z.string().optional(),
      guest_id: z.string().optional(),
      clerk_user_id: z.string().optional(),
    },
    run: ({ restaurant_id, ...query }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/reservations`, { query }),
  },
  {
    name: 'get_restaurant_reservation',
    description: 'Get a restaurant reservation by id',
    inputSchema: { restaurant_id: z.string(), id: z.string() },
    run: ({ restaurant_id, id }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/reservations/${id}`),
  },
  {
    name: 'update_restaurant_reservation',
    description: 'Update a restaurant reservation (e.g. set status to "cancelled" to cancel it)',
    inputSchema: {
      restaurant_id: z.string(),
      id: z.string(),
      status: z.string().optional(),
      notes: z.string().optional(),
      contact_name: z.string().optional(),
      contact_email: z.string().optional(),
      contact_phone: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    },
    run: ({ restaurant_id, id, ...body }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/reservations/${id}`, { body }),
  },
  ];
}

module.exports = { createTools };
```

- [ ] **Step 3: Document the new auth option in Swagger**

Replace:

```js
    '/api/restaurant': {
      get: { tags: ['Restaurant'], summary: 'List all restaurants', responses: { 200: { description: 'Array of restaurants' } } },
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [7] } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get restaurant by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Restaurant' } } },
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [1, 7] }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```

with:

```js
    '/api/restaurant': {
      get: { tags: ['Restaurant'], summary: 'List all restaurants', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: 'Array of restaurants' } } },
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [7] } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get restaurant by ID', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Restaurant' } } },
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [1, 7] }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
```

Replace:

```js
    '/api/restaurant/{restaurant_id}/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reservations' } } },
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get reservation by ID', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Reservation' } } },
      put: { tags: ['Restaurant'], summary: 'Update reservation', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } } } } } } }, responses: { 200: { description: 'Updated' } } },
```

with:

```js
    '/api/restaurant/{restaurant_id}/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reservations' } } },
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get reservation by ID', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Reservation' } } },
      put: { tags: ['Restaurant'], summary: 'Update reservation', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } } } } } } }, responses: { 200: { description: 'Updated' } } },
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Get Robs's current key, verify route broadening via curl**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)

echo "--- list restaurants ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant -H "X-Api-Key: $ROBS_KEY"

echo "--- get BBYC restaurant (belongs to Robs, reassigned earlier this session) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/65d3fbb7-7b05-49ea-b67b-02f9b83fd245 -H "X-Api-Key: $ROBS_KEY"

echo "--- list reservations for it ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/65d3fbb7-7b05-49ea-b67b-02f9b83fd245/reservations -H "X-Api-Key: $ROBS_KEY"
```
Expected: all three `200`, no `401`s. The `list restaurants` array should include the `BBYC` restaurant.

- [ ] **Step 6: Verify via MCP — 20 tools, `list_restaurants`, `get_restaurant`**

```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)
cd "c:\Users\robert\source\repos\OTA" && OTA_TEST_KEY="$ROBS_KEY" node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), {
    requestInit: { headers: { 'X-Api-Key': process.env.OTA_TEST_KEY } },
  });
  const client = new Client({ name: 'verify', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log('TOOL_COUNT:', tools.length);
  console.log('HAS_NEW_TOOLS:', ['list_restaurants','get_restaurant','list_restaurant_reservations','get_restaurant_reservation','update_restaurant_reservation'].every(n => tools.some(t => t.name === n)));

  const listResult = await client.callTool({ name: 'list_restaurants', arguments: {} });
  console.log('LIST_RESTAURANTS:', JSON.stringify(listResult).slice(0, 300));

  const getResult = await client.callTool({ name: 'get_restaurant', arguments: { id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245' } });
  console.log('GET_RESTAURANT:', JSON.stringify(getResult));

  const crossPropertyResult = await client.callTool({ name: 'get_restaurant', arguments: { id: '641efadd-3dba-492d-b78a-0ebd7083a575' } });
  console.log('CROSS_PROPERTY_GET:', JSON.stringify(crossPropertyResult));

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 20`; `HAS_NEW_TOOLS: true`; `LIST_RESTAURANTS` has no `isError`, includes BBYC; `GET_RESTAURANT` has no `isError`, `name: "BBYC"`; `CROSS_PROPERTY_GET` (a live-only id, won't exist locally) → `isError: true`, `"Restaurant not found"`.

- [ ] **Step 7: Verify the reservation lifecycle via MCP — create, get, list, update (cancel)**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)
cd "c:\Users\robert\source\repos\OTA" && OTA_TEST_KEY="$ROBS_KEY" node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), {
    requestInit: { headers: { 'X-Api-Key': process.env.OTA_TEST_KEY } },
  });
  const client = new Client({ name: 'verify2', version: '1.0.0' });
  await client.connect(transport);

  const createResult = await client.callTool({
    name: 'create_restaurant_reservation',
    arguments: {
      restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245',
      reservation_date: '2026-09-15',
      start_time: '19:00',
      contact_name: 'MCP Reservation Test',
      party_size: 2,
    },
  });
  console.log('CREATE:', JSON.stringify(createResult));
  const reservation = JSON.parse(createResult.content[0].text);

  const getResult = await client.callTool({
    name: 'get_restaurant_reservation',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245', id: reservation.id },
  });
  console.log('GET:', JSON.stringify(getResult));

  const listResult = await client.callTool({
    name: 'list_restaurant_reservations',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245' },
  });
  const list = JSON.parse(listResult.content[0].text);
  console.log('LIST_INCLUDES_IT:', list.some(r => r.id === reservation.id));

  const updateResult = await client.callTool({
    name: 'update_restaurant_reservation',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245', id: reservation.id, status: 'cancelled' },
  });
  console.log('UPDATE:', JSON.stringify(updateResult));

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `CREATE` has no `isError`, note the create result's likely `409` possibility — this restaurant (BBYC, reassigned from the BBYC property) may or may not have tables/service-periods set up under its new property assignment; if `CREATE` returns `isError: true` with `"No tables available"` or `"start_time is outside service hours"`, that's a data setup issue unrelated to this plan's own logic (the reassignment earlier this session moved the restaurant row but not necessarily surfaced any table/service-period gaps) — if that happens, note it and skip to verifying `list_restaurant_reservations`/`get_restaurant_reservation` return `isError: true`/`404`-equivalent for a fabricated reservation id instead, since the tools themselves (not the data) are what this plan verifies. If `CREATE` succeeds: `GET` returns the same reservation; `LIST_INCLUDES_IT: true`; `UPDATE` succeeds with `status: "cancelled"` in the response.

- [ ] **Step 8: Commit**

```bash
rm -f /tmp/robs_key.txt
git add src/routes/restaurant.js mcp-server/tools.js src/docs/swagger.js
git commit -m "Add restaurant list/get/reservation MCP tools, broaden authenticateOrApiKey to match"
```

---

### Task 2: Push and verify live

**Files:** none (deploy + verification only).

**Interfaces:**
- Consumes: Task 1's commit.

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
    console.log(j.paths['/api/restaurant'].get.security ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually `READY`.

- [ ] **Step 4: Get FORGE's current key cleanly**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
pool.query(\"SELECT api_key FROM property WHERE id = 'b7a4c969-5e82-4c26-a587-17d2ab74858e'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/forge_key_raw.txt
grep '^prop_' /tmp/forge_key_raw.txt > /tmp/forge_key.txt
cat /tmp/forge_key.txt
```

- [ ] **Step 5: Verify live — 20 tools, `get_restaurant` on the known Bonito id**

```bash
FORGE_KEY=$(cat /tmp/forge_key.txt)
cd "c:\Users\robert\source\repos\OTA" && OTA_TEST_KEY="$FORGE_KEY" node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const transport = new StreamableHTTPClientTransport(new URL('https://ota-u6ii.onrender.com/api/mcp'), {
    requestInit: { headers: { 'X-Api-Key': process.env.OTA_TEST_KEY } },
  });
  const client = new Client({ name: 'live-verify', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log('TOOL_COUNT:', tools.length);

  const getResult = await client.callTool({ name: 'get_restaurant', arguments: { id: '641efadd-3dba-492d-b78a-0ebd7083a575' } });
  console.log('GET_RESTAURANT:', JSON.stringify(getResult));

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 20`; `GET_RESTAURANT` has no `isError`, `name: "Bonito"`, `property_id: "b7a4c969-5e82-4c26-a587-17d2ab74858e"`.

- [ ] **Step 6: No further action**

```bash
rm -f /tmp/forge_key.txt /tmp/forge_key_raw.txt
```
This task is deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 2.
