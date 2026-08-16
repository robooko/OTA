# Reservations realtime feed — Design

## Context

Companion to `docs/superpowers/specs/2026-08-16-reservations-feed-page-design.md`
in `ota-table-bookings`, which wires `@forgebuild/hotal-ui`'s
`<live-reservations-feed>` (already published, v0.9.0) into the Dashboard —
the reservations equivalent of the Event Inquiries feed built earlier this
session.

A companion session proposed a starting point: two Ably publish functions
(`publishNewReservation`/`publishReservationStatusChanged`) and a
`listPropertyReservations` query. Sanity-checked against this codebase's
established conventions before building, the same way the original
Event Inquiries backend spec sanity-checked its own companion-session
proposal:

- `updateReservation` is a single combined update endpoint (status, notes,
  and contact fields all via one `COALESCE(...)` UPDATE) — unlike orders,
  which has a dedicated status-only endpoint. Publishing
  `reservation-status-changed` unconditionally on every call, as proposed,
  would fire a false status-changed event on a plain notes edit. Fixed by
  comparing the row's status before and after the update, only publishing
  when it actually changed.
- `restaurant_reservation` has no `restaurant_id` column of its own (only
  `table_id`, resolved to a restaurant via `restaurant_table`), but
  `<live-reservations-feed>` needs `restaurant_id` on every published
  event to look up the restaurant's display name. Both call sites already
  have `restaurant_id` for free from `req.params.restaurant_id` (both
  routes are nested under `/:restaurant_id/reservations`), so the
  published payload is patched with it rather than adding a join.
- `property_id` and its index already exist on `restaurant_reservation`
  (`idx_restaurant_res_property`) — no schema change needed here, unlike
  the original `event_inquiry` table which needed one added.

Confirmed with the user: this pass covers only the new Dashboard feed
component (both the OTA backend changes and the `ota-table-bookings`
wiring) — it does **not** add realtime updates to the existing
per-restaurant `/reservations` staff page, which stays as-is.

## Goals

- `publishNewReservation`/`publishReservationStatusChanged` in
  `src/lib/ably.js`, publishing to the same per-property channel shape
  already used for inquiries/orders: `property:{property_id}:reservations`.
- Wire those into the existing `createReservation`/`updateReservation`
  controllers (both already fully built — this only adds the publish
  calls, no other behavior changes).
- New `GET /api/restaurant/reservations` — property-wide (all
  restaurants), the query the companion session proposed, `authenticate`
  (Clerk) only.
- New `GET /api/reservations/ably-auth` in `ota-table-bookings` (companion
  spec) needs a `property_id` to scope its token — already resolvable via
  the existing `GET /api/property/me`, no new endpoint needed for that
  part.

## Non-goals

- No realtime wiring on the existing `/reservations` staff page —
  confirmed with the user, out of scope for this pass.
- No `table_number` on realtime-published events — the initial REST fetch
  (`GET /api/restaurant/reservations`, which joins `restaurant_table`)
  includes it, but adding it to every publish would mean an extra query
  at publish time for a field the component already treats as optional
  (`{#if reservation.table_number}`). A reservation that arrives live
  will show without its table number until the next full reload; not
  worth the extra query for that gap.
- No filtering/pagination UI on the new endpoint beyond the `date`/
  `status` query params already in the proposed query and the `LIMIT 50`
  cap — the Dashboard feed only ever shows its `max-items` most recent
  anyway.

## API & behavior

```
GET  /api/restaurant/reservations   authenticate, property-wide, filters: date, status
```

`src/routes/restaurant.js` gains one line, alongside the existing
reservation routes (no path collision — this is a one-segment literal
path, the existing routes are two-segment `:restaurant_id/...`):

```js
router.get('/reservations', authenticate, ctrl.listPropertyReservations);
```

`src/controllers/restaurant.js` gains:

```js
async function listPropertyReservations(req, res, next) {
  try {
    const { date, status } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location, rt.restaurant_id
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rr.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    query += ' ORDER BY rr.created_at DESC LIMIT 50';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}
```

(As proposed by the companion session — the query itself needed no
changes, only the two fixes noted in Context, which live in
`createReservation`/`updateReservation` below, not here.)

`createReservation` gains one line, after the existing `COMMIT`, before
the response — same placement as `restaurantOrders.js`'s
`publishNewOrder`:

```js
    await client.query('COMMIT');
    publishNewReservation(req.property_id, { ...rows[0], restaurant_id }).catch(
      (err) => console.error('Ably publish failed:', err.message)
    );
    res.status(201).json(rows[0]);
```

(`restaurant_id` is already destructured from `req.params` at the top of
this function — reused here, not re-fetched.)

`updateReservation` changes shape slightly to read the prior status
first, so the publish can be conditional:

```js
async function updateReservation(req, res, next) {
  try {
    const { status, notes, contact_name, contact_email, contact_phone, metadata } = req.body;
    if (metadata !== undefined && !isValidMetadata(metadata)) {
      return res.status(400).json({ error: 'metadata must be a JSON object' });
    }

    const { rows: beforeRows } = await pool.query(
      'SELECT status FROM restaurant_reservation WHERE id = $1 AND property_id = $2',
      [req.params.id, req.property_id]
    );
    if (!beforeRows.length) return res.status(404).json({ error: 'Reservation not found' });
    const previousStatus = beforeRows[0].status;

    const { rows } = await pool.query(
      `UPDATE restaurant_reservation SET
         status        = COALESCE($1, status),
         notes         = COALESCE($2, notes),
         contact_name  = COALESCE($3, contact_name),
         contact_email = COALESCE($4, contact_email),
         contact_phone = COALESCE($5, contact_phone),
         metadata      = COALESCE($6::jsonb, metadata)
       WHERE id = $7 AND property_id = $8 RETURNING *`,
      [status, notes, contact_name, contact_email, contact_phone, metadata ?? null, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reservation not found' });

    if (status && status !== previousStatus) {
      publishReservationStatusChanged(rows[0].property_id, { ...rows[0], restaurant_id: req.params.restaurant_id }).catch(
        (err) => console.error('Ably publish failed:', err.message)
      );
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
}
```

One extra `SELECT` per update (to know the prior status) — negligible
cost, and the simplest correct way to make the publish conditional
without a trigger or a more invasive rewrite of the existing UPDATE.

## Ably publishing

`src/lib/ably.js` gains, alongside the existing three:

```js
async function publishNewReservation(propertyId, reservation) {
  if (!client) return; // no key configured -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:reservations`);
  await channel.publish('new-reservation', reservation);
}

async function publishReservationStatusChanged(propertyId, reservation) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:reservations`);
  await channel.publish('reservation-status-changed', reservation);
}
```

Both exported alongside the existing four. Reuses the
`property:{property_id}:reservations` channel name pattern (parallel to
`property:{property_id}:inquiries`) — a new channel, not shared with
inquiries, since they're unrelated event streams even though they share
a property scope.

## Testing approach

No automated test framework in this repo — manual `curl` checks against
a running `npm start`, plus the Ably dashboard/log for the publish side,
matching this codebase's established convention:

1. `POST /:restaurant_id/reservations` with a valid booking → `201`,
   confirm a `new-reservation` publish on `property:{id}:reservations`
   (Ably dashboard or `ably channels:log`), payload includes
   `restaurant_id` matching the URL param.
2. `PUT /:restaurant_id/reservations/:id` with `{"status": "cancelled"}`
   where the reservation was previously `"confirmed"` → `200`, confirm a
   `reservation-status-changed` publish with the new status.
3. `PUT` the same reservation again with only `{"notes": "..."}` (no
   `status` in the body) → `200`, confirm **no** publish happens — this
   is the fix from Context; a bare notes edit must not fire a false
   status-changed event.
4. `PUT` with `{"status": "confirmed"}` when the reservation is *already*
   `"confirmed"` → `200`, confirm no publish (value didn't actually
   change, even though the field was present in the body).
5. `GET /api/restaurant/reservations` with no auth → `401`. With a valid
   Clerk token → `200`, includes reservations across multiple
   restaurants under that property (not just one), each row has
   `table_number`/`seats`/`location`/`restaurant_id` from the join.
6. Same `GET` with `date`/`status` query params → results filtered
   accordingly.
7. `GET /api/restaurant/reservations` with a different property's Clerk
   token → does not include the first property's reservations, proving
   `property_id` scoping holds on the new route.
8. Temporarily unset `ABLY_API_KEY` → both `POST` and `PUT` from steps 1–2
   still succeed, only the publish is skipped (logged, not thrown) —
   same best-effort framing as every other publish in this codebase.
