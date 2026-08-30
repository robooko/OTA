# Spa module: computed availability, service-at-booking, confirmations

## Context

Bedford Barber Co (a walk-in barbershop on Miller Road, Bedford — one
barber, Omar, nine fixed-price services) currently takes bookings through
Booksy. The question raised was whether OTA's spa module could take those
bookings instead, off the shop's own Astro site. Structurally it nearly
can: `spa` ≈ the shop, `spa_treatment` ≈ services (name, `duration_mins`,
`price`), `spa_therapist` ≈ barbers, `spa_appointment` ≈ a booking, and
every spa route already accepts the property `X-Api-Key`
(`authenticateOrApiKey`) so a server-side site endpoint can drive it.

Three things stop it being usable for this kind of business today:

1. **Availability is a pre-generated `spa_slot` row pinned to one
   treatment.** `spa_slot` is `(therapist_id, treatment_id, slot_date,
   slot_time)` with `UNIQUE (therapist_id, slot_date, slot_time)`, so a
   barber's 10:00 can only ever be one service. A customer choosing
   "Skin Fade + Beard" against a slot generated for "Haircut" is not
   expressible, and durations are ignored entirely — a 15-minute beard
   trim and a 45-minute fade occupy the same slot and the next slot is
   never blocked by a long service.
2. **Nothing is generated from opening hours.** `POST /:spa_id/slots/bulk`
   takes a date range + `times[]`; someone has to keep regenerating slots
   as the calendar rolls, remembering Tue closed, Sat 09–18, Sun 11:30–16.
3. **The customer hears nothing.** `createAppointment` publishes to Ably
   for the admin feed and returns 201. Resend is wired up
   (`src/lib/resend.js`) but only for event-inquiry replies.

The restaurant module already solved (1) and (2) for itself: `restaurant`
carries `slot_interval_minutes` / `closed_days`, `service_period` rows
hold opening windows, and `searchAvailability` computes candidate times
with `generate_series` and excludes overlapping reservations by
`start_time`/`end_time`. This spec brings spa in line with that pattern
rather than inventing a second one.

Live data that must survive: Pirates Bight Spa on production has 20
treatments, 3 therapists, 740 `spa_slot` rows and 6 real appointments
(per `2026-08-11-spa-property-scoping-design.md`). The slot-based flow
keeps working; it is not removed.

## Goals

- Per-therapist weekly working hours (`spa_therapist_hours`) and
  whole-day time off (`spa_therapist_time_off`), modelled on
  `service_period` / `restaurant_seasonal_closure`.
- A computed `GET /api/spa/:spa_id/availability` that takes a treatment
  and returns bookable start times per date, duration- and overlap-aware,
  in the same response shape as restaurant's `searchAvailability`.
- `spa_appointment` records what was actually booked — `treatment_id`,
  `therapist_id`, `appointment_date`, `start_time`, `end_time` — directly
  on the row, so reads never depend on a slot.
- `POST /:spa_id/appointments` accepts `{treatment_id, therapist_id?,
  date, time}` and serialises overlap checks per therapist. `slot_id`
  remains accepted for the legacy flow.
- Confirmation email on create and cancellation email on
  `status → 'cancelled'`, via the existing Resend client, fire-and-forget
  like the Ably publishes.
- MCP: `search_spa_availability`, `set_spa_therapist_hours`, and the
  `create_spa_appointment` tool schema updated for the new fields.
- Seed Bedford Barber Co as a real spa under its own property.

## Non-goals (explicitly out of scope)

- No reminders (email or SMS) ahead of the appointment. Booksy does this;
  it is the main thing a customer would notice missing. Separate spec once
  a scheduler/cron exists in this codebase (there is none today).
- No customer self-service cancel/reschedule link. Cancellation is a staff
  action via `PUT /:spa_id/appointments/:id` for now. The cancellation
  email is sent when staff do it.
- No deposits / holds. Restaurant's `payment_protection` +
  `stripe_secret_key` pattern could be lifted later; nothing in this spec
  blocks it.
- No no-show status. `status` stays `confirmed` / `cancelled`; a
  `no_show` value can be added to the same column later without a
  migration (it is `VARCHAR(20)` with no CHECK).
- No removal of `spa_slot` or the `/slots` routes. Pirates Bight has real
  slot data; the new columns are backfilled *from* it. `bulkCreateSlots`
  and `searchSlots` are left as-is and documented as the legacy path.
- No "any barber" load-balancing beyond a deterministic pick (see below).
- No admin UI — hotal-ui is a separate repo; `live-spa-bookings-feed`
  keeps working unchanged because `toLiveSpaBooking` is adjusted to read
  the new direct columns.
- No inbound email for appointments (no reply-to routing). Confirmation
  emails set `replyTo` to the spa's own contact email if one is set,
  otherwise no reply-to.
- No change to the bedford-barber site in this repo — see "Consuming
  site" at the end for what that side needs.
- No public/unauthenticated browse. Same decision as restaurant/tours/spa
  scoping: the site's server holds the key.

## Data model

### New: working hours (mirrors `service_period`)

```sql
CREATE TABLE IF NOT EXISTS spa_therapist_hours (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  therapist_id UUID NOT NULL REFERENCES spa_therapist(id),
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- ISO: 1 = Mon
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_hours_property  ON spa_therapist_hours(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_hours_therapist ON spa_therapist_hours(therapist_id, day_of_week);
```

Multiple rows per `(therapist_id, day_of_week)` are allowed — that is how
a lunch break or split shift is expressed (two windows). No row for a day
means the therapist does not work that day; there is no `closed_days`
array on `spa` because closure is per-barber, not per-shop.

### New: time off (mirrors `restaurant_seasonal_closure`, but dated)

```sql
CREATE TABLE IF NOT EXISTS spa_therapist_time_off (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  therapist_id UUID NOT NULL REFERENCES spa_therapist(id),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  reason       VARCHAR(100),
  CHECK (start_date <= end_date)
);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_time_off_therapist ON spa_therapist_time_off(therapist_id, start_date, end_date);
```

Whole days only. Partial-day blocks are done by editing hours for that
week or by staff creating a placeholder appointment — deliberately not a
third mechanism.

### `spa`: interval + contact email

```sql
ALTER TABLE spa ADD COLUMN IF NOT EXISTS slot_interval_minutes INT NOT NULL DEFAULT 15;
ALTER TABLE spa ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
ALTER TABLE spa ADD COLUMN IF NOT EXISTS address TEXT;
```

`slot_interval_minutes` is the step between candidate start times, same
meaning as on `restaurant`. `contact_email` becomes the confirmation
email's `replyTo`; `address` goes in the email body. Both nullable.

### `spa_appointment`: record the booking directly

```sql
ALTER TABLE spa_appointment ALTER COLUMN slot_id DROP NOT NULL;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS treatment_id     UUID REFERENCES spa_treatment(id);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS therapist_id     UUID REFERENCES spa_therapist(id);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS appointment_date DATE;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS start_time       TIME;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS end_time         TIME;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS confirmation_resend_email_id TEXT;
-- after backfill (see Migration):
ALTER TABLE spa_appointment ALTER COLUMN treatment_id     SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN therapist_id     SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN appointment_date SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN start_time       SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN end_time         SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spa_appointment_therapist_date ON spa_appointment(therapist_id, appointment_date);
```

Every appointment — legacy slot-based or new — ends up with the five
direct columns populated. `slot_id` becomes an optional back-pointer that
only the legacy `searchSlots` conflict check still reads. All list/get
queries switch from `JOIN spa_slot` to the direct columns; the joins to
`spa_therapist` / `spa_treatment` for names and price stay.

`schema.sql` is updated in place to the final shape (direct columns
`NOT NULL`, `slot_id` nullable, new tables, new `spa` columns).

## API & behavior

All new routes use `authenticateOrApiKey` and are scoped to
`req.property_id`, matching every existing spa route. Cross-property ids
`404`, never `403`.

### Hours & time off

```
GET    /api/spa/:spa_id/therapists/:id/hours       list rows, ordered by day_of_week, start_time
PUT    /api/spa/:spa_id/therapists/:id/hours       replace the full set (body: [{day_of_week, start_time, end_time}])
GET    /api/spa/:spa_id/therapists/:id/time-off    list, optional ?from&to
POST   /api/spa/:spa_id/therapists/:id/time-off    body: {start_date, end_date, reason?}
DELETE /api/spa/:spa_id/therapists/:id/time-off/:offId
```

`PUT .../hours` is a transactional delete-then-insert, exactly like
`setServicePeriods`. Validation: each row `day_of_week` 1–7, times via
`isValidTime`, `start_time < end_time`, and the therapist must belong to
the spa and property (`404` otherwise). Overlapping windows on the same
day are rejected with `400` — they would double-count candidate times.

### Availability

```
GET /api/spa/:spa_id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD&treatment_id=…[&therapist_id=…]
```

`from`, `to`, `treatment_id` required; `from <= to`; range capped at 31
days (`400` beyond). Treatment must be `active` and belong to the spa.

Computed in one query in the `searchAvailability` style:

- `r` = the spa's `slot_interval_minutes` and the treatment's
  `duration_mins`.
- `candidate_dates` = `generate_series(from, to)` filtered to dates not
  before "today" in the property's `timezone`.
- Per therapist (all `active` therapists of the spa, or the one given),
  `candidate_times` = for each `spa_therapist_hours` row whose
  `day_of_week` matches the date, `generate_series(start_time,
  end_time - duration, interval)`.
- Exclude dates covered by a `spa_therapist_time_off` row for that
  therapist.
- Exclude a candidate when a non-cancelled `spa_appointment` for that
  therapist on that date has `start_time < candidate + duration AND
  end_time > candidate`.
- For today, exclude candidates whose start is already past (compared in
  the property's timezone — `AT TIME ZONE p.timezone`, not the process
  TZ; see `addDaysUTC`'s comment in `spa.js` for why the process TZ is
  not trusted).

Response (grouped like restaurant's, but naming who is free):

```json
[
  { "date": "2026-09-02",
    "slots": [
      { "time": "10:00", "therapists": [{ "id": "…", "name": "Omar" }] },
      { "time": "10:15", "therapists": [{ "id": "…", "name": "Omar" }] }
    ] }
]
```

Dates with no free slots are omitted, same as restaurant.

The legacy `spa_slot` rows are **not** consulted here. A spa is either
hours-driven (has `spa_therapist_hours` rows) or slot-driven (Pirates
Bight today); mixing them on one therapist is unsupported and not
validated against — documented, not enforced, matching how the project
generally trusts staff-side configuration.

### Create appointment

`POST /api/spa/:spa_id/appointments` body, new form:

```json
{ "treatment_id": "…", "therapist_id": "…", "date": "2026-09-02", "time": "10:15",
  "contact_name": "…", "contact_email": "…", "contact_phone": "…", "notes": "…",
  "guest_id": "…", "clerk_user_id": "…" }
```

- Required: `treatment_id`, `date`, `time`, `contact_name`. `therapist_id`
  optional — if omitted, the server picks the free therapist with the
  lowest `name` (deterministic, no cleverness); `409` if none is free.
- If `slot_id` is present instead, the existing legacy path runs
  unchanged except that it now also fills the five direct columns from
  the slot row. Sending both `slot_id` and `treatment_id` is `400`.
- In a transaction: `SELECT id FROM spa_therapist WHERE id = $1 … FOR
  UPDATE` serialises concurrent bookings for the same barber (the same
  role the `UNIQUE` on `spa_slot` played before); then verify the
  candidate is within an hours window, not on a time-off day, not in the
  past, and has no overlapping non-cancelled appointment. Any failure
  `409 { error: 'Time is not available' }`. `end_time = time +
  duration_mins`.
- Insert with the direct columns; `slot_id = NULL`.
- After `COMMIT`: existing Ably publishes unchanged (`toLiveSpaBooking`
  now reads `appointment_date`/`start_time` instead of the slot join),
  then `sendAppointmentConfirmation(...)` if `contact_email` is set and
  Resend is configured. Its returned id is written to
  `confirmation_resend_email_id` in a follow-up `UPDATE`; failure is
  logged and swallowed, the 201 is not affected.

### Update appointment

`PUT /:spa_id/appointments/:id` is unchanged in shape. When the update
transitions `status` to `'cancelled'` and the row has `contact_email`,
`sendAppointmentCancellation(...)` is fired after the Ably publish, same
fire-and-forget rule.

### Emails (`src/lib/resend.js`)

Two new exports beside `sendReply`, same HTML/text builder style:

- `sendAppointmentConfirmation(appointment, spa, propertyName)` —
  `from: "${propertyName} via Forge <bookings@hotal.forge-build.co.uk>"`,
  `to: contact_email`, `replyTo: spa.contact_email` when set, subject
  `Booking confirmed — {treatment_name}, {D Mon YYYY} at {HH:MM}`. Body:
  treatment, barber, date/time, duration, price in the property currency,
  spa `address` and `phone`, and a line telling the customer to call to
  change or cancel (there is no self-service link — see Non-goals).
- `sendAppointmentCancellation(...)` — same shape, subject
  `Booking cancelled — …`.

`bookings@` on the already-verified `hotal.forge-build.co.uk` domain
needs no new Resend setup. No new env vars.

### Reads

`listAppointments`, `getAppointment`, `listAppointmentsForProperty` drop
`JOIN spa_slot ss` and select `sa.appointment_date`, `sa.start_time`,
`sa.end_time` directly, joining `spa_therapist`/`spa_treatment` via
`sa.therapist_id`/`sa.treatment_id`. Existing `date`/`status`/`guest_id`/
`clerk_user_id` filters keep working; add `therapist_id`.

### MCP (`mcp-server/tools.js`)

- New `search_spa_availability` → `GET /availability`.
- New `set_spa_therapist_hours` → `PUT .../hours`.
- `create_spa_appointment` input schema gains `treatment_id`,
  `therapist_id`, `date`, `time`; `slot_id` becomes optional.
- `list_spa_appointments` gains `therapist_id`.

### Swagger

`src/docs/swagger.js` updated for the new paths, the new appointment
body, and the response shape of `/availability`.

## Seed — Bedford Barber Co

New `src/db/seed-spa-bedford-barber.sql`, additive `INSERT`s chained with
`WITH … RETURNING`, safe against a populated database:

- **Property**: `Bedford Barber Co`, currency `GBP`, timezone
  `Europe/London` (both the column defaults). `api_key` is left NULL in
  the seed; mint it with `POST /api/property/api-key/rotate` once a Clerk
  org is linked, or set it directly in SQL before handing it to the site.
  (If `seed-property-bedford-barber.sql` from
  `2026-08-30-general-inquiries-design.md` has already been run, this
  seed reuses that property by name instead of inserting a second one.)
- **Spa**: `Bedford Barber Co`, phone `07429 153 339`, address
  `20C Miller Rd, Bedford MK42 9NZ`, `slot_interval_minutes = 15`,
  `contact_email` left for Omar to supply.
- **Treatments** (price from the client brief; durations are assumptions
  to confirm with Omar — Booksy's listing has the real ones):

  | Service | Price | Duration (assumed) |
  |---|---|---|
  | Haircut | £20 | 30 |
  | Skin Fade | £25 | 30 |
  | Haircut + Beard | £25 | 45 |
  | Skin Fade + Beard | £30 | 45 |
  | Beard Trim | £8 | 15 |
  | Wet Shave + Foam Steam | £15 | 30 |
  | Kids Haircut (under 12) | £15 | 30 |
  | Kids Skin Fade (under 12) | £20 | 30 |
  | Senior Citizens | £10 | 30 |

- **Therapist**: `Omar`.
- **Hours** (from the client brief; Tue has no row):

  | ISO day | Window |
  |---|---|
  | 1 Mon | 10:00–20:00 |
  | 3 Wed | 10:00–20:00 |
  | 4 Thu | 10:00–20:00 |
  | 5 Fri | 10:00–20:00 |
  | 6 Sat | 09:00–18:00 |
  | 7 Sun | 11:30–16:00 |

No seeded appointments or time off.

## Migration & rollout

Non-destructive, same convention as the restaurant/spa scoping
migrations. New `migrate-2026-08-30-spa-computed-availability.sql`:

1. `CREATE TABLE IF NOT EXISTS spa_therapist_hours …`,
   `spa_therapist_time_off …` + indexes.
2. `ALTER TABLE spa ADD COLUMN IF NOT EXISTS slot_interval_minutes …,
   contact_email …, address …`.
3. `ALTER TABLE spa_appointment` — add the six new columns nullable;
   `ALTER COLUMN slot_id DROP NOT NULL`.
4. Backfill from slots:
   ```sql
   UPDATE spa_appointment sa SET
     treatment_id     = ss.treatment_id,
     therapist_id     = ss.therapist_id,
     appointment_date = ss.slot_date,
     start_time       = ss.slot_time,
     end_time         = ss.slot_time + (tr.duration_mins || ' minutes')::interval
   FROM spa_slot ss JOIN spa_treatment tr ON tr.id = ss.treatment_id
   WHERE ss.id = sa.slot_id AND sa.treatment_id IS NULL;
   ```
5. `SET NOT NULL` on the five direct columns.
6. `CREATE INDEX IF NOT EXISTS idx_spa_appointment_therapist_date …`.

Idempotent via `IF NOT EXISTS` and the `IS NULL` guard on the backfill.
Run local first, then production; Pirates Bight's 6 live appointments are
the backfill check. Then run `seed-spa-bedford-barber.sql`.

Deploy order matters slightly: the controller change that stops joining
`spa_slot` must ship *after* the migration has run on that database,
otherwise reads return nulls for `appointment_date`. Same two-step used
for restaurant scoping.

## Testing approach

No automated test framework — manual `curl` against `npm run dev` with
the Bedford Barber Co property key (`X-Api-Key`) and a staff token for a
second property for cross-property checks:

1. Run the migration locally. Confirm Pirates Bight's existing local
   appointments have `appointment_date`/`start_time`/`end_time` matching
   their slots, and `slot_id` is unchanged.
2. Run the seed. `GET /api/spa` with the Bedford key → one spa.
   `GET /:spa_id/treatments` → 9 rows. `GET /:spa_id/therapists/:omar/hours`
   → 6 rows, none for day 2.
3. `GET /availability?from=<next Mon>&to=<next Sun>&treatment_id=<Skin
   Fade + Beard>` → no Tuesday entry; Sunday's last slot is `15:15`
   (16:00 − 45 min); Saturday starts `09:00`.
4. `POST /appointments {treatment_id: Skin Fade + Beard, date: <Wed>,
   time: "10:15", contact_name, contact_email}` → `201`,
   `end_time = 11:00`. Re-run `/availability` → `10:00`, `10:15`,
   `10:30`, `10:45` are gone (overlap-aware), `11:00` present.
5. Same `POST` again → `409 Time is not available`. `time: "10:45"` →
   `409`. `time: "08:00"` (outside hours) → `409`. A Tuesday → `409`.
6. Two concurrent `POST`s for the same time (e.g. `xargs -P2`) → exactly
   one `201`, one `409` (the `FOR UPDATE` serialisation).
7. `POST .../time-off {start_date, end_date}` covering the Wednesday →
   `/availability` omits it; `DELETE` it → back.
8. Confirm the confirmation email arrived (Resend dashboard / inbox) and
   `confirmation_resend_email_id` is set. `PUT … {status: 'cancelled'}` →
   cancellation email; `/availability` shows the time free again.
9. `POST /appointments` with `slot_id` from a Pirates Bight slot (using
   that property's key) → `201` with the direct columns filled — legacy
   path intact. `GET /:spa_id/slots/search` still works.
10. Bedford key against a Pirates Bight `spa_id` → `404` everywhere.
11. `PUT .../hours` with two overlapping windows on one day → `400`; with
    `end_time <= start_time` → `400`.
12. MCP: `search_spa_availability` and `create_spa_appointment` (new
    form) via the `ota-dev` server round-trip.

## Consuming site (bedford-barber) — for reference, not in this repo

The site is static Astro (no adapter, no `src/pages/api`). To use this it
needs `@astrojs/vercel` with two `prerender = false` endpoints —
`GET /api/availability` and `POST /api/book` — that hold `OTA_API_KEY`
server-side and proxy to the routes above. The key must never reach the
browser. Rate-limit and honeypot the `POST` on the site side; OTA has no
per-key rate limiting (flagged in the inquiries spec too). Keep the
Booksy link live until reminders exist — that is the visible gap.
