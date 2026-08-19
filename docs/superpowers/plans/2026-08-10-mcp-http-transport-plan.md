# MCP Server HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MCP server's `stdio` transport with an HTTP endpoint (`POST /api/mcp`, mounted on this Express app) — per `docs/superpowers/specs/2026-08-10-mcp-http-transport-design.md`. Part A of the original MCP spec (`authenticateOrApiKey` broadening, `api_key_enabled` kill switch) is already shipped and unchanged.

**Architecture:** `mcp-server/apiClient.js` and `mcp-server/tools.js` become factories (`createApiClient`, `createTools`) instead of module-level singletons reading a fixed env var. A new `src/routes/mcp.js`, gated by the existing `authenticateOrApiKey`, builds a fresh `McpServer` + stateless `StreamableHTTPServerTransport` per request, with tools that loop back to this same running server over HTTP using the caller's own forwarded auth header. The `stdio` entry point (`mcp-server/index.js`) and its test client (`mcp-server/verify.js`) are deleted.

**Tech Stack:** Node/Express, `@modelcontextprotocol/sdk` (already installed, confirmed via a throwaway smoke test that `StreamableHTTPServerTransport`/`StreamableHTTPClientTransport` work exactly as documented), `zod`.

## Global Constraints

- **No automated test framework.** Every "verify" step is a manual `node -e` script using the SDK's `Client` + `StreamableHTTPClientTransport`, or plain `curl`.
- **Confirm with the user before** `git push origin main` (triggers a live Render redeploy). No database migration in this plan — Part A's schema is already live.
- Today's date: **2026-08-10**.
- **Test identities:**
  - Local/dev: property **"Robs"** (`a3e548af-a71d-46c0-ba61-f1f702e495be`) — get its current key fresh via `SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'` (it's been rotated multiple times in prior sessions; any previously-recorded value is stale).
  - Live: property **"FORGE"** (`b7a4c969-5e82-4c26-a587-17d2ab74858e`) — same rule, get its key fresh from `DATABASE_URL_LIVE`.
- **Shell gotcha (hit and fixed in the prior plan's execution):** when piping a `node -e` DB-query script's stdout to a file for later reuse (e.g. `> /tmp/key.txt`), filtering out Node's `pg` SSL deprecation warning with `grep -v` can leave leading blank lines in the file, which then get embedded into a shell variable via `$(cat ...)` command substitution (which only strips *trailing* newlines, not leading ones) — corrupting header values built from that variable. When capturing a key this way, extract just the matching line: `grep '^prop_' raw_output.txt > clean.txt`, not a blanket `grep -v` of warning text.
- Before any local verification block, confirm the dev server is responding: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json` should print `200`. `nodemon` does not auto-restart a crashed process.
- **Scope:** exactly what the design doc covers — the transport swap. Do not change the 15 tools' names, descriptions, or input schemas; do not touch Part A (`authenticateOrApiKey`, `api_key_enabled`) at all.

---

### Task 1: Refactor `apiClient.js`/`tools.js` to factories; delete the stdio files

**Files:**
- Modify: `mcp-server/apiClient.js` (full rewrite)
- Modify: `mcp-server/tools.js` (full rewrite — same 15 tool bodies, different wrapping shape)
- Delete: `mcp-server/index.js`
- Delete: `mcp-server/verify.js`
- Modify: `package.json` (remove the `"mcp"` script)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createApiClient({ baseUrl, headers }) -> { apiRequest }` and `ApiError` from `apiClient.js`; `createTools(apiRequest) -> Array<{name, description, inputSchema, run}>` from `tools.js` — both consumed by Task 2's `src/routes/mcp.js`.

- [ ] **Step 1: Rewrite `apiClient.js` as a factory**

Replace the full contents of `mcp-server/apiClient.js`:

```js
const BASE_URL = process.env.OTA_BASE_URL;
const API_KEY = process.env.OTA_API_KEY;

if (!BASE_URL) {
  throw new Error('OTA_BASE_URL is required');
}
if (!API_KEY) {
  throw new Error('OTA_API_KEY is required');
}

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiRequest(method, path, { query, body } = {}) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, value);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Failed to reach the OTA API: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (err) {
      // non-JSON response body; leave json as null
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, json);
  }
  return json;
}

module.exports = { apiRequest, ApiError };
```

with:

```js
class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

function createApiClient({ baseUrl, headers }) {
  async function apiRequest(method, path, { query, body } = {}) {
    let url = `${baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) params.set(key, value);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Failed to reach the OTA API: ${err.message}`);
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        // non-JSON response body; leave json as null
      }
    }

    if (!res.ok) {
      throw new ApiError(res.status, json);
    }
    return json;
  }

  return { apiRequest };
}

module.exports = { createApiClient, ApiError };
```

- [ ] **Step 2: Rewrite `tools.js` as a factory**

Replace the full contents of `mcp-server/tools.js`:

```js
const { z } = require('zod');
const { apiRequest } = require('./apiClient');

module.exports = [
```

with:

```js
const { z } = require('zod');

function createTools(apiRequest) {
  return [
```

and replace the closing:

```js
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/reservations`, { body }),
  },
];
```

with:

```js
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/reservations`, { body }),
  },
  ];
}

module.exports = { createTools };
```

Every tool entry in between (`search_availability` through `create_restaurant_reservation`, all 15) is unchanged — same `name`, `description`, `inputSchema`, `run` bodies as before. After this edit, re-read the file to confirm it's valid JS: the array literal is now the `return` value of `createTools`, and every `run` closure still references the `apiRequest` parameter (now a function parameter of `createTools`, not a top-level `require`).

- [ ] **Step 3: Delete the stdio files**

```bash
rm mcp-server/index.js mcp-server/verify.js
```

- [ ] **Step 4: Remove the `mcp` npm script**

In `package.json`, replace:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "mcp": "node mcp-server/index.js"
  },
```

with:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  },
```

- [ ] **Step 5: Sanity-check the factories load without error**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { createApiClient, ApiError } = require('./mcp-server/apiClient');
const { createTools } = require('./mcp-server/tools');
const client = createApiClient({ baseUrl: 'http://localhost:3000', headers: { 'X-Api-Key': 'dummy' } });
const tools = createTools(client.apiRequest);
console.log('tool count:', tools.length);
console.log('tool names:', JSON.stringify(tools.map(t => t.name)));
"
```
Expected: `tool count: 15`, all 15 names listed (same set as before — `search_availability`, `create_guest`, `lookup_guest`, `create_booking`, `list_bookings`, `get_booking`, `cancel_booking`, `list_rooms`, `create_room`, `update_room`, `list_room_types`, `create_room_type`, `update_room_type`, `upsert_room_availability`, `create_restaurant_reservation`). No errors — confirms the factory refactor didn't break the module structure.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/apiClient.js mcp-server/tools.js package.json
git rm mcp-server/index.js mcp-server/verify.js
git commit -m "Refactor mcp-server apiClient/tools into factories, remove stdio entry point"
```

---

### Task 2: Add `POST /api/mcp`, mount it, verify locally

**Files:**
- Create: `src/routes/mcp.js`
- Modify: `src/app.js` (import + mount)

**Interfaces:**
- Consumes: `createApiClient`/`ApiError` from `mcp-server/apiClient.js`, `createTools` from `mcp-server/tools.js` (Task 1), `authenticateOrApiKey` from `src/middleware/auth.js` (already exported, unchanged).
- Produces: `POST /api/mcp` — nothing else in this plan depends on it (final deliverable).

- [ ] **Step 1: Write the route**

Create `src/routes/mcp.js`:

```js
const router = require('express').Router();
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createApiClient, ApiError } = require('../../mcp-server/apiClient');
const { createTools } = require('../../mcp-server/tools');
const { authenticateOrApiKey } = require('../middleware/auth');

router.post('/', authenticateOrApiKey, async (req, res, next) => {
  try {
    const forwardHeaders = {};
    if (req.headers['x-api-key']) forwardHeaders['X-Api-Key'] = req.headers['x-api-key'];
    if (req.headers.authorization) forwardHeaders['Authorization'] = req.headers.authorization;

    const baseUrl = `http://localhost:${process.env.PORT || 3000}`;
    const { apiRequest } = createApiClient({ baseUrl, headers: forwardHeaders });
    const tools = createTools(apiRequest);

    const server = new McpServer({ name: 'ota', version: '1.0.0' });
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
        try {
          const result = await tool.run(args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            return { isError: true, content: [{ type: 'text', text: 'API key is invalid, missing, or has been disabled. Contact your property admin.' }] };
          }
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
      });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount it in `app.js`**

In `src/app.js`, replace:

```js
const propertyRoutes = require('./routes/property');

const app = express();
```

with:

```js
const propertyRoutes = require('./routes/property');
const mcpRoutes = require('./routes/mcp');

const app = express();
```

Then replace:

```js
app.use('/api/property', propertyRoutes);

app.use(errorHandler);
```

with:

```js
app.use('/api/property', propertyRoutes);
app.use('/api/mcp', mcpRoutes);

app.use(errorHandler);
```

- [ ] **Step 3: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`. `nodemon` picks up the file changes automatically.

- [ ] **Step 4: Get Robs's current key**

```bash
cd "c:\Users\robert\source\repos\OTA" && node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT api_key FROM property WHERE id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'\")
  .then(r => { console.log(r.rows[0].api_key); pool.end(); });
" > /tmp/robs_key.txt
cat /tmp/robs_key.txt
```

- [ ] **Step 5: Verify — no auth at all is rejected**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/mcp -H "Content-Type: application/json" -d '{}'
```
Expected: `401` (the outer `authenticateOrApiKey` gate rejects before the request ever reaches MCP protocol handling).

- [ ] **Step 6: Verify — `listTools` and `create_guest` work via `X-Api-Key`**

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
  console.log('TOOL_NAMES:', JSON.stringify(tools.map(t => t.name)));

  const guestResult = await client.callTool({
    name: 'create_guest',
    arguments: { first_name: 'HTTP', last_name: 'Verify', email: \`http.verify.\${Date.now()}@example.com\` },
  });
  console.log('CREATE_GUEST:', JSON.stringify(guestResult));

  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 15`; `TOOL_NAMES` lists all 15 (same set as Task 1 Step 5); `CREATE_GUEST` has no `isError`, and its parsed `content[0].text` shows `property_id: "a3e548af-a71d-46c0-ba61-f1f702e495be"`.

- [ ] **Step 7: Verify — missing required field still surfaces the SDK validation error**

```bash
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
  const result = await client.callTool({ name: 'create_room_type', arguments: { name: 'Bad Type', max_occupancy: 2 } });
  console.log(JSON.stringify(result));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `isError: true`, text containing `"Input validation error"` and `base_rate` — same shape as the stdio version's equivalent check.

- [ ] **Step 8: Verify — disabled key rejected mid-session, same rewritten message**

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
curl -s -X POST http://localhost:3000/api/property/api-key/disable -H "Authorization: Bearer $CLERK_TOKEN" > /dev/null

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/mcp -H "Content-Type: application/json" -H "X-Api-Key: $(cat /tmp/robs_key.txt)" -d '{}'
```
Expected: `401` — the outer `authenticateOrApiKey` gate itself now rejects the disabled key (this is actually stricter/simpler than the stdio version's mid-tool-call 401 rewrite: since `/api/mcp` re-validates on every request, a disabled key never even reaches tool-call handling). Re-enable immediately after:

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
curl -s -X POST http://localhost:3000/api/property/api-key/enable -H "Authorization: Bearer $CLERK_TOKEN"
```
Expected: `{"api_key":"...","api_key_enabled":true}`.

- [ ] **Step 9: Verify — a Clerk Bearer token works too (not just X-Api-Key)**

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
cd "c:\Users\robert\source\repos\OTA" && OTA_TEST_TOKEN="$CLERK_TOKEN" node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), {
    requestInit: { headers: { 'Authorization': 'Bearer ' + process.env.OTA_TEST_TOKEN } },
  });
  const client = new Client({ name: 'verify3', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log('TOOL_COUNT:', tools.length);
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 15` — this must run within ~60 seconds of minting the token.

- [ ] **Step 10: Commit**

```bash
rm -f /tmp/robs_key.txt /tmp/tok.txt
git add src/routes/mcp.js src/app.js
git commit -m "Add POST /api/mcp (HTTP transport), mount on the Express app"
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
  RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST https://ota-u6ii.onrender.com/api/mcp -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "401" ]; then break; fi
  sleep 15
done
```
Expected: eventually `401` (proves the route exists and its auth gate is active — before this deploy finishes, the same request would `404` since the route doesn't exist yet on the old deployed code).

- [ ] **Step 4: Get FORGE's current key**

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
(Per Global Constraints' shell gotcha — extract the line by prefix match, not a blanket warning-filter, to avoid corrupting the value with leading blank lines.)

- [ ] **Step 5: Verify live — `listTools` and `create_guest`**

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

  const guestResult = await client.callTool({
    name: 'create_guest',
    arguments: { first_name: 'HTTP', last_name: 'LiveVerify', email: \`http.liveverify.\${Date.now()}@example.com\` },
  });
  console.log('CREATE_GUEST:', JSON.stringify(guestResult));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
"
```
Expected: `TOOL_COUNT: 15`; `CREATE_GUEST` has no `isError`, `property_id` is `b7a4c969-5e82-4c26-a587-17d2ab74858e` (FORGE).

- [ ] **Step 6: No further action**

```bash
rm -f /tmp/forge_key.txt /tmp/forge_key_raw.txt
```
This task is deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 2.
