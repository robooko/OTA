# OpenTravel channel + `hotal-channel` test OTA — design

Date: 6 Nov 2026. Builds on `2026-11-04-channel-distribution-design.md` (the
channel core: desired ARI diffed against a last-sent snapshot, adapters, and
`receiveReservation`). Read that first; this doc doesn't repeat it.

## Why

HOTAL's channel manager works, but only against the in-process `test`
adapter, which never leaves the server. Before a real partner (Google Hotel
Prices, SiteMinder, Expedia) will accept us we need to prove the whole loop
over the wire, on the industry standard, and we need a page that shows a hotel
owner how to connect a channel.

So we build two things:

1. An **`opentravel` adapter** in HOTAL that speaks OpenTravel (OTA) XML over
   SOAP, written to the standard, not to our test rig, so it is the adapter a
   real partner gets later.
2. **`hotal-channel`**, a small stand-in OTA: it receives HOTAL's prices,
   shows them on a public page like a bare-bones booking site, and sends
   bookings back to HOTAL.

Then we document the owner's side on `https://hotal.forge-build.co.uk/docs`.

## Goals

- **Prices out, over OpenTravel:** HOTAL pushes availability, stop-sell and
  nightly rates to `hotal-channel` as `OTA_HotelAvailNotifRQ` and
  `OTA_HotelRateAmountNotifRQ`; `hotal-channel` answers with the matching
  `…RS` (`<Success/>` or `<Errors>`). A non-success or HTTP failure marks those
  changes `failed` in the snapshot, so drift and retry work as they do today.
- **Bookings back, over OpenTravel:** `hotal-channel` sends
  `OTA_HotelResNotifRQ` to HOTAL; HOTAL answers `OTA_HotelResNotifRS` with its
  booking id as the confirmation. New, modify and cancel
  (`ResStatus="Commit" | "Modify" | "Cancel"`). An overbook or unknown code is
  an `<Errors>` response, so the OTA sees the failure.
- **The full loop is testable:** connect → map → sync → prices appear on
  `hotal-channel` → book there → booking appears in HOTAL → availability drops
  on `hotal-channel` → cancel → availability comes back.
- **Owner docs:** a Channels section on the HOTAL docs page, written for a
  hotel owner using the dashboard (Rooms › Channels), with screenshots taken
  from this rig.

## Non-goals

- Certification against any real partner, or partner-specific quirks
  (Google's own `Transaction` feed, SiteMinder's extra fields). The adapter
  follows OpenTravel 2015B-era messages; partner adapters can extend it.
- `hotal-channel` being a product: no payments, no accounts, no styling
  beyond clean and readable. It is a test rig with a public page.
- Multiple properties on `hotal-channel` beyond what falls out naturally
  (it keys everything by hotel code, so it can hold more than one, but the
  page only needs to work well for one).
- Firebase Hosting, Cloud Functions or the Blaze plan. Only Firestore is used.

## Anti-goals

- An adapter shaped around `hotal-channel`'s convenience. If the rig and the
  standard disagree, the rig changes.
- A test that passes without the network: every message in the loop must go
  over HTTPS between the two deployed systems.

## Constraints and decisions (Robert's)

- **Standard:** OpenTravel (OTA) XML messages.
- **Transport:** SOAP 1.1 over HTTPS with a WS-Security `UsernameToken`
  (plain `PasswordText`) in the header. (Proposed as a guess, accepted; it's
  what SiteMinder pmsXchange and most channel managers use.)
- **`hotal-channel` runs on Vercel.** The Google project `hotal-channel`
  supplies **Firestore only** (Robert: "we just want the google db"). The
  project is on the free Spark plan; keep it there. Firestore must be enabled
  (Native mode) on that project; region is the builder's call (`eur3` or
  `europe-west2`).
- **Docs audience:** a hotel owner connecting a channel in the dashboard, not
  an OTA developer.

## How it works

### HOTAL side (this repo, `OTA`)

**`src/lib/channels/opentravel.js`**, registered in `ADAPTERS`:

- `config`: `{ endpoint_url, username, password, hotel_code }`, plus
  `inbound_username` / `inbound_password` that the OTA must present when it
  calls us. `validateConfig` checks all are present and `endpoint_url` is
  `https://`. Secrets are masked by the API as for every channel config.
- `push(channel, changes)`: groups the change rows (one per mapping × date,
  from `desired.js`) into contiguous date runs with identical values per
  room code + rate code, and sends:
  - `OTA_HotelAvailNotifRQ` with one `AvailStatusMessage` per run:
    `BookingLimit` = available, `StatusApplicationControl`
    (`Start`, `End`, `InvTypeCode` = room code, `RatePlanCode` = rate code),
    and a `RestrictionStatus Status="Close"` when stop-sell (`"Open"`
    otherwise).
  - `OTA_HotelRateAmountNotifRQ` with one `RateAmountMessage` per run:
    `BaseByGuestAmt AmountAfterTax` = the nightly rate, `CurrencyCode` from
    the property.
  - `HotelCode` = `config.hotel_code` on both. Each request carries a unique
    `EchoToken` and `TimeStamp`.
  - Results map back to the original change rows: a change is `ok` only if
    the message carrying it got `<Success/>`. Batch size is the builder's
    call, keeping each request well under a size the OTA would reject.
- **Inbound:** `POST /api/channels/:id/inbound` (the route the 4 Nov design
  reserved). Mounted before `express.json()` with a raw/text parser for
  `text/xml` and `application/soap+xml`, no auth middleware. It:
  1. Loads the channel; 404 if missing or not `opentravel`.
  2. Verifies the WS-Security `UsernameToken` against
     `inbound_username`/`inbound_password` (constant-time compare). Failure →
     SOAP fault, HTTP 401 (or 500 with fault, builder's call per SOAP 1.1).
  3. Parses `OTA_HotelResNotifRQ`. Each `HotelReservation` is normalised to
     `receiveReservation`'s shape: `channel_ref` = the OTA's
     `UniqueID ID`, action from `ResStatus`, `InvTypeCode`/`RatePlanCode`,
     `TimeSpan Start/End`, guest counts, `Total AmountAfterTax` +
     `CurrencyCode`, `ResGuest` name/email/phone, and `collect` if present
     (builder's call on the OTA field; default to the channel's `collect`).
  4. Replies `OTA_HotelResNotifRS`: `<Success/>` and a `HotelReservationID`
     with HOTAL's booking id (`ResID_Type="14"`, or the builder's correct
     code) per reservation, or `<Errors>` per failure (overbook, unknown
     code, bad dates) — `receiveReservation` already logs the outcome.
  - Malformed XML or a message type it doesn't handle → SOAP fault, logged.
- **XML:** use one small, well-known parser/builder (e.g. `fast-xml-parser`)
  rather than string concatenation for parsing. Building may use templates if
  every value is escaped. No XXE: no external entity resolution.
- **Dashboard (`ota-table-bookings`, Rooms › Channels):** "OpenTravel" appears
  as an adapter choice when connecting a channel, with fields for the config
  above, and the channel's inbound URL shown so the owner can give it to the
  OTA. Existing mapping, sync, drift and inbound log UI is reused.
- MCP/Swagger: `create_channel` etc. accept the new adapter; the webhook route
  stays MCP-excluded, as the 4 Nov design says.

### `hotal-channel` (new repo, Vercel)

My call: **Astro** with the Vercel adapter (server output), like Robert's
other sites, in a new repo `C:\Users\robert\source\repos\hotal-channel`
(GitHub `robooko/hotal-channel`, private), deployed to Vercel. Domain is the
builder's call; `channel.hotal.forge-build.co.uk` or the `.vercel.app` URL.

- **Firestore access:** server-side only, with the Admin SDK and a service
  account key for the `hotal-channel` project stored as a Vercel env var
  (`FIREBASE_SERVICE_ACCOUNT`, JSON). Never shipped to the browser. Firestore
  security rules deny all client access.
- **Data (builder's shape):** per hotel code: room types (room code), rate
  plans (rate code), and one doc per room code × rate code × date with
  `available`, `stop_sell`, `rate`, `currency`, `updated_at`; reservations
  it has sent, with HOTAL's confirmation id and status; and a log of every
  message received and sent (type, time, outcome, raw XML) for debugging and
  docs screenshots.
- **`POST /api/opentravel`** — the SOAP endpoint HOTAL pushes to. Verifies
  the `UsernameToken` (`OTA_USERNAME`/`OTA_PASSWORD` env vars), handles
  `OTA_HotelAvailNotifRQ` and `OTA_HotelRateAmountNotifRQ` by writing the
  ranges into Firestore, and answers the `…RS`. Unknown message → `<Errors>`.
- **Public page `/`:** pick check-in and check-out, see each room × rate with
  whether it's bookable for the whole stay and the total (sum of nightly
  rates), and a calendar-ish grid of the next ~30 days so a push is visibly
  reflected. No client Firestore: the page is server-rendered on each load
  (a refresh shows the latest push). Plain, readable styling.
- **Booking:** a form (name, email, phone, guests) posts to the site's own
  server, which sends `OTA_HotelResNotifRQ` (`ResStatus="Commit"`) to HOTAL's
  inbound URL with WS-Security (`HOTAL_INBOUND_URL`,
  `HOTAL_INBOUND_USERNAME`, `HOTAL_INBOUND_PASSWORD`), stores the result and
  shows HOTAL's confirmation id or its error.
- **Reservations page `/reservations`:** lists what it booked, each with a
  Cancel button that sends `ResStatus="Cancel"`. Modify is exercised by a
  "change dates" action (builder's call on how simple).
- **Messages page `/messages`:** the log, newest first, raw XML expandable.
- The public pages are open (it's a test rig); the cancel/change actions sit
  behind a simple shared password (env var) so a passer-by can't cancel.

### Test

- **HOTAL unit/integration** (`scripts/check-channels.js` style, local DB):
  XML building for both notif messages from a set of change rows (including
  run grouping and stop-sell), parsing `OTA_HotelResNotifRQ` (new, modify,
  cancel, missing email), the inbound route's auth failure, and `<Errors>`
  responses for overbook and unknown codes. Fixtures are real OpenTravel
  sample messages.
- **End to end, deployed:** on a test property (Bloody Mary, as in the 4 Nov
  design, or a fresh one), run the full loop above against the deployed
  `hotal-channel`, plus: an overbook (book the last room on `hotal-channel`
  after it's sold directly, before the next sync) returns an error shown on
  `hotal-channel`; turning `hotal-channel`'s endpoint off (env var
  `OTA_REJECT=1`) makes drift report failures, and turning it back on clears
  them on the next sync. A Playwright script drives `hotal-channel`'s pages
  and checks HOTAL through its API.

### Docs (`ota-table-bookings/src/pages/docs.astro`)

A **Channels** section (or `/docs/channels` linked from it, if the page would
pass 200 lines), for an owner:

1. What a channel is and what HOTAL sends it (availability, prices, stop-sell)
   and gets back (bookings).
2. Connect one: Rooms › Channels › connect, choose OpenTravel, enter what the
   channel gave you, copy the inbound URL back to them.
3. Map rooms and rate plans to the channel's codes.
4. Sync, and how to read drift ("everything the channel has matches").
5. When a booking comes in: where it shows, who collects payment, what
   happens if there's no room (overbook), cancelling (on the channel, not in
   HOTAL).
6. Pause, caps and stop-sell.

Screenshots from the HOTAL dashboard and `hotal-channel` during the E2E run.
Plain owner language; no XML on the page.

## Calls settled after review (mine, check them)

- **Codes belong to the OTA.** `hotal-channel` defines its own room and rate
  codes (seeded per hotel code, shown on its page) and rejects pushes for
  codes it doesn't know, as a real OTA does. The owner maps HOTAL's room
  types to those codes.
- **Config masking and updates.** The channels controller today masks every
  config key except `fail_pushes`, and an update replaces the whole config.
  Change both: mask only secret keys (`password`, `inbound_password`), and
  merge config on update so editing the endpoint doesn't wipe the passwords.
- **Route order.** The inbound `POST /api/channels/:id/inbound` is registered
  on `app` before `app.use('/api/channels', express.json(...))` and the
  authenticated router; the existing staff `GET /:id/inbound` log stays.
- **Reject switch is a runtime toggle**, not an env var (an env var change
  means a Vercel redeploy): a setting in Firestore, flipped from the
  password-protected side of `hotal-channel`. The overbook test uses it to hold
  pushes back, then sells the last room directly in HOTAL, then books it on
  `hotal-channel`.
- **E2E runs on a fresh test property**, not Bloody Mary, since it hits
  production HOTAL.
- **Rates are after tax:** HOTAL has no tax on rooms, so `AmountAfterTax` is
  the room rate as stored.

## Left to the builder

- Firestore document layout and region; batch sizes; retry/backoff on push
  (the existing 60s sync already retries failed changes).
- Exact SOAP fault vs HTTP status conventions, and the correct OpenTravel
  `ResID_Type` codes.
- `hotal-channel`'s domain, styling details, and how modify is triggered.
- Whether the docs section stays on `docs.astro` or becomes its own page.

## Setup steps that need Robert

- Enable Firestore on `hotal-channel` (the builder can do it with `gcloud`
  as robooko7@gmail.com).
- A service account key for `hotal-channel` goes to Vercel as an env var
  (generated with `gcloud`, never pasted in chat).
- Pushing `main` on the OTA repo deploys HOTAL's API on Render, and
  `ota-table-bookings` deploys the dashboard and docs. Commit and push per
  each repo's own rules.
