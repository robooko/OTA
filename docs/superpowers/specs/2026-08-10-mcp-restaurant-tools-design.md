# MCP server: restaurant list/get/reservation tools

## Context

The MCP server's 15 tools (`docs/superpowers/specs/2026-08-10-mcp-server-design.md`, transport later redesigned in `2026-08-10-mcp-http-transport-design.md`) include `create_restaurant_reservation` but nothing to discover a `restaurant_id` in the first place, and nothing to look up or update a reservation afterward. An MCP client can create a reservation only if it already knows the restaurant's id from somewhere outside MCP (e.g. direct DB access, as used to verify this gap in this session).

The underlying REST routes for browsing restaurants and managing reservations (`GET /api/restaurant`, `GET /api/restaurant/:id`, `GET/PUT /:restaurant_id/reservations[/:id]`) are still `authenticate`-only (Clerk), not `authenticateOrApiKey` — the same gap the original MCP work closed for rooms/room-types/bookings/availability, just not yet done for restaurants.

## Goals

- Broaden `authenticateOrApiKey` to the 5 restaurant routes needed for browsing and reservation management.
- Add 5 matching MCP tools: `list_restaurants`, `get_restaurant`, `list_restaurant_reservations`, `get_restaurant_reservation`, `update_restaurant_reservation` — bringing the total to 20.

## Non-goals

- No `create_restaurant`/`update_restaurant`/table/service-period tools — restaurant *management* (as opposed to browsing + reservations) isn't part of this addition; only what's needed to complete the reservation flow.
- No dedicated `cancel_restaurant_reservation` tool — there's no `DELETE` route for reservations, only `PUT` with a `status` field (unlike bookings, which has a real `DELETE /:id`). `update_restaurant_reservation` with `status: "cancelled"` covers cancellation.
- No controller changes — `src/controllers/restaurant.js` already scopes every query by `req.property_id` (confirmed: 17 references), same as every other module this pattern has been applied to.

## Design

### Route changes (`src/routes/restaurant.js`)

```
GET  /api/restaurant                                    authenticate -> authenticateOrApiKey
GET  /api/restaurant/:id                                authenticate -> authenticateOrApiKey
GET  /api/restaurant/:restaurant_id/reservations         authenticate -> authenticateOrApiKey
GET  /api/restaurant/:restaurant_id/reservations/:id     authenticate -> authenticateOrApiKey
PUT  /api/restaurant/:restaurant_id/reservations/:id     authenticate -> authenticateOrApiKey
```

Everything else in that file (`POST`/`PUT` on the restaurant itself, tables, service periods) stays `authenticate`-only — out of scope per Non-goals.

### New tools (`mcp-server/tools.js`, added to the array `createTools` returns)

```js
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
```

Field names mirror the REST routes' existing body/query shapes exactly (already documented in `src/docs/swagger.js`), same convention every other tool follows. `src/docs/swagger.js` is updated to reflect the new `authenticateOrApiKey` security option on the 5 broadened paths (`security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]`, matching how `createBooking`/`createReservation` are already documented).

## Testing approach

No automated test framework — manual checks (`curl` for the route broadening, the SDK's `Client`/`StreamableHTTPClientTransport` for the tools, matching every prior MCP verification in this project):

1. `GET /api/restaurant` with `X-Api-Key` → `200`, scoped to that key's property (not `401`, confirming the middleware swap).
2. `GET /api/restaurant/:id` for a restaurant belonging to a *different* property than the key → `404`.
3. Via MCP: `listTools()` → 20 tools total, including the 5 new names.
4. `list_restaurants` → matches the REST call in step 1.
5. `get_restaurant` with a valid id → matches step 1's entry; with a cross-property id → `isError: true`, `"Restaurant not found"`.
6. Create a reservation via the existing `create_restaurant_reservation` tool, then `get_restaurant_reservation` with its id → returns the same reservation. `list_restaurant_reservations` for that restaurant → includes it.
7. `update_restaurant_reservation` with `status: "cancelled"` → succeeds; a follow-up `get_restaurant_reservation` shows the updated status.
8. Repeat steps 3-4 against live once local passes.
