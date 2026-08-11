# Tour slot management + restaurant table/service-period MCP tools

## Context

Two related gaps surfaced while testing the MCP server:

1. **Tour slots have no update or delete.** `tour_slot` has a `status` column (already respected by `searchSlots`'s `WHERE ts.status = 'active'` filter), but nothing lets a caller set it — slots can only be bulk-created, never individually deactivated.
2. **Restaurant tables and service periods have REST endpoints but no MCP tools.** `GET/POST/PUT /api/restaurant/:restaurant_id/tables[/:id]` and `GET/PUT /api/restaurant/:restaurant_id/service-periods` already work, but stay `authenticate`-only (Clerk), so an MCP tool calling them via `X-Api-Key` would 401 even if wrapped.

Precedent for the auth question: `POST/PUT /api/rooms` and `/api/room-types` — staff management actions — were made `authenticateOrApiKey` specifically so `create_room`/`update_room`/`create_room_type`/`update_room_type` MCP tools would work via a property's API key, not just a Clerk session. This spec follows that precedent for both parts below, superseding the tours module's original "staff-only, no API key" stance where it applies to this new endpoint (that stance predates the MCP work and wasn't designed with it in mind).

## Goals

- Add `PUT /api/tours/slots/:id` (status only) and its `update_tour_slot` MCP tool.
- Broaden `authenticate` → `authenticateOrApiKey` on the 5 restaurant table/service-period routes, and add 5 matching MCP tools.
- Bring the MCP tool count from 20 to 26.

## Non-goals

- No `slot_date`/`slot_time` editing — see rationale above (would retroactively change existing bookings' displayed time, since `tour_booking` has no date/time of its own, only a `slot_id` join).
- No hard `DELETE` for tour slots — `status = 'inactive'` achieves the practical effect without risking an FK-violation error against `tour_booking.slot_id`.
- No new tools for `create_tour`/`update_tour`/`bulk_create_slots` (tour *creation*, as opposed to slot status toggling) — not what was asked; those stay exactly as the tours-property-scoping design left them.
- No table/service-period *deletion* tools — matches the existing REST API, which has no delete for these either.

## Design

### Part A: `PUT /api/tours/slots/:id`

Route (`src/routes/tours.js`), added alongside the existing slot routes:
```js
router.put('/slots/:id', authenticateOrApiKey, ctrl.updateSlot);
```

Controller (`src/controllers/tours.js`):
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
```

MCP tool (`mcp-server/tools.js`):
```js
{
  name: 'update_tour_slot',
  description: 'Update a tour slot\'s status (e.g. set to "inactive" to hide it from search without deleting it)',
  inputSchema: { id: z.string(), status: z.string() },
  run: ({ id, status }) => apiRequest('PUT', `/api/tours/slots/${id}`, { body: { status } }),
},
```

### Part B: Restaurant table/service-period auth + tools

Route changes (`src/routes/restaurant.js`):
```
GET  /:restaurant_id/tables              authenticate -> authenticateOrApiKey
POST /:restaurant_id/tables              authenticate -> authenticateOrApiKey
PUT  /:restaurant_id/tables/:id          authenticate -> authenticateOrApiKey
GET  /:restaurant_id/service-periods     authenticate -> authenticateOrApiKey
PUT  /:restaurant_id/service-periods     authenticate -> authenticateOrApiKey
```
No controller changes — `listTables`/`createTable`/`updateTable`/`listServicePeriods`/`setServicePeriods` already scope every query by `req.property_id` (built that way from the start).

5 new MCP tools, same shape as every existing tool:
```js
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
```

Swagger (`src/docs/swagger.js`) gets `security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]` added to the 5 broadened restaurant paths, matching how the already-broadened restaurant paths (list/get restaurants, reservations) are documented.

## Testing approach

No automated test framework — manual checks, same pattern as every prior plan this session:

1. `PUT /api/tours/slots/:id` with a valid slot and `{"status":"inactive"}` via `X-Api-Key` → `200`, `status: "inactive"`. A follow-up `GET /api/tours/slots/search` for that date → the slot no longer appears (filtered by `status = 'active'`).
2. `PUT` on a slot belonging to a different property → `404`.
3. `PUT` with no `status` in the body → `400`.
4. `GET/POST/PUT` on restaurant tables and `GET/PUT` on service-periods, all via `X-Api-Key` → `200`/`201`, no `401`s (confirms the broadening).
5. Via MCP: `listTools()` → 26 tools total, including all 6 new names.
6. `create_restaurant_table` → `list_restaurant_tables` includes it → `update_restaurant_table` changes it.
7. `set_restaurant_service_periods` → `get_restaurant_service_periods` reflects the new set.
8. `update_tour_slot` via MCP on a real slot → `isError` absent, `status` updated.
9. Repeat steps 1, 4, 5 against live once local passes.
