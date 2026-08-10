# Public API for restaurant service periods — Design

## Context

`docs/superpowers/specs/2026-07-19-restaurant-service-periods-design.md` introduced the `service_period` table (a restaurant's bookable time windows, e.g. lunch/dinner) but explicitly scoped out any API to manage it: "No API CRUD for `service_period` rows — seed data only... no consumer currently needs to manage these dynamically via the API." That assumption no longer holds — a consuming project (a separate repo) needs to set a restaurant's service hours through the public API, and currently cannot: `service_period` rows only ever get created by seed SQL files run directly against the database.

The practical effect: any restaurant created through `POST /api/restaurant` (rather than seeded) has zero `service_period` rows, so `POST /:restaurant_id/reservations` always fails with `400 "start_time is outside service hours"`, for every time, with no way to fix it short of direct SQL access. Confirmed live: of the 15 restaurants currently under the FORGE property, the 6 seeded via SQL (BBYC, Barry, Betula, Bimini, Bonito, Pirates Bight) have valid periods and work; the other 8, created via the API itself, have none and are permanently broken for reservations.

## Goals

- Let a caller read and set a restaurant's `service_period` rows through the API.
- Keep the existing seed-data restaurants and the existing reservation/availability-search logic (both already query `service_period` by `restaurant_id`) completely unchanged.

## Non-goals

- `restaurant_seasonal_closure` (a separate table with the same "seed-only" gap) is out of scope — the reported problem is specifically about service hours, not seasonal closures. A similar follow-up may be needed there later, but isn't part of this change.
- No overlap validation between periods in the same request — consistent with the original design's rationale for seed data (not a correctness or safety issue; overlapping windows just mean some candidate reservation times get computed by more than one period).
- No migration — `service_period` already exists in `schema.sql`; this change only adds routes and controller functions on top of it.

## Endpoints

Added to the existing `src/routes/restaurant.js` / `src/controllers/restaurant.js` pair, alongside the sibling `Tables` resource:

```
GET /api/restaurant/:restaurant_id/service-periods
PUT /api/restaurant/:restaurant_id/service-periods
```

Both use `authenticate` only — no `requireRole` — matching every other restaurant/table CRUD route today (`createRestaurant`, `updateRestaurant`, `createTable`, `updateTable` are all staff-level, not admin-only). Both 404 with `{"error":"Restaurant not found"}` if `restaurant_id` doesn't exist or belongs to a different property — the same check `listTables`/`createTable` already perform (`SELECT id FROM restaurant WHERE id = $1 AND property_id = $2`).

**`GET`**: returns the restaurant's current periods, ordered by `start_time`:
```sql
SELECT id, label, start_time, end_time FROM service_period WHERE restaurant_id = $1 ORDER BY start_time
```

**`PUT`**: replaces the entire set of periods for that restaurant in one call — a caller sends the full list it wants, not incremental edits:

```
Request body:  { "periods": [ { "label": "Lunch", "start_time": "11:30", "end_time": "14:30" }, { "label": "Dinner", "start_time": "17:30", "end_time": "21:30" } ] }
Response:      200, the new array of period rows (same shape as GET)
```

`label` is optional (nullable, matches the column). `start_time`/`end_time` are required, validated with the existing `isValidTime` (`HH:MM`, already used by reservation creation), and `start_time < end_time` is checked per-period at the app level — a clean `400` instead of letting an invalid pair reach the DB's `CHECK (start_time < end_time)` constraint as a raw SQL error. `periods: []` is valid and clears all hours — a legitimate state (the restaurant becomes temporarily unbookable), not an error.

Implementation runs in a single transaction (`client.query('BEGIN')` ... `COMMIT`, same pattern `createReservation`/`createBooking` already use): delete every existing `service_period` row for the restaurant, then insert the new set, so there's never a window where the restaurant has partial or zero periods due to a mid-request failure.

```js
async function listServicePeriods(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const restaurantRes = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const { rows } = await pool.query(
      'SELECT id, label, start_time, end_time FROM service_period WHERE restaurant_id = $1 ORDER BY start_time',
      [restaurant_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function setServicePeriods(req, res, next) {
  const { restaurant_id } = req.params;
  const { periods } = req.body;

  if (!Array.isArray(periods)) {
    return res.status(400).json({ error: 'periods must be an array' });
  }
  for (const p of periods) {
    if (!p.start_time || !p.end_time) {
      return res.status(400).json({ error: 'Each period requires start_time and end_time' });
    }
    if (!isValidTime(p.start_time) || !isValidTime(p.end_time)) {
      return res.status(400).json({ error: 'Invalid time format, use HH:MM' });
    }
    if (p.start_time >= p.end_time) {
      return res.status(400).json({ error: 'Each period\'s start_time must be before its end_time' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const restaurantRes = await client.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!restaurantRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    await client.query('DELETE FROM service_period WHERE restaurant_id = $1', [restaurant_id]);

    const inserted = [];
    for (const p of periods) {
      const { rows } = await client.query(
        `INSERT INTO service_period (property_id, restaurant_id, label, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, label, start_time, end_time`,
        [req.property_id, restaurant_id, p.label ?? null, p.start_time, p.end_time]
      );
      inserted.push(rows[0]);
    }

    await client.query('COMMIT');
    res.json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```

Routes (inserted after the `Tables` section, before `Availability`, in `src/routes/restaurant.js`):

```js
router.get('/:restaurant_id/service-periods', authenticate, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticate, ctrl.setServicePeriods);
```

## Swagger

New `Restaurant`-tagged paths `/api/restaurant/{restaurant_id}/service-periods` (`get` and `put`), documented the same way as the neighboring `/tables` path.

## Testing approach

No automated test framework in this project — manual `curl` checks against a running `npm run dev` server, then repeated against live:

1. `GET` on a restaurant with no periods (a newly created one) → `200 []`.
2. `PUT` with two periods (lunch/dinner) → `200`, array of 2 rows with generated `id`s.
3. `GET` again → same 2 rows, confirming persistence.
4. `POST /:restaurant_id/reservations` with a `start_time` inside one of the new windows → `201` (previously impossible for an API-created restaurant).
5. `PUT` again with a different, single period → `200`, array of 1 row; a follow-up `GET` confirms the old 2 rows are gone, not merged.
6. `PUT` with `periods: []` → `200 []`; a follow-up reservation attempt → `400 "start_time is outside service hours"` (restaurant now has no bookable windows).
7. Error cases: `PUT` with a non-array `periods` → `400`; a period with `start_time >= end_time` → `400`; a period with a malformed time (e.g. `"25:00"`) → `400`; `restaurant_id` that doesn't exist or belongs to another property → `404` on both `GET` and `PUT`.
8. Regression: run an existing seeded restaurant's (e.g. Bonito's) availability search and reservation creation before and after this change — confirm identical behavior (these code paths are untouched).
9. Repeat steps 1–4 against production once local passes.
