# Restaurant reservations — Clerk customer linkage — Design

## Context

A restaurant customer logs into the restaurant's own website via Clerk (a
hosted auth provider) — entirely outside this PMS backend. That website's
own backend then needs to call this API on the customer's behalf: create a
reservation when they book, and later look up, edit, or cancel *their own*
reservation, without exposing the restaurant module's shared `X-Api-Key` to
the browser and without this backend needing to know anything about Clerk
sessions or tokens.

The restaurant website's backend is the trusted caller here (holds the API
key server-side, matching the "Vercel serverless proxy" pattern already
discussed for this project). This backend's job is narrower: let that
trusted caller find "this Clerk user's reservations" without having to
maintain its own separate mapping database.

This is a small, targeted addition on top of the restaurant availability
redesign (`2026-07-15-restaurant-availability-redesign-design.md`) — it does
not revisit any of that design's decisions.

## Goals

- Let a reservation be tagged with the Clerk user who made it.
- Let the restaurant website's backend (holding the API key) list "this
  customer's reservations" directly from this API, with no separate
  database of its own.
- Keep this self-contained to the restaurant module — no dependency on the
  property-scoped `guest` table or the staff JWT auth system.

## Non-goals (explicitly out of scope)

- Any actual Clerk SDK integration, webhook verification, or session
  handling in this backend — Clerk auth happens entirely on the restaurant
  website's side. This API never sees a Clerk token, only an opaque
  `clerk_user_id` string passed by an already-trusted caller.
- Linking through the existing `guest` table (`guest.clerk_user_id`). That
  table is `property_id`-scoped as part of the multi-property work; the
  restaurant module has no `property_id` yet (a separate, later phase per
  the multi-property design's phased rollout). Forcing that link now would
  require deciding which property owns a restaurant guest record ahead of
  that phase — deferred.
- Ownership enforcement inside this API. `PUT /reservations/:id` does not
  verify that a caller-supplied `clerk_user_id` matches the reservation's
  stored one. The API-key holder is already a fully trusted caller for
  every other write in this module (staff have always had blanket access);
  the restaurant website's backend is responsible for only calling this
  endpoint with a `reservation_id` it already confirmed belongs to its
  logged-in customer (via the new list-by-`clerk_user_id` filter below).
- A guest-facing login/JWT system of any kind in this backend. Rejected
  during brainstorming in favor of the Clerk-on-the-website approach above.

## Data model

Add one nullable column to `restaurant_reservation`:

```sql
ALTER TABLE restaurant_reservation
  ADD COLUMN clerk_user_id VARCHAR(100);

CREATE INDEX idx_restaurant_res_clerk_user ON restaurant_reservation(clerk_user_id);
```

Nullable because staff-created or walk-in reservations have no
Clerk-authenticated customer involved. No foreign key — this is a plain
opaque string, not a link to any other table.

## Endpoint changes

- **`POST /:restaurant_id/reservations`**: accepts an optional
  `clerk_user_id` string in the body alongside the existing fields
  (`reservation_date`, `start_time`, `location`, `guest_id`, `contact_name`,
  `contact_email`, `contact_phone`, `party_size`, `notes`); stored directly
  on the new row. No new validation — it's an opaque string, not parsed or
  format-checked. Doesn't affect the existing required-field checks,
  auto-assignment, or overlap logic in any way.
- **`GET /:restaurant_id/reservations`**: gains `clerk_user_id` as a new
  optional query filter, alongside the existing `date`/`status`/`guest_id`
  filters. This is what the restaurant website's backend calls (with the
  API key) after resolving its own Clerk session, to fetch "this customer's
  reservations."
- **`GET /:restaurant_id/reservations/:id`**, **`PUT /:restaurant_id/reservations/:id`**:
  unchanged. No ownership check added (see Non-goals).

## Error handling

No new error cases. `clerk_user_id` has no required-ness or format
validation; every existing 400/404/409/500 case in `createReservation`,
`listReservations`, `getReservation`, and `updateReservation` is unchanged.

## Testing approach

Manual `curl` checks, consistent with the rest of this project (no
automated test framework exists):

1. Create a reservation with `clerk_user_id: "user_abc"` → `201`, response
   includes it.
2. Create a second reservation with a different `clerk_user_id: "user_xyz"`.
3. `GET /:restaurant_id/reservations?clerk_user_id=user_abc` → returns only
   the first reservation, not the second.
4. `GET /:restaurant_id/reservations` with no filter → returns both
   (existing behavior unchanged).
5. Cancel the first via `PUT .../reservations/:id` with
   `{"status":"cancelled"}` → unchanged, still `200`, no ownership check
   blocks it regardless of `clerk_user_id`.
