# MCP server: HTTP transport (replaces stdio)

## Context

`docs/superpowers/specs/2026-08-10-mcp-server-design.md` ("Part B") built the MCP server as a local `stdio` process, run per staff member via their own Claude Desktop/Code config with `OTA_API_KEY`/`OTA_BASE_URL` env vars. That was implemented and shipped (`mcp-server/index.js`, `mcp-server/verify.js`, `mcp-server/tools.js`, `mcp-server/apiClient.js`).

This spec **replaces** that transport entirely: instead of a separate local process, the same 15 tools are now served over HTTP at `POST /api/mcp`, mounted directly on this Express app. No separate process to run or configure — any MCP-compatible HTTP client (including remote/hosted clients, not just local ones) connects straight to the deployed API.

**Part A of the original spec — `authenticateOrApiKey` broadening to rooms/room-types/bookings/availability, and the `property.api_key_enabled` kill switch — is unchanged and stays exactly as shipped.** This spec only supersedes Part B (the delivery mechanism for the tools), not the auth work it depends on.

## Goals

- Serve the same 15 tools (unchanged set, unchanged input schemas) over `POST /api/mcp`.
- Reuse `authenticateOrApiKey` as-is for the endpoint's own auth gate — no new auth code.
- Reuse the existing tool implementations with minimal change — same `apiRequest`-per-tool shape, just made per-request instead of reading a fixed env var at module load.

## Non-goals

- No `GET`/SSE support on `/api/mcp` — stateless mode only, `POST`-only, matching this API's existing request/response style (no other route in this API streams). Can be added later if a client genuinely needs server-initiated notifications; nothing here needs it yet.
- No stateful session tracking (`sessionIdGenerator: undefined` — stateless mode) — each request is independently authenticated and self-contained, consistent with every other route in this API having no server-side session state.
- No rate limiting specific to this endpoint — matches this API's existing posture (no route anywhere has rate limiting).
- The local `stdio` process design is removed, not kept alongside — confirmed with the user (single transport, not dual).

## Design

### Endpoint

```
POST /api/mcp   authenticateOrApiKey
```

Accepts either a per-property `X-Api-Key` header or a Clerk `Authorization: Bearer` token — identical auth surface to `createBooking`/`createReservation`/etc. The route handler builds a fresh `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request (cheap — stateless mode has no persistent connection to reuse anyway), registers the 15 tools with a request-scoped `apiRequest` that loops back to this same running server (`http://localhost:${PORT}`), forwarding whichever auth header the original request used:

```js
// src/routes/mcp.js
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

Mounted in `src/app.js`: `app.use('/api/mcp', mcpRoutes);`. `express.json()` is already applied globally, so `req.body` is pre-parsed — matches the SDK's documented Express integration pattern exactly.

Forwarding the caller's own already-validated header to the loopback call means every inner tool call re-runs the same `authenticateOrApiKey` check a second time on the target route — redundant but harmless (no different from how any other client would call these routes), and keeps the loopback calls indistinguishable from a normal external request, so all existing route validation/logic is reused unchanged.

### `mcp-server/apiClient.js` — factory instead of singleton

Replace the module-level `BASE_URL`/`API_KEY` read (and its fail-fast throw) with a factory:

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

Same request/error logic as before, just parameterized instead of reading fixed module-level values.

### `mcp-server/tools.js` — factory instead of a static array

Wrap the existing 15 tool definitions in a `createTools(apiRequest)` function; every individual tool's `name`/`description`/`inputSchema`/`run` body is **unchanged**, only the top-level shape changes from `module.exports = [...]` to `module.exports = { createTools: (apiRequest) => [...] }`.

### Files removed

- `mcp-server/index.js` (stdio entry point) — deleted, no longer meaningful without a standalone process.
- `mcp-server/verify.js` (stdio test client) — deleted, replaced by direct HTTP verification (see Testing).
- `"mcp": "node mcp-server/index.js"` script removed from `package.json` — nothing to run standalone anymore.

## Testing approach

No automated test framework in this project — manual checks using the SDK's `Client` + `StreamableHTTPClientTransport` (the HTTP equivalent of how the stdio version was verified), pointed at the running server instead of spawning a subprocess:

```js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/api/mcp'), {
  requestInit: { headers: { 'X-Api-Key': ROBS_KEY } },
});
const client = new Client({ name: 'verify', version: '1.0.0' });
await client.connect(transport);
```

1. No auth header at all → the SDK client's `connect()` fails/the underlying HTTP response is `401` (confirms `authenticateOrApiKey` gates the endpoint itself, not just the inner loopback calls).
2. Valid `X-Api-Key` → `listTools()` returns all 15 tool names, same set as the stdio version had.
3. `callTool('create_guest', ...)` → succeeds, created guest's `property_id` matches the key's property.
4. `callTool('create_room_type', { name, max_occupancy })` (missing `base_rate`) → `isError: true` with the SDK's validation message, same as the stdio version.
5. Disable the property's key (`POST /api/property/api-key/disable`) mid-session, then call a tool → `isError: true` with the rewritten "API key is invalid, missing, or has been disabled" message (this now also proves the outer route's own `authenticateOrApiKey` re-checks per request, since disabling takes effect immediately without restarting anything). Re-enable afterward.
6. Repeat steps 1-3 with a Clerk `Authorization: Bearer` token instead of `X-Api-Key`, confirming both auth methods work through the loopback.
7. Repeat steps 2-3 against the live deployed server once local passes.
