# Multi-spa support

## Context

The spa module (`spa_treatment`, `spa_therapist`, `spa_slot`,
`spa_appointment`) is currently flat and unscoped — there is no entity
representing an individual spa location, so all treatments and therapists
are implicitly one global spa. This mirrors how the restaurant module
looked before it grew a `restaurant` parent entity; restaurant now models
multiple named locations (Bonito, Bimini, Betula, Barry, BBYC, Pirates
Bight), each owning its own tables and service periods.

The request is to give spa the same shape: multiple named spa locations,
each with its own treatment menu and therapist roster, following the
`restaurant` → `restaurant_table` pattern as closely as it reasonably
applies. First location to seed: a spa for Pirates Bight.

No spa table currently has any seed data (confirmed: no seed file
references `spa_treatment`, `spa_therapist`, `spa_slot`, or
`spa_appointment`), so this is a clean rollout with nothing to backfill.

## Goals

- A `spa` entity table (name, description, phone) representing an
  individual spa location, analogous to `restaurant`.
- `spa_treatment` and `spa_therapist` each belong to exactly one spa via a
  `spa_id` FK — per-spa menu and per-spa staff, matching how
  `restaurant_table` belongs to exactly one `restaurant`.
- `spa_slot` and `spa_appointment` stay as-is (no new column) — a slot's
  spa is derived through `therapist_id → spa_therapist.spa_id`, the same
  way `restaurant_reservation`'s restaurant is derived through
  `table_id → restaurant_table.restaurant_id`.
- Routes and controllers restructured from flat (`/api/spa/treatments`) to
  nested under a spa (`/api/spa/:spa_id/treatments`), matching
  `/api/restaurant/:restaurant_id/...`.
- Seed a real spa location for Pirates Bight with a small treatment menu
  and two therapists.

## Non-goals (explicitly out of scope)

- No `property_id` on `spa` — stays unscoped like `restaurant` currently
  is. Multi-property scoping for restaurant/spa/tours/etc. is an
  explicitly deferred later phase per the existing Phase 1 multi-property
  plan; spa shouldn't get ahead of restaurant here.
- No FK or other schema-level link between `spa` and `restaurant`. The
  Pirates Bight spa is themed/named to match the Pirates Bight restaurant
  but is a fully independent row — same relationship (none) as any other
  pair of restaurant/spa locations.
- Therapists cannot work at more than one spa — `spa_therapist.spa_id` is
  a single required FK, not a join table.
- No seeded `spa_slot` rows for Pirates Bight — bookable availability is
  generated later via `POST /api/spa/:spa_id/slots/bulk`, same as how
  restaurant seeds define tables/hours but never seed example
  reservations.
- No pre-check that a `spa_id` in the URL actually exists before
  `createTreatment`/`createTherapist` insert — matches `createTable`'s
  existing behavior (relies on the FK constraint, 500 on a bad id) rather
  than introducing validation restaurant doesn't have.

## Data model

```sql
CREATE TABLE IF NOT EXISTS spa (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  phone       VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

No `slot_interval_minutes`/`default_duration_minutes`/`closed_days` —
those exist on `restaurant` to auto-fit reservations into a computed
service window. Spa has no equivalent computed-availability logic; slots
are always explicit rows created via `bulkCreateSlots`, so there's nothing
for those columns to drive.

```sql
ALTER TABLE spa_treatment ADD COLUMN spa_id UUID NOT NULL REFERENCES spa(id);
ALTER TABLE spa_therapist ADD COLUMN spa_id UUID NOT NULL REFERENCES spa(id);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa ON spa_therapist(spa_id);
```

`spa_slot` and `spa_appointment` are unchanged. A slot references both a
spa-scoped therapist and a spa-scoped treatment, which restaurant's
single-entity-per-reservation model doesn't have an equivalent of — so
`bulkCreateSlots` gets a new check: with `spa_id` coming from the URL
(`/api/spa/:spa_id/slots/bulk`), reject with `400` unless both the given
`therapist_id` and `treatment_id` belong to that `spa_id`.

## API & behavior

Routes move from flat to nested under `/api/spa`, mirroring
`/api/restaurant`:

```
GET    /api/spa                          list spas
GET    /api/spa/:id                      get spa
POST   /api/spa                          create spa
PUT    /api/spa/:id                      update spa

GET    /api/spa/:spa_id/treatments       list, filtered by spa_id (was global)
POST   /api/spa/:spa_id/treatments
PUT    /api/spa/:spa_id/treatments/:id

GET    /api/spa/:spa_id/therapists       list, filtered by spa_id (was global)
POST   /api/spa/:spa_id/therapists

GET    /api/spa/:spa_id/slots
POST   /api/spa/:spa_id/slots/bulk       validates therapist & treatment both belong to spa_id
GET    /api/spa/:spa_id/slots/search

GET    /api/spa/:spa_id/appointments
POST   /api/spa/:spa_id/appointments
PUT    /api/spa/:spa_id/appointments/:id
```

This breaks the current flat endpoints (`GET /api/spa/treatments` etc. no
longer exist in that form) — an accepted, deliberate change, not an
oversight; it brings spa in line with how restaurant is already
structured.

`listTreatments`/`listTherapists`/`listSlots`/`listAppointments` filter by
`spa_id` from the URL param instead of returning everything globally,
mirroring `listTables`. `listSlots`/`listAppointments`/`searchSlots` join
through `spa_therapist`/`spa_treatment` to scope by the URL's `spa_id`.
`createTreatment`/`createTherapist` insert using the URL's `spa_id`
directly (not read from the request body), same as `createTable` does for
`restaurant_id`. `createAppointment` is unchanged in its own logic (still
keyed off `slot_id`) beyond living under the nested route.

Swagger docs (`src/docs/swagger.js`) get updated for the new `spa` entity
CRUD and the nested paths, following the same shape as the restaurant
entries.

## Seed data — Pirates Bight spa

New `seed-spa-pirates-bight.sql`, scoped the same way as
`seed-restaurant-pirates-bight.sql` (structure only, no bookable
instances):

- **Spa**: `Pirates Bight Spa` — "A barefoot spa retreat steps from the
  dock on Norman Island, BVI — beachfront treatments beneath the palms."
- **Treatments**: Island Swedish Massage (60 min, $140), Deep Tissue
  Massage (60 min, $155), Ocean Facial (50 min, $120)
- **Therapists**: Marisol Fahie, Dwayne Christopher

Uses the same `WITH new_spa AS (INSERT ... RETURNING id)` chaining pattern
already used in the restaurant seed files.

## Migration & rollout

Following this project's non-destructive migration convention (see
`migrate-2026-07-23-restaurant-reservation-metadata.sql` and similar):

- `schema.sql` is updated in place (new `spa` table, `spa_id` columns on
  `spa_treatment`/`spa_therapist`) so a fresh full reset produces the new
  shape directly.
- New `migrate-2026-08-01-spa-scoping.sql` for an already-provisioned
  database: `CREATE TABLE IF NOT EXISTS spa (...)`, then
  `ALTER TABLE spa_treatment ADD COLUMN spa_id ...`/same for
  `spa_therapist`. Safe as a straight `NOT NULL` add (no default, no
  backfill needed) because both tables are confirmed empty everywhere.
  Idempotent via `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`.
- `seed-spa-pirates-bight.sql` is a plain additive `INSERT`, safe to run
  directly against an already-populated database, same as the restaurant
  seed files.

## Testing approach

No automated test framework in this project — manual checks (`curl`/`psql`
against a running `npm run dev`):

1. Run the migration (or a fresh reset) against the local dev DB. Confirm
   `spa` exists, and `spa_treatment`/`spa_therapist` have a `spa_id`
   column.
2. Run `seed-spa-pirates-bight.sql`. Confirm `GET /api/spa` returns
   "Pirates Bight Spa", and `GET /api/spa/:id/treatments` /
   `GET /api/spa/:id/therapists` return the seeded rows scoped to that
   spa only.
3. Create a second spa via `POST /api/spa`, add a treatment and therapist
   to it. Confirm it does not appear under Pirates Bight's nested list
   endpoints, and vice versa.
4. `POST /api/spa/:pirates_bight_id/slots/bulk` with a therapist/treatment
   pair from two *different* spas → `400`. Same call with a matching pair
   → `201`, slots created.
5. `POST /api/spa/:pirates_bight_id/appointments` against a created slot →
   `201`. Confirm it shows up under
   `GET /api/spa/:pirates_bight_id/appointments` and not under the other
   seeded spa's appointments list.
6. Confirm the old flat routes (e.g. `GET /api/spa/treatments`) no longer
   resolve (404 from the router, not a 500).
