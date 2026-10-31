# OTA — Claude Code Instructions

Multi-property hospitality backend (Node.js / Express / PostgreSQL): rooms and bookings, restaurant, spa, beach club, tours, courses, golf, equipment, pro shop, marina, housekeeping, event inquiries, billing. Also serves an MCP endpoint (`/api/mcp`) for AI agents.

## Where things live

- **Schema:** `src/db/schema.sql` is the source of truth. Changes ship as dated `src/db/migrate-YYYY-MM-DD-<feature>.sql` files.
- **API docs:** `src/docs/swagger.js` (served at `/api/docs`).
- **Routes → controllers → `src/lib/`** for shared domain logic. Look in `src/lib` before writing a helper.
- **MCP tools:** `mcp-server/tools.js`. Each tool calls the HTTP API through `apiRequest`.
- **Checks:** `scripts/check-<feature>.js`, run with `node -r dotenv/config scripts/check-<feature>.js`. They run against the local DB only. New ones should refuse to run on a remote DB, as most existing ones do.

## Conventions

- Every query is scoped by property. Auth middleware sets `req.property_id`. Never return or change another property's rows.
- Dates are `YYYY-MM-DD`. Stay ranges are `[check_in, check_out)`, so the check-out date is exclusive.
- Errors go to `errorHandler`: throw or `next()` an error with `status` (and optional `details`). The response is `{ error, details? }` with 400 / 404 / 409 / 500.
- Booking or availability changes refresh `room_type_availability` with `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- Nightly room rate: `room_availability.override_rate`, else `room_type_rate.rate`, else `room_type.base_rate`.
- Multi-step writes (bookings especially) run in one transaction.

## Deploying

- Pushing `main` auto-deploys to Render.
- If a change adds a migration, run it on the **live DB first (with Robert's OK), then push**. Otherwise new code hits the old schema and returns 500s.
- `scripts/run-migration.js` applies a migration to both local (`DATABASE_URL`) and live (`DATABASE_URL_LIVE`).

## New feature checklist

Every feature that adds or changes API routes is not done until it has:

- [ ] Dated migration `src/db/migrate-YYYY-MM-DD-<feature>.sql` + the same change in `schema.sql`
- [ ] Swagger docs in `src/docs/swagger.js`
- [ ] **MCP tools in `mcp-server/tools.js`** for every new route, unless it is staff-app, public guest link, webhook, OAuth or Stripe client flow (then add an `EXCLUDE` rule in `scripts/check-mcp-coverage.js`)
- [ ] `scripts/check-<feature>.js`
- [ ] `node -r dotenv/config scripts/check-mcp-coverage.js` passes

Plans must include the MCP tools step explicitly.
