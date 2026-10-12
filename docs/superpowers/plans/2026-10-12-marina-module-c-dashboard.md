# Marina module, plan C: operator dashboard + widget 1.1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marina staff run berths, bookings, documents, contracts and pricing from the OTA dashboard (`/marina`, `/marina-bookings`, `/marina-setup`, a Settings Marina section), on top of `@forgebuild/sidon-booking-widget@1.1.0` (staff map mode, a signed-in-staff forwarder, client timeout, booking-page locale) and a handful of additive OTA fixes — all built, tested end to end against local OTA, and safe to deploy before Switch, but not pushed, published or deployed.

**Architecture:** Task 1 adds the small, additive OTA changes the dashboard needs (live republish after document/contract events, the agreed contract text for staff, `?include_inactive=1`, validation fixes). Tasks 2–4 cut widget 1.1.0: `createMarinaProxy` gains an `auth` callback so the dashboard's own `/api/marina/guest/[...path]` route forwards the staff member's Clerk bearer through the same tested path guard; `<sidon-berth-map mode="staff">` makes every listed berth clickable and paints occupancy; the booking page follows the booking's own language. In the dashboard (Tasks 5–14) the widget is vendored as a tarball like hotal-ui, while the untouched interim `/marina` keeps the 0.4.17 element through an npm alias so the page still works for Pirates Bight until Switch. Every page is a plain `.astro` + one TS client script calling OTA directly with `apiFetch`; all date, CSV, tile, live-update and panel logic lives in one pure module (`src/lib/marina-logic.ts`) checked by a Node assert script; UI is checked with Playwright on the existing Clerk-impersonation setup. Task 15 drives the whole staff flow against local OTA.

**Tech Stack:** Express/pg (OTA), Svelte 5 custom elements + Vite 8 + TypeScript 6 (widget; Node 25 native type stripping for checks), Astro 7 (`output: 'server'`, `@astrojs/vercel`) + `@clerk/astro` 4 (dashboard; no UI framework, hand-written DOM with `escapeHtml`), Ably Realtime (token auth via a dashboard route), Stripe (per-property keys, no Connect), Playwright 1.62 (`tests/`, one worker) and Playwright MCP for the end-to-end task.

**Spec:** `docs/superpowers/specs/2026-10-10-ota-marina-unification-design.md` (amended 2026-10-12) — sections "Dashboard (ota-table-bookings)", "Staff routes", "Live updates", "Payments", "The forwarder, the server client and the widget" (last paragraph: the dashboard's own forwarder), "Cutover" steps 6–7, "Testing approach". Binding decisions: `O/.superpowers/plancd/rulings-c.md`, restated as R1–R30 below. Survey reports: `O/.superpowers/plancd/dashboard.md`, `ota-staff-api.md`, `widget-staff.md`.

## Global Constraints

- Repos: `O` = `C:/Users/robert/source/repos/OTA`, `W` = `C:/Users/robert/source/repos/sidon-booking-widget`, `D` = `C:/Users/robert/source/repos/ota-table-bookings`. Task 1 in `O`; Tasks 2–4 in `W`; Tasks 5–14 in `D`; Task 15 uses all three.
- Branch: `main` in every repo, committed directly (no worktree, no feature branch). Nothing is pushed, published to npm, or deployed (R2).
- OTA changes are additive and need no migration: OTA `main` auto-deploys on push, so every OTA commit must be safe to deploy at any time.
- Widget version `1.1.0`; tarball `forgebuild-sidon-booking-widget-1.1.0.tgz`; D dependency `"@forgebuild/sidon-booking-widget": "file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz"`; interim alias `"sidon-booking-widget-legacy": "npm:@forgebuild/sidon-booking-widget@0.4.17"`.
- Proxy timeout default `60_000` ms (unchanged); `createMarinaClient` timeout default `30000` ms; signed-out forwarder answer `401 {"error":"Not signed in"}`.
- Staff map: `mode="staff"`, `from` = property-today, `to` = property-tomorrow (YYYY-MM-DD), `api-origin` omitted (same-origin forwarder).
- Property cookie `hotal-property-id` → upstream `x-property-id` only when the cookie value is a UUID; nothing in plan C sets the cookie (R1).
- Live channel `property:{id}:marina-bookings`, events `new-booking` and `booking-status-changed`; token route `D/src/pages/api/marina/ably-auth.ts`.
- Bookings table page size `50`; tile window `?from=<yesterday>&to=<tomorrow>&limit=500`; CSV max `2000` data rows; image upload max `4 * 1024 * 1024` bytes.
- "Today" in D = the property's day: `propertyToday(property.timezone)`, never the viewer's `todayStr()`.
- No `{@html}` / `innerHTML` of server text without `escapeHtml`; error toasts use `showToast` (textContent).
- Gates: O — `node -r dotenv/config scripts/check-marina.js` and `node -r dotenv/config scripts/check-marina-http.js` end `all passed`; W — `npm test`, `npm run check` (0 errors), `npm run build`; D — `node scripts/check-marina.ts` (prints `check-marina: ok`), `npm run build`, the task's Playwright spec.
- Commits: explicit paths only (never `-A`/`.`), message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Viewer and marina in different time zones near midnight** (staff in London at 23:30 looking at a marina in `Europe/Rome`; an Antigua marina viewed from Italy in the morning; month and year ends; a DST change day): tiles, the map's night and the side panel's "current booking" must all use the marina property's day, and `departure = today` must still count as a departure. Pinned in Task 8 (`propertyToday`, `addDays` in `D/scripts/check-marina.ts`, exact asserts: `propertyToday('Europe/Rome', new Date('2026-10-12T22:30:00Z'))` → `'2026-10-13'`; `propertyToday('America/Antigua', new Date('2026-10-13T02:00:00Z'))` → `'2026-10-12'`; DST end day `propertyToday('Europe/Rome', new Date('2026-10-25T00:30:00Z'))` → `'2026-10-25'`; `propertyToday('Not/AZone', new Date('2026-10-12T23:30:00Z'))` and `propertyToday('', …same)` → `'2026-10-12'` (UTC); `addDays('2026-12-31', 1)` → `'2027-01-01'`; `addDays('2026-03-01', -1)` → `'2026-02-28'`; `addDays('2026-03-28', 2)` → `'2026-03-30'` (across the Rome DST start); `addDays('2026-10-24', 1)` → `'2026-10-25'`) and Task 13 (`tileCounts`, `matchBerthPanel` with yesterday/today/tomorrow fixtures, including `departure === today` counted as a departure and not on berth).
- **Spreadsheet CSVs as marinas really export them** (UTF-8 BOM from Excel, CRLF, quoted fields containing commas, newlines and `""`, Italian-locale `;` separators with decimal commas `12,5`, trailing blank rows, a pontoon name typo, 2001 rows, a blank `status` cell): parsed client-side into exactly the rows OTA's bulk route accepts, with row numbers that match OTA's `row N:` errors. Pinned in Task 7 (`parseCsv`, `csvToBerthRows`).
- **Deploying the dashboard before Switch**: Pirates Bight (has `sidon_marina_id`, no OTA marina) must keep today's interim `/marina` with its working Sidon map on the 0.4.17 element and never call `/api/marina/guest/`; a property with neither sees no Marina nav; a property with ≥1 active OTA marina gets the new dashboard and never calls Sidon. The test account has no Sidon id, so the Pirates Bight case is simulated with Playwright `page.route` (fulfil `GET /api/property/me` with `sidon_marina_id: 'pw-sidon'`, `GET /api/marina/marinas` with `[]`, `GET /api/marina/sidon-bookings` with `[]`) and asserts that `customElements.get('sidon-berth-map')` is defined, `#marina-map` holds the element with `api-origin="https://marina.sidonmarine.uk"`, and no request URL contains `/api/marina/guest/`. Pinned in Task 5 (`tests/marina-interim.spec.ts`, interim + nav cases) and Task 13 (branch cases added to the same spec: with a real active OTA marina, `#marina-dashboard` shows and no request goes to `marina.sidonmarine.uk`).
- **The staff forwarder as a trust boundary**: an inbound `Authorization`, `X-Api-Key`, `X-Property-Id` or cookie never reaches OTA; only a UUID `hotal-property-id` cookie becomes `x-property-id`; a signed-out caller gets JSON 401 (not Astro's HTML page); traversal (`x/../bookings`, `%2e%2e`) is 404 before `auth` is even called; giving both or neither of `keys`/`auth` throws at construction. Pinned in Task 2 (`W/scripts/check-astro-proxy.ts`) and Task 5 (`staffProxyHeaders` in `check-marina.ts` + the forwarder smoke in `marina-interim.spec.ts`).
- **Live updates on a filtered, paged table, including events that don't change status**: a guest's upload or contract agreement and a staff verify/reject must reach the dashboard without a reload — OTA calls `afterChange` exactly once per event with auto-confirm off and `republish` never calls it for a hold; on the dashboard the event merges into its table row (`{...old, ...row}`) and an open detail dialog for that booking re-fetches its documents and signature (the staff list rows carry no `doc_count`, so the dialog — not a table column — is where document changes show). A row that leaves the active filter disappears and the page refills; a row arriving for another filter/page never lands on the wrong page. Pinned in Task 1 (`check-marina-http.js`: exactly one stubbed `afterChange(b, b)` call with `b.status !== 'hold'` per upload / verify / reject / agree; zero for `life.republish(<hold id>)`), Task 11 (`matchesFilter`, `liveAction`) and Task 12 (`refreshOpenMarinaBookingDialog` re-fetches).

---

## Binding contract

The rulings and shared interfaces every task below implements. Where a task's text and this section disagree, this section wins.

### Design rulings (binding — do not re-decide)

R1 No property switcher in plan C: every marina page assumes one active property per Clerk org. The marina map forwarder adds `x-property-id` only when a `hotal-property-id` cookie exists (no code sets it yet; the multi-property follow-up will).
R2 Nothing in plan C pushes, publishes or deploys. OTA `main` auto-deploys on push, so OTA commits wait for a user-approved push and must be safe to deploy at any time: additive only, no migration (if one were unavoidable: additive, release note "run on live before pushing").
R3 (C1) Staff map mode: attribute `mode` = `guest` (default) | `staff` on `<sidon-berth-map>`. Staff: QuickBookCard hidden; no `/availability` fetch; no LOA fit; every listed berth clickable (`sidon-berth-selected {berthId}` unchanged, deselect emits `{berthId: null}`); berths with payload `available: false` for `[from, to)` paint solid navy "occupied" in chart style and the existing occupied style in coastal; available ones paint as free; the selected berth stays highlighted. Maintenance and booked share one colour (no OTA payload change). `from`/`to` are reactive in staff mode; guest mode keeps reading them once.
R4 (C2) Exported element method `refresh()` refetches the map payload (Svelte 5 custom-element export; callers use `el.refresh?.()`).
R5 (C3) `fitBounds` runs only on the first successful data load (both modes; also stops a guest's date change resetting their zoom).
R6 (C4) `createMarinaProxy` gains optional `auth(context, slug)` as the alternative to `keys`: returns upstream headers to add (e.g. `{ authorization: 'Bearer …', 'x-property-id': … }`) or `null` → `401 {error:'Not signed in'}`. Exactly one of `keys` / `auth` (throw at construction otherwise). Path guard, method/header allowlists, timeouts and response rebuilding are shared unchanged. Inbound `Authorization` is never forwarded as-is — only what `auth` returns.
R7 (C5) `createMarinaClient` gains `timeoutMs` (default 30000): timeout → `MarinaClientError` status 504; network failure → 502.
R8 (C6) Booking-page language: `<sidon-booking-widget booking-id>` without a `locale` attribute uses the booking's own `locale` from OTA (`booking.locale`) for labels; an explicit `locale` attribute wins.
R9 (C7) Neutral "expired" hero wording in en/it/fr/es that doesn't blame the guest (covers a lapsed hold and a request the marina never answered).
R10 (C8) Version 1.1.0; README (staff mode, `auth` option, timeout, booking locale); `elements.d.ts` (`mode`, `refresh`); `npm test` / `npm run check` / `npm run build` green; `npm pack --dry-run` clean. Not published.
R11 (C9) The other plan B deferred minors stay deferred.
R12 (C10) OTA publishes `booking-status-changed` with the joined row after a document upload, a document verify/reject, and a contract agreement.
R13 (C11) Staff `GET /api/marina/bookings/:id` `signature` includes `rendered_body`.
R14 (C12) List routes for marinas and their children accept `?include_inactive=1` (all statuses) so the dashboard can reactivate rows.
R15 (C13) Validation: negative prices/lengths → 400; tier `valid_from > valid_to` → 400; `contact_phone` > 30 chars → 400 (not 500); marina `email` format checked; image over the limit → 413 JSON.
R16 (C14) Fix the misleading "staff behaviour on reads" comment in `marinaGuest.js:16-18`.
R17 (C15) No booking move/re-date action (cancel and recreate). No admin-gating changes. No `contract-fields` route (template warnings shown after save, from the response).
R18 (C16) Checks for R12–R15 in `scripts/check-marina-http.js` / `scripts/check-marina.js`, failing first; Swagger updated.
R19 (C17) The widget reaches D as a vendored tarball: `D/vendor/forgebuild-sidon-booking-widget-1.1.0.tgz`, `"@forgebuild/sidon-booking-widget": "file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz"`. (Moving to npm after publish is a later one-line change.)
R20 (C18) Nav: one "Marina" item. `/marina-bookings` and `/marina-setup` are reached from `/marina`'s page-header buttons; `isActive()` treats `/marina*` as Marina. The item shows when the property has `sidon_marina_id` (interim) OR ≥1 active OTA marina (`GET /api/marina/marinas`).
R21 (C19) `/marina` branches: ≥1 active OTA marina → the new dashboard; otherwise the existing interim page unchanged. This is what makes plan C safe to deploy before Switch.
R22 (C20) `/marina`: stat tiles (arrivals today, departures today, on berth now, pending approvals) from `GET /api/marina/bookings?from=<yesterday>&to=<tomorrow>` (`from` filters `departure > from`), "today" in the PROPERTY timezone (`property.timezone` + Intl); a marina selector when the property has >1 marina; `<sidon-berth-map mode="staff" from=<today> to=<tomorrow>>` via the dashboard forwarder; clicking a berth opens a side panel with its current and next bookings (`GET /api/marina/bookings?berth_id=…`, berth id from `GET /api/marina/marinas/:id/berths` by label) and quick actions (open detail dialog; confirm/decline when pending); when the map shows a berth occupied but no booking matches, the panel says it is held by a guest checkout or in maintenance. Live refresh of tiles + map + panel on the Ably channel.
R23 (C21) `/marina-bookings`: filterable table (status, marina, berth, date range), 50 per page with prev/next from `{total, data}`; actions confirm / decline / cancel (refund or keep, when payment held/captured) / end open-ended (pick departure) / send guest link; staff create dialog (berth, dates or open-ended, contact, boat, optional total override, status pending|confirmed); booking detail dialog with documents (view file via bearer fetch → blob URL in a new tab, plus a download link with the file name; verify/reject with notes), contract (agreed text + time), payment status + `payment_error`. Live refresh via `D/src/pages/api/marina/ably-auth.ts` (golf ably-auth pattern) on `property:{id}:marina-bookings`. No assumption of ≤10 documents per booking.
R24 (C22) `/marina-setup` tabs (marinas themselves live in Settings, R26): Berths (inline-autosave grid, restaurant Tables pattern; deactivate/reactivate; CSV import), Pontoons (SVG file read client-side + numeric SW/NE corners + rotation; preview = the staff map), Price tiers, Document requirements, Contract templates (show `warnings.unknown_placeholders` after save), POIs, Images (upload to the public store). Inactive rows shown greyed with Reactivate (R14).
R25 (C23) CSV: header row with OTA bulk-berth field names `label,pontoon,length_m,min_length_m,beam_m,depth_m,price_per_night,price_mode,lat,lng,rotation,status`; `pontoon` matched by pontoon name within the marina (unknown → row error); blank → null; max 2000 rows; parsed client-side with no dependency (small RFC-4180-ish parser handling quoted fields); sent to `POST …/berths/bulk`; OTA's `row N: <col> <msg>` errors shown as-is.
R26 (C24) Settings: a Marina section (list + add/edit marinas: name, slug, location lat/lng, contact email/phone, response window hours, auto-confirm, booking URL, status) on the Settings Websites-tab list/edit pattern. The Stripe publishable key field goes beside the secret key in the Clerk org-profile modal. The Sidon id/key fields stay until plan D.
R27 (C25) Enquiries: a marina enquiry shows its marina name in the reply/detail dialog (dashboard-only) and hides "Convert to booking" and the restaurant select. No hotal-ui release.
R28 (C26) Status pills for `hold`/`pending`/`confirmed`/`declined`/`cancelled` and payment `held`/`captured`/`released`/`refunded`/`none` use existing colour mixes (no new percentages).
R29 (C27) Tests: Playwright specs for `/marina`, `/marina-bookings`, `/marina-setup` and the Settings marina section on the existing `tests/` setup (Clerk impersonation, one worker, local OTA). Each run creates its marina through the UI with a fresh slug and deactivates it at the end; admin-only saves branch on 403. The last task is an end-to-end run against local OTA with the plan B demo seed + a staff flow (create, confirm, upload via guest page, verify document, cancel with refund using Stripe test keys if present).
R30 (C28) Sidon field removal (Settings Sidon form, the `sidon_marina_id` nav rule, the interim marina client and its legacy alias) is plan D (cutover step 7), not plan C.

Architect's implementation notes (consequences of the rulings above, not new decisions):
- N1 (R21 + R19) Vendoring 1.1.0 would break the interim page: 1.x calls `/api/marina/guest/:slug` on its `api-origin`, which Sidon doesn't serve. The interim page therefore imports the 0.4.17 element through the npm alias `sidon-booking-widget-legacy`, and from Task 13 each `/marina` branch loads only its own element with a dynamic `import()` (both packages define the tag `sidon-berth-map`, so they must never load on the same page). Plan D removes the alias with the interim page.
- N2 (R22) "Pending approvals" counts every pending request for the selected marina, read as `total` from the same route: `GET /api/marina/bookings?status=pending&marina_id=<id>&limit=1`. The other three tiles come from the `[yesterday, tomorrow)` window call.
- N3 (R25) OTA's bulk validator rejects `null` for `status` and `price_mode`, so a blank cell in those two columns is omitted from the row (insert takes the DB default; an upsert keeps the stored value). Every other blank cell is `null`.

### Shared interfaces (exact names)

#### OTA (`O`, Task 1)

`O/src/lib/marinaLifecycle.js` — new export, added to `module.exports`:
```js
// Re-sends the joined row to the staff feed after a change that isn't a
// status transition (document upload/verify/reject, contract agreed). Calls
// module.exports.afterChange(b, b): same status, so it publishes
// 'booking-status-changed' (never for a hold) and no guest update. Never throws.
async function republish(bookingId) // -> Promise<void>
```
Body: `try { const b = await q.joinedBooking(pool, bookingId); if (b && b.status !== 'hold') module.exports.afterChange(b, b); } catch (err) { console.error('Marina republish failed:', err.message); }` (the explicit hold skip duplicates `afterChange`'s own guard so a check that stubs `afterChange` can observe "never for a hold") — `afterChange(b, b)` publishes `booking-status-changed` when `b.status !== 'hold'`, sends no guest update and no email (`emailKind` returns null when the status is unchanged). Called with `await life.republish(<booking id>)` (after the write, before the response) from `uploadDocument` and `updateDocument` (`O/src/controllers/marinaDocuments.js`; `updateDocument` only when a row was updated) and `agreeContract` (`O/src/controllers/marinaGuest.js`, only when the signature row was inserted). Checks observe it by stubbing `life.afterChange` (existing pattern, `check-marina-http.js:359`) with `auto_confirm` off on the fixture marina (a verify that auto-confirms legitimately adds a second, status-changing event). `updateDocument` and staff `getBooking`'s bearer-only bits are driven by calling the controller with a fake req/res (`call(fn, req)` pattern, `scripts/check-multi-property-http.js:18-26`, `auth_method: 'bearer'`), since the HTTP check has no Clerk token.

`GET /api/marina/bookings/:id` → `signature: { template_id, signer_email, agreed_at, rendered_body } | null`.

`?include_inactive=1` (exactly the string `1`; anything else = today's behaviour) on `GET /api/marina/marinas` and `GET /api/marina/marinas/:marina_id/{pontoons|berths|price-tiers|doc-requirements|contract-templates|pois|images}` → every status, same order.

`O/src/controllers/marinaCatalogue.js` validators (errors read `"<col> <msg>"`, row-prefixed in bulk):
```js
nonNeg: (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : fail('must be a number, 0 or more')),
email:  (x) => (x == null || x === '' ? null : typeof x === 'string' && x.length <= 255 && EMAIL_RE.test(x) ? x : fail('must be an email address')),
// EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/ (same as marinaGuard.js)
```
- `nonNeg` on berths `length_m, min_length_m, beam_m, depth_m, price_per_night` and price tiers `max_length_m, max_beam_m, price_per_night, price_per_month, price_per_year`. `MARINA_COLS.email` → `v.email`.
- Price tiers: create and update (merged with the locked row) with `valid_from > valid_to` → `400 {error:'valid_to must be on or after valid_from'}`.
- Staff `POST /api/marina/bookings` and the edit path of `PUT /api/marina/bookings/:id`: `contact_phone` longer than 30 → `400 {error:'contact_phone must be up to 30 characters'}`; `boat_length_m` / `boat_beam_m` negative or non-numeric → `400 {error:'boat_length_m must be a number, 0 or more'}` (resp. `boat_beam_m …`).
- `O/src/routes/marina.js`: `rawImageSafe` wraps `rawImage` like `rawDocSafe`: body-parser 413 → `413 {error:'Images are limited to 4 MB'}`.

#### Widget (`W`, Tasks 2–4)

`W/src/astro-proxy.ts` (stays one self-contained, import-free, erasable-TS file):
```ts
export type MarinaKeys = string | Record<string, string>;
export interface AstroLikeContext { request: Request; params: Record<string, string | undefined>; readonly clientAddress: string; }
export type AstroLikeRoute = (context: AstroLikeContext) => Promise<Response>;
export type MarinaProxyAuth<C extends AstroLikeContext = AstroLikeContext> =
  (context: C, slug: string) => Promise<Record<string, string> | null> | Record<string, string> | null;
export interface MarinaProxyOptions<C extends AstroLikeContext = AstroLikeContext> {
  otaBaseUrl: string;
  /** Site rail: one key or slug → key. Give this or `auth`. */
  keys?: MarinaKeys;
  /** Staff rail: upstream credential headers for this request; null → 401 {error:'Not signed in'}. */
  auth?: MarinaProxyAuth<C>;
  timeoutMs?: number; // default 60_000
}
export function createMarinaProxy<C extends AstroLikeContext = AstroLikeContext>(options: MarinaProxyOptions<C>): (context: C) => Promise<Response>;
// throws Error('createMarinaProxy: give exactly one of keys or auth') unless exactly one of keys/auth is !== undefined.
// Order per request: method check → path guard → URL prefix check → credentials (auth(context, segments[0]) or keyFor) → body → fetch.
// auth headers are set after the REQUEST_HEADERS allowlist; x-api-key is never set on the auth rail.

export interface MarinaClientOptions { otaBaseUrl: string; keys: MarinaKeys; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; /* default 30000 */ }
// each attempt: fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }) in try/catch:
//   err.name === 'TimeoutError' → throw new MarinaClientError('Booking service timed out', 504)
//   any other rejection        → throw new MarinaClientError('Booking service unavailable', 502)
```

`W/src/lib/ota.ts` additions (pure; tested in `scripts/check-ota.ts`):
```ts
// Guest: free and fits this LOA (the set GET availability returns). Staff: any listed berth.
export function berthPickable(b: Pick<Berth, 'status' | 'lengthM' | 'minLengthM' | 'beamM'>, loa: number, staff: boolean): boolean;
// Booking-page labels: a non-empty locale attribute wins, else the booking's own locale, else 'en'.
export function viewLang(attr: string | null | undefined, bookingLocale: BookLang | null | undefined): BookLang;
```

`<sidon-berth-map>` (`W/src/BerthMap.svelte`): new prop `mode: { attribute: 'mode', type: 'String' }`, `mode?: 'guest' | 'staff'` (default `'guest'`), `const staff = $derived(mode === 'staff')`; `export function refresh(): void` (bumps a `reload` counter read by the map-payload effect). Staff mode: availability effect returns early (`available = null`), `onBerthClick` skips the availability guard, `.sbm-card-slot` not rendered, an effect re-reads `fromAttr`/`toAttr` into `from`/`to`.
`W/src/components/BerthMapView.svelte`: new prop `staff?: boolean` (default `false`); `const OCCUPIED = $derived({ fillColor: navy, fillOpacity: 0.85, strokeColor: navy, strokeOpacity: 1, strokeWeight: 1.6 })` used for unavailable berths in staff chart style; `entry.pickable = berthPickable(entry.berth, loa, staff)`; coastal staff: listed berths get `data-pick="1"` and an injected last rule `[data-berth-id][data-pick="1"] { pointer-events: auto; cursor: pointer; }`; no `data-fit` in staff mode; a component-level `let fitted = false` gates both `fitBounds` calls.
`W/src/elements.d.ts` `SidonBerthMapElement`: `mode?: 'guest' | 'staff';` and `readonly refresh?: () => void;`.

Booking page (`W/src/BookingWidget.svelte`, `W/src/components/BookingView.svelte`): `BookingWidget` prop `locale` default becomes `''` (the wizard still uses `langOf(locale)`, i.e. `'en'` when absent; the one place that passes the raw string on, `<Summary … {locale}>` at `BookingWidget.svelte:536`, gets `locale={locale || 'en'}` because `toLocaleDateString('')` throws; `PaymentStep`'s `locale={lang}` at `:561` and the `locale: lang` at `:394` already use the derived `lang` and stay); `BookingView` prop `lang: BookLang | null` (null = follow the booking); inside BookingView `const shownLang = $derived(viewLang(lang, view?.booking.locale))` replaces `lang` in EVERY use (labels `getLabels(shownLang)`, date/time formatting, `formatMoney`, the Stripe `locale`, and the `lang` passed to `DocumentsSection` / `ContractSection`); BookingWidget passes `lang={locale ? lang : null}` at both `<BookingView>` sites (`BookingWidget.svelte:523`, booking-page mode, which also serves a resumed session; `:565`, wizard step 3). `adaptBooking` already yields `booking.locale` as a `BookLang` (`langOf(raw.locale)`).

`W/src/lib/i18n.ts` `hero.expired` (exact copy):
- en: eyebrow `Booking expired`, title `This booking has expired`, body `This booking expired before it was confirmed, so the berth was released. You're welcome to book again.`
- it: `Prenotazione scaduta`, `Questa prenotazione è scaduta`, `La prenotazione è scaduta prima di essere confermata, quindi il posto barca è stato liberato. Puoi prenotare di nuovo quando vuoi.`
- fr: `Réservation expirée`, `Cette réservation a expiré`, `La réservation a expiré avant d'être confirmée, l'anneau a donc été libéré. Vous pouvez réserver à nouveau.`
- es: `Reserva caducada`, `Esta reserva ha caducado`, `La reserva caducó antes de confirmarse, así que el amarre quedó libre. Puedes volver a reservar cuando quieras.`

#### Dashboard (`D`, Tasks 5–14)

`D/src/lib/marina-logic.ts` — pure (type-only imports at most; erasable TS; no DOM, no `import.meta.env`), imported extensionless by app code (`'../lib/marina-logic'`) and as `../src/lib/marina-logic.ts` by `D/scripts/check-marina.ts`. Each task adds its own exports, failing-check first:
```ts
// Task 5
export function isUuid(s: unknown): s is string;                       // /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function staffProxyHeaders(token: string | null | undefined, propertyCookie: string | null | undefined): Record<string, string> | null;
//   null when !token; else { authorization: `Bearer ${token}` } plus 'x-property-id': propertyCookie when isUuid(propertyCookie)
export type MarinaStatus = 'hold' | 'pending' | 'confirmed' | 'declined' | 'cancelled';
export type PaymentStatus = 'none' | 'held' | 'captured' | 'released' | 'refunded';
export interface MarinaRow {                                           // GET /api/marina/marinas row (subset read by D)
  id: string; name: string; slug: string; phone: string | null; email: string | null;
  lat: number | null; lng: number | null; response_window_hours: number; auto_confirm: boolean;
  booking_url: string | null; status: 'active' | 'inactive';
}
export interface StaffBookingRow {                                     // list row; Ably/GET rows are supersets (merge by id)
  id: string; marina_id: string; marina_name: string; berth_id: string; berth_label: string;
  contact_name: string; contact_email: string | null; contact_phone: string | null;
  boat_name: string | null; boat_length_m: string | null; arrival: string; departure: string | null;
  status: MarinaStatus; source: 'guest' | 'staff' | 'import'; total_price: string | null; currency: string | null;
  payment_status: PaymentStatus; payment_error: string | null; hold_expires_at: string | null; created_at: string;
  doc_count?: number; docs_verified?: number;
}
// Task 6
export function marinaBody(f: { name: string; slug: string; lat: string; lng: string; email: string; phone: string;
  response_window_hours: string; auto_confirm: boolean; booking_url: string; status?: 'active' | 'inactive' }): Record<string, unknown>;
//   trims; '' → null for lat/lng/email/phone/booking_url; response_window_hours → Number(...) (OTA rejects a string); status only when given
// Task 7
export const MARINA_STORAGE_KEY = 'hotal-marina-id';
export function pickMarina<T extends { id: string }>(marinas: T[], wanted: string | null | undefined): T | null; // wanted if present, else first, else null
export const CSV_COLUMNS = ['label', 'pontoon', 'length_m', 'min_length_m', 'beam_m', 'depth_m', 'price_per_night', 'price_mode', 'lat', 'lng', 'rotation', 'status'] as const;
export const CSV_MAX_ROWS = 2000;
export function parseCsv(text: string): string[][];
//   strips a leading BOM; delimiter ';' when the header line (outside quotes) has ';' and no ',', else ','; quoted fields with "" escapes,
//   delimiters and CR/LF inside quotes; CRLF / LF / CR line ends; drops TRAILING rows whose cells are all blank (not middle ones)
export function csvToBerthRows(text: string, pontoons: { id: string; name: string }[]): { rows: Record<string, string | null>[]; errors: string[] };
//   header trimmed + lower-cased; unknown header → 'unknown column "<h>"'; no label column → 'missing column "label"'; no data rows → 'no rows';
//   > CSV_MAX_ROWS → 'at most 2000 rows'; cells trimmed; blank → null except status/price_mode (omitted, N3); columns absent from the header are absent from rows;
//   pontoon → pontoon_id by trimmed, case-insensitive name match, unknown → 'row N: pontoon "<name>" not found' (N = 1-based data row, as OTA counts);
//   numeric columns (length_m, min_length_m, beam_m, depth_m, price_per_night, lat, lng, rotation) matching /^-?\d+,\d+$/ get the comma → '.'
// Task 8
export function propertyToday(timeZone: string | null | undefined, now?: Date): string; // Intl formatToParts in timeZone; invalid/empty → 'UTC'
export function addDays(ymd: string, n: number): string;                // UTC calendar arithmetic (month/year ends, DST-proof)
// Task 9
export function fieldsToLines(fields: unknown): string;                 // [{name,label,type}] → 'name | label | type' lines ('' for a non-array)
export function linesToFields(text: string): { name: string; label: string; type: string }[];
//   cells split on '|' and trimmed; blank lines skipped; label defaults to name; type defaults 'text'; a line without a name throws Error('line N: name is required') (N = 1-based line of the textarea)
// Task 10
export const PAGE_SIZE = 50;
export interface BookingFilter { status: '' | 'pending' | 'confirmed' | 'declined' | 'cancelled'; marina_id: string; berth_id: string; from: string; to: string; offset: number; }
export function bookingsQuery(f: BookingFilter): string;                // '?status=…&marina_id=…&berth_id=…&from=…&to=…&limit=50&offset=…' (empty params omitted; limit and offset always sent)
export function statusPillHtml(status: string): string;   // <span class="marina-pill" data-status="pending">Pending</span>; labels Hold/Pending/Confirmed/Declined/Cancelled; unknown → data-status="unknown" label 'Unknown' (output is whitelisted text only, never the input)
export function paymentPillHtml(status: string): string;  // <span class="marina-pay" data-status="held">Card held</span>; captured 'Paid', released 'Released', refunded 'Refunded', none 'No payment'; unknown → data-status="unknown" 'Unknown'
// Task 11
export function matchesFilter(row: Pick<StaffBookingRow, 'status' | 'marina_id' | 'berth_id' | 'arrival' | 'departure'>, f: BookingFilter): boolean;
//   never 'hold'; status/marina_id/berth_id equal when set; from: departure === null || departure > from; to: arrival < to
export function liveAction(rows: StaffBookingRow[], row: StaffBookingRow, f: BookingFilter): 'replace' | 'refetch' | 'ignore';
//   on page & matches → 'replace' (merge {...old, ...row}); on page & no longer matches → 'refetch'; absent & matches → 'refetch'; absent & no match → 'ignore'
export type BookingAction = 'confirm' | 'decline' | 'cancel' | 'end' | 'send-link';
export function bookingActions(row: Pick<StaffBookingRow, 'status' | 'departure'>): BookingAction[];
//   pending → ['confirm','decline','cancel','send-link']; confirmed → ['cancel','send-link'] + 'end' when departure === null; else []
// Task 13
export function tileCounts(rows: StaffBookingRow[], today: string): { arrivals: number; departures: number; onBerth: number };
//   arrivals: arrival === today && status ∈ {pending, confirmed}; departures: departure === today && status === 'confirmed';
//   onBerth: status === 'confirmed' && arrival <= today && (departure === null || departure > today)
export function matchBerthPanel(rows: StaffBookingRow[], label: string, today: string, occupiedOnMap: boolean):
  { current: StaffBookingRow | null; next: StaffBookingRow | null; heldOrMaintenance: boolean };
//   live = pending|confirmed with berth_label === label; current = live with arrival <= today && (departure === null || departure > today);
//   next = earliest live with arrival > today; heldOrMaintenance = occupiedOnMap && current === null
```
`D/scripts/check-marina.ts`: `import assert from 'node:assert/strict'`, imports `../src/lib/marina-logic.ts`, one `// ---- <fn> ----` block per export, ends `console.log('check-marina: ok');`. Run from `D`: `node scripts/check-marina.ts`.

Dashboard modules and routes:
- `D/src/pages/api/marina/guest/[...path].ts` (Task 5): imports `import type { APIContext } from 'astro';`, `import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';`, `import { staffProxyHeaders } from '../../../../lib/marina-logic';`; `export const prerender = false;` (literal line); `const proxy = createMarinaProxy<APIContext>({ otaBaseUrl: import.meta.env.PUBLIC_OTA_API_BASE_URL, auth: async (context) => { const { userId, getToken } = context.locals.auth(); return staffProxyHeaders(userId ? await getToken() : null, context.cookies.get('hotal-property-id')?.value); } });` `export const GET = proxy;` (GET only).
- `D/src/scripts/sidebar-modules-widget.ts` (Task 5): `loadProperty()` typed `{ id?: string; timezone?: string; currency?: string; enabled_modules?: unknown; sidon_marina_id?: string | null; sidon_marina_key_set?: boolean } | null`; new `export function loadMarinas(): Promise<MarinaRow[]>` (memoised `GET /api/marina/marinas` — OTA's default list is already active-only; checks `waitForClerkSession()` first like `loadProperty`, so a signed-out page never opens sign-in; `[]` on any failure or no session); nav rule: unhide `[data-marina]` when `property?.sidon_marina_id || (await loadMarinas()).length > 0`. Every page script that needs the marina list (Tasks 7–14) imports `loadMarinas` from here rather than fetching again; Settings (Task 6) and the setup tabs use their own `?include_inactive=1` fetch because they must show inactive rows.
- `D/src/layouts/Layout.astro` (Task 5): `isActive(href)` returns `currentPath.startsWith('/marina')` for `href === '/marina'`; Marina item comment updated to the R20 rule.
- `D/src/scripts/marina-staff-map.ts` (Task 8; reused by Task 13): `export async function mountStaffMap(host: HTMLElement, slug: string, timeZone: string | null | undefined, height = '60svh'): Promise<HTMLElement & { refresh?: () => void }>` — `await import('@forgebuild/sidon-booking-widget/berth-map')` (only ever from pages/branches that never load the legacy element, N1); replaces `host`'s children with `<sidon-berth-map marina=slug mode="staff" from=propertyToday(tz) to=addDays(today, 1) maps-api-key=import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY map-height=height locale="en">` (no `api-origin`); returns the element. Callers listen for `sidon-berth-selected` and call `el.refresh?.()`.
- Pages and their single client scripts: `D/src/pages/marina-setup.astro` + `D/src/scripts/marina-setup-client.ts` (Tasks 7–9); `D/src/pages/marina-bookings.astro` + `D/src/scripts/marina-bookings-client.ts` (Tasks 10–12); `D/src/pages/marina.astro` + `marina-client.ts` router (Task 13; `marina.astro` keeps `prerender = true`, its data loads client-side); Settings in `D/src/pages/settings.astro` + `D/src/scripts/settings-client.ts` (Task 6). New pages use `export const prerender = false;` and wrap their body in `<Show when="signed-in">` like the existing pages.
- `D/src/pages/api/marina/ably-auth.ts` (Task 11): copy of `api/golf/ably-auth.ts` with `const channel = \`property:${data.id}:marina-bookings\`;`, returns the bare TokenRequest.
- `D/src/scripts/marina-live.ts` (Task 11): `export async function subscribeMarinaBookings(onRow: (row: StaffBookingRow, event: 'new-booking' | 'booking-status-changed') => void): Promise<() => void>` — dynamic `import('ably')`, `new Realtime({ authUrl: '/api/marina/ably-auth' })`, channel from `loadProperty()`'s `id`; resolves to a no-op closer when there is no property.
- `D/src/scripts/marina-booking-actions.ts` (Task 11): `export async function runBookingAction(row: StaffBookingRow, action: BookingAction): Promise<StaffBookingRow | null>` — confirm/decline via `confirmDialog`; cancel: `payment_status === 'captured'` → `choiceDialog` (`confirmLabel: 'Cancel & refund'`, `altLabel: 'Cancel & keep payment'`, `cancelLabel: 'Keep booking'`, `danger: true`) → `refund = choice === 'confirm'`, `held` → `confirmDialog` ("Cancel & release hold", `refund: false`), else `confirmDialog`; end: a lazily created `<dialog id="marina-end-dialog">` with `<input type="date">` (min = arrival + 1 day) → `{action:'end', departure}`; send-link: `POST /api/marina/bookings/:id/send-guest-link`. OK → success toast, returns the row; error with `body.booking` (502 Stripe failure, 409 expired) → error toast `${row.contact_name}: ${error}` and returns `body.booking`; other errors → error toast, `null`; user cancelled → `null`.
- `D/src/scripts/marina-booking-dialog.ts` (Task 12): `export async function openMarinaBookingDialog(id: string, onChange: (row: StaffBookingRow) => void): Promise<void>` (lazily creates `<dialog id="marina-booking-dialog" class="list-dialog">`; loads `GET /api/marina/bookings/:id` + `GET /api/marina/bookings/:id/documents`; `onChange` gets the row returned by an action run inside the dialog) and `export function refreshOpenMarinaBookingDialog(row: StaffBookingRow): void` (when the open dialog shows `row.id`, re-runs both GETs and re-renders — the Ably row has no `documents` or `signature`; no-op otherwise).
- `/marina` scripts (Task 13): `D/src/scripts/marina-client.ts` becomes the router (`const marinas = await loadMarinas(); marinas.length ? await import('./marina-dashboard') : await import('./marina-interim');`); `D/src/scripts/marina-interim.ts` = today's interim code with its element import `await import('sidon-booking-widget-legacy/berth-map')`; `D/src/scripts/marina-dashboard.ts` mounts the map only through `mountStaffMap` (which does the dynamic 1.1 import). The berth panel's `occupiedOnMap` comes from `apiFetch(\`/api/marina/guest/${slug}?from=${today}&to=${addDays(today, 1)}\`)` (OTA's guest map payload on the bearer, the same data the map paints) → `berths.find((x) => x.label === label)?.available === false`; the element exposes no payload. The berth id for `GET /api/marina/bookings?berth_id=…&from=<yesterday>` comes from `GET /api/marina/marinas/:id/berths?include_inactive=1` matched by `label` (the event's `berthId` is the label).
- CSS (`D/src/styles/global.css`): `.marina-pill[data-status=…]`, `.marina-pay[data-status=…]` (Task 10, existing mixes only), `.is-inactive` greyed rows (Task 6), each with a `[hidden]` guard where the class sets `display`.

DOM ids shared between page tasks and the Playwright/e2e tasks:
- Settings (Task 6): tab `data-tab-target="marina"`, panel `data-settings-tab="marina"`; `#marina-list` of `li.marina-row[data-id]` (`.marina-row-save`, `.marina-row-remove`, `.reactivate-btn` on inactive rows); `#marina-add-form` with `#marina-add-name`, `#marina-add-slug`. Layout publishable key: `#stripe-publishable-key-form`, `#stripe-publishable-key-input`, `#stripe-publishable-key-status`, `#stripe-publishable-key-save`, `#stripe-publishable-key-clear`; `mountStripePublishableKeyWidget(form: HTMLFormElement)` in `stripe-key-widget.ts`, mounted from `org-settings-page-widget.ts` `tryMount()`.
- `/marina-setup` (Tasks 7–9): `#marina-setup-select`; tab buttons `data-setup-target`, panels `data-setup-tab` with values `berths | pontoons | price-tiers | doc-requirements | contract-templates | pois | images` (hash-linked); berths `#berths-body tr[data-id]`, `#berth-add-btn`, `#berths-csv-input`, `#berths-csv-errors`; `.deactivate-btn` / `.reactivate-btn` on every catalogue row.
- `/marina-bookings` (Tasks 10–12): filters `#mb-status`, `#mb-marina`, `#mb-berth`, `#mb-from`, `#mb-to`; `#marina-bookings-body tr[data-id]` (Task 10) with `button[data-action="confirm|decline|cancel|end|send-link"]` per `bookingActions` (Task 11) and `button[data-action="details"]` (Task 12); paging `#mb-prev`, `#mb-next`, `#mb-page-info` (text `Page N of M`, M ≥ 1); create `#mb-add-btn`, `#mb-create-dialog` with `#mb-create-marina`, `#mb-create-berth`, `#mb-create-arrival`, `#mb-create-departure`, `#mb-create-open-ended` (checkbox; disables departure, sends `departure: null`), `#mb-create-name`, `#mb-create-email`, `#mb-create-phone` (maxlength 30), `#mb-create-boat`, `#mb-create-length`, `#mb-create-beam`, `#mb-create-total` (blank = OTA prices it), `#mb-create-status` (`pending` | `confirmed`), `#mb-create-locale` (`en` default | `it` | `fr` | `es`; sent as `locale`, so the guest emails and booking page follow it); end dialog `#marina-end-dialog`; detail `#marina-booking-dialog`.
- `/marina` (Task 13): `#marina-dashboard` (hidden until the branch picks it), `#marina-select`, `#marina-stat-arrivals`, `#marina-stat-departures`, `#marina-stat-onberth`, `#marina-stat-pending`, `#marina-staff-map`, `<dialog id="marina-berth-panel" class="config-sheet">`, header links `a[href="/marina-bookings"]`, `a[href="/marina-setup"]`; interim ids unchanged (`#marina-empty`, `#marina-map`, `#marina-bookings`).
- Playwright helpers `D/tests/marina-helpers.ts` (Task 6; later tasks add to it): `export function uniqueSlug(prefix = 'pw-marina'): string` (`${prefix}-${Date.now()}`); `export async function createMarinaViaUi(page: Page, opts: { name: string; slug: string }): Promise<string>` (marina id); `export async function deactivateMarinaViaUi(page: Page, id: string): Promise<void>`; Task 7 adds `export async function importBerthsCsvViaUi(page: Page, marinaId: string, csv: string): Promise<void>` (on `/marina-setup#berths`, selects the marina, sets `#berths-csv-input` and waits for the `POST …/berths/bulk` response); Task 10 adds `export async function createBookingViaUi(page: Page, opts: { marinaId: string; berthLabel: string; arrival: string; departure: string | null; status: 'pending' | 'confirmed'; contactName: string; contactEmail?: string; locale?: 'en' | 'it' | 'fr' | 'es' }): Promise<string>` (fills `#mb-create-dialog` on `/marina-bookings`, returns the id from the `POST /api/marina/bookings` 201 response), used by the Task 10–13 specs.
- Specs: `tests/marina-interim.spec.ts` (Task 5, extended in Task 13), `tests/marina-settings.spec.ts` (Task 6), `tests/marina-setup.spec.ts` (Tasks 7–9), `tests/marina-bookings.spec.ts` (Tasks 10–12), `tests/marina.spec.ts` (Task 13), `tests/marina-enquiries.spec.ts` (Task 14). A dashboard date a spec needs ("today") comes from `propertyToday(<property timezone from GET /api/property/me>)` imported from `../src/lib/marina-logic`, never the test machine's clock.

### Plan conventions

- Each task: **Files** (exact paths, with line anchors where modifying), **Interfaces** (Consumes / Produces, using the names above), then `- [ ]` steps: failing check first wherever there is pure logic (W `scripts/check-*.ts`, O `scripts/check-marina*.js`, D `scripts/check-marina.ts`), run it and show the expected failure, implement, run it and show the pass, then the repo's remaining gates, then commit. UI-only behaviour is pinned by the task's Playwright spec (written before the page code where practical; run after).
- Commit: `git -C <repo> add <explicit paths> && git -C <repo> commit -m "<subject>" -m "<body>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. Subjects: O `Marina staff API: …`; W `Widget 1.1: …`; D `Marina dashboard: …`. Never `-A`, never `--no-verify`, never amend.
- Complete code in every code step (no "similar to", no TODO). Match the surrounding comment style (explain why, not what).
- Windows host; commands for Git Bash with absolute paths or `git -C`. OTA checks run from `O` (they load `.env` from the working directory) and refuse remote DBs.
- Local stack: OTA `cd O && npm run dev` (if port 3000 is taken: `PORT=3100 npm run dev`, then start D with `PUBLIC_OTA_API_BASE_URL=http://localhost:3100`); dashboard `cd D && npx astro dev --background` on port 4335 (`astro dev stop|status|logs`); Playwright `cd D && npx playwright test tests/<spec>.ts` (needs `clerk auth login` once per machine; the impersonated account is staff, not admin, so admin-only saves are asserted by branching on 403). `npx astro check` is not a gate.
- Widget tarball for D: `cd W && npm run build && npm pack --pack-destination ../ota-table-bookings/vendor`, then `cd D && npm install`.
- Do not touch the Sidon fields, the `sidon_marina_id` half of the nav rule, `MODULE_KEYS`, or hotal-ui (R26, R27, R30). Scratch files for the e2e task go in `O/.superpowers/planc/e2e/` (gitignored).

---

## Tasks

### Task 1: OTA staff-API follow-ups for the dashboard

Repo: `O` = `C:/Users/robert/source/repos/OTA`, branch `main`. Commit directly to `main` and do not push (R2). OTA `main` auto-deploys on push, so this commit stays additive with no migration until the user approves a push. This task implements R12–R18. R17 adds nothing here: no move action, no admin gating, no `contract-fields` route. Commands are for Git Bash and run from `O`, because the checks load `.env` from the working directory and refuse remote DBs. Leave the untracked `O/=` and `O/src/db/seed-extras.sql.pre-multi-property.bak` alone.

**Files:**
- Modify: `O/scripts/check-marina-http.js`
  - `pendingBooking`: lines 240 and 242
  - insert a block directly above line 472 (`    // (later tasks append here)`)
- Modify: `O/src/lib/marinaLifecycle.js`
  - insert after line 220 (the end of `afterChange`)
  - `module.exports`: line 324
- Modify: `O/src/controllers/marinaDocuments.js`
  - `uploadDocument`: lines 35-36
  - `updateDocument`: lines 77-79
- Modify: `O/src/controllers/marinaGuest.js`
  - header comment: lines 16-18
  - `agreeContract`: lines 329-330
- Modify: `O/src/controllers/marinaBookings.js`
  - insert after line 7
  - `getBooking`: line 55
  - `createBooking`: lines 73-78 and 85
  - `updateBooking`: line 114
- Modify: `O/src/controllers/marinaCatalogue.js`
  - header comment: lines 6-9
  - line 12
  - `v`: lines 20 and 26
  - `TABLES`: lines 36 and 39-40
  - `MARINA_COLS`: line 53
  - insert after line 81 (`checkPontoon`)
  - `listMarinas`: line 106
  - `childHandlers`: lines 160, 168 and 185
- Modify: `O/src/routes/marina.js`, lines 16 and 32
- Modify: `O/src/docs/swagger.js`
  - insert above line 1
  - lines 647, 648, 652, 658, 661, 668, 669, 672, 675, 676, 679, 682, 689, 696, 703, 711, 714 and 715

**Interfaces:**
- Consumes (existing code):
  - `q.joinedBooking(pool, id)`: `mb.*` plus `berth_label`, `marina_name`, …, `doc_count`, `docs_verified`.
  - `afterChange(before, after)` in `O/src/lib/marinaLifecycle.js:201`. With `before === after` and a status other than `hold`, it publishes `booking-status-changed` only: no guest update, and no email because `emailKind` returns null.
  - `life.maybeAutoConfirm`.
  - The body-parser 413 pattern of `rawDocSafe` in `O/src/routes/marina.js:15`.
  - Check helpers in `check-marina-http.js`: `api()`, `guestBody()`, `pendingBooking()`, `upload()`, `pdf`, `insert()`, `future()`, `life`, `m`, `P`, `G`, `berthRes`, `one`.
  - The `call(fn, req)` pattern from `O/scripts/check-multi-property-http.js:18-26`.
- Produces (binding names from the contract):
  - `life.republish(bookingId) -> Promise<void>`, exported from `O/src/lib/marinaLifecycle.js`. It is awaited after the write and before the response in three places:
    - `uploadDocument`
    - `updateDocument`, only when a row was updated
    - `agreeContract`, only when the signature row was inserted

    It never throws and never calls `afterChange` for a hold. Tasks 11 and 12 consume these events.
  - `GET /api/marina/bookings/:id` → `signature: { template_id, signer_email, agreed_at, rendered_body } | null` (Task 12).
  - `?include_inactive=1` lists every status in the same order. It must be exactly the string `1`; any other value keeps today's behaviour. It applies to `GET /api/marina/marinas` and `GET /api/marina/marinas/:marina_id/{pontoons|berths|price-tiers|doc-requirements|contract-templates|pois|images}` (Tasks 6–9 and 13).
  - New validators in `O/src/controllers/marinaCatalogue.js`: `v.nonNeg` and `v.email`, plus `EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Their errors read `"<col> must be a number, 0 or more"` and `"<col> must be an email address"`, with a `row N: ` prefix in bulk.
  - New 400s:
    - Price tier create, and update (checked against the stored row): `400 {error:'valid_to must be on or after valid_from'}`.
    - Staff `POST /api/marina/bookings` and the no-action edit path of `PUT /api/marina/bookings/:id`:
      - `400 {error:'contact_phone must be up to 30 characters'}`
      - `400 {error:'boat_length_m must be a number, 0 or more'}`, and the same message for `boat_beam_m`
  - Image upload over 4 MB: `413 {error:'Images are limited to 4 MB'}`.

- [ ] **Step 1: Write the failing HTTP checks**

In `O/scripts/check-marina-http.js`, let `pendingBooking` take a client IP. The new checks need their own IP because the default `192.0.2.121` has made 8 of its 10 bookings allowed per hour.

Line 240, old:
```js
    const pendingBooking = async () => {
```
new:
```js
    const pendingBooking = async (ip = '192.0.2.121') => {
```
Line 242, old:
```js
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': '192.0.2.121' } })).body;
```
new:
```js
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: { 'X-Client-Ip': ip } })).body;
```

Insert this block directly above line 472 (`    // (later tasks append here)`) and keep the marker after it:

```js
    // ---- Plan C Task 1 (R12-R15) ----
    const docCtrl = require('../src/controllers/marinaDocuments');
    // Bearer-only controllers can't be reached over HTTP without a real
    // Clerk token; drive them directly (check-multi-property-http.js).
    const call = async (fn, req) => {
      const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let error;
      await fn({ params: {}, query: {}, body: {}, ...req }, res, (e) => { error = e; });
      if (error) throw error;
      return res;
    };
    // Records afterChange calls (the staff-feed publish) instead of publishing.
    const spyAfterChange = async (fn) => {
      const real = life.afterChange; const calls = [];
      life.afterChange = (...args) => { calls.push(args); };
      try { await fn(); } finally { life.afterChange = real; }
      return calls;
    };
    // Exactly one republish: the same joined row as before and after (no
    // status change, so no guest update or email), never a hold.
    const republishedOnce = (calls, id) => {
      assert.equal(calls.length, 1, `afterChange calls: ${calls.length}`);
      const [before, after] = calls[0];
      assert.equal(before, after); assert.equal(after.id, id); assert.notEqual(after.status, 'hold');
      return after;
    };
    const ipR12 = '192.0.2.150';
    const review = (id, status) => call(docCtrl.updateDocument, { params: { id }, body: { status }, property_id: P, auth_method: 'bearer' });
    // Off, so a verify or an agreement can't add a second, status-changing event.
    await pool.query('UPDATE marina SET auto_confirm = false WHERE id = $1', [m.id]);
    await check('R12: a guest document upload republishes the booking once', async () => {
      const b = await pendingBooking(ipR12);
      const calls = await spyAfterChange(async () => assert.equal((await upload(b, pdf)).status, 201));
      assert.equal(republishedOnce(calls, b.booking.id).doc_count, 1);
    });
    await check('R12: a staff verify and a reject each republish the booking once', async () => {
      const b = await pendingBooking(ipR12);
      const d = (await upload(b, pdf)).body;
      const verified = await spyAfterChange(async () => {
        const r = await review(d.id, 'verified');
        assert.equal(r.statusCode, 200); assert.equal(r.body.status, 'verified');
      });
      assert.equal(republishedOnce(verified, b.booking.id).docs_verified, 1);
      const rejected = await spyAfterChange(async () => assert.equal((await review(d.id, 'rejected')).body.status, 'rejected'));
      assert.equal(republishedOnce(rejected, b.booking.id).docs_verified, 0);
    });
    const tpl = (await api('POST', `/api/marina/marinas/${m.id}/contract-templates`, { body: { name: 'R12', body_markdown: 'Agreed by {{sailor_name}}' } })).body;
    const agree = (b) => api('POST', `${G}/bookings/${b.booking.id}/contract`, { headers: { 'X-Booking-Token': b.booking_token } });
    await check('R12: a contract agreement republishes the booking once', async () => {
      const b = await pendingBooking(ipR12);
      const calls = await spyAfterChange(async () => assert.equal((await agree(b)).status, 201));
      republishedOnce(calls, b.booking.id);
    });
    await check('R13: staff GET /bookings/:id returns the agreed contract text', async () => {
      const b = await pendingBooking(ipR12);
      assert.equal((await agree(b)).status, 201);
      const r = await api('GET', `/api/marina/bookings/${b.booking.id}`);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body.signature).sort(), ['agreed_at', 'rendered_body', 'signer_email', 'template_id']);
      assert.equal(r.body.signature.rendered_body, 'Agreed by Ann'); assert.equal(r.body.signature.template_id, tpl.id);
    });
    await pool.query("UPDATE marina_contract_template SET status = 'inactive' WHERE id = $1", [tpl.id]);
    await check('R12: republish never sends a hold to the staff feed', async () => {
      const h = await insert({ arrival: future(3300), departure: future(3302), status: 'hold', source: 'guest', expires: new Date(Date.now() + 3600000) });
      const calls = await spyAfterChange(() => life.republish(h.id));
      assert.equal(calls.length, 0);
    });
    await check('R14: include_inactive=1 lists deactivated rows; the default and include_inactive=true do not', async () => {
      const mk = async (path, body) => { const r = await api('POST', path, { body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
      const M = `/api/marina/marinas/${m.id}`;
      const pon = await mk(`${M}/pontoons`, { name: 'R14 pontoon' });
      const berth = await mk(`${M}/berths`, { label: 'R14', length_m: 10 });
      const tier = await mk(`${M}/price-tiers`, { valid_from: '2090-01-01', valid_to: '2090-12-31', max_length_m: 10, price_per_night: 1 });
      const other = await mk('/api/marina/marinas', { name: 'Porto R14', slug: 'porto-r14' });
      const lists = [[`${M}/pontoons`, pon.id], [`${M}/berths`, berth.id], [`${M}/price-tiers`, tier.id], ['/api/marina/marinas', other.id]];
      for (const [path, id] of lists) assert.equal((await api('PUT', `${path}/${id}`, { body: { status: 'inactive' } })).status, 200, `deactivate ${path}`);
      const ids = async (path) => (await api('GET', path)).body.map((r) => r.id);
      for (const [path, id] of lists) {
        assert.ok(!(await ids(path)).includes(id), `${path} default`);
        assert.ok(!(await ids(`${path}?include_inactive=true`)).includes(id), `${path} =true`);
        assert.ok((await ids(`${path}?include_inactive=1`)).includes(id), `${path} =1`);
      }
      assert.ok((await ids('/api/marina/marinas?include_inactive=1')).includes(m.id), 'active rows stay listed');
    });
    await check('R15: negative berth and tier prices or sizes → 400', async () => {
      const M = `/api/marina/marinas/${m.id}`;
      const b = await api('POST', `${M}/berths`, { body: { label: 'NEG', length_m: 10, price_per_night: -1 } });
      assert.equal(b.status, 400); assert.equal(b.body.error, 'price_per_night must be a number, 0 or more');
      const l = await api('PUT', `${M}/berths/${berthRes.body.id}`, { body: { length_m: -0.5 } });
      assert.equal(l.status, 400); assert.equal(l.body.error, 'length_m must be a number, 0 or more');
      const t = await api('POST', `${M}/price-tiers`, { body: { valid_from: '2091-01-01', valid_to: '2091-12-31', max_length_m: 10, price_per_night: -5 } });
      assert.equal(t.status, 400); assert.equal(t.body.error, 'price_per_night must be a number, 0 or more');
      const bulk = await api('POST', `${M}/berths/bulk`, { body: { rows: [{ label: 'NB1' }, { label: 'NB2', beam_m: -3 }] } });
      assert.equal(bulk.status, 400); assert.equal(bulk.body.error, 'row 2: beam_m must be a number, 0 or more');
    });
    await check('R15: price tier valid_from after valid_to → 400 on create and update', async () => {
      const T = `/api/marina/marinas/${m.id}/price-tiers`;
      const bad = await api('POST', T, { body: { valid_from: '2092-06-10', valid_to: '2092-06-01', max_length_m: 10, price_per_night: 1 } });
      assert.equal(bad.status, 400); assert.equal(bad.body.error, 'valid_to must be on or after valid_from');
      const ok = await api('POST', T, { body: { valid_from: '2092-06-01', valid_to: '2092-06-01', max_length_m: 10, price_per_night: 1, status: 'inactive' } });
      assert.equal(ok.status, 201, 'a one-day tier is fine');
      const upd = await api('PUT', `${T}/${ok.body.id}`, { body: { valid_from: '2092-06-02' } });
      assert.equal(upd.status, 400); assert.equal(upd.body.error, 'valid_to must be on or after valid_from');
      assert.equal((await api('PUT', `${T}/${ok.body.id}`, { body: { valid_to: '2092-06-30' } })).status, 200);
    });
    await check('R15: staff booking contact_phone over 30 and bad boat sizes → 400, on create and edit', async () => {
      const base = { berth_id: berthRes.body.id, contact_name: 'Val', arrival: future(3100), departure: future(3102), status: 'pending' };
      const post = (o) => api('POST', '/api/marina/bookings', { body: { ...base, ...o } });
      const phone = await post({ contact_phone: '1'.repeat(31) });
      assert.equal(phone.status, 400); assert.equal(phone.body.error, 'contact_phone must be up to 30 characters');
      for (const [k, val] of [['boat_length_m', -1], ['boat_length_m', 'abc'], ['boat_beam_m', -2]]) {
        const r = await post({ [k]: val });
        assert.equal(r.status, 400, `${k}=${val}`); assert.equal(r.body.error, `${k} must be a number, 0 or more`);
      }
      const ok = await post({ contact_phone: '1'.repeat(30), boat_length_m: 0, boat_beam_m: '' });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const put = (body) => api('PUT', `/api/marina/bookings/${ok.body.id}`, { body });
      const p2 = await put({ contact_phone: '+39 '.padEnd(31, '0') });
      assert.equal(p2.status, 400); assert.equal(p2.body.error, 'contact_phone must be up to 30 characters');
      const l2 = await put({ boat_length_m: -4 });
      assert.equal(l2.status, 400); assert.equal(l2.body.error, 'boat_length_m must be a number, 0 or more');
      assert.equal((await put({ boat_length_m: '12.5', boat_beam_m: '' })).status, 200);
    });
    await check('R15: marina email must be an email address', async () => {
      const r = await api('POST', '/api/marina/marinas', { body: { name: 'Porto Mail', slug: 'porto-mail', email: 'harbour office' } });
      assert.equal(r.status, 400); assert.equal(r.body.error, 'email must be an email address');
      const u = await api('PUT', `/api/marina/marinas/${m.id}`, { body: { email: 'a@b' } });
      assert.equal(u.status, 400); assert.equal(u.body.error, 'email must be an email address');
      assert.equal((await api('PUT', `/api/marina/marinas/${m.id}`, { body: { email: '' } })).status, 200, "'' clears it");
    });
    await check('R15: an image over 4 MB → 413 JSON', async () => {
      // PNG signature + padding = 4 MB + 1 byte.
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4 * 1024 * 1024 - 7)]);
      const r = await api('POST', `/api/marina/marinas/${m.id}/images/upload`, { raw: png, headers: { 'Content-Type': 'image/png' } });
      assert.equal(r.status, 413); assert.deepEqual(r.body, { error: 'Images are limited to 4 MB' });
    });
```

Fixture notes, so nothing collides with earlier checks:
- Dates: the staff, hold and tier fixtures use `future(3100)`, `future(3300)` and the years 2090–2092. `guestBody` reaches only about `future(1150)`, and no tier lands in a priced range.
- Upload limit: the uploads at `192.0.2.120` end at 20 of the 30 allowed per hour.
- Booking limit: `ipR12` makes 4 bookings.
- Clean-up: the finally block already deletes every marina of `P`, including `porto-r14`.

- [ ] **Step 2: Run the checks and confirm the eleven new ones fail**

Run: `cd C:/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js`

Expected:
- The 38 existing checks print `ok`.
- The output ends with `11 FAILED` and exit code 1.
- The 11 failures, in order:
```
FAIL R12: a guest document upload republishes the booking once            (AssertionError: afterChange calls: 0)
FAIL R12: a staff verify and a reject each republish the booking once      (AssertionError: afterChange calls: 0)
FAIL R12: a contract agreement republishes the booking once                (AssertionError: afterChange calls: 0)
FAIL R13: staff GET /bookings/:id returns the agreed contract text         (deepEqual: [ 'agreed_at', 'signer_email', 'template_id' ] vs [ …, 'rendered_body', … ])
FAIL R12: republish never sends a hold to the staff feed                   (TypeError: life.republish is not a function)
FAIL R14: include_inactive=1 lists deactivated rows; the default and include_inactive=true do not   (AssertionError: /api/marina/marinas/<id>/pontoons =1)
FAIL R15: negative berth and tier prices or sizes → 400                    (201 !== 400)
FAIL R15: price tier valid_from after valid_to → 400 on create and update  (201 !== 400)
FAIL R15: staff booking contact_phone over 30 and bad boat sizes → 400, on create and edit   (500 !== 400)
FAIL R15: marina email must be an email address                            (201 !== 400)
FAIL R15: an image over 4 MB → 413 JSON                                    (deepEqual: { error: 'request entity too large' } vs { error: 'Images are limited to 4 MB' })
```

- [ ] **Step 3: Add `republish` and call it from documents and the contract (R12, R16)**

`O/src/lib/marinaLifecycle.js`: insert after line 220 (the closing `}` of `afterChange`):
```js

// Re-sends the joined row to the staff feed after a change that isn't a
// status transition (document upload/verify/reject, contract agreed).
// afterChange(b, b): same status, so 'booking-status-changed' only -- no
// guest update, no email. The hold check repeats afterChange's own guard so
// a stubbed afterChange still never sees a hold. Never throws.
async function republish(bookingId) {
  try {
    const b = await q.joinedBooking(pool, bookingId);
    if (b && b.status !== 'hold') module.exports.afterChange(b, b);
  } catch (err) {
    console.error('Marina republish failed:', err.message);
  }
}
```
Line 324, old:
```js
  promoteHeldBooking, piMatches, maybeAutoConfirm, sweepOnce, startMarinaHoldExpiryJob, withLockedBooking, setRow, toPending, confirmBooking, declineBooking, cancelBooking, endBooking, afterChange, LIVE, fail };
```
new:
```js
  promoteHeldBooking, piMatches, maybeAutoConfirm, sweepOnce, startMarinaHoldExpiryJob, withLockedBooking, setRow, toPending, confirmBooking, declineBooking, cancelBooking, endBooking, afterChange, republish, LIVE, fail };
```

`O/src/controllers/marinaDocuments.js` lines 35-36, old:
```js
    docs.extractDocument(d.id);
    res.status(201).json(d);
```
new:
```js
    docs.extractDocument(d.id);
    // Staff tables and an open detail dialog update live (doc_count).
    await life.republish(b.id);
    res.status(201).json(d);
```
Lines 77-79, old:
```js
    if (!d) return res.status(404).json({ error: 'Document not found' });
    if (status === 'verified') life.maybeAutoConfirm(d.booking_id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
    res.json(d);
```
new:
```js
    if (!d) return res.status(404).json({ error: 'Document not found' });
    // Before auto-confirm, so the feed sees the document change ahead of any
    // confirmation it triggers.
    await life.republish(d.booking_id);
    if (status === 'verified') life.maybeAutoConfirm(d.booking_id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
    res.json(d);
```

`O/src/controllers/marinaGuest.js` lines 16-18 (R16), old:
```js
// Guest routes: /api/marina/guest/:marina/... -- the only prefix a site's
// forwarder passes through. On the key rail the guest rules apply; a
// bearer (the dashboard's own forwarder) gets staff behaviour on reads.
```
new:
```js
// Guest routes: /api/marina/guest/:marina/... -- the only prefix a site's
// forwarder passes through. A bearer (the dashboard's own forwarder) gets
// the same whitelisted guest payloads as the key rail; only the guest rate
// limits (skipped), client_ip (not stored) and guest booking create (403:
// staff book through POST /api/marina/bookings) differ.
```
Lines 329-330, old:
```js
    if (!sig) return res.status(409).json({ error: 'Already agreed' });
    life.maybeAutoConfirm(b.id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
```
new:
```js
    if (!sig) return res.status(409).json({ error: 'Already agreed' });
    await life.republish(b.id);
    life.maybeAutoConfirm(b.id).catch((err) => console.error('Marina auto-confirm failed:', err.message));
```

- [ ] **Step 4: Staff bookings: rendered contract and field validation (R13, R15)**

`O/src/controllers/marinaBookings.js`: insert after line 7 (`const { sendGuestEmail } = …`):
```js

// Checked here rather than left to the DB: contact_phone is VARCHAR(30) (a
// longer one was a 500), and a negative boat size would price or fit
// nonsense. '' means "not given", as on the edit path.
function fieldError(f) {
  if (f.contact_phone != null && String(f.contact_phone).length > 30) return 'contact_phone must be up to 30 characters';
  for (const k of ['boat_length_m', 'boat_beam_m']) {
    if (f[k] != null && f[k] !== '' && !(Number.isFinite(Number(f[k])) && Number(f[k]) >= 0)) return `${k} must be a number, 0 or more`;
  }
  return null;
}
const numOrNull = (x) => (x == null || x === '' ? null : Number(x));
```
Line 55 (`getBooking`), old:
```js
      pool.query('SELECT template_id, signer_email, agreed_at FROM marina_contract_signature WHERE booking_id = $1', [b.id]),
```
new:
```js
      // rendered_body: the contract text exactly as the guest agreed it.
      pool.query('SELECT template_id, signer_email, agreed_at, rendered_body FROM marina_contract_signature WHERE booking_id = $1', [b.id]),
```
Lines 73-78 (`createBooking`), old:
```js
    if (b.total_price != null && !(Number(b.total_price) >= 0)) return res.status(400).json({ error: 'total_price must be a non-negative number' });
    const { rows: [berth] } = await pool.query("SELECT * FROM marina_berth WHERE id = $1 AND property_id = $2 AND status <> 'inactive'", [b.berth_id, req.property_id]);
    if (!berth) return res.status(404).json({ error: 'Berth not found' });
    const len = b.boat_length_m != null ? Number(b.boat_length_m) : null;
    const total = b.total_price != null ? Number(b.total_price).toFixed(2)
      : priceStay({ berth, tiers: await q.activeTiers(pool, berth.marina_id), arrival: b.arrival, departure: b.departure ?? null, boatLengthM: len, boatBeamM: b.boat_beam_m != null ? Number(b.boat_beam_m) : null }).total_price;
```
new:
```js
    if (b.total_price != null && !(Number(b.total_price) >= 0)) return res.status(400).json({ error: 'total_price must be a non-negative number' });
    const bad = fieldError(b);
    if (bad) return res.status(400).json({ error: bad });
    const { rows: [berth] } = await pool.query("SELECT * FROM marina_berth WHERE id = $1 AND property_id = $2 AND status <> 'inactive'", [b.berth_id, req.property_id]);
    if (!berth) return res.status(404).json({ error: 'Berth not found' });
    const len = numOrNull(b.boat_length_m);
    const beam = numOrNull(b.boat_beam_m);
    const total = b.total_price != null ? Number(b.total_price).toFixed(2)
      : priceStay({ berth, tiers: await q.activeTiers(pool, berth.marina_id), arrival: b.arrival, departure: b.departure ?? null, boatLengthM: len, boatBeamM: beam }).total_price;
```
Line 85, old:
```js
        b.contact_phone || null, b.boat_name || null, len, b.boat_beam_m ?? null, b.arrival, b.departure ?? null, status,
```
new:
```js
        b.contact_phone || null, b.boat_name || null, len, beam, b.arrival, b.departure ?? null, status,
```
Line 114 (`updateBooking`, edit path), old:
```js
      if ('contact_name' in fields && !fields.contact_name) return res.status(400).json({ error: 'contact_name cannot be empty' });
```
new:
```js
      if ('contact_name' in fields && !fields.contact_name) return res.status(400).json({ error: 'contact_name cannot be empty' });
      const bad = fieldError(fields);
      if (bad) return res.status(400).json({ error: bad });
```

- [ ] **Step 5: Catalogue: validators, tier dates, include_inactive (R14, R15)**

`O/src/controllers/marinaCatalogue.js` lines 6-9, old:
```js
// Staff CRUD for marinas and their catalogue tables. Every child table is
// property-scoped and soft-deletes through status, so one table-driven
// handler set serves all of them; list returns active rows (berths: all
// but inactive), get returns any status.
```
new:
```js
// Staff CRUD for marinas and their catalogue tables. Every child table is
// property-scoped and soft-deletes through status, so one table-driven
// handler set serves all of them; list returns active rows (berths: all
// but inactive) unless ?include_inactive=1 (the dashboard's Reactivate);
// get returns any status.
```
Line 12, old:
```js
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
```
new:
```js
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Same shape check as the guest booking form (marinaGuard.js).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```
Line 20, old:
```js
  num: (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : fail('must be a number')),
```
new:
```js
  num: (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : fail('must be a number')),
  // Prices and sizes: a negative one prices a stay below zero or fits any boat.
  nonNeg: (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : fail('must be a number, 0 or more')),
```
Line 26, old:
```js
  url: (x) => (x == null || x === '' ? null : isValidUrl(x) ? x : fail('must be an http(s) URL')),
```
new:
```js
  url: (x) => (x == null || x === '' ? null : isValidUrl(x) ? x : fail('must be an http(s) URL')),
  email: (x) => (x == null || x === '' ? null : typeof x === 'string' && x.length <= 255 && EMAIL_RE.test(x) ? x : fail('must be an email address')),
```
Line 36, old:
```js
    length_m: v.num, min_length_m: v.num, beam_m: v.num, depth_m: v.num, price_per_night: v.num,
```
new:
```js
    length_m: v.nonNeg, min_length_m: v.nonNeg, beam_m: v.nonNeg, depth_m: v.nonNeg, price_per_night: v.nonNeg,
```
Lines 39-40, old:
```js
    valid_from: v.date, valid_to: v.date, max_length_m: v.num, max_beam_m: v.num, price_per_night: v.num,
    price_per_month: v.num, price_per_year: v.num, status: STATUS }, required: ['valid_from', 'valid_to', 'max_length_m', 'price_per_night'] },
```
new:
```js
    valid_from: v.date, valid_to: v.date, max_length_m: v.nonNeg, max_beam_m: v.nonNeg, price_per_night: v.nonNeg,
    price_per_month: v.nonNeg, price_per_year: v.nonNeg, status: STATUS }, required: ['valid_from', 'valid_to', 'max_length_m', 'price_per_night'] },
```
Line 53, old:
```js
  description: v.longText, phone: v.text(30), email: v.text(255), website: v.url, lat: v.num, lng: v.num,
```
new:
```js
  description: v.longText, phone: v.text(30), email: v.email, website: v.url, lat: v.num, lng: v.num,
```
Insert after line 81 (the closing `}` of `checkPontoon`):
```js

// valid_to is inclusive, so a one-day tier has valid_from = valid_to.
// Dates are 'YYYY-MM-DD' strings (src/db sets the DATE parser), so string
// order is date order.
function checkTierDates(t) {
  if (t.valid_from > t.valid_to) fail('valid_to must be on or after valid_from');
}
```
Line 106 (`listMarinas`), old:
```js
    const { rows } = await pool.query("SELECT * FROM marina WHERE property_id = $1 AND status = 'active' ORDER BY name", [req.property_id]);
```
new:
```js
    // ?include_inactive=1 (exactly '1'): every status, for the dashboard's Reactivate.
    const all = req.query.include_inactive === '1';
    const { rows } = await pool.query(`SELECT * FROM marina WHERE property_id = $1${all ? '' : " AND status = 'active'"} ORDER BY name`, [req.property_id]);
```
Line 160 (`childHandlers(kind).list`), old:
```js
        const { rows } = await pool.query(`SELECT * FROM ${table} WHERE marina_id = $1 AND ${listWhere} ORDER BY ${order}`, [req.params.marina_id]);
```
new:
```js
        // ?include_inactive=1 (exactly '1'): every status, same order -- the
        // dashboard's setup tabs show inactive rows with Reactivate.
        const where = req.query.include_inactive === '1' ? '' : ` AND ${listWhere}`;
        const { rows } = await pool.query(`SELECT * FROM ${table} WHERE marina_id = $1${where} ORDER BY ${order}`, [req.params.marina_id]);
```
Line 168 (`.create`), old:
```js
        if (table === 'marina_berth') await checkPontoon(pool, req.params.marina_id, values);
```
new:
```js
        if (table === 'marina_berth') await checkPontoon(pool, req.params.marina_id, values);
        if (table === 'marina_price_tier') checkTierDates(values);
```
Line 185 (`.update`), old:
```js
        if (table === 'marina_berth') await checkPontoon(client, req.params.marina_id, values);
```
new:
```js
        if (table === 'marina_berth') await checkPontoon(client, req.params.marina_id, values);
        // Against the stored row: an update may move just one end.
        if (table === 'marina_price_tier') checkTierDates({ ...before, ...values });
```
`checkTierDates` throws `{status:400}` inside the update's try. The existing catch rolls back, releases the client and passes the error to `errorHandler`, which answers `400 {error:'valid_to must be on or after valid_from'}`.

- [ ] **Step 6: Friendly 413 on image uploads (R15)**

`O/src/routes/marina.js` line 16, old:
```js
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: '4mb' });
```
new:
```js
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: '4mb' });
const rawImageSafe = (req, res, next) => rawImage(req, res, (err) => (err?.status === 413 ? res.status(413).json({ error: 'Images are limited to 4 MB' }) : next(err)));
```
Line 32, old:
```js
router.post('/marinas/:marina_id/images/upload', authenticateOrApiKey, rawImage, cat.uploadImage);
```
new:
```js
router.post('/marinas/:marina_id/images/upload', authenticateOrApiKey, rawImageSafe, cat.uploadImage);
```

- [ ] **Step 7: Run the checks again and confirm they all pass**

Run:
```bash
cd C:/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js && node -r dotenv/config scripts/check-marina.js
```
Expected:
- All 49 HTTP checks print `ok`, then `all passed`.
- `check-marina.js` prints only `ok` lines and ends `all passed`.
- Both exit 0.
- `errorHandler` prints the expected 400s to stderr while the checks run, as it already does for existing 400s.

- [ ] **Step 8: Update Swagger (R18)**

Do this step in order. The `sed` uses the current line numbers, so run it before the insert at line 1.

First, add `INCLUDE_INACTIVE` to the seven child list `get:` lines (661, 668, 675, 682, 689, 696, 703). Line 721 has the same text and is outside the range, so it stays unchanged:
```bash
cd C:/Users/robert/source/repos/OTA && sed -i "660,704s/format: 'uuid' } }], responses: { 200: { description: \"OK\" } } },/format: 'uuid' } }, INCLUDE_INACTIVE], responses: { 200: { description: \"OK\" } } },/" src/docs/swagger.js && grep -c "INCLUDE_INACTIVE\]" src/docs/swagger.js
```
Expected: `7`

Insert above line 1 (`const swaggerSpec = {`):
```js
// ?include_inactive=1 on the marina and catalogue list routes (dashboard Reactivate).
const INCLUDE_INACTIVE = { name: 'include_inactive', in: 'query', schema: { type: 'string', enum: ['1'] }, description: "'1' = every status (inactive rows too), same order; any other value = the default list" };

```
Then make these exact replacements. The line numbers below are from before the insert; after it, each is +3.

Line 647, old:
```js
      get: { tags: ['Marina'], summary: "List active marinas", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: "OK" } } },
```
new:
```js
      get: { tags: ['Marina'], summary: "List active marinas (every status with include_inactive=1)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [INCLUDE_INACTIVE], responses: { 200: { description: "OK" } } },
```
Line 648, old substring:
```js
responses: { 201: { description: "Created" }, 400: { description: "Validation failed" }, 409: { description: "Slug already used" } } },
```
new:
```js
responses: { 201: { description: "Created" }, 400: { description: "Validation failed, e.g. 'email must be an email address'" }, 409: { description: "Slug already used" } } },
```
Line 652, old substring:
```js
responses: { 200: { description: "Marina" }, 400: { description: "Validation failed" }, 404: { description: "Not found" }, 409: { description: "Slug already used" } } },
```
new:
```js
responses: { 200: { description: "Marina" }, 400: { description: "Validation failed, e.g. 'email must be an email address'" }, 404: { description: "Not found" }, 409: { description: "Slug already used" } } },
```
Line 658, old substring:
```js
responses: { 201: { description: "marina_image row" }, 400: { description: "Not a JPEG/PNG" } } },
```
new:
```js
responses: { 201: { description: "marina_image row" }, 400: { description: "Not a JPEG/PNG" }, 413: { description: "{ error: 'Images are limited to 4 MB' }" } } },
```
Line 669, old:
```js
      post: { tags: ['Marina'], summary: "Create one of a marina's berths (staff lists exclude inactive)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 201: { description: "Created" }, 400: { description: "Validation failed" }, 404: { description: "Marina not found" } } },
```
new:
```js
      post: { tags: ['Marina'], summary: "Create one of a marina's berths (staff lists exclude inactive)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 201: { description: "Created" }, 400: { description: "Validation failed, e.g. 'price_per_night must be a number, 0 or more' (sizes and prices are 0 or more)" }, 404: { description: "Marina not found" } } },
```
Line 672, old:
```js
      put: { tags: ['Marina'], summary: "Update one of a marina's berths (staff lists exclude inactive) (status inactive = soft delete)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: "Updated" }, 400: { description: "Validation failed" }, 404: { description: "Not found" } } },
```
new:
```js
      put: { tags: ['Marina'], summary: "Update one of a marina's berths (staff lists exclude inactive) (status inactive = soft delete)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: "Updated" }, 400: { description: "Validation failed, e.g. 'length_m must be a number, 0 or more' (sizes and prices are 0 or more)" }, 404: { description: "Not found" } } },
```
Line 676, old:
```js
      post: { tags: ['Marina'], summary: "Create one of a marina's price tiers", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 201: { description: "Created" }, 400: { description: "Validation failed" }, 404: { description: "Marina not found" } } },
```
new:
```js
      post: { tags: ['Marina'], summary: "Create one of a marina's price tiers", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 201: { description: "Created" }, 400: { description: "Validation failed, e.g. 'valid_to must be on or after valid_from' or 'price_per_night must be a number, 0 or more'" }, 404: { description: "Marina not found" } } },
```
Line 679, old:
```js
      put: { tags: ['Marina'], summary: "Update one of a marina's price tiers (status inactive = soft delete)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: "Updated" }, 400: { description: "Validation failed" }, 404: { description: "Not found" } } },
```
new:
```js
      put: { tags: ['Marina'], summary: "Update one of a marina's price tiers (status inactive = soft delete)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'marina_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: "Updated" }, 400: { description: "Validation failed, e.g. 'valid_to must be on or after valid_from' (checked against the stored dates)" }, 404: { description: "Not found" } } },
```
Line 711, old substring:
```js
responses: { 201: { description: "Joined booking" }, 400: { description: "Validation failed" }
```
new:
```js
responses: { 201: { description: "Joined booking" }, 400: { description: "Validation failed, e.g. 'contact_phone must be up to 30 characters', 'boat_length_m must be a number, 0 or more'" }
```
Line 714, old substring:
```js
contract agreement", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: "Booking" }
```
new:
```js
contract agreement", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: "Booking: the joined row + documents[] + signature: { template_id, signer_email, agreed_at, rendered_body } | null (rendered_body = the contract text as agreed)" }
```
Line 715, old substring:
```js
responses: { 200: { description: "Booking" }, 400: { description: "Validation failed" }, 404: { description: "Not found" }, 409: { description: "Wrong status, or the request expired" }
```
new:
```js
responses: { 200: { description: "Booking" }, 400: { description: "Validation failed, e.g. 'contact_phone must be up to 30 characters', 'boat_beam_m must be a number, 0 or more'" }, 404: { description: "Not found" }, 409: { description: "Wrong status, or the request expired" }
```

Verify that the spec still loads:
```bash
cd C:/Users/robert/source/repos/OTA && node -e "const p=require('./src/docs/swagger').paths; console.log(Object.values(p).filter((x)=>x.get?.parameters?.some((q)=>q.name==='include_inactive')).length, Object.keys(p['/api/marina/marinas/{marina_id}/images/upload'].post.responses).join(','))"
```
Expected: `8 201,400,413`

- [ ] **Step 9: Re-run both gates and commit**

Run:
```bash
cd C:/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js && node -r dotenv/config scripts/check-marina.js && git status --short
```
Expected:
- Both runs end `all passed`.
- `git status --short` lists the 8 modified files below, plus the pre-existing untracked `=` and `src/db/seed-extras.sql.pre-multi-property.bak`. Do not add those two.

Commit:
```bash
git -C C:/Users/robert/source/repos/OTA add src/lib/marinaLifecycle.js src/controllers/marinaDocuments.js src/controllers/marinaGuest.js src/controllers/marinaBookings.js src/controllers/marinaCatalogue.js src/routes/marina.js src/docs/swagger.js scripts/check-marina-http.js && git -C C:/Users/robert/source/repos/OTA commit -m "Marina staff API: live republish on documents/contract, rendered contract, include_inactive, validation" -m "Document upload, staff verify/reject and contract agreement now republish the joined booking to property:{id}:marina-bookings as booking-status-changed (never for a hold). Staff GET /bookings/:id returns signature.rendered_body. Marina and catalogue lists accept ?include_inactive=1. Negative sizes/prices, tier valid_from > valid_to, contact_phone over 30 chars, bad boat sizes and a malformed marina email are 400s; an oversized image is a JSON 413. Fixes the misleading bearer comment in marinaGuest.js. Additive, no migration." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Do not push. OTA `main` auto-deploys on push, and the plan's runbook pushes only after the user approves.

---

### Task 2: Widget 1.1 — createMarinaProxy auth rail and createMarinaClient timeout

Repo `W` (`C:/Users/robert/source/repos/sidon-booking-widget`), branch `main`. Implements R6, R7. Pins Review Focus 4 (widget half).

**Files:**
- Modify: `W/src/astro-proxy.ts` — header comment (1-4), `MarinaProxyOptions` (16-22), new `MarinaProxyAuth` after `AstroLikeRoute` (33), `createMarinaProxy` signature (70-71), URL comment (82-83), credentials (88-89), header build (104-111), `MarinaClientOptions` (146-152), `createMarinaClient` params (168-172) and fetch (185). Stays one self-contained, import-free, erasable-TS file.
- Modify: `W/scripts/check-astro-proxy.ts` — new auth-rail block before line 245 (`console.log('check-astro-proxy: ok')`); hoist the hanging fetch out of the timeout block (228-243); new client cases at the end of the client block (after 331).

**Interfaces:**
- Consumes: nothing new (web-standard `fetch`, `Headers`, `AbortSignal.timeout`).
- Produces (exactly as the contract):
  ```ts
  export type MarinaProxyAuth<C extends AstroLikeContext = AstroLikeContext> =
    (context: C, slug: string) => Promise<Record<string, string> | null> | Record<string, string> | null;
  export interface MarinaProxyOptions<C extends AstroLikeContext = AstroLikeContext> { otaBaseUrl: string; keys?: MarinaKeys; auth?: MarinaProxyAuth<C>; timeoutMs?: number; }
  export function createMarinaProxy<C extends AstroLikeContext = AstroLikeContext>(options: MarinaProxyOptions<C>): (context: C) => Promise<Response>;
  export interface MarinaClientOptions { otaBaseUrl: string; keys: MarinaKeys; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; }
  ```
  `AstroLikeRoute` stays exported (the default-`C` return type), so `call(route: AstroLikeRoute, …)` in the check still fits. Errors: construction `Error('createMarinaProxy: give exactly one of keys or auth')`; signed out `401 {"error":"Not signed in"}`; client `MarinaClientError('Booking service timed out', 504)` / `MarinaClientError('Booking service unavailable', 502)`. Task 5's `D/src/pages/api/marina/guest/[...path].ts` uses `createMarinaProxy<APIContext>({ otaBaseUrl, auth })`.

- [ ] **Step 1: Write the failing auth-rail checks**

In `W/scripts/check-astro-proxy.ts`, insert this block immediately before line 245 `console.log('check-astro-proxy: ok');` (after the `// --- timeout: 504 JSON ---` block):

```ts
// --- auth rail (the OTA dashboard): only auth's headers authenticate ---
{
  // The timeout block above leaves reply hanging; start from the default.
  reply = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const seen: { context: AstroLikeContext; slug: string }[] = [];
  const staff = createMarinaProxy({
    otaBaseUrl: 'https://ota.test',
    auth: async (context, slug) => {
      seen.push({ context, slug });
      return { authorization: 'Bearer t1', 'x-property-id': '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
    },
  });
  const c = ctx('fox/bookings/b1', {
    headers: {
      'User-Agent': 'UA/1',
      Authorization: 'Bearer forged',
      'X-Api-Key': 'forged',
      'X-Property-Id': 'forged',
      Cookie: '__session=s1; hotal-property-id=forged',
    },
  }, '?from=2026-06-01&to=2026-06-02');
  const { res, body } = await call(staff, c);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].context, c, 'auth gets the route context (Clerk reads locals from it)');
  assert.equal(seen[0].slug, 'fox');
  assert.equal(calls[0].url, 'https://ota.test/api/marina/guest/fox/bookings/b1?from=2026-06-01&to=2026-06-02');
  assert.equal(sent('authorization'), 'Bearer t1');
  assert.equal(sent('x-property-id'), '7c9e6679-7425-40de-944b-e07fc1f90ae7');
  assert.equal(sent('x-api-key'), null, 'no site key on the staff rail');
  assert.equal(sent('cookie'), null);
  assert.deepEqual([...new Headers(calls[0].init.headers).keys()].sort(),
    ['authorization', 'user-agent', 'x-client-ip', 'x-property-id']);

  // Only what auth returns goes up: an inbound X-Property-Id, Authorization,
  // X-Api-Key or cookie never stands in for a header auth left out.
  const bare = createMarinaProxy({ otaBaseUrl: 'https://ota.test', auth: () => ({ authorization: 'Bearer t2' }) });
  await call(bare, ctx('fox', {
    headers: { Authorization: 'Bearer forged', 'X-Property-Id': 'forged', 'X-Api-Key': 'forged', Cookie: 'a=1' },
  }));
  assert.equal(calls.length, 1);
  assert.equal(sent('authorization'), 'Bearer t2');
  assert.equal(sent('x-property-id'), null);
  assert.equal(sent('x-api-key'), null);
  assert.equal(sent('cookie'), null);

  // The path guard runs first: a traversal to a staff route never reaches
  // auth, so it never gets a bearer attached.
  for (const path of ['x/../bookings', 'fox/%2e%2e/%2e%2e/bookings']) {
    seen.length = 0;
    const { res, body } = await call(staff, ctx(path));
    assert.equal(res.status, 404, path);
    assert.deepEqual(body, { error: 'Not found' });
    assert.equal(seen.length, 0, `${path}: auth must not be called`);
    assert.equal(calls.length, 0, `${path} must not reach OTA`);
  }

  // Signed out: JSON 401 (not Astro's HTML page), nothing sent.
  const anon = createMarinaProxy({ otaBaseUrl: 'https://ota.test', auth: async () => null });
  const out = await call(anon, ctx('fox'));
  assert.equal(out.res.status, 401);
  assert.equal(out.res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(out.body, { error: 'Not signed in' });
  assert.equal(calls.length, 0);

  // Exactly one credential source, checked when the route module loads.
  const one = { message: 'createMarinaProxy: give exactly one of keys or auth' };
  assert.throws(() => createMarinaProxy({ otaBaseUrl: 'https://ota.test', keys: 'key-1', auth: async () => null }), one);
  assert.throws(() => createMarinaProxy({ otaBaseUrl: 'https://ota.test' }), one);
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-astro-proxy.ts`
Expected: exit 1, with `check-astro-proxy: ok` NOT printed and:
```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

404 !== 200
```
(today `auth` is ignored, `keyFor(undefined, 'fox')` finds no key, so the forwarder answers 404.)

- [ ] **Step 3: Implement the auth rail in `W/src/astro-proxy.ts`**

Lines 1-4, old:
```ts
// Server-side half of the widget: an Astro route that relays the browser's
// /api/marina/guest/* calls to OTA with the site's API key, so the key never
// reaches the page. Consumers mount it at
// src/pages/api/marina/guest/[...path].ts.
```
new:
```ts
// Server-side half of the widget: an Astro route that relays the browser's
// /api/marina/guest/* calls to OTA with the site's API key (or, in the OTA
// dashboard, the signed-in staff member's credentials), so no credential
// ever reaches the page. Consumers mount it at
// src/pages/api/marina/guest/[...path].ts.
```

Lines 16-22, old:
```ts
export interface MarinaProxyOptions {
  /** OTA origin, e.g. `https://ota.example.com`. */
  otaBaseUrl: string;
  keys: MarinaKeys;
  /** Upstream timeout; Render cold starts can take most of a minute. */
  timeoutMs?: number;
}
```
new:
```ts
export interface MarinaProxyOptions<C extends AstroLikeContext = AstroLikeContext> {
  /** OTA origin, e.g. `https://ota.example.com`. */
  otaBaseUrl: string;
  /** Site rail: one key or slug → key. Give this or `auth`. */
  keys?: MarinaKeys;
  /** Staff rail: upstream credential headers for this request; null → 401 {error:'Not signed in'}. */
  auth?: MarinaProxyAuth<C>;
  /** Upstream timeout; Render cold starts can take most of a minute. */
  timeoutMs?: number;
}
```

Line 33, old:
```ts
export type AstroLikeRoute = (context: AstroLikeContext) => Promise<Response>;
```
new:
```ts
export type AstroLikeRoute = (context: AstroLikeContext) => Promise<Response>;

// Generic over the context so the dashboard's callback can read Astro's
// locals (Clerk) without this file importing astro. Returns the headers that
// authenticate this one request upstream, e.g. { authorization: 'Bearer …' }.
export type MarinaProxyAuth<C extends AstroLikeContext = AstroLikeContext> =
  (context: C, slug: string) => Promise<Record<string, string> | null> | Record<string, string> | null;
```

Lines 70-71, old:
```ts
export function createMarinaProxy({ otaBaseUrl, keys, timeoutMs = 60_000 }: MarinaProxyOptions): AstroLikeRoute {
  return async (context) => {
```
new:
```ts
export function createMarinaProxy<C extends AstroLikeContext = AstroLikeContext>({
  otaBaseUrl,
  keys,
  auth,
  timeoutMs = 60_000,
}: MarinaProxyOptions<C>): (context: C) => Promise<Response> {
  // Fail at startup: with both, which credential reaches OTA is a guess; with
  // neither (e.g. OTA_API_KEY unset) every request would 404 like "no such marina".
  if ((keys === undefined) === (auth === undefined)) {
    throw new Error('createMarinaProxy: give exactly one of keys or auth');
  }
  return async (context) => {
```

Lines 82-83, old:
```ts
    // Belt and braces: whatever the guard missed, the resolved URL must still
    // sit under the guest prefix — the API key also opens staff routes.
```
new:
```ts
    // Belt and braces: whatever the guard missed, the resolved URL must still
    // sit under the guest prefix — the API key and a staff bearer also open
    // staff routes.
```

Lines 88-89, old:
```ts
    const key = keyFor(keys, segments[0]);
    if (!key) return jsonError(404, 'Not found');
```
new:
```ts
    // After the path checks, so a rejected path never costs a token mint.
    let credentials: Record<string, string>;
    if (auth) {
      const fromAuth = await auth(context, segments[0]);
      if (!fromAuth) return jsonError(401, 'Not signed in');
      credentials = fromAuth;
    } else {
      const key = keyFor(keys!, segments[0]);
      if (!key) return jsonError(404, 'Not found');
      credentials = { 'x-api-key': key };
    }
```

Lines 104-111, old:
```ts
    // Built from scratch, so cookies, Authorization, X-Forwarded-For and any
    // inbound X-Client-Ip / X-Api-Key never reach OTA.
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('x-api-key', key);
```
new:
```ts
    // Built from scratch, so cookies, Authorization, X-Forwarded-For and any
    // inbound X-Client-Ip / X-Api-Key / X-Property-Id never reach OTA. The
    // credentials go on after the allowlist so nothing inbound can shadow them.
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
```

Everything after (x-client-ip, body cap, fetch with `redirect: 'manual'` and `AbortSignal.timeout(timeoutMs)`, 3xx → 502, response rebuild) is unchanged.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-astro-proxy.ts`
Expected, exit 0:
```
check-astro-proxy: ok
check-astro-proxy: createMarinaClient assertions passed
```
(The key-rail cases above the new block pass unchanged.)

- [ ] **Step 5: Write the failing client-timeout checks**

In `W/scripts/check-astro-proxy.ts`, lines 228-243, old:
```ts
// --- timeout: 504 JSON ---
{
  reply = (init) => new Promise((_resolve, reject) => {
    // AbortSignal.timeout's timer is unref'd; this one keeps Node alive
    // until the abort fires (else top-level await exits unsettled).
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal!.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal!.reason);
    });
  });
  const fast = createMarinaProxy({ otaBaseUrl: 'https://ota.test', keys: 'key-1', timeoutMs: 20 });
```
new:
```ts
// A hung OTA: settles only when the request's signal aborts, rejecting with
// its reason (a TimeoutError once AbortSignal.timeout fires).
const hangUntilAbort = (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  // AbortSignal.timeout's timer is unref'd; this one keeps Node alive
  // until the abort fires (else top-level await exits unsettled).
  const keepAlive = setTimeout(() => {}, 5000);
  init.signal!.addEventListener('abort', () => {
    clearTimeout(keepAlive);
    reject(init.signal!.reason);
  });
});

// --- timeout: 504 JSON ---
{
  reply = hangUntilAbort;
  const fast = createMarinaProxy({ otaBaseUrl: 'https://ota.test', keys: 'key-1', timeoutMs: 20 });
```

Then, at the end of the client block, after line 331 `assert.equal(queue.length, 0);` and before its closing `}`, insert:
```ts

  // Every attempt carries its own timeout signal, so a retry gets a fresh budget.
  ota(tooMany('0'), json(payload));
  await single.getMarina('fox');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal), 'every attempt has a timeout signal');
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);

  // A hung or unreachable OTA is a MarinaClientError too, with the
  // forwarder's statuses: timeout 504, anything else 502.
  reply = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await assert.rejects(single.getMarina('fox'), clientError(504, 'Booking service timed out'));
  reply = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(single.getDocRequirements('fox'), clientError(502, 'Booking service unavailable'));
  // timeoutMs really reaches the signal.
  reply = hangUntilAbort;
  const fast = createMarinaClient({ otaBaseUrl: OTA, keys: 'site-key', sleep, timeoutMs: 20 });
  await assert.rejects(fast.getMarina('fox'), clientError(504, 'Booking service timed out'));
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-astro-proxy.ts`
Expected: exit 1; `check-astro-proxy: ok` printed, `createMarinaClient assertions passed` NOT printed, and:
```
AssertionError [ERR_ASSERTION]: every attempt has a timeout signal
```

- [ ] **Step 7: Implement the client timeout in `W/src/astro-proxy.ts`**

Lines 146-152, old:
```ts
export interface MarinaClientOptions {
  /** OTA origin, e.g. `https://ota.example.com`. */
  otaBaseUrl: string;
  keys: MarinaKeys;
  /** Waits between 429 retries; injectable so the check doesn't really sleep. */
  sleep?: (ms: number) => Promise<void>;
}
```
new:
```ts
export interface MarinaClientOptions {
  /** OTA origin, e.g. `https://ota.example.com`. */
  otaBaseUrl: string;
  keys: MarinaKeys;
  /** Waits between 429 retries; injectable so the check doesn't really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt, default 30000: a hung OTA must fail an SSR page, not hold it open. */
  timeoutMs?: number;
}
```

Lines 168-172, old:
```ts
export function createMarinaClient({
  otaBaseUrl,
  keys,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: MarinaClientOptions) {
```
new:
```ts
export function createMarinaClient({
  otaBaseUrl,
  keys,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30_000,
}: MarinaClientOptions) {
```

Line 185, old:
```ts
      const res = await fetch(url, { headers: { 'x-api-key': key } });
```
new:
```ts
      let res: Response;
      try {
        res = await fetch(url, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        // The forwarder's statuses, so a page handles both the same way; a
        // raw DOMException / TypeError would otherwise escape as a 500.
        if ((err as Error | null)?.name === 'TimeoutError') throw new MarinaClientError('Booking service timed out', 504);
        throw new MarinaClientError('Booking service unavailable', 502);
      }
```

- [ ] **Step 8: Run it and watch it pass**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-astro-proxy.ts`
Expected, exit 0:
```
check-astro-proxy: ok
check-astro-proxy: createMarinaClient assertions passed
```

- [ ] **Step 9: Run the repo gates**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npm test`
Expected: exit 0, output includes `check-astro-proxy: ok`, `check-astro-proxy: createMarinaClient assertions passed`, then `check-ota.ts`'s own pass line, unchanged.

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npm run check`
Expected: exit 0; svelte-check ends `COMPLETED … 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, and both `tsc` runs print nothing.

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npm run build && grep -c "give exactly one of keys or auth" dist/astro-proxy.js && grep -c "MarinaProxyAuth" dist/astro-proxy.d.ts && grep -c "^import" dist/astro-proxy.js dist/astro-proxy.d.ts`
Expected: build exits 0; then `1`, a count ≥ `2`, and `dist/astro-proxy.js:0` / `dist/astro-proxy.d.ts:0` (the last grep exits 1 because nothing matched — that is the pass: the emitted files import nothing).

- [ ] **Step 10: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/astro-proxy.ts scripts/check-astro-proxy.ts && git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "Widget 1.1: createMarinaProxy auth rail; createMarinaClient timeout" -m "createMarinaProxy takes auth(context, slug) as the alternative to keys (exactly one, else it throws at construction): its headers go upstream after the allowlist, null answers 401 {error:'Not signed in'}, and it runs only after the path guard, so traversal never gets a bearer. No x-api-key on that rail; inbound Authorization/X-Api-Key/X-Property-Id/cookies never reach OTA. createMarinaClient gains timeoutMs (default 30000): timeout -> MarinaClientError 504, network failure -> 502. Checked in check-astro-proxy.ts; the README is updated in the 1.1 README pass." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Nothing is pushed or published. Task 4 bumps to 1.1.0, and the runbook publishes later.

---

### Task 3: Widget 1.1 — staff map mode, refresh(), fit once

Repo `W` = `C:/Users/robert/source/repos/sidon-booking-widget`, branch `main` (committed directly; not pushed, not published). Implements R3, R4 and R5. Staff mode is an attribute switch on `<sidon-berth-map>`. In staff mode the map has no card and makes no availability or LOA check, every listed berth is clickable, and occupied berths are painted navy. A new exported `refresh()` refetches the map payload. In both modes the map fits its bounds only once. The `sidon-berth-selected` detail shape stays `{ berthId: string | null }`. The README and version bump belong to Task 4.

**Files:**
- Modify `W/src/lib/ota.ts`. Insert `berthPickable` after `fitsBerth` (lines 191-198).
- Modify `W/scripts/check-ota.ts`. Add to the import list (lines 9-27) and add a new block after the `fitsBerth` block (lines 174-187).
- Modify `W/src/BerthMap.svelte`:
  - props block (line 15)
  - `Props` (line 55)
  - destructure (lines 85-101)
  - new `staff`/`reload`/`refresh` after line 101
  - staff date effect plus the map-payload effect (lines 149-155)
  - availability effect (lines 188-189)
  - `onBerthClick` (lines 213-216)
  - template (lines 262-299)
- Modify `W/src/components/BerthMapView.svelte`:
  - import (line 4)
  - props (lines 20-27)
  - `CircleEntry` comment (lines 36-40)
  - `let fitted` after line 43
  - `OCCUPIED` after line 51
  - `patchBerths` (lines 192-193, 216-241)
  - overlay click (lines 280-281)
  - `paintSvgState` (lines 311-323)
  - `paint` (lines 330-335)
  - re-stamp effect (lines 379-385)
  - `buildChartCircles` fit (lines 413-416)
  - overlay-effect fit (line 460)
- Modify `W/src/elements.d.ts`: `SidonBerthMapElement` (lines 74-75).
- Modify `W/demo/index.html`: add a staff-map row after line 100 and wire its controls in the inline script (lines 116-121).

**Interfaces:**
- Consumes:
  - `fitsBerth(b, loa, beam?)` and `type Berth` (already imported) in `W/src/lib/ota.ts`.
  - `parseISODate` and `localIso` from `W/src/lib/date-range.ts` (already imported in `BerthMap.svelte`).
  - `getMarina(origin, slug, range)`, unchanged.
- Produces (the contract's exact names):
  - `export function berthPickable(b: Pick<Berth, 'status' | 'lengthM' | 'minLengthM' | 'beamM'>, loa: number, staff: boolean): boolean`
  - `<sidon-berth-map>`:
    - prop `mode: { attribute: 'mode', type: 'String' }`, `mode?: 'guest' | 'staff'`, default `'guest'`
    - `const staff = $derived(mode === 'staff')`
    - `export function refresh(): void`
  - `BerthMapView`:
    - prop `staff?: boolean` (default `false`)
    - `OCCUPIED`
    - `data-pick="1"`
    - `let fitted = false`
  - `SidonBerthMapElement.mode?: 'guest' | 'staff'` and `readonly refresh?: () => void`.
  - Task 4 documents these in the README. Tasks 8 and 13 consume them through `mountStaffMap` (`mode="staff"`, `el.refresh?.()`).

- [ ] **Step 1: Write the failing `berthPickable` check**

In `W/scripts/check-ota.ts`, edit the import list (lines 17-18):

```ts
  asciiFileName,
  fitsBerth,
```
→
```ts
  asciiFileName,
  berthPickable,
  fitsBerth,
```

Then insert a block between the end of the `fitsBerth` block (line 187, `assert.equal(fitsBerth({ lengthM: 10, minLengthM: null, beamM: null }, 9, 99), true);`) and `// ---- pickCheapest`:

```ts
assert.equal(fitsBerth({ lengthM: 10, minLengthM: null, beamM: null }, 9, 99), true);

// ---- berthPickable (R3 staff map mode) --------------------------------------
// Guest: free and fits this LOA (the set GET availability returns).
// Staff (the dashboard): any berth OTA lists, booked, maintenance or too small.
const free = { status: 'available' as const, ...limits };
const taken = { status: 'occupied' as const, ...limits };
assert.equal(berthPickable(free, 10, false), true);
assert.equal(berthPickable(free, 12.01, false), false); // too long for a guest
assert.equal(berthPickable(taken, 10, false), false); // booked or maintenance
assert.equal(berthPickable(taken, 10, true), true);
assert.equal(berthPickable(taken, 12.01, true), true); // occupied and too long: staff still pick it
assert.equal(berthPickable(free, 12.01, true), true);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-ota.ts`
Expected (exit code 1):
```
SyntaxError: The requested module '../src/lib/ota.ts' does not provide an export named 'berthPickable'
```

- [ ] **Step 3: Implement `berthPickable`**

In `W/src/lib/ota.ts`, insert the new function after `fitsBerth` (after line 198, before the `// The list is already OTA's free, fitting berths.` comment):

```ts
export function fitsBerth(b: Pick<Berth, 'lengthM' | 'minLengthM' | 'beamM'>, loa: number, beam?: number | null): boolean {
  if (b.lengthM != null && loa > b.lengthM) return false;
  if (b.minLengthM != null && loa < b.minLengthM) return false;
  if (b.beamM != null && beam != null && beam > b.beamM) return false;
  return true;
}

// Guest: free and fits this LOA (the set GET availability returns), so
// nothing else may act clickable. Staff (the dashboard's map): any listed
// berth, since they click a booked or maintenance berth to see why.
export function berthPickable(b: Pick<Berth, 'status' | 'lengthM' | 'minLengthM' | 'beamM'>, loa: number, staff: boolean): boolean {
  return staff || (b.status === 'available' && fitsBerth(b, loa));
}
```

- [ ] **Step 4: Run the check again**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-ota.ts && npm test`
Expected:
```
check-ota: ok
...
check-astro-proxy: ok
check-astro-proxy: createMarinaClient assertions passed
check-ota: ok
```

- [ ] **Step 5: `BerthMap.svelte`: `mode`, `refresh()`, staff branches**

In `W/src/BerthMap.svelte`:

5a. Props block (line 15):
```svelte
      berth: { attribute: 'berth', type: 'String' },
      bookPath: { attribute: 'book-path', type: 'String' },
```
→
```svelte
      berth: { attribute: 'berth', type: 'String' },
      mode: { attribute: 'mode', type: 'String' },
      bookPath: { attribute: 'book-path', type: 'String' },
```

5b. `Props` (line 55):
```ts
    berth?: string;
    bookPath?: string;
```
→
```ts
    berth?: string;
    mode?: 'guest' | 'staff';
    bookPath?: string;
```

5c. Destructure (lines 85-86):
```ts
    berth: berthAttr = '',
    bookPath = '',
```
→
```ts
    berth: berthAttr = '',
    // 'staff' = the OTA dashboard: every listed berth is clickable and the
    // map shows [from, to) occupancy; no card, availability or LOA checks.
    mode = 'guest',
    bookPath = '',
```

5d. After the destructure (line 101):
```ts
  }: Props = $props();

  function emit(name: string, detail: unknown, cancelable = false) {
```
→
```ts
  }: Props = $props();

  const staff = $derived(mode === 'staff');
  // Bumped by refresh(). The map-payload effect reads it, so the host can
  // re-read occupancy after a booking changes (the dashboard's Ably feed).
  let reload = $state(0);
  // Svelte exposes this on the element only once it has mounted (a
  // microtask after connect), so callers use el.refresh?.().
  export function refresh() {
    reload++;
  }

  function emit(name: string, detail: unknown, cancelable = false) {
```

5e. Staff date effect and `reload` in the map-payload effect (lines 149-155):
```ts
  // ---- fetch marina data, re-fetch (debounced) on date change ----------
  // apiOrigin/marina are read synchronously so a changed attribute refetches
  // (read inside the timeout they were never tracked).
  $effect(() => {
    const origin = apiOrigin;
    const slug = marina;
    const range = from && to ? { from: localIso(from), to: localIso(to) } : undefined;
```
→
```ts
  // ---- staff: from/to follow the attributes -----------------------------
  // After mount a guest's dates belong to the card, so their attributes are
  // read once. Staff have no card, and the host owns the day shown. untrack:
  // only the attributes may re-run this, and an unchanged day must not write
  // a fresh Date, because that alone would refetch.
  $effect(() => {
    if (!staff) return;
    const f = parseISODate(fromAttr);
    const t = parseISODate(toAttr);
    untrack(() => {
      if (f && (!from || localIso(f) !== localIso(from))) from = f;
      if (t && (!to || localIso(t) !== localIso(to))) to = t;
    });
  });

  // ---- fetch marina data, re-fetch (debounced) on date change ----------
  // apiOrigin/marina/reload are read synchronously so a changed attribute or
  // a refresh() refetches (read inside the timeout they were never tracked).
  $effect(() => {
    const origin = apiOrigin;
    const slug = marina;
    reload;
    const range = from && to ? { from: localIso(from), to: localIso(to) } : undefined;
```

5f. Availability effect (lines 188-189):
```ts
    // OTA 400s a same-day range or a non-positive length: nothing to ask.
    if (!arrival || departure <= arrival || !(boatLengthM > 0)) {
```
→
```ts
    // OTA 400s a same-day range or a non-positive length: nothing to ask.
    // Staff never ask: they pick any berth, so `available` stays null and
    // the auto-pick below never runs.
    if (staff || !arrival || departure <= arrival || !(boatLengthM > 0)) {
```

5g. `onBerthClick` (lines 215-216):
```ts
    // berth the booking would refuse.
    if (berthId !== null && !available?.some((a) => a.label === berthId)) return;
```
→
```ts
    // berth the booking would refuse. Staff may pick any listed berth, and
    // deselecting (null) always goes through.
    if (!staff && berthId !== null && !available?.some((a) => a.label === berthId)) return;
```

5h. Template: pass `staff` to the view and drop the card in staff mode (lines 275-299):
```svelte
        {selectedBerth}
        {onBerthClick}
      />
    </div>
  {/if}
  <div class="sbm-card-slot">
    <QuickBookCard
      bind:loa
      bind:from
      bind:to
      {selectedBerthLabel}
      {totalLabel}
      {locale}
      {seasonRanges}
      onSubmit={handleSubmit}
      {eyebrow}
      title={cardTitle}
      {intro}
      {rangeLabel}
      {rangePlaceholder}
      {lengthLabel}
      {selectedLabel}
      {ctaLabel}
    />
  </div>
```
→
```svelte
        {selectedBerth}
        {onBerthClick}
        {staff}
      />
    </div>
  {/if}
  {#if !staff}
    <div class="sbm-card-slot">
      <QuickBookCard
        bind:loa
        bind:from
        bind:to
        {selectedBerthLabel}
        {totalLabel}
        {locale}
        {seasonRanges}
        onSubmit={handleSubmit}
        {eyebrow}
        title={cardTitle}
        {intro}
        {rangeLabel}
        {rangePlaceholder}
        {lengthLabel}
        {selectedLabel}
        {ctaLabel}
      />
    </div>
  {/if}
```

- [ ] **Step 6: `BerthMapView.svelte`: staff painting, coastal picking, fit once**

In `W/src/components/BerthMapView.svelte`:

6a. Import (line 4):
```ts
  import { fitsBerth } from '../lib/ota';
```
→
```ts
  import { berthPickable, fitsBerth } from '../lib/ota';
```

6b. Props (lines 21-27):
```ts
    onBerthClick: (berthId: string | null) => void;
  }
  let {
    mapsApiKey, mapStyle, center, navy, gold,
    logoMark = null, marinaName = '',
    otherMarinas, berths, overlays, layout, loa, selectedBerth, onBerthClick,
  }: Props = $props();
```
→
```ts
    onBerthClick: (berthId: string | null) => void;
    /** Staff map (the OTA dashboard): every listed berth is pickable. */
    staff?: boolean;
  }
  let {
    mapsApiKey, mapStyle, center, navy, gold,
    logoMark = null, marinaName = '',
    otherMarinas, berths, overlays, layout, loa, selectedBerth, onBerthClick,
    staff = false,
  }: Props = $props();
```

6c. `CircleEntry` comment and `fitted` (lines 36-43):
```ts
  // Buoy-circle state (chart style). Keyed by berthId so reactive effects
  // below can restyle/re-select without re-creating circles. `pickable` =
  // free and fits this LOA by OTA's own rule (fitsBerth) - the same set
  // GET availability returns, so nothing else may look or act clickable.
  type CircleEntry = { circle: any; berth: Berth; pickable: boolean };
  const circles = new Map<string, CircleEntry>();
  let logoOverlayInstances: InstanceType<typeof LogoOverlay>[] = [];
  let svgOverlayInstances: InstanceType<typeof SvgGroundOverlay>[] = [];
```
→
```ts
  // Buoy-circle state (chart style). Keyed by berthId so reactive effects
  // below can restyle/re-select without re-creating circles. `pickable` =
  // berthPickable: for a guest, free and fits this LOA by OTA's own rule,
  // which is the set GET availability returns, so nothing else may look or
  // act clickable. For staff, every listed berth.
  type CircleEntry = { circle: any; berth: Berth; pickable: boolean };
  const circles = new Map<string, CircleEntry>();
  let logoOverlayInstances: InstanceType<typeof LogoOverlay>[] = [];
  let svgOverlayInstances: InstanceType<typeof SvgGroundOverlay>[] = [];
  // fitBounds only for the first data with something to frame. A later
  // refetch (new dates, refresh(), a live update) keeps the user's pan/zoom.
  // Plain let: only the two fit sites read it, and nothing should re-run on it.
  let fitted = false;
```

6d. `OCCUPIED`, after `BOOKED` (line 51):
```ts
  const BOOKED = { fillColor: '#888888', fillOpacity: 0.15, strokeColor: '#888888', strokeOpacity: 0.4, strokeWeight: 1 };
```
→
```ts
  const BOOKED = { fillColor: '#888888', fillOpacity: 0.15, strokeColor: '#888888', strokeOpacity: 0.4, strokeWeight: 1 };
  // Staff read occupancy at a glance, so a booked or maintenance berth is
  // solid navy rather than faded. OTA's payload doesn't tell the two apart.
  const OCCUPIED = $derived({ fillColor: navy, fillOpacity: 0.85, strokeColor: navy, strokeOpacity: 1, strokeWeight: 1.6 });
```

6e. `patchBerths`: mark listed berths for staff (lines 192-193):
```ts
        const status = info?.status ?? 'occupied';
        el.setAttribute('data-status', status);
```
→
```ts
        const status = info?.status ?? 'occupied';
        el.setAttribute('data-status', status);
        // Staff pick any berth OTA lists; an unlisted SVG label stays inert.
        if (staff && info) el.setAttribute('data-pick', '1');
```

6f. `patchBerths`: the injected stylesheet (lines 216, 240-241):
```ts
      const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
```
→
```ts
      // The data-pick rule must stay last: it has the same specificity as the
      // status rules that switch pointer events off, so source order decides.
      // It only restores clicks; occupied berths keep the occupied paint.
      const styleEl = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
```
and
```ts
        [data-berth-id][data-selected="1"] [data-role="entrance"] { fill: ${gold}; }
      `;
```
→
```ts
        [data-berth-id][data-selected="1"] [data-role="entrance"] { fill: ${gold}; }
        [data-berth-id][data-pick="1"] { pointer-events: auto; cursor: pointer; }
      `;
```

6g. Overlay click (lines 280-281):
```ts
          const g = target?.closest('[data-berth-id]');
          if (!g || g.getAttribute('data-status') !== 'available' || g.hasAttribute('data-fit')) return;
```
→
```ts
          const g = target?.closest('[data-berth-id]');
          if (!g) return;
          const pickable = staff
            ? g.getAttribute('data-pick') === '1'
            : g.getAttribute('data-status') === 'available' && !g.hasAttribute('data-fit');
          if (!pickable) return;
```

6h. `paintSvgState` (lines 311-313, 323):
```ts
  // Stamp data-selected="1" on the SVG berth group matching `selectedBerth`,
  // and data-fit="small" on listed berths this boat doesn't fit (the
  // injected overlay CSS greys those and turns their pointer events off).
```
→
```ts
  // Stamp data-selected="1" on the SVG berth group matching `selectedBerth`,
  // and data-fit="small" on listed berths this boat doesn't fit (the
  // injected overlay CSS greys those and turns their pointer events off).
  // Never data-fit for staff: they have no boat, and any berth is pickable.
```
and
```ts
      if (b && !fitsBerth(b, loa)) el.setAttribute('data-fit', 'small');
```
→
```ts
      if (!staff && b && !fitsBerth(b, loa)) el.setAttribute('data-fit', 'small');
```

6i. `paint` (lines 330-335):
```ts
  function paint(entry: CircleEntry, berthId: string) {
    const booked = entry.berth.status !== 'available';
    entry.pickable = !booked && fitsBerth(entry.berth, loa);
    const look = berthId === selectedBerth ? SELECTED : booked ? BOOKED : entry.pickable ? FIT : NO_FIT;
    entry.circle.setOptions({ ...look, clickable: entry.pickable });
  }
```
→
```ts
  function paint(entry: CircleEntry, berthId: string) {
    const booked = entry.berth.status !== 'available';
    entry.pickable = berthPickable(entry.berth, loa, staff);
    // The selected look wins in both modes, so a picked occupied berth stays highlighted.
    const look = berthId === selectedBerth ? SELECTED : booked ? (staff ? OCCUPIED : BOOKED) : entry.pickable ? FIT : NO_FIT;
    entry.circle.setOptions({ ...look, clickable: entry.pickable });
  }
```

6j. Re-stamp effect (lines 379-385):
```ts
  // Re-stamp SVG selection/fit whenever the selection, LOA or berth data
  // changes. Read up front: with no overlay mounted yet the stamp loop
  // never touches them, and the effect must still track all three.
  $effect(() => {
    selectedBerth; loa; berths;
    paintSvgState();
  });
```
→
```ts
  // Re-stamp SVG selection/fit whenever the selection, LOA, berth data or
  // mode changes. Read up front: with no overlay mounted yet the stamp loop
  // never touches them, and the effect must still track all four.
  $effect(() => {
    selectedBerth; loa; berths; staff;
    paintSvgState();
  });
```

6k. Chart fit (lines 413-416):
```ts
    if (circles.size) {
      bounds.extend(center);
      map.fitBounds(bounds, 60);
    }
```
→
```ts
    if (circles.size && !fitted) {
      fitted = true;
      bounds.extend(center);
      map.fitBounds(bounds, 60);
    }
```

6l. Coastal fit (line 460):
```ts
    if (rows.length) {
      const bounds = new (window as any).google.maps.LatLngBounds();
```
→
```ts
    if (rows.length && !fitted) {
      fitted = true;
      const bounds = new (window as any).google.maps.LatLngBounds();
```

- [ ] **Step 7: Element typings**

In `W/src/elements.d.ts` (`SidonBerthMapElement`, lines 74-75):
```ts
  berth?: string;
  bookPath?: string;
```
→
```ts
  berth?: string;
  /** 'staff' (the OTA dashboard): every listed berth is clickable and fires
      sidon-berth-selected, occupied berths are painted for [from, to), and
      from/to follow their attributes. No card, availability or boat-length
      checks. Default 'guest'. */
  mode?: 'guest' | 'staff';
  /** Re-reads the map payload. Undefined until the element has mounted
      (a microtask after it is connected), so call `el.refresh?.()`. */
  readonly refresh?: () => void;
  bookPath?: string;
```

- [ ] **Step 8: Demo: a staff-mode map with date inputs and a refresh button**

In `W/demo/index.html`, insert a new row after the berth-map row (after line 100, before `<div id="log"></div>`):
```html
          show-weather="true"
        ></sidon-berth-map>
      </div>
    </div>

    <div id="log"></div>
```
→
```html
          show-weather="true"
        ></sidon-berth-map>
      </div>
    </div>

    <div class="row">
      <div class="col" style="flex-basis: 100%;">
        <h2>Berth map, staff mode (the OTA dashboard's map)</h2>
        <p>
          <label>From <input type="date" data-staff-attr="from" /></label>
          <label>To <input type="date" data-staff-attr="to" /></label>
          <button type="button" id="staff-refresh">refresh()</button>
        </p>
        <sidon-berth-map
          id="staff-map"
          marina="demo-marina"
          maps-api-key="YOUR_DEV_MAPS_KEY"
          map-style="chart"
          mode="staff"
          locale="en"
          map-height="420px"
        ></sidon-berth-map>
      </div>
    </div>

    <div id="log"></div>
```

Wire the controls at the end of the inline module script (lines 116-121):
```js
        el.addEventListener('sidon-quickbook-submit', (e) => write(`[berth-map ${i}] quickbook-submit: ${JSON.stringify(e.detail)}`));
      });
    </script>
```
→
```js
        el.addEventListener('sidon-quickbook-submit', (e) => write(`[berth-map ${i}] quickbook-submit: ${JSON.stringify(e.detail)}`));
      });
      // Staff mode re-reads from/to after mount, so these inputs drive the
      // attributes the way a host page changing the day would.
      const staffMap = document.getElementById('staff-map');
      document.querySelectorAll('[data-staff-attr]').forEach((input) => {
        input.addEventListener('change', () => {
          if (input.value) staffMap.setAttribute(input.dataset.staffAttr, input.value);
        });
      });
      document.getElementById('staff-refresh').addEventListener('click', () => {
        staffMap.refresh?.();
        write('[staff map] refresh()');
      });
    </script>
```

- [ ] **Step 9: Gates**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npm test && npm run check; echo "exit=$?"`
Expected: `check-ota: ok` (after the two astro-proxy lines), then svelte-check ends `COMPLETED … FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, both `tsc` runs print nothing, and the last line is `exit=0`.

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npx tsc --ignoreConfig --noEmit --skipLibCheck false --lib es2023,dom src/elements.d.ts; echo "exit=$?"`
Expected: `exit=0` with no other output.

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npm run build; echo "exit=$?" && ls dist`
Expected: both Vite builds print `✓ built in …`, then `exit=0`. `dist` lists `sidon-berth-map.js`, `sidon-booking-widget.js`, `astro-proxy.js`, `astro-proxy.d.ts`, `elements.d.ts`, `custom-element.d.ts` and `custom-element-berth-map.d.ts`. `dist/` is gitignored.

- [ ] **Step 10: Manual check against local OTA demo-marina**

Start OTA and seed it:
```bash
cd C:/Users/robert/source/repos/OTA && npm run dev
# second shell
cd C:/Users/robert/source/repos/OTA && node -r dotenv/config scripts/seed-marina-demo.js
```
If the key the seed prints differs from `OTA_DEMO_API_KEY` in `W/demo/.env.local`, update it there. The file is gitignored. For the visual checks, temporarily replace `YOUR_DEV_MAPS_KEY` on both `<sidon-berth-map>` elements in `demo/index.html` with a real dev Maps key. Step 11 restores it. Then run `cd C:/Users/robert/source/repos/sidon-booking-widget && npm run dev`, open `http://localhost:5173/` and keep DevTools open on the Network tab.

- **Staff map, network:**
  - About 200 ms after load, the staff map (berth-map 1) makes one `GET /api/marina/guest/demo-marina?from=<today>&to=<tomorrow>`.
  - It makes no `/availability` request. Only the guest map, berth-map 0, sends one.
  - Clicking **refresh()** logs `[staff map] refresh()` and sends exactly one more GET with the same query.
  - Setting **From** to a later date and then **To** to the day after sends a GET with those dates. If **To** is not after **From**, the request carries no range, which the widget drops by design.
- **Staff map, chart style (needs the real key):**
  - There is no quick-book card.
  - A6 (seeded `status: 'maintenance'`) is painted solid navy. Free berths are gold.
  - Every berth shows a pointer cursor, A6 included.
  - Clicking A6 logs `[berth-map 1] berth-selected: {"berthId":"A6"}` and turns A6 into the selected look. Clicking A6 again logs `{"berthId":null}`.
  - Zoom in, then click **refresh()** and change the dates. The zoom stays.
- **Staff map, coastal style:**
  - In the console, run `const s = document.createElement('sidon-berth-map'); Object.entries({ marina: 'demo-marina', 'maps-api-key': document.getElementById('staff-map').getAttribute('maps-api-key'), 'map-style': 'coastal', mode: 'staff' }).forEach(([k, v]) => s.setAttribute(k, v)); s.addEventListener('sidon-berth-selected', (e) => console.log(JSON.stringify(e.detail))); document.body.append(s);`
  - Clicking A6, which keeps the existing grey occupied paint, logs `{"berthId":"A6"}`. Clicking a free berth logs its label and paints it gold.
- **Guest map (berth-map 0):**
  - Zoom in, then change the card's dates. The map refetches (Network) and keeps the zoom.
  - A6 stays grey and clicking it logs nothing.
  - The card and the auto-pick work as before.

Stop the dev server. Restore the placeholder key, then confirm it:
```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && grep -c 'maps-api-key="YOUR_DEV_MAPS_KEY"' demo/index.html
```
Expected: `3`.

- [ ] **Step 11: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/lib/ota.ts scripts/check-ota.ts src/BerthMap.svelte src/components/BerthMapView.svelte src/elements.d.ts demo/index.html && git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "Widget 1.1: staff map mode, refresh(), fit once" -m "<sidon-berth-map mode=\"staff\"> (R3): no card, no availability fetch or LOA fit, every listed berth clickable (berthPickable), unavailable berths painted navy in chart style, from/to follow their attributes. refresh() refetches the map payload (R4). fitBounds runs only on the first data load in both modes, so a refetch or a guest's date change keeps the zoom (R5). sidon-berth-selected detail unchanged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Do not push or publish. Task 4 cuts 1.1.0, and the runbook publishes it later.

---

### Task 4: Widget 1.1: booking-page locale, neutral expired copy, 1.1.0 release prep

Repo `W` = `C:/Users/robert/source/repos/sidon-booking-widget`, branch `main`, committed directly. Contract R8, R9, R10, R11. Starts after the Task 2 and Task 3 commits. The README below documents their `auth`, `timeoutMs`, `mode` and `refresh()` behaviour, and `scripts/check-ota.ts` already imports `berthPickable`. R11: no other plan B deferred minor is touched here.

**Files:**
- Modify: `W/src/lib/ota.ts`, lines 38-43 (`langOf`). Add `viewLang` right after it.
- Modify: `W/scripts/check-ota.ts`, the import list (its last entry `toCreateBody,`, line 26 before Task 3) and the final `console.log('check-ota: ok');`.
- Modify: `W/src/components/BookingView.svelte`, lines 30 (prop type), 48-50 (labels and view), 79-82 (`fmtDate`/`fmtTime`), 159 (Stripe `locale`), 338 and 374 (`formatMoney`), 379 and 382 (`DocumentsSection` / `ContractSection`).
- Modify: `W/src/BookingWidget.svelte`, lines 55-56 (`locale` prop doc), 96 (default), 523 (booking-page `<BookingView>`), 535-536 (`<Summary>`), 565-574 (step 3 `<BookingView>`). Lines 120 (`lang = $derived(langOf(locale))`), 394 (`locale: lang`) and 560-561 (`PaymentStep`) stay as they are.
- Modify: `W/src/lib/i18n.ts`, lines 66 (`hero` doc comment), 179-183 (it), 294-298 (en), 409-413 (fr), 524-528 (es).
- Modify: `W/src/elements.d.ts`, line 47 (`SidonBookingWidgetElement.locale` doc comment).
- Modify: `W/demo/booking.html`, line 42. Drop `locale="en"` so the demo booking page shows the new rule.
- Modify: `W/README.md`, lines 10, 34, 107, 149-150, 208, 273, 299, 329-332, 339-345, 373-376, 434, 442 and 505.
- Modify: `W/package.json` and `W/package-lock.json`, version only, through `npm version minor --no-git-tag-version`.

**Interfaces:**
- **Consumes:**
  - `langOf(locale: string | null | undefined): BookLang` (`W/src/lib/ota.ts:40`).
  - `adaptBooking(raw).locale: BookLang`, which is already `langOf(raw.locale)` (`ota.ts:132`). `BookingView`'s `view.booking.locale` therefore always holds a valid `BookLang`.
  - `getLabels(lang: BookLang)` (`W/src/lib/i18n.ts`).
  - Task 2 (README only): `createMarinaProxy` `auth?: MarinaProxyAuth<C>`, the `401 {"error":"Not signed in"}` answer and the construction error, and `MarinaClientOptions.timeoutMs` (default 30000, 504 on timeout, 502 on network failure).
  - Task 3 (README only): `<sidon-berth-map mode="staff">`, `refresh()`, reactive `from`/`to` in staff mode, and fitting the map once.
- **Produces:**
  - `export function viewLang(attr: string | null | undefined, bookingLocale: BookLang | null | undefined): BookLang` in `W/src/lib/ota.ts`.
  - `BookingView` prop `lang: BookLang | null` (null means follow the booking). Inside it, `const shownLang = $derived(viewLang(lang, view?.booking.locale))`.
  - `BookingWidget` prop `locale` defaults to `''`. Both `<BookingView>` sites get `lang={locale ? lang : null}`, and `<Summary>` gets `locale={locale || 'en'}`.
  - `hero.expired` uses the contract's exact copy in en, it, fr and es.
  - `@forgebuild/sidon-booking-widget@1.1.0` in `package.json` and `package-lock.json`, not published and not tagged. Task 5 packs it into `D/vendor/forgebuild-sidon-booking-widget-1.1.0.tgz`.

- [ ] **Step 1: Write the failing `viewLang` check**

In `W/scripts/check-ota.ts`, add `viewLang` to the end of the import list:

```ts
  toCreateBody,
} from '../src/lib/ota.ts';
```
→
```ts
  toCreateBody,
  viewLang,
} from '../src/lib/ota.ts';
```

Replace the last line:

```ts
console.log('check-ota: ok');
```
with:
```ts
// ---- viewLang (R8: booking page follows the booking's own locale) -------------
// An emailed link opens the booking page with no `locale` attribute, so the
// labels must come from the booking; a site that sets the attribute still wins,
// even with a language OTA doesn't speak.
assert.equal(viewLang('', 'it'), 'it');
assert.equal(viewLang('fr-FR', 'it'), 'fr');
assert.equal(viewLang('de-DE', 'it'), 'en');
assert.equal(viewLang(null, null), 'en');
assert.equal(viewLang(undefined, 'es'), 'es');

console.log('check-ota: ok');
```

- [ ] **Step 2: Run the check and watch it fail**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-ota.ts
```
Expected: exit code 1, with
`SyntaxError: The requested module '../src/lib/ota.ts' does not provide an export named 'viewLang'`.

- [ ] **Step 3: Implement `viewLang` in `W/src/lib/ota.ts`**

```ts
export function langOf(locale: string | null | undefined): BookLang {
  const l = (locale ?? '').slice(0, 2).toLowerCase() as BookLang;
  return LANGS.includes(l) ? l : 'en';
}
```
→
```ts
export function langOf(locale: string | null | undefined): BookLang {
  const l = (locale ?? '').slice(0, 2).toLowerCase() as BookLang;
  return LANGS.includes(l) ? l : 'en';
}

// The booking page is opened from OTA's emails with no `locale` attribute, so
// it speaks the language the guest booked in (the one their emails use); a
// site that sets the attribute still wins.
export function viewLang(attr: string | null | undefined, bookingLocale: BookLang | null | undefined): BookLang {
  return attr ? langOf(attr) : (bookingLocale ?? 'en');
}
```

- [ ] **Step 4: Run the check and watch it pass**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-ota.ts
```
Expected: `check-ota: ok`.

- [ ] **Step 5: `BookingView` follows the booking's locale (`W/src/components/BookingView.svelte`)**

Import (line 6):
```ts
  import { formatMoney, resumeStep, shouldPoll } from '../lib/ota';
```
→
```ts
  import { formatMoney, resumeStep, shouldPoll, viewLang } from '../lib/ota';
```

Prop type (line 30):
```ts
    lang: BookLang;
    currencySymbol: string;
```
→
```ts
    /** null: follow the booking's own locale (no `locale` attribute on the
        element); a value forces that language. */
    lang: BookLang | null;
    currencySymbol: string;
```

Lines 48-50. `shownLang` reads `view`, so it is declared after it:
```ts
  const labels = $derived(getLabels(lang));

  let view = $state<View | null>(null);
```
→
```ts
  let view = $state<View | null>(null);
  // Every label, date, amount and the Stripe form use this, never `lang`:
  // until the booking loads it is the attribute's language or 'en'.
  const shownLang = $derived(viewLang(lang, view?.booking.locale));
  const labels = $derived(getLabels(shownLang));
```

Lines 79-82:
```ts
  const fmtDate = (ymd: string | null) =>
    parseISODate(ymd)?.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' }) ?? '';
  const fmtTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : '';
```
→
```ts
  const fmtDate = (ymd: string | null) =>
    parseISODate(ymd)?.toLocaleDateString(shownLang, { day: 'numeric', month: 'short', year: 'numeric' }) ?? '';
  const fmtTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(shownLang, { hour: '2-digit', minute: '2-digit' }) : '';
```

Line 159 (in `createPaymentSession({...})`):
```ts
        locale: lang,
```
→
```ts
        locale: shownLang,
```

Line 338:
```svelte
          <span class="sbw-panel-amount">{labels.total} {formatMoney(b.totalPrice, b.currency, currencySymbol, lang)}</span>
```
→
```svelte
          <span class="sbw-panel-amount">{labels.total} {formatMoney(b.totalPrice, b.currency, currencySymbol, shownLang)}</span>
```

Line 374:
```svelte
        <dd>{b.totalPrice == null ? labels.priceOnRequest : formatMoney(b.totalPrice, b.currency, currencySymbol, lang)}</dd>
```
→
```svelte
        <dd>{b.totalPrice == null ? labels.priceOnRequest : formatMoney(b.totalPrice, b.currency, currencySymbol, shownLang)}</dd>
```

Line 379:
```svelte
      <DocumentsSection {apiOrigin} {slug} {session} {lang} booking={b} {requirements} documents={view.documents} onchange={load} />
```
→
```svelte
      <DocumentsSection {apiOrigin} {slug} {session} lang={shownLang} booking={b} {requirements} documents={view.documents} onchange={load} />
```

Line 382:
```svelte
      <ContractSection {apiOrigin} {slug} {session} {lang} booking={b} contract={view.contract} onchange={load} />
```
→
```svelte
      <ContractSection {apiOrigin} {slug} {session} lang={shownLang} booking={b} contract={view.contract} onchange={load} />
```

Confirm that no bare `lang` use is left apart from the prop declaration and the destructure:
```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && grep -nE "\blang\b" src/components/BookingView.svelte
```
Expected: exactly lines 1 (`<script lang="ts">`), 32 (`lang: BookLang | null;`), 43 (the `$props()` destructure) and the `shownLang` line (`viewLang(lang, view?.booking.locale)`).

- [ ] **Step 6: `BookingWidget` stops forcing English on the booking page (`W/src/BookingWidget.svelte`)**

Prop doc (lines 55-56):
```ts
    berth?: string;
    locale?: string;
```
→
```ts
    berth?: string;
    /** en/it/fr/es (first two letters). Absent: the wizard is English and the
        booking page follows the booking's own locale. */
    locale?: string;
```

Default (line 96):
```ts
    locale = 'en',
```
→
```ts
    locale = '',
```

Booking-page mode (line 523). This also serves a resumed session:
```svelte
      <BookingView {apiOrigin} slug={marina} {session} {lang} {currencySymbol} {variant} host={hostEl} onstatus={onStatus} />
```
→
```svelte
      <BookingView {apiOrigin} slug={marina} {session} lang={locale ? lang : null} {currencySymbol} {variant} host={hostEl} onstatus={onStatus} />
```

`<Summary>` (lines 535-536). `toLocaleDateString('')` throws a RangeError, so the empty default must not reach it:
```svelte
        {maxLoa}
        {locale}
```
→
```svelte
        {maxLoa}
        locale={locale || 'en'}
```

Wizard step 3 (lines 565-574):
```svelte
      <BookingView
        {apiOrigin}
        slug={marina}
        {session}
        {lang}
        {currencySymbol}
```
→
```svelte
      <BookingView
        {apiOrigin}
        slug={marina}
        {session}
        lang={locale ? lang : null}
        {currencySymbol}
```

In `W/demo/booking.html`, line 42:
```html
    <sidon-booking-widget marina="demo-marina" booking-id locale="en"></sidon-booking-widget>
```
→
```html
    <sidon-booking-widget marina="demo-marina" booking-id></sidon-booking-widget>
```

In `W/src/elements.d.ts`, line 47 in `SidonBookingWidgetElement` (Task 3 edits only `SidonBerthMapElement`):
```ts
  berth?: string;
  locale?: string;
  currencySymbol?: string;
  variant?: 'navy' | 'dark';
```
→
```ts
  berth?: string;
  /** en/it/fr/es (first two letters). Unset: the wizard is English and the
      booking page follows the booking's own locale. */
  locale?: string;
  currencySymbol?: string;
  variant?: 'navy' | 'dark';
```
The `variant` line makes this anchor unique: the berth-map interface has `locale?: string;` right after `mapStyle`.

- [ ] **Step 7: Neutral "expired" copy (`W/src/lib/i18n.ts`)**

Red check. The old copy is still there:
```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && grep -cE "Time ran out|Tempo scaduto|Temps écoulé|Se acabó el tiempo" src/lib/i18n.ts
```
Expected: `4`.

Line 66. OTA's `expired` flag (`cancel_reason === 'expired'`) can't tell a lapsed hold from an unanswered request:
```ts
  /** One hero per OTA status, plus `expired` (a hold that lapsed unpaid). */
```
→
```ts
  /** One hero per OTA status, plus `expired`: a hold that lapsed or a request
      the marina never answered. OTA can't tell which, so the copy blames no one. */
```

Italian (lines 179-183):
```ts
      expired: {
        eyebrow: 'Riserva scaduta',
        title: 'Tempo scaduto',
        body: "La prenotazione non è stata completata in tempo, quindi l'ormeggio è stato rilasciato. Puoi prenotare di nuovo.",
      },
```
→
```ts
      expired: {
        eyebrow: 'Prenotazione scaduta',
        title: 'Questa prenotazione è scaduta',
        body: 'La prenotazione è scaduta prima di essere confermata, quindi il posto barca è stato liberato. Puoi prenotare di nuovo quando vuoi.',
      },
```

English (lines 294-298):
```ts
      expired: {
        eyebrow: 'Hold expired',
        title: 'Time ran out',
        body: "The booking wasn't completed in time, so the berth was released. You're welcome to book again.",
      },
```
→
```ts
      expired: {
        eyebrow: 'Booking expired',
        title: 'This booking has expired',
        body: "This booking expired before it was confirmed, so the berth was released. You're welcome to book again.",
      },
```

French (lines 409-413):
```ts
      expired: {
        eyebrow: 'Délai dépassé',
        title: 'Temps écoulé',
        body: "La réservation n'a pas été finalisée à temps, la place a donc été libérée. Vous pouvez réserver à nouveau.",
      },
```
→
```ts
      expired: {
        eyebrow: 'Réservation expirée',
        title: 'Cette réservation a expiré',
        body: "La réservation a expiré avant d'être confirmée, l'anneau a donc été libéré. Vous pouvez réserver à nouveau.",
      },
```

Spanish (lines 524-528):
```ts
      expired: {
        eyebrow: 'Reserva caducada',
        title: 'Se acabó el tiempo',
        body: 'La reserva no se completó a tiempo, así que el amarre se ha liberado. Puedes volver a reservar.',
      },
```
→
```ts
      expired: {
        eyebrow: 'Reserva caducada',
        title: 'Esta reserva ha caducado',
        body: 'La reserva caducó antes de confirmarse, así que el amarre quedó libre. Puedes volver a reservar cuando quieras.',
      },
```

Green check:
```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && grep -cE "Time ran out|Tempo scaduto|Temps écoulé|Se acabó el tiempo" src/lib/i18n.ts; grep -c "expired before it was confirmed\|scaduta prima di essere confermata\|expiré avant d'être confirmée\|caducó antes de confirmarse" src/lib/i18n.ts
```
Expected: `0`, then `4`.

- [ ] **Step 8: Type check**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm run check
```
Expected:
- svelte-check ends `COMPLETED … FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.
- Both `tsc` runs print nothing, and the exit code is 0.
- A `Type 'BookLang | null' is not assignable to type 'BookLang'` error on `DocumentsSection` or `ContractSection` means a `{lang}` shorthand from Step 5 was missed.

- [ ] **Step 9: Smoke the booking page against local OTA (manual, nothing committed)**

Prerequisites, as in plan B:
- OTA is running: `cd C:/Users/robert/source/repos/OTA && npm run dev` (or with `PORT=3100`).
- The demo is seeded: `node -r dotenv/config scripts/seed-marina-demo.js`.
- `W/demo/.env.local` holds `OTA_DEMO_API_KEY=<key>`, plus `OTA_DEMO_BASE_URL=http://localhost:3100` if OTA is on 3100.

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm run dev -- --port 5199 --strictPort
```
Run it in the background. Then create an Italian booking through the dev forwarder:
```bash
curl -s -X POST http://localhost:5199/api/marina/guest/demo-marina/bookings -H 'Content-Type: application/json' \
  -d '{"berth_label":"A2","arrival":"2027-05-10","departure":"2027-05-12","contact_name":"Lingua Test","contact_email":"lingua@example.test","boat_name":"Prova","boat_length_m":9,"locale":"it"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.booking.id, j.booking_token)})"
```
Expected: one line with `<id> <token>`. With Playwright MCP:
1. `browser_navigate` to `http://localhost:5199/booking.html?booking=<id>&token=<token>`. The hero eyebrow reads `Quasi fatto`, and the dates read like `10 mag 2027`.
2. `browser_evaluate` with `() => document.querySelector('sidon-booking-widget').setAttribute('locale', 'fr')`. The eyebrow switches to `Presque fini`, so an explicit attribute wins.

Clean up:
```bash
curl -s -X POST "http://localhost:5199/api/marina/guest/demo-marina/bookings/<id>/cancel" -H 'Content-Type: application/json' -H "X-Booking-Token: <token>" -d '{}'
```
Expected: JSON with `"status":"cancelled"`. Stop the dev server.

- [ ] **Step 10: README for 1.1 (`W/README.md`)**

Line 10:
```md
| `@forgebuild/sidon-booking-widget/berth-map` | `<sidon-berth-map>`: a Google map of the marina's berths with a quick-book card |
```
→
```md
| `@forgebuild/sidon-booking-widget/berth-map` | `<sidon-berth-map>`: a Google map of the marina's berths with a quick-book card, or an operator's occupancy view in [staff mode](#staff-mode) |
```

Lines 34, 434 and 442: replace each of the three occurrences of `@forgebuild/sidon-booking-widget@^1.0.0` with `@forgebuild/sidon-booking-widget@^1.1.0`. Line 429's "1.0 talks to OTA" stays.

After line 107, add the staff rail:
```md
The forwarder passes on every guest route, so a site's own enquiry form can post through it too,
to `/api/marina/guest/{slug}/enquiries`.
```
→
````md
The forwarder passes on every guest route, so a site's own enquiry form can post through it too,
to `/api/marina/guest/{slug}/enquiries`.

**Signed-in staff: `auth` instead of `keys`.** An operator dashboard forwards the signed-in staff
member's own credential instead of a site key. Give `auth` instead of `keys`. Exactly one of the two
is allowed: `createMarinaProxy` throws when both or neither are given.

```ts
// src/pages/api/marina/guest/[...path].ts in the dashboard
import type { APIContext } from 'astro';
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

export const prerender = false;

const proxy = createMarinaProxy<APIContext>({
  otaBaseUrl: import.meta.env.PUBLIC_OTA_API_BASE_URL,
  auth: async (context) => {
    const { userId, getToken } = context.locals.auth();
    const token = userId ? await getToken() : null;
    return token ? { authorization: `Bearer ${token}` } : null;
  },
});

export const GET = proxy;
```

- `auth(context, slug)` runs after the method and path checks, so a rejected path never reaches it.
  It returns the headers to add upstream. If it returns `null`, the forwarder answers
  `401 {"error":"Not signed in"}`.
- The caller's own `Authorization` header and cookies are still never passed on. Only the headers
  `auth` returns are. No `X-Api-Key` is added.
````

`createMarinaClient` (lines 149-150):
```md
- Any other error status throws a `MarinaClientError` (also exported). Its `status` property holds
  the HTTP status.
```
→
```md
- Any other error status throws a `MarinaClientError` (also exported). Its `status` property holds
  the HTTP status.
- Each request gives up after `timeoutMs` (default `30000`) and throws a `MarinaClientError` with
  status 504. If OTA can't be reached at all, the status is 502.
```

`locale` row (line 208):
```md
| `locale` | `en` | `en`, `it`, `fr` or `es`. Only the first two letters count (`it-IT` is `it`), and any other value means `en`. It also sets the language of OTA's emails about the booking. |
```
→
```md
| `locale` | `en` (wizard), the booking's language (booking page) | `en`, `it`, `fr` or `es`. Only the first two letters count (`it-IT` is `it`), and any other value means `en`. It also sets the language of OTA's emails about the booking. On [the booking page](#the-booking-page), leave it unset; see "Language" there. |
```

Booking page language (after line 273):
```md
The page can be prerendered or rendered on demand. In the browser, the widget reads
`?booking=&token=` from the URL and keeps both values in `sessionStorage`. It then removes `token`
from the address bar with `history.replaceState`.
```
→
```md
The page can be prerendered or rendered on demand. In the browser, the widget reads
`?booking=&token=` from the URL and keeps both values in `sessionStorage`. It then removes `token`
from the address bar with `history.replaceState`.

**Language.** Leave `locale` off this page. The booking view then uses the language the booking was
made in: the wizard's `locale`, or the language staff picked. That is also the language of OTA's
emails. A `locale` attribute overrides it.
```

Expired wording (line 299):
```md
- the status (hold, pending, confirmed, declined, cancelled or expired) and the booking's details
```
→
```md
- the status (hold, pending, confirmed, declined, cancelled or expired) and the booking's details.
  "Expired" covers both a hold that lapsed and a request the marina didn't answer in time. Its
  wording says only that the booking expired before it was confirmed and the berth was released.
```

Berth map behaviour (lines 329-332):
```md
- The card's total, and its automatic pick (the cheapest free berth that fits), come from OTA's
  availability route. So the price shown is the price charged.
```
→
```md
- The card's total, and its automatic pick (the cheapest free berth that fits), come from OTA's
  availability route. So the price shown is the price charged.
- The map zooms to fit the marina once, on its first load. Changing dates or reloading the data
  keeps the visitor's zoom and position.
```

`mode` row (after line 339):
```md
| `maps-api-key` | required | Google Maps JS API key. |
```
→
```md
| `maps-api-key` | required | Google Maps JS API key. |
| `mode` | `guest` | `guest` or `staff`; see [Staff mode](#staff-mode). |
```

`from`/`to` row (line 345):
```md
| `from` / `to` / `length` / `berth` | today / +1 night / `15` / none | Initial state, same as for `<sidon-booking-widget>`. |
```
→
```md
| `from` / `to` / `length` / `berth` | today / +1 night / `15` / none | Initial state, same as for `<sidon-booking-widget>`. In staff mode, `from` and `to` stay live. |
```

Staff mode subsection (lines 373-376):
```md
- `sidon-quickbook-submit` sends `{ from, to, length, berth }` and is dispatched with
  `cancelable: true`.

## TypeScript
```
→
````md
- `sidon-quickbook-submit` sends `{ from, to, length, berth }` and is dispatched with
  `cancelable: true`.

### Staff mode

`mode="staff"` turns the map into an operator's view of who is on which berth for `[from, to)`. It
is meant for a dashboard whose forwarder uses `auth` (see [the forwarder route](#the-forwarder-route)).

```ts
const map = document.createElement('sidon-berth-map');
map.setAttribute('marina', slug);
map.setAttribute('mode', 'staff');
map.setAttribute('from', today); // YYYY-MM-DD, in the marina's own time zone
map.setAttribute('to', tomorrow);
map.setAttribute('maps-api-key', mapsApiKey);
map.addEventListener('sidon-berth-selected', (e) => openPanel(e.detail.berthId)); // null = deselected
host.replaceChildren(map);

// After an edit, or a live booking event:
map.refresh?.();
```

- It shows no quick-book card and makes no availability lookup. Berths aren't greyed by boat
  length.
- Every berth OTA lists can be clicked, booked or not. `sidon-berth-selected` works as in guest
  mode.
- A berth that isn't available for `[from, to)` (booked, held or under maintenance) is painted as
  occupied: a solid navy circle in `chart` style, the usual occupied style in `coastal`. The
  selected berth stays highlighted.
- Changing `from` or `to` reloads the map. In guest mode, they're read only once.
- `refresh()` reloads the map data. Call it as `el.refresh?.()`, so a page running an older build
  doesn't throw.

## TypeScript
````

Publishing note (after line 505):
```md
`npm publish` runs `prepublishOnly` first, which rebuilds `dist/`, so a stale build can't ship.
Version 0.4.8 shipped a stale build before this script was added.
```
→
```md
`npm publish` runs `prepublishOnly` first, which rebuilds `dist/`, so a stale build can't ship.
Version 0.4.8 shipped a stale build before this script was added.

1.1.0 was bumped with `npm version minor --no-git-tag-version`, so it has no commit or tag of its
own. To release it, skip `npm version`, run `npm publish`, then `git tag v1.1.0` before
`git push && git push --tags`.
```

- [ ] **Step 11: Bump to 1.1.0 (no commit, no tag)**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm version minor --no-git-tag-version && git diff --stat -- package.json package-lock.json
```
Expected:
- `npm version` prints `v1.1.0`.
- The stat shows `package.json | 2 +-` and `package-lock.json | 4 ++--` (the root `version` and `packages[""].version`).
- `git tag -l v1.1.0` prints nothing.

- [ ] **Step 12: All gates**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm test && npm run check && npm run build && ls dist && npm pack --dry-run
```
Expected:
- `npm test` ends with `check-astro-proxy: ok`, `check-astro-proxy: createMarinaClient assertions passed` and `check-ota: ok`.
- `npm run check` reports `0 ERRORS 0 WARNINGS`.
- `npm run build` exits 0.
- `ls dist` lists `astro-proxy.d.ts`, `astro-proxy.js`, `custom-element-berth-map.d.ts`, `custom-element.d.ts`, `elements.d.ts`, `sidon-berth-map.js` and `sidon-booking-widget.js`.
- `npm pack --dry-run` lists exactly `README.md`, those 7 `dist/` files and `package.json`. It also shows `version: 1.1.0`, `filename: forgebuild-sidon-booking-widget-1.1.0.tgz` and `total files: 9`.

No `.tgz` is written. Task 5 packs the tarball into `D/vendor`.

- [ ] **Step 13: Commit**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && git status --short
```
Expected: only the 10 paths below show as modified. `dist/` and `demo/.env.local` are gitignored.

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/lib/ota.ts scripts/check-ota.ts src/components/BookingView.svelte src/BookingWidget.svelte src/lib/i18n.ts src/elements.d.ts demo/booking.html README.md package.json package-lock.json && git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "Widget 1.1: booking page follows the booking's language; neutral expired copy; 1.1.0" -m "Without a locale attribute the booking page now labels, dates, prices and the Stripe form in the booking's own locale (viewLang), so a guest arriving from an Italian email reads Italian; an explicit attribute still wins and the wizard stays English by default. The expired hero no longer blames the guest: OTA's expired flag covers both a lapsed hold and a request the marina never answered. README documents staff map mode, refresh(), the proxy's auth rail and the client timeout. Version 1.1.0, not published or tagged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Nothing is pushed, tagged or published here. The release runbook later runs `npm login`, `npm publish` and `git tag v1.1.0`, then `git push && git push --tags`, as the README's Publishing note describes.

---

### Task 5: Dashboard — vendor widget 1.1.0, legacy alias for the interim page, staff forwarder, nav rule

Repo: `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`, committed directly. One step runs in `W` = `C:/Users/robert/source/repos/sidon-booking-widget` and only builds and packs it (no commit there). Commands are Git Bash. Implements R1, R19, R20, R21 (the interim half) and N1. Pins Review Focus 3 (the interim half) and Review Focus 4 (the dashboard half).

**Files:**
- Create: `D/vendor/forgebuild-sidon-booking-widget-1.1.0.tgz` (the output of `npm pack` in W)
- Modify: `D/package.json`, line 19 (the `@forgebuild/sidon-booking-widget` dependency); add the `sidon-booking-widget-legacy` alias
- Modify: `D/package-lock.json` (regenerated by `npm install`)
- Modify: `D/src/scripts/marina-client.ts`, line 1 (the element import only; interim behaviour is unchanged)
- Create: `D/src/lib/marina-logic.ts`
- Create: `D/scripts/check-marina.ts` (D has no `scripts/` directory yet)
- Create: `D/src/pages/api/marina/guest/[...path].ts`
- Modify (full rewrite, 52 → 72 lines): `D/src/scripts/sidebar-modules-widget.ts`
- Modify: `D/src/layouts/Layout.astro`, lines 78-85 (Marina nav item comment) and lines 111-113 (`isActive`). The file has CRLF line endings, so keep them.
- Create: `D/tests/marina-interim.spec.ts` (Task 13 adds the branch cases)
- Unchanged: `D/src/pages/marina.astro` (`prerender = true`, interim ids `#marina-empty`, `#marina-map`, `#marina-bookings`), `settings-client.ts`, `MODULE_KEYS` and the Sidon fields (R26, R30).

**Interfaces:**
- Consumes:
  - W 1.1.0 from Tasks 2–4: `createMarinaProxy<C>({ otaBaseUrl, auth })` from `@forgebuild/sidon-booking-widget/astro-proxy`. It returns `401 {"error":"Not signed in"}` when `auth` returns `null`, and `404 {"error":"Not found"}` from the path guard before `auth` runs.
  - OTA `GET /api/marina/marinas`: a bare array of active marinas.
  - OTA `GET /api/marina/guest/:slug`: answers `404 {"error":"Marina not found"}` on a staff bearer for an unknown slug.
  - OTA `GET /api/property/me`, which already returns `id, timezone, currency, enabled_modules, sidon_marina_id, sidon_marina_key_set`.
  - `waitForClerkSession` and `apiFetch` from `D/src/scripts/api-client.ts`.
- Produces:
  - `D/src/lib/marina-logic.ts`: `isUuid(s: unknown): s is string`; `staffProxyHeaders(token, propertyCookie): Record<string, string> | null`; types `MarinaStatus`, `PaymentStatus`, `MarinaRow`, `StaffBookingRow`.
  - `D/scripts/check-marina.ts`, which ends `check-marina: ok`.
  - The route `GET /api/marina/guest/[...path]` (the staff map forwarder; GET only).
  - `export function loadMarinas(): Promise<MarinaRow[]>` and a widened `loadProperty()` in `sidebar-modules-widget.ts`.
  - Nav rule R20 and `isActive('/marina')` for every `/marina*` path.
  - Dependencies `"@forgebuild/sidon-booking-widget": "file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz"` and `"sidon-booking-widget-legacy": "npm:@forgebuild/sidon-booking-widget@0.4.17"`.
  - `tests/marina-interim.spec.ts`.

- [ ] **Step 1: Confirm W is at 1.1.0 and committed (Tasks 2–4 done)**

Run:
```bash
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"
git -C C:/Users/robert/source/repos/sidon-booking-widget status --short
```
Expected: `1.1.0`, and no output from `git status` (a clean tree). If either fails, stop: Task 4 is not finished.

- [ ] **Step 2: Build and pack W into D's vendor folder**

Run:
```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm run build && npm pack --pack-destination ../ota-table-bookings/vendor
tar -tzf C:/Users/robert/source/repos/ota-table-bookings/vendor/forgebuild-sidon-booking-widget-1.1.0.tgz | grep -E 'dist/(astro-proxy\.js|sidon-berth-map\.js|astro-proxy\.d\.ts)$'
```
Expected:
- The build finishes with no errors.
- The last line of `npm pack` output is `forgebuild-sidon-booking-widget-1.1.0.tgz`.
- `tar` lists these three entries:
  ```
  package/dist/astro-proxy.d.ts
  package/dist/astro-proxy.js
  package/dist/sidon-berth-map.js
  ```
  (`tar` may list them in a different order.)

- [ ] **Step 3: Point D at the tarball, add the 0.4.17 alias, install**

`D/package.json` line 19, old:
```json
    "@forgebuild/sidon-booking-widget": "^0.4.17",
```
new:
```json
    "@forgebuild/sidon-booking-widget": "file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz",
```
Add the alias as the last entry of `dependencies`. Old:
```json
    "swagger-ui-dist": "^5.32.12"
  },
```
new:
```json
    "swagger-ui-dist": "^5.32.12",
    "sidon-booking-widget-legacy": "npm:@forgebuild/sidon-booking-widget@0.4.17"
  },
```
Run:
```bash
cd C:/Users/robert/source/repos/ota-table-bookings && npm install
node -p "require('./node_modules/@forgebuild/sidon-booking-widget/package.json').version + ' ' + require('./node_modules/sidon-booking-widget-legacy/package.json').version"
grep -n '"resolved": "file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz"' package-lock.json
```
Expected:
- `npm install` exits 0.
- `node -p` prints `1.1.0 0.4.17`.
- `grep` prints one line.

- [ ] **Step 4: The interim page keeps the 0.4.17 element (N1)**

1.x reads `/api/marina/guest/:slug` on its `api-origin`, and Sidon doesn't serve that path. With the dependency swapped, the interim page would otherwise load 1.1.

`D/src/scripts/marina-client.ts` line 1, old:
```ts
import '@forgebuild/sidon-booking-widget/berth-map';
```
new:
```ts
// The 0.4.17 element through the npm alias: 1.x calls /api/marina/guest/ on
// its api-origin, which Sidon doesn't serve. Plan D deletes this page and the
// alias together.
import 'sidon-booking-widget-legacy/berth-map';
```
Nothing else in the file changes.

- [ ] **Step 5: Write the failing check**

Create `D/scripts/check-marina.ts`:
```ts
import assert from 'node:assert/strict';
import { isUuid, staffProxyHeaders } from '../src/lib/marina-logic.ts';

// Pure marina helpers. Run from the repo root: node scripts/check-marina.ts
// (Node strips the types). Each later task appends its own block.

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

// ---- isUuid ----
assert.equal(isUuid(UUID), true);
assert.equal(isUuid(UUID.toUpperCase()), true);
assert.equal(isUuid(UUID.replaceAll('-', '')), false);
assert.equal(isUuid(` ${UUID}`), false);
assert.equal(isUuid(`${UUID}\n`), false);
assert.equal(isUuid('3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6'), false);
assert.equal(isUuid('3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6g'), false);
assert.equal(isUuid(''), false);
assert.equal(isUuid(null), false);
assert.equal(isUuid(undefined), false);
assert.equal(isUuid(42), false);

// ---- staffProxyHeaders ----
assert.equal(staffProxyHeaders(null, UUID), null);
assert.equal(staffProxyHeaders(undefined, UUID), null);
assert.equal(staffProxyHeaders('', UUID), null);
assert.deepEqual(staffProxyHeaders('t', undefined), { authorization: 'Bearer t' });
assert.deepEqual(staffProxyHeaders('t', null), { authorization: 'Bearer t' });
assert.deepEqual(staffProxyHeaders('t', UUID), { authorization: 'Bearer t', 'x-property-id': UUID });
// The cookie is client-controlled: anything but a bare UUID is dropped, never echoed upstream.
for (const bad of ['1; drop', 'abc', '', `${UUID}, ${UUID}`, `${UUID}\r\nx-api-key: k`]) {
  assert.deepEqual(staffProxyHeaders('t', bad), { authorization: 'Bearer t' }, JSON.stringify(bad));
}

console.log('check-marina: ok');
```
Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: FAIL, exit 1, with:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\robert\source\repos\ota-table-bookings\src\lib\marina-logic.ts' imported from C:\Users\robert\source\repos\ota-table-bookings\scripts\check-marina.ts
```

- [ ] **Step 6: Implement `marina-logic.ts`**

Create `D/src/lib/marina-logic.ts`:
```ts
// Pure helpers for the marina pages, shared with scripts/check-marina.ts,
// which Node runs with type stripping: erasable TS only, with no DOM and no
// import.meta.env, so the checks run without a browser or Astro.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Upstream credentials for the staff map forwarder. null means signed out,
// and the forwarder answers 401. The hotal-property-id cookie is
// client-controlled, so only a well-formed UUID becomes x-property-id. OTA
// still resolves that id against the caller's org (resolveStaffProperty).
// Nothing sets the cookie in plan C (R1).
export function staffProxyHeaders(
  token: string | null | undefined,
  propertyCookie: string | null | undefined,
): Record<string, string> | null {
  if (!token) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (isUuid(propertyCookie)) headers['x-property-id'] = propertyCookie;
  return headers;
}

export type MarinaStatus = 'hold' | 'pending' | 'confirmed' | 'declined' | 'cancelled';
export type PaymentStatus = 'none' | 'held' | 'captured' | 'released' | 'refunded';

// GET /api/marina/marinas row (the subset the dashboard reads).
export interface MarinaRow {
  id: string; name: string; slug: string; phone: string | null; email: string | null;
  lat: number | null; lng: number | null; response_window_hours: number; auto_confirm: boolean;
  booking_url: string | null; status: 'active' | 'inactive';
}

// Staff list row. Ably and GET-by-id rows are supersets; merge them by id.
export interface StaffBookingRow {
  id: string; marina_id: string; marina_name: string; berth_id: string; berth_label: string;
  contact_name: string; contact_email: string | null; contact_phone: string | null;
  boat_name: string | null; boat_length_m: string | null; arrival: string; departure: string | null;
  status: MarinaStatus; source: 'guest' | 'staff' | 'import'; total_price: string | null; currency: string | null;
  payment_status: PaymentStatus; payment_error: string | null; hold_expires_at: string | null; created_at: string;
  doc_count?: number; docs_verified?: number;
}
```
Run: `node scripts/check-marina.ts`

Expected: PASS, exit 0, with output `check-marina: ok`.

- [ ] **Step 7: Write the failing Playwright spec**

Create `D/tests/marina-interim.spec.ts`:
```ts
import { test, expect, type Page } from '@playwright/test';

// Deploying the dashboard before Switch (Review Focus 3, interim half) and
// the staff map forwarder as a trust boundary (Review Focus 4, dashboard
// half). The test account has no Sidon marina id, so the Pirates Bight case
// is simulated by rewriting OTA's answers in the browser.

const NAV = '.sidebar-nav a[href="/marina"]';

// apiFetch sends Authorization and a JSON content type, so the browser may
// preflight these cross-origin OTA calls. A stubbed answer needs the CORS
// headers OTA itself would send.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
};

async function stubOta(page: Page, glob: string, body: unknown) {
  await page.route(glob, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({ status: 200, headers: CORS, json: body }),
  );
}

// The real property with only the Sidon fields overridden, so id, timezone
// and enabled_modules stay what the page would really get.
async function stubProperty(page: Page, sidon: { sidon_marina_id: string | null; sidon_marina_key_set: boolean }) {
  await page.route('**/api/property/me', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...sidon } });
  });
}

test.describe('Marina before Switch', () => {
  test('a Sidon-linked property with no OTA marina keeps the interim page on the 0.4.17 element', async ({ page }) => {
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    await stubProperty(page, { sidon_marina_id: 'pw-sidon', sidon_marina_key_set: true });
    await stubOta(page, '**/api/marina/marinas', []);
    await stubOta(page, '**/api/marina/sidon-bookings', []);
    // Keep the test offline: only the request the legacy element makes
    // matters here, not Sidon's or Google's answer.
    await page.route('https://marina.sidonmarine.uk/**', (route) => route.fulfill({ status: 404, json: { error: 'stubbed' } }));
    await page.route('https://maps.googleapis.com/**', (route) => route.abort());

    await page.goto('/marina');

    await expect(page.locator(NAV)).toBeVisible();
    await expect(page.locator(NAV)).toHaveAttribute('aria-current', 'page');
    await page.waitForFunction(() => customElements.get('sidon-berth-map') !== undefined);
    const map = page.locator('#marina-map sidon-berth-map');
    await expect(map).toHaveAttribute('marina', 'pw-sidon');
    await expect(map).toHaveAttribute('api-origin', 'https://marina.sidonmarine.uk');
    // 0.4.17 reads <api-origin>/api/marina/public/<id>. A 1.x element would
    // call /api/marina/guest/ instead.
    await expect
      .poll(() => urls.some((u) => u.startsWith('https://marina.sidonmarine.uk/api/marina/public/pw-sidon')))
      .toBe(true);
    await expect(page.locator('#marina-bookings-message')).toHaveText('No upcoming bookings.');
    expect(urls.filter((u) => u.includes('/api/marina/guest/'))).toEqual([]);
  });

  test('a property with neither a Sidon id nor an OTA marina gets no Marina nav', async ({ page }) => {
    await stubProperty(page, { sidon_marina_id: null, sidon_marina_key_set: false });
    await stubOta(page, '**/api/marina/marinas', []);
    const marinas = page.waitForResponse(
      (res) => res.request().method() === 'GET' && res.url().endsWith('/api/marina/marinas'),
    );

    await page.goto('/dashboard');
    await marinas;
    // An unhide would land within a tick of that response. Give it a second
    // so the hidden assertion below isn't vacuous.
    await page.waitForTimeout(1_000);

    await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible();
    await expect(page.locator(NAV)).toBeHidden();
  });

  test('the staff map forwarder: JSON 401 signed out, OTA answers on the bearer, traversal is 404', async ({ page, playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const res = await anon.get('/api/marina/guest/x');
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not signed in' });
    await anon.dispose();

    await page.goto('/dashboard');
    await page.waitForFunction(() => (window as any).Clerk?.loaded === true && !!(window as any).Clerk.session);
    // getToken() also rewrites the short-lived __session cookie that the
    // forwarder's Clerk middleware reads.
    await page.evaluate(() => (window as any).Clerk.session.getToken());
    const get = (path: string) =>
      page.evaluate(async (p) => {
        const r = await fetch(p);
        return { status: r.status, body: await r.json().catch(() => null) };
      }, path);

    expect(await get('/api/marina/guest/pw-no-such-marina')).toEqual({ status: 404, body: { error: 'Marina not found' } });
    // The browser resolves %2e%2e like '..' (WHATWG URL), so this reaches the
    // forwarder as guest/bookings. It must still be 404, never the staff list
    // /api/marina/bookings (200). The unnormalised path is pinned in W's
    // scripts/check-astro-proxy.ts.
    expect((await get('/api/marina/guest/x/%2e%2e/bookings')).status).toBe(404);
  });
});
```
Start local OTA in a second terminal: `cd C:/Users/robert/source/repos/OTA && npm run dev`. Playwright's `webServer` starts D's `npm run dev` on port 4335, or reuses a running one.

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-interim.spec.ts`

Expected: FAIL with `2 failed`, `2 passed` (the setup project counts as one of the passes).
- The interim test passes (Step 4 kept the 0.4.17 element).
- "no Marina nav" fails with `Test timeout of 45000ms exceeded.` at `await marinas`, because nothing fetches `/api/marina/marinas` yet.
- The forwarder test fails at the first status assert:
  ```
  Expected: 401
  Received: 404
  ```
  The route doesn't exist yet, so Astro serves its 404 page.

- [ ] **Step 8: The staff map forwarder**

Create `D/src/pages/api/marina/guest/[...path].ts`:
```ts
import type { APIContext } from 'astro';
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';
import { staffProxyHeaders } from '../../../../lib/marina-logic';

// Same-origin forwarder for <sidon-berth-map mode="staff">, which has no
// api-origin. OTA gets the signed-in staff member's Clerk bearer and nothing
// from the inbound request's credentials. It goes through the widget's
// tested path guard, header allowlist and timeout. GET only: staff read the
// map here and never quote or book through the guest routes.
export const prerender = false;

const proxy = createMarinaProxy<APIContext>({
  otaBaseUrl: import.meta.env.PUBLIC_OTA_API_BASE_URL,
  auth: async (context) => {
    const { userId, getToken } = context.locals.auth();
    return staffProxyHeaders(userId ? await getToken() : null, context.cookies.get('hotal-property-id')?.value);
  },
});

export const GET = proxy;
```

- [ ] **Step 9: Nav rule and `loadMarinas()`**

Replace the whole of `D/src/scripts/sidebar-modules-widget.ts` with:
```ts
import { apiFetch, waitForClerkSession } from './api-client';
import type { MarinaRow } from '../lib/marina-logic';

// Hides the sidebar nav items (and, on the main dashboard, the matching
// stat tiles/charts/feed cards -- see dashboard-client.ts) for whichever
// modules the property has turned off in Settings > Modules. Every
// toggleable nav item carries data-module="<key>" (set in Layout.astro's
// navItems); this just fetches the property's enabled_modules and hides
// the ones missing from it.

// null (the default -- see migrate-2026-09-12-property-enabled-modules.sql)
// means every module is enabled; check this before assuming a missing key
// means "disabled".
// Memoised: the sidebar and the page script on the same load share one fetch.
let propertyPromise: Promise<{ id?: string; timezone?: string; currency?: string; enabled_modules?: unknown; sidon_marina_id?: string | null; sidon_marina_key_set?: boolean } | null> | undefined;
export function loadProperty() {
  propertyPromise ??= (async () => {
    const hasSession = await waitForClerkSession();
    if (!hasSession) return null;
    const res = await apiFetch('/api/property/me').catch(() => null);
    if (!res || !res.ok) return null;
    return res.json().catch(() => null);
  })();
  return propertyPromise;
}

// OTA's default list holds active marinas only, which is exactly the nav
// rule's "has a marina" test. Memoised like loadProperty, so every marina
// page script shares this fetch. The session check comes first, as in
// loadProperty, so a signed-out page never pops the sign-in modal.
let marinasPromise: Promise<MarinaRow[]> | undefined;
export function loadMarinas(): Promise<MarinaRow[]> {
  marinasPromise ??= (async () => {
    if (!(await waitForClerkSession())) return [];
    const res = await apiFetch('/api/marina/marinas').catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    return Array.isArray(data) ? data : [];
  })();
  return marinasPromise;
}

export async function loadEnabledModules(): Promise<string[] | null> {
  const property = await loadProperty();
  return Array.isArray(property?.enabled_modules) ? property.enabled_modules : null;
}

export function isModuleEnabled(enabledModules: string[] | null, module: string): boolean {
  return enabledModules === null || enabledModules.includes(module);
}

async function applySidebarModules() {
  // Runs on every page, including public ones (docs) and while signed out --
  // loadEnabledModules() itself checks for a session first, same pattern as
  // sidebar-restaurants-widget.ts/api-key-widget.ts, so this is a no-op
  // rather than popping the sign-in modal.
  const enabledModules = await loadEnabledModules();
  if (enabledModules !== null) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-module]')) {
      if (!isModuleEnabled(enabledModules, el.dataset.module!)) el.hidden = true;
    }
  }

  // Marina last, so the marinas fetch never delays hiding disabled modules.
  // R20: shown for a Sidon-linked property (the interim page; plan D removes
  // that half) or one with at least one active OTA marina. The || skips the
  // fetch for an interim property.
  const property = await loadProperty();
  if (property?.sidon_marina_id || (await loadMarinas()).length > 0) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-marina]')) el.hidden = false;
  }
}

applySidebarModules();
```

- [ ] **Step 10: Layout — one Marina item, active on every `/marina*` page**

`D/src/layouts/Layout.astro` lines 78-85 (CRLF), old:
```ts
  {
    href: '/marina',
    label: 'Marina',
    icon: marinaIcon,
    // Not a module toggle: shown only once Settings has a Sidon marina id
    // (sidebar-modules-widget.ts unhides it).
    marina: true,
  },
```
new:
```ts
  {
    href: '/marina',
    label: 'Marina',
    icon: marinaIcon,
    // Not a module toggle: shown when the property has a Sidon marina id
    // (the interim page, until plan D) or at least one active OTA marina --
    // sidebar-modules-widget.ts unhides it. /marina-bookings and
    // /marina-setup are reached from /marina's header buttons, so this one
    // item covers all three.
    marina: true,
  },
```
Lines 111-113 (113-115 after the edit above), old:
```ts
function isActive(href: string): boolean {
  return currentPath === href || currentPath.startsWith(href + '/');
}
```
new:
```ts
function isActive(href: string): boolean {
  // /marina-bookings and /marina-setup have no nav item of their own (R20).
  if (href === '/marina') return currentPath.startsWith('/marina');
  return currentPath === href || currentPath.startsWith(href + '/');
}
```

- [ ] **Step 11: Run every gate**

Run, from `D`, with local OTA still running:
```bash
cd C:/Users/robert/source/repos/ota-table-bookings
node scripts/check-marina.ts
npm run build
npx playwright test tests/marina-interim.spec.ts
```
Expected:
- `check-marina: ok`.
- The build ends with `[build] Complete!` and no errors. The `@forgebuild/sidon-booking-widget/astro-proxy` and `sidon-booking-widget-legacy/berth-map` imports both resolve.
- Playwright reports `4 passed` (setup plus the three tests).

If the "no Marina nav" test fails because the nav is visible, the local test property has a non-null `sidon_marina_id`. The stub overrides it, so look for a second, unstubbed `/api/property/me` fetch instead.

- [ ] **Step 12: Commit (explicit paths; the bracketed route file uses a literal pathspec)**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add \
  vendor/forgebuild-sidon-booking-widget-1.1.0.tgz package.json package-lock.json \
  src/lib/marina-logic.ts scripts/check-marina.ts \
  ':(literal)src/pages/api/marina/guest/[...path].ts' \
  src/scripts/sidebar-modules-widget.ts src/scripts/marina-client.ts src/layouts/Layout.astro \
  tests/marina-interim.spec.ts \
&& git -C C:/Users/robert/source/repos/ota-table-bookings commit \
  -m "Marina dashboard: widget 1.1 vendored, staff map forwarder, Marina nav rule" \
  -m "Vendors @forgebuild/sidon-booking-widget 1.1.0 as a tarball. The interim /marina page keeps the 0.4.17 element through the sidon-booking-widget-legacy npm alias, because 1.x would call /api/marina/guest/ on Sidon. Adds the same-origin staff map forwarder (createMarinaProxy auth rail: Clerk bearer, UUID-only x-property-id, JSON 401 when signed out), marina-logic.ts with its Node check, loadMarinas(), the Marina nav rule (Sidon id or at least one active OTA marina) and isActive for /marina*. tests/marina-interim.spec.ts pins the Pirates Bight interim case, the hidden nav and the forwarder smoke." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Run `git -C C:/Users/robert/source/repos/ota-table-bookings status --short`. Expected: none of the paths above are listed. Nothing is pushed or deployed. The runbook pushes D only after the user approves; the Vercel deploy then serves the interim page unchanged to Pirates Bight.

---

### Task 6: Dashboard — Settings Marina section and Stripe publishable key

Repo `D` (`C:/Users/robert/source/repos/ota-table-bookings`), branch `main`. Implements R26, R14 (reactivate), R29 (403 branch) and R30 (the Sidon form, `#marina-form`, `MODULE_KEYS` and the `sidon_marina_id` nav rule are not touched).

**Files:**
- Modify: `D/src/lib/marina-logic.ts` (created in Task 5). Append `marinaBody` at the end of the file.
- Modify: `D/scripts/check-marina.ts` (created in Task 5). Add `marinaBody` to the named import, and add a `// ---- marinaBody ----` block just before the final `console.log('check-marina: ok');`.
- Modify: `D/src/pages/settings.astro`. Add a tab button after `:13` (Websites) and a panel after `:59` (the end of the Websites panel).
- Modify: `D/src/scripts/settings-client.ts`. Add imports after `:3`, and a new `// ── Marinas ──` section after `:255` (`loadWebsites();`). The Sidon section at `:636-707` stays unchanged.
- Modify: `D/src/styles/global.css`. Add `.marina-row-field` and `.is-inactive` after `.website-add-form` (`:1368-1370`).
- Modify: `D/src/layouts/Layout.astro`. Add `#stripe-publishable-key-form` after the `</form>` that closes `#stripe-key-form` (`:233` before Task 5; Task 5's nav edits sit above `:110`, so the anchor is the `</form>` line, not the number).
- Modify: `D/src/scripts/stripe-key-widget.ts`. Append `mountStripePublishableKeyWidget` after `:71`.
- Modify: `D/src/scripts/org-settings-page-widget.ts`. Change the import at `:4`, and add a mount block after `:36`.
- Create: `D/tests/marina-helpers.ts`, `D/tests/marina-settings.spec.ts`.

**Interfaces:**
- Consumes:
  - From Task 1 (OTA):
    - `GET /api/marina/marinas?include_inactive=1` returns every status, ordered by name.
    - `MARINA_COLS.email` → `v.email`. The 400 body is `{error:'email must be an email address'}`.
  - Existing OTA routes:
    - `POST /api/marina/marinas` returns 201 with the row.
    - `PUT /api/marina/marinas/:id` returns the row.
    - `GET /api/property/stripe/status` returns `{stripeKeyConfigured, stripePublishableKey}`.
    - `PUT /api/property/stripe/publishable-key {stripe_publishable_key}` (admin) returns `{stripePublishableKey}`. It answers 403 `Insufficient permissions` for staff, and 400 for a bad shape or a mode clash.
    - `POST /api/property/stripe/publishable-key/clear` (admin).
  - From Task 5: `type MarinaRow` from `D/src/lib/marina-logic.ts`.
  - Existing in D: `apiFetch` and `escapeHtml` (`api-client.ts`), `showToast` (`toast.ts`), `confirmDialog` (`confirm-dialog.ts`).
- Produces:
  - `export function marinaBody(f: { name: string; slug: string; lat: string; lng: string; email: string; phone: string; response_window_hours: string; auto_confirm: boolean; booking_url: string; status?: 'active' | 'inactive' }): Record<string, unknown>`
  - `export function mountStripePublishableKeyWidget(form: HTMLFormElement)`
  - Settings DOM:
    - Tab `data-tab-target="marina"` and panel `data-settings-tab="marina"`.
    - `#marina-list` (has `aria-busy="true"` until the first load renders) of `li.marina-row[data-id]`, carrying `.is-inactive` when inactive. Each row has `.marina-row-name`, `.marina-row-slug`, `.marina-row-lat`, `.marina-row-lng`, `.marina-row-email`, `.marina-row-phone`, `.marina-row-window`, `.marina-row-auto`, `.marina-row-url` and `.marina-row-save`, plus either `.marina-row-remove` or `.reactivate-btn`.
    - `#marina-add-form` with `#marina-add-name`, `#marina-add-slug`, `#marina-add-lat`, `#marina-add-lng`, `#marina-add-email`, `#marina-add-phone`, `#marina-add-window`, `#marina-add-auto`, `#marina-add-url` and `#marina-add-btn`.
  - Layout DOM: `#stripe-publishable-key-form`, `-input`, `-status`, `-save`, `-clear`.
  - `D/tests/marina-helpers.ts`:
    - `uniqueSlug(prefix = 'pw-marina'): string`
    - `createMarinaViaUi(page, { name, slug }): Promise<string>`
    - `deactivateMarinaViaUi(page, id): Promise<void>`

- [ ] **Step 1: Write the failing `marinaBody` check**

In `D/scripts/check-marina.ts`, add `marinaBody` to the named import from `'../src/lib/marina-logic.ts'`. Task 5 leaves that line as `import { isUuid, staffProxyHeaders } from '../src/lib/marina-logic.ts';`, so it becomes:

```ts
import { isUuid, staffProxyHeaders, marinaBody } from '../src/lib/marina-logic.ts';
```

Insert this block immediately before `console.log('check-marina: ok');`:

```ts
// ---- marinaBody ----
{
  // Blank optional fields clear the column (null), and status is left out
  // unless asked for, so a Save never flips a marina's status.
  assert.deepEqual(
    marinaBody({ name: ' Porto ', slug: ' porto ', lat: '', lng: '  ', email: '', phone: ' ', response_window_hours: '24', auto_confirm: false, booking_url: '' }),
    { name: 'Porto', slug: 'porto', lat: null, lng: null, email: null, phone: null, response_window_hours: 24, auto_confirm: false, booking_url: null },
  );
  // lat/lng stay trimmed strings (OTA's num validator takes them), but
  // response_window_hours must be a JSON number: OTA rejects '48'.
  assert.deepEqual(
    marinaBody({
      name: 'Porto', slug: 'porto', lat: ' 40.6281 ', lng: '-14.4850', email: ' harbour@example.com ', phone: ' +39 089 000 111 ',
      response_window_hours: ' 48 ', auto_confirm: true, booking_url: ' https://example.com/berth?b={id}&t={token} ', status: 'inactive',
    }),
    {
      name: 'Porto', slug: 'porto', lat: '40.6281', lng: '-14.4850', email: 'harbour@example.com', phone: '+39 089 000 111',
      response_window_hours: 48, auto_confirm: true, booking_url: 'https://example.com/berth?b={id}&t={token}', status: 'inactive',
    },
  );
  // An empty hours field reaches OTA as 0, which OTA answers with its own
  // "1-144" message. The UI doesn't guess a value.
  assert.equal(marinaBody({ name: 'a', slug: 'a', lat: '', lng: '', email: '', phone: '', response_window_hours: '', auto_confirm: false, booking_url: '' }).response_window_hours, 0);
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: it exits 1 with
`SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'marinaBody'`

- [ ] **Step 3: Implement `marinaBody`**

Append to the end of `D/src/lib/marina-logic.ts`:

```ts
// ---- Task 6: Settings marina rows ----

// One body for both add (POST) and save (PUT). An empty optional field is
// sent as null so clearing an input clears the column. OTA's num validator
// takes numeric strings for lat/lng, but response_window_hours must be a
// JSON integer, so that is the only field converted here. status is added
// only when given, so Save never touches it; Remove/Reactivate send it alone.
export function marinaBody(f: {
  name: string; slug: string; lat: string; lng: string; email: string; phone: string;
  response_window_hours: string; auto_confirm: boolean; booking_url: string; status?: 'active' | 'inactive';
}): Record<string, unknown> {
  const opt = (s: string) => s.trim() || null;
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    slug: f.slug.trim(),
    lat: opt(f.lat),
    lng: opt(f.lng),
    email: opt(f.email),
    phone: opt(f.phone),
    response_window_hours: Number(f.response_window_hours),
    auto_confirm: f.auto_confirm,
    booking_url: opt(f.booking_url),
  };
  if (f.status) body.status = f.status;
  return body;
}
```

- [ ] **Step 4: Run the check again**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: `check-marina: ok`

- [ ] **Step 5: Write the Playwright helpers and spec (before the page code)**

Create `D/tests/marina-helpers.ts`:

```ts
import { expect, type Page } from '@playwright/test';

// Marina specs create their own marina through Settings → Marina with a fresh
// slug, then soft-delete it through the same UI at the end. OTA has no
// delete, and driving the page avoids needing a Clerk bearer in tests (same
// approach as tests/helpers.ts for room types).

export function uniqueSlug(prefix = 'pw-marina'): string {
  return `${prefix}-${Date.now()}`;
}

// #marina-list drops aria-busy only after its first fetch has rendered, so
// counting rows after this cannot race the load.
async function openMarinaSettings(page: Page) {
  await page.goto('/settings#marina');
  await expect(page.locator('#marina-list:not([aria-busy])')).toBeAttached();
}

export async function createMarinaViaUi(page: Page, opts: { name: string; slug: string }): Promise<string> {
  await openMarinaSettings(page);
  await page.locator('#marina-add-name').fill(opts.name);
  await page.locator('#marina-add-slug').fill(opts.slug);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/marina\/marinas$/.test(r.url())),
    page.locator('#marina-add-btn').click(),
  ]);
  expect(res.status()).toBe(201);
  const id = (await res.json()).id as string;
  await expect(page.locator(`#marina-list li.marina-row[data-id="${id}"]`)).toHaveCount(1);
  return id;
}

export async function deactivateMarinaViaUi(page: Page, id: string): Promise<void> {
  if (!id) return;
  await openMarinaSettings(page);
  const remove = page.locator(`#marina-list li.marina-row[data-id="${id}"] .marina-row-remove`);
  if ((await remove.count()) === 0) return; // already inactive
  await remove.click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/api/marina/marinas/${id}`)),
    page.locator('#confirm-dialog-confirm-btn').click(),
  ]);
}
```

Create `D/tests/marina-settings.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { uniqueSlug, createMarinaViaUi, deactivateMarinaViaUi } from './marina-helpers';

// Settings → Marina (OTA marinas: add, edit, soft-delete, reactivate) and
// the Stripe publishable key beside the secret key in the Clerk org-profile
// modal. One serial chain on a marina made with a fresh slug; afterAll takes
// it offline again. The shared test account is staff: marina edits are open
// to staff, but the publishable key is admin-only, so that save branches on
// 403.
test.describe.serial('Settings marina section', () => {
  const slug = uniqueSlug();
  const name = `Playwright Marina ${Date.now()}`;
  const renamed = `${name} renamed`;
  let marinaId = '';

  // `page` is test-scoped; afterAll builds its own from the signed-in state.
  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  const row = (page: Page) => page.locator(`#marina-list li.marina-row[data-id="${marinaId}"]`);
  const listReady = (page: Page) => expect(page.locator('#marina-list:not([aria-busy])')).toBeAttached();
  const putMarina = (page: Page) =>
    page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes(`/api/marina/marinas/${marinaId}`));

  async function openTab(page: Page) {
    await page.goto('/settings#marina');
    await listReady(page);
  }

  test('create a marina through the add form', async ({ page }) => {
    marinaId = await createMarinaViaUi(page, { name, slug });
    await expect(row(page).locator('.marina-row-name')).toHaveValue(name);
    await expect(row(page).locator('.marina-row-slug')).toHaveValue(slug);
    await expect(row(page).locator('.marina-row-window')).toHaveValue('24');
    await expect(row(page)).not.toHaveClass(/is-inactive/);
  });

  test('rename, save, and the name survives a reload', async ({ page }) => {
    await openTab(page);
    await row(page).locator('.marina-row-name').fill(renamed);
    const [res] = await Promise.all([putMarina(page), row(page).locator('.marina-row-save').click()]);
    expect(res.ok()).toBe(true);
    await expect(page.locator('.toast--success').last()).toContainText(`${renamed}: Marina saved`);

    await page.reload();
    await listReady(page);
    await expect(row(page).locator('.marina-row-name')).toHaveValue(renamed);
  });

  test("an invalid email shows OTA's 400 text", async ({ page }) => {
    await openTab(page);
    await row(page).locator('.marina-row-email').fill('not-an-email');
    const [res] = await Promise.all([putMarina(page), row(page).locator('.marina-row-save').click()]);
    expect(res.status()).toBe(400);
    await expect(page.locator('.toast--error').last()).toContainText(`${renamed}: email must be an email address`);
  });

  test('deactivate greys the row and offers Reactivate, also after a reload', async ({ page }) => {
    await openTab(page);
    await row(page).locator('.marina-row-remove').click();
    const [res] = await Promise.all([putMarina(page), page.locator('#confirm-dialog-confirm-btn').click()]);
    expect((await res.json()).status).toBe('inactive');
    await expect(row(page)).toHaveClass(/is-inactive/);
    await expect(row(page).locator('.reactivate-btn')).toBeVisible();
    await expect(row(page).locator('.marina-row-remove')).toHaveCount(0);

    // Still listed: the section asks OTA for ?include_inactive=1.
    await page.reload();
    await listReady(page);
    await expect(row(page)).toHaveClass(/is-inactive/);
  });

  test('reactivate brings it back', async ({ page }) => {
    await openTab(page);
    const [res] = await Promise.all([putMarina(page), row(page).locator('.reactivate-btn').click()]);
    expect((await res.json()).status).toBe('active');
    await expect(row(page)).not.toHaveClass(/is-inactive/);
    await expect(row(page).locator('.marina-row-remove')).toBeVisible();
    await expect(page.locator('.toast--success').last()).toContainText(`${renamed}: Marina reactivated`);
  });

  test('publishable key sits beside the secret key; a save branches on 403', async ({ page }) => {
    await page.goto('/settings');
    // The form lives in a Clerk custom page that Clerk renders on demand, so
    // open it the way a user does: switcher → Manage → Settings.
    await page.locator('.cl-organizationSwitcherTrigger').click();
    await page.locator('.cl-organizationSwitcherPopoverActionButton__manageOrganization').click();
    const statusRes = page.waitForResponse(
      (res) => res.request().method() === 'GET' && res.url().includes('/api/property/stripe/status'),
    );
    await page.locator('.cl-navbarButton', { hasText: 'Settings' }).click();
    await expect(page.locator('#stripe-key-form')).toBeVisible();
    await expect(page.locator('#stripe-publishable-key-form')).toBeVisible();
    const original = ((await (await statusRes).json()).stripePublishableKey ?? null) as string | null;
    await expect(page.locator('#stripe-publishable-key-status')).toContainText(original ?? 'No Stripe publishable key');

    const input = page.locator('#stripe-publishable-key-input');
    await input.fill(`pk_test_playwright${Date.now()}`);
    const [saveRes] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/api/property/stripe/publishable-key')),
      page.locator('#stripe-publishable-key-save').click(),
    ]);
    // Admin-only: the staff test account gets OTA's 403 text as a toast.
    if (saveRes.status() === 403) {
      await expect(page.locator('.toast--error').last()).toContainText('Failed to save publishable key — Insufficient permissions');
      return;
    }
    // An admin whose stored secret key is live gets OTA's mode-clash 400 as-is.
    if (saveRes.status() === 400) {
      await expect(page.locator('.toast--error').last()).toContainText((await saveRes.json()).error);
      return;
    }
    expect(saveRes.ok()).toBe(true);
    const saved = (await saveRes.json()).stripePublishableKey as string;
    await expect(page.locator('#stripe-publishable-key-status')).toContainText(saved);

    // Put back what was there.
    if (original) {
      await input.fill(original);
      await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/api/property/stripe/publishable-key')),
        page.locator('#stripe-publishable-key-save').click(),
      ]);
    } else {
      page.once('dialog', (d) => d.accept());
      await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/property/stripe/publishable-key/clear')),
        page.locator('#stripe-publishable-key-clear').click(),
      ]);
    }
  });
});
```

- [ ] **Step 6: Run the spec and see it fail**

Prerequisites:
- Local OTA is running with Task 1 (`cd C:/Users/robert/source/repos/OTA && npm run dev`).
- The dashboard is running (`cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background`).

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-settings.spec.ts`

Expected: `setup` passes, and `create a marina through the add form` fails with
`Error: Timed out 15000ms waiting for expect(locator).toBeAttached()` on `Locator: locator('#marina-list:not([aria-busy])')`. The serial chain skips the rest (`1 failed`, `5 did not run` plus `1 passed` for setup; the publishable-key test is not reached).

- [ ] **Step 7: Add the Marina tab and panel to `settings.astro`**

In `D/src/pages/settings.astro`, after `:13` (`… data-tab-target="websites">Websites</button>`), insert:

```astro
      <button type="button" class="settings-tab" role="tab" data-tab-target="marina">Marina</button>
```

After `:59` (the `</div>` that closes the Websites panel), insert:

```astro

    <div class="chart-card settings-card" data-settings-tab="marina" hidden>
      <h2>Marina</h2>
      <div class="chart-card-header">
        <p class="chart-card-subtitle">
          Marinas taking berth bookings through this dashboard. Berths, prices and documents are set up on the Marina page. The slug is the marina's name in website booking widgets, so change it only together with the website.
        </p>
      </div>
      <!-- aria-busy until the first load has rendered (inactive marinas
           included, so they can be reactivated). -->
      <ul id="marina-list" class="websites-list" aria-busy="true"></ul>

      <form id="marina-add-form" class="settings-form website-add-form">
        <label for="marina-add-name">
          Name
          <input id="marina-add-name" type="text" maxlength="100" placeholder="Marina di Positano" required />
        </label>
        <label for="marina-add-slug">
          Slug
          <input id="marina-add-slug" type="text" maxlength="100" placeholder="marina-di-positano" pattern="[a-z0-9]+(-[a-z0-9]+)*" title="Lowercase letters, digits and dashes" required />
        </label>
        <label for="marina-add-lat">
          Latitude
          <input id="marina-add-lat" type="number" step="any" placeholder="40.6281" />
        </label>
        <label for="marina-add-lng">
          Longitude
          <input id="marina-add-lng" type="number" step="any" placeholder="14.4850" />
        </label>
        <label for="marina-add-email">
          Contact email
          <input id="marina-add-email" type="email" maxlength="255" placeholder="berths@example.com" />
        </label>
        <label for="marina-add-phone">
          Contact phone
          <input id="marina-add-phone" type="tel" maxlength="30" placeholder="+39 089 000 111" />
        </label>
        <label for="marina-add-window">
          Reply to requests within (hours)
          <input id="marina-add-window" type="number" min="1" max="144" step="1" value="24" required />
        </label>
        <label class="checkbox-field" for="marina-add-auto"><input id="marina-add-auto" type="checkbox" /> Auto-confirm requests</label>
        <label for="marina-add-url">
          Booking page URL
          <input id="marina-add-url" type="url" placeholder={"https://example.com/berth-booking?b={id}&t={token}"} />
        </label>
        <p class="chart-card-subtitle">Where guests open their booking from emails. It must contain <code>{'{id}'}</code> and <code>{'{token}'}</code>.</p>
        <button id="marina-add-btn" type="submit">Add marina</button>
      </form>
    </div>
```

- [ ] **Step 8: Wire the section in `settings-client.ts`**

In `D/src/scripts/settings-client.ts`, after `:3` (`import { loadStripe, … } from '@stripe/stripe-js';`), insert:

```ts
import { confirmDialog } from './confirm-dialog';
import { marinaBody, type MarinaRow } from '../lib/marina-logic';
```

After `:255` (`loadWebsites();`), insert:

```ts

// ── Marinas ──────────────
// OTA's own marinas. This is separate from the Sidon id under Modules, which
// stays until cutover. The list asks for inactive marinas too, so one taken
// offline here can be brought back. Remove is a soft delete, as for websites.
// OTA lets any staff member edit marinas, so there is no 403 branch here.

const marinaList = document.getElementById('marina-list') as HTMLUListElement;
const marinaAddForm = document.getElementById('marina-add-form') as HTMLFormElement;
const marinaAddBtn = document.getElementById('marina-add-btn') as HTMLButtonElement;
const BOOKING_URL_HINT = 'Must contain {id} and {token}, e.g. https://example.com/berth-booking?b={id}&t={token}';

function renderMarinaRow(m: MarinaRow): HTMLLIElement {
  const li = document.createElement('li');
  const inactive = m.status === 'inactive';
  li.className = 'website-row marina-row';
  li.classList.toggle('is-inactive', inactive);
  li.dataset.id = m.id;
  const field = (cls: string, label: string, attrs: string, value: unknown) =>
    `<label class="marina-row-field">${label}<input class="${cls}" ${attrs} value="${escapeHtml(value)}" /></label>`;
  li.innerHTML = `
    ${field('marina-row-name', 'Name', 'type="text" maxlength="100"', m.name)}
    ${field('marina-row-slug', 'Slug', 'type="text" maxlength="100"', m.slug)}
    ${field('marina-row-lat', 'Latitude', 'type="number" step="any"', m.lat)}
    ${field('marina-row-lng', 'Longitude', 'type="number" step="any"', m.lng)}
    ${field('marina-row-email', 'Email', 'type="email" maxlength="255"', m.email)}
    ${field('marina-row-phone', 'Phone', 'type="tel" maxlength="30"', m.phone)}
    ${field('marina-row-window', 'Reply within (hours)', 'type="number" min="1" max="144" step="1"', m.response_window_hours)}
    <label class="marina-row-field marina-row-field--check"><input class="marina-row-auto" type="checkbox"${m.auto_confirm ? ' checked' : ''} /> Auto-confirm</label>
    ${field('marina-row-url', 'Booking page URL', `type="url" title="${escapeHtml(BOOKING_URL_HINT)}"`, m.booking_url)}
    <button class="marina-row-save" type="button">Save</button>
    ${inactive
      ? '<button class="reactivate-btn" type="button">Reactivate</button>'
      : '<button class="marina-row-remove icon-btn" type="button" title="Remove">×</button>'}
  `;

  const value = (cls: string) => (li.querySelector(`.${cls}`) as HTMLInputElement).value;

  async function send(btn: HTMLButtonElement, body: Record<string, unknown>, done: string) {
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/marina/marinas/${m.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const updated = await res.json().catch(() => null);
      if (!res.ok || !updated) {
        showToast(`${m.name}: ${updated?.error ?? 'unknown error'}`, 'error');
        return;
      }
      // Re-render from the stored row. A status change swaps Remove and
      // Reactivate, and the inputs show what OTA actually kept.
      li.replaceWith(renderMarinaRow(updated));
      showToast(`${updated.name}: ${done}`, 'success');
    } catch {
      showToast(`${m.name}: Failed to save`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  const saveBtn = li.querySelector('.marina-row-save') as HTMLButtonElement;
  saveBtn.addEventListener('click', () =>
    send(saveBtn, marinaBody({
      name: value('marina-row-name'),
      slug: value('marina-row-slug'),
      lat: value('marina-row-lat'),
      lng: value('marina-row-lng'),
      email: value('marina-row-email'),
      phone: value('marina-row-phone'),
      response_window_hours: value('marina-row-window'),
      auto_confirm: (li.querySelector('.marina-row-auto') as HTMLInputElement).checked,
      booking_url: value('marina-row-url'),
    }), 'Marina saved'));

  const removeBtn = li.querySelector<HTMLButtonElement>('.marina-row-remove');
  removeBtn?.addEventListener('click', async () => {
    const ok = await confirmDialog(`Take ${m.name} offline? Its berth map and guest booking pages stop working until it is reactivated.`, {
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) await send(removeBtn, { status: 'inactive' }, 'Marina removed');
  });

  const reactivateBtn = li.querySelector<HTMLButtonElement>('.reactivate-btn');
  reactivateBtn?.addEventListener('click', () => send(reactivateBtn, { status: 'active' }, 'Marina reactivated'));

  return li;
}

async function loadMarinaRows() {
  try {
    const res = await apiFetch('/api/marina/marinas?include_inactive=1');
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data)) {
      showToast(`Failed to load marinas — ${data?.error ?? 'unknown error'}`, 'error');
      return;
    }
    marinaList.replaceChildren(...(data as MarinaRow[]).map((m) => renderMarinaRow(m)));
  } catch {
    showToast('Failed to load marinas', 'error');
  } finally {
    marinaList.removeAttribute('aria-busy');
  }
}

marinaAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  const body = marinaBody({
    name: value('marina-add-name'),
    slug: value('marina-add-slug'),
    lat: value('marina-add-lat'),
    lng: value('marina-add-lng'),
    email: value('marina-add-email'),
    phone: value('marina-add-phone'),
    response_window_hours: value('marina-add-window'),
    auto_confirm: (document.getElementById('marina-add-auto') as HTMLInputElement).checked,
    booking_url: value('marina-add-url'),
  });
  marinaAddBtn.disabled = true;
  try {
    const res = await apiFetch('/api/marina/marinas', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const created = await res.json().catch(() => null);
    if (!res.ok || !created) {
      showToast(`${body.name}: ${created?.error ?? 'unknown error'}`, 'error');
      return;
    }
    marinaList.appendChild(renderMarinaRow(created));
    marinaAddForm.reset();
    showToast(`${created.name}: Marina added`, 'success');
  } catch {
    showToast(`${body.name}: Failed to add marina`, 'error');
  } finally {
    marinaAddBtn.disabled = false;
  }
});

loadMarinaRows();
```

Then fix the Sidon form's nav toggle, so clearing the Sidon id doesn't hide Marina while the property has active OTA marinas (R20). Add `loadMarinas` to the imports at the top (`import { loadMarinas } from './sidebar-modules-widget';`, Task 5), and in the `#marina-form` submit handler replace

```ts
    for (const el of document.querySelectorAll<HTMLElement>('[data-marina]')) el.hidden = !updated.sidon_marina_id;
```

with

```ts
    // The nav rule is Sidon id OR at least one active OTA marina (Task 5).
    const showMarina = !!updated.sidon_marina_id || (await loadMarinas()).length > 0;
    for (const el of document.querySelectorAll<HTMLElement>('[data-marina]')) el.hidden = !showMarina;
```

- [ ] **Step 9: Styles for the labelled row fields and greyed inactive rows**

In `D/src/styles/global.css`, after the `.website-add-form { max-width: 420px; }` block (`:1368-1370`), insert:

```css

/* Settings → Marina rows reuse .website-row's card. Each input carries a
   small label, because nine fields can't be told apart from placeholders
   once they are filled in. */
.marina-row-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1 1 140px;
  min-width: 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.marina-row-field--check {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
}

/* A soft-deleted row (status 'inactive'), still listed so it can be
   reactivated. Its fields fade but its buttons don't, so Reactivate stays
   obvious. Shared by Settings → Marina and the /marina-setup grids. It sets
   no display value, so it needs no [hidden] guard. */
.is-inactive {
  color: var(--muted);
}

.is-inactive :is(input, select, textarea) {
  opacity: 0.5;
}
```

- [ ] **Step 10: Add the publishable key form beside the secret key**

In `D/src/layouts/Layout.astro`, directly after the `</form>` that closes `<form id="stripe-key-form" …>` (`:233`), insert:

```astro
                  <form id="stripe-publishable-key-form" class="settings-form stripe-key-form">
                    <label for="stripe-publishable-key-input">
                      Stripe Publishable Key
                      <input id="stripe-publishable-key-input" type="text" placeholder="pk_..." autocomplete="off" spellcheck="false" />
                    </label>
                    <p id="stripe-publishable-key-status" class="chart-card-subtitle"></p>
                    <div class="stripe-key-actions">
                      <button id="stripe-publishable-key-save" type="submit">Save</button>
                      <button id="stripe-publishable-key-clear" type="button" class="btn-link" hidden>Clear</button>
                    </div>
                  </form>
```

Append to `D/src/scripts/stripe-key-widget.ts` (after `:71`):

```ts

// The publishable key is public (it ships to guests' browsers with the
// marina booking widget), so unlike the secret key its value is shown back.
// Both routes are admin-only, and OTA refuses a key whose mode clashes with
// the stored secret key. Its 403/400 text names the fix, so it is toasted as-is.
export function mountStripePublishableKeyWidget(form: HTMLFormElement) {
  const input = form.querySelector('#stripe-publishable-key-input') as HTMLInputElement;
  const statusEl = form.querySelector('#stripe-publishable-key-status') as HTMLParagraphElement;
  const saveBtn = form.querySelector('#stripe-publishable-key-save') as HTMLButtonElement;
  const clearBtn = form.querySelector('#stripe-publishable-key-clear') as HTMLButtonElement;

  function renderStatus(key: string | null) {
    statusEl.textContent = key
      ? `Publishable key: ${key}`
      : 'No Stripe publishable key -- marina guests cannot pay by card online.';
    clearBtn.hidden = !key;
  }

  async function loadStatus() {
    const res = await apiFetch('/api/property/stripe/status');
    const data = await res.json().catch(() => null);
    renderStatus(data?.stripePublishableKey ?? null);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const stripe_publishable_key = input.value.trim();
    if (!stripe_publishable_key) return;
    saveBtn.disabled = true;
    try {
      const res = await apiFetch('/api/property/stripe/publishable-key', {
        method: 'PUT',
        body: JSON.stringify({ stripe_publishable_key }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(`Failed to save publishable key — ${body?.error ?? 'unknown error'}`, 'error');
        return;
      }
      input.value = '';
      showToast('Stripe publishable key saved', 'success');
      renderStatus(body?.stripePublishableKey ?? null);
    } catch {
      showToast('Failed to save publishable key', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear the Stripe publishable key?')) return;
    clearBtn.disabled = true;
    try {
      const res = await apiFetch('/api/property/stripe/publishable-key/clear', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(`Failed to clear publishable key — ${body?.error ?? 'unknown error'}`, 'error');
        return;
      }
      showToast('Stripe publishable key cleared', 'success');
      renderStatus(null);
    } catch {
      showToast('Failed to clear publishable key', 'error');
    } finally {
      clearBtn.disabled = false;
    }
  });

  loadStatus();
}
```

In `D/src/scripts/org-settings-page-widget.ts`, replace `:4`

```ts
import { mountStripeKeyWidget } from './stripe-key-widget';
```

with

```ts
import { mountStripeKeyWidget, mountStripePublishableKeyWidget } from './stripe-key-widget';
```

and after `:36` (the closing `}` of the `stripeForm` block), inside `tryMount()`, insert:

```ts

  const publishableForm = document.getElementById('stripe-publishable-key-form');
  if (publishableForm instanceof HTMLFormElement && !wired.has(publishableForm)) {
    wired.add(publishableForm);
    mountStripePublishableKeyWidget(publishableForm);
  }
```

- [ ] **Step 11: Run the gates**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`
Expected: `check-marina: ok`

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npm run build`
Expected: exits 0 and ends with `[build] Complete!`.

Run (OTA with Task 1 and `astro dev` still running): `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-settings.spec.ts`
Expected: `7 passed` (setup plus 6). The publishable-key test ends in its 403 branch for the staff test account. If the Clerk popover markup ever differs, `npx playwright test tests/marina-settings.spec.ts --debug` shows the real "Manage" button to target.

Check by hand that Settings → Modules still shows the Sidon marina form (`#marina-form`) unchanged (R30).

- [ ] **Step 12: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/pages/settings.astro src/scripts/settings-client.ts src/styles/global.css src/layouts/Layout.astro src/scripts/stripe-key-widget.ts src/scripts/org-settings-page-widget.ts tests/marina-helpers.ts tests/marina-settings.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: Settings marina section and Stripe publishable key" -m "Settings gets a Marina tab that lists OTA marinas, inactive ones included, so they can be reactivated. It adds, edits and soft-deletes them through marinaBody, which trims fields, turns blanks into null and sends the reply window as a number. OTA's validation text is toasted per marina. The Stripe publishable key form sits beside the secret key in the org-profile modal. Playwright creates and cleans up its own marina, and branches on 403 for the admin-only key. The Sidon fields are untouched until plan D." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Nothing is pushed or deployed. The runbook deploys D after the user approves.

---

### Task 7: Dashboard — /marina-setup page and Berths tab with CSV import

Repo `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`. Contract R24 (Berths tab, page skeleton), R25, R14, N3; Review Focus 2.

**Files:**
- Modify: `D/src/lib/marina-logic.ts`. Append after Task 6's `marinaBody` (end of file). Adds `MARINA_STORAGE_KEY`, `pickMarina`, `CSV_COLUMNS`, `CSV_MAX_ROWS`, `parseCsv`, `csvToBerthRows`, plus the module-private `headerDelimiter`, `CSV_NUMERIC` and `CSV_OMIT_BLANK`.
- Modify: `D/scripts/check-marina.ts`. Add one import line after the existing `from '../src/lib/marina-logic.ts'` import(s). Insert the new blocks just above the last line, `console.log('check-marina: ok');`.
- Create: `D/src/pages/marina-setup.astro`
- Create: `D/src/scripts/marina-setup-client.ts`
- Modify: `D/tests/marina-helpers.ts`. Append `importBerthsCsvViaUi` at the end of the file. Task 6's import of `type Page` from `@playwright/test` already covers it.
- Create: `D/tests/marina-setup.spec.ts`

**Interfaces:**
- Consumes:
  - From Task 1 (OTA):
    - `GET /api/marina/marinas/:marina_id/{berths|pontoons}?include_inactive=1`.
    - `nonNeg` error text, with the bulk row prefix: `row N: length_m must be a number, 0 or more`.
    - `POST …/berths/bulk` → `{ upserted, data }`. A 400 returns `{ error: 'row N: <col> <msg>' }`.
    - `POST …/berths` → 201 with the row. A duplicate label gets `409 {error:'That label is already used at this marina'}`.
    - `PUT …/berths/:id` → the row.
  - From Task 5:
    - `MarinaRow` from `D/src/lib/marina-logic.ts`.
    - `loadMarinas()` from `D/src/scripts/sidebar-modules-widget.ts`.
    - The `D/scripts/check-marina.ts` scaffold.
  - From Task 6:
    - `uniqueSlug`, `createMarinaViaUi`, `deactivateMarinaViaUi` in `D/tests/marina-helpers.ts`.
    - The `.is-inactive` greyed-row CSS in `global.css`.
- Produces:
  - `D/src/lib/marina-logic.ts`, exactly as the contract states:
    - `export const MARINA_STORAGE_KEY = 'hotal-marina-id'`
    - `pickMarina<T extends { id: string }>(marinas: T[], wanted: string | null | undefined): T | null`
    - `CSV_COLUMNS` (`as const`)
    - `CSV_MAX_ROWS = 2000`
    - `parseCsv(text: string): string[][]`
    - `csvToBerthRows(text, pontoons): { rows: Record<string, string | null>[]; errors: string[] }`. When `errors` is non-empty, `rows` is `[]`, so there is nothing to send.
  - One edge case is decided here, where the contract says nothing: a blank header cell is ignored. Excel exports stray formatted columns this way. It does not count as an unknown column.
  - `/marina-setup` DOM:
    - `#marina-setup-select`.
    - `#marina-setup-empty`: a link to `/settings#marina`, shown when there are no active marinas.
    - Tab buttons `button.settings-tab[data-setup-target]` and panels `section.marina-setup-panel[data-setup-tab]` for `berths | pontoons | price-tiers | doc-requirements | contract-templates | pois | images`. The tabs are hash-linked.
    - `#berths-body tr[data-id]`. Each row has the inputs `.berth-label`, `.berth-pontoon`, `.berth-length`, `.berth-min-length`, `.berth-beam`, `.berth-depth`, `.berth-price`, `.berth-price-mode` and `.berth-status`, plus a `.deactivate-btn` or `.reactivate-btn`. Inactive rows get `.is-inactive`, their inputs are disabled, and the status cell shows the text `inactive`.
    - `#berth-add-btn`, `#berths-csv-btn`, `#berths-csv-input` (hidden file input), `#berths-csv-errors` (`ul` of `li`), `#berths-empty`.
  - Extension points in `D/src/scripts/marina-setup-client.ts` for Tasks 8–9, which append to the same file:
    - `let marina: MarinaRow | null`, the selected marina.
    - `const tabLoaders: Partial<Record<SetupTab, (m: MarinaRow) => Promise<void>>>`. A tab registers `tabLoaders['<tab>'] = load…;`. The loader for the shown tab runs on tab activation and on every marina change.
    - `showCsvErrors(errors: string[])` stays private to the Berths section.
  - `D/tests/marina-helpers.ts`: `export async function importBerthsCsvViaUi(page: Page, marinaId: string, csv: string): Promise<void>`.

- [ ] **Step 1: Write the failing check**

In `D/scripts/check-marina.ts`, add this line directly after the existing `import … from '../src/lib/marina-logic.ts';` line(s):

```ts
import { MARINA_STORAGE_KEY, pickMarina, CSV_COLUMNS, CSV_MAX_ROWS, parseCsv, csvToBerthRows } from '../src/lib/marina-logic.ts';
```

Insert these blocks immediately above the final `console.log('check-marina: ok');`:

```ts
// ---- MARINA_STORAGE_KEY / pickMarina ----
assert.equal(MARINA_STORAGE_KEY, 'hotal-marina-id');
{
  const marinas = [{ id: 'a' }, { id: 'b' }];
  assert.equal(pickMarina(marinas, 'b'), marinas[1]);
  // A remembered marina that was deactivated (or belongs to another org) falls back to the first.
  assert.equal(pickMarina(marinas, 'gone'), marinas[0]);
  assert.equal(pickMarina(marinas, null), marinas[0]);
  assert.equal(pickMarina(marinas, undefined), marinas[0]);
  assert.equal(pickMarina([], 'a'), null);
}

// ---- CSV_COLUMNS / CSV_MAX_ROWS ----
assert.deepEqual(
  [...CSV_COLUMNS],
  ['label', 'pontoon', 'length_m', 'min_length_m', 'beam_m', 'depth_m', 'price_per_night', 'price_mode', 'lat', 'lng', 'rotation', 'status'],
);
assert.equal(CSV_MAX_ROWS, 2000);

// ---- parseCsv ----
// Excel "CSV UTF-8": BOM, CRLF, and a quoted cell holding a comma, a CRLF and "" escapes.
assert.deepEqual(
  parseCsv('\uFEFFlabel,length_m\r\n"A ""1"", east\r\nend",12\r\n'),
  [['label', 'length_m'], ['A "1", east\r\nend', '12']],
);
// LF and bare-CR line ends; no final newline.
assert.deepEqual(parseCsv('a,b\nc,d\re,f'), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
// Italian-locale Excel: ';' separators, so a decimal comma stays inside its cell.
assert.deepEqual(parseCsv('label;length_m\r\nA1;12,5\r\n'), [['label', 'length_m'], ['A1', '12,5']]);
// The header decides the delimiter, ignoring anything inside quotes.
assert.deepEqual(parseCsv('"a;b",c\n1,2'), [['a;b', 'c'], ['1', '2']]);
// Trailing blank rows (empty lines and ',,' padding) are dropped; a blank middle row stays.
assert.deepEqual(parseCsv('label\nA1\n\nA3\n,,\n\n'), [['label'], ['A1'], [''], ['A3']]);
assert.deepEqual(parseCsv(''), []);
assert.deepEqual(parseCsv('\uFEFF'), []);

// ---- csvToBerthRows ----
{
  const pontoons = [{ id: 'p-a', name: 'Pontone A' }, { id: 'p-b', name: 'Pier B ' }];

  // Italian Excel export end to end: BOM, ';', CRLF, decimal commas, mixed-case
  // header, a padded pontoon name matched case-insensitively, blank status /
  // price_mode omitted (N3), other blanks null, trailing ';;;;;' rows dropped.
  {
    const { rows, errors } = csvToBerthRows(
      '\uFEFFLabel;Pontoon;Length_m;Price_per_night;Price_mode;Status\r\n' +
        'A1; pontone a ;12,5;45,00;;\r\n' +
        'A2;;-3,5;;fixed;maintenance\r\n' +
        ';;;;;\r\n;;;;;\r\n',
      pontoons,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, [
      { label: 'A1', pontoon_id: 'p-a', length_m: '12.5', price_per_night: '45.00' },
      { label: 'A2', pontoon_id: null, length_m: '-3.5', price_per_night: null, price_mode: 'fixed', status: 'maintenance' },
    ]);
  }

  // Comma file: the quoted label keeps its comma and quotes, the quoted "12,5"
  // becomes 12.5, and the blank middle row is still row 2, so a pontoon typo
  // in the next row is reported as row 3 (OTA counts the same way).
  {
    const { rows, errors } = csvToBerthRows('label,pontoon,length_m\n"B ""1"", east",PIER B,"12,5"\n\nB3,Pontone Z,9\n', pontoons);
    assert.deepEqual(errors, ['row 3: pontoon "Pontone Z" not found']);
    assert.deepEqual(rows, []);
  }
  {
    const { rows, errors } = csvToBerthRows('label,pontoon,length_m\n"B ""1"", east",PIER B,"12,5"\n\nB3,Pontone A,9\n', pontoons);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, [
      { label: 'B "1", east', pontoon_id: 'p-b', length_m: '12.5' },
      { label: null, pontoon_id: null, length_m: null },
      { label: 'B3', pontoon_id: 'p-a', length_m: '9' },
    ]);
  }

  // The decimal comma is converted only in numeric columns.
  assert.deepEqual(csvToBerthRows('label;lat\n"1,5";43,6\n', []), { rows: [{ label: '1,5', lat: '43.6' }], errors: [] });

  // A blank header cell (a stray Excel column) is ignored rather than reported as unknown.
  assert.deepEqual(csvToBerthRows('label,\nA1,x\n', []), { rows: [{ label: 'A1' }], errors: [] });

  // Header-level errors: nothing is parsed further.
  assert.deepEqual(csvToBerthRows('name,length_m\nA1,10\n', []), { rows: [], errors: ['unknown column "name"', 'missing column "label"'] });
  assert.deepEqual(csvToBerthRows('label,length_m\r\n', []), { rows: [], errors: ['no rows'] });
  assert.deepEqual(csvToBerthRows('', []), { rows: [], errors: ['missing column "label"', 'no rows'] });

  // The 2000-row cap matches OTA's bulk route.
  const many = (n: number) => 'label\n' + Array.from({ length: n }, (_, i) => `B${i + 1}`).join('\n');
  assert.deepEqual(csvToBerthRows(many(2001), []), { rows: [], errors: ['at most 2000 rows'] });
  const atCap = csvToBerthRows(many(2000), []);
  assert.deepEqual(atCap.errors, []);
  assert.equal(atCap.rows.length, 2000);
  assert.deepEqual(atCap.rows[1999], { label: 'B2000' });
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: the run exits 1 before any assert runs, with
`SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'MARINA_STORAGE_KEY'`. Node names the first of the six missing exports.

- [ ] **Step 3: Implement the pure logic**

Append to the end of `D/src/lib/marina-logic.ts`:

```ts
// ---- Task 7: /marina-setup ----

// The marina the setup page last showed, remembered per browser.
export const MARINA_STORAGE_KEY = 'hotal-marina-id';

// A remembered id can point at a marina that has since been deactivated, or
// that belongs to another org, so fall back to the first one.
export function pickMarina<T extends { id: string }>(marinas: T[], wanted: string | null | undefined): T | null {
  return marinas.find((m) => m.id === wanted) ?? marinas[0] ?? null;
}

// OTA's bulk-berth field names, except that `pontoon` is a name, resolved to
// pontoon_id here.
export const CSV_COLUMNS = ['label', 'pontoon', 'length_m', 'min_length_m', 'beam_m', 'depth_m', 'price_per_night', 'price_mode', 'lat', 'lng', 'rotation', 'status'] as const;
export const CSV_MAX_ROWS = 2000;

// Italian (and most European) Excel saves ';'-separated CSV because ',' is
// their decimal mark. The header row decides, ignoring anything inside quotes.
function headerDelimiter(text: string): ',' | ';' {
  let quoted = false;
  let comma = false;
  let semicolon = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '\r' || c === '\n') break;
    else if (c === ',') comma = true;
    else if (c === ';') semicolon = true;
  }
  return semicolon && !comma ? ';' : ',';
}

// Small RFC-4180-style parser: quoted cells may hold the delimiter, CR/LF and
// "" escapes; CRLF, LF and bare-CR line ends are all accepted.
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Excel's UTF-8 BOM
  const delimiter = headerDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Spreadsheets pad the end with empty lines or ',,,' rows. A blank row in
  // the middle stays, so row numbers keep matching the file and OTA's errors.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

const CSV_NUMERIC = new Set(['length_m', 'min_length_m', 'beam_m', 'depth_m', 'price_per_night', 'lat', 'lng', 'rotation']);
// OTA rejects null for these two (N3). A blank cell leaves the column out, so
// an insert takes the DB default and an upsert keeps the stored value.
const CSV_OMIT_BLANK = new Set(['status', 'price_mode']);

// Rows exactly as POST …/berths/bulk takes them. Row N is the Nth data row,
// counted the way OTA's "row N:" errors count, so either error list points at
// the same line of the spreadsheet. Any error means nothing is sent.
export function csvToBerthRows(
  text: string,
  pontoons: { id: string; name: string }[],
): { rows: Record<string, string | null>[]; errors: string[] } {
  const [head = [], ...data] = parseCsv(text);
  const header = head.map((h) => h.trim().toLowerCase());
  const errors: string[] = [];
  for (const h of header) {
    // A blank header cell is a stray formatted column Excel exported, not a typo.
    if (h && !(CSV_COLUMNS as readonly string[]).includes(h)) errors.push(`unknown column "${h}"`);
  }
  if (!header.includes('label')) errors.push('missing column "label"');
  if (!data.length) errors.push('no rows');
  if (data.length > CSV_MAX_ROWS) errors.push(`at most ${CSV_MAX_ROWS} rows`);
  if (errors.length) return { rows: [], errors };

  const pontoonIds = new Map(pontoons.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const rows = data.map((cells, i) => {
    const row: Record<string, string | null> = {};
    header.forEach((col, j) => {
      if (!col) return;
      const value = (cells[j] ?? '').trim();
      if (col === 'pontoon') {
        const id = value ? pontoonIds.get(value.toLowerCase()) : null;
        if (id === undefined) errors.push(`row ${i + 1}: pontoon "${value}" not found`);
        else row.pontoon_id = id;
      } else if (value) {
        row[col] = CSV_NUMERIC.has(col) && /^-?\d+,\d+$/.test(value) ? value.replace(',', '.') : value;
      } else if (!CSV_OMIT_BLANK.has(col)) {
        row[col] = null;
      }
    });
    return row;
  });
  return errors.length ? { rows: [], errors } : { rows, errors };
}
```

- [ ] **Step 4: Run the check again**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: `check-marina: ok`, exit 0.

- [ ] **Step 5: Add the Playwright helper and spec**

Append to `D/tests/marina-helpers.ts`:

```ts
// Drives the Berths tab's file input the way a user picking a CSV would, then
// waits for OTA's answer. The answer may be a success or a row error; the
// caller asserts which. Only for CSVs that pass the client-side checks,
// because a client error never sends the POST.
export async function importBerthsCsvViaUi(page: Page, marinaId: string, csv: string): Promise<void> {
  const loaded = page.waitForResponse(
    (res) => res.request().method() === 'GET' && res.url().includes(`/api/marina/marinas/${marinaId}/berths?include_inactive=1`)
  );
  await page.goto('/marina-setup#berths');
  await page.locator('#marina-setup-select').selectOption(marinaId);
  await loaded;
  await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/marina/marinas/${marinaId}/berths/bulk`)
    ),
    page.locator('#berths-csv-input').setInputFiles({ name: 'berths.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }),
  ]);
}
```

Create `D/tests/marina-setup.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { createMarinaViaUi, deactivateMarinaViaUi, importBerthsCsvViaUi, uniqueSlug } from './marina-helpers';

// One serial chain on a marina created for this run. OTA has no delete for
// marinas, so afterAll deactivates it, which hides it and its berths
// from the app.
test.describe.serial('marina setup: berths', () => {
  const slug = uniqueSlug('pw-setup');
  let marinaId = '';
  let berthId = '';

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  // Each test starts with empty localStorage, so the page first shows
  // whichever marina comes first; selecting ours triggers the load we wait for.
  async function openBerths(page: Page) {
    const loaded = page.waitForResponse(
      (res) => res.request().method() === 'GET' && res.url().includes(`/api/marina/marinas/${marinaId}/berths?include_inactive=1`)
    );
    await page.goto('/marina-setup#berths');
    await page.locator('#marina-setup-select').selectOption(marinaId);
    await loaded;
  }

  const berthPut = (page: Page) =>
    page.waitForResponse(
      (res) => res.request().method() === 'PUT' && res.url().includes(`/api/marina/marinas/${marinaId}/berths/`)
    );

  // Rows are rebuilt from the fetch, so a label sits in the markup's value
  // attribute. Typing doesn't update that attribute, so match on it only after a reload.
  const berthRow = (page: Page, label: string) =>
    page.locator('#berths-body tr', { has: page.locator(`input.berth-label[value="${label}"]`) });

  test('create a marina for this run', async ({ page }) => {
    marinaId = await createMarinaViaUi(page, { name: `PW Setup ${slug}`, slug });
    expect(marinaId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('add a berth and autosave its length', async ({ page }) => {
    await openBerths(page);
    await expect(page.locator('#berths-body tr')).toHaveCount(0);

    const [created] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/marina/marinas/${marinaId}/berths`)
      ),
      page.locator('#berth-add-btn').click(),
    ]);
    expect(created.status()).toBe(201);
    berthId = (await created.json()).id;
    const row = page.locator(`#berths-body tr[data-id="${berthId}"]`);
    await expect(row.locator('.berth-label')).toHaveValue('New berth');

    const label = row.locator('.berth-label');
    await label.fill('PW-A1');
    const [labelRes] = await Promise.all([berthPut(page), label.blur()]);
    expect(labelRes.ok()).toBe(true);
    await expect(page.locator('.toast--success').last()).toContainText('PW-A1: Label saved');

    const length = row.locator('.berth-length');
    await length.fill('12.5');
    const [lengthRes] = await Promise.all([berthPut(page), length.blur()]);
    expect(lengthRes.ok()).toBe(true);
    await expect(page.locator('.toast--success').last()).toContainText('PW-A1: Length saved');

    // Reload to confirm OTA stored it, not just the DOM. NUMERIC(6,2) comes back as "12.50".
    await openBerths(page);
    await expect(page.locator(`#berths-body tr[data-id="${berthId}"] .berth-length`)).toHaveValue('12.50');
  });

  test('a CSV with a quoted field and pontoon-less rows upserts', async ({ page }) => {
    await importBerthsCsvViaUi(
      page,
      marinaId,
      'label,pontoon,length_m,price_per_night,price_mode,status\r\n' +
        '"PW-B1, east",,10,"45,50",fixed,\r\n' +
        'PW-B2,,8,,,maintenance\r\n'
    );
    await expect(page.locator('.toast--success').last()).toContainText('2 berths imported');
    await expect(page.locator('#berths-csv-errors')).toBeHidden();

    const b1 = berthRow(page, 'PW-B1, east');
    await expect(b1).toHaveCount(1);
    await expect(b1.locator('.berth-pontoon')).toHaveValue('');
    await expect(b1.locator('.berth-price')).toHaveValue('45.50');
    await expect(b1.locator('.berth-price-mode')).toHaveValue('fixed');
    await expect(b1.locator('.berth-status')).toHaveValue('active'); // blank status → DB default
    const b2 = berthRow(page, 'PW-B2');
    await expect(b2.locator('.berth-price-mode')).toHaveValue('per_metre'); // blank price_mode → DB default
    await expect(b2.locator('.berth-status')).toHaveValue('maintenance');
    await expect(page.locator('#berths-body tr')).toHaveCount(3);
  });

  test("a bad row shows OTA's row error and imports nothing", async ({ page }) => {
    await importBerthsCsvViaUi(page, marinaId, 'label,length_m\r\nPW-C1,9\r\nPW-C2,-3\r\n');
    await expect(page.locator('#berths-csv-errors')).toBeVisible();
    await expect(page.locator('#berths-csv-errors')).toHaveText('row 2: length_m must be a number, 0 or more');

    // The import is all or nothing, so PW-C1 (a valid row) wasn't written either.
    await openBerths(page);
    await expect(page.locator('#berths-body tr')).toHaveCount(3);
    await expect(berthRow(page, 'PW-C1')).toHaveCount(0);
  });

  test('deactivate then reactivate a berth', async ({ page }) => {
    await openBerths(page);
    const row = berthRow(page, 'PW-A1');
    await expect(row).not.toHaveClass(/is-inactive/);

    const [off] = await Promise.all([berthPut(page), row.locator('.deactivate-btn').click()]);
    expect(off.ok()).toBe(true);
    await expect(page.locator('.toast--success').last()).toContainText('PW-A1: Deactivated');
    await expect(row).toHaveClass(/is-inactive/);
    await expect(row.locator('.berth-length')).toBeDisabled();

    // Still listed after a reload (?include_inactive=1), so it can come back.
    await openBerths(page);
    await expect(row).toHaveClass(/is-inactive/);
    const [on] = await Promise.all([berthPut(page), row.locator('.reactivate-btn').click()]);
    expect(on.ok()).toBe(true);
    await expect(page.locator('.toast--success').last()).toContainText('PW-A1: Reactivated');
    await expect(row).not.toHaveClass(/is-inactive/);
    await expect(row.locator('.berth-status')).toHaveValue('active');
  });
});
```

- [ ] **Step 6: Run the spec and watch it fail**

Start local OTA with Task 1 applied, in its own terminal: `cd C:/Users/robert/source/repos/OTA && npm run dev`. If port 3000 is taken, run `PORT=3100 npm run dev` and start D with `PUBLIC_OTA_API_BASE_URL=http://localhost:3100`. Then start the dashboard: `cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background`.

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-setup.spec.ts`

Expected:
- `setup` and `create a marina for this run` pass.
- `add a berth and autosave its length` fails with `Test timeout of 45000ms exceeded` while waiting for `locator('#marina-setup-select')`, because `/marina-setup` is Astro's 404 page.
- The remaining 3 serial tests do not run.
- `afterAll` still deactivates the marina.

- [ ] **Step 7: Create the page**

Create `D/src/pages/marina-setup.astro`:

```astro
---
export const prerender = false;
import { Show } from '@clerk/astro/components';
import Layout from '../layouts/Layout.astro';
---
<Layout title="Marina setup — Table Bookings">
  <Show when="signed-in">
    <div class="page-header">
      <div class="page-header-title">
        <a class="icon-btn" href="/marina" title="Back to Marina">
          <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </a>
        <h1>Marina setup</h1>
      </div>
      <div class="page-header-actions">
        <select id="marina-setup-select" aria-label="Marina"></select>
      </div>
    </div>

    <p id="marina-setup-empty" class="chart-card-subtitle" hidden>
      No marinas yet. Add one in <a href="/settings#marina">Settings → Marina</a>.
    </p>

    <div id="marina-setup-body">
      <!-- Same tab look as /settings; hash-linked (#berths, #pontoons, …). -->
      <nav class="settings-tabs" role="tablist" aria-label="Marina setup sections">
        <button type="button" class="settings-tab" role="tab" data-setup-target="berths">Berths</button>
        <button type="button" class="settings-tab" role="tab" data-setup-target="pontoons">Pontoons</button>
        <button type="button" class="settings-tab" role="tab" data-setup-target="price-tiers">Price tiers</button>
        <button type="button" class="settings-tab" role="tab" data-setup-target="doc-requirements">Documents</button>
        <button type="button" class="settings-tab" role="tab" data-setup-target="contract-templates">Contracts</button>
        <button type="button" class="settings-tab" role="tab" data-setup-target="pois">Points of interest</button>
        <button type="button" class="settings-tab" role="tab" data-setup-target="images">Images</button>
      </nav>

      <section class="marina-setup-panel" data-setup-tab="berths" hidden>
        <div class="marina-setup-toolbar">
          <p class="chart-card-subtitle">
            Changes save as you leave each field. To import, use a CSV with a header row. Columns can come in any order, and only
            <code>label</code> is required: label, pontoon (the pontoon's name), length_m, min_length_m, beam_m, depth_m,
            price_per_night, price_mode (per_metre or fixed), lat, lng, rotation, status (active or maintenance).
            Rows are matched by label, so importing again updates berths. A blank cell clears that value, except that a blank
            status or price_mode keeps what is stored.
          </p>
          <div class="page-header-actions">
            <button id="berths-csv-btn" type="button">Import CSV</button>
            <input id="berths-csv-input" type="file" accept=".csv,text/csv" hidden />
            <button id="berth-add-btn" type="button"><svg class="btn-icon" viewBox="0 0 640 640"><path d="M160 144C151.2 144 144 151.2 144 160L144 480C144 488.8 151.2 496 160 496L480 496C488.8 496 496 488.8 496 480L496 160C496 151.2 488.8 144 480 144L160 144zM96 160C96 124.7 124.7 96 160 96L480 96C515.3 96 544 124.7 544 160L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 160zM296 408L296 344L232 344C218.7 344 208 333.3 208 320C208 306.7 218.7 296 232 296L296 296L296 232C296 218.7 306.7 208 320 208C333.3 208 344 218.7 344 232L344 296L408 296C421.3 296 432 306.7 432 320C432 333.3 421.3 344 408 344L344 344L344 408C344 421.3 333.3 432 320 432C306.7 432 296 421.3 296 408z"/></svg>Add</button>
          </div>
        </div>

        <ul id="berths-csv-errors" class="marina-csv-errors" role="alert" hidden></ul>

        <table id="berths-table" class="berths-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Pontoon</th>
              <th class="col-narrow">Length (m)</th>
              <th class="col-narrow">Min length (m)</th>
              <th class="col-narrow">Beam (m)</th>
              <th class="col-narrow">Depth (m)</th>
              <th class="col-narrow">Price/night</th>
              <th class="col-narrow">Price mode</th>
              <th class="col-narrow">Status</th>
              <th class="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody id="berths-body"></tbody>
        </table>
        <p id="berths-empty" class="chart-card-subtitle" hidden>No berths yet. Add one or import a CSV.</p>
      </section>

      <section class="marina-setup-panel" data-setup-tab="pontoons" hidden><h2>Pontoons</h2></section>
      <section class="marina-setup-panel" data-setup-tab="price-tiers" hidden><h2>Price tiers</h2></section>
      <section class="marina-setup-panel" data-setup-tab="doc-requirements" hidden><h2>Document requirements</h2></section>
      <section class="marina-setup-panel" data-setup-tab="contract-templates" hidden><h2>Contract templates</h2></section>
      <section class="marina-setup-panel" data-setup-tab="pois" hidden><h2>Points of interest</h2></section>
      <section class="marina-setup-panel" data-setup-tab="images" hidden><h2>Images</h2></section>
    </div>

    <script src="../scripts/marina-setup-client.ts"></script>
  </Show>
</Layout>

<style>
  .marina-setup-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .marina-setup-toolbar .chart-card-subtitle {
    margin: 0;
    max-width: 70ch;
  }

  .marina-csv-errors {
    margin: 0 0 1rem;
    padding-left: 1.25rem;
    color: #ef4444; /* same red the live-feed error states use */
  }

  /* Rows are built in marina-setup-client.ts, outside this component's scope.
     Without a floor, ten columns of inputs collapse their numbers out of view. */
  .berths-table :global(.berth-label) {
    min-width: 10ch;
  }

  .berths-table :global(input[type='number']) {
    min-width: 8ch;
  }
</style>
```

- [ ] **Step 8: Create the client script**

Create `D/src/scripts/marina-setup-client.ts`:

```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { loadMarinas } from './sidebar-modules-widget';
import { MARINA_STORAGE_KEY, pickMarina, csvToBerthRows, type MarinaRow } from '../lib/marina-logic';

// ── Tabs and marina selector ──────────────
// Hash-linked like /settings, so /marina's header and the tests can deep-link
// a tab. Each tab registers a loader in tabLoaders. The loader for the
// visible tab runs whenever the tab is shown or the marina changes, so lists
// are never a stale snapshot from page load.

type SetupTab = 'berths' | 'pontoons' | 'price-tiers' | 'doc-requirements' | 'contract-templates' | 'pois' | 'images';

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-setup-target]')];
const tabPanels = [...document.querySelectorAll<HTMLElement>('[data-setup-tab]')];
const tabNames = tabPanels.map((panel) => panel.dataset.setupTab as SetupTab);
const tabLoaders: Partial<Record<SetupTab, (m: MarinaRow) => Promise<void>>> = {};
let activeTab: SetupTab = tabNames[0];
let marina: MarinaRow | null = null;

async function loadActiveTab() {
  if (marina) await tabLoaders[activeTab]?.(marina);
}

function activateTab(name: string, updateHash = true) {
  activeTab = (tabNames as string[]).includes(name) ? (name as SetupTab) : tabNames[0];
  for (const panel of tabPanels) panel.hidden = panel.dataset.setupTab !== activeTab;
  for (const button of tabButtons) button.setAttribute('aria-selected', String(button.dataset.setupTarget === activeTab));
  if (updateHash) window.history.replaceState(null, '', `${window.location.pathname}#${activeTab}`);
  void loadActiveTab();
}

// ── Berths ──────────────
// A full-width inline-input table (the /equipment layout, because a berth has
// about ten editable columns) that autosaves per field like the restaurant
// Tables sheet: one PUT per changed input, with that input disabled while it
// is in flight. lat/lng/rotation are left out of the grid; set them by CSV
// or by the pontoon layout.

type Pontoon = { id: string; name: string };
type Berth = {
  id: string;
  marina_id: string;
  pontoon_id: string | null;
  label: string;
  length_m: string | null;
  min_length_m: string | null;
  beam_m: string | null;
  depth_m: string | null;
  price_per_night: string | null;
  price_mode: 'per_metre' | 'fixed';
  status: 'active' | 'maintenance' | 'inactive';
};

const BERTH_FIELD_LABELS: Record<string, string> = {
  label: 'Label',
  pontoon_id: 'Pontoon',
  length_m: 'Length',
  min_length_m: 'Min length',
  beam_m: 'Beam',
  depth_m: 'Depth',
  price_per_night: 'Price per night',
  price_mode: 'Price mode',
  status: 'Status',
};

const NUMBER_FIELDS = [
  ['length_m', 'berth-length'],
  ['min_length_m', 'berth-min-length'],
  ['beam_m', 'berth-beam'],
  ['depth_m', 'berth-depth'],
  ['price_per_night', 'berth-price'],
] as const;

const berthsBody = document.getElementById('berths-body') as HTMLTableSectionElement;
const berthsEmpty = document.getElementById('berths-empty') as HTMLElement;
const berthAddBtn = document.getElementById('berth-add-btn') as HTMLButtonElement;
const csvBtn = document.getElementById('berths-csv-btn') as HTMLButtonElement;
const csvInput = document.getElementById('berths-csv-input') as HTMLInputElement;
const csvErrors = document.getElementById('berths-csv-errors') as HTMLElement;

// The pontoon select's options, from the most recent berths load.
let pontoons: Pontoon[] = [];

// Inactive pontoons are included: a berth can still point at one, and its name must show.
async function fetchPontoons(marinaId: string): Promise<Pontoon[]> {
  const res = await apiFetch(`/api/marina/marinas/${marinaId}/pontoons?include_inactive=1`, { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  return res.ok && Array.isArray(data) ? data : [];
}

function showCsvErrors(errors: string[]) {
  // textContent: OTA's error text is never parsed as markup.
  csvErrors.replaceChildren(...errors.map((e) => Object.assign(document.createElement('li'), { textContent: e })));
  csvErrors.hidden = errors.length === 0;
}

async function saveBerthField(
  row: HTMLTableRowElement,
  marinaId: string,
  body: Record<string, unknown>,
  input: HTMLInputElement | HTMLSelectElement
) {
  const identifier = (row.querySelector('.berth-label') as HTMLInputElement).value || 'Berth';
  const field = Object.keys(body)[0];
  const fieldLabel = BERTH_FIELD_LABELS[field] ?? field;
  input.disabled = true;
  try {
    const res = await apiFetch(`/api/marina/marinas/${marinaId}/berths/${row.dataset.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const updated = await res.json().catch(() => null);
    if (!res.ok || !updated || typeof updated !== 'object') {
      showToast(`${identifier}: Failed to save ${fieldLabel} — ${updated?.error ?? 'unknown error'}`, 'error');
      return;
    }
    showToast(`${identifier}: ${fieldLabel} saved`, 'success');
    input.value = String(updated[field] ?? '');
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`${identifier}: Failed to save ${fieldLabel}`, 'error');
  } finally {
    input.disabled = false;
  }
}

// Inactive berths stay listed (?include_inactive=1) so they can be brought
// back. The row is rebuilt from OTA's answer so its inputs and button match
// the new status.
async function setBerthStatus(row: HTMLTableRowElement, b: Berth, status: 'active' | 'inactive', button: HTMLButtonElement) {
  const identifier = (row.querySelector('.berth-label') as HTMLInputElement).value || 'Berth';
  const verb = status === 'inactive' ? 'deactivate' : 'reactivate';
  button.disabled = true;
  try {
    const res = await apiFetch(`/api/marina/marinas/${b.marina_id}/berths/${b.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(15000),
    });
    const updated = await res.json().catch(() => null);
    if (!res.ok || !updated?.id) {
      showToast(`${identifier}: Failed to ${verb} — ${updated?.error ?? 'unknown error'}`, 'error');
      return;
    }
    row.replaceWith(berthRow(updated));
    showToast(`${identifier}: ${status === 'inactive' ? 'Deactivated' : 'Reactivated'}`, 'success');
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`${identifier}: Failed to ${verb}`, 'error');
  } finally {
    button.disabled = false;
  }
}

function berthRow(b: Berth): HTMLTableRowElement {
  const inactive = b.status === 'inactive';
  const tr = document.createElement('tr');
  tr.dataset.id = b.id;
  tr.classList.toggle('is-inactive', inactive);
  const selected = (on: boolean) => (on ? 'selected' : '');
  const pontoonOptions = [
    '<option value="">—</option>',
    ...pontoons.map(
      (p) => `<option value="${escapeHtml(p.id)}" ${selected(p.id === b.pontoon_id)}>${escapeHtml(p.name)}</option>`
    ),
  ].join('');
  tr.innerHTML = `
    <td><input type="text" class="berth-label" maxlength="30" value="${escapeHtml(b.label)}" aria-label="Label" /></td>
    <td><select class="berth-pontoon" data-field="pontoon_id" aria-label="Pontoon">${pontoonOptions}</select></td>
    ${NUMBER_FIELDS.map(
      ([field, cls]) =>
        `<td><input type="number" class="${cls}" data-field="${field}" min="0" step="0.01" value="${escapeHtml(b[field] ?? '')}" aria-label="${BERTH_FIELD_LABELS[field]}" /></td>`
    ).join('')}
    <td>
      <select class="berth-price-mode" data-field="price_mode" aria-label="Price mode">
        <option value="per_metre" ${selected(b.price_mode === 'per_metre')}>per metre</option>
        <option value="fixed" ${selected(b.price_mode === 'fixed')}>fixed</option>
      </select>
    </td>
    <td>${
      inactive
        ? 'inactive'
        : `<select class="berth-status" data-field="status" aria-label="Status">
            <option value="active" ${selected(b.status === 'active')}>active</option>
            <option value="maintenance" ${selected(b.status === 'maintenance')}>maintenance</option>
          </select>`
    }</td>
    <td class="col-actions">
      <div class="row-actions">${
        inactive
          ? '<button type="button" class="reactivate-btn">Reactivate</button>'
          : '<button type="button" class="deactivate-btn">Deactivate</button>'
      }</div>
    </td>
  `;

  // An inactive berth is read-only until it is reactivated.
  if (inactive) tr.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((el) => (el.disabled = true));

  const labelInput = tr.querySelector('.berth-label') as HTMLInputElement;
  labelInput.addEventListener('change', () => {
    if (!labelInput.value.trim()) return; // OTA requires a label, so a blank would 400
    saveBerthField(tr, b.marina_id, { label: labelInput.value.trim() }, labelInput);
  });
  // A blank number sends null, which clears the value (OTA's validators read null as "no value").
  for (const input of tr.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
    input.addEventListener('change', () =>
      saveBerthField(tr, b.marina_id, { [input.dataset.field!]: input.value === '' ? null : Number(input.value) }, input)
    );
  }
  for (const select of tr.querySelectorAll<HTMLSelectElement>('select')) {
    select.addEventListener('change', () => saveBerthField(tr, b.marina_id, { [select.dataset.field!]: select.value || null }, select));
  }
  const statusBtn = tr.querySelector('.deactivate-btn, .reactivate-btn') as HTMLButtonElement;
  statusBtn.addEventListener('click', () => setBerthStatus(tr, b, inactive ? 'active' : 'inactive', statusBtn));
  return tr;
}

async function loadBerths(m: MarinaRow) {
  const [res, ps] = await Promise.all([
    apiFetch(`/api/marina/marinas/${m.id}/berths?include_inactive=1`, { cache: 'no-store' }),
    fetchPontoons(m.id),
  ]);
  const data = await res.json().catch(() => null);
  if (marina?.id !== m.id) return; // the selector moved on while this was loading
  if (!res.ok || !Array.isArray(data)) {
    showToast(`Failed to load berths — ${data?.error ?? 'unknown error'}`, 'error');
    return;
  }
  pontoons = ps;
  showCsvErrors([]);
  berthsBody.innerHTML = '';
  for (const b of data) berthsBody.appendChild(berthRow(b));
  berthsEmpty.hidden = data.length > 0;
}
tabLoaders.berths = loadBerths;

berthAddBtn.addEventListener('click', async () => {
  const m = marina;
  if (!m) return;
  berthAddBtn.disabled = true;
  try {
    // Labels are unique per marina: a second "New berth" gets OTA's 409 as a toast until the first is renamed.
    const res = await apiFetch(`/api/marina/marinas/${m.id}/berths`, {
      method: 'POST',
      body: JSON.stringify({ label: 'New berth' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) {
      showToast(`Failed to create berth — ${data?.error ?? 'unknown error'}`, 'error');
      return;
    }
    showToast('Berth created', 'success');
    if (marina?.id !== m.id) return;
    const row = berthRow(data);
    berthsBody.appendChild(row);
    berthsEmpty.hidden = true;
    (row.querySelector('.berth-label') as HTMLInputElement).select();
  } finally {
    berthAddBtn.disabled = false;
  }
});

csvBtn.addEventListener('click', () => csvInput.click());

csvInput.addEventListener('change', async () => {
  const file = csvInput.files?.[0];
  csvInput.value = ''; // so picking the same file again after fixing it fires change
  const m = marina;
  if (!file || !m) return;
  showCsvErrors([]);
  csvBtn.disabled = true;
  try {
    // Pontoons are fetched now, not taken from the grid's load: the Pontoons tab may have added one since.
    const { rows, errors } = csvToBerthRows(await file.text(), await fetchPontoons(m.id));
    if (errors.length) return showCsvErrors(errors);
    const res = await apiFetch(`/api/marina/marinas/${m.id}/berths/bulk`, {
      method: 'POST',
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => null);
    // OTA's "row N: <col> <msg>" numbers rows the way csvToBerthRows does, so it is shown as-is.
    if (!res.ok) return showCsvErrors([data?.error ?? `Import failed (${res.status})`]);
    showToast(`${data.upserted} berths imported`, 'success');
    if (marina?.id === m.id) await loadBerths(m);
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showCsvErrors(['Import failed: the file could not be read or sent']);
  } finally {
    csvBtn.disabled = false;
  }
});

// ── Init ──────────────
// Active marinas only (the shared sidebar list). Inactive ones are managed
// in Settings → Marina. The choice is remembered per browser.

async function init() {
  // Listeners are attached before the await (same as the other list pages).
  tabButtons.forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.setupTarget!)));
  window.addEventListener('hashchange', () => activateTab(window.location.hash.slice(1), false));
  activateTab(window.location.hash.slice(1), false);

  const select = document.getElementById('marina-setup-select') as HTMLSelectElement;
  const marinas = await loadMarinas();
  if (!marinas.length) {
    select.hidden = true;
    (document.getElementById('marina-setup-body') as HTMLElement).hidden = true;
    (document.getElementById('marina-setup-empty') as HTMLElement).hidden = false;
    return;
  }
  select.innerHTML = marinas.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  marina = pickMarina(marinas, localStorage.getItem(MARINA_STORAGE_KEY));
  select.value = marina!.id;
  select.addEventListener('change', () => {
    if (select.value === marina?.id) return; // a scripted re-select of the current option still fires change
    marina = marinas.find((m) => m.id === select.value) ?? null;
    if (marina) localStorage.setItem(MARINA_STORAGE_KEY, marina.id);
    void loadActiveTab();
  });
  await loadActiveTab();
}

init();
```

- [ ] **Step 9: Build**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts && npm run build`

Expected: `check-marina: ok`, then Astro's build ends with `[build] Complete!` and exits 0.

- [ ] **Step 10: Run the spec again**

Use the same local stack as Step 6, with OTA and `astro dev` on 4335 still running.

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-setup.spec.ts`

Expected: `6 passed` (the `setup` project plus the 5 serial tests). `afterAll` deactivates the run's marina.

- [ ] **Step 11: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/pages/marina-setup.astro src/scripts/marina-setup-client.ts tests/marina-helpers.ts tests/marina-setup.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: setup page with berths grid and CSV import" -m "Adds /marina-setup: a marina selector remembered in localStorage, and hash-linked tabs (Berths filled; the six others are empty panels for the next tasks). The Berths tab is an inline-autosave grid with deactivate/reactivate over ?include_inactive=1. CSV import is parsed client-side (BOM, CRLF, quoted fields, ';' with decimal commas, trailing blank rows, pontoon by name) into exactly the rows POST /berths/bulk takes, with row numbers matching OTA's 'row N:' errors. Pinned by check-marina.ts and tests/marina-setup.spec.ts." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Nothing is pushed or deployed. The dashboard deploy happens later in the runbook.

---

### Task 8: Dashboard — /marina-setup Pontoons and Price tiers tabs, shared staff map

Repo: `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`. Commands are Git Bash and run from `D`. Rulings: R24 (Pontoons, Price tiers), R3 consumer (staff map), R14 (`?include_inactive=1` plus Reactivate), R15 (OTA 400s shown as toasts).

**Files:**
- Modify: `D/src/lib/marina-logic.ts`. Append `propertyToday` and `addDays` at the end of the file, after Task 7's `csvToBerthRows`.
- Modify: `D/scripts/check-marina.ts`. Add one import line after the existing imports, and two blocks immediately before the final `console.log('check-marina: ok');`.
- Create: `D/src/scripts/marina-staff-map.ts`
- Modify: `D/src/pages/marina-setup.astro` (created in Task 7):
  - Two tab buttons go right after the `data-setup-target="berths"` button.
  - Two panels go right after the closing tag of the `data-setup-tab="berths"` panel.
- Modify: `D/src/scripts/marina-setup-client.ts` (created in Task 7). Merge the imports and append one block at the end of the file.
- Modify: `D/tests/marina-setup.spec.ts` (created in Task 7). Merge the imports and append one `describe` block at the end of the file.
- Unchanged: `global.css`. `.is-inactive` comes from Task 6; `.settings-tab`, `.settings-card`, `.btn-link`, `.row-actions`, `.col-*` and `td input` already exist.

**Interfaces:**
- Consumes:
  - Task 1 (O):
    - `GET /api/marina/marinas/:marina_id/{pontoons|price-tiers}?include_inactive=1` returns every status.
    - Tier create/update with `valid_from > valid_to` → `400 {error:'valid_to must be on or after valid_from'}`.
    - A negative tier price → `400 {error:'price_per_night must be a number, 0 or more'}` (the `nonNeg` validator).
  - Tasks 3–5 (W/D):
    - Widget 1.1.0 is vendored. `@forgebuild/sidon-booking-widget/berth-map` defines `<sidon-berth-map>` with `mode`, `from`/`to` (reactive in staff mode) and `refresh()`.
    - The same-origin forwarder is `D/src/pages/api/marina/guest/[...path].ts`.
    - `loadProperty()` (has `timezone`) and `loadMarinas(): Promise<MarinaRow[]>` from `./sidebar-modules-widget`.
  - Task 6: `.is-inactive` CSS. `D/tests/marina-helpers.ts`: `uniqueSlug`, `createMarinaViaUi`, `deactivateMarinaViaUi`.
  - Task 7:
    - `marina-setup.astro` tab bar of `.settings-tab[data-setup-target]` buttons and `[data-setup-tab]` panels. Its tab script handles every `[data-setup-target]` in the markup and honours the URL hash.
    - `#marina-setup-select`: option values are marina ids (from `loadMarinas()`), and a user pick fires `change`.
    - `pickMarina` and `MARINA_STORAGE_KEY` from `../lib/marina-logic`.
- Produces:
  - `export function propertyToday(timeZone: string | null | undefined, now?: Date): string`
  - `export function addDays(ymd: string, n: number): string`
  - `export async function mountStaffMap(host: HTMLElement, slug: string, timeZone: string | null | undefined, height = '60svh'): Promise<HTMLElement & { refresh?: () => void }>` (Task 13 reuses it)
  - Pontoons tab DOM:
    - `#pontoon-add-btn`
    - `#pontoons-body tr[data-id][data-marina]` with inputs `[data-field="name|sort_order|sw_lat|sw_lng|ne_lat|ne_lng|rotation"]`
    - `input[type=file][data-field="svg_data"]` and `.pontoon-svg-state`
    - `#pontoon-preview`
  - Price tiers tab DOM:
    - `#tier-add-btn`
    - `#tiers-body tr[data-id][data-marina]` with inputs `[data-field="valid_from|valid_to|max_length_m|max_beam_m|price_per_night|price_per_month|price_per_year"]`
  - Both tabs: `.deactivate-btn` / `.reactivate-btn` on every row.

- [ ] **Step 1: Write the failing check for `propertyToday` and `addDays`**

In `D/scripts/check-marina.ts`, add this line after the existing `import … from '../src/lib/marina-logic.ts';` line(s). A second import from the same module is valid ESM, and it keeps the earlier tasks' import untouched:
```ts
import { addDays, propertyToday } from '../src/lib/marina-logic.ts';
```
Insert immediately before the final `console.log('check-marina: ok');`:
```ts
// ---- propertyToday ----
// The marina's day, never the viewer's: London staff at 23:30 UTC looking at
// a Rome marina are already on Rome's tomorrow; an Antigua marina viewed from
// Italy in the morning is still on yesterday.
assert.equal(propertyToday('Europe/Rome', new Date('2026-10-12T22:30:00Z')), '2026-10-13');
assert.equal(propertyToday('America/Antigua', new Date('2026-10-13T02:00:00Z')), '2026-10-12');
// DST end day in Rome (clocks go back at 01:00 UTC): 00:30 UTC is 02:30 CEST.
assert.equal(propertyToday('Europe/Rome', new Date('2026-10-25T00:30:00Z')), '2026-10-25');
// A bad or missing zone is UTC, not the viewer's zone.
assert.equal(propertyToday('Not/AZone', new Date('2026-10-12T23:30:00Z')), '2026-10-12');
assert.equal(propertyToday('', new Date('2026-10-12T23:30:00Z')), '2026-10-12');
assert.equal(propertyToday(null, new Date('2026-10-12T23:30:00Z')), '2026-10-12');
assert.equal(propertyToday(undefined, new Date('2026-10-12T23:30:00Z')), '2026-10-12');
assert.match(propertyToday('Europe/Rome'), /^\d{4}-\d{2}-\d{2}$/);

// ---- addDays ----
assert.equal(addDays('2026-12-31', 1), '2027-01-01'); // year end
assert.equal(addDays('2026-03-01', -1), '2026-02-28'); // month start, non-leap February
assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // across the Rome DST start (29 Mar)
assert.equal(addDays('2026-10-24', 1), '2026-10-25'); // into the DST end day
assert.equal(addDays('2026-10-25', 1), '2026-10-26'); // out of the 25-hour day
assert.equal(addDays('2026-10-13', 0), '2026-10-13');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/check-marina.ts; echo "exit=$?"`

Expected: FAIL, `exit=1`. Node rejects the import while linking, before any assert runs:
```
import { addDays, propertyToday } from '../src/lib/marina-logic.ts';
         ^^^^^^^
SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'addDays'
```

- [ ] **Step 3: Implement `propertyToday` and `addDays`**

Append to the end of `D/src/lib/marina-logic.ts`:
```ts
// ---- Task 8: the property's day ----

// "Today" at the marina, not on the viewer's machine: staff in London at
// 23:30 looking at a Rome marina are already on Rome's tomorrow. An unknown
// or empty zone falls back to UTC rather than the viewer's own zone, so a bad
// property setting is at least the same day for every viewer.
export function propertyToday(timeZone: string | null | undefined, now: Date = new Date()): string {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timeZone || 'UTC' });
  } catch {
    // RangeError: not an IANA zone.
    fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Calendar arithmetic on YYYY-MM-DD done in UTC, where every day is 24 h --
// local-time Date math lands on the wrong day around a DST change.
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the check again**

Run: `node scripts/check-marina.ts; echo "exit=$?"`

Expected: PASS:
```
check-marina: ok
exit=0
```

- [ ] **Step 5: Create the shared staff map mount**

Create `D/src/scripts/marina-staff-map.ts`:
```ts
import { addDays, propertyToday } from '../lib/marina-logic';

// The staff map: widget 1.1's <sidon-berth-map mode="staff"> showing tonight
// in the MARINA's time zone, not the viewer's. It reads OTA's guest map
// payload through the dashboard's own same-origin forwarder
// (src/pages/api/marina/guest/[...path].ts, staff bearer), so there's no
// api-origin. Shared by /marina-setup's pontoon preview and /marina's
// dashboard branch; callers listen for sidon-berth-selected and call
// el.refresh?.() after a change.
export async function mountStaffMap(
  host: HTMLElement,
  slug: string,
  timeZone: string | null | undefined,
  height = '60svh'
): Promise<HTMLElement & { refresh?: () => void }> {
  // Dynamic, never a top-level import: /marina's interim branch defines the
  // same tag from the 0.4.17 alias, so 1.1 may only load on pages/branches
  // that never load that one.
  await import('@forgebuild/sidon-booking-widget/berth-map');
  const today = propertyToday(timeZone);
  const el = document.createElement('sidon-berth-map') as HTMLElement & { refresh?: () => void };
  el.setAttribute('marina', slug);
  el.setAttribute('mode', 'staff');
  el.setAttribute('from', today);
  el.setAttribute('to', addDays(today, 1));
  el.setAttribute('maps-api-key', import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY ?? '');
  el.setAttribute('map-height', height);
  el.setAttribute('locale', 'en');
  host.replaceChildren(el);
  return el;
}
```

- [ ] **Step 6: Extend the Playwright spec (written before the page code)**

In `D/tests/marina-setup.spec.ts`, merge these imports with the ones Task 7 wrote. Add any missing name to the existing import from the same module, and never import a name twice:
```ts
import { test, expect, type Page } from '@playwright/test';
import { uniqueSlug, createMarinaViaUi, deactivateMarinaViaUi } from './marina-helpers';
import { addDays, propertyToday } from '../src/lib/marina-logic';
```
Append to the end of the file:
```ts
// Pontoons and price tiers on a marina of their own, so this block doesn't
// depend on the berths block's state. Serial: each test builds on the last.
test.describe.serial('marina setup: pontoons and price tiers', () => {
  const slug = uniqueSlug('pw-pontoons');
  let marinaId = '';

  // A pontoon SVG as marinas draw them: each berth shape carries its label.
  const PIER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20">' +
    '<rect data-berth-id="A1" x="0" y="0" width="10" height="20"/>' +
    '<rect data-berth-id="A2" x="12" y="0" width="10" height="20"/></svg>';

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  const waitPut = (page: Page, kind: 'pontoons' | 'price-tiers') =>
    page.waitForResponse(
      (res) => res.request().method() === 'PUT' && res.url().includes(`/api/marina/marinas/${marinaId}/${kind}/`)
    );

  // Opens a tab on this run's marina and waits for its list GET. Exactly one
  // is sent, from either the initial pick or the select change (the client
  // never reloads the marina it already shows), so the wait is set up before
  // goto. Resolves to the property's time zone, which "today" is based on.
  async function openTab(page: Page, tab: 'pontoons' | 'price-tiers'): Promise<string | undefined> {
    const listed = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes(`/api/marina/marinas/${marinaId}/${tab}?include_inactive=1`)
    );
    const me = page.waitForResponse((res) => res.url().includes('/api/property/me'));
    await page.goto(`/marina-setup#${tab}`);
    await expect(page.locator(`#marina-setup-select option[value="${marinaId}"]`)).toHaveCount(1);
    await page.selectOption('#marina-setup-select', marinaId);
    await listed;
    return (await (await me).json())?.timezone;
  }

  test('create a marina for this run', async ({ page }) => {
    marinaId = await createMarinaViaUi(page, { name: `Playwright Pontoons ${Date.now()}`, slug });
    expect(marinaId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a pontoon takes corners and an SVG; the preview is the staff map', async ({ page }) => {
    const timeZone = await openTab(page, 'pontoons');

    const [created] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/marina/marinas/${marinaId}/pontoons`)
      ),
      page.locator('#pontoon-add-btn').click(),
    ]);
    expect(created.status()).toBe(201);
    const pontoon = await created.json();
    const row = page.locator(`#pontoons-body tr[data-id="${pontoon.id}"]`);
    await expect(row.locator('[data-field="name"]')).toHaveValue('New pontoon');

    const swLat = row.locator('[data-field="sw_lat"]');
    await swLat.fill('40.6281');
    const [cornerPut] = await Promise.all([waitPut(page, 'pontoons'), swLat.blur()]);
    expect(cornerPut.ok()).toBeTruthy();
    expect(cornerPut.request().postDataJSON()).toEqual({ sw_lat: 40.6281 });
    await expect(page.locator('.toast--success').last()).toContainText('New pontoon: SW latitude saved');

    const fileInput = row.locator('input[type="file"][data-field="svg_data"]');
    const [svgPut] = await Promise.all([
      waitPut(page, 'pontoons'),
      fileInput.setInputFiles({ name: 'pier-a.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(PIER_SVG) }),
    ]);
    expect(svgPut.ok()).toBeTruthy();
    expect(svgPut.request().postDataJSON()).toEqual({ svg_data: PIER_SVG });
    await expect(page.locator('.toast--success').last()).toContainText('New pontoon: SVG saved');
    await expect(row.locator('.pontoon-svg-state')).toHaveText('SVG set');

    // Past OTA's 2 MB JSON limit: refused in the browser, nothing sent.
    let oversizePuts = 0;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(`/pontoons/${pontoon.id}`)) oversizePuts++;
    });
    await fileInput.setInputFiles({
      name: 'huge.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(2 * 1024 * 1024)}</svg>`),
    });
    await expect(page.locator('.toast--error').last()).toContainText(
      'huge.svg is too large — pontoon SVGs are limited to 2 MB'
    );
    expect(oversizePuts).toBe(0);

    // R3 consumer: staff mode, same-origin forwarder, tonight in the property's zone.
    const map = page.locator('#pontoon-preview sidon-berth-map');
    await expect(map).toHaveAttribute('mode', 'staff');
    await expect(map).toHaveAttribute('marina', slug);
    await expect(map).not.toHaveAttribute('api-origin');
    const today = propertyToday(timeZone);
    await expect(map).toHaveAttribute('from', today);
    await expect(map).toHaveAttribute('to', addDays(today, 1));
  });

  test('price tiers: OTA refusals toasted as-is and reverted; deactivate and reactivate', async ({ page }) => {
    await openTab(page, 'price-tiers');

    const [created] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/marina/marinas/${marinaId}/price-tiers`)
      ),
      page.locator('#tier-add-btn').click(),
    ]);
    expect(created.status()).toBe(201);
    const tier = await created.json();
    const row = page.locator(`#tiers-body tr[data-id="${tier.id}"]`);

    const maxLength = row.locator('[data-field="max_length_m"]');
    await maxLength.fill('12');
    const [lengthPut] = await Promise.all([waitPut(page, 'price-tiers'), maxLength.blur()]);
    expect(lengthPut.ok()).toBeTruthy();
    await expect(page.locator('.toast--success').last()).toContainText('Max length saved');

    // A date input fires change on fill, which sends the PUT.
    const validFrom = row.locator('[data-field="valid_from"]');
    await expect(validFrom).toHaveValue(tier.valid_from);
    const [badDates] = await Promise.all([waitPut(page, 'price-tiers'), validFrom.fill('2099-01-01')]);
    expect(badDates.status()).toBe(400);
    await expect(page.locator('.toast--error').last()).toContainText('valid_to must be on or after valid_from');
    await expect(validFrom).toHaveValue(tier.valid_from);

    const night = row.locator('[data-field="price_per_night"]');
    await night.fill('-5');
    const [negative] = await Promise.all([waitPut(page, 'price-tiers'), night.blur()]);
    expect(negative.status()).toBe(400);
    await expect(page.locator('.toast--error').last()).toContainText('price_per_night must be a number, 0 or more');
    await expect(night).toHaveValue(tier.price_per_night);

    await Promise.all([waitPut(page, 'price-tiers'), row.locator('.deactivate-btn').click()]);
    await expect(row).toHaveClass(/is-inactive/);
    await expect(row.locator('.reactivate-btn')).toBeVisible();

    // Still listed after a reload: the tab lists with ?include_inactive=1 (R14).
    await openTab(page, 'price-tiers');
    await expect(row).toHaveClass(/is-inactive/);
    await Promise.all([waitPut(page, 'price-tiers'), row.locator('.reactivate-btn').click()]);
    await expect(row).not.toHaveClass(/is-inactive/);
    await expect(row.locator('.deactivate-btn')).toBeVisible();
  });
});
```

- [ ] **Step 7: Run the spec and watch the new block fail**

Prerequisites:
- Local OTA is running with Task 1 applied: `cd C:/Users/robert/source/repos/OTA && npm run dev`.
- The dashboard is running: `npx astro dev --background`, on port 4335.

Run: `npx playwright test tests/marina-setup.spec.ts; echo "exit=$?"`

Expected: FAIL, `exit=1`:
- Task 7's tests and `create a marina for this run` pass.
- `a pontoon takes corners and an SVG; the preview is the staff map` fails with `Test timeout of 45000ms exceeded.` (no `/pontoons?include_inactive=1` GET is ever sent).
- The tiers test is skipped (serial). The summary shows `1 failed`, `1 skipped`.

- [ ] **Step 8: Add the two tabs to the page**

Task 7 already renders all seven tab buttons and an empty placeholder panel per tab. In `D/src/pages/marina-setup.astro`, replace the two placeholders

```astro
      <section class="marina-setup-panel" data-setup-tab="pontoons" hidden><h2>Pontoons</h2></section>
      <section class="marina-setup-panel" data-setup-tab="price-tiers" hidden><h2>Price tiers</h2></section>
```

with (no new tab buttons):
```astro
      <section class="marina-setup-panel" data-setup-tab="pontoons" hidden>
      <h2>Pontoons</h2>
      <div class="page-header-actions">
        <button id="pontoon-add-btn" type="button">Add pontoon</button>
      </div>
      <p class="chart-card-subtitle">
        Corners are the SVG's south-west and north-east points in decimal degrees; rotation is clockwise degrees.
        Each berth shape in the SVG carries <code>data-berth-id="&lt;berth label&gt;"</code>. SVGs up to 2 MB.
      </p>
      <table id="pontoons-table">
        <thead>
          <tr>
            <th>Name</th>
            <th class="col-narrow">Order</th>
            <th class="col-narrow">SW lat</th>
            <th class="col-narrow">SW lng</th>
            <th class="col-narrow">NE lat</th>
            <th class="col-narrow">NE lng</th>
            <th class="col-narrow">Rotation</th>
            <th>SVG</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody id="pontoons-body"></tbody>
      </table>
      <h3>Preview</h3>
      <p class="chart-card-subtitle">Tonight at this marina, as staff see it on the Marina page. Refreshes after each pontoon save.</p>
      <div id="pontoon-preview"></div>
      </section>

      <section class="marina-setup-panel" data-setup-tab="price-tiers" hidden>
      <h2>Price tiers</h2>
      <div class="page-header-actions">
        <button id="tier-add-btn" type="button">Add price tier</button>
      </div>
      <p class="chart-card-subtitle">
        A boat pays the tier with the smallest max length (and beam) it fits on its arrival date. Valid to is inclusive.
      </p>
      <table id="tiers-table">
        <thead>
          <tr>
            <th>Valid from</th>
            <th>Valid to</th>
            <th class="col-narrow">Max length (m)</th>
            <th class="col-narrow">Max beam (m)</th>
            <th class="col-narrow">Per night</th>
            <th class="col-narrow">Per month</th>
            <th class="col-narrow">Per year</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody id="tiers-body"></tbody>
      </table>
      </section>
```

- [ ] **Step 9: Wire both tabs in the client script**

In `D/src/scripts/marina-setup-client.ts`, make sure the top-of-file imports include these names. Add each missing name to the existing import from the same module, or add the line if that module isn't imported yet. Never import a name twice:
```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { loadMarinas, loadProperty } from './sidebar-modules-widget';
import { MARINA_STORAGE_KEY, pickMarina, propertyToday } from '../lib/marina-logic';
import { mountStaffMap } from './marina-staff-map';
```
Append to the end of the file:
```ts
// ---- Pontoons and Price tiers tabs ----

// One function scope so these helpers can't collide with the other tabs'
// top-level names in this file.
function mountPontoonsAndTiersTabs(): void {
  type Kind = 'pontoons' | 'price-tiers';
  type Row = Record<string, any> & { id: string; marina_id: string; status: string };

  const select = document.getElementById('marina-setup-select') as HTMLSelectElement;
  const pontoonsPanel = document.querySelector('[data-setup-tab="pontoons"]') as HTMLElement;
  const previewHost = document.getElementById('pontoon-preview') as HTMLElement;
  const bodies: Record<Kind, HTMLTableSectionElement> = {
    pontoons: document.getElementById('pontoons-body') as HTMLTableSectionElement,
    'price-tiers': document.getElementById('tiers-body') as HTMLTableSectionElement,
  };

  const LABELS: Record<string, string> = {
    name: 'Name',
    sort_order: 'Order',
    sw_lat: 'SW latitude',
    sw_lng: 'SW longitude',
    ne_lat: 'NE latitude',
    ne_lng: 'NE longitude',
    rotation: 'Rotation',
    valid_from: 'Valid from',
    valid_to: 'Valid to',
    max_length_m: 'Max length',
    max_beam_m: 'Max beam',
    price_per_night: 'Price per night',
    price_per_month: 'Price per month',
    price_per_year: 'Price per year',
  };

  // OTA parses /api/marina bodies with express.json({ limit: '2mb' })
  // (O/src/app.js), which counts the whole JSON body in bytes; past it the
  // PUT dies with a bare 413, so refuse it here with a clear message.
  const SVG_BODY_LIMIT = 2 * 1024 * 1024;

  let marinaId = '';
  let loadSeq = 0;
  let timeZone: string | undefined;
  let previewSlug = '';
  let previewFor = '';
  let preview: (HTMLElement & { refresh?: () => void }) | null = null;

  const val = (v: unknown) => escapeHtml(v ?? '');
  const num = (field: string, label: string, v: unknown, extra = '') =>
    `<td><input type="number" step="any" data-field="${field}" value="${val(v)}" aria-label="${label}" ${extra} /></td>`;

  function rowHtml(kind: Kind, r: Row): string {
    const actions = `<td class="col-actions"><div class="row-actions">${
      r.status === 'inactive'
        ? '<button type="button" class="btn-link reactivate-btn">Reactivate</button>'
        : '<button type="button" class="btn-link deactivate-btn">Deactivate</button>'
    }</div></td>`;
    if (kind === 'pontoons') {
      return `
        <td><input type="text" data-field="name" maxlength="100" required value="${val(r.name)}" aria-label="Pontoon name" /></td>
        <td><input type="number" step="1" data-field="sort_order" value="${val(r.sort_order)}" aria-label="Order" /></td>
        ${num('sw_lat', 'SW latitude', r.sw_lat)}
        ${num('sw_lng', 'SW longitude', r.sw_lng)}
        ${num('ne_lat', 'NE latitude', r.ne_lat)}
        ${num('ne_lng', 'NE longitude', r.ne_lng)}
        ${num('rotation', 'Rotation', r.rotation)}
        <td>
          <span class="pontoon-svg-state">${r.svg_data ? 'SVG set' : 'No SVG'}</span>
          <input type="file" accept=".svg,image/svg+xml" data-field="svg_data" aria-label="Upload pontoon SVG" />
        </td>
        ${actions}`;
    }
    return `
      <td><input type="date" data-field="valid_from" required value="${val(r.valid_from)}" aria-label="Valid from" /></td>
      <td><input type="date" data-field="valid_to" required value="${val(r.valid_to)}" aria-label="Valid to" /></td>
      ${num('max_length_m', 'Max length (m)', r.max_length_m, 'min="0" required')}
      ${num('max_beam_m', 'Max beam (m)', r.max_beam_m, 'min="0"')}
      ${num('price_per_night', 'Price per night', r.price_per_night, 'min="0" required')}
      ${num('price_per_month', 'Price per month', r.price_per_month, 'min="0"')}
      ${num('price_per_year', 'Price per year', r.price_per_year, 'min="0"')}
      ${actions}`;
  }

  function renderRow(kind: Kind, tr: HTMLTableRowElement, r: Row): void {
    tr.dataset.id = r.id;
    // The row's own marina, so a save in flight while the select changes
    // still goes to the right URL.
    tr.dataset.marina = r.marina_id;
    tr.classList.toggle('is-inactive', r.status === 'inactive');
    tr.innerHTML = rowHtml(kind, r);
  }

  function appendRow(kind: Kind, r: Row): HTMLTableRowElement {
    const tr = document.createElement('tr');
    renderRow(kind, tr, r);
    bodies[kind].append(tr);
    return tr;
  }

  // Toast prefix from the last saved values (defaultValue), not what's typed.
  function identify(kind: Kind, tr: HTMLTableRowElement): string {
    const saved = (f: string) => (tr.querySelector(`[data-field="${f}"]`) as HTMLInputElement).defaultValue;
    return kind === 'pontoons' ? saved('name') || 'Pontoon' : `Tier up to ${saved('max_length_m')} m`;
  }

  // The saved row, OTA's error text, or null when apiFetch already opened sign-in.
  async function put(kind: Kind, tr: HTMLTableRowElement, body: Record<string, unknown>): Promise<Row | string | null> {
    try {
      const res = await apiFetch(`/api/marina/marinas/${tr.dataset.marina}/${kind}/${tr.dataset.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => null);
      return res.ok && data && typeof data === 'object' ? (data as Row) : (data?.error ?? 'unknown error');
    } catch (err) {
      return err instanceof Error && err.message === 'Not authenticated' ? null : 'request failed';
    }
  }

  async function saveField(kind: Kind, tr: HTMLTableRowElement, input: HTMLInputElement, value: unknown) {
    const field = input.dataset.field!;
    const label = LABELS[field] ?? field;
    const name = identify(kind, tr);
    input.disabled = true;
    const result = await put(kind, tr, { [field]: value });
    input.disabled = false;
    if (result === null) return;
    if (typeof result === 'string') {
      // Put the last saved value back: the grid never shows something OTA refused.
      input.value = input.defaultValue;
      showToast(`${name}: Failed to save ${label} — ${result}`, 'error');
      return;
    }
    input.value = input.defaultValue = String(result[field] ?? '');
    showToast(`${name}: ${label} saved`, 'success');
    if (kind === 'pontoons') preview?.refresh?.();
  }

  async function uploadSvg(tr: HTMLTableRowElement, input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    const name = identify('pontoons', tr);
    const svg = await file.text();
    input.value = ''; // so picking the same file again still fires change
    if (!/<svg[\s>]/i.test(svg)) {
      showToast(`${name}: ${file.name} is not an SVG file`, 'error');
      return;
    }
    if (new Blob([JSON.stringify({ svg_data: svg })]).size > SVG_BODY_LIMIT) {
      showToast(`${name}: ${file.name} is too large — pontoon SVGs are limited to 2 MB`, 'error');
      return;
    }
    input.disabled = true;
    const result = await put('pontoons', tr, { svg_data: svg });
    input.disabled = false;
    if (result === null) return;
    if (typeof result === 'string') {
      showToast(`${name}: Failed to save SVG — ${result}`, 'error');
      return;
    }
    (tr.querySelector('.pontoon-svg-state') as HTMLElement).textContent = result.svg_data ? 'SVG set' : 'No SVG';
    showToast(`${name}: SVG saved`, 'success');
    preview?.refresh?.();
  }

  async function setStatus(kind: Kind, tr: HTMLTableRowElement, btn: HTMLButtonElement, status: 'active' | 'inactive') {
    const name = identify(kind, tr);
    const verb = status === 'inactive' ? 'deactivate' : 'reactivate';
    btn.disabled = true;
    const result = await put(kind, tr, { status });
    btn.disabled = false;
    if (result === null) return;
    if (typeof result === 'string') {
      showToast(`${name}: Failed to ${verb} — ${result}`, 'error');
      return;
    }
    renderRow(kind, tr, result);
    showToast(`${name}: ${verb}d`, 'success');
    if (kind === 'pontoons') preview?.refresh?.();
  }

  async function create(kind: Kind, btn: HTMLButtonElement, what: string, body: Record<string, unknown>) {
    if (!marinaId) return;
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/marina/marinas/${marinaId}/${kind}`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        showToast(`Failed to create ${what} — ${data?.error ?? 'unknown error'}`, 'error');
        return;
      }
      appendRow(kind, data).querySelector('input')?.focus();
      showToast(`${what[0].toUpperCase()}${what.slice(1)} created`, 'success');
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Not authenticated')) showToast(`Failed to create ${what}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function list(kind: Kind, id: string): Promise<Row[]> {
    const what = kind === 'pontoons' ? 'pontoons' : 'price tiers';
    try {
      // include_inactive: deactivated rows stay listed (greyed) so they can be reactivated.
      const res = await apiFetch(`/api/marina/marinas/${id}/${kind}?include_inactive=1`);
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data)) return data;
      showToast(`Failed to load ${what} — ${data?.error ?? 'unknown error'}`, 'error');
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Not authenticated')) showToast(`Failed to load ${what}`, 'error');
    }
    return [];
  }

  // Mounted on first view of the tab: a map started inside a hidden panel
  // has no size, and the widget fits its bounds only once.
  async function ensurePreview() {
    if (!previewSlug || previewFor === marinaId) return;
    const forId = (previewFor = marinaId);
    const el = await mountStaffMap(previewHost, previewSlug, timeZone, '45svh');
    if (previewFor === forId) preview = el;
  }

  async function load(id: string) {
    marinaId = id;
    const seq = ++loadSeq;
    preview = null;
    previewFor = '';
    previewSlug = '';
    previewHost.replaceChildren();
    bodies.pontoons.replaceChildren();
    bodies['price-tiers'].replaceChildren();
    if (!id) return;
    const [pontoons, tiers, marinas, property] = await Promise.all([
      list('pontoons', id),
      list('price-tiers', id),
      loadMarinas(),
      loadProperty(),
    ]);
    if (seq !== loadSeq) return; // another marina was picked while these loaded
    timeZone = property?.timezone;
    for (const r of pontoons) appendRow('pontoons', r);
    for (const r of tiers) appendRow('price-tiers', r);
    // loadMarinas() is active-only, and so is OTA's guest map payload.
    previewSlug = marinas.find((m) => m.id === id)?.slug ?? '';
    if (!previewSlug) previewHost.textContent = 'The preview shows active marinas only.';
    else if (!pontoonsPanel.hidden) void ensurePreview();
  }

  for (const kind of ['pontoons', 'price-tiers'] as const) {
    bodies[kind].addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const tr = input.closest<HTMLTableRowElement>('tr[data-id]');
      if (!tr || !input.dataset.field) return;
      if (input.type === 'file') return void uploadSvg(tr, input);
      const raw = input.value.trim();
      // A blank required cell would fail OTA's check (or its NOT NULL), so treat it as undo.
      if (!raw && input.required) {
        input.value = input.defaultValue;
        return;
      }
      void saveField(kind, tr, input, input.type === 'number' ? (raw === '' ? null : Number(raw)) : raw);
    });
    bodies[kind].addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.deactivate-btn, .reactivate-btn');
      const tr = btn?.closest<HTMLTableRowElement>('tr[data-id]');
      if (btn && tr) void setStatus(kind, tr, btn, btn.classList.contains('deactivate-btn') ? 'inactive' : 'active');
    });
  }

  const pontoonAddBtn = document.getElementById('pontoon-add-btn') as HTMLButtonElement;
  pontoonAddBtn.addEventListener('click', () =>
    create('pontoons', pontoonAddBtn, 'pontoon', { name: 'New pontoon', sort_order: bodies.pontoons.rows.length })
  );
  const tierAddBtn = document.getElementById('tier-add-btn') as HTMLButtonElement;
  tierAddBtn.addEventListener('click', async () => {
    // The marina's today, and to the end of the marina's calendar year (valid_to is inclusive).
    const today = propertyToday((await loadProperty())?.timezone);
    await create('price-tiers', tierAddBtn, 'price tier', {
      valid_from: today,
      valid_to: `${today.slice(0, 4)}-12-31`,
      max_length_m: 10,
      price_per_night: 0,
    });
  });

  document.querySelector('[data-setup-target="pontoons"]')?.addEventListener('click', () => void ensurePreview());
  select.addEventListener('change', () => {
    if (select.value !== marinaId) void load(select.value);
  });
  void (async () => {
    const marinas = await loadMarinas();
    if (marinaId) return; // the select's change already loaded one
    // Same rule as the berths tab (stored pick, else the first marina), so it
    // doesn't matter which of the two filled the select first.
    const initial = select.value || pickMarina(marinas, localStorage.getItem(MARINA_STORAGE_KEY))?.id;
    if (initial) await load(initial);
  })();
}

mountPontoonsAndTiersTabs();
```

- [ ] **Step 10: Logic check and build**

Run: `node scripts/check-marina.ts && npm run build; echo "exit=$?"`

Expected:
- `check-marina: ok`.
- Then Astro's build log ends with `[build] Complete!`.
- `exit=0`.

`marina-staff-map.ts` is split into its own dynamic-import chunk for `@forgebuild/sidon-booking-widget/berth-map`, and there is no unresolved-import error.

- [ ] **Step 11: Run the spec again**

Use the same local stack as Step 7, with the dev server restarted if it was stopped: `npx astro dev --background`.

Run: `npx playwright test tests/marina-setup.spec.ts; echo "exit=$?"`

Expected: PASS, `exit=0`. Every test passes, including:
- `marina setup: pontoons and price tiers › create a marina for this run`
- `› a pontoon takes corners and an SVG; the preview is the staff map`
- `› price tiers: OTA refusals toasted as-is and reverted; deactivate and reactivate`

The summary has no `failed` or `skipped` line. `afterAll` deactivates the run's marina through the Settings UI.

- [ ] **Step 12: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/scripts/marina-staff-map.ts src/pages/marina-setup.astro src/scripts/marina-setup-client.ts tests/marina-setup.spec.ts && git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: pontoons, price tiers and the staff map preview" -m "/marina-setup gains Pontoons (per-field autosave of name, order, SW/NE corners and rotation; SVG read in the browser and PUT as svg_data, refused client-side past OTA's 2 MB JSON limit; a staff-map preview refreshed after every pontoon save) and Price tiers (dates, size limits and prices, with OTA's 400s toasted as-is and the cell reverted). Both list with ?include_inactive=1 and deactivate/reactivate rows. propertyToday/addDays put 'today' on the marina's own calendar day; mountStaffMap mounts widget 1.1's <sidon-berth-map mode=\"staff\"> on tonight through the same-origin forwarder and is shared with /marina." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Nothing is pushed or deployed. The runbook later deploys D (after OTA Task 1 is live), per R2.

---

### Task 9: Dashboard — /marina-setup Requirements, Templates, POIs and Images tabs

Repo: `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`. Commands are Git Bash and run from `D`. Implements R24 (Document requirements, Contract templates, POIs, Images), R14 (`?include_inactive=1` lists, greyed rows with Reactivate), R15 (the image 413 is shown to staff) and R17 (no contract-fields route: placeholder warnings come from the save response).

**Files:**
- Modify: `D/src/lib/marina-logic.ts`: append the Task 9 exports after Task 8's `addDays`, at the end of the file.
- Modify: `D/scripts/check-marina.ts`: add two names to the named import from `'../src/lib/marina-logic.ts'`, and add two blocks just before the final `console.log('check-marina: ok');`.
- Modify: `D/src/pages/marina-setup.astro` (Tasks 7–8): add four panels after the `data-setup-tab="price-tiers"` panel. Add tab buttons only for any of the four `data-setup-target` values that Task 7 did not render.
- Modify: `D/src/scripts/marina-setup-client.ts` (Tasks 7–8): merge the imports at the top and append the Task 9 block at the end of the file.
- Modify: `D/src/styles/global.css`: append two rules at the end of the file.
- Modify: `D/tests/marina-setup.spec.ts` (Tasks 7–8): merge the imports at the top and append one `describe.serial` block at the end of the file.

**Interfaces:**
- Consumes:
  - `loadMarinas(): Promise<MarinaRow[]>` from `D/src/scripts/sidebar-modules-widget.ts` (Task 5).
  - `MARINA_STORAGE_KEY` and `pickMarina` (Task 7).
  - `#marina-setup-select`, whose value is the selected marina id and which fires `change` when staff pick another marina (Task 7).
  - The hash-linked `data-setup-target` / `data-setup-tab` tab switching (Task 7).
  - `.is-inactive` greyed rows (Task 6 CSS).
  - `uniqueSlug`, `createMarinaViaUi` and `deactivateMarinaViaUi` from `D/tests/marina-helpers.ts` (Task 6).
  - OTA (Task 1): `GET /api/marina/marinas/:marina_id/{doc-requirements|contract-templates|pois|images}?include_inactive=1`.
  - OTA (Task 1): `POST /api/marina/marinas/:marina_id/images/upload` returns `413 {error:'Images are limited to 4 MB'}` when the image is too large.
  - OTA (existing): `POST` / `PUT /api/marina/marinas/:marina_id/<kind>[/:id]`. On contract templates the response carries `warnings: { unknown_placeholders: string[] }` only when there are unknown placeholders.
  - `apiFetch` and `escapeHtml` (`api-client.ts`), `showToast` (`toast.ts`).
- Produces:
  - `fieldsToLines(fields: unknown): string`
  - `linesToFields(text: string): { name: string; label: string; type: string }[]`
  - Panels `data-setup-tab="doc-requirements|contract-templates|pois|images"`.
  - Row bodies `#doc-requirements-body`, `#contract-templates-body`, `#pois-body` and `#images-body`, each holding `tr[data-id]`. Every input carries `data-field="<OTA column>"`. A row has `.deactivate-btn`, or `.is-inactive` plus `.reactivate-btn`.
  - Add buttons `#doc-requirement-add-btn`, `#contract-template-add-btn` and `#poi-add-btn`.
  - Upload controls `#images-upload-desc` and `#images-upload-input`; thumbnails are `img.marina-thumb`.

- [ ] **Step 1: Failing check for fieldsToLines / linesToFields**

In `D/scripts/check-marina.ts`, add `fieldsToLines, linesToFields` to the existing named import from `'../src/lib/marina-logic.ts'`, keeping every name already there.

Old (last line of the file):
```ts
console.log('check-marina: ok');
```
New:
```ts
// ---- fieldsToLines ----
assert.equal(
  fieldsToLines([{ name: 'policy_number', label: 'Policy number', type: 'text' }, { name: 'expiry', label: 'Expiry', type: 'date' }]),
  'policy_number | Policy number | text\nexpiry | Expiry | date',
);
// A stored row missing label/type shows the same defaults linesToFields would give it.
assert.equal(fieldsToLines([{ name: 'insurer' }]), 'insurer | insurer | text');
assert.equal(fieldsToLines([]), '');
assert.equal(fieldsToLines(null), '');
assert.equal(fieldsToLines(undefined), '');
assert.equal(fieldsToLines('[{"name":"x"}]'), '');
assert.equal(fieldsToLines({ name: 'x' }), '');

// ---- linesToFields ----
assert.deepEqual(linesToFields('policy_number | Policy number | text\nexpiry|Expiry|date'), [
  { name: 'policy_number', label: 'Policy number', type: 'text' },
  { name: 'expiry', label: 'Expiry', type: 'date' },
]);
assert.deepEqual(linesToFields('  insurer  '), [{ name: 'insurer', label: 'insurer', type: 'text' }]);
assert.deepEqual(linesToFields('vat |  | '), [{ name: 'vat', label: 'vat', type: 'text' }]);
assert.deepEqual(linesToFields('a\n\n   \r\nb | B'), [
  { name: 'a', label: 'a', type: 'text' },
  { name: 'b', label: 'B', type: 'text' },
]);
assert.deepEqual(linesToFields(''), []);
assert.throws(() => linesToFields('ok\n | Label only'), { message: 'line 2: name is required' });
// N is the textarea line, blank lines included
assert.throws(() => linesToFields('\n\n|x'), { message: 'line 3: name is required' });
const docLines = 'policy_number | Policy number | text\nexpiry | Expiry | date';
assert.equal(fieldsToLines(linesToFields(docLines)), docLines);
const docFields = [{ name: 'loa', label: 'Length overall', type: 'number' }];
assert.deepEqual(linesToFields(fieldsToLines(docFields)), docFields);

console.log('check-marina: ok');
```

- [ ] **Step 2: Run it and see it fail**

Run: `node scripts/check-marina.ts`

Expected: FAIL. Node exits 1 before any assert runs, with:
```
SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'fieldsToLines'
```

- [ ] **Step 3: Implement both functions in marina-logic.ts**

Append to the end of `D/src/lib/marina-logic.ts`:
```ts
// ---- Task 9 ----

// Document-requirement fields are edited as one 'name | label | type' line
// each: the shape OTA stores ([{name,label,type}]) and hands to the
// extraction prompt, without a nested-row editor.
export function fieldsToLines(fields: unknown): string {
  if (!Array.isArray(fields)) return '';
  return fields
    .map((f) => {
      const name = String(f?.name ?? '');
      return `${name} | ${f?.label || name} | ${f?.type || 'text'}`;
    })
    .join('\n');
}

export function linesToFields(text: string): { name: string; label: string; type: string }[] {
  const fields: { name: string; label: string; type: string }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const [name = '', label = '', type = ''] = line.split('|').map((c) => c.trim());
    // Counted over every textarea line so the toast points at the line staff see.
    if (!name) throw new Error(`line ${i + 1}: name is required`);
    fields.push({ name, label: label || name, type: type || 'text' });
  });
  return fields;
}
```

- [ ] **Step 4: Run the check again**

Run: `node scripts/check-marina.ts`

Expected: PASS. The only output is:
```
check-marina: ok
```

- [ ] **Step 5: Playwright tests first**

In `D/tests/marina-setup.spec.ts`, merge into the existing import lines at the top (keep the names already imported) so that they include:
```ts
import { test, expect, type Page } from '@playwright/test';
import { uniqueSlug, createMarinaViaUi, deactivateMarinaViaUi } from './marina-helpers';
import { MARINA_STORAGE_KEY } from '../src/lib/marina-logic';
```
Append to the end of the file:
```ts
// ---- Task 9: requirements, templates, POIs, images ----
// A 1x1 PNG: OTA sniffs magic bytes, so it has to be a real image.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.describe.serial('marina setup: requirements, templates, POIs, images', () => {
  const slug = uniqueSlug('pw-setup-lists');
  let marinaId = '';
  let poiId = '';

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      marinaId = await createMarinaViaUi(page, { name: `PW lists ${slug}`, slug });
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  // Pre-select this run's marina the way the page remembers it, so the
  // initial pick is ours and there is exactly one list load to wait for.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [MARINA_STORAGE_KEY, marinaId] as const);
  });

  async function openTab(page: Page, kind: string) {
    const loaded = page.waitForResponse(
      (res) => res.request().method() === 'GET' && res.url().includes(`/api/marina/marinas/${marinaId}/${kind}?include_inactive=1`),
    );
    await page.goto(`/marina-setup#${kind}`);
    await loaded;
  }

  const isPut = (kind: string) => (res: import('@playwright/test').Response) =>
    res.request().method() === 'PUT' && res.url().includes(`/api/marina/marinas/${marinaId}/${kind}/`);
  const isPost = (kind: string) => (res: import('@playwright/test').Response) =>
    res.request().method() === 'POST' && res.url().endsWith(`/api/marina/marinas/${marinaId}/${kind}`);

  test('a contract template with an unknown placeholder warns after save', async ({ page }) => {
    await openTab(page, 'contract-templates');
    const [created] = await Promise.all([
      page.waitForResponse(isPost('contract-templates')),
      page.locator('#contract-template-add-btn').click(),
    ]);
    expect(created.status()).toBe(201);
    const id = (await created.json()).id as string;
    // The default body only uses known merge fields: no warning on create.
    await expect(page.locator('.toast--warning')).toHaveCount(0);

    const body = page.locator(`#contract-templates-body tr[data-id="${id}"] textarea[data-field="body_markdown"]`);
    await body.fill('Berth {{berth_id}} for {{bogus}}.');
    const [saved] = await Promise.all([page.waitForResponse(isPut('contract-templates')), body.blur()]);
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).warnings).toEqual({ unknown_placeholders: ['bogus'] });
    await expect(page.locator('.toast--warning').last()).toContainText('{{bogus}}');
  });

  test("a document requirement's fields round-trip after reload", async ({ page }) => {
    await openTab(page, 'doc-requirements');
    const [created] = await Promise.all([
      page.waitForResponse(isPost('doc-requirements')),
      page.locator('#doc-requirement-add-btn').click(),
    ]);
    expect(created.status()).toBe(201);
    const id = (await created.json()).id as string;
    const fields = page.locator(`#doc-requirements-body tr[data-id="${id}"] textarea[data-field="fields"]`);

    // A line with no name is refused in the browser: an error toast and no PUT.
    let puts = 0;
    page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/doc-requirements/')) puts++; });
    await fields.fill(' | Label only');
    await fields.blur();
    await expect(page.locator('.toast--error').last()).toContainText('line 1: name is required');
    expect(puts).toBe(0);

    await fields.fill('policy_number | Policy number | text\n\n  expiry |  | date\ninsurer');
    const [saved] = await Promise.all([page.waitForResponse(isPut('doc-requirements')), fields.blur()]);
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).fields).toEqual([
      { name: 'policy_number', label: 'Policy number', type: 'text' },
      { name: 'expiry', label: 'expiry', type: 'date' },
      { name: 'insurer', label: 'insurer', type: 'text' },
    ]);
    await expect(page.locator('.toast--success').last()).toContainText('New requirement: Fields saved');

    await openTab(page, 'doc-requirements');
    await expect(page.locator(`#doc-requirements-body tr[data-id="${id}"] textarea[data-field="fields"]`)).toHaveValue(
      'policy_number | Policy number | text\nexpiry | expiry | date\ninsurer | insurer | text',
    );
  });

  test('an uploaded PNG appears as a thumbnail', async ({ page }) => {
    await page.route(`**/api/marina/marinas/${marinaId}/images/upload`, async (route) => {
      const res = await route.fetch();
      if (res.status() !== 500) return route.fulfill({ response: res });
      // Local OTA has no BLOB_PUBLIC_READ_WRITE_TOKEN, so putPublic throws.
      // Stand in for the store's reply so the dashboard side is still exercised;
      // the real store is covered by Task 15 when the token is set.
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ id: crypto.randomUUID(), marina_id: marinaId, url: `data:image/png;base64,${TINY_PNG_B64}`, description: 'Pontoon view', sort_order: 0, status: 'active' }),
      });
    });
    await openTab(page, 'images');

    // Over the limit: refused in the browser before any upload.
    let posts = 0;
    page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/images/upload')) posts++; });
    await page.locator('#images-upload-input').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await expect(page.locator('.toast--error').last()).toContainText('Images are limited to 4 MB');
    expect(posts).toBe(0);

    await page.locator('#images-upload-desc').fill('Pontoon view');
    const [uploaded] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes(`/api/marina/marinas/${marinaId}/images/upload`)),
      page.locator('#images-upload-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_B64, 'base64') }),
    ]);
    expect(uploaded.status()).toBe(201);
    const row = await uploaded.json();
    const tr = page.locator(`#images-body tr[data-id="${row.id}"]`);
    await expect(tr.locator('img.marina-thumb')).toHaveAttribute('src', row.url);
    await expect(tr.locator('input[data-field="description"]')).toHaveValue('Pontoon view');
  });

  test('a POI round-trips after reload', async ({ page }) => {
    await openTab(page, 'pois');
    const [created] = await Promise.all([page.waitForResponse(isPost('pois')), page.locator('#poi-add-btn').click()]);
    expect(created.status()).toBe(201);
    poiId = (await created.json()).id;
    const tr = page.locator(`#pois-body tr[data-id="${poiId}"]`);

    for (const [field, value] of [['label', 'Fuel dock'], ['type', 'fuel'], ['lat', '43.6301'], ['lng', '7.0152']] as const) {
      const input = tr.locator(`input[data-field="${field}"]`);
      await input.fill(value);
      const [saved] = await Promise.all([page.waitForResponse(isPut('pois')), input.blur()]);
      expect(saved.ok()).toBeTruthy();
    }

    await openTab(page, 'pois');
    const after = page.locator(`#pois-body tr[data-id="${poiId}"]`);
    await expect(after.locator('input[data-field="label"]')).toHaveValue('Fuel dock');
    await expect(after.locator('input[data-field="type"]')).toHaveValue('fuel');
    await expect(after.locator('input[data-field="lat"]')).toHaveValue('43.6301');
    await expect(after.locator('input[data-field="lng"]')).toHaveValue('7.0152');
  });

  test('deactivate and reactivate a POI', async ({ page }) => {
    expect(poiId).toBeTruthy();
    await openTab(page, 'pois');
    const tr = page.locator(`#pois-body tr[data-id="${poiId}"]`);
    await Promise.all([page.waitForResponse(isPut('pois')), tr.locator('.deactivate-btn').click()]);
    await expect(tr).toHaveClass(/is-inactive/);

    // Still listed after a reload: the tab asks for inactive rows too.
    await openTab(page, 'pois');
    await expect(tr).toHaveClass(/is-inactive/);
    await Promise.all([page.waitForResponse(isPut('pois')), tr.locator('.reactivate-btn').click()]);
    await expect(tr).not.toHaveClass(/is-inactive/);
    await expect(tr.locator('.deactivate-btn')).toBeVisible();
  });
});
```

- [ ] **Step 6: Run the new tests and see them fail**

Start the local stack: OTA with `cd C:/Users/robert/source/repos/OTA && npm run dev`, and the dashboard with `cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background` on port 4335.

Run: `npx playwright test tests/marina-setup.spec.ts -g "requirements, templates, POIs, images"`

Expected: FAIL. `setup` passes and the first new test fails: it waits in `openTab` for a `GET …/<kind>?include_inactive=1` that the page never sends, so it reports `Test timeout of 45000ms exceeded.` (`page.waitForResponse`). The block is `describe.serial`, so the other four are not run. The summary reads `1 failed`, `4 did not run`, `1 passed`.

- [ ] **Step 7: marina-setup.astro — four panels**

If Task 7 rendered tab buttons for only some tabs, add buttons for the missing values among `doc-requirements`, `contract-templates`, `pois` and `images`, after the `data-setup-target="price-tiers"` button. Copy that button's attributes. Labels are `Requirements`, `Contract templates`, `POIs` and `Images`. Each value must appear exactly once.

Insert these panels immediately after the closing tag of the `data-setup-tab="price-tiers"` panel (Task 8), as its siblings. If Task 7 left empty placeholder panels for these four values, delete them.
```astro
<section data-setup-tab="doc-requirements" hidden>
  <p><button id="doc-requirement-add-btn" type="button">+ New requirement</button></p>
  <table id="doc-requirements-table">
    <thead>
      <tr>
        <th>Type</th>
        <th>Name</th>
        <th class="col-grow">Description</th>
        <th class="col-narrow">Mandatory</th>
        <th class="col-narrow">Order</th>
        <th class="col-grow">Fields (one per line: name | label | type)</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody id="doc-requirements-body"></tbody>
  </table>
</section>

<section data-setup-tab="contract-templates" hidden>
  <p><button id="contract-template-add-btn" type="button">+ New template</button></p>
  <table id="contract-templates-table">
    <thead>
      <tr>
        <th>Name</th>
        <th class="col-narrow">Min nights</th>
        <th class="col-grow">Contract (Markdown)</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody id="contract-templates-body"></tbody>
  </table>
</section>

<section data-setup-tab="pois" hidden>
  <p><button id="poi-add-btn" type="button">+ New point</button></p>
  <table id="pois-table">
    <thead>
      <tr>
        <th>Label</th>
        <th>Type</th>
        <th class="col-narrow">Latitude</th>
        <th class="col-narrow">Longitude</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody id="pois-body"></tbody>
  </table>
</section>

<section data-setup-tab="images" hidden>
  <p>
    <label>Description <input type="text" id="images-upload-desc" maxlength="500" /></label>
    <label>Photo (JPEG or PNG, up to 4 MB) <input type="file" id="images-upload-input" accept="image/jpeg,image/png" /></label>
  </p>
  <table id="images-table">
    <thead>
      <tr>
        <th class="col-narrow">Image</th>
        <th class="col-grow">Description</th>
        <th class="col-narrow">Order</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody id="images-body"></tbody>
  </table>
</section>
```

- [ ] **Step 8: global.css — textareas in cells and thumbnails**

Append to the end of `D/src/styles/global.css`:
```css
/* Marina setup lists: textareas fill their cell like `td input` does, and
   thumbnails share one crop so rows line up. */
td textarea {
  width: 100%;
  min-width: 16ch;
  resize: vertical;
}

.marina-thumb {
  display: block;
  width: 96px;
  height: 64px;
  object-fit: cover;
  border-radius: 6px;
}
```

- [ ] **Step 9: marina-setup-client.ts — the four tabs**

Merge into the existing import lines at the top of `D/src/scripts/marina-setup-client.ts`, keeping every name Tasks 7–8 already import, so that they include:
```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { loadMarinas } from './sidebar-modules-widget';
import { MARINA_STORAGE_KEY, pickMarina, fieldsToLines, linesToFields } from '../lib/marina-logic';
```
Append to the end of the file:
```ts
// ---- Requirements, contract templates, POIs, images ----
// One table-driven renderer for the four flat catalogue lists: each row's
// inputs autosave one column at a time with PUT (restaurant Tables pattern),
// and the list asks for inactive rows too so they can be reactivated.

type SetupKind = 'doc-requirements' | 'contract-templates' | 'pois' | 'images';
interface SetupCol {
  key: string;
  label: string;
  input: 'text' | 'number' | 'checkbox' | 'textarea' | 'fields';
  // NOT NULL in OTA: a blank value is put back rather than sent
  required?: boolean;
  attrs?: string;
}
interface SetupList { kind: SetupKind; bodyId: string; nameKey: string; noun: string; title: string; cols: SetupCol[]; thumb?: boolean }

const DOC_REQUIREMENTS: SetupList = {
  kind: 'doc-requirements', bodyId: 'doc-requirements-body', nameKey: 'name', noun: 'Requirement', title: 'document requirements',
  cols: [
    { key: 'type', label: 'Type', input: 'text', required: true, attrs: 'maxlength="30"' },
    { key: 'name', label: 'Name', input: 'text', required: true, attrs: 'maxlength="100"' },
    { key: 'description', label: 'Description', input: 'textarea', attrs: 'rows="3"' },
    { key: 'mandatory', label: 'Mandatory', input: 'checkbox' },
    { key: 'sort_order', label: 'Order', input: 'number', required: true, attrs: 'step="1"' },
    { key: 'fields', label: 'Fields', input: 'fields', attrs: 'rows="3" placeholder="policy_number | Policy number | text"' },
  ],
};
const CONTRACT_TEMPLATES: SetupList = {
  kind: 'contract-templates', bodyId: 'contract-templates-body', nameKey: 'name', noun: 'Template', title: 'contract templates',
  cols: [
    { key: 'name', label: 'Name', input: 'text', required: true, attrs: 'maxlength="100"' },
    { key: 'min_nights', label: 'Min nights', input: 'number', required: true, attrs: 'min="0" step="1"' },
    { key: 'body_markdown', label: 'Contract', input: 'textarea', required: true, attrs: 'rows="8"' },
  ],
};
const POIS: SetupList = {
  kind: 'pois', bodyId: 'pois-body', nameKey: 'label', noun: 'Point', title: 'points of interest',
  cols: [
    { key: 'label', label: 'Label', input: 'text', required: true, attrs: 'maxlength="100"' },
    { key: 'type', label: 'Type', input: 'text', attrs: 'maxlength="30"' },
    { key: 'lat', label: 'Latitude', input: 'number', required: true, attrs: 'step="any"' },
    { key: 'lng', label: 'Longitude', input: 'number', required: true, attrs: 'step="any"' },
  ],
};
const IMAGES: SetupList = {
  kind: 'images', bodyId: 'images-body', nameKey: 'description', noun: 'Image', title: 'images', thumb: true,
  cols: [
    { key: 'description', label: 'Description', input: 'text' },
    { key: 'sort_order', label: 'Order', input: 'number', required: true, attrs: 'step="1"' },
  ],
};
const SETUP_LISTS = [DOC_REQUIREMENTS, CONTRACT_TEMPLATES, POIS, IMAGES];

// OTA's raw-body limit. Checking it here fails fast instead of sending 4 MB
// just to be refused.
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

let setupListMarinaId = '';
// Per-list load counter: only the newest load renders, so a quick marina
// switch can't leave one marina's rows under another.
const setupListSeq: Record<string, number> = {};

type SetupInput = HTMLInputElement | HTMLTextAreaElement;

function setupListIdent(list: SetupList, tr: HTMLElement): string {
  return tr.querySelector<SetupInput>(`[data-field="${list.nameKey}"]`)?.value.trim() || list.noun;
}

function warnUnknownPlaceholders(ident: string, row: any) {
  const unknown = row?.warnings?.unknown_placeholders;
  if (Array.isArray(unknown) && unknown.length) {
    showToast(`${ident}: unknown placeholders will be left blank — ${unknown.map((p: string) => `{{${p}}}`).join(', ')}`, 'warning');
  }
}

function setupCell(col: SetupCol, row: Record<string, any>): string {
  const attrs = `data-field="${col.key}" aria-label="${escapeHtml(col.label)}" ${col.attrs ?? ''}`;
  if (col.input === 'checkbox') return `<td class="col-narrow"><input type="checkbox" ${attrs} ${row[col.key] ? 'checked' : ''} /></td>`;
  const text = col.input === 'fields' ? fieldsToLines(row[col.key]) : String(row[col.key] ?? '');
  if (col.input === 'textarea' || col.input === 'fields') {
    return `<td class="col-grow"><textarea ${attrs} data-saved="${escapeHtml(text)}">${escapeHtml(text)}</textarea></td>`;
  }
  return `<td><input type="${col.input}" ${attrs} value="${escapeHtml(text)}" data-saved="${escapeHtml(text)}" /></td>`;
}

function setupListRow(list: SetupList, marinaId: string, row: Record<string, any>): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.id = row.id;
  const inactive = row.status === 'inactive';
  tr.classList.toggle('is-inactive', inactive);
  tr.innerHTML = `
    ${list.thumb ? `<td class="col-narrow"><img class="marina-thumb" src="${escapeHtml(row.url)}" alt="${escapeHtml(row.description ?? '')}" loading="lazy" /></td>` : ''}
    ${list.cols.map((col) => setupCell(col, row)).join('')}
    <td class="col-actions"><div class="row-actions">${
      inactive
        ? '<button type="button" class="reactivate-btn">Reactivate</button>'
        : '<button type="button" class="deactivate-btn">Deactivate</button>'
    }</div></td>
  `;
  for (const col of list.cols) {
    const el = tr.querySelector<SetupInput>(`[data-field="${col.key}"]`)!;
    el.addEventListener('change', () => void saveSetupListField(list, marinaId, tr, col, el));
  }
  tr.querySelector('.deactivate-btn')?.addEventListener('click', () => void setSetupListStatus(list, marinaId, tr, 'inactive'));
  tr.querySelector('.reactivate-btn')?.addEventListener('click', () => void setSetupListStatus(list, marinaId, tr, 'active'));
  return tr;
}

async function saveSetupListField(list: SetupList, marinaId: string, tr: HTMLTableRowElement, col: SetupCol, el: SetupInput) {
  const ident = setupListIdent(list, tr);
  if (col.required && !el.value.trim()) {
    el.value = el.dataset.saved ?? '';
    showToast(`${ident}: ${col.label} is required`, 'error');
    return;
  }
  let value: unknown;
  try {
    // '' and numeric strings go as typed: OTA reads '' as null and casts numbers.
    value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : col.input === 'fields' ? linesToFields(el.value) : el.value;
  } catch (err) {
    showToast(`${ident}: ${(err as Error).message}`, 'error');
    return;
  }
  el.disabled = true;
  try {
    const res = await apiFetch(`/api/marina/marinas/${marinaId}/${list.kind}/${tr.dataset.id}`, {
      method: 'PUT',
      body: JSON.stringify({ [col.key]: value }),
      signal: AbortSignal.timeout(15000),
    });
    const updated = await res.json().catch(() => null);
    if (!res.ok || !updated || typeof updated !== 'object') {
      showToast(`${ident}: Failed to save ${col.label} — ${updated?.error ?? 'unknown error'}`, 'error');
      return;
    }
    showToast(`${setupListIdent(list, tr)}: ${col.label} saved`, 'success');
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      el.checked = !!updated[col.key];
    } else {
      const text = col.input === 'fields' ? fieldsToLines(updated[col.key]) : String(updated[col.key] ?? '');
      el.value = text;
      el.dataset.saved = text;
    }
    warnUnknownPlaceholders(setupListIdent(list, tr), updated);
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`${ident}: Failed to save ${col.label}`, 'error');
  } finally {
    el.disabled = false;
  }
}

async function setSetupListStatus(list: SetupList, marinaId: string, tr: HTMLTableRowElement, status: 'active' | 'inactive') {
  const ident = setupListIdent(list, tr);
  const verb = status === 'inactive' ? 'deactivate' : 'reactivate';
  try {
    const res = await apiFetch(`/api/marina/marinas/${marinaId}/${list.kind}/${tr.dataset.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(15000),
    });
    const updated = await res.json().catch(() => null);
    if (!res.ok || !updated?.id) {
      showToast(`${ident}: Failed to ${verb} — ${updated?.error ?? 'unknown error'}`, 'error');
      return;
    }
    tr.replaceWith(setupListRow(list, marinaId, updated));
    showToast(`${ident}: ${status === 'inactive' ? 'Deactivated' : 'Reactivated'}`, 'success');
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`${ident}: Failed to ${verb}`, 'error');
  }
}

async function loadSetupList(list: SetupList, marinaId: string) {
  const seq = (setupListSeq[list.kind] = (setupListSeq[list.kind] ?? 0) + 1);
  try {
    const res = await apiFetch(`/api/marina/marinas/${marinaId}/${list.kind}?include_inactive=1`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    if (seq !== setupListSeq[list.kind]) return;
    if (!res.ok || !Array.isArray(data)) {
      showToast(`Failed to load ${list.title} — ${data?.error ?? 'unknown error'}`, 'error');
      return;
    }
    document.getElementById(list.bodyId)!.replaceChildren(...data.map((row) => setupListRow(list, marinaId, row)));
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`Failed to load ${list.title}`, 'error');
  }
}

function loadSetupLists(marinaId: string) {
  setupListMarinaId = marinaId;
  for (const list of SETUP_LISTS) void loadSetupList(list, marinaId);
}

async function addSetupListRow(list: SetupList, body: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
  const marinaId = setupListMarinaId;
  if (!marinaId) {
    showToast('Add a marina in Settings first', 'error');
    return;
  }
  try {
    const res = await apiFetch(`/api/marina/marinas/${marinaId}/${list.kind}`, {
      method: 'POST',
      body: JSON.stringify(await body()),
      signal: AbortSignal.timeout(15000),
    });
    const created = await res.json().catch(() => null);
    if (!res.ok || !created?.id) {
      showToast(`Failed to add ${list.noun.toLowerCase()} — ${created?.error ?? 'unknown error'}`, 'error');
      return;
    }
    if (marinaId !== setupListMarinaId) return;
    const tr = setupListRow(list, marinaId, created);
    document.getElementById(list.bodyId)!.appendChild(tr);
    warnUnknownPlaceholders(setupListIdent(list, tr), created);
    tr.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.select();
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`Failed to add ${list.noun.toLowerCase()}`, 'error');
  }
}

async function uploadMarinaImage(input: HTMLInputElement) {
  const file = input.files?.[0];
  // Cleared now so picking the same file again still fires change.
  input.value = '';
  const marinaId = setupListMarinaId;
  if (!file || !marinaId) return;
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    showToast('Only JPEG or PNG images', 'error');
    return;
  }
  if (file.size > IMAGE_MAX_BYTES) {
    showToast('Images are limited to 4 MB', 'error');
    return;
  }
  const descInput = document.getElementById('images-upload-desc') as HTMLInputElement;
  const desc = descInput.value.trim();
  // fetch throws on a header value it can't send as bytes, such as an em
  // dash or emoji, so a non-ASCII caption goes in a follow-up PUT instead.
  const headerSafe = /^[\x20-\x7e]*$/.test(desc);
  input.disabled = true;
  try {
    const res = await apiFetch(`/api/marina/marinas/${marinaId}/images/upload`, {
      method: 'POST',
      headers: { 'Content-Type': file.type, ...(desc && headerSafe ? { 'X-Description': desc } : {}) },
      body: file,
      signal: AbortSignal.timeout(60000),
    });
    let row = await res.json().catch(() => null);
    if (!res.ok || !row?.id) {
      showToast(`${file.name}: Upload failed — ${row?.error ?? 'unknown error'}`, 'error');
      return;
    }
    if (desc && !headerSafe) {
      const put = await apiFetch(`/api/marina/marinas/${marinaId}/images/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify({ description: desc }),
        signal: AbortSignal.timeout(15000),
      });
      const updated = await put.json().catch(() => null);
      if (put.ok && updated?.id) row = updated;
      else showToast(`${file.name}: Uploaded, but the description wasn't saved — ${updated?.error ?? 'unknown error'}`, 'error');
    }
    descInput.value = '';
    if (marinaId === setupListMarinaId) document.getElementById(IMAGES.bodyId)!.appendChild(setupListRow(IMAGES, marinaId, row));
    showToast(`${file.name}: Uploaded`, 'success');
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast(`${file.name}: Upload failed`, 'error');
  } finally {
    input.disabled = false;
  }
}

// Listeners before the await, as elsewhere in the dashboard.
document.getElementById('marina-setup-select')!.addEventListener('change', (e) => loadSetupLists((e.target as HTMLSelectElement).value));
document.getElementById('doc-requirement-add-btn')!.addEventListener('click', () =>
  void addSetupListRow(DOC_REQUIREMENTS, () => ({ type: 'document', name: 'New requirement', fields: [] })),
);
document.getElementById('contract-template-add-btn')!.addEventListener('click', () =>
  // Known merge fields only, so a fresh template saves without a warning.
  void addSetupListRow(CONTRACT_TEMPLATES, () => ({
    name: 'New template',
    body_markdown: 'I, {{sailor_name}}, agree to the terms of {{marina_name}} for berth {{berth_id}} from {{arrival_date}} to {{departure_date}}.',
  })),
);
document.getElementById('poi-add-btn')!.addEventListener('click', () =>
  // Starts at the marina's own position so the new point lands on the map.
  void addSetupListRow(POIS, async () => {
    const m = (await loadMarinas()).find((x) => x.id === setupListMarinaId);
    return { label: 'New point', type: 'other', lat: m?.lat ?? 0, lng: m?.lng ?? 0 };
  }),
);
const imagesUploadInput = document.getElementById('images-upload-input') as HTMLInputElement;
imagesUploadInput.addEventListener('change', () => void uploadMarinaImage(imagesUploadInput));

// The same initial choice Task 7 makes for #marina-setup-select (setting a
// select's value in code fires no change event).
const firstSetupMarina = pickMarina(await loadMarinas(), localStorage.getItem(MARINA_STORAGE_KEY));
if (firstSetupMarina) loadSetupLists(firstSetupMarina.id);
```

- [ ] **Step 10: Gates — check script and build**

Run: `node scripts/check-marina.ts`

Expected: `check-marina: ok`

Run: `npm run build`

Expected: exit 0. The log ends with `[build] Complete!` and shows no `error` lines.

- [ ] **Step 11: Run the Playwright spec**

Run: `npx playwright test tests/marina-setup.spec.ts -g "requirements, templates, POIs, images"`

Expected: PASS, `6 passed` (setup plus the five new tests).

Run: `npx playwright test tests/marina-setup.spec.ts`

Expected: PASS. Every test passes, including Tasks 7–8's, with `0 failed`.

- [ ] **Step 12: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/pages/marina-setup.astro src/scripts/marina-setup-client.ts src/styles/global.css tests/marina-setup.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: requirements, contract templates, POIs and images" -m "Four more /marina-setup tabs on one table-driven autosave list that also lists inactive rows (?include_inactive=1) so they can be reactivated. Requirement fields are edited as 'name | label | type' lines (fieldsToLines/linesToFields, checked in check-marina.ts); a bad line is toasted and nothing is sent. Contract template saves toast OTA's warnings.unknown_placeholders. Images upload raw to OTA's public store, with a 4 MB guard in the browser and OTA's 413 shown as-is." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Do not push. Deploying the dashboard is a later runbook step.

---

### Task 10: Dashboard — /marina-bookings table, filters, paging, staff create

Staff get a full list of berth bookings. They can filter it by status, marina, berth and date range, and the filter state is kept in the URL. The list shows 50 rows per page, with prev/next driven by OTA's `{total, data}`. Staff can also create a booking from a dialog. This task covers R23 (table, filters, paging, staff create) and R28 (status and payment pills that reuse existing colour mixes). Row actions, the detail dialog and live refresh come later (Tasks 11–12). They plug into this task's `filter`, `rows`, `loadBookings()` and `rowHtml()`.

Repo `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`.

**Files:**
- Modify: `D/scripts/check-marina.ts` (created in Task 5, extended by Tasks 6–9):
  - Add one import line directly below the existing `import { … } from '../src/lib/marina-logic.ts';` line.
  - Insert two `// ---- … ----` blocks immediately before the last line, `console.log('check-marina: ok');`.
- Modify: `D/src/lib/marina-logic.ts`. Append after the last line, which is Task 9's `linesToFields`. Nothing above it changes.
- Modify: `D/src/styles/global.css`. Append at the end of the file (after Task 6's `.is-inactive` rules). Nothing above it changes.
- Modify: `D/tests/marina-helpers.ts`. Append `createBookingViaUi` at the end of the file (after Task 7's `importBerthsCsvViaUi`). It uses only the `Page` type the file already imports.
- Create: `D/tests/marina-bookings.spec.ts`
- Create: `D/src/pages/marina-bookings.astro`
- Create: `D/src/scripts/marina-bookings-client.ts`

**Interfaces:**
- Consumes:
  - Task 1 (O): `GET /api/marina/marinas/:marina_id/berths?include_inactive=1` returns every status. Without the param it returns active + maintenance (OTA's default `listWhere` excludes only `inactive`).
  - Task 1 (O): staff `POST /api/marina/bookings` returns 400 `contact_phone must be up to 30 characters`.
  - Existing OTA routes:
    - `GET /api/marina/bookings?status&marina_id&berth_id&from&to&limit&offset` returns `{ total, data: StaffBookingRow[] }`. Holds are excluded. `from` matches `departure IS NULL OR departure > from` and `to` matches `arrival < to`.
    - `POST /api/marina/bookings` returns 201 with the joined row. It returns 409 `{error:'That berth is already booked for those dates'}` on overlap, 404 `Berth not found`, and 400s such as `departure must be YYYY-MM-DD after arrival, or null for open-ended`.
  - Task 5:
    - `loadMarinas(): Promise<MarinaRow[]>` from `D/src/scripts/sidebar-modules-widget.ts`.
    - `MarinaRow` and `StaffBookingRow` from `D/src/lib/marina-logic.ts`.
    - `D/scripts/check-marina.ts`, ending `console.log('check-marina: ok');`.
  - Task 6, `D/tests/marina-helpers.ts`: `uniqueSlug(prefix?)`, `createMarinaViaUi(page, { name, slug }): Promise<string>`, `deactivateMarinaViaUi(page, id)`.
  - Task 7: `importBerthsCsvViaUi(page, marinaId, csv): Promise<void>`.
  - Task 8: `propertyToday(timeZone, now?)` and `addDays(ymd, n)` from `marina-logic.ts`.
  - D: `apiFetch` and `escapeHtml` (`src/scripts/api-client.ts`), `showToast` (`src/scripts/toast.ts`).
- Produces:
  ```ts
  // D/src/lib/marina-logic.ts
  export const PAGE_SIZE = 50;
  export interface BookingFilter { status: '' | 'pending' | 'confirmed' | 'declined' | 'cancelled'; marina_id: string; berth_id: string; from: string; to: string; offset: number; }
  export function bookingsQuery(f: BookingFilter): string;
  export function statusPillHtml(status: string): string;
  export function paymentPillHtml(status: string): string;
  // D/tests/marina-helpers.ts
  export async function createBookingViaUi(page: Page, opts: { marinaId: string; berthLabel: string; arrival: string; departure: string | null; status: 'pending' | 'confirmed'; contactName: string; contactEmail?: string; locale?: 'en' | 'it' | 'fr' | 'es' }): Promise<string>;
  //   throws Error(`create booking: <status> <OTA error>`) when the POST is not 201 (the dialog stays open, OTA's error is toasted)
  ```
  - DOM ids on `/marina-bookings`:
    - filters: `#mb-status`, `#mb-marina`, `#mb-berth`, `#mb-from`, `#mb-to`
    - table rows: `#marina-bookings-body tr[data-id]`, with `.marina-pill[data-status]` and `.marina-pay[data-status]` cells
    - paging: `#mb-prev`, `#mb-next`, `#mb-page-info`
    - create: `#mb-add-btn`, `#mb-create-dialog` and every `#mb-create-*` id listed in the contract
  - CSS: `.marina-pill[data-status]` and `.marina-pay[data-status]`.
  - Module state in `marina-bookings-client.ts` that Tasks 11–12 extend: `let filter: BookingFilter`, `let rows: StaffBookingRow[]`, `let total`, `loadBookings()` (steps back from a page past the end), `renderTable()`, `rowHtml(b)` whose last cell is `<td class="col-actions"></td>` under a `<th class="col-actions">Actions</th>` header (Task 11 fills it).

- [ ] **Step 1: Write the failing check**

In `D/scripts/check-marina.ts`, insert this line directly below the existing `import { … } from '../src/lib/marina-logic.ts';` line. It is a second import of the same module, so this edit doesn't depend on how Tasks 5–9 left the first one.

```ts
import { PAGE_SIZE, bookingsQuery, paymentPillHtml, statusPillHtml } from '../src/lib/marina-logic.ts';
```

Insert immediately before the last line `console.log('check-marina: ok');`:

```ts
// ---- bookingsQuery ----
{
  assert.equal(PAGE_SIZE, 50);
  const none = { status: '', marina_id: '', berth_id: '', from: '', to: '', offset: 0 } as const;
  // Nothing set: no empty params, but the page window is always explicit
  // (OTA's own default limit is 100, not a page).
  assert.equal(bookingsQuery(none), '?limit=50&offset=0');
  assert.equal(
    bookingsQuery({ status: 'pending', marina_id: 'm-1', berth_id: 'b-1', from: '2026-10-01', to: '2026-11-01', offset: 100 }),
    '?status=pending&marina_id=m-1&berth_id=b-1&from=2026-10-01&to=2026-11-01&limit=50&offset=100',
  );
  assert.equal(bookingsQuery({ ...none, to: '2026-11-01', offset: 50 }), '?to=2026-11-01&limit=50&offset=50');
  assert.equal(bookingsQuery({ ...none, status: 'cancelled', berth_id: 'b-2' }), '?status=cancelled&berth_id=b-2&limit=50&offset=0');
}

// ---- statusPillHtml / paymentPillHtml ----
{
  const statusPill = (s: string, label: string) => `<span class="marina-pill" data-status="${s}">${label}</span>`;
  const payPill = (s: string, label: string) => `<span class="marina-pay" data-status="${s}">${label}</span>`;
  assert.equal(statusPillHtml('hold'), statusPill('hold', 'Hold'));
  assert.equal(statusPillHtml('pending'), statusPill('pending', 'Pending'));
  assert.equal(statusPillHtml('confirmed'), statusPill('confirmed', 'Confirmed'));
  assert.equal(statusPillHtml('declined'), statusPill('declined', 'Declined'));
  assert.equal(statusPillHtml('cancelled'), statusPill('cancelled', 'Cancelled'));
  assert.equal(paymentPillHtml('none'), payPill('none', 'No payment'));
  assert.equal(paymentPillHtml('held'), payPill('held', 'Card held'));
  assert.equal(paymentPillHtml('captured'), payPill('captured', 'Paid'));
  assert.equal(paymentPillHtml('released'), payPill('released', 'Released'));
  assert.equal(paymentPillHtml('refunded'), payPill('refunded', 'Refunded'));
  // Unknown values (a newer OTA status, a prototype key, a hostile Ably
  // payload) render the fixed 'Unknown' pill; the input never reaches markup.
  const evil = '"><img src=x onerror=alert(1)>';
  for (const bad of [evil, 'constructor', '__proto__', '', 'Pending']) {
    assert.equal(statusPillHtml(bad), statusPill('unknown', 'Unknown'));
    assert.equal(paymentPillHtml(bad), payPill('unknown', 'Unknown'));
  }
  assert.ok(!statusPillHtml(evil).includes('onerror') && !paymentPillHtml(evil).includes('<img'));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: a non-zero exit with
```
SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'PAGE_SIZE'
```

- [ ] **Step 3: Implement in `marina-logic.ts`**

Append to `D/src/lib/marina-logic.ts`:

```ts

// ---- Task 10: /marina-bookings ----

export const PAGE_SIZE = 50;

export interface BookingFilter {
  status: '' | 'pending' | 'confirmed' | 'declined' | 'cancelled';
  marina_id: string;
  berth_id: string;
  from: string;
  to: string;
  offset: number;
}

// Blank filters are left out so OTA applies none. limit/offset are always
// sent: OTA's default limit is 100, and the pager's "Page N of M" assumes
// exactly PAGE_SIZE rows per page.
export function bookingsQuery(f: BookingFilter): string {
  const p = new URLSearchParams();
  for (const k of ['status', 'marina_id', 'berth_id', 'from', 'to'] as const) if (f[k]) p.set(k, f[k]);
  p.set('limit', String(PAGE_SIZE));
  p.set('offset', String(f.offset));
  return `?${p}`;
}

const STATUS_LABELS: Record<string, string> = {
  hold: 'Hold', pending: 'Pending', confirmed: 'Confirmed', declined: 'Declined', cancelled: 'Cancelled',
};
const PAYMENT_LABELS: Record<string, string> = {
  none: 'No payment', held: 'Card held', captured: 'Paid', released: 'Released', refunded: 'Refunded',
};

// These strings go into innerHTML, and the status comes from OTA or an Ably
// payload. Only whitelisted keys and labels are emitted: an unknown value
// becomes 'unknown'/'Unknown' rather than being echoed (even escaped).
// Object.hasOwn keeps 'constructor' and '__proto__' out.
function pill(cls: string, labels: Record<string, string>, status: string): string {
  const key = Object.hasOwn(labels, status) ? status : 'unknown';
  return `<span class="${cls}" data-status="${key}">${labels[key] ?? 'Unknown'}</span>`;
}

export function statusPillHtml(status: string): string {
  return pill('marina-pill', STATUS_LABELS, status);
}

export function paymentPillHtml(status: string): string {
  return pill('marina-pay', PAYMENT_LABELS, status);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: exit 0, last line `check-marina: ok`.

- [ ] **Step 5: Pill styles**

Append to `D/src/styles/global.css`:

```css

/* ── Marina bookings (/marina-bookings) status + payment pills ──
   Same badge shape and colour mixes as .reservation-status /
   .reservation-payment-status (no new percentages): amber = waiting on
   someone, green = settled, red = ended, blue = money moved back,
   muted = nothing to show (none / unknown). */
.marina-pill,
.marina-pay {
  display: inline-block;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  text-transform: uppercase;
  font-weight: 600;
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: var(--muted);
  background: color-mix(in srgb, currentColor 8%, transparent);
}

/* inline-block is author origin and beats the UA [hidden] rule -- same
   trap as .stat-tile[hidden]. */
.marina-pill[hidden],
.marina-pay[hidden] {
  display: none;
}

.marina-pill[data-status='pending'],
.marina-pay[data-status='held'] {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: #d97706;
}

.marina-pill[data-status='hold'],
.marina-pay[data-status='released'],
.marina-pay[data-status='refunded'] {
  background: color-mix(in srgb, #3b82f6 18%, transparent);
  color: #3b82f6;
}

.marina-pill[data-status='confirmed'],
.marina-pay[data-status='captured'] {
  background: color-mix(in srgb, #10b981 18%, transparent);
  color: #10b981;
}

.marina-pill[data-status='declined'],
.marina-pill[data-status='cancelled'] {
  background: color-mix(in srgb, #ef4444 18%, transparent);
  color: #ef4444;
}
```

- [ ] **Step 6: Playwright helper and spec (written before the page)**

Append to `D/tests/marina-helpers.ts`:

```ts

// Staff create through the /marina-bookings dialog. It opens the page
// already filtered to the marina (URL state), so the reload after the POST
// shows this marina's rows no matter how many other bookings the shared dev
// DB holds. A non-201 throws after OTA's error has been toasted, so a spec
// can assert on the toast (e.g. the 409 overlap).
export async function createBookingViaUi(
  page: Page,
  opts: {
    marinaId: string;
    berthLabel: string;
    arrival: string;
    departure: string | null;
    status: 'pending' | 'confirmed';
    contactName: string;
    contactEmail?: string;
    locale?: 'en' | 'it' | 'fr' | 'es';
  },
): Promise<string> {
  const listLoad = page.waitForResponse(
    (res) => res.request().method() === 'GET' && res.url().includes('/api/marina/bookings?'),
  );
  await page.goto(`/marina-bookings?marina_id=${opts.marinaId}`);
  await listLoad;

  await page.click('#mb-add-btn');
  await page.locator('#mb-create-dialog').waitFor();
  await page.selectOption('#mb-create-marina', opts.marinaId);
  // Berth options load per marina after the select changes.
  await page.locator('#mb-create-berth option', { hasText: opts.berthLabel }).first().waitFor({ state: 'attached' });
  await page.selectOption('#mb-create-berth', { label: opts.berthLabel });
  await page.fill('#mb-create-arrival', opts.arrival);
  if (opts.departure === null) await page.check('#mb-create-open-ended');
  else await page.fill('#mb-create-departure', opts.departure);
  await page.fill('#mb-create-name', opts.contactName);
  if (opts.contactEmail) await page.fill('#mb-create-email', opts.contactEmail);
  await page.selectOption('#mb-create-status', opts.status);
  await page.selectOption('#mb-create-locale', opts.locale ?? 'en');

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/marina/bookings')),
    page.click('#mb-create-dialog button[type="submit"]'),
  ]);
  const body = await res.json().catch(() => null);
  if (res.status() !== 201 || !body?.id) throw new Error(`create booking: ${res.status()} ${body?.error ?? ''}`);
  return body.id as string;
}
```

Create `D/tests/marina-bookings.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addDays, propertyToday } from '../src/lib/marina-logic';
import { createBookingViaUi, createMarinaViaUi, deactivateMarinaViaUi, importBerthsCsvViaUi, uniqueSlug } from './marina-helpers';

// One serial chain on a fresh marina with two berths. Every booking
// here lives on this marina, and the page is filtered to it, so row counts
// are exact even on the shared dev DB. OTA has no delete for bookings or
// marinas, so afterAll deactivates the marina (a fresh slug every run, since
// an inactive slug stays taken).
test.describe.serial('marina bookings table', () => {
  const slug = uniqueSlug('pw-mb');
  let marinaId = '';
  let start = '';
  let pendingId = '';
  let confirmedId = '';

  const waitForList = (page: Page) =>
    page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/api/marina/bookings?'));
  const body = (page: Page) => page.locator('#marina-bookings-body');

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      marinaId = await createMarinaViaUi(page, { name: `PW Bookings ${slug}`, slug });
      await importBerthsCsvViaUi(page, marinaId, 'label,length_m,price_per_night\nPW1,15,40\nPW2,15,40\n');
      // Dates follow the property's own day, never the test machine's clock.
      const me = page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/api/property/me'));
      await page.goto('/marina-bookings');
      const property = await (await me).json().catch(() => null);
      start = addDays(propertyToday(property?.timezone), 30);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  test('a staff-created pending booking shows a Pending pill', async ({ page }) => {
    pendingId = await createBookingViaUi(page, {
      marinaId, berthLabel: 'PW1', arrival: start, departure: addDays(start, 3),
      status: 'pending', contactName: `PW Pending ${slug}`, contactEmail: 'pw-pending@example.com',
    });
    const row = body(page).locator(`tr[data-id="${pendingId}"]`);
    await expect(row.locator('.marina-pill')).toHaveText('Pending');
    await expect(row.locator('.marina-pill')).toHaveAttribute('data-status', 'pending');
    await expect(row.locator('.marina-pay')).toHaveText('No payment');
    await expect(row).toContainText('PW1');
    await expect(row).toContainText(`PW Pending ${slug}`);
  });

  test('the status filter changes the rows', async ({ page }) => {
    confirmedId = await createBookingViaUi(page, {
      marinaId, berthLabel: 'PW2', arrival: start, departure: addDays(start, 2),
      status: 'confirmed', contactName: `PW Confirmed ${slug}`,
    });
    await expect(body(page).locator('tr[data-id]')).toHaveCount(2);

    const [pendingRes] = await Promise.all([waitForList(page), page.selectOption('#mb-status', 'pending')]);
    expect(pendingRes.url()).toContain('status=pending');
    await expect(page).toHaveURL(/status=pending/);
    await expect(body(page).locator('tr[data-id]')).toHaveCount(1);
    await expect(body(page).locator(`tr[data-id="${pendingId}"]`)).toHaveCount(1);

    await Promise.all([waitForList(page), page.selectOption('#mb-status', 'confirmed')]);
    await expect(body(page).locator('tr[data-id]')).toHaveCount(1);
    await expect(body(page).locator(`tr[data-id="${confirmedId}"]`)).toHaveCount(1);
    await expect(body(page).locator(`tr[data-id="${pendingId}"]`)).toHaveCount(0);
  });

  test("an open-ended confirmed booking shows 'Open-ended'", async ({ page }) => {
    const openId = await createBookingViaUi(page, {
      marinaId, berthLabel: 'PW2', arrival: addDays(start, 10), departure: null,
      status: 'confirmed', contactName: `PW Open ${slug}`, locale: 'it',
    });
    const row = body(page).locator(`tr[data-id="${openId}"]`);
    await expect(row.locator('td').nth(1)).toHaveText('Open-ended');
    await expect(row.locator('.marina-pill')).toHaveText('Confirmed');
  });

  test("an overlapping create shows OTA's 409 as a toast", async ({ page }) => {
    await expect(
      createBookingViaUi(page, {
        marinaId, berthLabel: 'PW2', arrival: addDays(start, 1), departure: addDays(start, 4),
        status: 'confirmed', contactName: `PW Overlap ${slug}`,
      }),
    ).rejects.toThrow('create booking: 409');
    await expect(page.locator('.toast--error').last()).toContainText('That berth is already booked for those dates');
    await expect(page.locator('#mb-create-dialog')).toBeVisible();
  });

  test('paging shows Page 1 of 1 with prev/next disabled', async ({ page }) => {
    const list = waitForList(page);
    await page.goto(`/marina-bookings?marina_id=${marinaId}`);
    const res = await list;
    expect(res.url()).toContain('limit=50&offset=0');
    expect((await res.json()).total).toBe(3);
    await expect(body(page).locator('tr[data-id]')).toHaveCount(3);
    await expect(page.locator('#mb-page-info')).toHaveText('Page 1 of 1');
    await expect(page.locator('#mb-prev')).toBeDisabled();
    await expect(page.locator('#mb-next')).toBeDisabled();
  });
});
```

- [ ] **Step 7: The page**

Create `D/src/pages/marina-bookings.astro`:

```astro
---
export const prerender = false;
import { Show } from '@clerk/astro/components';
import Layout from '../layouts/Layout.astro';
---
<Layout title="Marina Bookings — Table Bookings">
  <Show when="signed-in">
    <div class="page-header">
      <div class="page-header-title">
        <a class="icon-btn" href="/marina" title="Back to Marina">
          <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </a>
        <h1>Marina Bookings</h1>
      </div>
      <div class="page-header-actions">
        <select id="mb-status" aria-label="Status">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="declined">Declined</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select id="mb-marina" aria-label="Marina"><option value="">All marinas</option></select>
        <select id="mb-berth" aria-label="Berth" disabled><option value="">All berths</option></select>
        <!-- OTA's range semantics: from = still on the berth after this day
             (departure > from), to = arriving before this day (arrival < to). -->
        <input type="date" id="mb-from" aria-label="From" title="On a berth after" />
        <input type="date" id="mb-to" aria-label="To" title="Arriving before" />
        <button id="mb-add-btn" type="button"><svg class="btn-icon" viewBox="0 0 640 640"><path d="M160 144C151.2 144 144 151.2 144 160L144 480C144 488.8 151.2 496 160 496L480 496C488.8 496 496 488.8 496 480L496 160C496 151.2 488.8 144 480 144L160 144zM96 160C96 124.7 124.7 96 160 96L480 96C515.3 96 544 124.7 544 160L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 160zM296 408L296 344L232 344C218.7 344 208 333.3 208 320C208 306.7 218.7 296 232 296L296 296L296 232C296 218.7 306.7 208 320 208C333.3 208 344 218.7 344 232L344 296L408 296C421.3 296 432 306.7 432 320C432 333.3 421.3 344 408 344L344 344L344 408C344 421.3 333.3 432 320 432C306.7 432 296 421.3 296 408z"/></svg>Add</button>
      </div>
    </div>

    <table id="marina-bookings-table">
      <thead>
        <tr><th class="col-narrow">Arrival</th><th class="col-narrow">Departure</th><th class="col-narrow">Berth</th><th class="col-narrow">Marina</th><th class="col-grow">Contact</th><th>Boat</th><th class="col-narrow">Total</th><th class="col-narrow">Status</th><th class="col-narrow">Payment</th><th class="col-actions">Actions</th></tr>
      </thead>
      <tbody id="marina-bookings-body"></tbody>
    </table>

    <div class="mb-paging">
      <button id="mb-prev" type="button" disabled>Previous</button>
      <span id="mb-page-info">Page 1 of 1</span>
      <button id="mb-next" type="button" disabled>Next</button>
    </div>

    <dialog id="mb-create-dialog" class="list-dialog">
      <div class="list-dialog-header"><h2>New berth booking</h2></div>
      <form id="mb-create-form" class="slots-bulk-form">
        <label>
          Marina
          <select id="mb-create-marina" required></select>
        </label>
        <label>
          Berth
          <select id="mb-create-berth" required></select>
        </label>
        <label>
          Arrival
          <input type="date" id="mb-create-arrival" required />
        </label>
        <label>
          Departure
          <input type="date" id="mb-create-departure" required />
        </label>
        <label>
          Open-ended
          <input type="checkbox" id="mb-create-open-ended" />
        </label>
        <label>
          Contact name
          <input type="text" id="mb-create-name" maxlength="100" required />
        </label>
        <label>
          Email
          <input type="email" id="mb-create-email" maxlength="255" />
        </label>
        <label>
          Phone
          <input type="tel" id="mb-create-phone" maxlength="30" />
        </label>
        <label>
          Boat name
          <input type="text" id="mb-create-boat" maxlength="100" />
        </label>
        <label>
          Length (m)
          <input type="number" id="mb-create-length" min="0" max="9999" step="0.01" />
        </label>
        <label>
          Beam (m)
          <input type="number" id="mb-create-beam" min="0" max="9999" step="0.01" />
        </label>
        <label>
          Total
          <input type="number" id="mb-create-total" min="0" step="0.01" placeholder="Priced automatically" />
        </label>
        <label>
          Status
          <select id="mb-create-status">
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
          </select>
        </label>
        <label>
          Guest language
          <select id="mb-create-locale">
            <option value="en">English</option>
            <option value="it">Italiano</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
          </select>
        </label>
        <div class="list-dialog-footer">
          <button id="mb-create-cancel-btn" type="button">Cancel</button>
          <button type="submit">Create</button>
        </div>
      </form>
    </dialog>

    <script src="../scripts/marina-bookings-client.ts"></script>
  </Show>
</Layout>

<style>
  /* Five filters plus Add don't fit one row on a laptop. */
  .page-header-actions {
    flex-wrap: wrap;
  }

  /* Rows are built in marina-bookings-client.ts, outside this component's
     scope. Contact (col-grow) takes the slack. */
  #marina-bookings-table :global(td) {
    white-space: nowrap;
  }

  .mb-paging {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 1rem;
    margin-top: 1rem;
  }
</style>
```

- [ ] **Step 8: The client script**

Create `D/src/scripts/marina-bookings-client.ts`:

```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { loadMarinas } from './sidebar-modules-widget';
import {
  PAGE_SIZE,
  bookingsQuery,
  paymentPillHtml,
  statusPillHtml,
  type BookingFilter,
  type MarinaRow,
  type StaffBookingRow,
} from '../lib/marina-logic';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusSelect = byId<HTMLSelectElement>('mb-status');
const marinaSelect = byId<HTMLSelectElement>('mb-marina');
const berthSelect = byId<HTMLSelectElement>('mb-berth');
const fromInput = byId<HTMLInputElement>('mb-from');
const toInput = byId<HTMLInputElement>('mb-to');
const prevBtn = byId<HTMLButtonElement>('mb-prev');
const nextBtn = byId<HTMLButtonElement>('mb-next');
const pageInfo = byId<HTMLElement>('mb-page-info');

const STATUSES: readonly string[] = ['pending', 'confirmed', 'declined', 'cancelled'];
const FILTER_KEYS = ['status', 'marina_id', 'berth_id', 'from', 'to'] as const;

let filter: BookingFilter = { status: '', marina_id: '', berth_id: '', from: '', to: '', offset: 0 };
let rows: StaffBookingRow[] = [];
let total = 0;
let loadSeq = 0;

type BerthOption = { id: string; label: string; status: string };

// A YYYY-MM-DD parsed with new Date() is UTC midnight, which shows as the
// previous day west of Greenwich. Building it from parts keeps the booking's
// own calendar day (same as marina-client.ts's formatDate).
function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatMoney(amount: string | null, currency: string | null): string {
  if (amount == null) return '—';
  if (!currency) return Number(amount).toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    return Number(amount).toFixed(2); // an unknown ISO code throws a RangeError
  }
}

function rowHtml(b: StaffBookingRow): string {
  const contact = [b.contact_email, b.contact_phone].filter(Boolean).join(' · ');
  const boat = [b.boat_name, b.boat_length_m ? `${Number(b.boat_length_m)} m` : ''].filter(Boolean).join(' · ');
  return `
    <td>${escapeHtml(formatDate(b.arrival))}</td>
    <td>${b.departure ? escapeHtml(formatDate(b.departure)) : 'Open-ended'}</td>
    <td>${escapeHtml(b.berth_label)}</td>
    <td>${escapeHtml(b.marina_name)}</td>
    <td class="contact" title="${escapeHtml(contact)}">${escapeHtml(b.contact_name)}</td>
    <td>${escapeHtml(boat)}</td>
    <td>${escapeHtml(formatMoney(b.total_price, b.currency))}</td>
    <td>${statusPillHtml(b.status)}</td>
    <td>${paymentPillHtml(b.payment_status)}</td>
    <td class="col-actions"></td>
  `;
}

function renderTable(): void {
  const tbody = byId<HTMLTableSectionElement>('marina-bookings-body');
  tbody.innerHTML = rows.length ? '' : '<tr><td colspan="10">No bookings match these filters.</td></tr>';
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = b.id;
    tr.innerHTML = rowHtml(b);
    tbody.appendChild(tr);
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  pageInfo.textContent = `Page ${Math.floor(filter.offset / PAGE_SIZE) + 1} of ${pages}`;
  prevBtn.disabled = filter.offset === 0;
  nextBtn.disabled = filter.offset + PAGE_SIZE >= total;
}

async function loadBookings(): Promise<void> {
  const seq = ++loadSeq;
  let res: Response;
  try {
    res = await apiFetch(`/api/marina/bookings${bookingsQuery(filter)}`, { cache: 'no-store' });
  } catch (err) {
    if (seq === loadSeq && !(err instanceof Error && err.message === 'Not authenticated')) showToast('Failed to load bookings', 'error');
    return;
  }
  const data = await res.json().catch(() => null);
  if (seq !== loadSeq) return; // a newer filter or page change owns the table now
  if (!res.ok) {
    showToast(`Failed to load bookings — ${data?.error ?? 'unknown error'}`, 'error');
    return;
  }
  total = Number(data?.total) || 0;
  rows = Array.isArray(data?.data) ? data.data : [];
  // A page past the end (a stale ?offset= link, or the last row of the last
  // page cancelled meanwhile) shows the last real page, not an empty table.
  if (!rows.length && total > 0 && filter.offset > 0) {
    filter.offset = Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
    return loadBookings();
  }
  renderTable();
}

async function loadBerths(marinaId: string, includeInactive: boolean): Promise<BerthOption[]> {
  const qs = includeInactive ? '?include_inactive=1' : '';
  const res = await apiFetch(`/api/marina/marinas/${encodeURIComponent(marinaId)}/berths${qs}`, { cache: 'no-store' }).catch(() => null);
  const data = await res?.json().catch(() => null);
  return Array.isArray(data) ? data : [];
}

function berthOptionsHtml(berths: BerthOption[]): string {
  return berths
    .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.label)}${b.status === 'active' ? '' : ` (${escapeHtml(b.status)})`}</option>`)
    .join('');
}

function marinaOptionsHtml(marinas: MarinaRow[]): string {
  return marinas.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
}

// The filter lists inactive berths too: old bookings stay on a berth after
// it is retired, and staff still need to find them.
let berthFilterSeq = 0;
async function fillBerthFilter(marinaId: string, wanted: string): Promise<void> {
  const seq = ++berthFilterSeq;
  berthSelect.innerHTML = '<option value="">All berths</option>';
  berthSelect.disabled = !marinaId;
  if (!marinaId) return;
  const berths = await loadBerths(marinaId, true);
  if (seq !== berthFilterSeq) return;
  berthSelect.innerHTML += berthOptionsHtml(berths);
  berthSelect.value = berths.some((b) => b.id === wanted) ? wanted : '';
}

function filterFromUrl(): BookingFilter {
  const p = new URLSearchParams(window.location.search);
  const status = p.get('status') ?? '';
  const offset = Number.parseInt(p.get('offset') ?? '', 10);
  return {
    status: (STATUSES.includes(status) ? status : '') as BookingFilter['status'],
    marina_id: p.get('marina_id') ?? '',
    berth_id: p.get('berth_id') ?? '',
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    offset: offset > 0 ? offset - (offset % PAGE_SIZE) : 0,
  };
}

// The controls are the source of truth: a value the URL named but the
// selects or date inputs rejected reads back as ''.
function readFilter(offset: number): void {
  filter = {
    status: statusSelect.value as BookingFilter['status'],
    marina_id: marinaSelect.value,
    berth_id: berthSelect.value,
    from: fromInput.value,
    to: toInput.value,
    offset,
  };
}

function applyFilters(offset = 0): Promise<void> {
  readFilter(offset);
  const url = new URL(window.location.href);
  for (const k of FILTER_KEYS) {
    if (filter[k]) url.searchParams.set(k, filter[k]);
    else url.searchParams.delete(k);
  }
  if (filter.offset) url.searchParams.set('offset', String(filter.offset));
  else url.searchParams.delete('offset');
  history.pushState({}, '', url);
  return loadBookings();
}

async function init() {
  // Attach before the awaits below -- see reservations-client.ts's identical
  // comment for why (an await yields control back to the browser, and a
  // real interaction landing in that window would fire 'change' before a
  // later-attached listener exists).
  statusSelect.addEventListener('change', () => applyFilters());
  marinaSelect.addEventListener('change', () => {
    // Resets the berth select synchronously, so applyFilters reads berth ''.
    void fillBerthFilter(marinaSelect.value, '');
    applyFilters();
  });
  berthSelect.addEventListener('change', () => applyFilters());
  fromInput.addEventListener('change', () => applyFilters());
  toInput.addEventListener('change', () => applyFilters());
  prevBtn.addEventListener('click', () => applyFilters(Math.max(0, filter.offset - PAGE_SIZE)));
  nextBtn.addEventListener('click', () => applyFilters(filter.offset + PAGE_SIZE));

  const initial = filterFromUrl();
  statusSelect.value = initial.status;
  fromInput.value = initial.from;
  toInput.value = initial.to;

  const marinas = await loadMarinas();
  marinaSelect.innerHTML = '<option value="">All marinas</option>' + marinaOptionsHtml(marinas);
  marinaSelect.value = marinas.some((m) => m.id === initial.marina_id) ? initial.marina_id : '';
  await fillBerthFilter(marinaSelect.value, initial.berth_id);

  readFilter(initial.offset);
  await loadBookings();
}

init();

// ── Staff create dialog ───────────────────────────────────

const createDialog = byId<HTMLDialogElement>('mb-create-dialog');
const createForm = byId<HTMLFormElement>('mb-create-form');
const createMarina = byId<HTMLSelectElement>('mb-create-marina');
const createBerth = byId<HTMLSelectElement>('mb-create-berth');
const createArrival = byId<HTMLInputElement>('mb-create-arrival');
const createDeparture = byId<HTMLInputElement>('mb-create-departure');
const createOpenEnded = byId<HTMLInputElement>('mb-create-open-ended');
const createName = byId<HTMLInputElement>('mb-create-name');
const createEmail = byId<HTMLInputElement>('mb-create-email');
const createPhone = byId<HTMLInputElement>('mb-create-phone');
const createBoat = byId<HTMLInputElement>('mb-create-boat');
const createLength = byId<HTMLInputElement>('mb-create-length');
const createBeam = byId<HTMLInputElement>('mb-create-beam');
const createTotal = byId<HTMLInputElement>('mb-create-total');
const createStatus = byId<HTMLSelectElement>('mb-create-status');
const createLocale = byId<HTMLSelectElement>('mb-create-locale');

// Without include_inactive: OTA's default list (active + maintenance) is
// exactly what POST accepts. An inactive berth would 404.
let createBerthSeq = 0;
async function fillCreateBerths(marinaId: string): Promise<void> {
  const seq = ++createBerthSeq;
  createBerth.innerHTML = '<option value="">Loading…</option>';
  const berths = marinaId ? await loadBerths(marinaId, false) : [];
  if (seq !== createBerthSeq) return;
  createBerth.innerHTML = berths.length ? berthOptionsHtml(berths) : '<option value="">No berths at this marina</option>';
}

byId<HTMLButtonElement>('mb-add-btn').addEventListener('click', async () => {
  const marinas = await loadMarinas();
  if (!marinas.length) {
    showToast('Add a marina in Settings first', 'warning');
    return;
  }
  createForm.reset();
  createDeparture.disabled = false; // reset() doesn't fire the open-ended change handler
  createMarina.innerHTML = marinaOptionsHtml(marinas);
  createMarina.value = marinas.some((m) => m.id === filter.marina_id) ? filter.marina_id : marinas[0].id;
  createDialog.showModal();
  await fillCreateBerths(createMarina.value);
});

createMarina.addEventListener('change', () => fillCreateBerths(createMarina.value));

// A disabled input is skipped by native validation, so `required` on
// departure only applies while the stay has an end date.
createOpenEnded.addEventListener('change', () => {
  createDeparture.disabled = createOpenEnded.checked;
  if (createOpenEnded.checked) createDeparture.value = '';
});

byId<HTMLButtonElement>('mb-create-cancel-btn').addEventListener('click', () => createDialog.close());
createDialog.addEventListener('click', (e) => {
  if (e.target === createDialog) createDialog.close();
});

createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!createBerth.value) {
    showToast('Select a berth', 'warning');
    return;
  }
  const body: Record<string, unknown> = {
    berth_id: createBerth.value,
    arrival: createArrival.value,
    departure: createOpenEnded.checked ? null : createDeparture.value,
    contact_name: createName.value.trim(),
    contact_email: createEmail.value.trim() || null,
    contact_phone: createPhone.value.trim() || null,
    boat_name: createBoat.value.trim() || null,
    boat_length_m: createLength.value === '' ? null : Number(createLength.value),
    boat_beam_m: createBeam.value === '' ? null : Number(createBeam.value),
    status: createStatus.value,
    // Stored on the booking: guest emails and the booking page follow it.
    locale: createLocale.value,
  };
  // Only an explicit override is sent. Leaving it out lets OTA price the
  // stay from the berth rate and price tiers.
  if (createTotal.value.trim() !== '') body.total_price = Number(createTotal.value);

  const submitBtn = createForm.querySelector('button[type="submit"]') as HTMLButtonElement;
  submitBtn.disabled = true;
  try {
    const res = await apiFetch('/api/marina/bookings', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      // OTA's message as-is (overlap 409, validation 400s): it names what to fix.
      showToast(data?.error ?? 'Failed to create booking', 'error');
      return;
    }
    createDialog.close();
    showToast(`${data.contact_name}: booking created`, 'success');
    // The new row may sort onto another page or fall outside the filters,
    // so reload the page window rather than inserting the row.
    await loadBookings();
  } catch (err) {
    if (!(err instanceof Error && err.message === 'Not authenticated')) showToast('Failed to create booking', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
```

- [ ] **Step 9: Build**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts && npm run build`

Expected:
- `check-marina: ok`.
- Then `astro build` exits 0. The last build line contains `Complete!`, and there are no `[ERROR]` lines.
- `/marina-bookings` is listed as a server-rendered (non-prerendered) route.

- [ ] **Step 10: Run the spec against local OTA**

Start the stack. Local OTA must be at Task 1's commit, because the berth filter relies on `?include_inactive=1`.
- OTA: `cd C:/Users/robert/source/repos/OTA && npm run dev`. If port 3000 is taken, use `PORT=3100 npm run dev` and start D with `PUBLIC_OTA_API_BASE_URL=http://localhost:3100`.
- Dashboard: `cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background`.

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-bookings.spec.ts`

Expected: `6 passed`. That is `auth.setup.ts` plus the five tests:
- `a staff-created pending booking shows a Pending pill`
- `the status filter changes the rows`
- `an open-ended confirmed booking shows 'Open-ended'`
- `an overlapping create shows OTA's 409 as a toast`
- `paging shows Page 1 of 1 with prev/next disabled`

`afterAll` deactivates the run's marina. Re-running passes again, because every run uses a fresh `uniqueSlug('pw-mb')`.

If a test fails, debug it with `npx playwright show-report`, which has the trace and screenshot. Don't weaken the assertions.

- [ ] **Step 11: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/styles/global.css src/pages/marina-bookings.astro src/scripts/marina-bookings-client.ts tests/marina-helpers.ts tests/marina-bookings.spec.ts && git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: bookings table, filters, paging and staff create" -m "/marina-bookings lists OTA marina bookings with status, marina, berth and date-range filters kept in the URL, 50 per page with prev/next from {total, data}, and whitelisted status/payment pills (unknown values render 'Unknown', never the input). Staff create posts to /api/marina/bookings with optional open-ended departure, total override, status and guest language; OTA's errors (409 overlap, 400s) are toasted as-is. Pure query/pill logic is pinned in scripts/check-marina.ts; the page by tests/marina-bookings.spec.ts." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Nothing is pushed or deployed. The runbook does that later, after user approval.

---

### Task 11: Dashboard — booking actions and live refresh on /marina-bookings

Repo `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`. Contract R17, R23 (actions, live), Review Focus 5 (table half).

**Files:**
- Modify: `D/src/lib/marina-logic.ts`: append the Task 11 exports at the end of the file, after Task 10's `paymentPillHtml`.
- Modify: `D/scripts/check-marina.ts`:
  - add one import statement after the existing `../src/lib/marina-logic.ts` import(s);
  - insert three blocks before the final `console.log('check-marina: ok');`.
- Create: `D/src/scripts/marina-booking-actions.ts`
- Create: `D/src/scripts/marina-live.ts`
- Create: `D/src/pages/api/marina/ably-auth.ts`
- Modify: `D/src/scripts/marina-bookings-client.ts` (Task 10's file). Edits:
  - imports;
  - the actions cell in `rowHtml`;
  - new `applyRow` / `wireActions` / `startLive`;
  - two calls in `init()`.
- Modify: `D/tests/marina-bookings.spec.ts`: merge into the import block, then append a second `test.describe.serial` block at the end of the file.

**Interfaces:**
- Consumes:
  - From Task 5: `StaffBookingRow`, `MarinaStatus`, `PaymentStatus` (`marina-logic.ts`); `loadProperty()` typed with `id?: string` (`sidebar-modules-widget.ts`).
  - From Task 8: `addDays`, `propertyToday`.
  - From Task 10: `PAGE_SIZE`, `BookingFilter`, `statusPillHtml` (rows render `.marina-pill`).
  - From `D/tests/marina-helpers.ts`: `uniqueSlug`, `createMarinaViaUi`, `deactivateMarinaViaUi`, `importBerthsCsvViaUi`, `createBookingViaUi`.
  - From the existing code: `confirmDialog` / `choiceDialog` (`confirm-dialog.ts`), `showToast` (`toast.ts`), `apiFetch` (`api-client.ts`), `otaRequest` / `requireAuth` (`src/lib`).
  - Task 10's module-private names in `marina-bookings-client.ts`, which this task relies on:
    - `rows: StaffBookingRow[]` (the current page);
    - `filter: BookingFilter` (an object whose `offset` field can be changed);
    - `async function loadBookings(): Promise<void>`: fetches `bookingsQuery(filter)`, sets `rows` and the total, renders, updates `#mb-page-info`, and steps back from a page past the end;
    - `function renderTable(): void`;
    - `function rowHtml(b: StaffBookingRow): string`, whose last cell is `<td class="col-actions"></td>`, under a `<th class="col-actions">Actions</th>` header;
    - `async function init()`.
  - OTA:
    - `PUT /api/marina/bookings/:id` with `{action:'confirm'}`, `{action:'decline'}`, `{action:'cancel', refund}` or `{action:'end', departure}` returns the joined row on success. Errors are `{error, booking?}`: 502 when Stripe refuses, and 409 `This request expired before it was confirmed`, both carry `booking`.
    - `POST /api/marina/bookings/:id/send-guest-link` returns `{sent:true}`, or 409 `Set the marina's booking page URL in Settings first`.
    - Ably `property:{id}:marina-bookings` carries `new-booking` / `booking-status-changed` with the joined row, which is a superset of `StaffBookingRow`.
- Produces:
  - In `marina-logic.ts`, exactly as in the contract:
    - `matchesFilter(row, f): boolean`
    - `liveAction(rows, row, f): 'replace' | 'refetch' | 'ignore'`
    - `type BookingAction = 'confirm' | 'decline' | 'cancel' | 'end' | 'send-link'`
    - `bookingActions(row): BookingAction[]`
  - `runBookingAction(row: StaffBookingRow, action: BookingAction): Promise<StaffBookingRow | null>` (`marina-booking-actions.ts`).
  - `subscribeMarinaBookings(onRow): Promise<() => void>` (`marina-live.ts`). Task 13 reuses it.
  - `GET /api/marina/ably-auth`: a bare TokenRequest, subscribe-only on `property:${id}:marina-bookings`.
  - DOM:
    - `button[data-action="confirm|decline|cancel|end|send-link"]` in `#marina-bookings-body tr[data-id] td.col-actions`;
    - `<dialog id="marina-end-dialog" class="list-dialog">` containing `#marina-end-date` (`type="date"`, `min` = arrival + 1), `#marina-end-cancel` and `button[type=submit][value=end]`.
  - The click delegation ignores every other `data-action` value, so Task 12's `details` button in the same cell is left to Task 12.
  - R17: no move or re-date action exists. `bookingActions` can never return one.

- [ ] **Step 1: Write the failing check**

In `D/scripts/check-marina.ts`, add this statement after the existing `import … from '../src/lib/marina-logic.ts';` statement(s). It is a separate statement so it can't clash with the names earlier tasks import:

```ts
import { matchesFilter, liveAction, bookingActions } from '../src/lib/marina-logic.ts';
```

Then replace the final line

```ts
console.log('check-marina: ok');
```

with:

```ts
// ---- matchesFilter ----
{
  // Fixture types come from the function itself, so this block needs no
  // extra type import that could collide with an earlier block's.
  type Row = Parameters<typeof liveAction>[1];
  type Filter = Parameters<typeof liveAction>[2];
  const F: Filter = { status: '', marina_id: '', berth_id: '', from: '', to: '', offset: 0 };
  const R: Pick<Row, 'status' | 'marina_id' | 'berth_id' | 'arrival' | 'departure'> =
    { status: 'confirmed', marina_id: 'm1', berth_id: 'b1', arrival: '2026-10-10', departure: '2026-10-14' };

  assert.equal(matchesFilter(R, F), true);
  // OTA's list never returns holds; one arriving on the feed must not show up.
  assert.equal(matchesFilter({ ...R, status: 'hold' }, F), false);
  assert.equal(matchesFilter({ ...R, status: 'hold' }, { ...F, status: '' }), false);
  // Open-ended stays on berth for ever, so it overlaps any `from`.
  assert.equal(matchesFilter({ ...R, departure: null }, { ...F, from: '2030-01-01' }), true);
  // Same overlap test as OTA: departure > from, arrival < to.
  assert.equal(matchesFilter(R, { ...F, from: '2026-10-14' }), false);
  assert.equal(matchesFilter(R, { ...F, from: '2026-10-13' }), true);
  assert.equal(matchesFilter(R, { ...F, to: '2026-10-10' }), false);
  assert.equal(matchesFilter(R, { ...F, to: '2026-10-11' }), true);
  assert.equal(matchesFilter(R, { ...F, status: 'pending' }), false);
  assert.equal(matchesFilter(R, { ...F, status: 'confirmed' }), true);
  assert.equal(matchesFilter(R, { ...F, marina_id: 'm2' }), false);
  assert.equal(matchesFilter(R, { ...F, marina_id: 'm1' }), true);
  assert.equal(matchesFilter(R, { ...F, berth_id: 'b2' }), false);
  assert.equal(matchesFilter(R, { ...F, berth_id: 'b1' }), true);
}

// ---- liveAction ----
{
  type Row = Parameters<typeof liveAction>[1];
  type Filter = Parameters<typeof liveAction>[2];
  const F: Filter = { status: '', marina_id: '', berth_id: '', from: '', to: '', offset: 0 };
  const base: Row = {
    id: 'a', marina_id: 'm1', marina_name: 'Marina', berth_id: 'b1', berth_label: 'A1',
    contact_name: 'Ann', contact_email: null, contact_phone: null, boat_name: null, boat_length_m: null,
    arrival: '2026-10-10', departure: '2026-10-14', status: 'confirmed', source: 'staff',
    total_price: null, currency: null, payment_status: 'none', payment_error: null,
    hold_expires_at: null, created_at: '2026-10-01T00:00:00.000Z',
  };

  // On the page and still matching: merge it in place.
  assert.equal(liveAction([base], { ...base, contact_name: 'Ann B' }, F), 'replace');
  // On the page but it left the filter (declined while viewing Confirmed): refill the page.
  assert.equal(liveAction([base], { ...base, status: 'declined' }, { ...F, status: 'confirmed' }), 'refetch');
  // New and matching: refetch so it lands on the page OTA's order puts it on.
  assert.equal(liveAction([base], { ...base, id: 'b' }, F), 'refetch');
  // New and for another filter: never touch this page.
  assert.equal(liveAction([base], { ...base, id: 'b', marina_id: 'm2' }, { ...F, marina_id: 'm1' }), 'ignore');
  assert.equal(liveAction([], { ...base, status: 'hold' }, F), 'ignore');
}

// ---- bookingActions ----
assert.deepEqual(bookingActions({ status: 'pending', departure: '2026-10-14' }), ['confirm', 'decline', 'cancel', 'send-link']);
assert.deepEqual(bookingActions({ status: 'pending', departure: null }), ['confirm', 'decline', 'cancel', 'send-link']);
assert.deepEqual(bookingActions({ status: 'confirmed', departure: '2026-10-14' }), ['cancel', 'send-link']);
assert.deepEqual(bookingActions({ status: 'confirmed', departure: null }), ['cancel', 'send-link', 'end']);
assert.deepEqual(bookingActions({ status: 'declined', departure: '2026-10-14' }), []);
assert.deepEqual(bookingActions({ status: 'cancelled', departure: null }), []);
assert.deepEqual(bookingActions({ status: 'hold', departure: '2026-10-14' }), []);

console.log('check-marina: ok');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: exit code 1 with
`SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'matchesFilter'`

- [ ] **Step 3: Implement the pure logic**

Append to the end of `D/src/lib/marina-logic.ts`:

```ts
// ---- Task 11: live updates and row actions ----

// The client-side twin of OTA's list WHERE clause (GET /api/marina/bookings):
// a live row is only placed on the page if the server would have returned it
// for the same filter. OTA never lists holds, so neither does this.
export function matchesFilter(
  row: Pick<StaffBookingRow, 'status' | 'marina_id' | 'berth_id' | 'arrival' | 'departure'>,
  f: BookingFilter,
): boolean {
  if (row.status === 'hold') return false;
  if (f.status && row.status !== f.status) return false;
  if (f.marina_id && row.marina_id !== f.marina_id) return false;
  if (f.berth_id && row.berth_id !== f.berth_id) return false;
  // `from` keeps stays still on berth after it (open-ended always is);
  // `to` keeps stays that start before it. Both bounds exclusive, as in OTA.
  if (f.from && row.departure != null && !(row.departure > f.from)) return false;
  if (f.to && !(row.arrival < f.to)) return false;
  return true;
}

// A row from Ably or from an action's response, decided against the page in
// view. Only rows already on the page are patched; anything else that matches
// forces a refetch, so a new booking appears on the page OTA's ordering and
// paging put it on, never on whichever page happens to be open.
export function liveAction(rows: StaffBookingRow[], row: StaffBookingRow, f: BookingFilter): 'replace' | 'refetch' | 'ignore' {
  const onPage = rows.some((r) => r.id === row.id);
  const matches = matchesFilter(row, f);
  if (onPage) return matches ? 'replace' : 'refetch';
  return matches ? 'refetch' : 'ignore';
}

export type BookingAction = 'confirm' | 'decline' | 'cancel' | 'end' | 'send-link';

// What OTA's PUT /api/marina/bookings/:id accepts from each status. There is
// no move/re-date action (R17): staff cancel and create again.
export function bookingActions(row: Pick<StaffBookingRow, 'status' | 'departure'>): BookingAction[] {
  if (row.status === 'pending') return ['confirm', 'decline', 'cancel', 'send-link'];
  if (row.status === 'confirmed') return row.departure === null ? ['cancel', 'send-link', 'end'] : ['cancel', 'send-link'];
  return [];
}
```

- [ ] **Step 4: Run the check again**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: exit 0, printing `check-marina: ok`.

- [ ] **Step 5: Create the Ably token route**

Create `D/src/pages/api/marina/ably-auth.ts`:

```ts
import type { APIRoute } from 'astro';
import * as Ably from 'ably';
import { otaRequest } from '../../../lib/ota-client';
import { requireAuth } from '../../../lib/require-auth';

// Copy of golf/ably-auth.ts: returns the bare TokenRequest for Ably's
// `authUrl` client option (used by src/scripts/marina-live.ts), scoped
// subscribe-only to this property's marina-bookings channel. OTA publishes
// 'new-booking' / 'booking-status-changed' there from publishMarinaBooking
// in src/lib/ably.js.
export const GET: APIRoute = async (context) => {
  const authError = requireAuth(context);
  if (authError) return authError;

  const token = await context.locals.auth().getToken();
  const { status, data } = await otaRequest('/api/property/me', { token });
  if (status !== 200 || !data?.id) {
    return new Response(JSON.stringify({ error: 'Could not resolve property' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const channel = `property:${data.id}:marina-bookings`;
  const ably = new Ably.Rest({ key: import.meta.env.ABLY_API_KEY });
  const tokenRequest = await ably.auth.createTokenRequest({
    capability: { [channel]: ['subscribe'] },
  });

  return new Response(JSON.stringify(tokenRequest), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
```

- [ ] **Step 6: Create the live subscription**

Create `D/src/scripts/marina-live.ts`:

```ts
import { loadProperty } from './sidebar-modules-widget';
import type { StaffBookingRow } from '../lib/marina-logic';

// D's first direct Ably subscriber (everything else goes through hotal-ui
// feeds). The token comes from /api/marina/ably-auth, scoped to this
// property's channel. OTA sends the whole joined row (a superset of the list
// row), never a patch, so callers can merge it by id.
export async function subscribeMarinaBookings(
  onRow: (row: StaffBookingRow, event: 'new-booking' | 'booking-status-changed') => void,
): Promise<() => void> {
  const property = await loadProperty();
  if (!property?.id) return () => {};
  // Loaded only on pages that go live, the same way hotal-ui loads it.
  const { Realtime } = await import('ably');
  const realtime = new Realtime({ authUrl: '/api/marina/ably-auth' });
  const channel = realtime.channels.get(`property:${property.id}:marina-bookings`);
  // Not awaited: without ABLY_API_KEY the attach fails, and the page must
  // still work. It just doesn't update live until the next reload.
  channel
    .subscribe(['new-booking', 'booking-status-changed'], (msg) => {
      if (msg.data && typeof msg.data === 'object') {
        onRow(msg.data as StaffBookingRow, msg.name as 'new-booking' | 'booking-status-changed');
      }
    })
    .catch((err) => console.warn('Marina live updates unavailable:', err?.message ?? err));
  return () => realtime.close();
}
```

- [ ] **Step 7: Create the action runner**

Create `D/src/scripts/marina-booking-actions.ts`:

```ts
import { apiFetch } from './api-client';
import { confirmDialog, choiceDialog } from './confirm-dialog';
import { showToast } from './toast';
import { addDays, type BookingAction, type StaffBookingRow } from '../lib/marina-logic';

const DONE: Record<BookingAction, string> = {
  confirm: 'Confirmed',
  decline: 'Declined',
  cancel: 'Cancelled',
  end: 'Departure set',
  'send-link': 'Booking link sent',
};

// Shared by the bookings table (this task), the detail dialog (Task 12) and
// the /marina berth panel (Task 13). Resolves to the row to repaint, or null
// when nothing changed (user backed out, or a plain error).
export async function runBookingAction(row: StaffBookingRow, action: BookingAction): Promise<StaffBookingRow | null> {
  const body = await ask(row, action);
  if (!body) return null;
  try {
    const res =
      action === 'send-link'
        ? await apiFetch(`/api/marina/bookings/${row.id}/send-guest-link`, { method: 'POST' })
        : await apiFetch(`/api/marina/bookings/${row.id}`, { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showToast(`${row.contact_name}: ${data?.error ?? 'Request failed'}`, 'error');
      // A Stripe refusal (502, payment_error now set) or a request that
      // lapsed (409, now cancelled) still changed the booking. Hand the row
      // back so the table shows its real state.
      return data?.booking ?? null;
    }
    showToast(`${row.contact_name}: ${DONE[action]}`, 'success');
    // send-guest-link answers {sent:true}; the booking itself is unchanged.
    return action === 'send-link' ? row : (data as StaffBookingRow);
  } catch (err) {
    // apiFetch has already opened the sign-in modal for this one.
    if (err instanceof Error && err.message === 'Not authenticated') return null;
    showToast(`${row.contact_name}: Could not reach the booking service`, 'error');
    return null;
  }
}

// The request body for the action, or null when the user backs out.
async function ask(row: StaffBookingRow, action: BookingAction): Promise<Record<string, unknown> | null> {
  const who = row.contact_name;
  const where = `berth ${row.berth_label}`;
  if (action === 'confirm') {
    const charge = row.payment_status === 'held' ? ' The card hold will be charged.' : '';
    const ok = await confirmDialog(`Confirm ${who}'s booking for ${where} from ${row.arrival}?${charge}`, {
      confirmLabel: 'Confirm booking',
      cancelLabel: 'Back',
    });
    return ok ? { action: 'confirm' } : null;
  }
  if (action === 'decline') {
    const release = row.payment_status === 'held' ? ' The card hold will be released.' : '';
    const ok = await confirmDialog(`Decline ${who}'s request for ${where}?${release}`, {
      confirmLabel: 'Decline request',
      cancelLabel: 'Keep request',
      danger: true,
    });
    return ok ? { action: 'decline' } : null;
  }
  if (action === 'cancel') {
    // The restaurant cancel pattern: money already taken can be refunded or
    // kept as a fee. A hold that was never captured can only be released.
    if (row.payment_status === 'captured') {
      const choice = await choiceDialog(
        `Cancel ${who}'s booking for ${where}? The payment can be refunded or kept as a cancellation fee.`,
        { confirmLabel: 'Cancel & refund', altLabel: 'Cancel & keep payment', cancelLabel: 'Keep booking', danger: true },
      );
      return choice ? { action: 'cancel', refund: choice === 'confirm' } : null;
    }
    const held = row.payment_status === 'held';
    const ok = await confirmDialog(
      held ? `Cancel ${who}'s booking for ${where}? The card hold will be released.` : `Cancel ${who}'s booking for ${where}?`,
      { confirmLabel: held ? 'Cancel & release hold' : 'Cancel booking', cancelLabel: 'Keep booking', danger: true },
    );
    return ok ? { action: 'cancel', refund: false } : null;
  }
  if (action === 'end') {
    const departure = await pickDeparture(row);
    return departure ? { action: 'end', departure } : null;
  }
  return {}; // send-link: nothing to ask, the guest just gets their link again
}

// Created on first use, so no page has to carry its markup.
function endDialog(): HTMLDialogElement {
  const existing = document.getElementById('marina-end-dialog') as HTMLDialogElement | null;
  if (existing) return existing;
  const dialog = document.createElement('dialog');
  dialog.id = 'marina-end-dialog';
  dialog.className = 'list-dialog';
  dialog.innerHTML = `
    <div class="list-dialog-header"><h2>End booking</h2></div>
    <form method="dialog" class="slots-bulk-form">
      <p id="marina-end-who"></p>
      <label>
        Departure
        <input type="date" id="marina-end-date" required />
      </label>
      <div class="list-dialog-footer">
        <button id="marina-end-cancel" type="button">Cancel</button>
        <button type="submit" value="end">End booking</button>
      </div>
    </form>
  `;
  (dialog.querySelector('#marina-end-cancel') as HTMLButtonElement).addEventListener('click', () => dialog.close());
  // <dialog> has no backdrop-click dismiss of its own.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  return dialog;
}

function pickDeparture(row: StaffBookingRow): Promise<string | null> {
  const dialog = endDialog();
  const input = dialog.querySelector('#marina-end-date') as HTMLInputElement;
  (dialog.querySelector('#marina-end-who') as HTMLElement).textContent =
    `${row.contact_name} · berth ${row.berth_label} · arrived ${row.arrival}`;
  // OTA requires departure > arrival. The native min blocks an earlier date
  // before anything is sent.
  input.min = addDays(row.arrival, 1);
  input.value = '';
  // Esc and Cancel close without a value; don't replay the last answer.
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'end' && input.value ? input.value : null),
      { once: true },
    );
  });
}
```

- [ ] **Step 8: Wire actions and live refresh into the bookings table**

In `D/src/scripts/marina-bookings-client.ts`:

8a. Add these imports below Task 10's imports (`PAGE_SIZE` and `StaffBookingRow` are already imported by Task 10):

```ts
import { runBookingAction } from './marina-booking-actions';
import { subscribeMarinaBookings } from './marina-live';
import { bookingActions, liveAction, type BookingAction } from '../lib/marina-logic';
```

8b. In `rowHtml`, replace the actions cell. Old:

```ts
<td class="col-actions"></td>
```

New:

```ts
<td class="col-actions">${actionButtonsHtml(b)}</td>
```

8c. Add above `rowHtml`:

```ts
const ACTION_LABELS: Record<BookingAction, string> = {
  confirm: 'Confirm',
  decline: 'Decline',
  cancel: 'Cancel',
  end: 'End',
  'send-link': 'Send link',
};

// Labels and data-action values are fixed strings, never server text.
function actionButtonsHtml(r: StaffBookingRow): string {
  return bookingActions(r)
    .map((a) => `<button type="button" data-action="${a}">${ACTION_LABELS[a]}</button>`)
    .join('');
}
```

8d. Add below `renderTable`:

```ts
// One path for a row from an action and a row from Ably, so both obey the
// filter and page in view. A row that left the filter (declined while viewing
// Pending) drops out and the page refills; a new one appears only through a
// refetch, so it lands where OTA's order puts it.
function applyRow(row: StaffBookingRow): void {
  const action = liveAction(rows, row, filter);
  if (action === 'replace') {
    const i = rows.findIndex((r) => r.id === row.id);
    // Merge: the list row has fields (marina_name) that an action's
    // response or the Ably row may shape differently or lack.
    rows[i] = { ...rows[i], ...row };
    renderTable();
  } else if (action === 'refetch') {
    // loadBookings steps back itself when the last row of the last page left.
    void loadBookings();
  }
}

// Delegated on the tbody because renderTable replaces every <tr>.
function wireActions(): void {
  const body = document.getElementById('marina-bookings-body') as HTMLElement;
  body.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    // Other data-action values (Task 12's "details") have their own handler.
    if (!btn || !(btn.dataset.action! in ACTION_LABELS)) return;
    const row = rows.find((r) => r.id === btn.closest<HTMLElement>('tr')?.dataset.id);
    if (!row) return;
    btn.disabled = true;
    try {
      const updated = await runBookingAction(row, btn.dataset.action as BookingAction);
      if (updated) applyRow(updated);
    } finally {
      btn.disabled = false;
    }
  });
}

// A burst of events can start overlapping loads; loadBookings' sequence
// number lets only the newest one render.
function startLive(): void {
  void subscribeMarinaBookings((row) => applyRow(row));
}
```

8e. In `init()`, call `wireActions();` next to Task 10's other listener wiring, before the first `await`. Call `startLive();` straight after the first `await loadBookings();`, so an event can't merge into the empty pre-load `rows`.

- [ ] **Step 9: Gates (logic and build)**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts && npm run build`

Expected:
- `check-marina: ok`;
- then Astro's build log ending `[build] Complete!`, with no TypeScript or Vite errors (exit 0).

- [ ] **Step 10: Extend the Playwright spec**

At the top of `D/tests/marina-bookings.spec.ts`, merge into Task 10's import block so that, without duplicate names, it contains:

```ts
import { test, expect, type Page } from '@playwright/test';
import { uniqueSlug, createMarinaViaUi, deactivateMarinaViaUi, importBerthsCsvViaUi, createBookingViaUi } from './marina-helpers';
import { propertyToday, addDays } from '../src/lib/marina-logic';
```

Append at the end of the file:

```ts
// Task 11: row actions against local OTA. A fresh marina with four berths
// (one booking each, so no overlap) and no booking_url, which is exactly
// what makes send-link answer 409. Deactivated in afterAll.
test.describe.serial('marina booking actions', () => {
  const slug = uniqueSlug('pw-mb-actions');
  let marinaId = '';
  let today = '';
  const ids = { confirm: '', decline: '', open: '', plain: '' };

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  // Clerk's impersonation badge sits over the right-hand Actions column.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const inject = () => {
        const style = document.createElement('style');
        style.textContent = '#cl-impersonationEye { display: none !important; }';
        document.head.appendChild(style);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
      else inject();
    });
  });

  const listLoad = (page: Page, needle = '/api/marina/bookings?') =>
    page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/api/marina/bookings?') && res.url().includes(needle));

  // All statuses, this run's marina only, whatever filter the page restored.
  async function gotoMarinaBookings(page: Page) {
    const initial = listLoad(page);
    await page.goto('/marina-bookings');
    await initial;
    let next = listLoad(page);
    await page.locator('#mb-status').selectOption({ value: '' });
    await next;
    next = listLoad(page, `marina_id=${marinaId}`);
    await page.locator('#mb-marina').selectOption(marinaId);
    await next;
  }

  const rowOf = (page: Page, id: string) => page.locator(`#marina-bookings-body tr[data-id="${id}"]`);
  const putOf = (page: Page, id: string) =>
    page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes(`/api/marina/bookings/${id}`));

  test('set up a marina, berths and four bookings', async ({ page }) => {
    const propertyLoad = page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/api/property/me'));
    marinaId = await createMarinaViaUi(page, { name: `PW Actions ${slug}`, slug });
    // The marina's day, not the test machine's: arrival "today" shows under
    // any default date filter Task 10 restores.
    today = propertyToday((await (await propertyLoad).json()).timezone);
    await importBerthsCsvViaUi(page, marinaId, 'label,length_m,price_per_night\nPW1,12,40\nPW2,12,40\nPW3,12,40\nPW4,12,40\n');
    const departure = addDays(today, 3);
    ids.confirm = await createBookingViaUi(page, { marinaId, berthLabel: 'PW1', arrival: today, departure, status: 'pending', contactName: 'PW Confirm Me', contactEmail: 'pw-confirm@example.com' });
    ids.decline = await createBookingViaUi(page, { marinaId, berthLabel: 'PW2', arrival: today, departure, status: 'pending', contactName: 'PW Decline Me' });
    ids.open = await createBookingViaUi(page, { marinaId, berthLabel: 'PW3', arrival: today, departure: null, status: 'confirmed', contactName: 'PW Open Ended' });
    ids.plain = await createBookingViaUi(page, { marinaId, berthLabel: 'PW4', arrival: today, departure, status: 'confirmed', contactName: 'PW Cancel Me' });
  });

  test('confirm a pending booking', async ({ page }) => {
    await gotoMarinaBookings(page);
    const row = rowOf(page, ids.confirm);
    await row.locator('button[data-action="confirm"]').click();
    await expect(page.locator('#confirm-dialog-confirm-btn')).toHaveText('Confirm booking');
    const [res] = await Promise.all([putOf(page, ids.confirm), page.locator('#confirm-dialog-confirm-btn').click()]);
    expect(res.status()).toBe(200);
    await expect(row.locator('.marina-pill')).toHaveText('Confirmed');
    await expect(row.locator('button[data-action="confirm"]')).toHaveCount(0);
    await expect(row.locator('button[data-action="decline"]')).toHaveCount(0);
  });

  test('decline another pending booking', async ({ page }) => {
    await gotoMarinaBookings(page);
    const row = rowOf(page, ids.decline);
    await row.locator('button[data-action="decline"]').click();
    const [res] = await Promise.all([putOf(page, ids.decline), page.locator('#confirm-dialog-confirm-btn').click()]);
    expect(res.status()).toBe(200);
    await expect(row.locator('.marina-pill')).toHaveText('Declined');
    await expect(row.locator('button[data-action]:not([data-action="details"])')).toHaveCount(0);
  });

  test("send-link without a booking page URL shows OTA's 409", async ({ page }) => {
    await gotoMarinaBookings(page);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/marina/bookings/${ids.confirm}/send-guest-link`)),
      rowOf(page, ids.confirm).locator('button[data-action="send-link"]').click(),
    ]);
    expect(res.status()).toBe(409);
    await expect(page.locator('.toast--error').last()).toContainText("Set the marina's booking page URL in Settings first");
  });

  test('end an open-ended booking with a departure', async ({ page }) => {
    await gotoMarinaBookings(page);
    const row = rowOf(page, ids.open);
    const departure = addDays(today, 5);
    await row.locator('button[data-action="end"]').click();
    const dialog = page.locator('#marina-end-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#marina-end-date')).toHaveAttribute('min', addDays(today, 1));
    await dialog.locator('#marina-end-date').fill(departure);
    const [res] = await Promise.all([putOf(page, ids.open), dialog.locator('button[type="submit"]').click()]);
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ action: 'end', departure });
    // The row shows dates formatted (e.g. 'Sat, 17 Oct'), so check the cell left 'Open-ended'.
    await expect(row.locator('td').nth(1)).not.toHaveText('Open-ended');
    await expect(row.locator('button[data-action="end"]')).toHaveCount(0);
  });

  test('cancel a booking with no payment', async ({ page }) => {
    await gotoMarinaBookings(page);
    const row = rowOf(page, ids.plain);
    await row.locator('button[data-action="cancel"]').click();
    // No payment: a plain confirm, no refund/keep choice.
    await expect(page.locator('#confirm-dialog-confirm-btn')).toHaveText('Cancel booking');
    await expect(page.locator('#confirm-dialog-alt-btn')).toBeHidden();
    const [res] = await Promise.all([putOf(page, ids.plain), page.locator('#confirm-dialog-confirm-btn').click()]);
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ action: 'cancel', refund: false });
    await expect(row.locator('.marina-pill')).toHaveText('Cancelled');
    await expect(row.locator('button[data-action]:not([data-action="details"])')).toHaveCount(0);
  });

  test('ably-auth mints a marina-bookings token for the signed-in page', async ({ page }) => {
    await gotoMarinaBookings(page);
    // Fetched from inside the page so Clerk's fresh session cookie goes with it.
    const { status, body } = await page.evaluate(async () => {
      const r = await fetch('/api/marina/ably-auth');
      return { status: r.status, body: await r.text() };
    });
    test.skip(status >= 500, `ABLY_API_KEY not set in D/.env? ably-auth answered ${status}`);
    expect(status).toBe(200);
    const token = JSON.parse(body);
    expect(typeof token.keyName).toBe('string');
    expect(token.capability).toContain(':marina-bookings');
  });
});
```

- [ ] **Step 11: Run the spec against local OTA**

Start the stack:
- `cd C:/Users/robert/source/repos/OTA && npm run dev`. If port 3000 is taken, use `PORT=3100 npm run dev` and start D with `PUBLIC_OTA_API_BASE_URL=http://localhost:3100`.
- `cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background`.

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-bookings.spec.ts`

Expected:
- `Running N tests using 1 worker`, then `N passed`, where N is Task 10's tests plus the 7 above.
- If `ABLY_API_KEY` is missing from `D/.env`, the result is `N-1 passed, 1 skipped`, and the skip reason names the 5xx status.

- [ ] **Step 12: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/scripts/marina-booking-actions.ts src/scripts/marina-live.ts src/pages/api/marina/ably-auth.ts src/scripts/marina-bookings-client.ts tests/marina-bookings.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: booking actions and live refresh" -m "Rows offer confirm/decline/cancel (refund or keep when captured, release when held)/end open-ended/send guest link per status; no move or re-date (R17). Action responses and Ably rows on property:{id}:marina-bookings go through matchesFilter/liveAction: merged in place, or the page is refetched (stepping back when it empties). New /api/marina/ably-auth token route." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do not push. The runbook deploys D later, together with the rest of plan C.

---

### Task 12: Dashboard — booking detail dialog (documents, contract, payment)

Repo `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `main`. Contract R23 (detail dialog; no assumption of ≤10 documents), R13 consumer (`signature.rendered_body`), R12 consumer (the dialog half of Review Focus 5: `refreshOpenMarinaBookingDialog` re-fetches).

**Files:**
- Create: `D/src/scripts/marina-booking-dialog.ts`. It holds the whole dialog: lazy `<dialog>`, both GETs, render, document view/download/verify/reject, and actions through `runBookingAction`.
- Modify: `D/src/scripts/marina-bookings-client.ts` (created by Task 10, extended by Task 11). Four anchored edits:
  - the import block;
  - the action-cell template that maps `bookingActions(row)`;
  - the top of the `#marina-bookings-body` click listener;
  - the `subscribeMarinaBookings(` call.
- Modify: `D/src/styles/global.css`. Append one block at the end of the file, after Task 10's `.marina-pill` / `.marina-pay` rules.
- Modify: `D/tests/marina-bookings.spec.ts`. Append one `test.describe.serial` block at the end of the file and extend its import lines.

**Interfaces:**
- Consumes:
  - `apiFetch` and `escapeHtml` (`D/src/scripts/api-client.ts`).
  - `showToast` (`D/src/scripts/toast.ts`).
  - From `D/src/lib/marina-logic.ts`:
    - `StaffBookingRow` (Task 5)
    - `statusPillHtml`, `paymentPillHtml` (Task 10)
    - `bookingActions`, `BookingAction` (Task 11)
  - `runBookingAction(row, action): Promise<StaffBookingRow | null>` (`D/src/scripts/marina-booking-actions.ts`, Task 11).
  - Task 11's per-row apply function in `marina-bookings-client.ts`. It runs `liveAction` and then replaces or refetches. Task 11 uses it for both its Ably callback and its table action results. This task calls it `applyRow(row: StaffBookingRow): void`.
  - Playwright helpers in `D/tests/marina-helpers.ts`:
    - `uniqueSlug`, `createMarinaViaUi`, `deactivateMarinaViaUi` (Task 6)
    - `importBerthsCsvViaUi` (Task 7)
    - `createBookingViaUi` (Task 10)
  - `propertyToday` and `addDays` (Task 8).
  - OTA routes:
    - `GET /api/marina/bookings/:id`: the joined row plus `documents` and `signature: { template_id, signer_email, agreed_at, rendered_body } | null` (R13, Task 1).
    - `GET /api/marina/bookings/:id/documents`
    - `GET /api/marina/documents/:id/file`: 410 `File deleted under the retention policy`.
    - `PUT /api/marina/documents/:id {status, notes}`
    - Live `booking-status-changed` after upload, verify/reject and agree (R12, Task 1), delivered through `subscribeMarinaBookings` (Task 11).
- Produces:
  - `export async function openMarinaBookingDialog(id: string, onChange: (row: StaffBookingRow) => void): Promise<void>`
  - `export function refreshOpenMarinaBookingDialog(row: StaffBookingRow): void`
  - DOM, used by Task 13 (berth panel "open detail dialog") and Task 15 (e2e):
    - `<dialog id="marina-booking-dialog" class="list-dialog">`
    - `#marina-booking-dialog-title`, `#marina-booking-details`, and the close button `button[title="Close"]`
    - booking action buttons `#marina-booking-dialog button[data-action="confirm|decline|cancel|end|send-link"]`
    - documents as `li.mbd-doc[data-doc-id]`, each with `button[data-doc-view]`, `button[data-doc-download]`, `input[data-doc-notes]`, and `button[data-doc-status="verified"|"rejected"]`
    - the empty state text `No documents uploaded yet`
    - the contract text `Not agreed yet`, or `Agreed <date time> by <email>` plus `.mbd-contract`, which holds `rendered_body` as textContent
  - Rows: `#marina-bookings-body tr[data-id]` gets `button[data-action="details"]`, and a click on the row (outside a control) opens the dialog.

Prerequisites for the Playwright steps:
- Local OTA: `cd C:/Users/robert/source/repos/OTA && npm run dev`.
- Dashboard: `cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background`, on port 4335.
- `clerk auth login` done once on this machine.

- [ ] **Step 1: Write the failing Playwright block**

In `D/tests/marina-bookings.spec.ts`, make sure the import lines include these names. Merge them into Task 10's existing lines; do not duplicate an import.

```ts
import { test, expect } from '@playwright/test';
import { uniqueSlug, createMarinaViaUi, deactivateMarinaViaUi, importBerthsCsvViaUi, createBookingViaUi } from './marina-helpers';
import { propertyToday, addDays } from '../src/lib/marina-logic';
```

Then append at the end of the file:

```ts
// Task 12: the booking detail dialog. Its own marina and booking, so the
// decline here can't disturb Tasks 10-11's rows. Verify/Reject and the
// agreed contract text need a guest upload/agreement first -- Task 15's
// end-to-end run covers those against the real guest page.
test.describe.serial('marina booking detail dialog', () => {
  const slug = uniqueSlug('pw-mbd');
  const contactName = `PW Detail ${slug}`;
  let marinaId = '';
  let bookingId = '';

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  // The detail URL is a prefix of the documents URL, so match pathnames exactly.
  const waitGet = (page: import('@playwright/test').Page, path: string) =>
    page.waitForResponse((res) => res.request().method() === 'GET' && new URL(res.url()).pathname === path);

  // Narrow the table to this run's marina: the shared dev DB keeps earlier
  // runs' bookings, which could push this row off page 1.
  async function openFiltered(page: import('@playwright/test').Page) {
    const list = page.waitForResponse(
      (res) => res.request().method() === 'GET' && res.url().includes('/api/marina/bookings?')
    );
    await page.goto('/marina-bookings');
    await list;
    await expect(page.locator(`#mb-marina option[value="${marinaId}"]`)).toHaveCount(1);
    if ((await page.locator('#mb-marina').inputValue()) !== marinaId) {
      await Promise.all([
        page.waitForResponse(
          (res) => res.request().method() === 'GET' && res.url().includes('/api/marina/bookings?') && res.url().includes(`marina_id=${marinaId}`)
        ),
        page.selectOption('#mb-marina', marinaId),
      ]);
    }
    await expect(page.locator('#mb-status')).toHaveValue('');
    return page.locator(`#marina-bookings-body tr[data-id="${bookingId}"]`);
  }

  test('details shows the payment pill, empty documents and an unsigned contract', async ({ page }) => {
    const me = waitGet(page, '/api/property/me');
    await page.goto('/marina-bookings');
    const today = propertyToday((await (await me).json()).timezone);

    marinaId = await createMarinaViaUi(page, { name: contactName, slug });
    await importBerthsCsvViaUi(page, marinaId, 'label,length_m,price_per_night\nD1,15,40\n');
    // No email, so no card was ever taken: payment_status stays 'none'.
    bookingId = await createBookingViaUi(page, {
      marinaId, berthLabel: 'D1', arrival: today, departure: addDays(today, 2), status: 'pending', contactName,
    });

    const row = await openFiltered(page);
    await expect(row).toBeVisible();
    const loads = Promise.all([
      waitGet(page, `/api/marina/bookings/${bookingId}`),
      waitGet(page, `/api/marina/bookings/${bookingId}/documents`),
    ]);
    await row.locator('button[data-action="details"]').click();
    await loads;

    const dialog = page.locator('#marina-booking-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#marina-booking-dialog-title')).toHaveText(contactName);
    await expect(dialog.locator('.marina-pill')).toHaveText('Pending');
    await expect(dialog.locator('.marina-pay')).toHaveText('No payment');
    await expect(dialog).toContainText('No documents uploaded yet');
    await expect(dialog).toContainText('Not agreed yet');
    await expect(dialog.locator('button[data-action="confirm"]')).toBeVisible();

    await dialog.locator('button[title="Close"]').click();
    await expect(dialog).toBeHidden();

    // A click on the row itself (not one of its buttons) opens the same dialog.
    await row.locator('td').first().click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('#marina-booking-dialog-title')).toHaveText(contactName);
  });

  test('declining inside the dialog updates the table row', async ({ page }) => {
    const row = await openFiltered(page);
    await row.locator('button[data-action="details"]').click();
    const dialog = page.locator('#marina-booking-dialog');
    await expect(dialog.locator('.marina-pay')).toHaveText('No payment');

    await dialog.locator('button[data-action="decline"]').click();
    const [put] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'PUT' && new URL(res.url()).pathname === `/api/marina/bookings/${bookingId}`
      ),
      page.locator('#confirm-dialog-confirm-btn').click(),
    ]);
    expect(put.ok()).toBeTruthy();

    await expect(dialog.locator('.marina-pill')).toHaveText('Declined');
    await expect(dialog.locator('button[data-action]')).toHaveCount(0);
    // onChange runs the table's liveAction path, so the row changes with no reload.
    await expect(row.locator('.marina-pill')).toHaveText('Declined');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-bookings.spec.ts -g "marina booking detail dialog"`

Expected: the first test fails and the second does not run. The failure message:

```
Error: locator.click: Test timeout of 45000ms exceeded.
  - waiting for locator('#marina-bookings-body tr[data-id="…"]').locator('button[data-action="details"]')
```

The summary reads `1 failed`, `1 did not run`, `1 passed` (the auth setup). The marina is still deactivated by `afterAll`.

- [ ] **Step 3: Create the dialog module**

Create `D/src/scripts/marina-booking-dialog.ts`:

```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { runBookingAction } from './marina-booking-actions';
import { bookingActions, paymentPillHtml, statusPillHtml } from '../lib/marina-logic';
import type { BookingAction, StaffBookingRow } from '../lib/marina-logic';

// GET /api/marina/bookings/:id/documents row (subset read here).
interface MarinaDocument {
  id: string;
  requirement_name: string | null;
  type: string | null;
  file_name: string | null;
  status: string;
  notes: string | null;
  submitted_at: string;
  file_deleted_at: string | null;
}

interface Signature {
  template_id: string | null;
  signer_email: string | null;
  agreed_at: string;
  rendered_body: string | null;
}

type DetailRow = StaffBookingRow & { notes?: string | null; signature: Signature | null };

const ACTION_LABELS: Record<BookingAction, string> = {
  confirm: 'Confirm',
  decline: 'Decline',
  cancel: 'Cancel booking',
  end: 'End stay',
  'send-link': 'Send guest link',
};

const SOURCE_LABELS: Record<string, string> = { guest: 'Guest request', staff: 'Added by staff', import: 'Imported' };

// Document pills reuse the payment-status tones (amber waiting, green done);
// a rejected or unknown status stays muted.
const DOC_TONES: Record<string, string> = { pending: 'hold', verified: 'captured' };
const DOC_LABELS: Record<string, string> = { pending: 'Pending', verified: 'Verified', rejected: 'Rejected' };

let dialog: HTMLDialogElement | null = null;
let titleEl: HTMLElement;
let bodyEl: HTMLElement;
let shownId: string | null = null;
let shown: DetailRow | null = null;
let docs: MarinaDocument[] | null = [];
let onRowChange: (row: StaffBookingRow) => void = () => {};
// Live refreshes and action reloads can overlap; only the newest load may render.
let loadSeq = 0;
// One fetch per document while the dialog is open, so View and Download share the bytes.
const blobs = new Map<string, Blob>();

// arrival/departure are plain YYYY-MM-DD; build a local Date so the day doesn't shift by UTC offset.
function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function money(total: string | null, currency: string | null): string {
  if (total == null) return '—';
  if (!currency) return total;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(total));
  } catch {
    return `${currency} ${total}`;
  }
}

function isAuthError(err: unknown): boolean {
  return err instanceof Error && err.message === 'Not authenticated'; // apiFetch already opened sign-in
}

function docHtml(d: MarinaDocument): string {
  const name = d.requirement_name ?? d.type ?? 'Document';
  const fileTools = d.file_deleted_at
    ? '<span class="reservation-payment-note">File deleted under the retention policy</span>'
    : '<button type="button" data-doc-view>View</button><button type="button" data-doc-download>Download</button>';
  return `
    <li class="mbd-doc" data-doc-id="${escapeHtml(d.id)}">
      <div class="mbd-doc-head">
        <strong>${escapeHtml(name)}</strong>
        <span class="reservation-payment-note">${escapeHtml(d.file_name ?? 'Unnamed file')} · ${escapeHtml(formatDateTime(d.submitted_at))}</span>
        <span class="reservation-payment-status" data-tone="${DOC_TONES[d.status] ?? 'settled'}">${escapeHtml(DOC_LABELS[d.status] ?? 'Unknown')}</span>
      </div>
      <div class="mbd-doc-tools">
        ${fileTools}
        <input type="text" data-doc-notes maxlength="500" value="${escapeHtml(d.notes ?? '')}" placeholder="Notes (optional)" aria-label="Notes for ${escapeHtml(name)}">
        <button type="button" data-doc-status="verified" ${d.status === 'verified' ? 'disabled' : ''}>Verify</button>
        <button type="button" data-doc-status="rejected" ${d.status === 'rejected' ? 'disabled' : ''}>Reject</button>
      </div>
    </li>`;
}

function render(): void {
  const b = shown!;
  titleEl.textContent = b.contact_name;
  const boat = [b.boat_name, b.boat_length_m != null ? `${b.boat_length_m} m` : null].filter(Boolean).join(' · ') || '—';
  const actions = bookingActions(b);
  // Every row renders: a booking has no fixed document count (R23).
  const docsHtml = docs === null
    ? '<p class="reply-inquiry-received">Documents could not be loaded</p>'
    : docs.length === 0
      ? '<p class="reply-inquiry-received">No documents uploaded yet</p>'
      : `<ul class="mbd-docs">${docs.map(docHtml).join('')}</ul>`;
  const sig = b.signature;
  const contractHtml = sig
    ? `<p class="reply-inquiry-received">Agreed ${escapeHtml(formatDateTime(sig.agreed_at))}${sig.signer_email ? ` by ${escapeHtml(sig.signer_email)}` : ''}</p>
       ${typeof sig.rendered_body === 'string' ? '<div class="reservation-notes mbd-contract"></div>' : ''}`
    : '<p class="reply-inquiry-received">Not agreed yet</p>';

  bodyEl.innerHTML = `
    <div class="reservation-summary">
      <span class="reservation-summary-meta">${escapeHtml(b.marina_name)} · Berth ${escapeHtml(b.berth_label)}</span>
      <span class="mbd-pills">${statusPillHtml(b.status)}${paymentPillHtml(b.payment_status)}</span>
    </div>
    ${b.payment_error ? `<p class="mbd-error">Payment problem: ${escapeHtml(b.payment_error)}</p>` : ''}
    <dl class="reservation-detail-grid">
      <div><dt>Arrival</dt><dd>${escapeHtml(formatDate(b.arrival))}</dd></div>
      <div><dt>Departure</dt><dd>${b.departure ? escapeHtml(formatDate(b.departure)) : 'Open-ended'}</dd></div>
      <div><dt>Total</dt><dd>${escapeHtml(money(b.total_price, b.currency))}</dd></div>
      <div><dt>Boat</dt><dd>${escapeHtml(boat)}</dd></div>
      <div><dt>Contact</dt><dd>${escapeHtml(b.contact_name)}</dd></div>
      <div><dt>Email</dt><dd>${escapeHtml(b.contact_email ?? '—')}</dd></div>
      <div><dt>Phone</dt><dd>${escapeHtml(b.contact_phone ?? '—')}</dd></div>
    </dl>
    ${b.notes ? `<div class="reservation-notes"><span class="reservation-field-label">Notes</span>${escapeHtml(b.notes)}</div>` : ''}
    ${actions.length ? `<div class="mbd-actions">${actions.map((a) => `<button type="button" data-action="${a}">${ACTION_LABELS[a]}</button>`).join('')}</div>` : ''}
    <section class="mbd-section"><h3>Documents</h3>${docsHtml}</section>
    <section class="mbd-section"><h3>Contract</h3>${contractHtml}</section>
    <span class="reservation-booked">Booked ${escapeHtml(formatDateTime(b.created_at))} · ${escapeHtml(SOURCE_LABELS[b.source] ?? b.source)}</span>`;

  // The agreed text is the guest's legal record: textContent, never markup.
  const contract = bodyEl.querySelector<HTMLElement>('.mbd-contract');
  if (contract && sig) contract.textContent = sig.rendered_body ?? '';
}

async function load(id: string): Promise<boolean> {
  const seq = ++loadSeq;
  try {
    const [bRes, dRes] = await Promise.all([
      apiFetch(`/api/marina/bookings/${id}`, { cache: 'no-store' }),
      apiFetch(`/api/marina/bookings/${id}/documents`, { cache: 'no-store' }),
    ]);
    const b = await bRes.json().catch(() => null);
    const d = await dRes.json().catch(() => null);
    if (seq !== loadSeq || shownId !== id) return false; // a newer open/refresh owns the dialog now
    if (!bRes.ok || !b || typeof b !== 'object') {
      showToast(`Failed to load booking — ${b?.error ?? 'unknown error'}`, 'error');
      return false;
    }
    shown = b as DetailRow;
    docs = dRes.ok && Array.isArray(d) ? (d as MarinaDocument[]) : null;
    render();
    return true;
  } catch (err) {
    if (!isAuthError(err)) showToast('Failed to load booking', 'error');
    return false;
  }
}

async function docBlob(doc: MarinaDocument): Promise<Blob | null> {
  const cached = blobs.get(doc.id);
  if (cached) return cached;
  const name = doc.file_name ?? 'Document';
  try {
    // Bearer-only route, so an <a href> or a new tab can't load it directly.
    const res = await apiFetch(`/api/marina/documents/${doc.id}/file`, { cache: 'no-store' });
    if (res.status === 410) {
      showToast('File deleted under the retention policy', 'error');
      return null;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      showToast(`${name}: ${data?.error ?? 'Failed to load the file'}`, 'error');
      return null;
    }
    const blob = await res.blob();
    blobs.set(doc.id, blob);
    return blob;
  } catch (err) {
    if (!isAuthError(err)) showToast(`${name}: Failed to load the file`, 'error');
    return null;
  }
}

async function openDoc(doc: MarinaDocument, download: boolean): Promise<void> {
  const blob = await docBlob(doc);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  // The URL pins the bytes in memory; a minute is plenty for the tab or download to read them.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (download) {
    // A blob URL has no file name of its own; the download attribute supplies it.
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.file_name || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (!window.open(url, '_blank')) showToast('Allow pop-ups for this site to view documents', 'warning');
}

async function setDocStatus(btn: HTMLButtonElement, doc: MarinaDocument, status: string, notes: string): Promise<void> {
  const name = doc.requirement_name ?? doc.file_name ?? 'Document';
  const verb = status === 'verified' ? 'verify' : 'reject';
  btn.disabled = true;
  try {
    const res = await apiFetch(`/api/marina/documents/${doc.id}`, {
      method: 'PUT',
      // OTA COALESCEs notes, so a blank box means "leave as is" -- send nothing rather than ''.
      body: JSON.stringify({ status, notes: notes || undefined }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showToast(`${name}: Failed to ${verb} — ${data?.error ?? 'unknown error'}`, 'error');
      return;
    }
    showToast(`${name}: ${status === 'verified' ? 'Verified' : 'Rejected'}`, 'success');
    if (shownId) await load(shownId);
  } catch (err) {
    if (!isAuthError(err)) showToast(`${name}: Failed to ${verb}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function act(btn: HTMLButtonElement, action: BookingAction): Promise<void> {
  if (!shown) return;
  const id = shown.id;
  btn.disabled = true;
  try {
    const row = await runBookingAction(shown, action);
    if (!row) return;
    onRowChange(row);
    // Re-read rather than render the PUT row: it carries no documents or signature.
    if (shownId === id) await load(id);
  } finally {
    btn.disabled = false;
  }
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'marina-booking-dialog';
  dialog.className = 'list-dialog';
  dialog.innerHTML = `
    <div class="list-dialog-header">
      <h2 id="marina-booking-dialog-title">Booking</h2>
      <button class="icon-btn" type="button" title="Close" data-close>✕</button>
    </div>
    <div id="marina-booking-details" class="mbd-body"></div>`;
  document.body.appendChild(dialog);
  titleEl = dialog.querySelector('#marina-booking-dialog-title')!;
  bodyEl = dialog.querySelector('#marina-booking-details')!;

  const d = dialog;
  d.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === d) { d.close(); return; } // backdrop click
    const btn = target.closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled) return;
    if (btn.dataset.close !== undefined) { d.close(); return; }
    if (btn.dataset.action) { void act(btn, btn.dataset.action as BookingAction); return; }
    const li = btn.closest<HTMLElement>('[data-doc-id]');
    const doc = docs?.find((x) => x.id === li?.dataset.docId);
    if (!li || !doc) return;
    if (btn.dataset.docView !== undefined) void openDoc(doc, false);
    else if (btn.dataset.docDownload !== undefined) void openDoc(doc, true);
    else if (btn.dataset.docStatus) {
      const notes = li.querySelector<HTMLInputElement>('[data-doc-notes]')?.value.trim() ?? '';
      void setDocStatus(btn, doc, btn.dataset.docStatus, notes);
    }
  });
  d.addEventListener('close', () => {
    shownId = null;
    shown = null;
    blobs.clear();
  });
  return d;
}

export async function openMarinaBookingDialog(id: string, onChange: (row: StaffBookingRow) => void): Promise<void> {
  const d = ensureDialog();
  shownId = id;
  onRowChange = onChange;
  blobs.clear();
  if ((await load(id)) && !d.open) d.showModal();
}

export function refreshOpenMarinaBookingDialog(row: StaffBookingRow): void {
  // The Ably row has no documents or signature, so re-fetch rather than merge.
  if (dialog?.open && shownId === row.id) void load(row.id);
}
```

- [ ] **Step 4: Wire it into the bookings page**

`D/src/scripts/marina-bookings-client.ts` (as left by Task 11). Below, `applyRow` is Task 11's function that applies one row through `liveAction` (it is shared by its Ably callback and its action buttons). If Task 11 gave it another name, use that name in the edits below.

(a) Add to the import block:

```ts
import { openMarinaBookingDialog, refreshOpenMarinaBookingDialog } from './marina-booking-dialog';
```

(b) In Task 11's `actionButtonsHtml`, put a Details button in front of the action buttons, using the same element as Task 11's buttons. Old:

```ts
  return bookingActions(r)
    .map((a) => `<button type="button" data-action="${a}">${ACTION_LABELS[a]}</button>`)
    .join('');
```

New:

```ts
  return '<button type="button" class="btn-link" data-action="details">Details</button>' + bookingActions(r)
    .map((a) => `<button type="button" data-action="${a}">${ACTION_LABELS[a]}</button>`)
    .join('');
```

(c) At the very top of the `#marina-bookings-body` click listener, before the code that reads `data-action` and calls `runBookingAction`, insert the following. `'details'` is not a `BookingAction`, so it must never reach `runBookingAction`.

```ts
    const clicked = e.target as HTMLElement;
    const detailRow = clicked.closest<HTMLTableRowElement>('tr[data-id]');
    const detailBtn = clicked.closest<HTMLButtonElement>('button[data-action]');
    // The row itself opens the details too, unless the click was on one of its controls.
    if (detailRow && (detailBtn?.dataset.action === 'details' || (!detailBtn && !clicked.closest('a, button, input, select, label')))) {
      void openMarinaBookingDialog(detailRow.dataset.id!, applyRow);
      return;
    }
```

(d) In the live subscription, an open dialog for the same booking must re-fetch, because an upload, a verify or reject, or an agreement changes no table column. Old:

```ts
subscribeMarinaBookings((row) => applyRow(row))
```

New:

```ts
subscribeMarinaBookings((row) => {
  applyRow(row);
  refreshOpenMarinaBookingDialog(row);
})
```

Task 11's callback may also take the `event` argument or a block body. If so, keep its body and add `refreshOpenMarinaBookingDialog(row);` as its last statement.

- [ ] **Step 5: Styles**

Append to the end of `D/src/styles/global.css`:

```css
/* ── Marina booking detail dialog (marina-booking-dialog.ts) ─────────
 * The body scrolls inside the dialog's height cap: a booking can carry
 * any number of documents, plus a full contract text. */
#marina-booking-dialog {
  width: min(760px, 92vw);
  max-height: min(760px, 90vh);
}

.mbd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.mbd-pills,
.mbd-actions,
.mbd-doc-head,
.mbd-doc-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.mbd-error {
  margin: 0;
  color: #ef4444;
  font-size: 0.85rem;
}

.mbd-section h3 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
}

.mbd-docs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

/* One card per document: Verify/Reject and the notes box must read as belonging to that file. */
.mbd-doc {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.mbd-doc-tools input {
  flex: 1;
  min-width: 10rem;
}

.mbd-contract {
  max-height: 240px;
  overflow-y: auto;
}

#marina-bookings-body tr[data-id] {
  cursor: pointer;
}
```

`.reservation-notes` already sets `white-space: pre-wrap` (around `global.css:4588`), so the contract text keeps its line breaks.

- [ ] **Step 6: Logic check and build**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`
Expected: `check-marina: ok`. This task adds no pure logic; the run confirms nothing regressed.

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npm run build`
Expected: exit 0, ending with `[build] Complete!`.

- [ ] **Step 7: Run the spec and watch it pass**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-bookings.spec.ts`

Expected: every test passes, including Tasks 10–11's tests and these two:
- `marina booking detail dialog › details shows the payment pill, empty documents and an unsigned contract`
- `marina booking detail dialog › declining inside the dialog updates the table row`

The run ends with `N passed` and no failures.

- [ ] **Step 8: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/scripts/marina-booking-dialog.ts src/scripts/marina-bookings-client.ts src/styles/global.css tests/marina-bookings.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: booking detail dialog with documents, contract and payment" -m "Details button and row click open a dialog that reads GET /api/marina/bookings/:id and its documents list (every row, no count cap): status and payment pills, payment_error, boat/contact/dates, the row's actions through runBookingAction, documents with bearer blob view/download (410 toasts the retention message) and verify/reject with notes, and the agreed contract text as textContent. Live events re-fetch an open dialog for the same booking, since uploads, verifies and agreements change no table column." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do not push. Deploying D is a runbook step after plan C.

---

### Task 13: Dashboard — /marina branch: tiles, staff map, berth side panel, live

Repo `D` (`C:/Users/robert/source/repos/ota-table-bookings`), branch `main`. Implements R21, R22, N1, N2. Builds on Tasks 5–12 (vendored 1.1.0 + legacy alias, `loadMarinas`, `mountStaffMap`, `propertyToday`/`addDays`, `pickMarina`/`MARINA_STORAGE_KEY`, `statusPillHtml`, `bookingActions`, `subscribeMarinaBookings`, `runBookingAction`, `openMarinaBookingDialog`/`refreshOpenMarinaBookingDialog`, the Playwright helpers).

**Files:**
- Modify: `D/src/lib/marina-logic.ts`: append the Task 13 exports at the end of the file, after Task 11's `bookingActions`.
- Modify: `D/scripts/check-marina.ts`: add one import line directly below the existing `from '../src/lib/marina-logic.ts'` import, and two blocks directly above the final `console.log('check-marina: ok');`.
- Rename + modify: `D/src/scripts/marina-client.ts` → `D/src/scripts/marina-interim.ts` (`git mv`). The interim code is unchanged except that its line-1 static element import (`import 'sidon-booking-widget-legacy/berth-map';`, from Task 5) becomes a top-level `await import(...)`.
- Create: `D/src/scripts/marina-client.ts`: the router (whole file below).
- Create: `D/src/scripts/marina-dashboard.ts`.
- Modify: `D/src/pages/marina.astro`: whole file (currently 80 lines) replaced. It keeps `prerender = true` and the interim markup and ids.
- Modify: `D/tests/marina-interim.spec.ts`: add one import line below the `@playwright/test` import, and append a `/marina branch` describe at the end of the file.
- Create: `D/tests/marina.spec.ts`.

**Interfaces:**
- Consumes:
  - `isUuid`-era types `MarinaStatus` and `StaffBookingRow` (Task 5).
  - `propertyToday` and `addDays` (Task 8).
  - `MARINA_STORAGE_KEY` and `pickMarina` (Task 7).
  - `statusPillHtml` (Task 10).
  - `bookingActions` and `BookingAction` (Task 11).
  - `loadProperty()` (typed with `timezone`) and `loadMarinas(): Promise<MarinaRow[]>` from `sidebar-modules-widget.ts` (Task 5).
  - `mountStaffMap(host, slug, timeZone, height = '60svh')` (Task 8).
  - `subscribeMarinaBookings(onRow)` (Task 11) and `runBookingAction(row, action)` (Task 11).
  - `openMarinaBookingDialog(id, onChange)` and `refreshOpenMarinaBookingDialog(row)` (Task 12).
  - Helpers `uniqueSlug`, `createMarinaViaUi`, `deactivateMarinaViaUi` (Task 6), `importBerthsCsvViaUi` (Task 7) and `createBookingViaUi` (Task 10).
  - OTA routes:
    - `GET /api/marina/bookings?marina_id&from&to&limit=500` and `?status=pending&marina_id&limit=1` → `{total, data}`
    - `GET /api/marina/marinas/:id/berths?include_inactive=1` → bare array
    - `GET /api/marina/bookings?berth_id&from&limit=500`
    - `GET /api/marina/guest/:slug?from&to` → `{ berths: [{ label, available }] }`
- Produces:
  ```ts
  export function tileCounts(rows: StaffBookingRow[], today: string): { arrivals: number; departures: number; onBerth: number };
  export function matchBerthPanel(rows: StaffBookingRow[], label: string, today: string, occupiedOnMap: boolean):
    { current: StaffBookingRow | null; next: StaffBookingRow | null; heldOrMaintenance: boolean };
  ```
  - The `marina-client.ts` router.
  - DOM ids: `#marina-dashboard`, `#marina-dashboard-actions`, `#marina-select`, `#marina-stat-arrivals`, `#marina-stat-departures`, `#marina-stat-onberth`, `#marina-stat-pending`, `#marina-staff-map`, `<dialog id="marina-berth-panel" class="config-sheet">` (with `#marina-berth-panel-title`, `#marina-berth-panel-close` and `#marina-berth-panel-body`), and panel slots `[data-slot="current"|"next"]`.
  - Header links `a[href="/marina-bookings"]` and `a[href="/marina-setup"]`.
  - The interim ids (`#marina-empty`, `#marina-map`, `#marina-bookings`) are unchanged.

- [ ] **Step 1: Write the failing checks (Review Focus 1)**

In `D/scripts/check-marina.ts`, add this line directly below the existing `marina-logic.ts` import. It imports values only: the row type is derived from the signature, so this line cannot clash with a `type StaffBookingRow` import from an earlier task.

```ts
import { tileCounts, matchBerthPanel } from '../src/lib/marina-logic.ts';
```

Insert directly above `console.log('check-marina: ok');`:

```ts
// Task 13 fixtures: the marina property's yesterday / today / tomorrow are
// 2026-10-11 / 2026-10-12 / 2026-10-13. Rows are what the tile window call
// (?from=<yesterday>&to=<tomorrow>) and the berth call return.
type T13Row = Parameters<typeof tileCounts>[0][number];
const t13Row = (id: string, over: Partial<T13Row>): T13Row => ({
  id, marina_id: 'm1', marina_name: 'Marina', berth_id: `berth-${over.berth_label ?? 'A1'}`, berth_label: 'A1',
  contact_name: id, contact_email: null, contact_phone: null, boat_name: null, boat_length_m: null,
  arrival: '2026-10-12', departure: '2026-10-13', status: 'confirmed', source: 'staff',
  total_price: null, currency: null, payment_status: 'none', payment_error: null, hold_expires_at: null,
  created_at: '2026-10-01T09:00:00Z', ...over,
});
const t13Rows: T13Row[] = [
  t13Row('departs-today', { berth_label: 'A1', arrival: '2026-10-05', departure: '2026-10-12' }),
  t13Row('arrives-today', { berth_label: 'A1', arrival: '2026-10-12', departure: '2026-10-15' }),
  // Listed before the earlier one so "next" has to sort, not take the first.
  t13Row('arrives-later', { berth_label: 'A1', arrival: '2026-10-20', departure: '2026-10-22' }),
  t13Row('arrives-next', { berth_label: 'A1', arrival: '2026-10-15', departure: '2026-10-17', status: 'pending' }),
  t13Row('open-ended', { berth_label: 'B1', arrival: '2026-09-01', departure: null }),
  t13Row('arrives-tomorrow', { berth_label: 'B2', arrival: '2026-10-13', departure: '2026-10-14' }),
  t13Row('pending-today', { berth_label: 'C1', arrival: '2026-10-12', departure: '2026-10-14', status: 'pending' }),
  t13Row('pending-leaving', { berth_label: 'C2', arrival: '2026-10-10', departure: '2026-10-12', status: 'pending' }),
  t13Row('left-yesterday', { berth_label: 'C3', arrival: '2026-10-08', departure: '2026-10-11' }),
  t13Row('cancelled', { berth_label: 'D1', arrival: '2026-10-12', departure: '2026-10-13', status: 'cancelled' }),
  t13Row('declined', { berth_label: 'D1', arrival: '2026-10-11', departure: null, status: 'declined' }),
];

// ---- tileCounts ----
{
  // Today: arrivals = arrives-today + pending-today (a pending arrival is
  // still expected); departures = departs-today only (confirmed; a pending
  // "departure" never arrived); on berth = arrives-today + open-ended.
  // departs-today is a departure but NOT on berth; cancelled/declined ignored.
  assert.deepEqual(tileCounts(t13Rows, '2026-10-12'), { arrivals: 2, departures: 1, onBerth: 2 });
  // The same rows seen tomorrow.
  assert.deepEqual(tileCounts(t13Rows, '2026-10-13'), { arrivals: 1, departures: 0, onBerth: 3 });
  assert.deepEqual(tileCounts([], '2026-10-12'), { arrivals: 0, departures: 0, onBerth: 0 });
}

// ---- matchBerthPanel ----
{
  const a1 = matchBerthPanel(t13Rows, 'A1', '2026-10-12', true);
  assert.equal(a1.current?.id, 'arrives-today'); // departs-today has left: not current
  assert.equal(a1.next?.id, 'arrives-next');     // earliest future, pending counts
  assert.equal(a1.heldOrMaintenance, false);     // occupied, but a booking explains it

  const b1 = matchBerthPanel(t13Rows, 'B1', '2026-10-12', true);
  assert.equal(b1.current?.id, 'open-ended');
  assert.equal(b1.next, null);
  assert.equal(b1.heldOrMaintenance, false);

  assert.equal(matchBerthPanel(t13Rows, 'C1', '2026-10-12', true).current?.id, 'pending-today');

  // Only cancelled/declined rows: nothing live. Occupied on the map → a hold or maintenance.
  assert.deepEqual(matchBerthPanel(t13Rows, 'D1', '2026-10-12', true), { current: null, next: null, heldOrMaintenance: true });
  assert.deepEqual(matchBerthPanel(t13Rows, 'D1', '2026-10-12', false), { current: null, next: null, heldOrMaintenance: false });

  // Labels match exactly (the map's label is the OTA label).
  assert.equal(matchBerthPanel(t13Rows, 'a1', '2026-10-12', false).current, null);

  // Turnover day: arrives-today leaves on 15th, arrives-next starts on the 15th.
  const turn = matchBerthPanel(t13Rows, 'A1', '2026-10-15', true);
  assert.equal(turn.current?.id, 'arrives-next');
  assert.equal(turn.next?.id, 'arrives-later');
}
```

- [ ] **Step 2: Run the check and confirm it fails**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected failure (exit code 1):
```
SyntaxError: The requested module '../src/lib/marina-logic.ts' does not provide an export named 'tileCounts'
```

- [ ] **Step 3: Implement `tileCounts` and `matchBerthPanel`**

Append to `D/src/lib/marina-logic.ts`:

```ts
// ---- Task 13: /marina tiles and berth side panel ----

// Statuses that hold a berth in the staff view. Holds never reach the staff
// list; declined and cancelled free the berth.
const LIVE_STATUSES: ReadonlySet<MarinaStatus> = new Set<MarinaStatus>(['pending', 'confirmed']);

// `today` is the marina property's day (propertyToday), never the viewer's,
// so a departure today still counts as one when the viewer's clock has
// already rolled over. Only a confirmed stay is physically on the berth; a
// pending arrival is still expected, so it counts as an arrival.
export function tileCounts(rows: StaffBookingRow[], today: string): { arrivals: number; departures: number; onBerth: number } {
  let arrivals = 0;
  let departures = 0;
  let onBerth = 0;
  for (const r of rows) {
    if (r.arrival === today && LIVE_STATUSES.has(r.status)) arrivals++;
    if (r.status !== 'confirmed') continue;
    if (r.departure === today) departures++;
    if (r.arrival <= today && (r.departure === null || r.departure > today)) onBerth++;
  }
  return { arrivals, departures, onBerth };
}

// `occupiedOnMap` is the guest map payload's `available === false` for this
// berth tonight. That payload paints holds and maintenance the same way as
// bookings (R3), so "occupied but no live booking" means a guest checkout
// hold or a berth in maintenance.
export function matchBerthPanel(rows: StaffBookingRow[], label: string, today: string, occupiedOnMap: boolean):
  { current: StaffBookingRow | null; next: StaffBookingRow | null; heldOrMaintenance: boolean } {
  const live = rows.filter((r) => LIVE_STATUSES.has(r.status) && r.berth_label === label);
  const current = live.find((r) => r.arrival <= today && (r.departure === null || r.departure > today)) ?? null;
  const next = live
    .filter((r) => r.arrival > today)
    .reduce<StaffBookingRow | null>((best, r) => (best === null || r.arrival < best.arrival ? r : best), null);
  return { current, next, heldOrMaintenance: occupiedOnMap && current === null };
}
```

- [ ] **Step 4: Run the check and confirm it passes**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`

Expected: `check-marina: ok`

- [ ] **Step 5: Write the Playwright specs (they fail until the page exists)**

Create `D/tests/marina.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { MARINA_STORAGE_KEY, addDays, propertyToday } from '../src/lib/marina-logic';
import { createBookingViaUi, createMarinaViaUi, deactivateMarinaViaUi, importBerthsCsvViaUi, uniqueSlug } from './marina-helpers';

// One serial chain like rooms.spec.ts: a fresh marina with two berths, then
// bookings that move the tiles and fill the berth panel. OTA has no delete
// routes, so afterAll deactivates the marina through the UI.
test.describe.serial('/marina dashboard', () => {
  const slug = uniqueSlug('pw-marina-dash');
  let marinaId = '';
  // The marina property's day, from its own timezone: the test machine's
  // clock may be on a different date near midnight.
  let today = '';

  test.afterAll(async ({ browser }) => {
    if (!marinaId) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  // pickMarina prefers the remembered id. Without that, an older test
  // marina could be the "first" one, and the tiles would count its bookings.
  async function openDashboard(page: Page) {
    await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [MARINA_STORAGE_KEY, marinaId]);
    await page.goto('/marina');
    await expect(page.locator('#marina-dashboard')).toBeVisible();
  }

  async function dispatchBerth(page: Page, berthId: string | null) {
    await page.locator('#marina-staff-map > sidon-berth-map').evaluate((el, id) => {
      el.dispatchEvent(new CustomEvent('sidon-berth-selected', { detail: { berthId: id }, bubbles: true, composed: true }));
    }, berthId);
  }

  test('create a marina with two berths', async ({ page }) => {
    marinaId = await createMarinaViaUi(page, { name: `Playwright Dashboard ${slug}`, slug });
    await importBerthsCsvViaUi(page, marinaId, 'label,length_m,price_per_night\nA1,15,40\nA2,15,40\n');
    const me = page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/api/property/me'));
    await page.goto('/marina');
    today = propertyToday((await (await me).json()).timezone);
  });

  test('tiles start at zero', async ({ page }) => {
    await openDashboard(page);
    for (const id of ['arrivals', 'departures', 'onberth', 'pending']) {
      await expect(page.locator(`#marina-stat-${id}`)).toHaveText('0');
    }
  });

  test('a confirmed booking arriving today moves arrivals and on berth', async ({ page }) => {
    await createBookingViaUi(page, {
      marinaId, berthLabel: 'A1', arrival: today, departure: addDays(today, 2),
      status: 'confirmed', contactName: 'PW Arrival Today',
    });
    await openDashboard(page);
    await expect(page.locator('#marina-stat-arrivals')).toHaveText('1');
    await expect(page.locator('#marina-stat-onberth')).toHaveText('1');
    await expect(page.locator('#marina-stat-departures')).toHaveText('0');
    await expect(page.locator('#marina-stat-pending')).toHaveText('0');
  });

  test('a pending request moves the pending tile', async ({ page }) => {
    await createBookingViaUi(page, {
      marinaId, berthLabel: 'A2', arrival: addDays(today, 5), departure: addDays(today, 7),
      status: 'pending', contactName: 'PW Pending', contactEmail: 'pw-pending@example.com',
    });
    await openDashboard(page);
    await expect(page.locator('#marina-stat-pending')).toHaveText('1');
    await expect(page.locator('#marina-stat-arrivals')).toHaveText('1');
  });

  test('header links navigate', async ({ page }) => {
    await openDashboard(page);
    await page.locator('.page-header a[href="/marina-bookings"]').click();
    await expect(page).toHaveURL(/\/marina-bookings$/);
    await openDashboard(page);
    await page.locator('.page-header a[href="/marina-setup"]').click();
    await expect(page).toHaveURL(/\/marina-setup/);
  });

  test('a berth click opens the side panel with its bookings', async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator('#marina-staff-map > sidon-berth-map')).toHaveCount(1);
    const panel = page.locator('#marina-berth-panel');

    await dispatchBerth(page, 'A1');
    await expect(panel).toBeVisible();
    await expect(page.locator('#marina-berth-panel-title')).toHaveText('Berth A1');
    await expect(panel.locator('[data-slot="current"]')).toContainText('PW Arrival Today');

    // A pending next booking carries the quick approve/decline pair.
    await dispatchBerth(page, 'A2');
    await expect(page.locator('#marina-berth-panel-title')).toHaveText('Berth A2');
    await expect(panel.locator('[data-slot="current"]')).toHaveText('Free tonight');
    await expect(panel.locator('[data-slot="next"]')).toContainText('PW Pending');
    await expect(panel.locator('[data-slot="next"] button[data-action="confirm"]')).toBeVisible();
    await expect(panel.locator('[data-slot="next"] button[data-action="decline"]')).toBeVisible();

    // Deselect on the map ({berthId: null}) closes the panel.
    await dispatchBerth(page, null);
    await expect(panel).toBeHidden();
  });
});
```

In `D/tests/marina-interim.spec.ts`, add below the `@playwright/test` import:

```ts
import { MARINA_STORAGE_KEY } from '../src/lib/marina-logic';
import { createMarinaViaUi, deactivateMarinaViaUi, uniqueSlug } from './marina-helpers';
```

Append at the end of the file:

```ts
// R21/N1: the branch follows the property's REAL active OTA marinas (the
// simulated Pirates Bight cases above fulfil the list with []). Each branch
// loads only its own <sidon-berth-map> package.
test.describe.serial('/marina branch', () => {
  const slug = uniqueSlug('pw-marina-branch');
  let marinaId = '';
  let deactivated = false;

  test.afterAll(async ({ browser }) => {
    if (!marinaId || deactivated) return;
    const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
    const page = await context.newPage();
    try {
      await deactivateMarinaViaUi(page, marinaId);
    } finally {
      await context.close();
    }
  });

  test('an active OTA marina gets the dashboard and never calls Sidon', async ({ page }) => {
    marinaId = await createMarinaViaUi(page, { name: `Playwright Branch ${slug}`, slug });
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [MARINA_STORAGE_KEY, marinaId]);
    const mapPayload = page.waitForResponse((res) => res.url().includes(`/api/marina/guest/${slug}`));
    await page.goto('/marina');

    await expect(page.locator('#marina-dashboard')).toBeVisible();
    await expect(page.locator('#marina-staff-map > sidon-berth-map')).toHaveCount(1);
    await mapPayload;
    expect(await page.evaluate(() => !!customElements.get('sidon-berth-map'))).toBe(true);
    await expect(page.locator('#marina-map')).toBeEmpty();
    await expect(page.locator('#marina-empty')).toBeHidden();
    await expect(page.locator('#marina-bookings')).toBeHidden();
    expect(urls.filter((u) => u.includes('marina.sidonmarine.uk'))).toEqual([]);
  });

  test('with no active OTA marina the interim page returns', async ({ page }) => {
    await deactivateMarinaViaUi(page, marinaId);
    deactivated = true;
    const urls: string[] = [];
    page.on('request', (req) => urls.push(req.url()));
    const list = page.waitForResponse(
      (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/marina/marinas'
    );
    await page.goto('/marina');
    const marinas: { id: string }[] = await (await list).json();
    expect(marinas.some((m) => m.id === marinaId)).toBe(false);
    test.skip(marinas.length > 0, 'an active OTA marina is left over from an aborted run; deactivate it in Settings → Marina');

    // The test account has no Sidon id, so the interim page shows its empty state.
    await expect(page.locator('#marina-empty')).toBeVisible();
    await expect(page.locator('#marina-dashboard')).toBeHidden();
    expect(urls.filter((u) => u.includes('/api/marina/guest/'))).toEqual([]);
  });
});
```

Run with the local stack up (OTA `cd C:/Users/robert/source/repos/OTA && npm run dev`; dashboard `cd C:/Users/robert/source/repos/ota-table-bookings && npx astro dev --background`):
`cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina.spec.ts tests/marina-interim.spec.ts`

Expected failure:
- `/marina dashboard › tiles start at zero` and `/marina branch › an active OTA marina gets the dashboard…` both fail with `expect(locator).toBeVisible() failed … Locator: locator('#marina-dashboard') … element(s) not found`.
- In each serial describe, the tests after the failing one are reported as `did not run`.
- The Task 5 interim cases still pass.

- [ ] **Step 6: Move the interim code into `marina-interim.ts`**

Run: `git -C C:/Users/robert/source/repos/ota-table-bookings mv src/scripts/marina-client.ts src/scripts/marina-interim.ts`

`D/src/scripts/marina-interim.ts` must then read exactly as follows. The only changes from Task 5's file are the removed static import, the added comment and the added `await import(...)`:

```ts
import { apiFetch, escapeHtml } from './api-client';
import { todayStr } from './date-utils';
import { loadProperty } from './sidebar-modules-widget';

// Unifying OTA and sidon-marina, interim: the berth map reads Sidon's
// public marina API, and bookings come through OTA's GET /api/marina/sidon-bookings
// proxy (which holds the marina's Sidon key server-side).
//
// Loaded only by marina-client.ts when the property has no active OTA
// marina. The 0.4.17 element comes in through the legacy alias, dynamically,
// because 1.1 defines the same <sidon-berth-map> tag and the two must never
// share a page (N1). Plan D deletes this file with the alias.
await import('sidon-booking-widget-legacy/berth-map');

const SIDON_API_ORIGIN = 'https://marina.sidonmarine.uk';

type MarinaBooking = {
  id: number;
  berth_id: string;
  sailor_name: string;
  sailor_email: string;
  boat_name: string;
  boat_loa: number | null;
  arrival_date: string;
  departure_date: string;
  nights: number;
  status: string;
  expires_at: string | null;
};

const emptyEl = document.getElementById('marina-empty') as HTMLElement;
const bookingsSection = document.getElementById('marina-bookings') as HTMLElement;
const bookingsMessage = document.getElementById('marina-bookings-message') as HTMLElement;
const bookingsTable = document.getElementById('marina-bookings-table') as HTMLTableElement;
const bookingsBody = document.getElementById('marina-bookings-body') as HTMLTableSectionElement;

function mountMap(marinaId: string) {
  const mapsApiKey = import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!mapsApiKey) {
    emptyEl.textContent = 'The berth map needs PUBLIC_GOOGLE_MAPS_API_KEY set on this deployment.';
    emptyEl.hidden = false;
    return;
  }
  const map = document.createElement('sidon-berth-map');
  map.setAttribute('marina', marinaId);
  map.setAttribute('api-origin', SIDON_API_ORIGIN);
  map.setAttribute('maps-api-key', mapsApiKey);
  map.setAttribute('map-height', '60svh');
  map.setAttribute('locale', 'en');
  document.getElementById('marina-map')!.append(map);
}

function showBookingsMessage(text: string) {
  bookingsMessage.textContent = text;
  bookingsMessage.hidden = false;
  bookingsTable.hidden = true;
}

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// Still on a berth or yet to arrive, and still live: cancelled/declined
// rows and pending holds past their expiry (Sidon treats those as free
// too -- see its create-intent.ts) are dropped.
function isUpcoming(b: MarinaBooking, today: string, now: number): boolean {
  if (b.departure_date < today) return false;
  if (b.status === 'cancelled' || b.status === 'declined') return false;
  if (b.status === 'pending' && b.expires_at && Date.parse(b.expires_at) < now) return false;
  return true;
}

async function loadBookings(keySet: boolean) {
  bookingsSection.hidden = false;
  if (!keySet) {
    showBookingsMessage("Add the marina's Sidon API key in Settings → Modules to see its bookings here.");
    return;
  }
  const res = await apiFetch('/api/marina/sidon-bookings', { cache: 'no-store' }).catch(() => null);
  const data = res ? await res.json().catch(() => null) : null;
  if (!res?.ok || !Array.isArray(data)) {
    showBookingsMessage(`Couldn't load bookings — ${data?.error ?? 'unknown error'}`);
    return;
  }

  const today = todayStr();
  const now = Date.now();
  const upcoming = (data as MarinaBooking[])
    .filter((b) => isUpcoming(b, today, now))
    .sort((a, b) => a.arrival_date.localeCompare(b.arrival_date) || a.berth_id.localeCompare(b.berth_id));
  if (!upcoming.length) {
    showBookingsMessage('No upcoming bookings.');
    return;
  }

  bookingsBody.innerHTML = upcoming.map((b) => `
    <tr>
      <td>${escapeHtml(formatDate(b.arrival_date))}</td>
      <td>${escapeHtml(formatDate(b.departure_date))}</td>
      <td>${escapeHtml(b.nights)}</td>
      <td>${escapeHtml(b.berth_id)}</td>
      <td>${escapeHtml(b.boat_name)}${b.boat_loa ? ` <span class="muted-text">${escapeHtml(b.boat_loa)} m</span>` : ''}</td>
      <td>${escapeHtml(b.sailor_name)}<br /><span class="muted-text">${escapeHtml(b.sailor_email)}</span></td>
      <td class="status">${escapeHtml(b.status)}</td>
    </tr>
  `).join('');
  bookingsMessage.hidden = true;
  bookingsTable.hidden = false;
}

const property = await loadProperty();
const marinaId = property?.sidon_marina_id;
if (!marinaId) {
  emptyEl.hidden = false;
} else {
  mountMap(marinaId);
  loadBookings(!!property?.sidon_marina_key_set);
}
```

- [ ] **Step 7: Create the router `D/src/scripts/marina-client.ts`**

```ts
import { loadMarinas } from './sidebar-modules-widget';

// /marina branches on the property's active OTA marinas (R21), which is
// what makes the dashboard safe to deploy before Switch. Properties with
// none (Pirates Bight: a Sidon id, no OTA marina) keep the interim page
// unchanged. Each branch is a dynamic import so only one
// <sidon-berth-map> package is ever loaded: 1.1 and the 0.4.17 legacy
// alias define the same tag (N1). loadMarinas() is the same memoised fetch
// the sidebar's nav rule uses, and it is [] when signed out or on failure.
const marinas = await loadMarinas();
marinas.length ? await import('./marina-dashboard') : await import('./marina-interim');
```

- [ ] **Step 8: Replace `D/src/pages/marina.astro`**

```astro
---
export const prerender = true;
import { Show } from '@clerk/astro/components';
import Layout from '../layouts/Layout.astro';
// Material Symbols (Outlined) per-icon SVGs, as on restaurant-dashboard.astro;
// each one was checked to exist in node_modules/@material-symbols/svg-400/outlined/.
import arrivalsIcon from '@material-symbols/svg-400/outlined/login.svg?raw';
import departuresIcon from '@material-symbols/svg-400/outlined/logout.svg?raw';
import onBerthIcon from '@material-symbols/svg-400/outlined/anchor.svg?raw';
import pendingIcon from '@material-symbols/svg-400/outlined/pending_actions.svg?raw';
---
<Layout title="Marina — Table Bookings">
  <Show when="signed-in">
    <div class="page-header">
      <h1>Marina</h1>
      <!-- Dashboard branch only (marina-dashboard.ts unhides it). R20: the
           bookings and setup pages are reached from here, not the nav. -->
      <div id="marina-dashboard-actions" class="page-header-actions" hidden>
        <select id="marina-select" aria-label="Marina" hidden></select>
        <a class="btn-link" href="/marina-bookings">Bookings</a>
        <a class="btn-link" href="/marina-setup">Setup</a>
      </div>
    </div>

    <!-- Interim page (marina-interim.ts): unchanged until plan D. On the
         dashboard branch nothing here is unhidden or filled. -->
    <div class="marina-page">
      <p id="marina-empty" class="chart-card-subtitle" hidden>
        No marina linked yet. Add your Sidon marina ID in <a href="/settings">Settings → Modules</a>.
      </p>
      <!-- <sidon-berth-map> (the 0.4.17 element through the
           sidon-booking-widget-legacy alias) is created here once the
           property's sidon_marina_id is known. -->
      <div id="marina-map" class="marina-map"></div>

      <section id="marina-bookings" class="marina-bookings" hidden>
        <h2>Upcoming bookings</h2>
        <p id="marina-bookings-message" class="chart-card-subtitle" hidden></p>
        <table id="marina-bookings-table" hidden>
          <thead>
            <tr>
              <th class="col-narrow">Arrival</th>
              <th class="col-narrow">Departure</th>
              <th class="col-narrow">Nights</th>
              <th class="col-narrow">Berth</th>
              <th class="col-grow">Boat</th>
              <th>Sailor</th>
              <th class="col-narrow">Status</th>
            </tr>
          </thead>
          <tbody id="marina-bookings-body"></tbody>
        </table>
      </section>
    </div>

    <!-- Dashboard (marina-dashboard.ts), for a property with >=1 active OTA
         marina. The tiles reuse the four 4-tile accents, so no new CSS. -->
    <div id="marina-dashboard" class="marina-page" hidden>
      <div class="stat-tiles">
        <div class="stat-tile stat-tile--orders">
          <div class="stat-tile-text">
            <span class="stat-tile-label">Arrivals today</span>
            <span class="stat-tile-value" id="marina-stat-arrivals">–</span>
          </div>
          <span class="stat-tile-icon" set:html={arrivalsIcon} />
        </div>
        <div class="stat-tile stat-tile--revenue">
          <div class="stat-tile-text">
            <span class="stat-tile-label">Departures today</span>
            <span class="stat-tile-value" id="marina-stat-departures">–</span>
          </div>
          <span class="stat-tile-icon" set:html={departuresIcon} />
        </div>
        <div class="stat-tile stat-tile--active">
          <div class="stat-tile-text">
            <span class="stat-tile-label">On berth now</span>
            <span class="stat-tile-value" id="marina-stat-onberth">–</span>
          </div>
          <span class="stat-tile-icon" set:html={onBerthIcon} />
        </div>
        <div class="stat-tile stat-tile--reservations">
          <div class="stat-tile-text">
            <span class="stat-tile-label">Pending approvals</span>
            <span class="stat-tile-value" id="marina-stat-pending">–</span>
          </div>
          <span class="stat-tile-icon" set:html={pendingIcon} />
        </div>
      </div>

      <!-- mountStaffMap puts <sidon-berth-map mode="staff"> (widget 1.1) here. -->
      <div id="marina-staff-map" class="marina-map"></div>
    </div>

    <dialog id="marina-berth-panel" class="config-sheet" aria-labelledby="marina-berth-panel-title">
      <div class="config-sheet-header">
        <h2 id="marina-berth-panel-title">Berth</h2>
        <button id="marina-berth-panel-close" class="icon-btn" type="button" title="Close">✕</button>
      </div>
      <div id="marina-berth-panel-body" class="config-sheet-body"></div>
    </dialog>

    <script src="../scripts/marina-client.ts"></script>
  </Show>
</Layout>

<style>
  .marina-page {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .marina-map {
    border-radius: 12px;
    overflow: hidden;
  }

  .marina-map:empty {
    display: none;
  }

  .marina-bookings h2 {
    margin-top: 0;
  }

  /* Rows are built in marina-interim.ts, outside this component's scope.
     .col-narrow only reaches the header cells, so the body cells need their
     own nowrap -- Boat (col-grow) takes the slack instead. */
  .marina-bookings :global(td) {
    white-space: nowrap;
  }

  .marina-bookings :global(.muted-text) {
    color: var(--muted);
  }

  /* Panel sections are built in marina-dashboard.ts. */
  #marina-berth-panel :global(.marina-panel-actions) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  /* [hidden] specificity trap: these carry their own display
     (.marina-page and .page-header-actions are flex). */
  .marina-page [hidden],
  .marina-page[hidden],
  .page-header [hidden] {
    display: none;
  }
</style>
```

- [ ] **Step 9: Create `D/src/scripts/marina-dashboard.ts`**

```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { loadMarinas, loadProperty } from './sidebar-modules-widget';
import { mountStaffMap } from './marina-staff-map';
import { subscribeMarinaBookings } from './marina-live';
import { runBookingAction } from './marina-booking-actions';
import { openMarinaBookingDialog, refreshOpenMarinaBookingDialog } from './marina-booking-dialog';
import {
  MARINA_STORAGE_KEY,
  addDays,
  bookingActions,
  matchBerthPanel,
  pickMarina,
  propertyToday,
  statusPillHtml,
  tileCounts,
  type BookingAction,
  type StaffBookingRow,
} from '../lib/marina-logic';

// /marina for a property with at least one active OTA marina (R21, R22).
// Only marina-client.ts imports this module, and only on that branch, so
// the legacy Sidon element never shares the page with the 1.1 element
// that mountStaffMap loads (N1). Every "today" here is the marina
// property's day, never the viewer's todayStr().

type StaffMap = HTMLElement & { refresh?: () => void };
type PanelState = ReturnType<typeof matchBerthPanel>;

const dashboardEl = document.getElementById('marina-dashboard') as HTMLElement;
const actionsEl = document.getElementById('marina-dashboard-actions') as HTMLElement;
const selectEl = document.getElementById('marina-select') as HTMLSelectElement;
const mapHost = document.getElementById('marina-staff-map') as HTMLElement;
const panel = document.getElementById('marina-berth-panel') as HTMLDialogElement;
const panelTitle = document.getElementById('marina-berth-panel-title') as HTMLElement;
const panelBody = document.getElementById('marina-berth-panel-body') as HTMLElement;
const tiles = {
  arrivals: document.getElementById('marina-stat-arrivals') as HTMLElement,
  departures: document.getElementById('marina-stat-departures') as HTMLElement,
  onBerth: document.getElementById('marina-stat-onberth') as HTMLElement,
  pending: document.getElementById('marina-stat-pending') as HTMLElement,
};

const property = await loadProperty();
const timeZone = property?.timezone;
const marinas = await loadMarinas();
// Non-null: marina-client.ts only imports this module when the list is non-empty.
let marina = pickMarina(marinas, localStorage.getItem(MARINA_STORAGE_KEY))!;
let map: StaffMap | null = null;
// The berth the open panel shows (null while it's closed), and the rows it
// rendered, so a button click finds its booking without another fetch.
let panelLabel: string | null = null;
let panelRows = new Map<string, StaffBookingRow>();
// Bumped on every load, so a slow response for a marina or berth the user
// has since left never overwrites the current one.
let tilesSeq = 0;
let panelSeq = 0;

const today = () => propertyToday(timeZone);

async function getJson(path: string): Promise<any> {
  const res = await apiFetch(path, { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

async function loadTiles() {
  const seq = ++tilesSeq;
  const t = today();
  const id = encodeURIComponent(marina.id);
  try {
    // The [yesterday, tomorrow) window (`from` matches departure > from)
    // holds every stay touching today, including today's departures.
    // Pending approvals are every pending request for the marina, not only
    // this window's, so that tile reads the route's total (N2).
    const [win, pending] = await Promise.all([
      getJson(`/api/marina/bookings?marina_id=${id}&from=${addDays(t, -1)}&to=${addDays(t, 1)}&limit=500`),
      getJson(`/api/marina/bookings?status=pending&marina_id=${id}&limit=1`),
    ]);
    if (seq !== tilesSeq) return;
    const counts = tileCounts(win.data, t);
    tiles.arrivals.textContent = String(counts.arrivals);
    tiles.departures.textContent = String(counts.departures);
    tiles.onBerth.textContent = String(counts.onBerth);
    tiles.pending.textContent = String(pending.total);
  } catch (err) {
    if (seq === tilesSeq) showToast(`Couldn't load marina stats — ${(err as Error).message}`, 'error');
  }
}

function bookingHtml(slot: 'current' | 'next', heading: string, b: StaffBookingRow): string {
  // Only the approve/decline pair belongs beside the map. Cancel, end and
  // send-link live on /marina-bookings and in the detail dialog.
  const quick = bookingActions(b).filter((a) => a === 'confirm' || a === 'decline');
  const boat = [b.boat_name, b.boat_length_m ? `${b.boat_length_m} m` : null].filter(Boolean).join(' · ');
  return `
    <section class="config-section" data-slot="${slot}" data-id="${escapeHtml(b.id)}">
      <div class="config-section-header config-section-header--actions">
        <h3>${heading}</h3>
        ${statusPillHtml(b.status)}
      </div>
      <div class="config-row">
        <strong>${escapeHtml(b.contact_name)}</strong>
        ${boat ? `<p>${escapeHtml(boat)}</p>` : ''}
        <p>${escapeHtml(formatDate(b.arrival))} → ${escapeHtml(b.departure ? formatDate(b.departure) : 'open-ended')}</p>
        <div class="marina-panel-actions">
          <button type="button" data-action="details">Details</button>
          ${quick.map((a) => `<button type="button" data-action="${a}">${a === 'confirm' ? 'Confirm' : 'Decline'}</button>`).join('')}
        </div>
      </div>
    </section>`;
}

function panelHtml(p: PanelState): string {
  const current = p.current
    ? bookingHtml('current', 'Tonight', p.current)
    : `<p class="chart-card-subtitle" data-slot="current">${p.heldOrMaintenance ? 'Held by a guest checkout or in maintenance' : 'Free tonight'}</p>`;
  const next = p.next
    ? bookingHtml('next', 'Next booking', p.next)
    : '<p class="chart-card-subtitle" data-slot="next">No upcoming bookings</p>';
  return current + next;
}

async function renderPanel() {
  const label = panelLabel;
  if (label === null) return;
  const seq = ++panelSeq;
  const t = today();
  try {
    const [berths, mapData] = await Promise.all([
      // The map event carries the label, but the bookings filter wants the
      // id. include_inactive=1 because an inactive berth can still have
      // bookings worth seeing.
      getJson(`/api/marina/marinas/${encodeURIComponent(marina.id)}/berths?include_inactive=1`) as Promise<{ id: string; label: string }[]>,
      // The element exposes no payload, so read the guest map payload it
      // paints from (OTA, on the staff bearer). A berth shown occupied with
      // no live booking is a checkout hold or maintenance. If this fetch
      // fails, the panel just shows "Free tonight".
      getJson(`/api/marina/guest/${encodeURIComponent(marina.slug)}?from=${t}&to=${addDays(t, 1)}`).catch(() => null),
    ]);
    const berthId = berths.find((b) => b.label === label)?.id;
    const bookings = berthId
      ? await getJson(`/api/marina/bookings?berth_id=${encodeURIComponent(berthId)}&from=${addDays(t, -1)}&limit=500`)
      : { data: [] };
    if (seq !== panelSeq || panelLabel !== label) return;
    const mapBerths: { label?: string; available?: boolean }[] = Array.isArray(mapData?.berths) ? mapData.berths : [];
    const occupiedOnMap = mapBerths.find((x) => x.label === label)?.available === false;
    const state = matchBerthPanel(bookings.data, label, t, occupiedOnMap);
    panelRows = new Map([state.current, state.next].filter((b): b is StaffBookingRow => !!b).map((b) => [b.id, b]));
    panelBody.innerHTML = panelHtml(state);
  } catch (err) {
    if (seq === panelSeq) {
      panelBody.innerHTML = `<p class="chart-card-subtitle">${escapeHtml(`Couldn't load berth ${label} — ${(err as Error).message}`)}</p>`;
    }
  }
}

// Tiles, map colours and an open panel all follow any booking change at
// this marina, whether it came from an action here or from Ably.
function refreshAll() {
  void loadTiles();
  map?.refresh?.();
  void renderPanel();
}

function onRowChanged(row: StaffBookingRow) {
  if (row.marina_id === marina.id) refreshAll();
}

function onBerthSelected(e: Event) {
  const label = (e as CustomEvent<{ berthId: string | null }>).detail?.berthId ?? null;
  if (label === null) {
    if (panel.open) panel.close();
    return;
  }
  panelLabel = label;
  panelTitle.textContent = `Berth ${label}`;
  panelBody.innerHTML = '<p class="chart-card-subtitle">Loading…</p>';
  // Modal, like every config-sheet: close it to pick another berth.
  if (!panel.open) panel.showModal();
  void renderPanel();
}

async function showMarina() {
  localStorage.setItem(MARINA_STORAGE_KEY, marina.id);
  if (panel.open) panel.close();
  for (const el of Object.values(tiles)) el.textContent = '–';
  // mountStaffMap replaces the old element, and its listener goes with it.
  map = await mountStaffMap(mapHost, marina.slug, timeZone);
  map.addEventListener('sidon-berth-selected', onBerthSelected);
  await loadTiles();
}

panel.addEventListener('close', () => {
  panelLabel = null;
  panelRows = new Map();
});
document.getElementById('marina-berth-panel-close')!.addEventListener('click', () => panel.close());

panelBody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const id = btn?.closest<HTMLElement>('[data-id]')?.dataset.id;
  const row = id ? panelRows.get(id) : undefined;
  if (!btn || !row) return;
  if (btn.dataset.action === 'details') {
    void openMarinaBookingDialog(row.id, onRowChanged);
    return;
  }
  btn.disabled = true;
  try {
    const updated = await runBookingAction(row, btn.dataset.action as BookingAction);
    if (updated) onRowChanged(updated);
  } finally {
    btn.disabled = false;
  }
});

if (marinas.length > 1) {
  selectEl.innerHTML = marinas.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  selectEl.value = marina.id;
  selectEl.hidden = false;
  selectEl.addEventListener('change', () => {
    marina = marinas.find((m) => m.id === selectEl.value) ?? marina;
    void showMarina();
  });
}

actionsEl.hidden = false;
dashboardEl.hidden = false;
await showMarina();

// Live (R22). The detail dialog can be open for a booking at any marina.
// Without Ably (no key locally) the page still works, it just doesn't
// update itself.
subscribeMarinaBookings((row) => {
  refreshOpenMarinaBookingDialog(row);
  onRowChanged(row);
}).catch((err) => console.error('Marina live updates unavailable:', err));
```

- [ ] **Step 10: Re-run the logic check and the build**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts && npm run build`

Expected:
- `check-marina: ok`
- The build ends with `[build] Complete!` and has no errors.
- The output has separate chunks for `marina-dashboard` and `marina-interim`, because both are reached only through the router's dynamic `import()`.

- [ ] **Step 11: Run both specs and confirm they pass**

Run (local OTA and `astro dev` up as in Step 5): `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina.spec.ts tests/marina-interim.spec.ts`

Expected, with 0 failed:
- In `marina.spec.ts`, all 6 tests pass: create, tiles at zero, arrival, pending, header links, berth panel.
- In `marina-interim.spec.ts`, the Task 5 interim, nav and forwarder cases still pass.
- `/marina branch › an active OTA marina gets the dashboard and never calls Sidon` passes.
- `/marina branch › with no active OTA marina the interim page returns` passes. It is reported as skipped, with its message, only if an earlier aborted run left an active marina on the test account.

- [ ] **Step 12: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts src/scripts/marina-client.ts src/scripts/marina-interim.ts src/scripts/marina-dashboard.ts src/pages/marina.astro tests/marina-interim.spec.ts tests/marina.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: /marina tiles, staff berth map and side panel" -m "/marina now branches on the property's active OTA marinas. With at least one, it shows the new dashboard; otherwise the interim Sidon page loads unchanged. Each branch dynamic-imports only its own <sidon-berth-map> package. The dashboard has property-day tiles (arrivals, departures, on berth, pending approvals), the 1.1 staff map, a berth side panel with current/next bookings and confirm/decline, and Ably refresh. tileCounts and matchBerthPanel are pinned in check-marina.ts." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do not push. The dashboard is deployed later by the runbook, which is not part of this task.

---

### Task 14: Dashboard — marina enquiries in the reply dialog

Repo `D` (`C:/Users/robert/source/repos/ota-table-bookings`), branch `main`. Implements R27. hotal-ui is not released or changed, so the feed list still labels only restaurant enquiries.

**Files:**
- Modify: `D/src/scripts/event-inquiry-dialogs.ts`
  - `:1-3`: imports, adding `loadMarinas`.
  - `:41-44`: `Inquiry` type, adding `marina_id` / `marina_name`.
  - `:144-148`: `buildInquiryDetailsHtml` meta line.
  - `:162`: restaurant field.
  - `:509-514`: `openReplyDialog`, covering the marina name fallback and hiding Convert.
- Create: `D/tests/marina-enquiries.spec.ts`
- Unchanged:
  - `dashboard.astro`, `event-inquiries.astro` and `pro-shop.astro`. They share this one dialog, and `spa-dashboard` gets the same code with `showBookingConversion: false`.
  - `global.css`. `#convert-to-booking-btn` has no class and no rule that sets `display` (the base `button {}` rule at `global.css:1523-1531` sets none). The UA `[hidden]` rule hides it, just as it already does for return threads at `:514`, so no CSS guard is needed.
  - Every existing spec.

**Interfaces:**
- Consumes:
  - `loadMarinas(): Promise<MarinaRow[]>` from `D/src/scripts/sidebar-modules-widget.ts` (Task 5).
  - `uniqueSlug`, `createMarinaViaUi(page, { name, slug }): Promise<string>` and `deactivateMarinaViaUi(page, id)` from `D/tests/marina-helpers.ts` (Task 6).
  - OTA `GET /api/event-inquiries` rows. These are `ei.*` plus `marina_name` (`O/src/controllers/eventInquiries.js:43,50`).
  - Bare rows that have `marina_id` but no `marina_name`: the Ably `new-inquiry` payload (`:166`) and the `PUT /api/event-inquiries/:id` answer (`:227`).
- Produces:
  - `Inquiry.marina_id?: string | null`
  - `Inquiry.marina_name?: string | null`
  - When `marina_id` is set, the reply dialog's `.reply-inquiry-meta` starts with the marina name, `#reply-detail-restaurant` and its label are not rendered, and `#convert-to-booking-btn` is `[hidden]`.

Prerequisites: Tasks 5 and 6 are committed. Local OTA is running (`cd O && npm run dev`). The dashboard dev server is on 4335 (`cd D && npx astro dev --background`). `clerk auth login` has been done once on this machine.

- [ ] **Step 1: Write the failing Playwright spec**

Create `D/tests/marina-enquiries.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { createMarinaViaUi, deactivateMarinaViaUi, uniqueSlug } from './marina-helpers';

// The enquiries are fixtures served in place of OTA's list (page.route), so
// the spec needs no guest-submitted enquiry in the shared dev DB. The marina
// is real because a row without marina_name (an Ably push or a PUT answer)
// is labelled from loadMarinas(), the property's active marinas.
const MARINA_ENQ = '00000000-0000-4000-8000-0000000000a1';
const PUSHED_ENQ = '00000000-0000-4000-8000-0000000000a2';
const RESTAURANT_ENQ = '00000000-0000-4000-8000-0000000000a3';

const slug = uniqueSlug('pw-enq');
const marinaName = `PW Enquiries ${slug}`;
let marinaId = '';

function enquiry(id: string, name: string, extra: Record<string, unknown>) {
  return {
    id, name, email: 'pw-enquiry@example.com', phone: null,
    event_date: '2026-11-20', event_time: null, guests: 2,
    event_type: 'Berth enquiry', format: null, message: 'Playwright fixture',
    status: 'new', created_at: '2026-10-12T09:00:00.000Z',
    restaurant_id: null, restaurant_name: null, spa_id: null, spa_name: null,
    marina_id: null, marina_name: null,
    last_reply_direction: null, last_reply_by_name: null, last_reply_avatar_url: null,
    ...extra,
  };
}

// Only the list and the fixture rows' replies/ai-drafts reads are swapped.
// The dashboard's own /api/event-inquiries/ably-auth has a single segment,
// so neither pattern matches it. route.fetch() keeps OTA's real CORS
// headers on the cross-origin answer; only the body and status change.
async function serveEnquiries(page: Page, list: unknown[]) {
  await page.route(
    (url) => url.pathname === '/api/event-inquiries' || /^\/api\/event-inquiries\/[^/]+\/(replies|ai-drafts)$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const isList = new URL(route.request().url()).pathname === '/api/event-inquiries';
      await route.fulfill({ response, status: 200, json: isList ? list : [] });
    },
  );
}

test.afterAll(async ({ browser }) => {
  if (!marinaId) return;
  // afterAll has no test fixtures: sign in through the same stored state as the other marina specs.
  const context = await browser.newContext({ storageState: 'playwright/.auth/user.json' });
  const page = await context.newPage();
  try {
    await deactivateMarinaViaUi(page, marinaId);
  } finally {
    await context.close();
  }
});

test('marina enquiries show the marina and skip booking conversion', async ({ page }) => {
  marinaId = await createMarinaViaUi(page, { name: marinaName, slug });

  await serveEnquiries(page, [
    enquiry(MARINA_ENQ, 'PW Marina Guest', { marina_id: marinaId, marina_name: marinaName }),
    // Shaped like an Ably new-inquiry push or a PUT answer: marina_id, no marina_name.
    enquiry(PUSHED_ENQ, 'PW Pushed Guest', { marina_id: marinaId, marina_name: undefined }),
    enquiry(RESTAURANT_ENQ, 'PW Restaurant Guest', { event_type: 'Private dining' }),
  ]);
  await page.goto('/event-inquiries');

  const feed = page.locator('#inquiries-feed');
  const dialog = page.locator('#reply-dialog');
  const meta = dialog.locator('.reply-inquiry-meta');
  const convert = page.locator('#convert-to-booking-btn');
  const restaurantSelect = page.locator('#reply-detail-restaurant');

  for (const id of [MARINA_ENQ, PUSHED_ENQ]) {
    await feed.locator(`[data-id="${id}"]`).click();
    await expect(dialog).toBeVisible();
    await expect(meta).toContainText(marinaName);
    await expect(convert).toBeHidden();
    await expect(restaurantSelect).toHaveCount(0);
    await page.locator('#reply-dialog-close-btn').click();
    await expect(dialog).toBeHidden();
  }

  // Restaurant enquiries are unchanged: no marina label, the restaurant
  // select (restaurant_id is null) and Convert to booking.
  await feed.locator(`[data-id="${RESTAURANT_ENQ}"]`).click();
  await expect(dialog).toBeVisible();
  await expect(meta).toContainText('Private dining');
  await expect(meta).not.toContainText(marinaName);
  await expect(convert).toBeVisible();
  await expect(restaurantSelect).toBeVisible();
});
```

- [ ] **Step 2: Run the spec and confirm it fails**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-enquiries.spec.ts`

Expected: `1 failed` (the setup project still passes, so `1 passed`). The failure comes from the first marina enquiry:
```
Error: expect(locator).toContainText(expected) failed
Locator: locator('#reply-dialog').locator('.reply-inquiry-meta')
Expected substring: "PW Enquiries pw-enq-<timestamp>"
Received string:    "Berth enquiry"
```
`afterAll` still deactivates the marina.

- [ ] **Step 3: Add the marina fields to the `Inquiry` type**

In `D/src/scripts/event-inquiry-dialogs.ts`, add the import. Old (`:1-3`):
```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { confirmDialog } from './confirm-dialog';
```
New:
```ts
import { apiFetch, escapeHtml } from './api-client';
import { showToast } from './toast';
import { confirmDialog } from './confirm-dialog';
import { loadMarinas } from './sidebar-modules-widget';
```

Old (`:41-44`):
```ts
  restaurant_id: string | null;
  restaurant_name: string | null;
  spa_id: string | null;
  spa_name: string | null;
```
New:
```ts
  restaurant_id: string | null;
  restaurant_name: string | null;
  spa_id: string | null;
  spa_name: string | null;
  // Set on enquiries sent from a marina's booking page. Only the list query
  // joins marina_name; Ably pushes and PUT answers carry marina_id alone
  // (see withMarinaName).
  marina_id?: string | null;
  marina_name?: string | null;
```

- [ ] **Step 4: Label the marina and drop the restaurant field in `buildInquiryDetailsHtml`**

Old (`:144-148`):
```ts
  function buildInquiryDetailsHtml(inquiry: Inquiry): string {
    if (inquiry.return) return buildReturnDetailsHtml(inquiry, inquiry.return);
    const meta = [inquiry.event_type, inquiry.format].filter(Boolean) as string[];
```
New:
```ts
  function buildInquiryDetailsHtml(inquiry: Inquiry): string {
    if (inquiry.return) return buildReturnDetailsHtml(inquiry, inquiry.return);
    // A marina enquiry leads with its marina, the way the restaurant field
    // names the restaurant. It gets no restaurant field: there's no table
    // reservation to convert it into. 'Marina' covers a name that couldn't
    // be resolved (an inactive marina isn't in loadMarinas()).
    const marinaLabel = inquiry.marina_id ? inquiry.marina_name || 'Marina' : null;
    const meta = [marinaLabel, inquiry.event_type, inquiry.format].filter(Boolean) as string[];
```
The meta spans already go through `escapeHtml(m)` in `meta.map(...)`, so the marina name is escaped too.

Old (`:162`):
```ts
        ${showBookingConversion ? `<label>Restaurant ${restaurantField}</label>` : ''}
```
New:
```ts
        ${showBookingConversion && !inquiry.marina_id ? `<label>Restaurant ${restaurantField}</label>` : ''}
```
With no `#reply-detail-restaurant` and `restaurant_id` null, `wireBookingFields` gets `currentRestaurantId() === ''`. Its restaurant availability check therefore stays blank, and no `/api/restaurant` list is fetched.

- [ ] **Step 5: Resolve the name and hide Convert in `openReplyDialog`**

Old (`:509-514`):
```ts
  async function openReplyDialog(inquiry: Inquiry) {
    currentInquiry = inquiry;
    replyDialog.dataset.inquiryId = inquiry.id;
    replyDialogTitle.textContent = `Replies — ${inquiry.name}`;
    const convert = document.getElementById('convert-to-booking-btn') as HTMLButtonElement | null;
    if (convert) convert.hidden = !!inquiry.return;
```
New:
```ts
  // Ably new-inquiry pushes (dashboard feed) and saveField's PUT answers
  // carry the bare row: marina_id but no marina_name. Name those from the
  // nav's memoised marina list, which has normally settled by the time
  // anyone clicks, so this rarely waits on the network.
  async function withMarinaName(inquiry: Inquiry): Promise<Inquiry> {
    if (!inquiry.marina_id || inquiry.marina_name) return inquiry;
    const marina = (await loadMarinas()).find((m) => m.id === inquiry.marina_id);
    return { ...inquiry, marina_name: marina?.name ?? null };
  }

  async function openReplyDialog(inquiry: Inquiry) {
    inquiry = await withMarinaName(inquiry);
    currentInquiry = inquiry;
    replyDialog.dataset.inquiryId = inquiry.id;
    replyDialogTitle.textContent = `Replies — ${inquiry.name}`;
    const convert = document.getElementById('convert-to-booking-btn') as HTMLButtonElement | null;
    // Convert creates a restaurant reservation. A marina enquiry becomes a
    // berth booking on /marina-bookings instead.
    if (convert) convert.hidden = !!inquiry.return || !!inquiry.marina_id;
```

- [ ] **Step 6: Build**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npm run build`

Expected: exits 0 and ends with `[build] Complete!`, with no TypeScript or Vite errors.

- [ ] **Step 7: Run the spec and confirm it passes**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-enquiries.spec.ts`

Expected: `2 passed` (setup plus the spec). `afterAll` deactivates the `pw-enq-<timestamp>` marina, so it no longer shows in `GET /api/marina/marinas`.

- [ ] **Step 8: Regression check on another page with the shared dialog**

Run: `cd C:/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/dashboard.spec.ts`

Expected: `2 passed`. `dashboard.astro` loads the same dialog module with its new import, and the spec is not changed.

- [ ] **Step 9: Commit**

```bash
git -C C:/Users/robert/source/repos/ota-table-bookings add src/scripts/event-inquiry-dialogs.ts tests/marina-enquiries.spec.ts
git -C C:/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: marina enquiries show the marina and skip booking conversion" -m "The shared reply dialog (dashboard, event inquiries, pro shop) now names the marina in the meta row. Ably and PUT rows that carry no marina_name are named from loadMarinas(). For marina enquiries the dialog drops the restaurant select and hides Convert to booking. The feed list label stays restaurant-only (no hotal-ui release, R27)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Do not push. The dashboard is deployed later by the runbook, with the rest of plan C.

---

### Task 15: End-to-end staff flow against local OTA

This task runs the whole staff flow in a real browser against a local OTA, the plan B demo seed and the W demo booking page. It adds no product code. If a check fails, Step 19 fixes the cause in the repo that owns it, starting with a failing check. That fix gets its own commit, and its hash goes next to the item in Step 22. Implements R29 (last task).

**Files:**
- Repos `O`, `W`, `D`, all on branch `main`. No new commits unless Step 19 finds a defect.
- Create these scratch files under the gitignored `O/.superpowers/`. They are never committed:
  - `O/.superpowers/planc/e2e/port.txt` (the OTA port for this run)
  - `O/.superpowers/planc/e2e/preload.js`
  - `O/.superpowers/planc/e2e/prop.js`
  - `O/.superpowers/planc/e2e/card.js`
  - `O/.superpowers/planc/e2e/pontoon.svg`
  - `O/.superpowers/planc/e2e/berths.csv`
  - `O/.superpowers/planc/e2e/e2e-passport.pdf`
  - Written while the task runs: `key-restore.json` (by `prop.js key`, only when the key had to change) and `demo.env.local.bak`
- Modify temporarily: `W/demo/.env.local`. It is gitignored by `*.local`. Step 20 restores it from `demo.env.local.bak`.
- Product code: none. Step 19 handles defects.

**Interfaces:**
- Consumes:
  - O:
    - `scripts/seed-marina-demo.js`
    - `src/lib/marinaToken.js` `bookingToken(id)`
    - The `marinaDocuments` store seam (`store.put/get/del`; `get` resolves `{ stream }`; `extractDocument`)
    - `marinaStripe.stripeFor(sk)`
    - R12 `life.republish` → `booking-status-changed`
    - R13 `signature.rendered_body`
    - R14 `?include_inactive=1`
    - Staff routes `POST/PUT /api/marina/bookings[/:id]`, `POST /api/marina/bookings/:id/send-guest-link`, `GET /api/marina/bookings/:id/documents`, `GET /api/marina/documents/:id/file`, `PUT /api/marina/documents/:id`
    - Guest routes `POST …/guest/:slug/bookings`, `…/confirm-payment`, `…/documents`, `…/contract`
  - W:
    - `<sidon-booking-widget booking-id>` without `locale`, which follows `booking.locale` (R8)
    - `<sidon-berth-map mode="staff">` (R3)
    - The demo dev proxy (`vite.config.ts`: `OTA_DEMO_BASE_URL`, `OTA_DEMO_API_KEY` from `demo/.env.local`)
  - D:
    - The forwarder `src/pages/api/marina/guest/[...path].ts` (signed out → `401 {"error":"Not signed in"}`)
    - `mountStaffMap`, `openMarinaBookingDialog` / `refreshOpenMarinaBookingDialog`, `runBookingAction`, `subscribeMarinaBookings`, `src/pages/api/marina/ably-auth.ts`
    - Settings ids:
      - tab `data-tab-target="marina"`
      - `#marina-add-form`, `#marina-add-name`, `#marina-add-slug`
      - `li.marina-row[data-id]` with `.marina-row-save` and `.marina-row-remove`
    - Setup ids:
      - `#marina-setup-select`
      - tab buttons `data-setup-target`
      - `#berths-csv-input`, `#berths-csv-errors`, `#berths-body tr[data-id]`
    - Bookings ids:
      - `#marina-bookings-body tr[data-id]`
      - `button[data-action="confirm|decline|cancel|end|send-link|details"]`
      - `#mb-add-btn`, `#mb-create-dialog` and its `#mb-create-*` fields, including `#mb-create-locale`
      - `#marina-booking-dialog`
    - `/marina` ids:
      - `#marina-dashboard`, `#marina-select`
      - `#marina-stat-arrivals|departures|onberth|pending`
      - `#marina-staff-map`, `#marina-berth-panel`
    - Pills `.marina-pill[data-status]` and `.marina-pay[data-status]`. Payment pill labels: 'Card held', 'Paid', 'Refunded', 'No payment'.
    - Specs `tests/marina-interim.spec.ts`, `marina-settings.spec.ts`, `marina-setup.spec.ts`, `marina-bookings.spec.ts`, `marina.spec.ts`, `marina-enquiries.spec.ts`.
  - Italian `W/src/lib/i18n.ts` labels the expectations quote:
    - `hero.confirmed` = 'Prenotazione confermata' / 'Sei dentro'
    - `hero.cancelled.eyebrow` = 'Prenotazione annullata'
    - `documentsHeading` = 'Documenti'
    - `upload` = 'Carica'
    - `docState.pending` = 'Ricevuto · in verifica'
    - `contractHeading` = 'Contratto di ormeggio'
    - `readAgree` = 'Ho letto e accetto'
    - `agree` = 'Accetto'
    - `contractAgreedOn` = 'Accettato il <date>'
- Produces: no code. The results checklist in Step 22, which goes into the task report.

Below, `O`, `W` and `D` mean `/c/Users/robert/source/repos/OTA`, `/c/Users/robert/source/repos/sidon-booking-widget` and `/c/Users/robert/source/repos/ota-table-bookings`. `$P` is the OTA port from Step 1, also stored in `port.txt`. `$SLUG` is the marina slug from Step 7. `$TODAY` is the property's day from `prop.js show`. Use Git Bash. Browser steps use `mcp__playwright__browser_*`.

- [ ] **Step 1: Preflight: clean trees, ports, Ably, Clerk CLI**

```bash
for r in OTA sidon-booking-widget ota-table-bookings; do echo "== $r $(git -C /c/Users/robert/source/repos/$r branch --show-current)"; git -C /c/Users/robert/source/repos/$r status --short; done
for port in 3000 3100 4335 5173; do netstat -ano | awk -v p=":$port" -v port="$port" '$2 ~ p"$" && $4 == "LISTENING" { print "port " port " in use by PID " $5 }' | sort -u; done
node -e "const f=(p)=>((require('fs').readFileSync(p,'utf8').match(/^ABLY_API_KEY=([^.\s]+)\./m)||[])[1]);const a=f('C:/Users/robert/source/repos/OTA/.env'),b=f('C:/Users/robert/source/repos/ota-table-bookings/.env');console.log(!a||!b?'ably: missing':a===b?'ably: same app':'ably: different apps')"
clerk --version
```

Expected:
- All three repos are on `main`.
  - `OTA` lists only the entries that were already there: `?? =` and `?? src/db/seed-extras.sql.pre-multi-property.bak`.
  - `sidon-booking-widget` and `ota-table-bookings` list nothing.
- Choose the OTA port `P`:
  - `3000` if no line names port 3000.
  - Otherwise `3100`.
  - If 3100 is also in use, stop its PID with the Step 20 loop for that port, and record "restart the 3100 server in Step 20".
- If 4335 or 5173 is in use, stop it the same way:
  - 4335: `cd D && npx astro dev stop`, or the PID.
  - 5173: the PID.
  - Record what you stopped so Step 20 can restart it.
- `ably: same app` means OTA's publishes reach D's token, so the live-dialog checks in Steps 14–15 run. `different apps` or `missing` means those checks are recorded as skipped, and the dialog is reopened instead.
- `clerk --version` prints a version. If it doesn't, run `clerk auth login` once, as `D/CLAUDE.md` says.

- [ ] **Step 2: Scratch helpers and fixtures (gitignored)**

```bash
mkdir -p /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e
cd /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e
echo 3000 > port.txt   # write 3100 instead when Step 1 picked 3100
cat > preload.js <<'EOF'
// Plan C e2e only (gitignored scratch). Preloaded into src/server.js:
//   PORT=<port> node -r ./.superpowers/planc/e2e/preload.js src/server.js
require('dotenv').config();
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('e2e preload: local DB only');

// No real guest emails from a test run. marinaEmails builds its Resend
// client at require time, so load it while the key is hidden; server.js's
// own dotenv call puts the key back for everything else. send-guest-link
// still answers 200: sendGuestEmail returns early without a client.
delete process.env.RESEND_API_KEY;
require('../../../src/lib/marinaEmails');

// Local .env has no BLOB_READ_WRITE_TOKEN: keep uploads in memory (the seam
// scripts/check-marina-http.js uses). Unlike plan B, get() hands the bytes
// back, because the staff dialog streams the file (GET /documents/:id/file).
const docs = require('../../../src/lib/marinaDocuments');
const blobs = new Map();
docs.store = {
  put: async (p, buf) => { blobs.set(p, Buffer.from(buf)); },
  get: async (p) => (blobs.has(p) ? { stream: new Blob([blobs.get(p)]).stream() } : null),
  del: async (ps) => { ps.forEach((p) => blobs.delete(p)); },
};
// Paid extraction stays off for fixtures.
docs.extractDocument = async () => {};
EOF
cat > prop.js <<'EOF'
// Plan C e2e (gitignored scratch): the e2e marina's property, found by slug.
//   cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planc/e2e/prop.js <slug> show|key|restore
// show:    ids, the property's today, api-key and Stripe state, active marina count.
// key:     the W demo proxy and card.js need an enabled property api_key; the
//          staff test property may have none, so one is set and the original
//          state is recorded first (only once), for `restore`.
// restore: puts the recorded api_key / api_key_enabled back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('local DB only');
const pool = require('../../../src/db');

const [slug, mode] = process.argv.slice(2);
const RESTORE = path.join(__dirname, 'key-restore.json');

(async () => {
  if (!slug || !['show', 'key', 'restore'].includes(mode)) throw new Error('usage: prop.js <slug> show|key|restore');
  const { rows } = await pool.query(
    `SELECT m.id AS marina_id, m.status, m.auto_confirm, m.booking_url, p.id AS property_id, p.timezone, upper(p.currency) AS currency,
            to_char((now() AT TIME ZONE COALESCE(p.timezone, 'UTC'))::date, 'YYYY-MM-DD') AS today,
            p.api_key, p.api_key_enabled, p.stripe_secret_key, p.stripe_publishable_key, p.sidon_marina_id,
            (SELECT count(*)::int FROM marina x WHERE x.property_id = p.id AND x.status = 'active') AS active_marinas
       FROM marina m JOIN property p ON p.id = m.property_id WHERE m.slug = $1`, [slug]);
  if (rows.length !== 1) throw new Error(`expected one marina with slug ${slug}, found ${rows.length}`);
  const r = rows[0];
  if (mode === 'show') {
    const sk = r.stripe_secret_key || '';
    const pk = r.stripe_publishable_key || '';
    console.log(JSON.stringify({
      marina_id: r.marina_id, status: r.status, auto_confirm: r.auto_confirm, booking_url: r.booking_url,
      property_id: r.property_id, timezone: r.timezone, currency: r.currency, today: r.today,
      api_key: r.api_key && r.api_key_enabled ? 'enabled' : r.api_key ? 'disabled' : 'none',
      stripe: sk.startsWith('sk_test_') && pk.startsWith('pk_test_') ? 'test pair' : sk || pk ? 'not a test pair' : 'none',
      sidon_marina_id: r.sidon_marina_id, active_marinas: r.active_marinas,
    }, null, 2));
  } else if (mode === 'key') {
    if (!(r.api_key && r.api_key_enabled)) {
      if (!fs.existsSync(RESTORE)) fs.writeFileSync(RESTORE, JSON.stringify({ property_id: r.property_id, api_key: r.api_key, api_key_enabled: r.api_key_enabled }));
      r.api_key = r.api_key || `prop_${crypto.randomBytes(32).toString('hex')}`;
      await pool.query('UPDATE property SET api_key = $2, api_key_enabled = true WHERE id = $1', [r.property_id, r.api_key]);
    }
    console.log(`api_key=${r.api_key}`);
  } else if (!fs.existsSync(RESTORE)) {
    console.log('nothing to restore');
  } else {
    const o = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
    await pool.query('UPDATE property SET api_key = $2, api_key_enabled = $3 WHERE id = $1', [o.property_id, o.api_key, o.api_key_enabled]);
    fs.unlinkSync(RESTORE);
    console.log('api key restored');
  }
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
EOF
cat > card.js <<'EOF'
// Plan C e2e (gitignored scratch): a guest card booking on the e2e marina,
// authorised with Stripe's test card, so a staff confirm captures it and a
// staff cancel can refund it. Only ever the property's own TEST pair.
//   cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planc/e2e/card.js <slug> <berth label> <arrival> <departure>
const fs = require('fs');
const path = require('path');
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('local DB only');
const pool = require('../../../src/db');
const { stripeFor } = require('../../../src/lib/marinaStripe');

const OTA = `http://localhost:${fs.readFileSync(path.join(__dirname, 'port.txt'), 'utf8').trim()}`;
const [slug, label, arrival, departure] = process.argv.slice(2);

(async () => {
  if (!slug || !label || !arrival || !departure) throw new Error('usage: card.js <slug> <berth label> <arrival> <departure>');
  const { rows: [p] } = await pool.query(
    `SELECT p.api_key, p.api_key_enabled, p.stripe_secret_key, p.stripe_publishable_key
       FROM marina m JOIN property p ON p.id = m.property_id WHERE m.slug = $1`, [slug]);
  if (!p) throw new Error(`no marina ${slug}`);
  if (!(p.stripe_secret_key?.startsWith('sk_test_') && p.stripe_publishable_key?.startsWith('pk_test_'))) {
    console.log('SKIP: no Stripe keys');
    return;
  }
  if (!(p.api_key && p.api_key_enabled)) throw new Error('run prop.js <slug> key first');
  const G = `${OTA}/api/marina/guest/${encodeURIComponent(slug)}`;
  const H = { 'X-Api-Key': p.api_key, 'Content-Type': 'application/json' };
  const r = await fetch(`${G}/bookings`, { method: 'POST', headers: H, body: JSON.stringify({
    berth_label: label, arrival, departure, contact_name: 'E2E Card', contact_email: `e2e-card-${Date.now()}@example.com`,
    boat_name: 'E2E Card Boat', boat_length_m: 10, locale: 'en' }) });
  const body = await r.json();
  if (r.status !== 201 || !body.payment) throw new Error(`POST bookings -> ${r.status} ${JSON.stringify(body)}`);
  // client_secret is "<intent id>_secret_<...>"; confirming server-side with
  // Stripe's test PaymentMethod stands in for the guest's Payment Element.
  const pi = await stripeFor(p.stripe_secret_key).paymentIntents.confirm(body.payment.client_secret.split('_secret_')[0], { payment_method: 'pm_card_visa' });
  if (pi.status !== 'requires_capture') throw new Error(`intent ${pi.id} is ${pi.status}`);
  const c = await fetch(`${G}/bookings/${body.booking.id}/confirm-payment`, { method: 'POST', headers: { ...H, 'X-Booking-Token': body.booking_token } });
  const cb = await c.json();
  if (c.status !== 200) throw new Error(`confirm-payment -> ${c.status} ${JSON.stringify(cb)}`);
  console.log(JSON.stringify({ id: body.booking.id, status: cb.booking.status, payment_status: cb.booking.payment_status, total: body.booking.total_price, currency: body.booking.currency, intent: pi.id }));
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
EOF
# Same geometry as seed-marina-demo.js: a 300x150 SVG over SW..NE, berths as
# <g data-berth-id> around a rect; CSV lat/lng are the top-row cell centres.
cat > pontoon.svg <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><rect data-role="pontoon" x="5" y="67" width="290" height="16" fill="#9c8b74"/><g data-type="berth" data-berth-id="E1"><rect x="15" y="10" width="80" height="52" rx="4"/><text x="55" y="36" text-anchor="middle">E1</text></g><g data-type="berth" data-berth-id="E2"><rect x="110" y="10" width="80" height="52" rx="4"/><text x="150" y="36" text-anchor="middle">E2</text></g><g data-type="berth" data-berth-id="E3"><rect x="205" y="10" width="80" height="52" rx="4"/><text x="245" y="36" text-anchor="middle">E3</text></g></svg>
EOF
# E3's blank status cell must be omitted (N3), so OTA's default 'active' applies.
printf 'label,pontoon,length_m,beam_m,depth_m,price_per_night,price_mode,lat,lng,status\r\nE1,Pontoon E2E,12,4,3,50,fixed,44.303427,9.20922,active\r\nE2,Pontoon E2E,12,4,3,50,fixed,44.303427,9.2096,active\r\nE3,Pontoon E2E,12,4,3,50,fixed,44.303427,9.20998,\r\n' > berths.csv
# Smallest file OTA's magic-byte sniff accepts as a PDF.
printf '%%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%%%EOF\n' > e2e-passport.pdf
head -c 5 e2e-passport.pdf; echo
git -C /c/Users/robert/source/repos/OTA check-ignore -q .superpowers/planc/e2e/prop.js && echo ignored
```

Expected:
- `head` prints `%PDF-`.
- The last line prints `ignored`.
- `e2e/` holds `port.txt`, the 3 scripts and the 3 fixtures.

- [ ] **Step 3: Seed, start OTA**

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/seed-marina-demo.js
```

Expected: `Marina Demo seeded (property <uuid>)`, `api_key=prop_…` and `slug=demo-marina`. The seed is idempotent.

Start OTA with the Bash tool and `run_in_background: true`. This is the same `src/server.js` that `npm run dev` runs. It adds the preload, which keeps emails, blobs and extraction local, and it runs without nodemon, so restart it by hand after an OTA fix.

```bash
cd /c/Users/robert/source/repos/OTA && PORT=$(cat .superpowers/planc/e2e/port.txt) node -r ./.superpowers/planc/e2e/preload.js src/server.js
```

Expected log: `Server running on port <P>`.

```bash
P=$(cat /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/port.txt)
curl -s -w '\n%{http_code}\n' "http://localhost:$P/api/marina/bookings"
```

Expected: `401` with a JSON error. OTA is up, and staff routes need a bearer.

- [ ] **Step 4: Start D against this OTA; forwarder smoke**

```bash
P=$(cat /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/port.txt)
cd /c/Users/robert/source/repos/ota-table-bookings && PUBLIC_OTA_API_BASE_URL=http://localhost:$P npx astro dev --background
npx astro dev status
curl -s -w '\n%{http_code}\n' http://localhost:4335/api/marina/guest/no-such-marina
```

Expected:
- The status reports a running dev server on `http://localhost:4335`.
- The curl prints `{"error":"Not signed in"}` and `401`. That is JSON, not Astro's HTML page (R6).
- Vite gives a variable that is already in the process environment priority over `.env`. Step 8 checks in the browser that D calls `http://localhost:<P>`.

- [ ] **Step 5: Run every marina spec**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-interim.spec.ts tests/marina-settings.spec.ts tests/marina-setup.spec.ts tests/marina-bookings.spec.ts tests/marina.spec.ts tests/marina-enquiries.spec.ts
```

Expected:
- The `setup` project signs in.
- Every test passes: `N passed`, with no `failed` and no `flaky`.
- Playwright reuses the Step 4 server (`reuseExistingServer: true`).
- A failure goes to Step 19. After the fix, re-run this command.

- [ ] **Step 6: Sign the MCP browser in as the impersonated staff user**

```bash
clerk impersonate "ota-dashboard-test+clerk_test@example.com" --app app_3C7SdjDmmGPnfX5GbgDW6IoG8XU --instance dev --print --yes | node -p "new URL(JSON.parse(require('fs').readFileSync(0,'utf8')).url).searchParams.get('ticket')"
```

1. `browser_navigate` to `http://localhost:4335/login`, then `browser_wait_for` with `time: 3`.
2. `browser_navigate` to `http://localhost:4335/login?__clerk_ticket=<ticket>`. An "aborted" navigation is expected here: Clerk handles the ticket client-side, as `tests/auth.setup.ts` explains.
3. `browser_snapshot`. If it shows "Choose an organization", click the first `…'s logo` button.
4. `browser_wait_for` with `text: "Open user menu"`, or check that the snapshot has a button named 'Open user menu'.

Expected: the user menu button is there. If it isn't, the single-use ticket raced Vite's reload. Mint a fresh ticket and repeat items 1–4, up to 5 attempts, as `auth.setup.ts` does.

- [ ] **Step 7: Settings: create the e2e marina**

```bash
echo "e2e-marina-$(date +%s)"
```

That value is `$SLUG`.

1. `browser_navigate` to `http://localhost:4335/settings`, then click the tab `[data-tab-target="marina"]`.
2. Fill the add form:
   - `#marina-add-name`: `E2E Marina`
   - `#marina-add-slug`: `$SLUG`
   - Fill these fields too, by their labels, whether they are in the add form or in the new row's editor:
     - Latitude `44.30332`
     - Longitude `9.2096`
     - Email `e2e-marina@example.com`
     - Booking URL `http://localhost:5173/booking.html?booking={id}&token={token}`
     - Auto-confirm unchecked
     - Status active
   - Submit, then save the row (`.marina-row-save`) if the fields are in the row.
3. `browser_network_requests` with `filter: "/api/marina/marinas"`. Expected:
   - `POST http://localhost:<P>/api/marina/marinas` → 201, plus a `PUT …/marinas/<id>` → 200 if the row was saved.
   - Every API URL starts with `http://localhost:<P>`.
4. Expected in the page: `#marina-list li.marina-row[data-id="<marina id>"]` exists.

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planc/e2e/prop.js $SLUG show
```

Expected:
- `status: 'active'`, `auto_confirm: false`, `booking_url` exactly as typed.
- The output also gives `marina_id`, `today` (use it as `$TODAY`), `currency`, `api_key`, `stripe` and `active_marinas` (≥1). Record them all.

- [ ] **Step 8: /marina-setup: pontoon with SVG, berths by CSV, a document requirement, a contract template**

1. `browser_navigate` to `http://localhost:4335/marina-setup#pontoons`. Choose `E2E Marina` in `#marina-setup-select`.
2. Add a pontoon:
   - Click `#pontoon-add-btn`. Expected: `POST …/marinas/<id>/pontoons` → 201 (Task 8 creates "New pontoon" first).
   - Name `Pontoon E2E`; SW lat/lng `44.3031` / `9.209`, NE lat/lng `44.30353` / `9.2102`, rotation `0`. Each field autosaves on change (`PUT …/pontoons/<pid>` → 200).
   - SVG: click `input[type=file][data-field="svg_data"]` in that row, then `browser_file_upload` with `C:/Users/robert/source/repos/OTA/.superpowers/planc/e2e/pontoon.svg`.
   - Expected: `PUT …/pontoons/<pid>` → 200 with a body whose `svg_data` starts `<svg`, which shows the file was read client-side.
3. Click `[data-setup-target="berths"]`, then `browser_run_code_unsafe` with `code`:
   `async (page) => { const r = page.waitForResponse((x) => x.url().includes('/berths/bulk')); await page.setInputFiles('#berths-csv-input', 'C:/Users/robert/source/repos/OTA/.superpowers/planc/e2e/berths.csv'); const res = await r; return [res.status(), await res.json()]; }`
   Expected:
   - `[200, { upserted: 3, data: [...] }]`.
   - Every `data` row has the new pontoon's `pontoon_id`, and E3 has `status: 'active'` (blank cell omitted, N3).
   - `#berths-csv-errors` is empty or hidden.
   - `#berths-body tr[data-id]` count is 3.
4. Click `[data-setup-target="doc-requirements"]`. Add name `Passport`, type `passport`, mandatory on, then save. Expected: `POST …/doc-requirements` → 201, and the row is listed.
5. Click `[data-setup-target="contract-templates"]`. Add name `E2E berth agreement`, min nights `0`, and this body (`browser_type` into the body textarea), then save:

```text
# Berth agreement

Between **{{marina_name}}** and **{{sailor_name}}** ({{sailor_email}}).

- Boat: {{boat_name}}
- Berth: {{berth_id}}
- Stay: {{arrival_date}} to {{departure_date}} ({{nights}} nights)
```

   Expected:
   - `POST …/contract-templates` → 201.
   - No unknown-placeholder warning is shown, because the response has `warnings.unknown_placeholders` empty or absent.

- [ ] **Step 9: Point the W demo at this OTA and the e2e property; start it**

```bash
cd /c/Users/robert/source/repos/OTA
KEY=$(node -r dotenv/config .superpowers/planc/e2e/prop.js $SLUG key | sed -n 's/^api_key=//p')
P=$(cat .superpowers/planc/e2e/port.txt)
cd /c/Users/robert/source/repos/sidon-booking-widget
[ -f /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/demo.env.local.bak ] || cp demo/.env.local /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/demo.env.local.bak
printf 'OTA_DEMO_BASE_URL=http://localhost:%s\nOTA_DEMO_API_KEY=%s\n' "$P" "$KEY" > demo/.env.local
git check-ignore -q demo/.env.local && echo ignored
```

Expected: `ignored`, and `KEY` is non-empty. If `prop.js key` created a key, it wrote `key-restore.json`.

Start the demo with `run_in_background: true`. `--strictPort` makes Vite fail instead of moving port, because `booking_url` hard-codes 5173:

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget && npm run dev -- --strictPort
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:5173/api/marina/guest/$SLUG"
```

Expected: Vite logs `Local: http://localhost:5173/`, and curl prints `200`. curl sent no key, so this shows the proxy added the e2e property's key.

- [ ] **Step 10: /marina-bookings: a confirmed stay for today and a pending Italian request**

1. `browser_navigate` to `http://localhost:4335/marina-bookings`.
2. Click `#mb-add-btn` and fill `#mb-create-dialog`:
   - `#mb-create-marina` E2E Marina, `#mb-create-berth` E2
   - `#mb-create-arrival` `$TODAY`, `#mb-create-departure` `$TODAY`+2
   - `#mb-create-name` `E2E Today`, email blank
   - `#mb-create-status` `confirmed`, `#mb-create-locale` `en`
   - Submit.
   - Expected: `POST …/api/marina/bookings` → 201 with `status: 'confirmed'`. The new row shows the 'Confirmed' pill.
3. Click `#mb-add-btn` again:
   - Marina E2E Marina, berth E1
   - Arrival `$TODAY`+7, departure `$TODAY`+9
   - Name `E2E Rossi`, `#mb-create-email` `e2e-it-<date +%s>@example.com`
   - `#mb-create-boat` `Gabbiano`, `#mb-create-length` `11`
   - `#mb-create-status` `pending`, `#mb-create-locale` `it`
   - Submit.
   - Expected:
     - `POST` → 201. The request body has `locale: 'it'`, `status: 'pending'`, `departure: '<$TODAY+7+2>'`. The response has `locale: 'it'` and `total_price` `100.00`, which is 2 × the fixed `50`.
     - The row shows 'Pending' and 'No payment'.
     - The row's buttons are exactly `confirm`, `decline`, `cancel`, `send-link` (plus `details`).
   - Record this booking's id as `<B1>`.

- [ ] **Step 11: /marina: tiles, the staff map, the berth panel**

1. `browser_navigate` to `http://localhost:4335/marina`. If `#marina-select` is visible, choose E2E Marina. Then `browser_wait_for` with `time: 4`.
2. `browser_snapshot`. Expected:
   - `#marina-dashboard` is visible and the interim `#marina-empty` / `#marina-map` are not.
   - The tiles read: `#marina-stat-arrivals` 1, `#marina-stat-departures` 0, `#marina-stat-onberth` 1, `#marina-stat-pending` 1.
   - The header has links to `/marina-bookings` and `/marina-setup`.
3. `browser_network_requests` with `filter: "/api/marina/guest/"`. Expected:
   - `GET http://localhost:4335/api/marina/guest/<slug>?from=<$TODAY>&to=<$TODAY+1>` → 200, which is relative, through D's forwarder.
   - `browser_network_request` `response-body` has E2 `available: false` and E1, E3 `available: true`.
   - No request goes to `marina.sidonmarine.uk`.
4. `browser_take_screenshot` of `#marina-staff-map`. Expected:
   - Chart style.
   - E2's circle is solid navy (`#16365b`, the OCCUPIED style).
   - E1 and E3 use the free paint.
   - No quick-book card shows.
5. Find E2's circle in the screenshot and click its centre with `browser_run_code_unsafe` `async (page) => { await page.mouse.click(<x>, <y>); return 'clicked'; }`. Expected:
   - `#marina-berth-panel` is open and shows berth E2, current booking `E2E Today` (Confirmed) and an action to open details.
   - `GET …/api/marina/bookings?berth_id=<E2 id>&from=<$TODAY-1>…` → 200.
6. Close the panel, then click E1's circle. Expected:
   - The panel shows no current booking and next booking `E2E Rossi` (Pending), with confirm and decline actions.
   - There is no "held by a guest checkout or in maintenance" note, because E1 is free on the map.
   - Close the panel.

- [ ] **Step 12: Confirm `<B1>` and send the guest link**

1. `browser_navigate` to `http://localhost:4335/marina-bookings`.
2. On `tr[data-id="<B1>"]`, click `button[data-action="confirm"]` and accept the dialog. Expected:
   - `PUT …/api/marina/bookings/<B1>` with `{action:'confirm'}` → 200.
   - The pill shows 'Confirmed'.
   - The row's actions are now `cancel` and `send-link`, with no `end` (departure is set).
3. Click `button[data-action="send-link"]`. Expected: `POST …/api/marina/bookings/<B1>/send-guest-link` → 200 `{"sent":true}`, and a success toast. With the preload, no email leaves the machine.

- [ ] **Step 13: Guest page in Italian, from the booking's own locale**

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config -e "console.log(require('./src/lib/marinaToken').bookingToken('<B1>'))"
```

That prints `<T>`.

1. `browser_tabs` `action: "new"`. This is tab 1; D stays in tab 0.
2. `browser_run_code_unsafe` with `code`:
   `async (page) => { await page.route('**/booking.html*', async (route) => { const res = await route.fetch(); const body = (await res.text()).replace(/<sidon-booking-widget[^>]*>/, '<sidon-booking-widget marina="<SLUG>" booking-id>'); await route.fulfill({ response: res, body }); }); return 'routed'; }`
   This swaps the demo page's `marina="demo-marina" … locale="en"` tag for the e2e slug with no `locale` attribute, without touching W's files.
3. `browser_navigate` to `http://localhost:5173/booking.html?booking=<B1>&token=<T>`, then `browser_wait_for` with `time: 3`.
4. `browser_evaluate` `() => { const w = document.querySelector('sidon-booking-widget'); return [w.getAttribute('marina'), w.getAttribute('locale')]; }`. Expected: `['<SLUG>', null]`.
5. `browser_snapshot`. Expected:
   - The labels are Italian: 'Prenotazione confermata', 'Sei dentro', 'Documenti' with the Passport row offering 'Carica', and 'Contratto di ormeggio' with 'Ho letto e accetto' / 'Accetto'.
   - The dates are formatted in Italian.
6. `browser_network_requests` with `filter: "/api/marina/guest/"`. Expected: `GET http://localhost:5173/api/marina/guest/<SLUG>/bookings/<B1>` → 200. Its `response-body` has `locale: 'it'` and `status: 'confirmed'`.

- [ ] **Step 14: Detail dialog: a live document upload, verify, view, download**

1. `browser_tabs` `action: "select"`, `index: 0`. On `tr[data-id="<B1>"]`, click `button[data-action="details"]`. Expected:
   - `#marina-booking-dialog` is open.
   - `GET …/bookings/<B1>` → 200 and `GET …/bookings/<B1>/documents` → 200 `[]`.
   - It shows no documents, no agreed contract, and payment 'No payment'.
2. Select tab 1. Click 'Carica' on the Passport row, then `browser_file_upload` with `C:/Users/robert/source/repos/OTA/.superpowers/planc/e2e/e2e-passport.pdf`. Expected:
   - `POST …/guest/<SLUG>/bookings/<B1>/documents` → 201.
   - The row shows 'Ricevuto · in verifica'.
3. Select tab 0 without reloading, then `browser_wait_for` with `time: 3`. Expected:
   - With `ably: same app` (Step 1): a second `GET …/bookings/<B1>/documents` → 200 after the upload, and the open dialog lists `e2e-passport.pdf` as pending. No navigation happened.
   - Otherwise: record "live dialog skipped: <Step 1 Ably result>". Close the dialog, reopen it with `details`, and expect the same row.
   - Record the document id `<DOC>` from that response body.
4. On the document row, click Verify with notes `e2e ok`. Expected: `PUT …/api/marina/documents/<DOC>` → 200 with `status: 'verified'`, and the dialog row shows verified.
5. Click the row's View. Expected:
   - `GET http://localhost:<P>/api/marina/documents/<DOC>/file` → 200, `content-type: application/pdf`.
   - `browser_tabs` `action: "list"` shows a new tab whose URL starts `blob:http://localhost:4335/`. Close that tab and select tab 0.
6. Click `#marina-booking-dialog li.mbd-doc[data-doc-id="<DOC>"] button[data-doc-download]` (Task 12 builds a temporary `<a download>` on click). Expected: MCP reports a download named `e2e-passport.pdf`. If this MCP build reports no downloads, run instead `browser_run_code_unsafe` with `async (page) => { const d = page.waitForEvent('download'); await page.click('#marina-booking-dialog button[data-doc-download]'); return (await d).suggestedFilename(); }`, expecting `'e2e-passport.pdf'`.

- [ ] **Step 15: Contract agreed on the guest page → rendered text in the dialog**

1. Select tab 1. Tick 'Ho letto e accetto' and click 'Accetto'. Expected:
   - `POST …/guest/<SLUG>/bookings/<B1>/contract` → 201.
   - The section shows 'Accettato il <date>'.
2. Select tab 0 and `browser_wait_for` with `time: 3`. Expected:
   - With Ably: another `GET …/bookings/<B1>` → 200 without reload. Otherwise reopen the dialog.
   - That response's `signature` has `agreed_at` and `rendered_body`. `rendered_body` contains `E2E Rossi`, `Gabbiano` and `E1`, and no `{{`.
   - The dialog's contract section shows that text and the agreed time.

- [ ] **Step 16: Cancel `<B1>` (no payment)**

1. Close the dialog. On `tr[data-id="<B1>"]`, click `button[data-action="cancel"]`. With `payment_status` `none`, this is a plain confirm dialog. Accept it. Expected:
   - `PUT …/bookings/<B1>` with `{action:'cancel', refund:false}` → 200.
   - The pill shows 'Cancelled'.
   - The row leaves the table if the status filter excludes cancelled. Otherwise it has no action buttons.
2. Select tab 1 and `browser_wait_for` with `time: 3`. Expected: the hero shows 'Prenotazione annullata', via Ably or the polling/visibility refetch.

- [ ] **Step 17: Card booking: captured on confirm, then cancel & refund (skip without Stripe test keys)**

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planc/e2e/card.js $SLUG E3 <$TODAY+14> <$TODAY+16>
```

If it prints `SKIP: no Stripe keys`, matching Step 7's `stripe` field, record `no Stripe keys: refund path skipped` and go to Step 18. A staff user can't set the keys (admin-only). Otherwise it prints `{ id: <B2>, status: 'pending', payment_status: 'held', total: '100.00', … }`. Then, in tab 0:

1. `browser_wait_for` with `time: 3`. Expected:
   - `tr[data-id="<B2>"]` appears without reload, via the `new-booking` event and a refetch.
   - It shows 'Pending' and 'Card held'.
   - If it doesn't appear, reload, and record "live new-booking skipped".
2. Click `confirm` and accept. Expected:
   - `PUT …/bookings/<B2>` → 200 with `status: 'confirmed'`, `payment_status: 'captured'`.
   - The pills show 'Confirmed' and 'Paid'.
3. Click `cancel`. Expected: a choice dialog with 'Cancel & refund', 'Cancel & keep payment' and 'Keep booking'. Choose 'Cancel & refund'. Expected:
   - `PUT …/bookings/<B2>` with `{action:'cancel', refund:true}` → 200, `payment_status: 'refunded'`.
   - The pills show 'Cancelled' and 'Refunded'.

- [ ] **Step 18: Pirates Bight safety: deactivate the e2e marina, re-run the interim spec**

1. `browser_navigate` to `http://localhost:4335/settings`, then the Marina tab. On `li.marina-row[data-id="<marina id>"]`, click `.marina-row-remove` and accept. Expected:
   - `PUT …/api/marina/marinas/<marina id>` → 200 with `status: 'inactive'`.
   - The row is greyed (`.is-inactive`) and offers `.reactivate-btn`.

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planc/e2e/prop.js $SLUG show
```

Expected: `status: 'inactive'`. Record `active_marinas`. If it is above 0, earlier spec runs left marinas active. Deactivate each `pw-marina-…` row the same way, and re-run until `active_marinas: 0`.

2. With `sidon_marina_id: null` and 0 active marinas, `browser_navigate` to `http://localhost:4335/dashboard`. Then `browser_evaluate` `() => document.querySelector('[data-marina]')?.hidden ?? 'no item'`. Expected: `true`, so there is no Marina nav item.

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npx playwright test tests/marina-interim.spec.ts
```

Expected: all of its tests pass. That covers the interim page on the 0.4.17 element, the nav cases, and the forwarder smoke.

- [ ] **Step 19: Any outcome that doesn't match → fix it in the owning code, failing check first, then re-run**

1. Find the owner:
   - OTA `O/src/…`
   - Widget `W/src/…`
   - Dashboard `D/src/…`
   - A scratch helper in `O/.superpowers/planc/e2e/`: fix it in place, no commit.
2. Write the failing check:
   - OTA: add a `check(...)` above `// (later tasks append here)` in `O/scripts/check-marina-http.js`. Run `cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js`. Expected: `FAIL <name>`.
   - Widget pure logic (`W/src/lib/ota.ts`, `W/src/astro-proxy.ts`): add an assert to `W/scripts/check-ota.ts` or `W/scripts/check-astro-proxy.ts`. Run `cd /c/Users/robert/source/repos/sidon-booking-widget && npm test`. Expected: an `AssertionError` on it.
   - Dashboard pure logic (`D/src/lib/marina-logic.ts`): add an assert in that function's `// ---- <fn> ----` block of `D/scripts/check-marina.ts`. Run `cd /c/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts`. Expected: an `AssertionError`.
   - Dashboard UI: add a `test(...)` that reproduces the failure to the owning spec (`tests/marina-*.spec.ts`). Run `npx playwright test tests/<spec>.ts`. Expected: it fails.
3. Fix it and re-run the same command. Expected:
   - OTA: `all passed`.
   - W: `check-ota: ok`, plus `npm run check` with 0 errors.
   - D: `check-marina: ok`, or the spec passes.
4. A widget fix also has to reach D. Run `cd /c/Users/robert/source/repos/sidon-booking-widget && npm run build && npm pack --pack-destination ../ota-table-bookings/vendor`, then `cd /c/Users/robert/source/repos/ota-table-bookings && npm install`. The version stays `1.1.0`, so the same tarball file name is overwritten.
5. Restart what the fix touched:
   - OTA: stop it and re-run the Step 3 start command.
   - D: `npx astro dev stop`, then the Step 4 start.
   - W: Vite reloads `src/` by itself.

   Then re-run the failing step from its start. If it needs a fresh booking, begin at Step 10, or at Step 7 with a new slug if the marina was already deactivated.
6. Commit each fix on its own, in its repo, with explicit paths. For example:

```bash
git -C /c/Users/robert/source/repos/OTA add src/controllers/marinaDocuments.js scripts/check-marina-http.js && git -C /c/Users/robert/source/repos/OTA commit -m "Marina staff API: <what the e2e found>" -m "Found by the plan C end-to-end run." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/sidon-booking-widget add src/lib/ota.ts scripts/check-ota.ts && git -C /c/Users/robert/source/repos/sidon-booking-widget commit -m "Widget 1.1: <what the e2e found>" -m "Found by the plan C end-to-end run." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/ota-table-bookings add vendor/forgebuild-sidon-booking-widget-1.1.0.tgz package-lock.json && git -C /c/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: re-vendor widget 1.1.0 with <fix>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/ota-table-bookings add src/lib/marina-logic.ts scripts/check-marina.ts && git -C /c/Users/robert/source/repos/ota-table-bookings commit -m "Marina dashboard: <what the e2e found>" -m "Found by the plan C end-to-end run." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

   Stage exactly the files the fix changed. Never `-A`, `--no-verify` or `--amend`. Note each commit hash next to its item in Step 22.

- [ ] **Step 20: Stop the servers, restore the key and the demo env**

1. `browser_close`.
2. `cd /c/Users/robert/source/repos/ota-table-bookings && npx astro dev stop`.
3. Stop the Step 3 and Step 9 background commands with `TaskStop`, or by port:

```bash
P=$(cat /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/port.txt)
for port in $P 5173; do
  for pid in $(netstat -ano | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do taskkill //PID "$pid" //T //F; done
done
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planc/e2e/prop.js $SLUG restore
cp /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/demo.env.local.bak /c/Users/robert/source/repos/sidon-booking-widget/demo/.env.local && rm /c/Users/robert/source/repos/OTA/.superpowers/planc/e2e/demo.env.local.bak
```

Expected:
- A `SUCCESS: The process with PID … has been terminated.` line for each port.
- `api key restored` or `nothing to restore`.
- Step 1's port loop then prints nothing for `$P`, 4335 and 5173.

4. Restart anything Step 1 stopped, with `run_in_background: true`. For the user's OTA on 3100: `cd /c/Users/robert/source/repos/OTA && PORT=3100 npm run dev`.

- [ ] **Step 21: Re-run every gate**

```bash
cd /c/Users/robert/source/repos/OTA && set -o pipefail && node -r dotenv/config scripts/check-marina.js | tail -n 1 && node -r dotenv/config scripts/check-marina-http.js | tail -n 1
cd /c/Users/robert/source/repos/sidon-booking-widget && npm test && npm run check && npm run build
cd /c/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts && npm run build
```

Expected:
- OTA: `all passed`, twice.
- W:
  - `check-astro-proxy: createMarinaClient assertions passed` and `check-ota: ok`.
  - `svelte-check found 0 errors`, and `tsc` prints nothing.
  - The build ends without errors and writes `dist/` (gitignored).
- D: `check-marina: ok`, then Astro's `Complete!`.

- [ ] **Step 22: Record the results; confirm the end state**

In the task report, tick each item as you observed it. For a failed item, add the Step 19 fix commit. For an item that did not run, write `skipped: <reason>`.

- [ ] Specs: all six marina specs passed (Step 5), and `marina-interim.spec.ts` passed again with no active marina (Step 18).
- [ ] Forwarder:
  - Signed out → `401 {"error":"Not signed in"}`.
  - The staff map payload went through `http://localhost:4335/api/marina/guest/…`.
  - Nothing went to `marina.sidonmarine.uk`.
- [ ] Settings: the marina was created with its booking URL, auto-confirm off, then deactivated and shown greyed with Reactivate.
- [ ] Setup:
  - Pontoon SVG read client-side → 201.
  - CSV → `upserted: 3`, with the blank status taking the default `active`.
  - The document requirement and contract template were saved, with no placeholder warning.
- [ ] `/marina`:
  - Tiles 1/0/1/1.
  - E2 navy in chart style, E1/E3 free.
  - The E2 panel showed the current booking; the E1 panel showed the next pending booking with confirm/decline.
- [ ] Bookings:
  - Pending `it` booking created (`locale: 'it'`, total 100.00).
  - Confirmed → 200.
  - send-guest-link → 200 `{"sent":true}`.
- [ ] Guest page: with no `locale` attribute the labels were Italian (`booking.locale` = `it`).
- [ ] Documents:
  - The upload reached the open dialog without reload, or `skipped: <Ably reason>` with a reopen.
  - Verify → 200 verified.
  - View opened a `blob:` tab after a 200 PDF fetch.
  - Download named `e2e-passport.pdf`.
- [ ] Contract: the guest agreed (201, 'Accettato il …'), and the dialog showed `rendered_body` with the booking's values and no `{{`.
- [ ] Cancel: `<B1>` cancelled (refund false), and the guest page showed 'Prenotazione annullata'.
- [ ] Refund: `<B2>` went 'Card held' → 'Paid' on confirm → 'Cancelled' + 'Refunded'. Or `no Stripe keys: refund path skipped`.
- [ ] Nav: with 0 active marinas and no Sidon id, `[data-marina]` was hidden.
- [ ] Gates (Step 21): all green.
- [ ] Deferred items: list anything observed but out of scope, for example the R11 plan B minors still deferred and any UI nits. Give each one a line and its owning repo.

```bash
for r in OTA sidon-booking-widget ota-table-bookings; do echo "== $r"; git -C /c/Users/robert/source/repos/$r status --short; git -C /c/Users/robert/source/repos/$r log --oneline origin/main..main | head -n 40; done
```

Expected:
- Each repo is on `main` with plan C's commits (plus any Step 19 fixes) listed as unpushed.
- OTA's status shows only `?? =` and `?? src/db/seed-extras.sql.pre-multi-property.bak`. The other two show nothing. The scratch files and `W/demo/.env.local` are gitignored.
- If Step 19 found no defect, there is nothing to commit in this task.

End state: plan C is complete on `main` in O, W and D. Nothing is pushed, published or deployed. The later runbook does those steps after the user approves:
- push O (Render auto-deploys `main`)
- `npm publish` 1.1.0 from W
- push and deploy D on Vercel
