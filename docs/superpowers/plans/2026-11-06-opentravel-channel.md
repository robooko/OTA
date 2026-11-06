# OpenTravel channel + hotal-channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HOTAL pushes availability and rates to a stand-in OTA (`hotal-channel`) over OpenTravel SOAP, takes bookings back the same way, and the owner's side is documented.

**Architecture:** A new `opentravel` adapter in `OTA/src/lib/channels` turns desired-ARI change rows into `OTA_HotelAvailNotifRQ` / `OTA_HotelRateAmountNotifRQ`; a new unauthenticated `POST /api/channels/:id/inbound` takes `OTA_HotelResNotifRQ` into the existing `receiveReservation`. `hotal-channel` is a new Astro (server output) site on Vercel that stores what it receives in Firestore (Google project `hotal-channel`) and sends reservations back.

**Tech Stack:** Node 22 / Express 4 / Postgres (OTA), `fast-xml-parser` (both sides), Astro 5 + `@astrojs/vercel` + `firebase-admin` (hotal-channel), Playwright (E2E).

**Spec:** `OTA/docs/superpowers/specs/2026-11-06-opentravel-channel-design.md` (builds on `2026-11-04-channel-distribution-design.md`).

## Global Constraints

- Messages are OpenTravel XML (`xmlns="http://www.opentravel.org/OTA/2003/05"`, `Version="1.0"`), in a SOAP 1.1 envelope (`http://schemas.xmlsoap.org/soap/envelope/`), with a WS-Security `UsernameToken`, `PasswordText`, in the header (`http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd`).
- HTTPS only for `endpoint_url` / inbound URLs (localhost `http://` allowed only when `NODE_ENV !== 'production'`, for tests).
- `StatusApplicationControl` and `BaseByGuestAmts` date ranges: `Start` = first night, `End` = **last night, inclusive**. Reservation `TimeSpan`: `Start` = arrival, `End` = departure (check-out).
- XML parsing: `fast-xml-parser` with entity processing off (`processEntities: false` for DOCTYPE, no external entities). Building: template strings where every interpolated value goes through one `esc()` (`& < > " '`).
- Credentials compared in constant time (`crypto.timingSafeEqual` over SHA-256 digests).
- The Firebase service account key lives only in Vercel env `FIREBASE_SERVICE_ACCOUNT` (JSON) and the gitignored local `.env`; never in the repo, never sent to the browser. Firestore rules deny all client access. Firestore keeps to the free Spark plan; billing is not enabled.
- Channel config secrets (`password`, `inbound_password`) are masked as `***` by the API; all other keys returned as-is.
- No file over 200 lines (forge/HOTAL convention).
- The E2E runs on a fresh test property, never Bloody Mary or a real client.

## Review Focus

1. **A push for a code `hotal-channel` doesn't know** → it answers `<Errors>`, those changes go `failed`, drift shows them, nothing is written. Tested in Task 6.
2. **Guest name or email containing `& < > "`** → round-trips intact into the HOTAL booking (escaped on build, decoded on parse). Tested in Tasks 2 and 4.
3. **The same reservation sent twice** (double click, retry after timeout) → same `UniqueID`, one booking, second response still `<Success/>` with the same confirmation id. Tested in Task 4.
4. **`hotal-channel` unreachable, slow (>15s) or returning HTML** → `push` resolves `failed` for every change with a reason, never throws, sync job keeps running. Tested in Task 3.
5. **Inbound with wrong password, unknown channel id, or a non-`opentravel` channel** → SOAP fault (401 / 404), no log row claiming a booking, no booking. Tested in Task 4.

---

## Part A — HOTAL API (`C:\Users\robert\source\repos\OTA`)

Tests follow the repo's style: plain Node scripts with `node:assert/strict` under `scripts/`, run against the local DB (they refuse a remote `DATABASE_URL`). Pure-XML tests need no DB.

### Task 1: Channel config — mask only secrets, merge on update

**Files:**
- Modify: `src/controllers/channels.js:16` (masking), `:86-96` (update)
- Test: `scripts/check-channels.js` (append a section)

**Interfaces:**
- Produces: `SECRET_KEYS = ['password', 'inbound_password']` exported from `src/lib/channels/index.js`; GET returns every other config key unmasked; `PUT /api/channels/:id` with `config` merges into the stored config (`config || $5::jsonb`), and a value of `null` removes a key. `validateConfig` runs on the **merged** config.

- [ ] **Step 1: Write the failing test** — in `check-channels.js`: create a `test` channel with `config: { fail_pushes: true }`, PUT `config: {}` → the DB row's `config.fail_pushes` is still `true` (merge); PUT `config: { fail_pushes: null }` → key gone. (Task 3 adds the opentravel masking assertions: `endpoint_url` returned as-is, `password` as `***`, and a partial PUT keeping `password` in the DB.)
- [ ] **Step 2: Run** `node scripts/check-channels.js` → FAIL (today's update replaces config with `{}`).
- [ ] **Step 3: Implement** the mask using `SECRET_KEYS`, and change the update SQL to merge (`config = CASE WHEN $5::jsonb IS NULL THEN config ELSE jsonb_strip_nulls(config || $5::jsonb) END`), validating `{ ...ch.config, ...b.config }` with nulls removed.
- [ ] **Step 4: Run** `node scripts/check-channels.js` → passes.
- [ ] **Step 5: Commit** `Channels: mask only secret config keys, merge config on update`.

### Task 2: OpenTravel XML — build and parse (pure)

**Files:**
- Create: `src/lib/channels/opentravel/xml.js` (envelope, `esc`, WS-Security, parse helpers)
- Create: `src/lib/channels/opentravel/messages.js` (the four message types)
- Create: `scripts/fixtures/opentravel/` — `avail-rs-success.xml`, `rate-rs-errors.xml`, `res-notif-new.xml`, `res-notif-modify.xml`, `res-notif-cancel.xml`, `res-notif-no-email.xml`, `not-xml.html`
- Test: `scripts/check-opentravel.js` (new, no DB)
- Modify: `package.json` — add `fast-xml-parser` and `"check:opentravel": "node scripts/check-opentravel.js"`

**Interfaces:**
- Produces (from `messages.js`):
  - `groupRuns(changes) -> Run[]` where `Run = { room_code, rate_code, start, end, available, rate, stop_sell, changes }` — consecutive dates (no gap) with identical `available`/`rate`/`stop_sell` per room+rate collapse to one run; `end` inclusive; `changes` = the original rows.
  - `availNotifRQ({ hotelCode, runs, username, password, echoToken }) -> string` (full SOAP envelope)
  - `rateNotifRQ({ hotelCode, currency, runs, username, password, echoToken }) -> string`
  - `parseNotifRS(xml) -> { ok: boolean, error?: string }` — `ok` iff the body's `…RS` has `Success`; `error` from `Errors/Error` text or `ShortText`; a SOAP fault, non-XML, or wrong root → `{ ok: false, error }`.
  - `parseResNotifRQ(xml) -> { username, password, echoToken, reservations: Array<NormalisedReservation & { _uid: string }> } | { error }` — `NormalisedReservation` is `receiveReservation`'s shape (`src/lib/channels/reservations.js:3-6`); `ResStatus` `Commit|Book` → `new`, `Modify` → `modify`, `Cancel` → `cancel`; `channel_ref` = `UniqueID@ID`; `guests` = sum of `GuestCount@Count`; `total_price` = `Number(Total@AmountAfterTax)`; `currency` = `Total@CurrencyCode`.
  - `resNotifRS({ echoToken, results }) -> string` where `results = Array<{ channel_ref, booking_id?, error? }>`; all succeeded → `<Success/>` + one `HotelReservation` per result carrying `UniqueID ID=channel_ref` and `HotelReservationID ResID_Value=booking_id`; any failed → `<Errors>` with one `<Error Type="3" ShortText=reason>` per failure (success entries still listed).
  - `soapFault(code, message) -> string`
  - `availNotifRS`, `rateNotifRS` builders (used by hotal-channel's copy and by tests): `({ echoToken, error? }) -> string`.

- [ ] **Step 1: Write the failing tests** in `check-opentravel.js`:
  - `groupRuns` of DBL/BAR 1–3 Dec same values + 5 Dec → two runs, `end: '2026-12-03'` and a run 5–5; a value change on 2 Dec splits at 2 Dec.
  - `availNotifRQ` output parses back: `HotelCode="H1"`, `StatusApplicationControl Start="2026-12-01" End="2026-12-03" InvTypeCode="DBL" RatePlanCode="BAR"`, `BookingLimit="2"`, `RestrictionStatus Status="Open"`; stop-sell run → `Status="Close"`; `wsse:Username` = given username.
  - `rateNotifRQ` → `BaseByGuestAmt AmountAfterTax="120.00"`, `CurrencyCode="GBP"`.
  - `parseNotifRS(avail-rs-success)` → `{ ok: true }`; `parseNotifRS(rate-rs-errors)` → `ok: false`, `error` contains the fixture's error text; `parseNotifRS(not-xml.html)` → `ok: false`.
  - `parseResNotifRQ(res-notif-new)` → `action: 'new'`, `room_code: 'DBL'`, `check_in`/`check_out` from `TimeSpan`, `total_price: 360`, `guest.first_name: 'Anna & Co'` (fixture uses `&amp;`); `-modify` → `'modify'`; `-cancel` → `'cancel'`; `-no-email` → `guest.email === undefined`.
  - A body with `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>` → parse returns `{ error }` or leaves `&e;` unexpanded; never file contents.
  - `resNotifRS` with one ok and one `error: 'no room available'` → contains `<Errors>` and `ShortText="no room available"`.
- [ ] **Step 2: Run** `npm run check:opentravel` → FAIL (`Cannot find module`).
- [ ] **Step 3: Implement** `xml.js` (`esc`, `envelope({ username, password, body })`, `parse(xml)` with a shared `XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, processEntities: false })`, `bodyOf(parsed)`) and `messages.js` with the signatures above. Amounts formatted to 2 dp. `EchoToken` = `crypto.randomUUID()` when not given; `TimeStamp` = ISO now.
- [ ] **Step 4: Run** `npm run check:opentravel` → PASS.
- [ ] **Step 5: Commit** `OpenTravel: SOAP message builders and parsers`.

### Task 3: The `opentravel` adapter

**Files:**
- Create: `src/lib/channels/opentravel/index.js`
- Modify: `src/lib/channels/index.js` (register `opentravel: require('./opentravel')`)
- Test: `scripts/check-opentravel.js` (append; uses a local `http.createServer` stand-in on a random port)

**Interfaces:**
- Consumes: Task 2's `groupRuns`, `availNotifRQ`, `rateNotifRQ`, `parseNotifRS`.
- Produces: adapter `{ label: 'OpenTravel', validateConfig(config) -> string[], push(channel, changes) -> Promise<Array<{ ok, error? }>> }`. Required config keys: `endpoint_url`, `username`, `password`, `hotel_code`, `inbound_username`, `inbound_password`; unknown keys are errors. `push` reads `channel.currency` if present, else the property's currency (pass it in from `sync.js` if `channel` lacks it — check `syncChannel` and add a `currency` field to the loaded channel there).

- [ ] **Step 1: Write the failing tests** — stand-in server records request bodies and answers per scenario:
  - 3 changes (2 runs) → server receives exactly 1 avail + 1 rate request with `SOAPAction`/`Content-Type: text/xml; charset=utf-8`; both `<Success/>` → `[{ok:true}×3]`, in input order.
  - Rate request answers `<Errors>` → every change carried by it `{ ok: false, error: /rate/ }`; a change is ok only if **both** its avail and rate messages succeeded.
  - Server closed (unused port) → all `{ ok: false }`, no throw. Server delays 20s → all failed after the 15s timeout (`AbortSignal.timeout(15000)`); set the timeout via an exported constant so the test can lower it to 200ms.
  - Server answers 200 with HTML → all failed.
  - `validateConfig({})` lists all six missing keys; `endpoint_url: 'http://x'` in production → error.
  - Batch: 400 runs → split into requests of at most `MAX_RUNS = 200` runs each.
- [ ] **Step 2: Run** `npm run check:opentravel` → FAIL.
- [ ] **Step 3: Implement** `push`: `groupRuns`, chunk by `MAX_RUNS`, send avail and rate per chunk with global `fetch`, `parseNotifRS` each, then fold results back to change rows.
- [ ] **Step 3b: Add to `check-channels.js`:** create an opentravel channel with full config → GET has `endpoint_url: 'https://x.test/ota'` and `password: '***'`; PUT `config: { endpoint_url: 'https://y.test/ota' }` → DB row keeps the original `password`.
- [ ] **Step 4: Run** `npm run check:opentravel` and `node scripts/check-channels.js` → PASS.
- [ ] **Step 5: Commit** `Channels: OpenTravel adapter (AvailNotif + RateAmountNotif over SOAP)`.

### Task 4: Inbound `POST /api/channels/:id/inbound`

**Files:**
- Create: `src/controllers/channelInbound.js`
- Modify: `src/app.js` — before line 72: `app.post('/api/channels/:id/inbound', express.text({ type: ['text/xml', 'application/soap+xml', 'application/xml'], limit: '1mb' }), handleChannelInbound);`
- Modify: `scripts/check-mcp-coverage.js` EXCLUDE — add `/^\/api\/channels\/:p\/inbound$/` for POST only if the checker is method-aware; otherwise make sure the existing GET log still maps to its tool and add a comment
- Modify: Swagger doc for channels (wherever `82c5a00` added it) — document the route as SOAP, no auth
- Test: `scripts/check-channels.js` (append; uses `app` on a random port as the file already does)

**Interfaces:**
- Consumes: `parseResNotifRQ`, `resNotifRS`, `soapFault` (Task 2); `receiveReservation(channel, r)` → `{ outcome, booking_id?, reason? }`.
- Produces: the inbound URL format `https://<api host>/api/channels/<channel id>/inbound` (shown in the dashboard, Task 5).

Behaviour: unknown id or adapter ≠ `opentravel` → 404 + `soapFault('Client', 'unknown channel')`; credentials ≠ `inbound_username`/`inbound_password` → 401 + fault; unparsable → 400 + fault; otherwise each reservation → `receiveReservation`; outcomes `created|modified|cancelled|duplicate` are successes with `booking_id`; `rejected` → error with `reason`. HTTP 200 for any well-formed request (errors live in the body, per OpenTravel). Rate-limit the route (`express-rate-limit`, 60/min per IP).

- [ ] **Step 1: Write the failing tests** — on a fresh test property with a `DBL`/`BAR` mapping and 1 free room, opentravel channel:
  - Wrong password → 401, body has `Fault`, `channel_reservation_log` row count unchanged.
  - Unknown channel uuid → 404; a `test`-adapter channel id → 404.
  - `res-notif-new` (guest `Anna & Co`) → 200 `<Success/>`, `HotelReservationID ResID_Value` = a booking whose `channel_ref` = fixture `UniqueID`, guest first name `Anna & Co`.
  - Same body again → 200 `<Success/>`, same `ResID_Value`, still one booking.
  - A second new reservation for the same dates (last room gone) → 200 with `<Errors>` `no room available`, no booking.
  - `res-notif-cancel` → `<Success/>`, booking `cancelled`.
  - Body `not xml` → 400 fault.
- [ ] **Step 2: Run** `node scripts/check-channels.js` → FAIL (404 route).
- [ ] **Step 3: Implement** `handleChannelInbound(req, res)` in `channelInbound.js` with the behaviour above; respond `Content-Type: text/xml; charset=utf-8`.
- [ ] **Step 4: Run** `node scripts/check-channels.js`, `npm run check:opentravel`, `node scripts/check-mcp-coverage.js` → PASS.
- [ ] **Step 5: Commit** `Channels: OpenTravel inbound reservations (OTA_HotelResNotifRQ)`. Push `main` (deploys the API on Render) only after Task 5's dashboard is ready, so both land together.

### Task 5: Dashboard — connect an OpenTravel channel

**Files:**
- Modify: `C:\Users\robert\source\repos\ota-table-bookings\src\pages\room-bookings.astro` (the Channels tab's connect form) and `src\scripts\channels.ts`; split into `src\scripts\channels-connect.ts` if `channels.ts` passes 200 lines
- Modify: `C:\Users\robert\source\repos\OTA\mcp-server\tools.js` only if `create_channel`'s description lists adapters (add `opentravel` and its config keys)

**Interfaces:**
- Consumes: `POST/PUT /api/channels` with `adapter: 'opentravel'` and Task 3's six config keys; `GET /api/channels/:id` (secrets come back `***`; a blank secret field on edit sends no key, so the stored one is kept by Task 1's merge).
- Produces: the connect form labels the docs (Task 8) refer to — **Channel type** (Test channel / OpenTravel), **Channel endpoint URL**, **Username**, **Password**, **Hotel code**, and, read-only after creation, **Inbound URL** with a Copy button plus **Inbound username** / **Inbound password** (generated by the dashboard on create: 24-char random, shown once with Copy, then `***`).

- [ ] **Step 1:** Add the adapter select and the OpenTravel fields (shown only when OpenTravel is picked); on create, generate the inbound credentials client-side with `crypto.getRandomValues` and send them in `config`.
- [ ] **Step 2:** Show the inbound URL (`${API_BASE}/api/channels/${id}/inbound`, using the base `apiFetch` already uses) and the inbound credentials on the channel's settings.
- [ ] **Step 3: Verify** — `npm run build` in `ota-table-bookings` passes; run it against the local OTA API (`npm start` in OTA), create an OpenTravel channel, reload, edit only the endpoint, and confirm with `GET /api/channels/:id` via curl that `password` is still `***` (kept) and the endpoint changed.
- [ ] **Step 4: Commit** in `ota-table-bookings`: `Channels: connect an OpenTravel channel`. Push both repos' `main`.

---

## Part B — hotal-channel (`C:\Users\robert\source\repos\hotal-channel`, new)

Firestore layout (shared by Tasks 6–7; `hc` = hotel code):

- `hotels/{hc}`: `{ name, currency, rooms: [{ code, name }], rates: [{ code, name }], reject: boolean, hotal_inbound_url, hotal_inbound_username, hotal_inbound_password }` (the last three never rendered)
- `hotels/{hc}/ari/{room}_{rate}_{date}`: `{ room_code, rate_code, date, available, stop_sell, rate, currency, updated_at }` (`available`/`stop_sell` from avail messages, `rate`/`currency` from rate messages, merged)
- `hotels/{hc}/reservations/{uid}`: `{ uid, room_code, rate_code, check_in, check_out, guests, total, currency, guest: { first_name, last_name, email, phone }, status: 'confirmed'|'cancelled'|'failed', hotal_id, error, created_at, updated_at }`
- `messages/{auto}`: `{ hotel_code, direction: 'in'|'out', type, outcome: 'ok'|'error', detail, xml_in, xml_out, at }` (XML truncated to 100 KB)

### Task 6: Scaffold, Firestore, and the SOAP endpoint

**Files:**
- Create: Astro project (`npm create astro@latest -- --template minimal --typescript strict`), `@astrojs/vercel`, `output: 'server'`, `firebase-admin`, `fast-xml-parser`
- Create: `src/lib/firestore.ts` (admin init from `FIREBASE_SERVICE_ACCOUNT`), `src/lib/ota/xml.ts`, `src/lib/ota/messages.ts` (TypeScript ports of the OTA repo's Task 2 functions this side needs: `parse`, `esc`, `envelope`, `availNotifRS`, `rateNotifRS`, `resNotifRQ` builder, `parseResNotifRS`; port, don't import across repos)
- Create: `src/pages/api/opentravel.ts` (POST), `src/lib/ari.ts` (`applyAvail(hc, msgs)`, `applyRates(hc, msgs)` — batched writes, ≤500 per batch)
- Create: `firestore.rules` (`allow read, write: if false;`) and deploy it with `gcloud`/Firebase REST
- Create: `tests/opentravel.spec.ts` (Playwright `request` fixture against `BASE_URL`), `.env.example`, `.gitignore` (`.env`)

**Interfaces:**
- Consumes: the XML contract from Global Constraints and Task 2 (same element/attribute names).
- Produces: `POST /api/opentravel` — WS-Security vs `OTA_USERNAME`/`OTA_PASSWORD` (401 fault otherwise); `OTA_HotelAvailNotifRQ` / `OTA_HotelRateAmountNotifRQ` → `…RS`; `<Errors>` (and no write) when the hotel code, any room code or rate code is unknown, when `hotels/{hc}.reject` is true (`ShortText="rejecting pushes (test switch)"`), or for any other root element. Every request logged to `messages`.

- [ ] **Step 1: Setup** — `gcloud services enable firestore.googleapis.com --project hotal-channel`; `gcloud firestore databases create --location=eur3 --project hotal-channel`; create SA `hotal-channel-web` with `roles/datastore.user`, key to a temp file, write it single-line into `.env` as `FIREBASE_SERVICE_ACCOUNT`, delete the temp file. GitHub repo `robooko/hotal-channel` (private), Vercel project linked to it, env vars `FIREBASE_SERVICE_ACCOUNT`, `OTA_USERNAME`, `OTA_PASSWORD` (random 24 chars), `ADMIN_PASSWORD` set with `vercel env add` (never echoed).
- [ ] **Step 2: Write the failing tests** (`tests/opentravel.spec.ts`, seeding `hotels/TEST-<random>` with rooms `DBL`, rate `BAR` through a test-only helper that uses the admin SDK directly, deleted in `afterAll`):
  - Wrong password → 401.
  - Avail notif DBL/BAR 1–3 Dec available 2 → `<Success/>`; three ari docs with `available: 2`.
  - Rate notif 120.00 GBP → ari docs have `rate: 120`.
  - Avail notif with `InvTypeCode="XXX"` → `<Errors>`, no ari doc for XXX, the DBL docs unchanged.
  - `reject: true` → `<Errors>`; set false → `<Success/>`.
- [ ] **Step 3: Run** `npx astro dev --port 4340` and `BASE_URL=http://localhost:4340 npx playwright test tests/opentravel.spec.ts` → FAIL.
- [ ] **Step 4: Implement** the endpoint and `ari.ts`.
- [ ] **Step 5: Run** the tests → PASS; `npm run build` passes.
- [ ] **Step 6: Commit and push** `hotal-channel: OpenTravel ARI endpoint on Firestore`; check the Vercel deploy is Ready.

### Task 7: The OTA pages — browse, book, cancel, change, log, admin

**Files:**
- Create: `src/pages/index.astro` (hotel picker if more than one; dates; rooms × rates with total for the stay or "Not available"; 30-day grid), `src/pages/book.ts` (POST), `src/pages/reservations.astro`, `src/pages/reservations/[uid].ts` (POST cancel / change dates), `src/pages/messages.astro`, `src/pages/admin.astro` (hotel code, name, currency, room/rate codes, HOTAL inbound URL + credentials, reject toggle)
- Create: `src/lib/reservations.ts` (`sendReservation(hc, res, status: 'Commit'|'Modify'|'Cancel') -> { ok, hotal_id?, error? }` — builds `OTA_HotelResNotifRQ`, POSTs to `hotal_inbound_url` with WS-Security, 15s timeout, parses the RS, updates the reservation doc, logs to `messages`), `src/lib/admin.ts` (cookie session: POST password → signed `httpOnly; Secure; SameSite=Strict` cookie, HMAC with `ADMIN_PASSWORD`)
- Test: `tests/booking.spec.ts`

**Interfaces:**
- Consumes: Task 6's Firestore layout and `messages.ts`; HOTAL's inbound (Task 4).
- Produces: page text the E2E (Task 8) relies on: the Book button `Book`, the confirmation `Confirmed — HOTAL reference <id>`, the error `HOTAL declined: <reason>`, the reservations Cancel button `Cancel`, the admin toggle `Reject price pushes`.

Rules: a room × rate is bookable only if every night `[check_in, check_out)` has an ari doc with `available > 0` and `stop_sell === false`; total = sum of nightly `rate`. `uid` = `HC-` + 10 random base32 chars, created when the form renders (hidden field), so a double submit sends the same `UniqueID`. Public: `/`, `/book`, `/messages`. Admin cookie required: `/admin`, cancel, change dates. All POST forms carry a CSRF token tied to the cookie (admin) or the page render (book).

- [ ] **Step 1: Write the failing tests** (`tests/booking.spec.ts`). Seed a hotel with ari 1–3 Dec DBL/BAR, available 1, rate 120, and `hotal_inbound_url` = `${BASE_URL}/api/test-hotal`: a stub HOTAL route (`src/pages/api/test-hotal.ts`) that returns 404 unless `import.meta.env.DEV`, answering `<Success/>` with `ResID_Value="TEST-1"`, or `<Errors>` `no room available` when the guest's last name is `Decline`.
  - Dates 1–3 Dec → row shows `£240.00` and `Book`; 1–4 Dec → `Not available`.
  - Book as `Anna & Co` → `Confirmed — HOTAL reference TEST-1`; reservations doc `confirmed`, `hotal_id: 'TEST-1'`.
  - Re-POST the same form (same uid) → still one reservation doc.
  - Last name `Decline` → `HOTAL declined: no room available`, doc `failed`.
  - `/admin` without the cookie → redirected to login; with it, Cancel → doc `cancelled`, a `Cancel` message logged.
  - `/messages` lists the messages newest first and doesn't contain `hotal_inbound_password`'s value.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, `npm run build` passes.
- [ ] **Step 5: Commit and push** `hotal-channel: browse, book, cancel and change, message log, admin`.

### Task 8: End-to-end on the deployed systems, and the owner docs

**Files:**
- Create: `C:\Users\robert\source\repos\hotal-channel\scripts\e2e-loop.mjs` (Playwright, headless, drives `hotal-channel` pages; talks to HOTAL through its API with a full-access API key for the test property read from `.env` as `HOTAL_E2E_API_KEY`; saves screenshots to `screenshots/`)
- Create: `C:\Users\robert\source\repos\ota-table-bookings\src\pages\docs\channels.astro`; Modify: `src\pages\docs.astro` (link to it, and drop the "Rooms … Not built yet" line only for Rooms if Rooms is live — check the nav before editing)
- Create: `C:\Users\robert\source\repos\ota-table-bookings\public\docs\channels\*.webp` (screenshots, ≤1440px wide)

**Interfaces:**
- Consumes: everything above; the test property's API key (if missing, stop and ask Robert to add `HOTAL_E2E_API_KEY` via FORGE Desktop › Settings › Project › Keys).

- [ ] **Step 1: Set up the test property** (via the ota-live MCP or API): a fresh property `HOTAL Channel Test` with a `Double` room type (2 rooms, base rate 100, GBP) and a `BAR` rate. On `hotal-channel` `/admin`: hotel `HCTEST`, room `DBL`, rate `BAR`. In HOTAL: create the OpenTravel channel (endpoint `https://<hotal-channel>/api/opentravel`, `OTA_USERNAME`/`OTA_PASSWORD`, hotel code `HCTEST`), map Double → `DBL`/`BAR`; paste HOTAL's inbound URL and credentials into `hotal-channel` admin.
- [ ] **Step 2: Write `e2e-loop.mjs`** asserting, with polling up to 90s where a sync is involved:
  1. Sync → `hotal-channel` shows `DBL`/`BAR` bookable tomorrow at £100.00, availability 2; HOTAL drift is empty.
  2. Book tomorrow→+2 on `hotal-channel` → `Confirmed — HOTAL reference <id>`; HOTAL `GET /api/bookings/<id>` has `channel_ref` = the uid.
  3. Within 90s, `hotal-channel`'s grid shows availability 1 for those nights.
  4. Change the Double rate to 130 in HOTAL → within 90s the page shows £130.00.
  5. Admin: turn on `Reject price pushes`, change the rate to 140 → HOTAL drift reports failed changes; turn it off → within 90s drift is empty and the page shows £140.00.
  6. Overbook: with `Reject price pushes` on (holding hotal-channel's count at 1), book the last Double directly in HOTAL, then book the same nights on `hotal-channel` → `HOTAL declined: no room available`; turn the switch off.
  7. Cancel the step-2 reservation on `hotal-channel` → HOTAL booking `cancelled`; within 90s availability is back to 2 (minus the direct booking: 1).
  Screenshots at each step: HOTAL Channels tab (connect form, mappings, drift clean, drift failed, inbound log) and `hotal-channel` (rooms, confirmation, reservations, messages).
- [ ] **Step 3: Run** `node scripts/e2e-loop.mjs` → all seven pass. On failure, fix the owning task's code with a regression test there, then re-run.
- [ ] **Step 4: Write `docs/channels.astro`** for the owner, in plain language, no XML, following the spec's six sections, using the field labels from Task 5 and the screenshots (converted to webp, lazy, with alt text). Under 200 lines.
- [ ] **Step 5: Verify** `npm run build` in `ota-table-bookings`; open `/docs/channels` on the dev server and check each screenshot loads.
- [ ] **Step 6: Commit and push** both repos (`hotal-channel: end-to-end loop script`; `Docs: connecting a channel`). After the dashboard deploys, open `https://hotal.forge-build.co.uk/docs/channels` and confirm it renders.
