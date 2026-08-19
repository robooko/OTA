# Hotel Booking API — Claude Code Instructions

## Project overview

Build a RESTful hotel booking backend using **Node.js (Express)** and **PostgreSQL**. The system manages guests, room types, rooms, availability, and bookings — modelled after the hospitality industry pattern used by platforms like SiteMinder.

---

## Tech stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** PostgreSQL
- **Libraries:** `pg`, `dotenv`, `cors`, `helmet`
- **Dev:** `nodemon`

---

## Database schema

Implement the following tables exactly. Use UUIDs as primary keys (`gen_random_uuid()`).

### `guest`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| first_name | VARCHAR(100) | NOT NULL |
| last_name | VARCHAR(100) | NOT NULL |
| email | VARCHAR(255) | NOT NULL, UNIQUE |
| phone | VARCHAR(30) | |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### `room_type`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | VARCHAR(100) | NOT NULL (e.g. Standard, Deluxe, Suite) |
| description | TEXT | |
| max_occupancy | INT | NOT NULL |
| base_rate | NUMERIC(10,2) | NOT NULL — default nightly rate |

### `room`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| room_type_id | UUID | FK → room_type |
| room_number | VARCHAR(10) | NOT NULL, UNIQUE |
| floor | INT | |
| status | VARCHAR(20) | DEFAULT 'active' — active / maintenance / inactive |

### `room_availability`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| room_id | UUID | FK → room |
| date | DATE | NOT NULL |
| is_available | BOOLEAN | DEFAULT true |
| override_rate | NUMERIC(10,2) | NULL = fall back to room_type_rate.rate, then room_type.base_rate |
| block_reason | VARCHAR(100) | e.g. maintenance, ota_hold, owner_block |

Add a UNIQUE constraint on `(room_id, date)`.

### `room_type_rate`

Dated nightly rates per room type (rate calendar). One row per date; a missing row falls back to `base_rate`; a per-room `room_availability.override_rate` outranks both.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| room_type_id | UUID | FK → room_type |
| date | DATE | NOT NULL |
| rate | NUMERIC(10,2) | NOT NULL |

Add a UNIQUE constraint on `(room_type_id, date)`.

### `booking`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| guest_id | UUID | FK → guest |
| room_id | UUID | FK → room |
| check_in | DATE | NOT NULL |
| check_out | DATE | NOT NULL |
| guests | INT | NOT NULL DEFAULT 1 |
| total_price | NUMERIC(10,2) | NOT NULL |
| status | VARCHAR(20) | DEFAULT 'confirmed' — confirmed / cancelled / checked_in / checked_out |
| created_at | TIMESTAMPTZ | DEFAULT now() |

### `payment`
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| booking_id | UUID | FK → booking |
| amount | NUMERIC(10,2) | NOT NULL |
| method | VARCHAR(30) | e.g. card, cash, bank_transfer |
| status | VARCHAR(20) | DEFAULT 'pending' — pending / completed / refunded |
| paid_at | TIMESTAMPTZ | |

### `room_type_availability` (materialised view)

Create this as a **materialised view** — not a table:

```sql
CREATE MATERIALIZED VIEW room_type_availability AS
SELECT
  r.room_type_id,
  ra.date,
  COUNT(*)                                                AS total_rooms,
  COUNT(*) FILTER (WHERE ra.is_available = true)          AS available_rooms,
  MIN(COALESCE(ra.override_rate, rtr.rate, rt.base_rate)) AS min_rate
FROM room_availability ra
JOIN room r         ON r.id  = ra.room_id
JOIN room_type rt   ON rt.id = r.room_type_id
LEFT JOIN room_type_rate rtr
       ON rtr.room_type_id = r.room_type_id
      AND rtr.date         = ra.date
GROUP BY r.room_type_id, ra.date;

CREATE UNIQUE INDEX ON room_type_availability (room_type_id, date);
```

Refresh this view whenever bookings or availability records change.

---

## Project structure

```
/
├── CLAUDE.md
├── .env
├── package.json
├── src/
│   ├── app.js              # Express setup, middleware
│   ├── server.js           # Entry point
│   ├── db/
│   │   ├── index.js        # pg Pool setup
│   │   └── schema.sql      # All CREATE TABLE / VIEW statements
│   ├── routes/
│   │   ├── guests.js
│   │   ├── rooms.js
│   │   ├── roomTypes.js
│   │   ├── availability.js
│   │   ├── bookings.js
│   │   └── payments.js
│   ├── controllers/
│   │   ├── guests.js
│   │   ├── rooms.js
│   │   ├── roomTypes.js
│   │   ├── availability.js
│   │   ├── bookings.js
│   │   └── payments.js
│   └── middleware/
│       ├── errorHandler.js
│       └── validate.js
```

---

## API endpoints

### Guests — `/api/guests`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List all guests |
| GET | `/:id` | Get guest by ID |
| POST | `/` | Create guest |
| PUT | `/:id` | Update guest |
| DELETE | `/:id` | Delete guest |

### Room types — `/api/room-types`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List all room types |
| GET | `/:id` | Get room type by ID |
| POST | `/` | Create room type |
| PUT | `/:id` | Update room type |
| GET | `/:id/rates` | List dated nightly rates (supports `?from=&to=`, `to` exclusive) |
| PUT | `/:id/rates` | Bulk set dated rates over ranges — `{ rates: [{ from, to, rate }] }`, `to` exclusive, `rate: null` clears back to base_rate |

### Rooms — `/api/rooms`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List all rooms (supports `?room_type_id=` filter) |
| GET | `/:id` | Get room by ID |
| POST | `/` | Create room |
| PUT | `/:id` | Update room |

### Availability — `/api/availability`
| Method | Path | Description |
|---|---|---|
| GET | `/rooms/:room_id` | Get availability for a room (supports `?from=&to=` date range) |
| GET | `/types` | Get `room_type_availability` summary (supports `?from=&to=&room_type_id=`) |
| GET | `/search` | Search available room types: `?check_in=&check_out=&guests=` |
| PUT | `/rooms/:room_id` | Bulk upsert availability rows for a room |
| POST | `/refresh` | Manually trigger `REFRESH MATERIALIZED VIEW CONCURRENTLY` |

### Bookings — `/api/bookings`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List bookings (supports `?status=`, `?guest_id=`, `?from=`, `?to=`) |
| GET | `/:id` | Get booking by ID (include guest and room details) |
| POST | `/` | Create booking — see logic below |
| PUT | `/:id` | Update booking (e.g. change status) |
| DELETE | `/:id` | Cancel booking — sets status to 'cancelled', restores availability |

### Payments — `/api/payments`
| Method | Path | Description |
|---|---|---|
| GET | `/booking/:booking_id` | List payments for a booking |
| POST | `/` | Record a payment |
| PUT | `/:id` | Update payment status |

---

## Booking creation logic

When `POST /api/bookings` is called:

1. Validate `check_in < check_out`
2. Check that the room exists and is active
3. Query `room_availability` — ensure `is_available = true` for **every date** in `[check_in, check_out)`. If any date is blocked, return `409 Conflict`.
4. Also check no overlapping confirmed booking exists for the same room.
5. Calculate `total_price`:
   - For each night, use the room's `override_rate` if set, else the room type's dated `room_type_rate.rate` for that night, else `room_type.base_rate`
   - Sum all nightly rates
6. Insert the booking record.
7. Update `room_availability` to set `is_available = false` for all dates in the range.
8. Refresh the materialised view.
9. Return the created booking.

All steps should run inside a **single database transaction**.

---

## Availability search query

`GET /api/availability/search?check_in=2026-06-01&check_out=2026-06-03&guests=2`

Should return room types where:
- `available_rooms > 0` for **every night** in the range
- `room_type.max_occupancy >= guests`

Use the materialised view for performance:

```sql
SELECT
  rta.room_type_id,
  rt.name,
  rt.description,
  rt.max_occupancy,
  MIN(rta.available_rooms) AS min_available,
  MIN(rta.min_rate)        AS from_rate
FROM room_type_availability rta
JOIN room_type rt ON rt.id = rta.room_type_id
WHERE rta.date >= $1
  AND rta.date <  $2
  AND rt.max_occupancy >= $3
GROUP BY rta.room_type_id, rt.name, rt.description, rt.max_occupancy
HAVING MIN(rta.available_rooms) > 0
ORDER BY from_rate ASC;
```

---

## Error handling

- All errors must be caught and passed to the Express `errorHandler` middleware
- Return consistent JSON: `{ error: "message", details?: "..." }`
- Use appropriate HTTP status codes:
  - `400` — validation failure
  - `404` — resource not found
  - `409` — conflict (e.g. room not available)
  - `500` — internal server error

---

## Environment variables (`.env`)

```
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/hotel_booking
```

---

## Additional notes

- All date parameters are `YYYY-MM-DD` format
- Check-in/out ranges are **exclusive of check_out date** (standard hotel convention)
- The materialised view should be refreshed with `CONCURRENTLY` to avoid locking
- Add database indexes on: `room_availability(room_id, date)`, `booking(room_id, check_in, check_out)`, `booking(guest_id)`
- Seed file (`src/db/seed.sql`) with sample room types and rooms would be helpful but is optional
