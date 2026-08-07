# Table bookings admin UI — Design

## Context

Staff currently have no UI for managing restaurant table bookings — every
interaction with `routes/restaurant.js` happens via direct API calls (curl,
or whatever the caller builds themselves). This is a v1 internal dashboard
so staff can view, create, edit, and cancel reservations without touching
the API directly.

The restaurant module is authenticated differently from the rest of this
API: `routes/restaurant.js`'s reservation endpoints require a single
shared `X-Api-Key` for the whole deployment (`middleware/apiKey.js`), not
the per-staff JWT that `guest`/`booking` use — because `restaurant` and its
child tables carry no `property_id` at all (confirmed in `schema.sql`).
There's no restaurant-level permission model to build on.

Separately, this project's `api_user` table and `POST /api/auth/login`
already provide individual staff accounts (email/password → JWT, 24h
expiry, `{id, role, property_id}` claims) — currently used to gate the
hotel-booking JWT routes. This design reuses those accounts purely as the
dashboard's login gate; it does not extend them with restaurant-specific
permissions.

## Goals

- Let logged-in staff view a restaurant's reservations for a given date,
  create a new reservation, and edit/cancel an existing one.
- Keep the shared `X-Api-Key` server-side only — it must never reach the
  browser.
- Ship as a separate project from this API, deployed on Vercel.

## Non-goals (explicitly out of scope for v1)

- Restaurant-level access control. Any staff member who can log in can
  view/manage any restaurant's reservations — the OTA backend itself has
  no such permission model today either; the shared API key already grants
  that scope to any caller holding it.
- Managing tables, service periods, or seasonal closures. V1 is
  reservations only.
- Real-time sync between staff sessions. Another person's edit won't
  appear until the page/list is refetched.
- Any change to this API (`OTA` repo). This is purely a new consumer of
  the existing endpoints; no backend routes, auth, or schema change.
- Independently verifying the staff JWT's signature in the new project. It
  has no access to (and does not need) `JWT_SECRET` — see Auth below.

## Architecture

A new, standalone repository (not part of this `OTA` repo) — Astro,
`output: 'server'`, deployed to Vercel via `@astrojs/vercel`. Interactive
pieces (the reservation list, cancel/edit actions, the new-reservation
form) are plain-JS client islands using `fetch()` — no React/Preact/etc.;
the interactions involved (a list, a couple of forms) don't need a
component framework.

Two projects, two deployments: this Astro app only ever talks to the OTA
API over HTTPS, the same way any other client would.

**Configuration** (Vercel environment variables for the new project):
- `OTA_API_BASE_URL` — e.g. `https://ota-u6ii.onrender.com`
- `OTA_API_KEY` — the shared restaurant-module key (same value as this
  API's `API_KEY` env var)

## Auth & the API-key proxy

- `/login`: a form posts credentials to the Astro app's own
  `POST /api/login`, which calls this API's `POST /api/auth/login`. On
  success, the returned JWT is stored in an httpOnly, `Secure`,
  `SameSite=Lax` cookie (`ota_session`), `maxAge` matching the JWT's 24h
  expiry — never exposed to client JS. On failure (`401` from the OTA
  API), the form re-renders with the error.
- Astro middleware runs on every page request: if `ota_session` is
  missing, or its (unverified, just base64-decoded) `exp` claim has
  passed, redirect to `/login`. This is a UX check only, not a security
  boundary — see below.
- `POST /api/logout` clears the cookie and redirects to `/login`.
- The shared restaurant-module key (`OTA_API_KEY`) is a Vercel environment
  variable read only inside this Astro app's own server-side `/api/*`
  routes. The browser never calls the OTA API directly and never sees this
  key — it only ever calls this app's own `/api/*` routes, which then call
  the OTA API server-to-server.
- Why not verifying the JWT signature is fine: this app has no
  `JWT_SECRET` and doesn't need one. The actual authorization boundary for
  every restaurant-module write is the OTA backend's own `X-Api-Key`
  check, which happens regardless of what's in the session cookie. The
  cookie's only job here is letting this app decide when to show the login
  page vs. the dashboard.

## Astro server API routes (the proxy layer)

Each of these checks `ota_session` first (`401 { error: "Not authenticated" }`
if missing/expired), then calls the OTA API with header
`X-Api-Key: process.env.OTA_API_KEY`, and forwards the OTA response's
status and body back to the client largely as-is:

| Method | Path | Proxies to |
|---|---|---|
| POST | `/api/login` | `POST {OTA_API_BASE_URL}/api/auth/login` (no API key — uses the submitted credentials) |
| POST | `/api/logout` | (local only — clears the cookie, no OTA call) |
| GET | `/api/restaurants` | `GET {OTA_API_BASE_URL}/api/restaurant` |
| GET | `/api/restaurants/:id/reservations?date=` | `GET {OTA_API_BASE_URL}/api/restaurant/:id/reservations?date=` |
| POST | `/api/restaurants/:id/reservations` | `POST {OTA_API_BASE_URL}/api/restaurant/:id/reservations` |
| PATCH | `/api/restaurants/:id/reservations/:resId` | `PUT {OTA_API_BASE_URL}/api/restaurant/:id/reservations/:resId` |

`GET /api/restaurants` is public on the OTA side (no `requireApiKey`), so
this route doesn't send `X-Api-Key` when proxying it — but it still
requires a valid `ota_session` itself, since every one of this app's own
routes is gated the same way for consistency, regardless of what the
upstream endpoint requires.

Create and update bodies are passed through unchanged (`reservation_date`,
`start_time`, `party_size`, `contact_name`, `contact_email`,
`contact_phone`, `location`, `notes` for create; `status`, `notes`,
`contact_name`, `contact_email`, `contact_phone` for update). No
`table_id` field anywhere — the OTA backend auto-assigns the
smallest fitting table on create, and update never changes date/time/table
(confirmed in `controllers/restaurant.js`).

## Pages

- `/login` — email/password form.
- `/reservations` — the only real page in v1:
  - Server-rendered on first load: fetches the restaurant list and, for
    the first restaurant (or the one in a `?restaurant_id=` query param),
    today's reservations (or the date in `?date=`), so the page has
    content before any client JS runs.
  - A client island then takes over: restaurant selector and date picker
    (changing either refetches `GET /api/restaurants/:id/reservations` and
    replaces the table body — no full page reload), an inline
    "new reservation" form (submits to the `POST` route above; on success,
    appends the new row; on `400`/`409`, shows the OTA error message
    inline without clearing the form), and per-row "Cancel" (`PATCH` with
    `status: "cancelled"`) and "Edit" (opens an inline form for
    notes/contact fields, `PATCH`) actions.

## Error handling

- Client-side fetch wrapper used by all island code: a `401` response from
  any of this app's `/api/*` routes redirects to `/login`. A
  `400`/`404`/`409` shows the response body's `error` message inline next
  to the relevant form or row — no navigation, form input preserved.
- Astro API routes: any network failure reaching the OTA API returns
  `502 { error: "Upstream API unavailable" }`. Every other OTA response
  (status + JSON body) is forwarded through unchanged.

## Testing approach

Manual browser walkthrough (this project has no automated test framework
for the API either, per its existing specs):

1. Log in with valid `api_user` credentials → redirected to
   `/reservations`; confirm via devtools that `ota_session` is `httpOnly`
   (not readable from `document.cookie`).
2. Log in with bad credentials → inline error, no cookie set, stays on
   `/login`.
3. View reservations for a restaurant/date known to have data (from the
   existing Neon-backed seed data) → list matches what
   `GET /api/restaurant/:id/reservations` returns directly.
4. Create a reservation via the form → appears in the list without a page
   reload; confirm against the OTA API directly that it was actually
   created.
5. Trigger each validation path (closed day, outside service hours, no
   tables available for the requested time/party size) → inline error
   shown, table not falsely updated.
6. Cancel a reservation → row shows `cancelled` without reload; confirm
   via the OTA API directly.
7. Clear/expire the session cookie, then trigger any action → `401` →
   client redirects to `/login`.
8. Check the browser's Network tab across all of the above → confirm
   `OTA_API_KEY` never appears in any request the browser can see; the
   browser only ever calls this app's own `/api/*` routes.
9. Deploy to Vercel and repeat steps 1–4 against the deployed instance,
   talking to the real OTA API (`https://ota-u6ii.onrender.com`, Neon-backed).
