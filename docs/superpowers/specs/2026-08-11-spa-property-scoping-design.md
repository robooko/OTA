# Spa module: property scoping

## Context

The restaurant module was scoped to `property_id` in `docs/superpowers/specs/2026-08-09-restaurant-property-scoping-design.md`; tours followed in `docs/superpowers/specs/2026-08-10-tours-property-scoping-design.md`. Spa (`spa`, `spa_treatment`, `spa_therapist`, `spa_slot`, `spa_appointment`) is next — it currently has no `property_id` anywhere, most read routes are fully public (no auth at all), and every write route is gated by the old shared `X-Api-Key` (`requireApiKey`). Every spa, treatment, therapist, slot, and appointment is visible and bookable regardless of property.

Unlike tours (which had zero existing rows), spa has real data on both databases, so this needs the restaurant module's backfill approach, not a clean additive migration:

- **Local:** 3 spas ("Pirates Bight Spa", "Test Spa A", "Test Spa B"), 5 treatments, 3 therapists, 2 slots, 2 appointments.
- **Live:** 1 spa ("Pirates Bight Spa"), 20 treatments, 3 therapists, 740 slots, 6 real appointments.

### Property backfill mapping (confirmed with the user)

| Spa | Database | Property |
|---|---|---|
| Pirates Bight Spa | Live | FORGE (`b7a4c969-5e82-4c26-a587-17d2ab74858e`) — matches the restaurant "Pirates Bight"'s current (reassigned) property from earlier this session, not its original BBYC home |
| Pirates Bight Spa | Local | Robs (`a3e548af-a71d-46c0-ba61-f1f702e495be`) |
| Test Spa A | Local | Robs |
| Test Spa B | Local | Robs |

## Goals

- Add `property_id UUID NOT NULL REFERENCES property(id)` directly to all 5 spa tables, matching the restaurant module's "avoid parent-chain joins in every query" pattern.
- Staff-only access to spa management and browsing: list/get/create/update spas, treatments, therapists, slots (list/bulk-create/search), and appointments (list/get/update) all require `authenticate` (Clerk) and are scoped to `req.property_id`.
- Guest-facing appointment creation keeps working via `X-Api-Key`: `POST /:spa_id/appointments` switches to `authenticateOrApiKey`, matching `createBooking`/`createReservation`/tours' `createBooking`.

## Non-goals

- No MCP tools in this pass — this is scoping only, matching how tours was scoped first and got its `update_tour_slot` tool as a separate follow-up later. A spa MCP-tools pass can follow the same way if wanted.
- No public/unauthenticated browse mode anywhere — confirmed with the user implicitly by following the same decision already made twice (restaurant, tours): browse requires staff login.
- No change to any other module.
- Golf/beach club/equipment/room service/pro shop stay on `requireApiKey`, unscoped — later phases, not this one.

## Data model

```sql
ALTER TABLE spa              ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE spa_treatment    ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE spa_therapist    ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE spa_slot         ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE spa_appointment  ADD COLUMN property_id UUID REFERENCES property(id);
```

Added nullable first (real data exists — see Migration below for the backfill + `SET NOT NULL` sequence). `schema.sql` itself is updated in place to declare the column `NOT NULL` directly, for fresh installs that never carry legacy data.

Indexes: `idx_spa_property`, `idx_spa_treatment_property`, `idx_spa_therapist_property`, `idx_spa_slot_property`, `idx_spa_appointment_property` — one per table.

No unique-constraint changes — `spa_slot`'s existing `UNIQUE (therapist_id, slot_date, slot_time)` is already scoped transitively through `therapist_id`, which is itself now single-property.

## API & behavior

Routes (no path changes, only middleware and query scoping):

```
GET    /api/spa                              authenticate, scoped to req.property_id
GET    /api/spa/:id                          authenticate, scoped
POST   /api/spa                              authenticate (was requireApiKey)
PUT    /api/spa/:id                          authenticate, scoped

GET    /api/spa/:spa_id/treatments           authenticate, scoped
POST   /api/spa/:spa_id/treatments           authenticate (was requireApiKey)
PUT    /api/spa/:spa_id/treatments/:id       authenticate, scoped

GET    /api/spa/:spa_id/therapists           authenticate, scoped
POST   /api/spa/:spa_id/therapists           authenticate (was requireApiKey)
PUT    /api/spa/:spa_id/therapists/:id       authenticate, scoped

GET    /api/spa/:spa_id/slots                authenticate, scoped (was requireApiKey)
POST   /api/spa/:spa_id/slots/bulk           authenticate (was requireApiKey)
GET    /api/spa/:spa_id/slots/search         authenticate, scoped (was public, no auth)

GET    /api/spa/:spa_id/appointments         authenticate, scoped (was requireApiKey)
GET    /api/spa/:spa_id/appointments/:id     authenticate, scoped (was requireApiKey)
POST   /api/spa/:spa_id/appointments         authenticateOrApiKey (was requireApiKey)
PUT    /api/spa/:spa_id/appointments/:id     authenticate, scoped (was requireApiKey)
```

Controller changes, mirroring `tours.js`:

- `listSpas`: add `AND property_id = $1`.
- `getSpa`/`updateSpa`: add `AND property_id = $n` to the `WHERE`.
- `createSpa`: insert `property_id` from `req.property_id`.
- `listTreatments`/`listTherapists`: add `AND property_id = $n` alongside the existing `spa_id` filter.
- `createTreatment`/`createTherapist`: insert `property_id` from `req.property_id`. The existing `spa_id`-from-URL insert is unchanged, but should also first confirm the spa itself belongs to `req.property_id` (`404` if not) — same "verify the parent before trusting a path param" rule `bulkCreateSlots` already follows for `tour_id`.
- `updateTreatment`/`updateTherapist`: add `AND property_id = $n` to the `WHERE`.
- `listSlots`: add `AND ss.property_id = $n`.
- `bulkCreateSlots`: first verify the `spa_id` from the URL belongs to `req.property_id` (`404` if not). Keep the existing `therapist_id`/`treatment_id`-belongs-to-`spa_id` checks unchanged. Each inserted `spa_slot` row sets `property_id = req.property_id` directly.
- `searchSlots`: add `AND ss.property_id = $n`.
- `listAppointments`: add `AND sa.property_id = $n`.
- `getAppointment`: add `AND sa.property_id = $n` (in addition to the existing `st.spa_id = $2` join condition).
- `createAppointment`: the slot lookup gains `AND ss.property_id = $n` using `req.property_id` — a `slot_id` from another property now `404`s. Insert sets `spa_appointment.property_id` from `req.property_id`. If `guest_id` is supplied, checked against `req.property_id` the same way `createReservation`/tours' `createBooking` check guest ownership — a cross-property guest id now `404`s instead of silently attaching.
- `updateAppointment`: add `AND sa.property_id = $n` to the `WHERE`.

Foreign/cross-property IDs return `404` everywhere, never `403` — same rule as every prior phase.

`src/docs/swagger.js` gets updated to reflect the new auth requirement on each path, matching how restaurant/tours paths are already documented, and to drop `security: []`/absent-security from the previously-public `GET` paths now that they require auth.

## Migration & rollout

Following the restaurant module's non-destructive migration convention (real data on both databases):

- `schema.sql` updated in place — `property_id UUID NOT NULL REFERENCES property(id)` added directly to all 5 table definitions, plus the 5 new indexes — so a fresh full reset produces the final shape directly.
- New `migrate-2026-08-11-spa-property-scoping.sql` for the already-populated dev/prod databases:
  1. Add each `property_id` column **nullable** (`ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id)`).
  2. Backfill `spa.property_id` directly by name, per the mapping table above (different values for local vs. live — this migration file will need the local and live runs to use different `UPDATE ... WHERE name = ...` statements, since the *same* spa name maps to a *different* property per database. Written as one migration file with explicit `WHERE name = 'Pirates Bight Spa' AND id = '<the specific known id>'` per-database, not a shared blind `WHERE name = ...`, to avoid accidentally matching the wrong row if names ever collide differently between the two databases).
  3. Backfill `spa_treatment`, `spa_therapist` by joining back to `spa.id` (`UPDATE ... SET property_id = s.property_id FROM spa s WHERE s.id = spa_treatment.spa_id`, similarly for `spa_therapist`).
  4. Backfill `spa_slot` by joining through `spa_therapist` (links via `therapist_id`, not `spa_id` directly).
  5. Backfill `spa_appointment` by joining through `spa_slot` (links via `slot_id`).
  6. `ALTER COLUMN property_id SET NOT NULL` on all 5 tables, once backfilled.
  7. Create the 5 indexes.
  Idempotent-safe via `IF NOT EXISTS` on the column adds and indexes; the `UPDATE`/backfill steps are naturally idempotent.
- Migration is run against local first (verify), then production — same two-step process used for restaurant/tours.

## Testing approach

No automated test framework — manual checks (`curl` against a running `npm run dev`, using Robs's staff token and a second property's for cross-property checks, matching the tours plan's approach of inserting one "foreign" row directly via SQL rather than needing a second live Clerk identity):

1. Run the migration locally. Confirm all 5 tables have `property_id` `NOT NULL`, and the 3 local spas map to Robs.
2. `GET /api/spa` with no auth → `401` (previously public). With Robs's token → all 3 local spas.
3. `GET /api/spa/:id` for a spa inserted directly under a different property → `404`.
4. `POST /api/spa` with Robs's token → `201`, correct `property_id`. With the old shared `API_KEY` → `401` (confirms full replacement).
5. `POST /:spa_id/treatments` and `/:spa_id/therapists` for a spa belonging to a different property → `404`.
6. `POST /:spa_id/slots/bulk` for a spa belonging to a different property → `404`.
7. `GET /:spa_id/slots/search` with no auth → `401` (previously public). With a staff token → only that property's slots.
8. `POST /:spa_id/appointments` via `X-Api-Key` for a `slot_id` belonging to a different property → `404`. Via the matching property's key → `201`.
9. `POST /:spa_id/appointments` with a `guest_id` belonging to a different property → `404`.
10. `GET /:spa_id/appointments` with a staff token → only that property's appointments.
11. Repeat the core checks (2, 4, 8) against live once local passes — using the real "Pirates Bight Spa" data, read-only where practical given it has 6 real appointments and 740 real slots.
