# Marina module in OTA: unifying OTA and sidon-marina (phase 1)

## Context

sidon-marina (marina.sidonmarine.uk, Astro + drizzle, its own Neon DB and
its own Clerk instance shared with the sidon-ai sailor app) runs berths,
berth bookings, pricing, guest documents and contracts for marinas. OTA
runs every other hospitality module. Two backends, two dashboards, two
logins, and no shared guest record.

Already shipped (2026-10-10) as interim steps:

- `property.sidon_marina_id` + `property.sidon_marina_key`
  (`migrate-2026-10-10-property-sidon-marina*.sql`), the admin-only
  `PUT /api/marina/key` / `POST /api/marina/key/clear`.
- `GET /api/marina/bookings`: a server-side proxy to Sidon's keyed
  `/api/marina/public/<id>/bookings`, returning a bare array
  (`src/controllers/marina.js`), used by the dashboard and the MCP tool
  `list_marina_bookings`.
- The dashboard's `/marina` page: Sidon's `<sidon-berth-map>` plus an
  upcoming-bookings table (ota-table-bookings `src/pages/marina.astro`,
  `src/scripts/marina-client.ts`), shown when `sidon_marina_id` is set.

State of sidon-marina found while writing this (read-only survey,
2026-10-10, production DB):

- **Small data.** 11 marina profiles, 1,312 berths, 148 bookings, 584
  documents, 46 price tiers, 35 overlays, 41 messages; 9.6 MB. No foreign
  keys or secondary indexes. No booking created since 2026-08-20; 68 of
  70 `pending` bookings are past `expires_at`. 4 owner ids have child
  rows but no profile; 2 profiles have no child rows (one with a NULL
  slug).
- **Consumers, all calling from the browser with no key:**
  `@forgebuild/sidon-booking-widget` 0.4.17 (`<sidon-booking-widget>`,
  `<sidon-berth-map>`) on pirates-bight and tested-trappist (BBYC);
  `@robooko/sidon-booking-widget` (GitHub Packages) 0.4.16 on sea-company
  (Fox + Pevero) and 0.2.1 on marina-di-positano (still pointed at the
  dead `sidonmarine.uk` origin); portals (hand-rolled calls plus
  server-side reads); sea-company, positano and portals also read the
  marina payload server-side or at build time; sidon-marina's own public
  pages (`/[lang]/m/[slug]/*`) read Sidon's DB directly; sidon-ai (sailor
  app: list, book, availability, contract, share-wallet, messages);
  sidon-marina-app (Tap to Pay, on the dead origin). OTA's backend is the
  only `X-Marina-Key` caller.
- **Booking trust gaps:** `book.ts` accepts `status: 'confirmed'` from
  any caller including unauthenticated guests; `guestToken` is never
  validated; `paymentIntentId` is never retrieved or checked; staff
  confirm captures on the platform account with no `stripeAccount`
  (fails silently, booking confirms anyway); no expiry job exists (the
  cron was deleted in sidon-ai `20ee807`).
- **Documents:** all 584 files are public Vercel Blob URLs with
  predictable paths, on a store shared with sidon-ai (552 of the files
  are sidon-ai's sailor-wallet files under `sailor-docs/`; 32 are Sidon
  guest uploads under `marina-docs/`). `guest-doc-upload` has no auth;
  verification has been broken since the split (0 documents verified
  since 2026-08-19; all 32 post-split uploads have `booking_id` and
  `guest_email` NULL).
- **Payments:** Stripe Connect Standard accounts on Sidon's platform
  (6 marinas, 4 in test mode). OTA uses a per-property
  `stripe_secret_key` and no Connect.
- **Berth "status" is a manual flag**, not date-aware: 266 berths
  `occupied`, 60 `reserved`, 20 `maintenance`; 319 with a hand-typed
  `guest_name` (seasonal/annual holders), independent of bookings.
- **AI enquiry replies** (sidon-marina `4acb4bf..88ee507`, spec
  `2026-10-04-ai-enquiry-replies-design.md`) are implemented but
  unpushed, their schema was never applied, and `@forgebuild/ai-replies`
  is missing from sidon-marina's `package.json`.

Decided with the user (2026-10-10):

1. **Goal order:** one backend, then one operator dashboard, then one
   guest record (Folio). Phases 1 and 2 are merged: marina operations
   are built in the OTA dashboard now and Sidon's dashboard is retired
   at cutover.
2. **One cutover**, not marina by marina: every marina is a demo or
   pilot. Endpoints are rebuilt on OTA conventions rather than ported,
   so the trust gaps are fixed, not migrated.
3. **No Stripe Connect.** Marinas use OTA's per-property Stripe keys.
4. **Each site reaches OTA through its own Astro API route** holding
   the property's `X-Api-Key` (OTA's guest-site convention).
5. **OTA-native API + a new major of the widget** that speaks it; the
   forwarder ships inside the widget package.
6. **Marina enquiries go into OTA's event-inquiry inbox** and AI reply
   pipeline. Sidon's in-app chat and its unpushed AI branch are retired.
7. **Documents and contracts move in phase 1, fixed:** private storage,
   booking-bound uploads, working verification.
8. **Manual occupancy becomes open-ended bookings**; availability comes
   from bookings only.

## Goals

- Marina data lives in OTA's Postgres as a property-scoped module
  following OTA conventions (UUIDs, `property_id`, `status` soft delete,
  `DATE` columns).
- A guest booking API that can't be abused into confirmed bookings,
  free holds, or document leaks.
- Card holds on the property's own Stripe account, captured or released
  correctly, with expiry, safe under concurrency.
- Staff run marinas from the OTA dashboard: bookings, documents,
  berths, pricing, contracts.
- Every current consumer keeps working after cutover or is deliberately
  retired (listed below), via the widget's new major, a one-file
  forwarder per site, and a server-side client for build-time reads.
- Sidon's data imported with a reconciled report, its marina-owned
  public document files deleted, its database retired.

## Non-goals (phase 1)

- Stripe Connect; Stripe Terminal / Tap to Pay (0 transactions).
- In-app chat, the sailor-app inbox, the sailor document wallet
  (`share-wallet`), signed-in contract signing.
- **sidon-ai's marina features** (list, book, availability, contract,
  wallet, chat) are removed at cutover; the sailor app's future is
  backlog. sidon-ai's own `sailor-docs/*` wallet files are untouched.
- A drag-and-drop map editor (placement by coordinates/CSV; overlays
  are traced by script today).
- Guest record / Folio linkage (phase 2: `guest_id` stays NULL).
- Token metering of document extraction.
- sidon-marina's marketing chatbot (`/api/chat`) and its marina content
  collection (`src/content/marinas/*.md`, presentation per sidon-ai
  DECISIONS #1): both stay in sidon-marina.
- Cleaning the stale `marina_*` copies in sidon-ai's old DB (follow-up).

## Data model

All tables: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`,
`property_id UUID NOT NULL REFERENCES property(id)`, an
`idx_<table>_property` index, `created_at TIMESTAMPTZ DEFAULT now()`.
Catalogue rows soft-delete through `status VARCHAR(20) DEFAULT 'active'`
(`active`/`inactive`), matching spa/golf (`list*` filters active, `get*`
does not), except berths (below). One migration file,
`src/db/migrate-YYYY-MM-DD-marina-module.sql`, mirrored into
`schema.sql`.

**"Today"** everywhere in this spec means
`(now() AT TIME ZONE property.timezone)::date`: arrival-not-in-past,
"upcoming", stat tiles, import's cutover date, retention day counts.
"Upcoming" means `departure IS NULL OR departure > today`.

### `marina` (from `marina_profile` + `marina_layout`)

The venue, like `spa`; a property may have several.

| column | notes |
|---|---|
| `name` VARCHAR(100) NOT NULL, `slug` VARCHAR(100) NOT NULL | `UNIQUE (property_id, slug)`; the slug is what the widget's `marina` attribute carries. Import uses Sidon's slug, else `slugify(name)`. |
| `description`, `phone`, `email`, `website` | |
| `lat`, `lng` DOUBLE PRECISION | |
| `layout_svg` TEXT, `layout_sw_lat`, `layout_sw_lng`, `layout_ne_lat`, `layout_ne_lng`, `layout_rotation` | base map (3 Sidon marinas have one; the largest is 135 kB) |
| `response_window_hours` INT NOT NULL DEFAULT 24 | `CHECK (BETWEEN 1 AND 144)`: Stripe releases uncaptured online card holds after ~7 days |
| `auto_confirm` BOOLEAN NOT NULL DEFAULT false | DECISIONS #7, opt-in per marina |
| `booking_url` TEXT | the guest booking page on the marina's site (below); must contain `{id}` and `{token}`; used in every guest email |
| `sidon_owner_id` TEXT UNIQUE | import mapping only; dropped in cleanup |
| `status` | soft delete |

Currency comes from `property.currency`. A property created for a marina
takes the marina's currency, upper-cased (`EUR`/`USD`). A reused
property's currency is never changed (see Cutover step 2).

### `marina_pontoon` (from `marina_overlay`)

`marina_id` FK, `name` VARCHAR(100) NOT NULL DEFAULT 'Dock', `svg_data`
TEXT, corner coordinates, `rotation`, `sort_order` INT, `status`.
Overlay SVGs join to berths by label (`data-berth-id`).

### `marina_berth`

| column | notes |
|---|---|
| `marina_id` FK NOT NULL, `pontoon_id` FK NULL | |
| `label` VARCHAR(30) NOT NULL | Sidon `berth_id` ("P10"); `UNIQUE (marina_id, label)` (0 duplicates in Sidon) |
| `lat`, `lng`, `rotation` | |
| `length_m`, `min_length_m`, `beam_m`, `depth_m` NUMERIC(6,2) | |
| `price_per_night` NUMERIC(10,2), `price_mode` VARCHAR(10) DEFAULT 'per_metre' | `CHECK (price_mode IN ('per_metre','fixed'))` |
| `notes` TEXT | |
| `status` VARCHAR(20) DEFAULT 'active' | `active` / `maintenance` / `inactive`. Occupancy is never stored here. Staff lists (grid, staff map, `list_marina_berths`) exclude only `inactive`; the guest map payload includes `maintenance` berths with `available: false`; only `active` berths are bookable. |

### `marina_price_tier`

`marina_id` FK, `valid_from` DATE, `valid_to` DATE (inclusive),
`max_length_m` NUMERIC(6,2) NOT NULL, `max_beam_m`, `price_per_night`
NUMERIC(10,2) NOT NULL, `price_per_month`, `price_per_year`
NUMERIC(10,2). Sidon's values are ISO datetimes with offsets
(`2025-09-16T00:00:00.000+01:00`); import takes the date part in the
property's timezone (so the timezone must be set before tiers import).

### `marina_booking` (from `berth_booking`)

| column | notes |
|---|---|
| `marina_id` FK, `berth_id` FK `marina_berth(id)` NOT NULL | |
| `guest_id` FK `guest(id)` NULL | phase 2 |
| `contact_name` VARCHAR(100) NOT NULL, `contact_email` VARCHAR(255), `contact_phone` VARCHAR(30), `contact_email_key` VARCHAR(255) | `contact_email_key` via `spaBookingGuard`'s `emailKey` |
| `boat_name` VARCHAR(100), `boat_length_m`, `boat_beam_m` NUMERIC(6,2) | |
| `arrival` DATE NOT NULL, `departure` DATE NULL | departure exclusive; NULL = open-ended |
| `status` VARCHAR(20) NOT NULL | `hold` / `pending` / `confirmed` / `declined` / `cancelled`; CHECK constraint |
| `source` VARCHAR(10) NOT NULL | `guest` / `staff` / `import` |
| `locale` VARCHAR(5) NOT NULL DEFAULT 'en' | `en`/`it`/`fr`/`es`, guest emails |
| `total_price` NUMERIC(10,2), `currency` CHAR(3) | server-computed at create; currency copied from the property (upper case) so later property changes don't break in-flight payments; NULL total for open-ended |
| `stripe_payment_intent_id` VARCHAR(255), `payment_status` VARCHAR(20) NOT NULL DEFAULT 'none' | `none` / `held` / `captured` / `released` / `refunded` |
| `payment_error` TEXT | last Stripe capture/cancel/refund error; cleared on success; shown to staff |
| `hold_expires_at` TIMESTAMPTZ | set **only on `source = 'guest'` rows**: `hold` (30 min) and `pending` (response window). Staff and imported rows keep NULL and are never swept. |
| `confirm_token_hash` VARCHAR(64) | sha256 of the email-confirm token (no-card holds; spa pattern) |
| `client_ip`, `user_agent` | from the forwarder headers at create |
| `notes` TEXT, `cancel_reason` TEXT, `updated_at` | |
| `legacy_payment_intent_id` VARCHAR(255) | import only: a Sidon Connect PI, reference only |

```sql
ALTER TABLE marina_booking ADD CONSTRAINT marina_booking_no_overlap
  EXCLUDE USING gist (berth_id WITH =, daterange(arrival, departure) WITH &&)
  WHERE (status IN ('hold', 'pending', 'confirmed'));
-- plus CHECK (departure IS NULL OR departure > arrival)
```

`daterange(arrival, NULL)` is unbounded above, so an open-ended booking
blocks every later date; adjacent stays (one's departure = next arrival)
don't overlap under the default `[)` bounds. `23P01` maps to 409, as
`bookings.js` does for rooms. `btree_gist` is already installed on both
DBs.

No booking token is stored: it is derived (see Guest routes).

### Documents and contracts

- `marina_doc_requirement`: `marina_id`, `type` VARCHAR(30) (passport /
  registration / insurance / safety / …), `name`, `description`,
  `fields` JSONB (Sidon's `schema` string parsed: `[{name,label,type}]`),
  `mandatory` BOOLEAN DEFAULT true, `sort_order`, `status`.
- `marina_document`: `marina_id`, `booking_id` FK NOT NULL,
  `requirement_id` FK NULL (33 imported documents reference requirements
  Sidon deleted), `type`, `blob_pathname` TEXT NOT NULL (private store
  path, never a URL), `file_name`, `content_type`, `size_bytes`,
  `extracted_data` JSONB, `expiry_date` DATE, `status` (`pending` /
  `verified` / `rejected`), `notes`, `submitted_at`, `verified_at`,
  `verified_by` (Clerk user id), `file_deleted_at`.
- `marina_contract_template`: `marina_id`, `name`, `body_markdown`,
  `min_nights` INT DEFAULT 0, `status`.
- `marina_contract_signature`: `booking_id` FK, `template_id` FK,
  `rendered_body` TEXT NOT NULL, `signer_email`, `agreed_at`,
  `ip_address`, `user_agent`.

### Content

- `marina_poi`: `marina_id`, `label`, `type`, `lat`, `lng`.
- `marina_image`: `marina_id`, `url` (OTA's public blob store),
  `description`, `sort_order`.

### Changes to existing tables and code

- `event_inquiry.marina_id UUID NULL REFERENCES marina(id)`;
  `createInquiry` gains marina validation like `restaurant_id`/`spa_id`
  (`eventInquiries.js`).
- `property.stripe_publishable_key TEXT` (public; returned to guest
  routes).
- The interim proxy moves from `GET /api/marina/bookings` to
  `GET /api/marina/sidon-bookings` in the dark deploy (Cutover step 1),
  freeing the path for the new staff list.

Dropped from Sidon: `marina_announcement` (0 rows), `marina_transaction`
(0), `marina_message` (exported), `marina_ai_draft` (never deployed),
`marina_profile.api_key`, `place_id` (always NULL) and the Stripe Connect
columns.

After Switch, the dashboard shows the Marina nav item when the property
has at least one active `marina` (replacing the `sidon_marina_id` rule).
`marina` is not added to `MODULE_KEYS` in phase 1.

## API

New/extended `src/routes/marina.js` with controllers split by area
(`marinaGuest.js`, `marinaBookings.js`, `marinaDocuments.js`,
`marinaCatalogue.js`), mounted at `/api/marina` alongside the interim
routes until cleanup. Literal segments before `/:id`, per existing
route-order comments.

**Body parsing:** the marina router mounts `express.json({ limit: '2mb' })`
ahead of the global `express.json()` (100 kB default) for layout/pontoon
SVGs and `berths/bulk`; the document upload route uses
`express.raw(...)` (below). Both mounted in `app.js` before the global
parser, like the webhook routes.

### Guest routes: `/api/marina/guest/:marina/...`

The only prefix a site forwarder passes through. `:marina` is the slug,
resolved within `req.property_id`. Auth: `authenticateOrApiKey`; on the
key rail (`req.auth_method === 'api_key'`) the guest rules below apply;
a bearer (the dashboard) gets staff behaviour on the same reads.

| route | purpose |
|---|---|
| `GET /:marina[?from&to]` | map payload: marina (`name, slug, description, lat, lng, phone, email, website, layout`), pontoons, non-inactive berths (`label, pontoon_id, lat, lng, rotation, length_m, min_length_m, beam_m, depth_m, price_per_night, price_mode, available`), price tiers, POIs, images, `currency`, `stripe_publishable_key`. `available` = active and no `hold`/`pending`/`confirmed` booking overlapping `[from, to)`; without dates, overlapping today. Nothing else from `marina` or `property`. |
| `GET /:marina/availability?arrival&departure&boat_length_m&boat_beam_m` | fitting, free, active berths |
| `GET /:marina/doc-requirements` | active requirements |
| `GET /:marina/contract-preview?nights` | applicable template rendered with marina fields |
| `POST /:marina/quote` | `{berth_label, arrival, departure, boat_length_m, boat_beam_m?}` → price breakdown |
| `POST /:marina/bookings` | `{berth_label, arrival, departure, contact_name, contact_email, contact_phone?, boat_name, boat_length_m, boat_beam_m?, notes?, locale?}` → creates a `hold`; returns `{booking, booking_token, payment?}` |
| `GET /:marina/bookings/:id` | booking status page data (token); while `hold` with a PI, includes `payment.client_secret` (retrieved from Stripe) so a reloaded page can resume |
| `POST /:marina/bookings/:id/confirm-payment` | token |
| `POST /:marina/bookings/:id/documents?requirement_id=` | raw-body upload (token) |
| `POST /:marina/bookings/:id/contract` | agree (token) |
| `POST /:marina/bookings/:id/cancel` | guest cancel while `hold`/`pending` (token) |
| `GET /:marina/bookings/:id/ably-token` | subscribe-only TokenRequest for `marina-booking:{id}` (token) |
| `POST /:marina/enquiries` | `{name, email, phone?, message, arrival?, departure?, boat_length_m?}` → an `event_inquiry` with `marina_id`; shares `createInquiry`'s validation and token-balance gate (core factored out), then the AI reply pipeline |
| `GET /api/marina/confirm-booking/:id/:confirmToken` | unauthenticated email-confirm link, emailed as an absolute `${OTA_API_BASE_URL}/api/marina/confirm-booking/…` URL (spa pattern), never via a forwarder. Moves `hold` → `pending`, then redirects to `booking_url` (filled), or renders a plain confirmation page when unset. |

**Booking token:** derived, never stored:
`base64url(HMAC-SHA256(MARINA_BOOKING_TOKEN_SECRET, booking.id))`
(new Render env var). Sent in an `X-Booking-Token` header (the forwarder
passes it), verified by recomputing and comparing in constant time.
Wrong or missing → 404 (don't reveal the booking exists). Because any
code path can rebuild it, staff-action and sweep emails and the confirm
redirect can all fill `{token}`. `confirm_token_hash` stays separate so
the create response can't confirm its own email. Rotating the secret
invalidates every outstanding link (acceptable; documented).

### One pricing function

`src/lib/marinaPricing.js` →
`priceStay({berth, tiers, arrival, departure, boatLengthM, boatBeamM})`,
used by quote, booking create and the PI amount, so they can never
disagree (Sidon priced create-intent and book differently). Returns a
NUMERIC-safe value rounded to 2 dp.

1. A tier applies when `valid_from <= arrival`,
   `departure - 1 day <= valid_to`, `max_length_m >= boat length` (and
   `max_beam_m >= boat beam` when both are set); the smallest
   `max_length_m` wins. Tiers match on **boat** length (deliberate change:
   Sidon's `book.ts` matched on berth length); berth length is used when
   no boat length is given (staff only).
2. Else the berth: `fixed` → `price_per_night × nights`; `per_metre` →
   `price_per_night × boat_length_m × nights`.
3. No price → `total_price` NULL and the booking is request-only (no
   card hold).

Open-ended (staff/import only) bookings have no total.

### Booking lifecycle

| status | meaning | exits |
|---|---|---|
| `hold` | created by a guest; awaiting a card hold or the email-confirm link. Blocks the berth, hidden from staff lists and feeds. | `pending` on confirm-payment / confirm link; `cancelled` by the sweep after 30 min (or immediately if PI creation fails) |
| `pending` | awaiting staff (and documents/contract). Guest rows: `hold_expires_at = now + response_window_hours`. | `confirmed`, `declined`, `cancelled` (guest or staff), `cancelled` by the sweep at expiry (guest rows only) |
| `confirmed` | staff confirmed, or auto-confirm. PI captured (if any). | `cancelled` (staff: refund or keep); open-ended → staff set `departure` |
| `declined` / `cancelled` | PI released (or refunded per staff choice) | terminal |

- Guests can never set `status`; it isn't accepted on the guest rail.
- **Concurrency:** every transition that calls Stripe (confirm-payment,
  staff/auto confirm, decline, guest cancel, staff cancel/refund) runs
  in one transaction: `SELECT … FOR UPDATE` on the booking (spa
  `confirmBooking` pattern), re-check the expected status (and
  `hold_expires_at > now()` for guest `hold`/`pending`; a lapsed row is
  cancelled instead), call Stripe with an idempotency key
  (`marina-capture-{id}`, `marina-cancel-{id}`, `marina-refund-{id}`),
  then update and commit. `payment_status = released` only after
  Stripe's cancel succeeds.
- **Sweep:** `startMarinaHoldExpiryJob` in `server.js` beside the spa
  hold-expiry job, every 60 s, `WHERE source = 'guest' AND status IN
  ('hold','pending') AND hold_expires_at < now()`, each row under the
  same row lock (skipping rows whose status changed). Before cancelling
  an expired `hold` that has a PI, it retrieves the PI: if
  `requires_capture` with matching amount and currency, it moves the
  booking to `pending` instead (there's no webhook to catch a guest who
  closed the tab after authorising). Otherwise it cancels the booking,
  releases the PI, publishes, and emails the guest for expired
  `pending`. A failed release keeps `payment_error` and is retried on
  the next pass.
- **Auto-confirm** (`marina.auto_confirm`): checked when a booking
  reaches `pending`, after a document is verified, and after the
  contract is agreed; only for `status = 'pending'`, under the row lock.
  Confirms when every mandatory requirement has a verified document for
  the booking, the applicable contract (if any) is agreed, and — only if
  the booking has a `stripe_payment_intent_id` — `payment_status =
  'held'`. A PI is captured first; on failure the booking stays
  `pending` with `payment_error` set.
- Staff confirm/decline skip Stripe when `stripe_payment_intent_id` is
  NULL (staff, imported, unpriced, or no-Stripe bookings).

### Guest rail rules (spa pattern, `spaBookingGuard.js`)

- At most 3 upcoming `hold`/`pending`/`confirmed` bookings per
  `contact_email_key` per property, serialised with
  `pg_advisory_xact_lock(hashtext('marina-email:{property}:{key}'))`;
  429 over the cap.
- Valid `contact_email`; `boat_length_m` required; arrival ≥ today;
  departure required and > arrival; stay ≤ 90 nights; berth `active`;
  fit checks (boat length ≤ `length_m`, boat length ≥ `min_length_m`,
  boat beam ≤ `beam_m`) each skipped when that berth value is NULL.
- **Client identity:** the forwarder sets `X-Client-Ip` (from Astro's
  `clientAddress`, overwriting any inbound value) and passes the
  client's `User-Agent`. OTA reads `X-Client-Ip` only on the key rail
  (never `X-Forwarded-For`, which Render appends to; no app-wide
  `trust proxy`), grouping IPv6 by /64 (express-rate-limit's
  `ipKeyGenerator`). A key-rail request without it shares one bucket per
  property.
- Per-IP limits: `POST bookings` 10/hour, document uploads 30/hour,
  `POST enquiries` 10/hour. When `X-Client-Ip` is present, the existing
  per-key limiter (`rateLimiter.js`, 100/min) keys on key + client IP,
  so one visitor can't exhaust a property's budget for every module.
- **Uploads:** the request body is the raw file (`Content-Type` = the
  file's type, `X-File-Name` header, `requirement_id` query parameter),
  parsed by a route-level `express.raw({ type: [the three types], limit:
  '4mb' })`. ≤ 4 MB (Vercel's 4.5 MB function body limit applies at
  every forwarder; the widget downscales images client-side and rejects
  larger PDFs with a clear message). `application/pdf`, `image/jpeg`,
  `image/png` only, checked by magic bytes, not the declared type.
  Accepted only while the booking is `pending` or `confirmed` (409
  otherwise, so a card-free hold can't trigger paid extraction), at most
  10 documents per booking.

### Staff routes

`authenticateOrApiKey` (OTA's module norm, so MCP tools work over a
key), except where marked **bearer**:

- marinas, pontoons, berths (+ `POST berths/bulk` from CSV rows), price
  tiers, doc requirements, contract templates, POIs, images (+ upload to
  the public store): list / get / create / update (soft delete via
  `status`). Renaming a berth label also rewrites the matching
  `data-berth-id` in its pontoon's `svg_data`, in the same transaction.
- bookings: `GET /bookings` (filters: `from`, `to`, `status`,
  `berth_id`, `marina_id`; paged `{total, data}`), `GET /bookings/:id`
  (joined: berth, documents metadata, signature, payment,
  `payment_error`), `POST /bookings` (staff create: any dates,
  open-ended allowed, optional `total_price` override, status `pending`
  or `confirmed`, `source = 'staff'`), `PUT /bookings/:id` (`confirm`,
  `decline`, `cancel` with `refund: boolean`, `end` with `departure`,
  contact/boat edits), `POST /bookings/:id/send-guest-link` (emails the
  `booking_url` link so staff-created bookings can collect documents and
  the contract).
- documents **bearer**: `GET /bookings/:id/documents` (metadata +
  extracted data), `GET /documents/:id/file` (streamed from the private
  store), `PUT /documents/:id` (`verified`/`rejected`, notes). Passport
  data never reaches the key rail, because guest sites hold the key.

### Live updates

- `property:{id}:marina-bookings`, events `new-booking` (on reaching
  `pending` or staff create) and `booking-status-changed`, payload the
  full joined row (berth label, marina name, payment, `payment_error`,
  document counts), never a patch, never joining `property`.
- `marina-booking:{id}`, event `updated` `{status}`, for the guest's
  booking page.

### Emails (Resend)

From `${propertyName} via Forge <bookings@…>` like spa, `replyTo` the
marina's email, property branding via `resolveEmailBranding`, in the
booking's `locale` (en/it/fr/es copy ported from sidon-marina
`src/lib/email.ts`; staff-facing text stays English).

| booking source | emails |
|---|---|
| `guest` | received (with the confirm link when there's no card hold, whether or not `booking_url` is set), pending, confirmed, declined, cancelled, expired |
| `staff` (with `contact_email`) | confirmed, declined, cancelled, and the guest link on request |
| `import` | none |

Every guest email links to `booking_url` with `{id}` and `{token}`
filled in, plus a QR code of that link (`qrcode`, as Sidon does), when
`booking_url` is set. The raw token appears only in emails to the
booking's `contact_email`, the confirm redirect, and the create
response.

### MCP and Swagger

Tools: `list_marinas`, `get_marina`, `list_marina_berths`,
`update_marina_berth`, `search_berth_availability`,
`list_marina_bookings` (rewritten at Switch to OTA data and the paged
shape), `get_marina_booking`, `create_marina_booking`,
`update_marina_booking`. No document tools (bearer-only data; MCP calls
REST over loopback with the caller's credentials). Swagger `Marina` tag
gains every route.

### AI replies

`src/lib/aiReplyTools.js` gains a `marina_id` branch: an availability
tool over the availability logic, in-process. `aiReplies.js`
`buildVenueFacts` renders marina facts (berth size range, price tiers,
response window, document requirements). No booking proposal for
marinas in phase 1 (approve-to-book stays spa-only; replies link to the
marina's booking page), matching the sidon-marina AI spec's "the AI
never creates a booking".

## Payments

Per-property Stripe, no Connect.

- Settings gains `stripe_publishable_key` next to the secret key (bearer
  + admin, like `PUT /property/stripe/key`). Mode is read from the
  `sk_`/`rk_`/`pk_` prefix. Both `PUT /property/stripe/key` and the new
  publishable-key route reject a save whose mode differs from the other
  stored key, naming both modes; changing modes means clearing the other
  key first.
- `POST bookings`, card path (priced, and the property has both a secret
  and a publishable key; otherwise the email-confirm path): inside the
  transaction insert the `hold`; then create a PaymentIntent on the
  property's account: `capture_method: 'manual'`, card,
  `amount = toCents(total_price)`, `currency = booking.currency
  .toLowerCase()`, `metadata {property_id, marina_booking_id}`,
  idempotency key `marina-booking-{id}`. Return `{client_secret,
  publishable_key}`. **If PI creation fails**, the same request cancels
  the hold (`cancel_reason = 'payment setup failed'`) and returns 502, so
  the berth is freed at once.
- `confirm-payment` (under the row lock): retrieve the PI with the
  property key; require `pi.id` = the booking's,
  `metadata.marina_booking_id` = the booking,
  `pi.amount = toCents(total_price)`,
  `pi.currency = booking.currency.toLowerCase()`,
  `status = 'requires_capture'` → `pending`, `payment_status = 'held'`.
- Confirm (staff or auto) → `paymentIntents.capture`. Failure: stays
  `pending`, `payment_error` set, 502 with Stripe's message to staff.
  Decline / guest cancel / expiry → `paymentIntents.cancel`. Staff
  cancel of `confirmed` → refund or keep (restaurant `cancel` pattern).
- Unpriced bookings or properties without both keys: no PI;
  email-confirm link moves `hold` → `pending`.
- No webhook, matching OTA's explicit confirm endpoints (the sweep's PI
  check covers the closed-tab case).

## Documents and contracts

- **Storage:** Vercel Blob access is fixed per store, so OTA gets two
  stores: a private one (`BLOB_READ_WRITE_TOKEN`) for `marina-docs/` and
  `marina-docs-archive/`, and a public one
  (`BLOB_PUBLIC_READ_WRITE_TOKEN`) for `marina_image` files. Neither is
  Sidon's store. Add `@vercel/blob` ≥ 2.3 to OTA. Document pathname:
  `marina-docs/{property_id}/{booking_id}/{uuid}.{ext}`.
- **Viewing:** `GET /documents/:id/file` (bearer) gets the private blob
  and streams it (`Readable.fromWeb(result.stream).pipe(res)`) with the
  stored, magic-byte-checked `Content-Type`, `Content-Disposition:
  inline`, `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`.
- **Upload:** the guest route stores the file, inserts `marina_document`
  (`pending`), then runs extraction in the background (port of Sidon's
  `extract-document.ts`: Claude with the requirement's `fields`), filling
  `extracted_data` and `expiry_date`. Failures are stored as
  `extracted_data {error}`. Extracted values never change document
  status or drive auto-confirm (document content is untrusted input to
  the model).
- **Verification:** staff verify/reject per document; the auto-confirm
  check runs as listed in the lifecycle.
- **Contracts:** the server picks the active template with the highest
  `min_nights <= nights` (not the client). Merge fields keep Sidon's
  names so imported templates render unchanged: `sailor_name` →
  `contact_name`, `sailor_email` → `contact_email`, `boat_name`,
  `boat_loa` → `boat_length_m`, `boat_beam` → `boat_beam_m`,
  `berth_id` → berth label, `arrival_date`, `departure_date`, `nights`,
  `amount` → `total_price`, `notes`, `marina_name`, `marina_email`,
  `marina_phone`, `marina_website`, `today`. Document-field placeholders
  (`{{<type>.<field>}}`, e.g. `acord25.*` used by 8 of 9 templates,
  `insurance.*`) are unsupported and render blank; the template editor
  warns about unknown placeholders. Agreeing stores the rendered
  snapshot, client IP and user agent (forwarded headers), and the
  booking email.
- **Retention:** a daily job deletes document files 90 days after the
  booking's departure or cancellation (open-ended: after it's ended),
  sets `file_deleted_at`, keeps the row; and deletes
  `marina-docs-archive/` objects older than 90 days.

## The forwarder, the server client and the widget

New major `@forgebuild/sidon-booking-widget@1.0.0` (repo
sidon-booking-widget):

- Speaks the guest API above. `api-origin` defaults to the page's own
  origin; `marina` is the OTA slug.
- Keeps every existing element attribute and every emitted event name
  and `detail` shape (`sidon-quickbook-submit`, `sidon-berth-selected`,
  `sidon-loa-change`, `sidon-step-change`, `sidon-booked`,
  `sidon-booking-status`); berth identifiers in attributes and events
  stay the berth label.
- Flow: quote → `POST bookings` → Stripe Payment Element with
  `publishable_key` (no `stripeAccount`) → `confirm-payment` → booking
  page. The documents and contract steps move after the booking (they
  need the token), on the booking page.
- **Booking-page mode:** `<sidon-booking-widget booking-id>` reads
  `?booking=&token=` and shows status (live via the booking's Ably
  token), payment resume while `hold`, document uploads, the contract,
  and cancel. Each site hosts this page; its URL is the marina's
  `booking_url`.
- `<sidon-berth-map>` reads `GET /:marina[?from&to]`.
- Export `@forgebuild/sidon-booking-widget/astro-proxy`:
  - `createMarinaProxy({ otaBaseUrl, keys })` returns an Astro `APIRoute`
    for `src/pages/api/marina/guest/[...path].ts` (`prerender = false`).
    `keys` is one API key string, or a `Record<slug, apiKey>` for a site
    serving marinas on several properties (the `:marina` segment selects
    the key; unknown slug → 404; slugs must be unique across the map).
  - It forwards only `/api/marina/guest/*`, methods GET/POST. Astro has
    already decoded `params.path`, so it returns 404 when any segment is
    empty, `.` or `..`, or contains `\`, `%` or a control character;
    builds the upstream URL with
    `new URL('/api/marina/guest/' + path, otaBaseUrl)`, returns 404
    unless `url.pathname` starts with `/api/marina/guest/`, then appends
    the inbound query string.
  - Passes the body, `Content-Type`, `X-File-Name`, `X-Booking-Token`,
    `User-Agent`; sets `X-Client-Ip` from `clientAddress`; adds
    `X-Api-Key`; drops cookies and every other header; enforces a 4.5 MB
    body cap; fetches with `redirect: 'manual'`.
  - `createMarinaClient({ otaBaseUrl, apiKey })` for server-side and
    build-time reads (`getMarina(slug, {from, to})`,
    `getDocRequirements(slug)`), calling OTA directly with the key.

Per-site change: add the one route; set `OTA_API_KEY` / `OTA_BASE_URL`
as server env (and available to the Vercel build where pages read marina
data at build time); install `@forgebuild/sidon-booking-widget@^1.0.0`
(sea-company and marina-di-positano: uninstall
`@robooko/sidon-booking-widget`, update import specifiers, remove the
`@robooko` line from `.npmrc`); set `marina` to the OTA slug; host the
booking page and set the marina's `booking_url`.

| consumer | phase 1 outcome |
|---|---|
| pirates-bight, tested-trappist | forwarder + widget 1.0 + booking page |
| sea-company | Fox + Pevero on one property (one key); forwarder; build-time price grid via `createMarinaClient` |
| portals | forwarder; hand-rolled calls rewritten to the guest API; SSR berths page via `createMarinaClient` |
| marina-di-positano | forwarder; widget 1.0; SSR/build reads via `createMarinaClient`; its hand-rolled Google map rewritten to the new payload (`available`, not Sidon `status` strings) or replaced by `<sidon-berth-map>` |
| sidon-marina public pages (`/[lang]/m/[slug]/*`) | a client site: multi-key forwarder (`keys` map in server config, which also replaces Sidon's `/public/list`), pages read via `createMarinaClient` instead of Sidon's DB; `MarinaEnquiryDrawer` posts to `POST /:marina/enquiries`; `MarinaMessageSticky` (chat) removed; the old `/[lang]/m/[slug]/booking/[id]` page replaced by the booking page |
| sidon-ai | marina list, map detail, availability, booking, wallet, chat and contract calls removed |
| sidon-marina-app (Tap to Pay) | archived |

The dashboard uses its own forwarder route that sends the signed-in
staff member's Clerk bearer instead of a key, so `<sidon-berth-map>`
works there with staff rules; the dashboard opens its side panel from
the map's `sidon-berth-selected` event.

## Dashboard (ota-table-bookings)

Ships at Switch (Cutover step 6), after import; until then `/marina`
keeps its interim behaviour.

- **`/marina`:** stat tiles (arrivals today, departures today, on berth,
  pending approvals); the berth map coloured by today's bookings;
  clicking a berth opens a side panel with current/next bookings and
  quick edits.
- **`/marina-bookings`:** filterable table; confirm / decline / cancel
  (refund or keep) / end open-ended / send guest link; staff create
  dialog; booking detail dialog with documents (view file,
  verify/reject), contract agreement, payment status and
  `payment_error`. Live refresh on `property:{id}:marina-bookings` via
  `src/pages/api/marina/ably-auth.ts` (existing ably-auth pattern). No
  new hotal-ui element in phase 1.
- **`/marina-setup`:** berths grid (inline autosave, restaurant grid
  pattern), CSV import, pontoons (SVG + corners), price tiers, document
  requirements (template editor warns on unknown placeholders), contract
  templates, POIs, images.
- **Settings:** a Marina section (add/edit marinas: name, slug,
  location, contact, response window, auto-confirm, booking URL); the
  Stripe publishable key beside the secret key; the Sidon id/key fields
  removed at cleanup.
- **Enquiries:** marina enquiries in the existing inbox, labelled with
  the marina.

## Cutover

Runbook, in order. Sidon's DB is only ever read by the import.

1. **Dark deploy** (nothing user-visible changes):
   - OTA: the marina module (unused); the interim proxy moved to
     `GET /api/marina/sidon-bookings` with `marina-client.ts`, the old
     `list_marina_bookings` and its Swagger entry updated in the same
     release.
   - Widget 1.0.0 + `astro-proxy` published.
   - A PR ready per consumer in the table above (incl. the sidon-ai
     removal PR and the sidon-marina client-site rewrite).
2. **Map:** `node scripts/import-sidon-marina.js --map <map-file>`. The
   map file lists every Sidon owner id → `property_id` | `create` |
   `skip`, plus, per created property, its name, IANA timezone and the
   operator's OTA Clerk org id. It never matches by name. Initial
   decisions:
   - Pirates Bight (the profile named by the live property's
     `sidon_marina_id`) → the existing "Pirates Bight" property; the other
     Pirates Bight profile, "Playwright Test Marina" and "nvcnv" → skip.
   - Bora Bora Yacht Club → the existing "BBYC" property
     (tested-trappist already holds its key).
   - Fox Mooring + Pevero Mooring → one created SEA Company property (two
     `marina` rows).
   - The rest → created, one property per operator.
   Rules:
   - **Clerk orgs first:** the operator creates each OTA Clerk org (Clerk
     dashboard or `clerk` CLI); `--map` writes `property.clerk_org_id`
     when creating the property and refuses a created property without
     one. Invites go out only after. (A property without `clerk_org_id`
     must never be handed to an owner: `auth.js` auto-creates a new,
     empty property for an unknown org on first sign-in.) Reused
     properties without a `clerk_org_id` (BBYC today) get one linked
     before import.
   - Created properties get name, upper-cased currency, timezone,
     `api_key` with `api_key_enabled = true`, and `grantStarter` tokens.
   - Every mapped property gets `property.sidon_marina_id = owner_id`;
     `--map` looks properties up by that column first, so re-runs never
     create duplicates.
   - **Currency:** a reused property's currency is never changed. If it
     differs from the marina's (BBYC: GBP vs `eur`), `--map` flags it and
     the import refuses that marina's priced rows unless the map file
     records a decision (re-price, or accept the numbers as the property
     currency).
   - **Profile-less owners:** re-keyed to a profiled marina when their
     rows point to exactly one (documents whose `booking_id` hits its
     bookings, berths whose `overlay_id` hits its overlays, or every
     booking label found only in that marina); their bookings then import
     against that marina's berths by label, duplicate berths are not
     imported, and the re-key is reported. Ambiguous or unmatched owners
     are skipped and listed. Profiles with no child rows are not
     imported.
   - The printed map (grouping, re-keys, currency flags, slugs) is signed
     off before import. Slugs served by one multi-key forwarder must be
     unique across it.
3. **Freeze:** deploy sidon-marina with every non-GET `/api/marina/*`
   route (public and dashboard: bookings, berths, tiers, templates,
   requirements, layout, overlays, profile, stripe, terminal) returning
   503 until Switch; tell marina staff the dashboard is read-only.
4. **Import** (`--dry-run`, then for real; local first, then live). Each
   target DB import runs in one transaction (9.6 MB source): a failed run
   leaves nothing, and a re-run first deletes everything under marinas
   whose `sidon_owner_id` is in the map (safe only before Switch).
   Mapping:
   - marinas (+ layout), pontoons, berths, price tiers (date part in the
     property timezone), doc requirements (`schema` → `fields`), contract
     templates and signatures (skipped with their booking), POIs, images
     (copied into OTA's public store).
   - **Berths:** status `available` → `active`, `maintenance` →
     `maintenance`, `occupied`/`reserved` → `active` (occupancy becomes a
     booking, below). A berth whose `overlay_id` points at another
     owner's overlay (80 berths) → `pontoon_id` NULL, reported.
   - **Bookings:** `source = 'import'`, `total_price = amount_cents/100`,
     `currency` = the property's, `created_at` preserved,
     `payment_status = 'none'`, Sidon PI → `legacy_payment_intent_id`
     (Connect accounts; any refund is done in Stripe's dashboard),
     `hold_expires_at` NULL. `declined`/`cancelled` imported as-is.
     `pending` past `expires_at`, with NULL `expires_at`, or with
     departure before the cutover date → `cancelled` (no email). A
     booking whose `berth_id` has no berth (23) or that violates the
     overlap constraint → skipped and reported.
   - **Occupancy:** each berth with Sidon `status` `occupied`/`reserved`,
     not covered today by an imported booking → an open-ended `confirmed`
     booking (`source = 'import'`, arrival = cutover date,
     `contact_name = guest_name`, or 'Reserved' when blank).
   - **Documents:** linked to an imported booking (any status) → copied
     into the private store at
     `marina-docs/{property_id}/{booking_id}/sidon-{document_id}.{ext}`
     (deterministic, overwrite allowed) and inserted, then subject to
     retention; unlinked or orphaned → copied to `marina-docs-archive/`,
     listed, purged after 90 days.
   - **Messages** → a JSON export in the private archive.
   Output: per-marina counts, source vs imported vs skipped, with
   reasons.
5. **Verify:** counts reconcile; each consumer's staging deploy renders
   through its forwarder; an end-to-end guest booking on Pirates Bight
   with Stripe test keys (hold → card → pending → booking page → upload →
   verify → contract → confirm → capture), plus guest cancel, sweep
   expiry, and the closed-tab case.
6. **Switch:**
   - Merge the consumer PRs; deploy the new dashboard (`/marina`,
     `/marina-bookings`, `/marina-setup`, the active-marina nav rule) and
     the rewritten `list_marina_bookings`.
   - Delete the interim `GET /api/marina/sidon-bookings` (Sidon is about
     to return 410).
   - sidon-marina: dashboard routes redirect to the OTA dashboard;
     `/api/marina/*` returns 410 with a pointer. Archive the Tap to Pay
     app.
7. **Clean up:**
   - Once verified, delete Sidon's marina-owned public document blobs
     (`marina-docs/*`, the 32 post-split guest uploads). **Leave every
     `sailor-docs/*` blob in place:** those are the live files of
     sidon-ai's sailor wallet (552 of its 554 rows); OTA's private copies
     don't orphan them.
   - After two weeks, first deploy (OTA and dashboard) the removal of
     every reader of the interim columns: `GET/PUT /api/property/me`
     fields (`sidon_marina_id`, `sidon_marina_key_set`), `PUT
     /api/marina/key` and `POST /api/marina/key/clear` with controllers
     and Swagger, `update_property`'s `sidon_marina_id` argument and
     `get_property`'s description, the dashboard's Settings Sidon
     fields, the `sidebar-modules-widget` `sidon_marina_id` rule and the
     interim marina client. Only then migrate away
     `property.sidon_marina_id`, `property.sidon_marina_key`,
     `marina.sidon_owner_id` and `marina_booking.legacy_payment_intent_id`.
   - Keep Sidon's DB read-only for 90 days, then delete it. Tag and
     shelve sidon-marina's AI branch (`88ee507`).

**Rollback** (until step 7): revert the consumer PRs and the dashboard
release, restore the interim proxy, lift the freeze. Bookings made in
OTA in between would need re-entering in Sidon by hand (none expected).

## Testing approach

- Assert-based checks (`node scripts/check-marina.js`, against the local
  DB in a transaction rolled back at the end):
  - `priceStay`: tier coverage edges (stay crossing `valid_to`), smallest
    fitting tier, beam limit, per-metre vs fixed, no price → null,
    2-dp rounding;
  - overlap constraint: adjacent stays allowed, overlaps rejected,
    open-ended blocks later dates, cancelled rows don't block;
  - lifecycle: guest can't set status; hold → pending only via a
    verified PI or the confirm link; the sweep cancels expired guest
    hold/pending exactly once, never staff/import rows, and promotes a
    swept hold whose PI is `requires_capture`; confirm racing the sweep
    (two connections) never captures a cancelled booking; auto-confirm
    only when every condition holds, including the no-requirements case;
  - booking token: wrong/missing token → 404; constant-time compare;
  - documents: file and metadata routes reject the API key; uploads
    reject wrong magic bytes, > 4 MB, a `hold` booking, an 11th file;
  - currency: confirm-payment accepts Stripe's lowercase currency.
- Widget package: a check for `createMarinaProxy`: path/method/header
  allowlist (a staff path, a cookie, an `Authorization` header dropped or
  404); `%252e%252e/%252e%252e/bookings` and `x%252f..%252f..%252fmcp`
  return 404 without calling fetch; `X-Client-Ip` overwrites an inbound
  value; the multi-key map selects by slug.
- Import: the dry-run report reconciles source counts; a re-run is
  idempotent (delete-and-reinsert under mapped `sidon_owner_id`s,
  deterministic blob paths).
- Dashboard: Playwright on `/marina`, `/marina-bookings`,
  `/marina-setup` (existing `tests/` setup with Clerk impersonation).
- End-to-end on Pirates Bight with Stripe test keys (Cutover step 5).

## Order of work

Phase 1 is large; it is expected to become several implementation plans
that all land before the single cutover: (A) OTA backend, (B) widget 1.0
+ `astro-proxy`, (C) dashboard, (D) import + consumer PRs + cutover.

1. Schema migration + `schema.sql` + `marinaPricing.js` + checks; move
   the interim proxy to `/sidon-bookings`.
2. Staff CRUD routes (+ body limits, label rename rewrite), Swagger, MCP
   tools.
3. Guest routes: lifecycle, concurrency, sweep, guards, client identity,
   enquiries route, emails (locale, QR), Ably.
4. Payments: publishable key setting + mode checks, PI hold / confirm /
   capture / release / refund, closed-tab sweep check.
5. Documents: two blob stores, raw upload, extraction, stream, retention
   + archive purge job; contracts (Sidon merge fields); auto-confirm.
6. Event inquiry `marina_id` + AI availability tool and venue facts.
7. Widget 1.0.0: OTA guest API, booking-page mode, unchanged element
   contract; `astro-proxy` (forwarder + server client) with its checks.
8. Dashboard pages and Settings.
9. Import script (`--map`, `--dry-run`); rehearse against local until the
   report is clean.
10. Consumer PRs (table above), including the sidon-marina client-site
    rewrite, the sidon-ai removal PR and the sidon-marina freeze / 410 /
    redirect deploys; Clerk org provisioning; run the cutover.

## Later phases (separate specs)

- **Phase 2, one guest record:** populate `marina_booking.guest_id`
  (guest per property by email), sailors as OTA guests, then Folio
  across modules (`project_folio_concept`); add marina to
  `review_candidate`.
- **Backlog:** the sidon-ai sailor app's future (OTA guest client or
  retire) and its public `sailor-docs/*` wallet files; Tap to Pay for
  marinas (spa's `spaPayments` card_present flow is the model); a
  drag-and-drop map editor; token metering for document extraction;
  deleting the stale `marina_*` tables in sidon-ai's old DB.
