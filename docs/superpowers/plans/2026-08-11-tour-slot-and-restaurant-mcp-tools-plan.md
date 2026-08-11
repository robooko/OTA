# Tour Slot & Restaurant MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `PUT /api/tours/slots/:id` (status-only) + its `update_tour_slot` MCP tool, and broaden restaurant table/service-period routes to `authenticateOrApiKey` with 5 matching MCP tools — bringing the tool count from 20 to 26. Per `docs/superpowers/specs/2026-08-11-tour-slot-and-restaurant-mcp-tools-design.md`.

**Architecture:** No schema changes — `tour_slot.status` already exists. New route/controller function for slot status updates, scoped by `req.property_id`, using `authenticateOrApiKey` (matching the precedent set by `create_room`/`update_room`). Restaurant table/service-period routes swap `authenticate` for `authenticateOrApiKey` (no controller changes — they already scope by `req.property_id`). 6 new entries appended to `mcp-server/tools.js`.

**Tech Stack:** Node/Express, `pg`, `@modelcontextprotocol/sdk`, `zod` — all already in place.

## Global Constraints

- **No automated test framework.** Manual `curl` for route checks, the SDK's `Client`/`StreamableHTTPClientTransport` (pointed at `POST /api/mcp`) for tool checks.
- **Confirm with the user before** `git push origin main` (triggers a live Render redeploy). No database migration in this plan.
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
  Get Robs's/FORGE's current `api_key` fresh via `SELECT api_key FROM property WHERE id = '...'` — both have been rotated multiple times in prior sessions.
- **Shell gotcha:** when capturing a live-DB query's output for reuse in a shell variable, extract just the matching line (`grep '^prop_' raw.txt > clean.txt`), not a blanket warning-filter.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`.
- **Scope:** exactly the 1 new route + 5 broadened routes + 6 tools in the design doc. No `create_tour`/`update_tour`/`bulk_create_slots` tools, no table/service-period delete, no `slot_date`/`slot_time` editing.

---

### Task 1: `PUT /api/tours/slots/:id` + `update_tour_slot` tool

**Files:**
- Modify: `src/routes/tours.js`
- Modify: `src/controllers/tours.js`
- Modify: `mcp-server/tools.js`

**Interfaces:**
- Consumes: `authenticateOrApiKey` from `src/middleware/auth.js` (already exported).
- Produces: `updateSlot` exported from `src/controllers/tours.js`; `update_tour_slot` tool — nothing else in this plan depends on it.

- [ ] **Step 1: Add the route**

Replace:

```js
// Slots
router.post('/slots/bulk', authenticate, ctrl.bulkCreateSlots);
router.get('/slots/search', authenticate, ctrl.searchSlots);
```

with:

```js
// Slots
router.post('/slots/bulk', authenticate, ctrl.bulkCreateSlots);
router.get('/slots/search', authenticate, ctrl.searchSlots);
router.put('/slots/:id', authenticateOrApiKey, ctrl.updateSlot);
```

- [ ] **Step 2: Add the controller function**

Replace:

```js
module.exports = {
  listTours, createTour, updateTour,
  bulkCreateSlots, searchSlots,
  listBookings, createBooking, updateBooking,
};
```

with:

```js
async function updateSlot(req, res, next) {
  try {
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ error: 'status is required' });
    }
    const { rows } = await pool.query(
      'UPDATE tour_slot SET status = $1 WHERE id = $2 AND property_id = $3 RETURNING *',
      [status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Slot not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listTours, createTour, updateTour,
  bulkCreateSlots, searchSlots, updateSlot,
  listBookings, createBooking, updateBooking,
};
```

- [ ] **Step 3: Add the MCP tool**

Replace:

```js
    run: ({ restaurant_id, id, ...body }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/reservations/${id}`, { body }),
  },
  ];
}

module.exports = { createTools };
```

with:

```js
    run: ({ restaurant_id, id, ...body }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/reservations/${id}`, { body }),
  },
  {
    name: 'update_tour_slot',
    description: 'Update a tour slot\'s status (e.g. set to "inactive" to hide it from search without deleting it)',
    inputSchema: { id: z.string(), status: z.string() },
    run: ({ id, status }) => apiRequest('PUT', `/api/tours/slots/${id}`, { body: { status } }),
  },
  ];
}

module.exports = { createTools };
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Create a tour + slot to update**

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

curl -s -X POST http://localhost:3000/api/tours -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d '{"name":"Slot Update Test Tour","duration_mins":60,"max_group_size":4,"price":40}' > /tmp/tour.json
cat /tmp/tour.json
```
Save the `id` as `TOUR_ID`.

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
TOUR_ID="<id from previous step>"
curl -s -X POST http://localhost:3000/api/tours/slots/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"tour_id\":\"$TOUR_ID\",\"from\":\"2026-10-01\",\"to\":\"2026-10-01\",\"times\":[\"09:00\"]}"
```
Save the returned slot `id` as `SLOT_ID`.

- [ ] **Step 6: Verify the update via curl — success, cross-property 404, missing-status 400**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)
SLOT_ID="<id from Step 5>"

echo "--- update to inactive ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/tours/slots/$SLOT_ID -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"status":"inactive"}'

echo "--- missing status ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/tours/slots/$SLOT_ID -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{}'

echo "--- fake id (proxy for cross-property/nonexistent) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X PUT http://localhost:3000/api/tours/slots/00000000-0000-0000-0000-000000000000 -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"status":"inactive"}'
```
Expected: update → `200 {"status":"inactive",...}`; missing status → `400 {"error":"status is required"}`; fake id → `404 {"error":"Slot not found"}`.

- [ ] **Step 7: Verify the inactive slot disappears from search**

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
curl -s "http://localhost:3000/api/tours/slots/search?date=2026-10-01" -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `[]` — the slot from Step 5, now `inactive`, no longer matches `searchSlots`'s `WHERE ts.status = 'active'` filter.

- [ ] **Step 8: Verify `update_tour_slot` via MCP — needs a fresh active slot first**

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
TOUR_ID="<TOUR_ID from Step 5>"
curl -s -X POST http://localhost:3000/api/tours/slots/bulk -H "Content-Type: application/json" -H "Authorization: Bearer $CLERK_TOKEN" -d "{\"tour_id\":\"$TOUR_ID\",\"from\":\"2026-10-02\",\"to\":\"2026-10-02\",\"times\":[\"11:00\"]}"
```
Save the new slot `id` as `SLOT_ID_2`.

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
  const result = await client.callTool({ name: 'update_tour_slot', arguments: { id: '<SLOT_ID_2>', status: 'inactive' } });
  console.log(JSON.stringify(result));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
(Replace `<SLOT_ID_2>` with the actual id before running.) Expected: no `isError`, `content[0].text` parses to the slot with `status: "inactive"`.

- [ ] **Step 9: Commit**

```bash
rm -f /tmp/tok.txt /tmp/robs_key.txt /tmp/tour.json
git add src/routes/tours.js src/controllers/tours.js mcp-server/tools.js
git commit -m "Add PUT /api/tours/slots/:id and update_tour_slot MCP tool"
```

---

### Task 2: Restaurant table/service-period auth broadening + 5 MCP tools

**Files:**
- Modify: `src/routes/restaurant.js`
- Modify: `src/docs/swagger.js`
- Modify: `mcp-server/tools.js`

**Interfaces:**
- Consumes: `authenticateOrApiKey` (already exported, unchanged).
- Produces: 5 new tool names — `list_restaurant_tables`, `create_restaurant_table`, `update_restaurant_table`, `get_restaurant_service_periods`, `set_restaurant_service_periods`.

- [ ] **Step 1: Broaden the 5 routes**

Replace:

```js
// Tables
router.get('/:restaurant_id/tables', authenticate, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, ctrl.updateTable);

// Service Periods
router.get('/:restaurant_id/service-periods', authenticate, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticate, ctrl.setServicePeriods);
```

with:

```js
// Tables
router.get('/:restaurant_id/tables', authenticateOrApiKey, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticateOrApiKey, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticateOrApiKey, ctrl.updateTable);

// Service Periods
router.get('/:restaurant_id/service-periods', authenticateOrApiKey, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticateOrApiKey, ctrl.setServicePeriods);
```

- [ ] **Step 2: Document the new auth option in Swagger**

Replace:

```js
    '/api/restaurant/{restaurant_id}/tables': {
      get: { tags: ['Restaurant'], summary: 'List tables', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of tables' } } },
      post: { tags: ['Restaurant'], summary: 'Create table', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_number', 'seats'], properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{restaurant_id}/service-periods': {
      get: { tags: ['Restaurant'], summary: "List a restaurant's service periods (bookable windows)", parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of service periods' }, 404: { description: 'Restaurant not found' } } },
      put: { tags: ['Restaurant'], summary: "Replace all of a restaurant's service periods", parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['periods'], properties: { periods: { type: 'array', items: { type: 'object', required: ['start_time', 'end_time'], properties: { label: { type: 'string', nullable: true, example: 'Lunch' }, start_time: { type: 'string', example: '11:30' }, end_time: { type: 'string', example: '14:30' } } } } } } } } }, responses: { 200: { description: 'The new array of service periods' }, 400: { description: 'Invalid periods' }, 404: { description: 'Restaurant not found' } } },
    },
```

with:

```js
    '/api/restaurant/{restaurant_id}/tables': {
      get: { tags: ['Restaurant'], summary: 'List tables', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of tables' } } },
      post: { tags: ['Restaurant'], summary: 'Create table', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_number', 'seats'], properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{restaurant_id}/service-periods': {
      get: { tags: ['Restaurant'], summary: "List a restaurant's service periods (bookable windows)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of service periods' }, 404: { description: 'Restaurant not found' } } },
      put: { tags: ['Restaurant'], summary: "Replace all of a restaurant's service periods", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['periods'], properties: { periods: { type: 'array', items: { type: 'object', required: ['start_time', 'end_time'], properties: { label: { type: 'string', nullable: true, example: 'Lunch' }, start_time: { type: 'string', example: '11:30' }, end_time: { type: 'string', example: '14:30' } } } } } } } } }, responses: { 200: { description: 'The new array of service periods' }, 400: { description: 'Invalid periods' }, 404: { description: 'Restaurant not found' } } },
    },
```

- [ ] **Step 3: Add the 5 MCP tools**

Replace:

```js
    run: ({ id, status }) => apiRequest('PUT', `/api/tours/slots/${id}`, { body: { status } }),
  },
  ];
}

module.exports = { createTools };
```

with:

```js
    run: ({ id, status }) => apiRequest('PUT', `/api/tours/slots/${id}`, { body: { status } }),
  },
  {
    name: 'list_restaurant_tables',
    description: 'List tables for a restaurant',
    inputSchema: { restaurant_id: z.string() },
    run: ({ restaurant_id }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/tables`),
  },
  {
    name: 'create_restaurant_table',
    description: 'Create a table for a restaurant',
    inputSchema: { restaurant_id: z.string(), table_number: z.string(), seats: z.number().int(), location: z.string().optional() },
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/tables`, { body }),
  },
  {
    name: 'update_restaurant_table',
    description: 'Update a restaurant table',
    inputSchema: { restaurant_id: z.string(), id: z.string(), table_number: z.string().optional(), seats: z.number().int().optional(), location: z.string().optional(), status: z.enum(['active', 'inactive']).optional() },
    run: ({ restaurant_id, id, ...body }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/tables/${id}`, { body }),
  },
  {
    name: 'get_restaurant_service_periods',
    description: "List a restaurant's service periods (bookable windows)",
    inputSchema: { restaurant_id: z.string() },
    run: ({ restaurant_id }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/service-periods`),
  },
  {
    name: 'set_restaurant_service_periods',
    description: "Replace all of a restaurant's service periods",
    inputSchema: {
      restaurant_id: z.string(),
      periods: z.array(z.object({
        label: z.string().optional(),
        start_time: z.string(),
        end_time: z.string(),
      })),
    },
    run: ({ restaurant_id, periods }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/service-periods`, { body: { periods } }),
  },
  ];
}

module.exports = { createTools };
```

- [ ] **Step 4: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 5: Verify route broadening via curl**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
ROBS_KEY=$(cat /tmp/robs_key.txt)

echo "--- list BBYC's tables (Robs owns it, reassigned earlier this session) ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/65d3fbb7-7b05-49ea-b67b-02f9b83fd245/tables -H "X-Api-Key: $ROBS_KEY"

echo "--- create a table ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/restaurant/65d3fbb7-7b05-49ea-b67b-02f9b83fd245/tables -H "Content-Type: application/json" -H "X-Api-Key: $ROBS_KEY" -d '{"table_number":"T99","seats":4}'

echo "--- get service periods ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/restaurant/65d3fbb7-7b05-49ea-b67b-02f9b83fd245/service-periods -H "X-Api-Key: $ROBS_KEY"
```
Expected: all three `200`/`201`, no `401`s. Save the created table's `id` as `TABLE_ID`.

- [ ] **Step 6: Verify via MCP — 26 tools, table CRUD round-trip, service-periods round-trip**

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
  const expected = ['update_tour_slot','list_restaurant_tables','create_restaurant_table','update_restaurant_table','get_restaurant_service_periods','set_restaurant_service_periods'];
  console.log('HAS_NEW_TOOLS:', expected.every(n => tools.some(t => t.name === n)));

  const createResult = await client.callTool({
    name: 'create_restaurant_table',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245', table_number: 'MCP-T1', seats: 2 },
  });
  console.log('CREATE_TABLE:', JSON.stringify(createResult));
  const table = JSON.parse(createResult.content[0].text);

  const listResult = await client.callTool({ name: 'list_restaurant_tables', arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245' } });
  const tableList = JSON.parse(listResult.content[0].text);
  console.log('LIST_INCLUDES_IT:', tableList.some(t => t.id === table.id));

  const updateResult = await client.callTool({
    name: 'update_restaurant_table',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245', id: table.id, seats: 3 },
  });
  console.log('UPDATE_TABLE:', JSON.stringify(updateResult));

  const setResult = await client.callTool({
    name: 'set_restaurant_service_periods',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245', periods: [{ label: 'Lunch', start_time: '11:30', end_time: '14:30' }] },
  });
  console.log('SET_PERIODS:', JSON.stringify(setResult));

  const getResult = await client.callTool({ name: 'get_restaurant_service_periods', arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245' } });
  console.log('GET_PERIODS:', JSON.stringify(getResult));

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 26`; `HAS_NEW_TOOLS: true`; `CREATE_TABLE` no `isError`, `table_number: "MCP-T1"`; `LIST_INCLUDES_IT: true`; `UPDATE_TABLE` no `isError`, `seats: 3`; `SET_PERIODS` no `isError`, one period; `GET_PERIODS` matches `SET_PERIODS`'s result.

Note: `SET_PERIODS` replaces BBYC's existing periods (from the restaurant-service-periods work earlier this session) with just this one Lunch period — this is expected full-replace behavior per that feature's design, not a bug. If you want BBYC's original Lunch+Dinner periods restored afterward, re-run `set_restaurant_service_periods` with both.

- [ ] **Step 7: Restore BBYC's original service periods (cleanup, since Step 6 replaced them)**

```bash
ROBS_KEY=$(cat /tmp/robs_key.txt)
cd "c:\Users\robert\source\repos\OTA" && OTA_TEST_KEY="$ROBS_KEY" node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), {
    requestInit: { headers: { 'X-Api-Key': process.env.OTA_TEST_KEY } },
  });
  const client = new Client({ name: 'restore', version: '1.0.0' });
  await client.connect(transport);
  const result = await client.callTool({
    name: 'set_restaurant_service_periods',
    arguments: { restaurant_id: '65d3fbb7-7b05-49ea-b67b-02f9b83fd245', periods: [
      { label: 'Lunch', start_time: '11:30', end_time: '14:30' },
      { label: 'Dinner', start_time: '17:30', end_time: '21:30' },
    ] },
  });
  console.log(JSON.stringify(result));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: no `isError`, 2 periods returned.

- [ ] **Step 8: Commit**

```bash
rm -f /tmp/robs_key.txt
git add src/routes/restaurant.js src/docs/swagger.js mcp-server/tools.js
git commit -m "Broaden restaurant table/service-period routes, add 5 matching MCP tools"
```

---

### Task 3: Push and verify live

**Files:** none (deploy + verification only).

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
    console.log(j.paths['/api/restaurant/{restaurant_id}/tables'].get.security ? 'READY' : 'NOT_READY');
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
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL_LIVE, ssl: { rejectUnauthorized: false } });
pool.query(\"SELECT api_key FROM property WHERE id = 'b7a4c969-5e82-4c26-a587-17d2ab74858e'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/forge_key_raw.txt
grep '^prop_' /tmp/forge_key_raw.txt > /tmp/forge_key.txt
cat /tmp/forge_key.txt
```

- [ ] **Step 5: Verify live — 26 tools, table create/list, service-periods round-trip on Bonito**

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

  const getPeriodsResult = await client.callTool({ name: 'get_restaurant_service_periods', arguments: { restaurant_id: '641efadd-3dba-492d-b78a-0ebd7083a575' } });
  console.log('GET_PERIODS (Bonito):', JSON.stringify(getPeriodsResult).slice(0, 300));

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 26`; `GET_PERIODS` has no `isError` (read-only check on live — deliberately not calling `set_restaurant_service_periods` against production data to avoid disrupting a real restaurant's hours).

- [ ] **Step 6: No further action**

```bash
rm -f /tmp/forge_key.txt /tmp/forge_key_raw.txt
```
This task is deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 2.
