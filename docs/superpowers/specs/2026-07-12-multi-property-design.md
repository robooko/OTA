# Multi-property (multi-tenant) support — Design

## Context

The API currently models a single hotel/resort — no table has any concept of
"which property this belongs to." The goal is to support multiple unrelated
hotel operators (a white-label SaaS) on one deployment, with each property's
data fully isolated from the others.

Almost no route currently requires authentication (only `GET /api/auth/me`
and the `/api/auth/users` admin routes do). Making tenant isolation real
requires closing that gap: staff/management endpoints must require login so
the server can trust which property a request belongs to.

## Goals

- Add a `property` table and scope every business record to one property.
- Identify the requesting property from the authenticated user's JWT for all
  staff/management endpoints.
- Keep a minimal public surface (guest-facing availability search) that takes
  an explicit `property_id`.
- Prevent cross-property data leaks: unknown/foreign IDs return `404`, never
  `403` (don't confirm another tenant's row exists).

## Non-goals (explicitly out of scope)

- Self-service property signup/provisioning API — properties and their first
  admin user are seeded directly via SQL.
- Subdomain or custom-domain based routing.
- Postgres Row-Level Security (RLS) — isolation is enforced entirely at the
  application/query layer for this iteration.
- Per-tenant billing/plan limits.
- Any change to payment provider integration (none exists today).

## Data model

### New table: `property`

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | VARCHAR(100) | NOT NULL |
| status | VARCHAR(20) | DEFAULT 'active' |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### `property_id` added to every business table

`property_id UUID NOT NULL REFERENCES property(id)` is added to:

`api_user, guest, room_type, room, room_availability, booking, payment,
extra, restaurant, restaurant_table, time_slot, restaurant_reservation,
spa_treatment, spa_therapist, spa_slot, spa_appointment, beach_bed,
beach_booking, tour, tour_slot, tour_booking, equipment, equipment_hire,
golf_course, tee_time, golf_booking, room_service_item, room_service_order,
proshop_item`

**Skipped** on pure line-item tables that only ever exist attached to a
parent and are never queried independently: `booking_extra`,
`room_service_order_item`, `golf_booking_item`. They're scoped transitively
through their parent (`booking`, `room_service_order`, `golf_booking`).

Each scoped table gets a plain index on `property_id`, and existing
composite indexes are prefixed with it, e.g.:

```sql
CREATE INDEX idx_booking_room_dates ON booking(property_id, room_id, check_in, check_out);
```

### Uniqueness changes (global → per-property)

- `guest`: `UNIQUE (property_id, email)` — was globally unique. Guests aren't
  logging in, so the same email may exist as separate guest records at two
  different properties.
- `room`: `UNIQUE (property_id, room_number)` — was globally unique.
- `beach_bed`: `UNIQUE (property_id, bed_number)` — was globally unique.
- No change needed for constraints already scoped via a single-property
  parent FK: `restaurant_table(restaurant_id, table_number)`,
  `tee_time(course_id, tee_date, tee_time)`,
  `spa_slot(therapist_id, slot_date, slot_time)`,
  `tour_slot(tour_id, slot_date, slot_time)`.
- `api_user.email` **stays globally unique** — see Auth section for why.

### Materialized view

`room_type_availability` gains `property_id` in the `SELECT`/`GROUP BY`, and
its unique index becomes `(property_id, room_type_id, date)`, so the search
query can filter by property directly without an extra join:

```sql
CREATE MATERIALIZED VIEW room_type_availability AS
SELECT
  r.property_id,
  r.room_type_id,
  ra.date,
  COUNT(*)                                        AS total_rooms,
  COUNT(*) FILTER (WHERE ra.is_available = true)  AS available_rooms,
  MIN(COALESCE(ra.override_rate, rt.base_rate))   AS min_rate
FROM room_availability ra
JOIN room      r  ON r.id  = ra.room_id
JOIN room_type rt ON rt.id = r.room_type_id
GROUP BY r.property_id, r.room_type_id, ra.date;

CREATE UNIQUE INDEX idx_rta_property_type_date
  ON room_type_availability(property_id, room_type_id, date);
```

The availability search query (`GET /api/availability/search`) adds
`rta.property_id = $1` to its `WHERE` clause, with `property_id` supplied as
an explicit query param (this endpoint stays public).

## Auth & tenant identification

- `api_user` gains `property_id NOT NULL REFERENCES property(id)`.
- `api_user.email` stays **globally unique**, unlike `guest`. This is an
  intentional asymmetry: a staff member's login email is how we find their
  account *before* we know their property (there's no subdomain or property
  selector on the login form), so it must be unique platform-wide. Guests
  never log in, so their email can repeat across properties without
  ambiguity.
- JWT payload becomes `{ id, role, property_id }`, signed at login/register.
- `authenticate` middleware is otherwise unchanged; it additionally sets
  `req.property_id = req.user.property_id` immediately after verifying the
  token, for controllers to use.
- **Public surface**: only `GET /api/availability/search` remains
  unauthenticated, and it requires an explicit `?property_id=` query param.
  Every other route across every module (guests, rooms, bookings, payments,
  restaurant, spa, beach club, tours, equipment, golf, room service, pro
  shop, extras) gets `authenticate` added.
- `POST /api/auth/register` currently accepts any `role` from an
  unauthenticated caller — a tenant-boundary hole once `property_id` exists.
  It changes to `authenticate + requireRole('admin')`, and always uses the
  caller's own `req.property_id` (any `property_id` in the request body is
  ignored) — an admin can only add staff/guest-role accounts to their own
  property. The first admin account per property is created directly via
  seed SQL (pre-hashed password), consistent with properties being
  provisioned manually.
- `requireRole` is unchanged, and gets applied consistently to
  admin-only write endpoints across modules where it isn't already.

## Query-scoping pattern in controllers

- Every query touching a scoped table adds `property_id = req.property_id`
  to its `WHERE`/`JOIN`.
- Single-record lookups (`GET/PUT/DELETE /:id`) always include
  `property_id` in the `WHERE`. A syntactically valid ID belonging to
  another property returns **404** — the response never distinguishes
  "doesn't exist" from "exists, but not yours."
- Inserts always set `property_id` from `req.property_id` server-side;
  a `property_id` in the request body (if present) is ignored.
- Because every table now carries its own `property_id`, controllers filter
  on the table's own column directly rather than joining up a parent chain
  (e.g. `WHERE booking.property_id = $1`, not a join through `room`).
- Line-item child tables (`booking_extra`, `room_service_order_item`,
  `golf_booking_item`) are scoped implicitly — they're only ever reached via
  their already-scoped parent's id.

## Migration & seed approach

There is no migration tool in this project (`schema.sql` is applied
directly; no migrations directory). Given no production data to preserve:

- `schema.sql` is edited in place: add `property`, add `property_id`
  columns, update unique constraints, update the materialized view and
  indexes.
- `seed.sql` / `seed-extras.sql` are updated to create 2 sample properties
  and tag every seeded row with one or the other, so local dev can
  immediately verify cross-property isolation (e.g. property A's rooms must
  not appear when authenticated as property B staff).
- Applying the change is a reset: drop/recreate the dev database, rerun
  `schema.sql`, then the seed files.

## Phased rollout

Each phase updates schema + controllers/routes + Swagger docs for that
module's tables, and is verified (manually, against the reseeded dev DB —
there's no automated test suite in this project) before moving to the next.

1. **Core**: `property`, `api_user`/auth, `guest`, `room_type`, `room`,
   `room_availability`, `booking`, `payment`, `extra`/`booking_extra`,
   materialized view + search query.
2. **Restaurant**: `restaurant`, `restaurant_table`, `time_slot`,
   `restaurant_reservation`.
3. **Spa / Beach club / Tours**: same resource → slot → appointment/booking
   shape repeated across all three.
4. **Equipment hire / Golf / Room service / Pro shop**: remaining modules.

## Error handling

No change to the existing error contract (`{ error, details? }` with
400/404/409/500). Cross-property access attempts surface as `404`, per the
scoping rule above — not a new `403` case.
