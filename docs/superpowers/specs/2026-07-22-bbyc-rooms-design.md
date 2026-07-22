# BBYC Rooms Design

## Context

BBYC (Bora Bora Yacht Club) already exists as a `restaurant` (added in `seed-restaurant-bbyc.sql`), but the restaurant module has no `property_id` link — it's unscoped, out of scope for the multi-property Phase 1 plan. Hotel rooms and bookings, however, are strictly scoped to a `property`: `room_type`, `room`, and `booking` all carry `property_id`. There is currently no `property` row for BBYC at all, so it can't have bookable rooms.

This adds BBYC as a new `property` with bungalow-style accommodation, following the same pattern Ocean View Resort already uses (the only property with room data seeded so far — Mountain Lodge and Bonito exist as properties but have zero rooms). This mirrors Bonito's existing situation: a property and an unscoped restaurant sharing a name with no formal link between them.

**Goal:** BBYC becomes a fourth bookable property — with its own admin login, one `Bungalow` room type, 6 rooms, and enough availability to actually book a stay through the live API today.

## Data model

New file: `src/db/seed-bbyc-rooms.sql`, additive only (no schema changes), bundling everything in one script — mirrors how `seed-restaurant-bbyc.sql` bundles restaurant + tables + service periods in one file.

**Property**
| id | name | status |
|---|---|---|
| `e1000000-0000-0000-0000-000000000004` | BBYC | active |

Continues the `e1...00N` id series from `seed.sql` (`...001` Ocean View Resort, `...002` Mountain Lodge, `...003` Bonito).

**Bootstrap admin** (`api_user`, matches the per-property admin pattern in `seed.sql`)
| id | property_id | name | email | password | role |
|---|---|---|---|---|---|
| `f4000000-0000-0000-0000-000000000001` | (BBYC property id) | BBYC Admin | `admin@bbyc.example.com` | `changeme123` | admin |

Password hash: reuse the exact bcrypt hash already in `seed.sql` for the other bootstrap admins (`$2b$12$AeG.yVLwhNPTxp2WeowJ8OZ6J9m4Kyn/sasVTECO/nHbxaBXMzycu`), which is a hash of `changeme123` — no new hash needs generating.

**Room type**
| id | name | max_occupancy | base_rate |
|---|---|---|---|
| `a4000000-0000-0000-0000-000000000001` | Bungalow | 2 | 450.00 |

**Rooms** — 6 units, `floor` left `NULL` (no floor concept for a bungalow), all `status = 'active'`:
| id | room_number |
|---|---|
| `b4000000-0000-0000-0000-000000000001` | B1 |
| `b4000000-0000-0000-0000-000000000002` | B2 |
| `b4000000-0000-0000-0000-000000000003` | B3 |
| `b4000000-0000-0000-0000-000000000004` | B4 |
| `b4000000-0000-0000-0000-000000000005` | B5 |
| `b4000000-0000-0000-0000-000000000006` | B6 |

**Availability** — for each of the 6 rooms, one `room_availability` row per date in `2026-07-22`–`2026-10-20` (90 days from today), `is_available = true`, no `override_rate`. Generated via `generate_series` scoped to `WHERE r.property_id = <bbyc property id>` (not the unscoped "all active rooms" query `seed.sql` uses, to avoid touching other properties' rooms).

This diverges intentionally from the rest of the seed data, whose availability window (`2026-04-03`–`2026-07-01`) is already in the past relative to today (2026-07-22) — a pre-existing staleness issue in `seed.sql`, out of scope to fix here. BBYC's window is chosen so its rooms are actually bookable through the live API right now.

## Rollout

No schema change, so no destructive/non-destructive tradeoff like the `booking.metadata` migration — this is pure additive `INSERT`.

- **Local**: full reset + reseed, adding `seed-bbyc-rooms.sql` to the existing file list (after `schema.sql`, order otherwise doesn't matter since it has no dependency on `seed.sql`'s data).
- **otadb (live)**: run `seed-bbyc-rooms.sql` directly as a plain additive script against the already-populated database — same precedent as how `seed-restaurant-bbyc.sql` was rolled out. No code changes, so no git push/redeploy is required for this to take effect live. The seed file is still committed to the repo for reproducibility of future fresh resets.
- Not safely re-runnable (would create a duplicate `BBYC` property) — same one-time-script caveat as `seed-restaurant-bbyc.sql`.

## Verification

1. Local reset + reseed including the new file.
2. Log in as `admin@bbyc.example.com` / `changeme123`.
3. `GET /api/room-types` and `GET /api/rooms` — confirm `Bungalow` and the 6 `B1`–`B6` rooms appear, scoped to the BBYC property.
4. `GET /api/availability/search?check_in=...&check_out=...&guests=2` for a date inside the seeded window — confirm BBYC's Bungalow type is returned with `min_available: 6`.
5. `POST /api/bookings` for a 2-night stay, including `metadata: { pickup_location: ... }` (exercising the field just shipped) — confirm `201` and `total_price` of `900.00`.
6. Repeat the additive seed run against `otadb`, then repeat steps 2–5 against the live service.
