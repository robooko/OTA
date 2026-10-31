# Housekeeping — design

Date: 2026-10-31. Status: draft for approval. Scope: hotel **rooms only** (no berths).

## Why

Properties have no way to know which rooms are dirty, clean or ready, who cleaned them, how long it took, or how well. Booked extras (flowers, champagne, spa sets) need to be in the room on arrival and nobody is tracking that. The minibar is both an operational job (count, restock, charge) and a selling point on the booking site ("Deluxe Flex includes a minibar with…").

OTA provides the API and live events. Housekeeping staff use the existing staff mobile app (waitress/kitchen app), which Robert will extend. Back-office views (reports, settings) go in the dashboard later; this spec is the API.

## Goals

1. **Room readiness.** Every room has a housekeeping state: `dirty → cleaning → clean → ready` (ready = passed inspection). Checkout makes a room dirty. Check-in warns when the room isn't ready.
2. **Daily board.** A shared list of today's housekeeping jobs per property. Cleaners claim jobs themselves. Each job shows who last cleaned the room and who has been looking after the current guest's stay, so cleaners can keep "their" rooms and guests. It doesn't lock anyone out.
3. **Recorded cleans.** Each clean records the cleaner, start and finish times (time per room), comments, and whether sheets and towels were changed.
4. **Stayover rule.** Each property sets how often in-house guests get serviced and how often sheets are changed. Staff can override it for a room on a day (skip because the guest declined, or add an extra clean).
5. **Inspection.** Each property defines its own checklist items, each with a pass mark (e.g. "Vacuum/floor ≥ 4"). The inspector grades every item 1–5 and can add a comment and a photo per item. Any item below its pass mark fails the room. The fail goes straight back to the cleaner who did it, showing the exact item, score, comment and photo. They redo it, and it's inspected again.
6. **Scores.** The inspector's score and the guest's post-stay cleanliness rating are both credited to the cleaner. Reports give average minutes, inspection score and guest score per cleaner and per room.
7. **Arrival extras.** Booked extras that belong in the room appear on that room's arrival job as a checklist ("place Dom Pérignon ×1"). Each is ticked off when placed.
8. **Minibar.** Each room type has a minibar list, and a rate plan can have its own list that replaces it. Each item on a list is either **included** or **charged**, so the same item can be free on Flex and charged on Saver. The list is public so the booking site can market it. Housekeeping records what was used and restocks. Charged items go on the folio.

## Non-goals

- Berths / marina.
- Linen inventory, laundry counts, par levels. Linen is just "sheets changed / towels changed" on each clean.
- Staff rostering, shifts, pay.
- Defining permissions. That is `2026-10-31-permissions-design.md`, which ships first. This spec's routes use its gates: inspection takes `requirePermission('housekeeping.inspect')`; checklist items, stayover settings and minibar catalogue/list writes take `requirePermission('housekeeping.manage')`. Everything else on the board is open to any staff login.
- Dashboard UI and mobile app UI (Robert builds the app side).
- Minibar stock control (stockroom quantities, purchasing).

## Anti-goals (would make this a failure)

- A dirty room disappearing from availability or search. Housekeeping state is **not** availability: `room.status` and `room_availability` are untouched.
- A failed inspection that leaves the cleaner guessing what was wrong.
- Hard-blocking check-in. It's a warning the desk can override (`force: true`), the same pattern as the folio balance gate.
- Adding fields the caller could supply instead (see the "OTA holds minimal data" rule). Everything here is operational state that only OTA can own, which is fine.

## Decided

**Module.** Everything sits behind a new `housekeeping` entry in `property.enabled_modules`, like the other modules. Staff rail (Clerk bearer) for all write endpoints. The minibar list is also exposed on the site rail (API key) for the booking site.

**Identity.** Cleaners and inspectors are Clerk org members. Store `clerk_user_id` (and a display name snapshot), the same way spa therapists do.

**Housekeeping state on the room.** New column `room.housekeeping_status` (`dirty` | `cleaning` | `clean` | `ready`), default `ready`.
- Booking moves to `checked_out` → room `dirty`, and a checkout job is created for today.
- Cleaner starts a job → `cleaning`. Finishes → `clean`.
- Inspection pass → `ready`. Inspection fail → `dirty` again, and the job is reopened for the same cleaner (rework).
- Staff can set it by hand (e.g. mark a room dirty after a maintenance visit).

**Jobs.** One job per room per day per kind: `checkout` or `stayover` (plus `extra` for a manually added clean). Each job holds the booking it relates to (departing or staying guest), plus the arriving booking when there is one that day, so arrival extras and priority ("arrival today") show on it. Job lifecycle: `open → claimed → in_progress → done → passed | failed`. Failed goes back to `in_progress` on rework, and `skipped` is set by override. A job keeps its full history: each attempt's start/finish and each inspection.

**Stayover rule.** Two property settings: `hk_service_every_days` (null = no automatic stayover service) and `hk_linen_every_days`. A stayover job is due for an in-house booking on night *n* when *n* is a multiple of the service interval. The job shows "change sheets" when the linen interval is due. Overrides per room per date: `skip` or `clean` (adds one). The cleaner still records what they actually did.

**Board.** `GET` today's board (or a given date) for the property. It lists jobs with room number, floor, kind, state, claimed-by, departing/arriving guest names, arrival time if known, extras to place, the minibar list, the last cleaner of the room, and the cleaner who has handled most of the current stay. Ordered with arrivals-today-and-dirty first.

**Inspection checklist.** Property-level list of items: name, pass mark (1–5), sort order, active/archived. An inspection stores a score per item, plus optional comment and photo per item. The overall score is the average. It fails if any item is under its pass mark. Archiving an item never rewrites old inspections (scores snapshot the item name and pass mark).

**Fail alert.** On fail, publish an Ably event on the property channel addressed to the cleaner's `clerk_user_id`. The event carries the failed items (name, score, pass mark, comment, photo URL). The app shows it and filters to the signed-in user.

**Guest cleanliness rating.** Add a 1–5 cleanliness rating to the existing post-stay review request email (`reviewRequester`) for room bookings. Each star is a one-click link to a public OTA endpoint that records it, and the existing Google review link stays. The rating is credited to the cleaner of the last passed checkout job on that room before the guest's check-in. Credit for stayover cleans during the stay is spread across their cleaners. (Builder: weighting is your call, documented in code.)

**Arrival extras.** New `extra.place_in_room` boolean (default false). On a job with an arriving booking, list that booking's `booking_extra` rows where the extra is `place_in_room`. Add `placed_at` and `placed_by` to `booking_extra`. The cleaner or anyone else ticks them.

**Minibar.**
- Catalogue: `minibar_item` per property (name, description, image URL, price, active).
- Lists: `minibar_list_item` rows of (room_type_id, rate_plan_id nullable, minibar_item_id, quantity, included). Rows with a rate plan **replace** the room type's list for that plan entirely (no merge).
- Public read: the list for a room type and rate plan, with included/charged and price, for the booking site.
- Recording: on any job, the cleaner records quantities used per item. Included items record at 0 so they're still counted for restock. Charged items become a folio line (new folio line type `minibar`) at the price at the time. If the guest has already checked out, the charge simply shows as an unpaid balance. Nothing blocks.
- Restock: recording usage also means "restocked to par". There's no separate restock step.

**Check-in warning.** `PUT /api/bookings/:id` to `checked_in` when the room isn't `ready` returns `409 { error: 'Room not ready', housekeeping_status }` unless `force: true`. This mirrors the existing folio gate at `src/controllers/bookings.js:399`.

**Arrival time.** Shown when the caller supplied `booking.metadata.arrival_time`, and left blank otherwise. *(Claude's call.)*

**Job sources.** The board builds itself from expected bookings: departures (`check_out = date`) produce a checkout job before the desk marks the booking `checked_out`, and in-house stays produce stayover jobs by the rule. Marking a booking `checked_out` makes the room dirty. A room with an arrival but no departure gets an `arrival` job when it has `place_in_room` extras to place. *(Claude's call.)*

**Live events.** Publish on a new Ably channel `property:{id}:housekeeping`, following the per-feature channel pattern (`property:{id}:orders` etc.): job created/claimed/started/finished, inspection passed/failed, room housekeeping status changed, extra placed, minibar recorded. Send full joined rows, not partial payloads (see the comment at `bookings.js:419`).

**Reports.** One endpoint over a date range giving, per cleaner and per room: jobs done, median and average minutes, average inspection score, first-time pass rate, average guest score.

## Left to the builder

- Exact table and column names, indexes, endpoint paths (follow existing route and controller style).
- How jobs get created: on demand when the board is fetched (idempotent with a unique key on room+date+kind), from a daily sweep like the seeders, or both.
- Where inspection photos are stored. Use the per-org storage if it fits, or a simpler upload path if it's connected for too few properties. Say which in the plan.
- Validation details, swagger docs, and the check scripts in `scripts/` following existing patterns.
- Migration file (`src/db/migrate-2026-..-housekeeping.sql`) plus `schema.sql`. The live migration runs **before** pushing (OTA main auto-deploys).

## Open

- **Phone notifications when the app is closed.** Ably events only reach an open app. True push (Expo or FCM) is out of scope unless the app already has it.
