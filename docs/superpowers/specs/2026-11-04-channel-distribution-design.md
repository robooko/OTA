# Channel distribution (rooms) — design

**Date:** 2026-11-04
**Status:** Design agreed in conversation; awaiting written-spec review
**Follows:** multi-property spec (2026-10-11), which listed "channel manager" as a separate follow-up

## Intent

OTA becomes the single source of truth for room inventory and rates, and keeps
every connected sales channel consistent with it. A booking taken anywhere
(direct, a channel) is reflected on every other channel quickly enough that the
last room is not sold twice; a rate or closure change made in OTA reaches every
channel without anyone editing them by hand.

The core is **channel-agnostic**. Adding Google, Channex, SiteMinder or anything
else later means writing one adapter, not touching the core. The first version
ships the core plus a built-in **test channel** so the whole loop is provable on
the Bloody Mary property with no external account.

Why the shape: real channels (Google Hotel Prices ARI, SiteMinder pmsXchange,
Channex) all speak roughly the same vocabulary — the OpenTravel ("OTA") message
families for inventory counts, rate amounts, availability restrictions and
reservations. The core is modelled on those concepts so adapters are mostly
translation.

## Goals

1. **Shared pool.** Every channel draws on the same real availability. Nothing
   is reserved per channel.
2. **Per-channel trims:** a *cap* (a channel never sees more than N rooms of a
   type on a date) and *stop-sell* (a channel sees 0). Trims only reduce what is
   advertised; they never reserve inventory.
3. **Outbound ARI:** for each channel, per mapped room type × rate per date:
   available count, nightly rate, stop-sell flag. Pushed as changes happen.
4. **Inbound reservations:** a channel can deliver a new / modified / cancelled
   reservation; OTA turns it into an OTA booking (or changes/cancels it),
   idempotently, then the new availability flows to every channel.
5. **Consistency check ("drift").** For any channel OTA can say, at any moment:
   what we would send now vs. what the channel last acknowledged, and what is
   failing. Anything stale is re-sent automatically. This is OTA's own version
   of Google's price-accuracy check.
6. **Pluggable adapters** behind one small interface; v1 ships the `test` adapter.

## Non-goals (v1)

- Real allotments / release dates (reserved blocks per channel).
- Different prices per channel (rate parity: every channel gets the same rate).
- New restriction types (min stay, closed-to-arrival/departure). Only stop-sell
  and caps. The data shape should leave room for them.
- Any real external adapter (Channex sandbox is the planned next phase; an
  OpenTravel XML adapter for Google/SiteMinder after a partner accepts us).
- Dashboard screens. API + MCP tools only, as usual.
- Content sync (photos, descriptions, amenities).

## Anti-goals

- **Overselling caused by OTA.** If the core is unsure whether a channel has
  current availability, it must surface that loudly (drift), never hide it.
- **Per-call-site hooks.** The core must not depend on every place that changes
  availability or rates remembering to notify it (there are already 7+ such
  places: bookings, cancels, payment expiry, overrides, room-type rates, rate
  plans, the horizon seeder). Missing one would silently desync a channel.
- A channel failure must never fail or roll back an OTA booking or edit.

## Constraints (from the codebase)

- Everything scoped by `property_id`; a channel belongs to one property.
- Availability is per **room** per date (`room_availability.is_available`), and
  `room_type_availability` (materialized view) counts per room type per date.
  Every booking already flips `is_available` (including `pending_payment`), and
  cancel/expiry releases it. **But** the view counts rooms regardless of
  `room.status`, while `createBooking` only books `active` rooms — so the sync
  computes its own count (`is_available` nights of **active** rooms only) and
  does not read `available_rooms` from the view (my call; leaves the view and its
  existing readers untouched).
- Nightly rate: `override_rate` (per room) → `room_type_rate.rate` → `room_type.base_rate`;
  rate plans apply `adjustment_pct` on top (`src/lib/ratePlans.js` `applyAdjustment`).
- Availability horizon is ~548 days (`availabilitySeeder.js`).
- Background work runs as in-process jobs started from `src/server.js`
  (`start…Job()` pattern).
- Multi-step writes in one transaction; after commit, refresh the view with
  `roomPayments.refreshAvailabilityView()`.
- New feature checklist from CLAUDE.md applies: dated migration + `schema.sql`,
  Swagger, MCP tools for every route, `scripts/check-channels.js` (refuses a
  remote DB), `check-mcp-coverage.js` passes. Live migration before push.

## How it works

### 1. Desired state, diffed — not events

The core never listens for individual changes. Instead, for a channel it can
always **compute the desired ARI grid** from current OTA data:

```
for each mapping (channel rate code → room_type_id [+ rate_plan_id]):
  for each date in [today, today + channel.horizon_days):
    available = min(rooms free that date for the room type, cap if any); 0 if stop-sell
    rate      = type-level night rate (room_type_rate.rate else base_rate),
                with the rate plan's adjustment applied if the mapping has one
    stop_sell = stop-sell trim covers this date
```

and compare it with a stored **last-sent snapshot** per channel (one row per
mapping × date: what we sent, when, and whether the channel acknowledged it).
The difference is exactly what to push. The drift check (goal 5) is the same
diff, reported instead of sent.

This makes every existing change path covered for free, including ones written
later, and makes recovery from any failure automatic: the next run re-diffs.

**Triggering:** a sync job runs on an interval (builder picks, ~1 minute) over
every active channel. Additionally, `refreshAvailabilityView()` (and the other
places that refresh the view) **nudges** an immediate sync for that property, so
a booking reaches channels in seconds rather than at the next tick. The nudge
is an optimisation only; correctness comes from the diff. Rate edits that don't
refresh the view are picked up by the interval. Builder decides whether to
route all refresh call sites through the one helper (recommended) and how to
de-duplicate concurrent syncs for the same channel (e.g. advisory lock).

**Per-room override rates are not advertised** (my call): channels get the
type-level rate. A per-room override is a staff tool for a specific room, and a
channel booking is for a room type, so OTA can't know in advance which room's
override would apply. Channel bookings are charged what the channel says (see
§4), so this never under-/over-charges the guest — it only means overrides
don't show on channels.

### 2. Data

Builder chooses exact column names/types; the shapes are:

- **`channel`** — `property_id`, `adapter` (`'test'` in v1), `name`,
  `status` (`active` | `paused`), `horizon_days` (default 365, max the
  availability horizon), `config` JSONB (adapter credentials/settings; never
  returned by the API in full — mask secrets).
- **Mappings** — `channel_id`, OTA `room_type_id`, optional `rate_plan_id`,
  and the channel's external room code + rate code. Unique per channel on the
  external codes. A room type with active rate plans should be mapped per plan;
  a room type without plans maps with `rate_plan_id` null (base rate).
- **Trims** — `channel_id`, `room_type_id` (null = all types),
  `date_from`, `date_to` (inclusive range is fine here — builder's call, but be
  explicit), `max_available` (null = no cap), `stop_sell` boolean.
- **Last-sent snapshot** — per `channel_id` × mapping × `date`: `available`,
  `rate`, `stop_sell`, `sent_at`, `ack` status (`pending` | `ok` | `failed`),
  last error. Rows older than today can be pruned.
- **Booking source** — on `booking`: nullable `channel_id` and `channel_ref`
  (the channel's reservation id), unique together. Null = direct, as today.
- **Inbound log** — every reservation message received, with its outcome
  (`created` | `modified` | `cancelled` | `duplicate` | `rejected` + reason).
  This is where overbook conflicts are visible.

### 3. Adapter interface

An adapter is a module in `src/lib/channels/<adapter>.js` registered in a small
map (same idea as `PROVIDERS` in `src/lib/integrations.js`). It implements:

- `push(channel, changes)` → per-change result (`ok` / `failed` + error). The
  core batches changes; the adapter formats and sends them. The core updates
  the snapshot from the results.
- `validateConfig(config)` → errors, used when a channel is created/updated.

Inbound is **adapter-driven, core-handled**: however a channel delivers
reservations (webhook, polling, test endpoint), the adapter normalises each one
and calls one core function, `receiveReservation(channel, reservation)`, with a
fixed normalised shape: `{ channel_ref, action: new|modify|cancel, room code,
rate code, check_in, check_out, guests, total_price, currency, guest {first_name,
last_name, email?, phone?} }`. Adapters that need a webhook route get one at
`/api/channels/:id/inbound` (no auth middleware; the adapter verifies the
request). v1's test adapter doesn't need it.

### 4. Inbound reservations

`receiveReservation` runs in one transaction:

- **Idempotent** on `(channel_id, channel_ref)`: a repeat `new` is logged as
  `duplicate` and returns the existing booking.
- **new:** map codes → room type (+ plan); find/create the guest by
  `(property_id, email)`; book a room of that type for the dates using the same
  room-picking and availability rules as `createBooking` (builder extracts the
  shared part of `createBooking` into `src/lib` rather than duplicating it).
  Status `confirmed`, no Stripe, `total_price` = the channel's total (the guest
  paid/pays the channel's price), `rate_plan_id` set from the mapping,
  `rate_plan_terms` null. No OTA guest emails (the channel sends its own — my
  call). Publish the usual Ably new-booking event so staff see it.
- **No room free (overbooking):** don't create anything; log `rejected` with
  the reason, return an error to the adapter (so a real channel gets a failure),
  and publish an Ably alert for staff. The next sync pushes 0 to every channel.
- **modify:** if dates/type/guests change, release the old nights and book the
  new ones in the same transaction; if the new stay can't be booked, keep the
  original booking unchanged and log `rejected`.
- **cancel:** cancel the OTA booking the same way `cancelBooking` does, minus
  Stripe (there's none), then the view refresh nudges a sync.
- **Who collects payment — both supported** (Robert's decision). The channel
  has a default `collect` (`hotel` | `channel`) in its settings; the normalised
  reservation carries an optional `collect` that overrides it (real channels
  say per reservation, e.g. Expedia Collect vs Hotel Collect).
  - `hotel`: nothing extra — the stay shows as owed on the folio and staff take
    payment at the desk as for any booking.
  - `channel`: in the same transaction, insert a `payment` row for the
    channel's total with `status = 'completed'` (the status `computeFolio`
    counts), `method` identifying the channel (e.g. `channel`, builder's
    call), `paid_at = now()`. The folio balance is then 0 for the stay, so
    check-out isn't blocked. On a channel **cancel**, mark that payment
    `refunded` (the channel handles the guest's money). On **modify** with a
    new total, adjust it to match.
  - Commission tracking is out of scope for v1.
- **Missing guest email** (some channels mask it): builder picks a stable
  placeholder derived from channel + ref so `guest.email NOT NULL` and the
  `(property_id, email)` uniqueness still work.

**Staff cancelling a channel booking in OTA** (my call): `DELETE /bookings/:id`
on a booking with a `channel_id` returns 409 ("cancel it on the channel")
unless `force: true`, because cancelling only in OTA would leave the guest
holding a reservation on the channel.

### 5. The test adapter

Behaves like a well-behaved channel with no network:

- `push` acknowledges every change and stores it, so the snapshot shows what
  "the channel" holds and the drift check reads clean after a sync.
- A **failure switch** in its `config` (e.g. `fail_pushes: true`) makes `push`
  return `failed`, to prove retries and drift reporting.
- `POST /api/channels/:id/test-reservations` (test adapter only, 404 for
  others) takes the normalised reservation shape and calls
  `receiveReservation`, so new / modify / cancel / duplicate / overbook can all
  be exercised end to end.

### 6. API (all staff-or-full-key, property-scoped; each gets an MCP tool)

- Channels: list, get, create, update (incl. pause/resume), delete
  (pausing is the normal off switch; delete only if it has no bookings — builder's call).

**Switching off never leaves stale counts on a channel** (my call):
- **Pause** first pushes `available 0` / stop-sell for every mapped date, then
  stops syncing. If that push fails, the channel stays in a visible
  `pausing` state (shown in drift) and the job keeps retrying it.
- **Removing a mapping** (via replace) and **deleting a channel** do the same
  close-out push for the affected mappings first.
- **Resume** is just a normal sync (the diff re-sends everything).
- **Inbound reservations from a paused channel are still accepted**: they were
  made against counts the channel already held, and rejecting them would leave
  guests with reservations OTA doesn't know about. They go through the normal
  rules, including the overbook rejection.
- Mappings: list / replace for a channel.
- Trims: list / create / delete for a channel.
- `POST /channels/:id/sync` — run a sync now, return what was pushed.
- `GET /channels/:id/drift` — the diff (desired vs last acknowledged), plus
  counts of `pending` / `failed` and the oldest failing date. Optional date range.
- `GET /channels/:id/inbound` — the inbound log.
- `POST /channels/:id/test-reservations` (test adapter only).
- `/channels/:id/inbound` webhook route — **only** if a v1 adapter needs it;
  otherwise leave it for the Channex phase. Webhook routes are MCP-excluded.

Bookings list/get should expose `channel_id` / `channel_ref` and allow filtering
by channel (builder decides the filter shape, consistent with the existing list).

## Success (how we know v1 works, on Bloody Mary)

1. Create a test channel, map its room types/plans, sync: drift is empty and the
   snapshot matches `room_type_availability` and the rate rules.
2. Book a room directly: within seconds the channel's count for those nights drops.
3. Change a room-type rate or a rate plan's adjustment: the next sync sends the
   new rate; drift shows it until then.
4. Add a cap and a stop-sell: the channel sees min(free, cap) and 0 respectively;
   direct booking is unaffected.
5. Send a test reservation: an OTA booking appears with `channel_id`/`channel_ref`;
   resending it is a no-op; cancelling it frees the nights; booking the last
   room twice yields one booking and one `rejected` log entry. A
   `collect: channel` reservation has a zero folio balance; a `collect: hotel`
   one shows the full stay as owed.
6. Turn on `fail_pushes`: drift reports failures; turn it off: the next sync
   clears them with no manual step.

`scripts/check-channels.js` covers these against the local DB.

## Left to the builder

Exact table/column names, sync interval, batching size, how concurrent syncs
are serialised, whether the snapshot stores one row per date or ranges, the
placeholder-email format, the bookings filter shape, MCP tool names, and
whether the inbound webhook route ships in v1.
