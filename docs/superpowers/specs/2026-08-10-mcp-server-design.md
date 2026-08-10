# MCP server for staff — Design

## Context

Staff currently interact with this API only through whatever frontend calls it directly, or manual `curl`. The goal is to let hotel staff connect their own AI assistant (Claude Desktop or Claude Code) to a Model Context Protocol (MCP) server that wraps this API — so they can search availability, create bookings, manage rooms, etc. through natural-language tool calls instead of hand-writing HTTP requests.

The MCP server runs locally per staff member (a `stdio` process, standard MCP setup), authenticated with their property's existing per-property API key (`docs/superpowers/specs/2026-08-09-property-api-key-design.md`). Today that key only works on 3 routes (guests, bookings-create, restaurant-reservations-create) — everything else an MCP tool would need (listing/updating rooms, listing/cancelling bookings, setting availability) requires a Clerk session token, which a local process can't silently refresh the way a browser can. This spec covers both: broadening API-key auth to the routes the MCP server needs, and the MCP server itself.

No per-user identity or role distinction is introduced for API-key auth — a key grants full access to its property, same as today. That's an explicit simplification, not an oversight: this project doesn't need per-staff-member permission granularity yet.

## Goals

- Broaden `authenticateOrApiKey` to cover every route the MCP tools below need.
- Let an admin instantly kill a property's API-key access (MCP or otherwise) without rotating the key value.
- Ship a working local MCP server exposing 15 tools covering the guest/booking/room lifecycle.

## Non-goals

- No per-staff-member identity, role, or permission model for API keys — out of scope, a bigger project if ever needed.
- No remote/HTTP-hosted MCP server — local `stdio` only, per this design's chosen use case (staff running their own Claude Desktop/Code).
- No MCP tools for restaurant/spa/golf/tours/equipment/proshop/room-service/beach-club/payments/extras — those either use the separate `requireApiKey` shared-key mechanism (out of scope, see the per-property-API-key design's own non-goals) or aren't part of the core booking flow this first version targets.
- No tool-level enable/disable — the single `api_key_enabled` flag governs the whole key (all tools, and any other integration using that key) at once.

## Part A — Auth broadening

### Route changes

`authenticateOrApiKey` already exists (`src/middleware/auth.js`) and needs no logic changes — just swap which middleware these routes use, from `authenticate` to `authenticateOrApiKey`. No controller changes: all four controllers already consistently scope every query by `req.property_id`, which both middlewares set identically.

| File | Routes |
|---|---|
| `src/routes/rooms.js` | `GET /`, `POST /`, `PUT /:id` |
| `src/routes/roomTypes.js` | `GET /`, `POST /`, `PUT /:id` |
| `src/routes/bookings.js` | `GET /`, `GET /:id`, `DELETE /:id` |
| `src/routes/availability.js` | `PUT /rooms/:room_id` |

`src/routes/guests.js` (`POST /`, `GET /lookup`) and `src/routes/restaurant.js` (`POST /:restaurant_id/reservations`) already use `authenticateOrApiKey` — untouched.

### `GET /api/availability/search` — special case

This route is public today (`security: []` in Swagger, no middleware at all) and takes `property_id` as a required query param. It needs to stay callable with zero auth (existing public consumers), but an MCP tool call shouldn't have to know and pass its own property's UUID by hand when it already has the property's API key.

Fix, inside `searchAvailability` (`src/controllers/availability.js`) itself — not shared middleware, since no other route has this "public but key-optional" shape:

```js
async function searchAvailability(req, res, next) {
  try {
    let property_id = req.query.property_id;
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true', [apiKey]);
      if (rows.length) property_id = rows[0].id;
    }
    if (!property_id) {
      return res.status(400).json({ error: 'property_id is required (or supply a valid X-Api-Key)' });
    }
    // ...unchanged from here — the rest of the function already uses `property_id` as a local var
  } catch (err) { next(err); }
}
```

If an `X-Api-Key` header is present and matches an enabled key, it wins over any `property_id` query param sent alongside it (same "the key determines the property" rule as every other API-key route). Public callers without the header are completely unaffected.

### `property.api_key_enabled` — the kill switch

```sql
ALTER TABLE property ADD COLUMN IF NOT EXISTS api_key_enabled BOOLEAN NOT NULL DEFAULT true;
```

`authenticateOrApiKey`'s lookup (`src/middleware/auth.js`) changes from:
```sql
SELECT id FROM property WHERE api_key = $1
```
to:
```sql
SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true
```
A disabled key now behaves exactly like a wrong key — `401 {"error":"Missing or invalid Authorization header or X-Api-Key"}` — no special-cased error message (a disabled key shouldn't leak "this key exists but is disabled" to whoever's holding it; that information belongs to the admin who disabled it, not the caller).

Two new admin-only endpoints alongside the existing `GET`/`POST /rotate` (`src/controllers/property.js`, `src/routes/property.js`):

```
POST /api/property/api-key/disable   -- authenticate, requireRole('admin')
POST /api/property/api-key/enable    -- authenticate, requireRole('admin')
```

Both `UPDATE property SET api_key_enabled = $1 WHERE id = $2 RETURNING api_key, api_key_enabled`, returning the current state. `GET /api/property/api-key` also gains `api_key_enabled` in its response. Disabling doesn't touch the stored `api_key` value — re-enabling restores access with the same key, no rotation involved.

## Part B — MCP server

### File structure

New top-level `mcp-server/` directory, sibling to `src/` — not a nested package. `@modelcontextprotocol/sdk` added to the root `package.json` dependencies; a new `"mcp": "node mcp-server/index.js"` script. This repo has no monorepo tooling anywhere else, so a second `package.json` would be an unprecedented pattern — staying with one flat package is the established-pattern choice.

```
mcp-server/
  index.js       -- bootstraps @modelcontextprotocol/sdk's Server + StdioServerTransport, registers all tools from tools.js
  apiClient.js   -- fetch wrapper: reads OTA_API_KEY + OTA_BASE_URL from env, sets X-Api-Key on every request, throws ApiError(status, body) on non-2xx
  tools.js       -- the 11 tool definitions: { name, description, inputSchema, handler }
```

### Configuration

Two required env vars, set in the staff member's own MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ota": {
      "command": "node",
      "args": ["/absolute/path/to/OTA/mcp-server/index.js"],
      "env": {
        "OTA_API_KEY": "prop_...",
        "OTA_BASE_URL": "https://ota-u6ii.onrender.com"
      }
    }
  }
}
```

`index.js` fails fast at startup (throws, process exits non-zero) if either env var is missing — same "fail fast on missing secret" convention already used by `src/middleware/auth.js`'s `CLERK_SECRET_KEY` check.

### Tools

Each tool's input schema mirrors its route's existing request shape exactly — same field names, same required/optional split already established in `src/docs/swagger.js`. No new validation invented; `apiClient.js` passes the tool's input straight through as the request body/query/params, and the API's own validation (already there) is the source of truth for what's actually required.

| Tool | Method + path | Notes |
|---|---|---|
| `search_availability` | `GET /api/availability/search` | `check_in`, `check_out`, `guests` — `property_id` omitted from the tool's input schema entirely (resolved server-side from the API key, per Part A) |
| `create_guest` | `POST /api/guests` | `first_name`, `last_name`, `email`, `phone?` |
| `lookup_guest` | `GET /api/guests/lookup` | `email` |
| `create_booking` | `POST /api/bookings` | `guest_id`, `room_id` or `room_type_id`, `check_in`, `check_out`, `guests?`, `metadata?` |
| `list_bookings` | `GET /api/bookings` | `status?`, `guest_id?`, `from?`, `to?` |
| `get_booking` | `GET /api/bookings/:id` | `id` |
| `cancel_booking` | `DELETE /api/bookings/:id` | `id` |
| `list_rooms` | `GET /api/rooms` | `room_type_id?` |
| `create_room` | `POST /api/rooms` | `room_type_id`, `room_number`, `floor?` |
| `update_room` | `PUT /api/rooms/:id` | `id`, `room_number?`, `floor?`, `status?` |
| `list_room_types` | `GET /api/room-types` | (none) |
| `create_room_type` | `POST /api/room-types` | `name`, `description?`, `max_occupancy`, `base_rate` |
| `update_room_type` | `PUT /api/room-types/:id` | `id`, `name?`, `description?`, `max_occupancy?`, `base_rate?` |
| `upsert_room_availability` | `PUT /api/availability/rooms/:room_id` | `room_id`, `dates` (array of `{date, is_available?, override_rate?, block_reason?}`) |
| `create_restaurant_reservation` | `POST /api/restaurant/:restaurant_id/reservations` | `restaurant_id`, `reservation_date`, `start_time`, `contact_name`, `party_size`, plus the route's other optional fields |

### Error handling

`apiClient.js` catches every non-2xx response and throws `ApiError` carrying the parsed `{error, details}` body. Each tool handler in `tools.js` catches `ApiError` and returns an MCP tool error:

```js
{ isError: true, content: [{ type: 'text', text: message }] }
```

where `message` is:
- the API's `error` field, verbatim, for any status except 401
- for 401 specifically: `"API key is invalid, missing, or has been disabled. Contact your property admin."` (rewritten — the raw API message doesn't distinguish "never configured" from "disabled" from "wrong", and none of that distinction is useful to surface to whoever's holding a rejected key)
- for a network-level failure (can't reach `OTA_BASE_URL` at all): `"Failed to reach the OTA API: " + err.message`

Successful responses return the API's JSON body as the tool's result content, stringified.

## Testing approach

No automated test framework in this project — manual checks, same as every other feature here.

**Part A (auth broadening), against local `npm run dev`:**
1. For each of the 4 route files: call the now-key-eligible route with `X-Api-Key` (a real property key) and no `Authorization` header → success, scoped to that property (not whatever `property_id` might be in the body, if any is sent). Then with a wrong key → `401`.
2. `GET /api/availability/search` with a valid `X-Api-Key`, no `property_id` in the query → results scoped to that key's property. Same call with `property_id` for a *different* property in the query alongside the header → the header wins (results still scoped to the key's property, not the query param). Same call with only `property_id`, no header → unchanged public behavior.
3. Run the migration; confirm every existing property has `api_key_enabled = true`.
4. `POST /api/property/api-key/disable` (Clerk admin token) → `200 {"api_key":"...","api_key_enabled":false}`. Follow-up call to any API-key route using that property's key → `401` (same message as a wrong key). `POST /api/property/api-key/enable` → `200 {"api_key_enabled":true}`; the same follow-up call now succeeds again, using the *same* key value as before (proving disable/enable doesn't touch the key itself).

**Part B (MCP server):**
5. Start the MCP server locally with `OTA_API_KEY` set to a real (enabled) property key and `OTA_BASE_URL=http://localhost:3000`. Connect via Claude Desktop/Code's MCP inspector or a minimal stdio client script; confirm all 15 tools are listed with the expected input schemas.
6. Call `search_availability`, `create_guest`, `create_booking` in sequence (guest → booking uses the guest's returned `id`) → each succeeds, booking lands on the key's property.
7. Call `list_bookings` → includes the booking from step 6. Call `cancel_booking` with its `id` → succeeds; a follow-up `get_booking` shows `status: "cancelled"`.
8. Call any tool with a deliberately invalid input (e.g. `create_room_type` missing `base_rate`) → tool returns `isError: true` with the API's actual validation message, not a crash.
9. Disable the property's key via the REST API directly (step 4's endpoint), then call any MCP tool → `isError: true` with the rewritten "API key is invalid, missing, or has been disabled" message. Re-enable, retry → succeeds.
10. Stop `OTA_BASE_URL`'s server (or point `OTA_BASE_URL` at an unreachable host) and call a tool → `isError: true` with the "Failed to reach the OTA API" message, not a hang or crash.
