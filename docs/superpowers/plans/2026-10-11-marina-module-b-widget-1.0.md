# Marina module, plan B: sidon-booking-widget 1.0 + astro-proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@forgebuild/sidon-booking-widget@1.0.0` speaks OTA's guest API (already live from plan A) through a per-site forwarder, with booking-page mode for documents/contract/payment resume, plus `/astro-proxy` (`createMarinaProxy`, `createMarinaClient`) — ready to publish, with OTA's small guest-API follow-ups shipped first.

**Architecture:** Task 1 adds the few OTA fields the booking page needs. In the widget repo, a pure adapter layer (`lib/ota.ts`, node-tested) maps OTA payloads onto the widget's camelCase types, so the Svelte components change shape as little as possible; the berth map and the booking wizard are migrated onto it, and a new `BookingView` component serves both step 3 and `<sidon-booking-widget booking-id>`. The forwarder and server client are one self-contained, erasable-TS file compiled by `tsc` as a separate `exports` entry so servers never import the browser bundles. Task 10 drives the real demo against a local OTA with Playwright.

**Tech Stack:** Svelte 5 (runes, custom elements), Vite 8, TypeScript 6 (Node 25 native type stripping for checks), Stripe.js Payment Element (no Connect), Ably Realtime (token auth), Express/pg (OTA), Playwright MCP for e2e.

**Spec:** `docs/superpowers/specs/2026-10-10-ota-marina-unification-design.md` — sections "The forwarder, the server client and the widget", "Guest routes", "Booking lifecycle", "Testing approach". Research behind this plan (survey of the widget, every consumer site and Astro internals) was summarised into the binding contract below.

## Global Constraints

- Repos: `W` = `C:/Users/robert/source/repos/sidon-booking-widget`, `O` = `C:/Users/robert/source/repos/OTA`. Task 1 is in `O`; Tasks 2–9 in `W`; Task 10 uses both.
- Version `1.0.0`. Tag names, every attribute, every event name and detail field name stay (R1). `api-origin` defaults to the page origin (R2); `marina` is the OTA slug.
- Base path `${apiOrigin}/api/marina/guest/${slug}`; the forwarder is the only thing that talks to OTA, with the property's `X-Api-Key`.
- Upload limit 4 MiB (`4 * 1024 * 1024`, OTA's `express.raw` limit), forwarder body cap 4.5 MB (`4_500_000`, Vercel's).
- Booking token travels only in the `X-Booking-Token` header and the booking page's `?token=` (stripped from the URL after reading); never in API URLs.
- No `{@html}` of server text; no third-party scripts in booking-page mode beyond Stripe and Ably.
- `npm test` (node assert scripts) and `npm run check` (svelte-check + tsc, 0 errors from Task 8 on) gate every widget commit; OTA's `scripts/check-marina.js` and `scripts/check-marina-http.js` gate Task 1.
- Commits: explicit paths only (never `-A`), message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Nothing in this plan publishes to npm, pushes a repo, or deploys** (R22). Release is a separate, user-approved step (see the end).

## Review Focus

- **Encoded path traversal through the forwarder** (`%252e%252e/%252e%252e/bookings`, `x%252f..%252f..%252fmcp`, backslashes, control characters): must 404 without calling OTA — the site's API key would otherwise reach staff routes. Pinned in Task 3's `check-astro-proxy.ts`.
- **A guest who goes back from payment and changes dates/berth/length**: the old hold must be cancelled before a new one is created (no self-inflicted 409, no stuck berth, no fourth booking against the email cap). Pinned in Task 8 (goBack cancels) and Task 10 Step 14 item 2 / Step 17 item 8.
- **A reload (or a closed tab) after the card was authorised but before confirm-payment**: the booking view must call confirm-payment first and land on `pending`, never remount a Payment Element on a `requires_capture` intent. Pinned in Task 7 (R10 resume order) and Task 10 Step 14 items 5–5b (confirm-payment aborted once, then a reload resumes to `pending`).
- **Regional locales and non-ASCII file names** (`it-IT`, `Pässport ñ.pdf`): labels and OTA emails in Italian, upload header never throws. Pinned in Task 5's `check-ota.ts` (`langOf`, `asciiFileName`).
- **OTA cold start / outage** (Render spin-up, Stripe down): forwarder answers JSON 504/502 instead of an Astro HTML error page, and the booking page still renders without payment. Pinned in Task 3 (timeout → 504, fetch rejection → 502) and Task 1 (PI retrieve failure → `payment: null`).

---

## Binding contract

The rulings and shared interfaces every task below implements. Where a task's text and this section disagree, this section wins.


### Design rulings (binding — do not re-decide)

R1 Version: `@forgebuild/sidon-booking-widget@1.0.0`. Element tag names, every existing attribute, every event NAME and detail FIELD NAMES stay. Value types may change where the backend changed: berth ids are labels (strings, as before); `bookingId` becomes a UUID string; `marina` is the OTA slug.
R2 `api-origin` default becomes `''` (page origin; URLs relative). Base path `${apiOrigin.replace(/\/$/,'')}/api/marina/guest/${encodeURIComponent(slug)}`.
R3 Data layer: one adapter maps OTA snake_case payloads to the widget's camelCase types (`adaptMarina`); `Number()` on every NUMERIC string; berth `status = available ? 'available' : 'occupied'`. Unknown SVG `data-berth-id` labels are UNAVAILABLE. Server client (`createMarinaClient`) returns OTA raw snake_case.
R4 Fit rule = OTA's `berthFitError` (O/src/lib/marinaGuard.js): boat ≤ length_m, boat ≥ min_length_m, beam ≤ beam_m, each skipped when the berth value is null.
R5 Prices/auto-pick: both elements call `GET {base}/availability?arrival&departure&boat_length_m[&boat_beam_m]` (debounced) — it returns free, fitting berths with `total_price` from OTA's own `priceStay`. No client-side price maths. Auto-pick = cheapest non-null `total_price`, tie → smaller `length_m`; berths with null total sort last. Manual pick must be in that list. Season gating (`seasonRangesFromTiers` / `applySeasonGate` in date-range.ts) keeps working on adapted tiers.
R6 Wizard steps (keep `sidon-step-change {step:1|2|3}`): 1 = Details (summary bar + contact/boat form), 2 = Payment (Stripe Payment Element; only when the create response has `payment`), 3 = Booking (booking-page view in place). Documents and the contract are NOT in the wizard; they live in the booking view (spec). The pre-booking contract preview is dropped from the widget.
R7 Hold lifecycle in the wizard: Next on step 1 → `POST {base}/bookings` (creates a 30-min `hold`). If `payment` → step 2; Pay → `stripe.confirmPayment({redirect:'if_required'})` → `POST …/confirm-payment` → step 3. If `payment` is null (unpriced or property lacks Stripe keys) → step 3 directly (hold awaiting the emailed confirm link). Back from step 2 → `POST …/cancel` the hold, then step 1 (inputs on step 1 only, as today). On reaching step 3 emit `sidon-booked {bookingId, marina}`.
R8 Session: after create, store `{id, token}` in `sessionStorage['sidon-booking:'+slug]`. On wizard mount, if a session exists, render the booking view for it (it resumes payment while `hold`) with a "Start a new booking" action that clears the session (cancelling a `hold` first).
R9 Booking-page mode: `<sidon-booking-widget booking-id>` (boolean presence; a non-empty value overrides the id). Reads `?booking=&token=`, saves them to the session, removes `token` from the URL with `history.replaceState`. In booking-page mode (and in the step-3 view) never load Google Maps or weather.
R10 Booking view features: status hero for hold / pending / confirmed / declined / cancelled / expired (`booking.expired`), details, payment resume while `hold` (call confirm-payment FIRST: 200 → done; 409 "not authorised" → mount Payment Element with `payment.client_secret`; 410 → expired), "check your email" panel for `hold` without `payment` (show `hold_expires_at` time), documents per requirement (upload only while pending/confirmed; state from `documents[]`), contract show + agree (only when `contract` non-null, `agreed_at` null, status pending/confirmed), cancel (hold/pending, confirm() first). Emit `sidon-booking-status {bookingId, status}` whenever the observed status changes after first load (status = OTA status string).
R11 Live updates: Ably Realtime with `authCallback` that calls `GET …/bookings/:id/ably-token` EVERY time (never replay one TokenRequest); channel `marina-booking:{id}`, event `updated` → refetch `GET booking`. If the token route returns 503 or Ably fails → poll `GET booking` every 30 s, but never while status is `hold`. Also refetch on `visibilitychange` (visible) and after every own action. Close on unmount.
R12 Uploads: `prepareUpload(file)`: PDF passes if ≤ 4 MiB (4*1024*1024) else error; JPEG/PNG ≤ 4 MiB pass as-is; any other image (or oversize JPEG/PNG) → `createImageBitmap` → canvas, longest side ≤ 2000 px, JPEG quality 0.85 (retry 0.7) ; undecodable → error "Please upload a PDF, JPEG or PNG". Send raw Blob, `Content-Type` = the final type, `X-File-Name` = ASCII-only (`/[^\x20-\x7E]/g → '_'`, ≤ 200 chars), `?requirement_id=` always.
R13 Locale: `langOf(locale)` = first 2 letters lower-cased if in en/it/fr/es else 'en'; used for labels AND sent to OTA. Currency: if `currency-symbol` attribute is non-empty → `${symbol}${amount}`; else `Intl.NumberFormat(lang,{style:'currency',currency})`. Default `currency-symbol` becomes `''`.
R14 Input limits: `maxlength` name 100, boat name 100, phone 30, notes 2000; email `type=email`.
R15 Errors: every API call parses OTA `{error}` safely (non-JSON bodies → fallback message, never a raw SyntaxError); `MarinaApiError` carries `status`. `loadError` is cleared on the next successful load.
R16 Map: `<sidon-berth-map>` guest behaviour: chart style unavailable berths are NOT clickable; unknown labels unavailable; card total + auto-pick from availability (R5). Staff/select-any mode for the dashboard is deferred to plan C (1.1.0).
R17 Astro proxy: one self-contained file `W/src/astro-proxy.ts` (no relative runtime imports, no node: imports, erasable TS only), compiled by `tsc -p tsconfig.proxy.json` to `dist/astro-proxy.js` + `.d.ts` as the LAST build step; `exports["./astro-proxy"] = {types:"./dist/astro-proxy.d.ts", import:"./dist/astro-proxy.js"}`. Structural APIRoute type (no astro dependency).
R18 `createMarinaProxy({ otaBaseUrl, keys, timeoutMs = 60000 })`: `keys: string | Record<slug,string>`. Behaviour per spec plus: methods GET, HEAD (treated as GET), POST else 404; path guard per spec (segments non-empty, not `.`/`..`, no `\`, `%`, control chars; `new URL('/api/marina/guest/'+path, otaBaseUrl)` pathname must start with `/api/marina/guest/`); query from `new URL(request.url).search`; body: reject Content-Length > 4.5 MB (4_500_000) with 413 JSON, else `arrayBuffer()` and re-check; forwards only `Content-Type`, `X-File-Name`, `X-Booking-Token`, `User-Agent`; sets `X-Client-Ip` from `clientAddress` (read in try/catch; omit if it throws or is empty) and `X-Api-Key`; `redirect:'manual'`; upstream 3xx → 502 JSON; network error → 502 JSON `{error:'Booking service unavailable'}`; timeout (AbortSignal.timeout) → 504 JSON; response always a NEW `Response(upstream.body, {status, headers})` with only `content-type`, `cache-control`, `retry-after`, `ratelimit-*`, `ratelimit` headers copied. Multi-key: first path segment selects the key; unknown slug → 404 JSON.
R19 `createMarinaClient({ otaBaseUrl, keys })` (same `keys` rule; spec's `apiKey` is the single-string case): `slugs: string[]` (map keys, or `[]` for a single key), `getMarina(slug, {from,to}?) → raw payload | null` (null on 404, throw `MarinaClientError` with `.status` otherwise), `getDocRequirements(slug) → raw array | null`. Retries 429 up to 3 times waiting `Retry-After` seconds (cap 30 s, default 5 s). No cache.
R20 OTA follow-ups (Task 1, in O): `GET /guest/:marina/bookings/:id` response gains top-level `documents: [{id, requirement_id, file_name, status, submitted_at}]` (no extracted_data/blob path) and `booking.expired` (boolean: status cancelled AND cancel_reason 'expired'); its Stripe PI retrieve is wrapped in try/catch (payment null on failure); `createGuestBooking` returns 503 `{error:'Online booking is not configured'}` BEFORE inserting when `MARINA_BOOKING_TOKEN_SECRET` is unset; card path requires `toCents(total_price) > 0` (zero → email-confirm path). Swagger + `scripts/check-marina-http.js` updated; plus `scripts/seed-marina-demo.js` (idempotent local demo property/marina for the widget demo; refuses remote DBs; prints the API key).
R21 Tests: widget gets `npm test` = node assert scripts run with Node's native TS stripping: `node scripts/check-astro-proxy.ts && node scripts/check-ota.ts` (each imports `../src/...ts` files that contain only erasable syntax and NO relative runtime imports — type-only imports are fine). UI is verified by `npm run check` (svelte-check, must be 0 errors), `npm run build`, and the Playwright e2e task. Fix the 3 pre-existing svelte-check errors in the baseline task.
R22 Do NOT publish to npm, push any repo, or deploy in any task — release is gated on the user.

### Shared TypeScript interfaces (exact names)

`W/src/lib/types.ts` (rewrite):
```ts
export type BookLang = 'en' | 'it' | 'fr' | 'es';
export interface MarinaProfile { slug: string; name: string; lat: number | null; lng: number | null; phone: string | null; email: string | null; }
export interface Berth {
  berthId: string;            // = OTA label
  pontoonId: string | null;
  pricePerNight: number | null;
  priceMode: 'per_metre' | 'fixed';
  status: 'available' | 'occupied';
  lat: number | null; lng: number | null; rotation: number | null;
  lengthM: number | null; minLengthM: number | null; beamM: number | null; depthM: number | null;
}
export interface PriceTier { validFrom: string; validTo: string; maxLenM: number; maxBeamM: number | null; pricePerNight: number; }
export interface OverlayRow { svgData: string; swLat: number; swLng: number; neLat: number; neLng: number; rotation: number | null; }
export interface OtherMarina { name: string; lat: number; lng: number; logoMark: string | null; href: string | null; }
export interface MarinaData {
  profile: MarinaProfile; berths: Berth[]; priceTiers: PriceTier[];
  stripePublishableKey: string | null; currency: string;
  overlays: OverlayRow[]; layout: OverlayRow | null;
}
export interface DocRequirement { id: string; type: string; name: string; description: string; mandatory: boolean; }
export interface AvailableBerth { label: string; lengthM: number | null; beamM: number | null; depthM: number | null; nights: number; totalPrice: number | null; }
export type BookingStatus = 'hold' | 'pending' | 'confirmed' | 'declined' | 'cancelled';
export interface GuestBooking {
  id: string; status: BookingStatus; expired: boolean;
  berthLabel: string; marinaName: string; arrival: string; departure: string | null;
  contactName: string; contactEmail: string | null; boatName: string | null;
  boatLengthM: number | null; boatBeamM: number | null;
  totalPrice: number | null; currency: string | null; paymentStatus: string;
  holdExpiresAt: string | null; locale: BookLang; docCount: number;
}
export interface GuestDocument { id: string; requirementId: string | null; fileName: string | null; status: 'pending' | 'verified' | 'rejected'; submittedAt: string; }
export interface PaymentSession { clientSecret: string; publishableKey: string; }
export interface GuestContract { templateId: string | null; renderedBody: string; agreedAt: string | null; }
export interface BookingView { booking: GuestBooking; payment: PaymentSession | null; contract: GuestContract | null; documents: GuestDocument[]; }
export interface CreateBookingInput { berthLabel: string; arrival: string; departure: string; contactName: string; contactEmail: string; contactPhone?: string; boatName: string; boatLengthM: number; boatBeamM?: number | null; notes?: string; locale: BookLang; }
export interface CreatedBooking { booking: GuestBooking; token: string; payment: PaymentSession | null; }
export interface BookingSession { id: string; token: string; }
```

`W/src/lib/ota.ts` (pure; only type-only imports; tested by `scripts/check-ota.ts`):
```ts
export function guestBase(apiOrigin: string, slug: string): string;
export function langOf(locale: string | null | undefined): BookLang;
export function adaptMarina(raw: any): MarinaData;
export function adaptRequirements(raw: any): DocRequirement[];
export function adaptAvailability(raw: any): AvailableBerth[];
export function adaptBooking(raw: any): GuestBooking;
export function adaptBookingView(raw: any): BookingView;          // raw = {booking, payment, contract, documents}
export function adaptCreated(raw: any): CreatedBooking;           // raw = {booking, booking_token, payment}
export function toCreateBody(input: CreateBookingInput): Record<string, unknown>; // snake_case OTA body
export function fitsBerth(b: Pick<Berth,'lengthM'|'minLengthM'|'beamM'>, loa: number, beam?: number | null): boolean;
export function pickCheapest(list: AvailableBerth[]): string | null;
export function formatMoney(amount: number | null, currency: string | null, symbolOverride: string, lang: BookLang): string;
export function asciiFileName(name: string): string;
export async function readError(res: Response, fallback: string): Promise<string>;
```

`W/src/lib/marina-api.ts` (rewrite; every function takes `apiOrigin, slug` first; all POSTs send `Content-Type: application/json` with body `'{}'` when there is no payload, except the upload):
```ts
export class MarinaApiError extends Error { constructor(message: string, public status: number) }
getMarina(apiOrigin, slug, range?: {from: string; to: string}): Promise<MarinaData>   // only sends from/to when to > from
getDocRequirements(apiOrigin, slug): Promise<DocRequirement[]>
getAvailability(apiOrigin, slug, q: {arrival: string; departure: string; boatLengthM: number; boatBeamM?: number | null}): Promise<AvailableBerth[]>
createBooking(apiOrigin, slug, input: CreateBookingInput): Promise<CreatedBooking>
getBooking(apiOrigin, slug, s: BookingSession): Promise<BookingView>
confirmPayment(apiOrigin, slug, s: BookingSession): Promise<GuestBooking>
cancelBooking(apiOrigin, slug, s: BookingSession): Promise<GuestBooking>
uploadDocument(apiOrigin, slug, s: BookingSession, p: {blob: Blob; contentType: string; fileName: string; requirementId: string}): Promise<GuestDocument>
agreeContract(apiOrigin, slug, s: BookingSession): Promise<GuestContract>
getAblyTokenRequest(apiOrigin, slug, s: BookingSession): Promise<import('ably').TokenRequest | null>   // null on 503
```
`X-Booking-Token: s.token` on every `/bookings/:id…` call.

`W/src/lib/booking-session.ts`: `loadSession(slug): BookingSession | null`, `saveSession(slug, s)`, `clearSession(slug)`, `takeSessionFromUrl(): BookingSession | null` (reads `booking`/`token` query params, strips `token` via `history.replaceState`, returns null when either is missing). All sessionStorage access in try/catch.

`W/src/lib/upload-prep.ts`: `prepareUpload(file: File): Promise<{ blob: Blob; contentType: 'application/pdf' | 'image/jpeg' | 'image/png'; fileName: string }>` (throws `Error(message)`), `MAX_UPLOAD_BYTES = 4 * 1024 * 1024`.

`W/src/lib/stripe.ts`: `createPaymentSession({ publishableKey, clientSecret, locale, mount: HTMLElement, colorPrimary })` → `Promise<{ confirm(): Promise<void>, destroy(): void }>` (no `stripeAccount`).

Components (Svelte 5 runes):
- `BookingWidget.svelte` (element): owns mode switching (wizard vs booking view), step state, hold create/cancel, sessions, events. Renders `<BookingView>` for step 3 / booking-page mode / resumed session.
- `components/BookingView.svelte` props: `{ apiOrigin: string; slug: string; session: BookingSession; lang: BookLang; currencySymbol: string; variant: 'navy'|'dark'; host: HTMLElement; onstatus: (status: BookingStatus, previous: BookingStatus | null) => void; onstartover?: () => void }` (host = the custom element, for the light-DOM Stripe mount). Contains `DocumentsSection.svelte` (props `{ apiOrigin, slug, session, lang, booking: GuestBooking, requirements: DocRequirement[], documents: GuestDocument[], onchange: () => void }`; BookingView fetches `getDocRequirements` once and passes it down) and `ContractSection.svelte` (props `{ apiOrigin, slug, session, lang, booking, contract: GuestContract, onchange }`).
- `components/DetailsStep.svelte`: contact/boat form only (fields contactName, contactEmail, contactPhone, boatName, boatBeamM, notes) via `$bindable` props; no document locks, no contract.
- `components/PaymentStep.svelte`: shows total + mounts Payment Element; props `{ payment: PaymentSession; host: HTMLElement; lang; locale; totalLabel: string }` and exposes `confirm()` via `bind:this`.
- Deleted: `SentStep.svelte`, `DocumentsStep.svelte` (replaced by DocumentsSection), `lib/guest-token.ts`, `getContractPreview`/`createIntent`/`submitBooking`/`uploadGuestDoc`/`getAblyToken`, `berth-pricing.ts` price helpers (`derivedNightlyPrice`, `pickBestFit`, `nightlyFromTiers`) — delete the file if nothing else uses it.
- i18n (`lib/i18n.ts`): `getLabels(lang: BookLang)` keyed by `BookLang`; Task 7 adds the booking-view keys flat on `BookLabels` (no group) and `getLabels`; Task 8 adds the `wizard` group and removes the old `getBookLabels` (each lists its exact keys + all 4 translations).

### Plan conventions

- Each task: **Files**, **Interfaces** (Consumes/Produces using the names above), then `- [ ]` steps: failing check first where there is pure logic, run it (expected failure), implement, run (expected pass), `npm run check` 0 errors where Svelte changed, commit (`git -C <repo> add <explicit paths> && git -C <repo> commit -m "..."` — explicit paths only, never `-A`; message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Complete code in every code step (no "similar to", no TODO). Match the surrounding code's comment style (explain why).
- Windows host; commands shown for bash (Git Bash).

---

## Tasks

### Task 1: OTA guest-API follow-ups and the demo seed

Repo: `O` = `C:/Users/robert/source/repos/OTA`. Implements R20. Commands are for Git Bash. The OTA scripts load `.env` from the working directory, so they run from `O`.

**Files:**
- Modify: `O/src/controllers/marinaGuest.js`
  - `guestView`, lines 124-132
  - `createGuestBooking`: insert after line 140, replace line 155
  - `getGuestBooking`: lines 204-207 and 217
- Modify: `O/src/docs/swagger.js`, lines 726 and 729
- Modify: `O/scripts/check-marina-http.js`: insert above line 387 (`// (later tasks append here)`)
- Create: `O/scripts/seed-marina-demo.js`

**Interfaces:**
- Consumes (existing code):
  - `q.joinedBooking` (`mb.*`, so it includes `cancel_reason`)
  - `life.sweepOnce`
  - `toCents` (`src/lib/folio.js`)
  - `bookingToken` (`src/lib/marinaToken.js`, which throws when the secret is unset)
  - The check helpers `api()`, `guestBody()`, `pendingBooking()`, `upload()`, `pdf`, `fake`, `life`, `m`, `P` and `n`
- Produces (Task 5's `adaptBooking` / `adaptBookingView` / `adaptCreated` read these):
  - `GET /api/marina/guest/:marina/bookings/:id` returns `{ booking, payment: {client_secret, publishable_key} | null, contract: {template_id, rendered_body, agreed_at} | null, documents: [{ id, requirement_id, file_name, status, submitted_at }] }` and becomes `BookingView.documents: GuestDocument[]`.
  - Every guest route that returns `booking` (create, get, cancel, confirm-payment) gains `expired: boolean` (status `cancelled` AND `cancel_reason = 'expired'`), which becomes `GuestBooking.expired`.
  - `POST /api/marina/guest/:marina/bookings`:
    - returns `503 {error:'Online booking is not configured'}` before any insert when `MARINA_BOOKING_TOKEN_SECRET` is unset
    - returns `payment: null` when `total_price` is null or `0.00` (the email-confirm path)
  - `scripts/seed-marina-demo.js` creates:
    - property `Marina Demo`
    - marina slug `demo-marina` with berths `A1`–`A6`
    - `booking_url` = `http://localhost:5173/booking.html?booking={id}&token={token}`
    
    It prints `api_key=<key>` and `slug=demo-marina` on stdout. OTA serves the demo at `http://localhost:3000`.

- [ ] **Step 1: Write the failing HTTP checks**

In `O/scripts/check-marina-http.js`, insert this block directly above line 387 (`    // (later tasks append here)`). Keep the marker after it.

```js
    // ---- Plan B Task 1 (R20) ----
    // guestBody's rolling dates would reach the staff booking fixed at
    // +400 days within three more calls; jump past every fixed fixture.
    n = 100;
    const ipR20 = { 'X-Client-Ip': '192.0.2.140' };
    const view = (b) => api('GET', `${G}/bookings/${b.booking.id}`, { headers: { 'X-Booking-Token': b.booking_token } });
    await check('R20: booking page lists document metadata only', async () => {
      const b = await pendingBooking();
      const d = (await upload(b, pdf)).body;
      await pool.query("UPDATE marina_document SET extracted_data = '{\"number\":\"X9\"}' WHERE id = $1", [d.id]);
      const { blob_pathname } = await one('SELECT blob_pathname FROM marina_document WHERE id = $1', [d.id]);
      const r = await view(b);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.documents, [{ id: d.id, requirement_id: null, file_name: 'passport.pdf', status: 'pending', submitted_at: d.submitted_at }]);
      const json = JSON.stringify(r.body);
      assert.ok(!json.includes('X9')); assert.ok(!json.includes(blob_pathname));
    });
    await check('R20: booking.expired marks a lapsed hold, not a guest cancel', async () => {
      const a = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      assert.equal(a.booking.expired, false);
      await pool.query("UPDATE marina_booking SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [a.booking.id]);
      await life.sweepOnce();
      const lapsed = (await view(a)).body.booking;
      assert.equal(lapsed.status, 'cancelled'); assert.equal(lapsed.expired, true);
      const c = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      const cancelled = (await api('POST', `${G}/bookings/${c.booking.id}/cancel`, { headers: { 'X-Booking-Token': c.booking_token } })).body.booking;
      assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.expired, false);
    });
    await check('R20: a failing PaymentIntent retrieve gives payment null, not a 500', async () => {
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
      const b = (await api('POST', `${G}/bookings`, { body: guestBody(), headers: ipR20 })).body;
      assert.ok(b.payment, 'card path');
      assert.ok((await view(b)).body.payment, 'resumes while Stripe answers');
      const row = await one('SELECT stripe_payment_intent_id FROM marina_booking WHERE id = $1', [b.booking.id]);
      fake.store.delete(row.stripe_payment_intent_id); // the fake's retrieve now throws, as in a Stripe outage
      const r = await view(b);
      assert.equal(r.status, 200); assert.equal(r.body.payment, null); assert.equal(r.body.booking.status, 'hold');
    });
    await check('R20: no MARINA_BOOKING_TOKEN_SECRET → 503 before any hold is taken', async () => {
      const secret = process.env.MARINA_BOOKING_TOKEN_SECRET;
      delete process.env.MARINA_BOOKING_TOKEN_SECRET;
      try {
        const body = guestBody();
        const r = await api('POST', `${G}/bookings`, { body, headers: ipR20 });
        assert.equal(r.status, 503); assert.equal(r.body.error, 'Online booking is not configured');
        assert.equal((await one('SELECT count(*)::int AS n FROM marina_booking WHERE property_id = $1 AND contact_email = $2', [P, body.contact_email])).n, 0);
      } finally { process.env.MARINA_BOOKING_TOKEN_SECRET = secret; }
    });
    await check('R20: a zero total takes the email-confirm path, never a card hold', async () => {
      await pool.query("UPDATE property SET stripe_secret_key = 'sk_test_check', stripe_publishable_key = 'pk_test_check' WHERE id = $1", [P]);
      assert.equal((await api('POST', `/api/marina/marinas/${m.id}/berths`, { body: { label: 'Z1', length_m: 15, price_per_night: 0 } })).status, 201);
      const r = await api('POST', `${G}/bookings`, { body: guestBody({ berth_label: 'Z1' }), headers: ipR20 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.booking.total_price, '0.00'); assert.equal(r.body.payment, null);
      const row = await one('SELECT stripe_payment_intent_id, confirm_token_hash FROM marina_booking WHERE id = $1', [r.body.booking.id]);
      assert.equal(row.stripe_payment_intent_id, null); assert.ok(row.confirm_token_hash, 'confirm link issued');
    });

```

Why the block is written this way:
- **`n = 100` (`n` is the `let` at line 57).** The existing checks leave `n` at 34. At `n = 37`, `guestBody()` would pick `future(400)`–`future(402)`. That overlaps the confirmed staff booking from "staff list hides holds" and would return 409.
- **`192.0.2.140`.** The block uses its own visitor IP because `cardBooking()`'s IP (`192.0.2.91`) has already used 9 of its 10 bookings per hour.
- **Rate limits stay under their caps.** `pendingBooking()` reaches 8 of 10 bookings and `upload()` reaches 18 of 30 uploads.

- [ ] **Step 2: Run the checks and confirm the five new ones fail**

```bash
cd C:/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js
```

Expected:
- The 31 existing checks print `ok`.
- The two 500s also print `Error: No such payment_intent` and `Error: MARINA_BOOKING_TOKEN_SECRET is not set` on stderr, from errorHandler.
- The output ends with `5 FAILED` and exit code 1.
- The five new checks fail like this:
```
FAIL R20: booking page lists document metadata only            (AssertionError: undefined vs the documents array)
FAIL R20: booking.expired marks a lapsed hold, not a guest cancel   (undefined !== false)
FAIL R20: a failing PaymentIntent retrieve gives payment null, not a 500   (500 !== 200)
FAIL R20: no MARINA_BOOKING_TOKEN_SECRET → 503 before any hold is taken   (500 !== 503)
FAIL R20: a zero total takes the email-confirm path, never a card hold   ({ client_secret: 'pi_fake_…', publishable_key: 'pk_test_check' } !== null)
```

- [ ] **Step 3: Implement the four controller changes in `O/src/controllers/marinaGuest.js`**

(a) `guestView`, lines 130-131. Old:
```js
    hold_expires_at: b.hold_expires_at, locale: b.locale, doc_count: b.doc_count,
  };
```
New:
```js
    hold_expires_at: b.hold_expires_at, locale: b.locale, doc_count: b.doc_count,
    // cancel_reason itself is staff free text; only this derived flag leaves.
    expired: b.status === 'cancelled' && b.cancel_reason === 'expired',
  };
```

(b) `createGuestBooking`, line 140. Old:
```js
    if (req.auth_method !== 'api_key') return res.status(403).json({ error: 'Use POST /api/marina/bookings for staff bookings' });
```
New:
```js
    if (req.auth_method !== 'api_key') return res.status(403).json({ error: 'Use POST /api/marina/bookings for staff bookings' });
    // No secret, no booking_token: the guest could never reach the booking
    // again, so refuse before a hold takes the berth.
    if (!process.env.MARINA_BOOKING_TOKEN_SECRET) return res.status(503).json({ error: 'Online booking is not configured' });
```

(c) `createGuestBooking`, line 155. Old:
```js
    const cardPath = price.total_price != null && prop.stripe_secret_key && prop.stripe_publishable_key;
```
New:
```js
    // Stripe refuses a zero amount, so a free stay confirms by email like an unpriced one.
    const cardPath = price.total_price != null && toCents(price.total_price) > 0 && prop.stripe_secret_key && prop.stripe_publishable_key;
```

(d) `getGuestBooking`, lines 204-207. Old:
```js
      if (p.stripe_secret_key) {
        const pi = await marinaStripe.stripeFor(p.stripe_secret_key).paymentIntents.retrieve(b.stripe_payment_intent_id);
        payment = { client_secret: pi.client_secret, publishable_key: p.stripe_publishable_key };
      }
```
New:
```js
      if (p.stripe_secret_key) {
        // A Stripe outage must not take the booking page down: the guest
        // still sees the booking and can cancel it.
        try {
          const pi = await marinaStripe.stripeFor(p.stripe_secret_key).paymentIntents.retrieve(b.stripe_payment_intent_id);
          payment = { client_secret: pi.client_secret, publishable_key: p.stripe_publishable_key };
        } catch (err) {
          console.error(`Marina PI retrieve failed for ${b.id}:`, err.message);
        }
      }
```
Then line 217. Old:
```js
    res.json({ booking: guestView(b), payment, contract });
```
New:
```js
    // Metadata only: extracted data and the private blob path never reach the key rail.
    const { rows: documents } = await pool.query(
      'SELECT id, requirement_id, file_name, status, submitted_at FROM marina_document WHERE booking_id = $1 ORDER BY submitted_at', [b.id]);
    res.json({ booking: guestView(b), payment, contract, documents });
```

- [ ] **Step 4: Run the checks again and confirm they all pass**

```bash
cd C:/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js && node -r dotenv/config scripts/check-marina.js
```

Expected:
- All 36 HTTP checks print `ok`, then `all passed`.
- The new catch logs `Marina PI retrieve failed for <uuid>: No such payment_intent` once.
- `check-marina.js` still ends with `all passed`.

- [ ] **Step 5: Update the Swagger descriptions in `O/src/docs/swagger.js`**

Each old fragment occurs exactly once.

Line 726 (POST guest bookings), summary. Old fragment:
```js
for priced stays with Stripe keys set, a card hold client_secret"
```
New:
```js
for stays priced above zero with Stripe keys set, a card hold client_secret (otherwise payment is null and the guest confirms by email)"
```
Line 726, responses. Old fragment:
```js
502: { description: "Card payment could not be set up" } } },
```
New:
```js
502: { description: "Card payment could not be set up" }, 503: { description: "Online booking is not configured (MARINA_BOOKING_TOKEN_SECRET unset); nothing is held" } } },
```
Line 729 (GET guest booking), summary. Old fragment:
```js
summary: "Booking page data: status, payment resume while on hold, contract"
```
New:
```js
summary: "Booking page data: status, payment resume while on hold, contract, uploaded documents"
```
Line 729, 200 response. Old fragment:
```js
200: { description: "{ booking, payment, contract }" }
```
New:
```js
200: { description: "{ booking, payment, contract, documents }. booking.expired is true when the hold or request lapsed unconfirmed (status cancelled). payment is null unless on hold with a card PaymentIntent, and also when Stripe can't be reached. documents is [{ id, requirement_id, file_name, status, submitted_at }], metadata only" }
```
Verify:
```bash
cd C:/Users/robert/source/repos/OTA && node -e "const s=require('./src/docs/swagger'); console.log(s.paths['/api/marina/guest/{marina}/bookings'].post.responses[503].description)"
```
Expected: `Online booking is not configured (MARINA_BOOKING_TOKEN_SECRET unset); nothing is held`

- [ ] **Step 6: Create `O/scripts/seed-marina-demo.js`**

```js
// Seeds a local demo marina for the booking widget's demo page: property
// 'Marina Demo' (EUR, Europe/Rome, API key on) with marina demo-marina --
// one pontoon, six berths, a 12-month price tier, two document
// requirements and a contract. Safe to re-run: rows are matched on natural
// keys and updated in place, so ids (and any demo bookings, uploads and
// signatures on them) survive. Local DB only.
//   node scripts/seed-marina-demo.js
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const BERTHS = [
  { label: 'A1', length_m: 8, beam_m: 3, depth_m: 2.5, price_per_night: 3.5, price_mode: 'per_metre' },
  { label: 'A2', length_m: 10, beam_m: 3.5, depth_m: 3, price_per_night: 4, price_mode: 'per_metre' },
  { label: 'A3', length_m: 12, beam_m: 4, depth_m: 3, price_per_night: 60, price_mode: 'fixed' },
  { label: 'A4', length_m: 15, beam_m: 5, depth_m: 3.5, price_per_night: 4.5, price_mode: 'per_metre' },
  // min_length_m keeps small boats off the big berth (OTA's fit rule).
  { label: 'A5', length_m: 20, min_length_m: 14, beam_m: 6, depth_m: 4, price_per_night: 5, price_mode: 'per_metre' },
  { label: 'A6', length_m: 18, beam_m: 5.5, depth_m: 4, price_per_night: 5, price_mode: 'per_metre', status: 'maintenance' },
];

// The pontoon overlay: a 300x150 SVG stretched over SW..NE (about 96 x 48 m
// at this latitude, so the aspect matches). Berth lat/lng come from the
// same cells, so the chart style's circles sit on the SVG's rects.
const SW = { lat: 44.3031, lng: 9.209 };
const NE = { lat: 44.30353, lng: 9.2102 };
const W = 300;
const H = 150;
const cell = (i) => ({ x: 15 + (i % 3) * 95, y: i < 3 ? 10 : 88, w: 80, h: 52 });
const at = (c) => ({
  lat: Number((NE.lat - ((c.y + c.h / 2) / H) * (NE.lat - SW.lat)).toFixed(6)),
  lng: Number((SW.lng + ((c.x + c.w / 2) / W) * (NE.lng - SW.lng)).toFixed(6)),
});
// The widget paints the rect INSIDE each [data-berth-id] element and hides
// [data-type="berth"] text, so each berth is a <g> around its rect + label.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`
  + '<rect data-role="pontoon" x="5" y="67" width="290" height="16" fill="#9c8b74"/>'
  + BERTHS.map((b, i) => {
    const c = cell(i);
    return `<g data-type="berth" data-berth-id="${b.label}"><rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="4"/>`
      + `<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" text-anchor="middle">${b.label}</text></g>`;
  }).join('')
  + '</svg>';

// Sidon's merge-field names (src/lib/marinaContracts.js FIELDS).
const CONTRACT = `# Berth agreement

Between **{{marina_name}}** ({{marina_email}}, {{marina_phone}}) and **{{sailor_name}}** ({{sailor_email}}), dated {{today}}.

- Boat: {{boat_name}}, {{boat_loa}} m LOA, {{boat_beam}} m beam
- Berth: {{berth_id}}
- Stay: {{arrival_date}} to {{departure_date}} ({{nights}} nights)
- Total: {{amount}}

The skipper keeps the boat insured and safely moored, follows the marina's rules and staff instructions, and leaves the berth by noon on the departure date.`;

// UPDATE, then INSERT if nothing matched. Most marina tables have no unique
// key to ON CONFLICT on, and updating in place keeps ids stable.
async function put(db, table, key, row) {
  const cols = Object.keys(row);
  const keys = Object.keys(key);
  const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const where = keys.map((k, i) => `${k} = $${cols.length + i + 1}`).join(' AND ');
  const { rows: [found] } = await db.query(`UPDATE ${table} SET ${set} WHERE ${where} RETURNING id`, [...Object.values(row), ...Object.values(key)]);
  if (found) return found.id;
  const all = [...keys, ...cols];
  const { rows: [made] } = await db.query(
    `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    [...Object.values(key), ...Object.values(row)]);
  return made.id;
}

async function seed(db) {
  const P = await put(db, 'property', { name: 'Marina Demo' }, { currency: 'EUR', timezone: 'Europe/Rome', api_key_enabled: true });
  // Generated once and then kept, so a running widget demo survives a re-seed.
  const { rows: [{ api_key: apiKey }] } = await db.query(
    'UPDATE property SET api_key = COALESCE(api_key, $2) WHERE id = $1 RETURNING api_key', [P, `prop_${crypto.randomBytes(32).toString('hex')}`]);
  const M = await put(db, 'marina', { property_id: P, slug: 'demo-marina' }, {
    name: 'Demo Marina', description: 'A local demo marina for the booking widget.', phone: '+39 0185 000000',
    email: 'demo-marina@example.com', website: 'https://example.com', lat: 44.30332, lng: 9.2096,
    booking_url: 'http://localhost:5173/booking.html?booking={id}&token={token}', status: 'active',
  });
  const pontoon = await put(db, 'marina_pontoon', { marina_id: M, name: 'Pontoon A' }, {
    property_id: P, svg_data: SVG, sw_lat: SW.lat, sw_lng: SW.lng, ne_lat: NE.lat, ne_lng: NE.lng, rotation: 0, sort_order: 0, status: 'active',
  });
  for (const [i, b] of BERTHS.entries()) {
    await put(db, 'marina_berth', { marina_id: M, label: b.label }, {
      property_id: P, pontoon_id: pontoon, ...at(cell(i)), rotation: null, length_m: b.length_m, min_length_m: b.min_length_m ?? null,
      beam_m: b.beam_m, depth_m: b.depth_m, price_per_night: b.price_per_night, price_mode: b.price_mode, status: b.status ?? 'active',
    });
  }
  // Property-local today, so the season opens on the day the widget sees;
  // valid_to is inclusive (the last night covered).
  const { rows: [d] } = await db.query(
    "SELECT t::text AS today, ((t + interval '12 months')::date - 1)::text AS last FROM (SELECT (now() AT TIME ZONE 'Europe/Rome')::date AS t) x");
  await put(db, 'marina_price_tier', { marina_id: M, max_length_m: 12 }, {
    property_id: P, valid_from: d.today, valid_to: d.last, max_beam_m: null, price_per_night: 45, price_per_month: null, price_per_year: null, status: 'active',
  });
  await put(db, 'marina_doc_requirement', { marina_id: M, type: 'passport' }, {
    property_id: P, name: 'Passport', description: "The skipper's passport photo page", mandatory: true, sort_order: 0, status: 'active',
  });
  await put(db, 'marina_doc_requirement', { marina_id: M, type: 'insurance' }, {
    property_id: P, name: 'Boat insurance', description: 'Third-party liability certificate', mandatory: false, sort_order: 1, status: 'active',
  });
  await put(db, 'marina_contract_template', { marina_id: M, name: 'Berth agreement' }, {
    property_id: P, body_markdown: CONTRACT, min_nights: 0, status: 'active',
  });
  return { P, apiKey };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    const { P, apiKey } = await seed(db);
    await db.query('COMMIT');
    console.log(`Marina Demo seeded (property ${P})`);
    // Machine-readable for the widget demo: KEY=$(... | sed -n 's/^api_key=//p')
    console.log(`api_key=${apiKey}`);
    console.log('slug=demo-marina');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 7: Seed twice and confirm the second run changes nothing**

```bash
cd C:/Users/robert/source/repos/OTA && node scripts/seed-marina-demo.js && node scripts/seed-marina-demo.js
```

Expected: both runs print the same three lines (same property id, same key):
```
Marina Demo seeded (property <uuid>)
api_key=prop_<64 hex>
slug=demo-marina
```

- [ ] **Step 8: Run OTA locally for the widget demo and check the seeded API**

Terminal 1 runs OTA on `http://localhost:3000`. `PORT=3000` is already in `.env`.

```bash
cd C:/Users/robert/source/repos/OTA && OTA_API_BASE_URL=http://localhost:3000 npm run dev
```

What the local loop depends on:
- **`OTA_API_BASE_URL`.** It is not in the local `.env`. Without it, the emailed confirm link for a no-card hold reads `undefined/api/marina/confirm-booking/…`. dotenv never overrides a variable already set on the command line.
- **Confirm emails.** `RESEND_API_KEY` is in `.env`, so the confirm email really goes out. Book with an inbox you can read.
- **Live updates.** `ABLY_API_KEY` is also set, so live updates work locally.
- **Payment.** The seed stores no Stripe keys, so `payment` is always null and every booking takes the email-confirm path.
  - To try the card step, store Stripe test keys in `stripe_secret_key` and `stripe_publishable_key` on the `Marina Demo` property row.
  - The seed never writes those two columns, so the keys survive a re-seed.
- **The API key.** The widget never holds the key. The widget demo's local forwarder (Task 2) adds `X-Api-Key` from the `api_key=` line and targets `http://localhost:3000` with marina `demo-marina`.
- **Confirm-link redirect.** The confirm link redirects to `http://localhost:5173/booking.html?booking=…&token=…`.

Terminal 2:
```bash
cd C:/Users/robert/source/repos/OTA && KEY=$(node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p')
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/marina/guest/demo-marina | node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.marina.slug,j.currency,j.pontoons.length,j.price_tiers.length,j.berths.map((b)=>b.label+':'+b.available).join(' '))})"
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/marina/guest/demo-marina/doc-requirements | node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.parse(s).map((r)=>r.type+':'+r.mandatory).join(' ')))"
curl -s -H "X-Api-Key: $KEY" "http://localhost:3000/api/marina/guest/demo-marina/availability?arrival=$(date -d '+7 days' +%F)&departure=$(date -d '+9 days' +%F)&boat_length_m=14" | node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.parse(s).map((b)=>b.label+'='+b.total_price).join(' ')))"
```

Expected:
```
demo-marina EUR 1 1 A1:true A2:true A3:true A4:true A5:true A6:false
passport:true insurance:false
A4=126.00 A5=140.00
```
- A6 is in maintenance.
- A1–A3 are too short for a 14 m boat.
- The 12 m tier doesn't cover 14 m, so the per-metre berth prices apply: 4.50 × 14 × 2 and 5.00 × 14 × 2.

Stop `npm run dev` when you are done, or leave it running for Tasks 2 and 10.

- [ ] **Step 9: Commit**

```bash
git -C C:/Users/robert/source/repos/OTA add src/controllers/marinaGuest.js src/docs/swagger.js scripts/check-marina-http.js scripts/seed-marina-demo.js
git -C C:/Users/robert/source/repos/OTA commit -m "$(cat <<'EOF'
Marina guest API: plan B follow-ups and a local demo seed

GET booking adds documents[] (metadata only) and booking.expired. A failing
Stripe PI retrieve now returns payment null instead of a 500. Create returns
503 before taking a hold when MARINA_BOOKING_TOKEN_SECRET is unset. A zero
total takes the email-confirm path. Swagger and check-marina-http updated.
scripts/seed-marina-demo.js idempotently seeds 'Marina Demo' / demo-marina
for the widget demo and prints its API key.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Widget baseline — green type check and a local OTA loop

Repo: `W` = `C:/Users/robert/source/repos/sidon-booking-widget`. All commands are bash (Git Bash) and run from `W`.

**Files:**
- Modify: `C:/Users/robert/source/repos/sidon-booking-widget/src/components/Summary.svelte` (line 4 import; line 31 `fp` type)
- Modify: `C:/Users/robert/source/repos/sidon-booking-widget/src/components/SentStep.svelte` (lines 31-32; the file is deleted in Task 8)
- Modify: `C:/Users/robert/source/repos/sidon-booking-widget/tsconfig.node.json` (line 22 `include`)
- Modify: `C:/Users/robert/source/repos/sidon-booking-widget/vite.config.ts` (line 1 import; lines 20-26 serve branch)
- Modify (full rewrite): `C:/Users/robert/source/repos/sidon-booking-widget/demo/index.html` (lines 1-130)
- Create: `C:/Users/robert/source/repos/sidon-booking-widget/demo/booking.html`
- Not committed: `demo/.env.local`. `.gitignore:13` (`*.local`) already ignores it, so `.gitignore` stays as it is.
- Unchanged: `package.json`. `check` stays `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json`. The `&&` only skipped `tsc` because svelte-check failed. Once svelte-check is green, `tsc` runs.

**Interfaces:**
- Consumes:
  - R2 base path `/api/marina/guest/${slug}`, called relative because `api-origin` is omitted.
  - R9 `<sidon-booking-widget booking-id>` (boolean presence).
  - Task 1's `scripts/seed-marina-demo.js` in `O`. It creates slug `demo-marina` and prints the API key.
- Produces:
  - A dev-server proxy: `'/api/marina/guest'` goes to `OTA_DEMO_BASE_URL` (default `http://localhost:3000`). It injects `X-Api-Key: OTA_DEMO_API_KEY` and `X-Client-Ip: 127.0.0.1`. Values come from `demo/.env.local` or the shell; the shell wins.
  - `demo/index.html`: three wizards and one `<sidon-berth-map>` on `demo-marina`.
  - `demo/booking.html`: booking-page mode, with no referrer.
  - A green `npm run check` (0 errors). Tasks 3–4 keep it green; Tasks 5–7 leave only the legacy-wizard errors listed in Task 5 Step 11; Task 8 restores 0.

- [ ] **Step 1: Confirm the failing baseline**

Run: `npm run check; echo "exit=$?"`

Expected: FAIL, `exit=1`. svelte-check reports 3 errors, and `tsc -p tsconfig.node.json` never runs:
```
ERROR "src\\components\\Summary.svelte" 60:7 "Type 'Instance' is not assignable to type '{ destroy(): void; set(key: string, val: unknown): void; } | undefined'. ...
ERROR "src\\components\\SentStep.svelte" 31:12 "Could not find a declaration file for module 'qrcode'. ...
ERROR "src\\components\\SentStep.svelte" 32:96 "Parameter 'url' implicitly has an 'any' type."
COMPLETED 172 FILES 3 ERRORS 0 WARNINGS 2 FILES_WITH_PROBLEMS
```
(In an interactive terminal the last line reads `svelte-check found 3 errors and 0 warnings in 2 files`.)

- [ ] **Step 2: Summary.svelte — use flatpickr's real `Instance` type**

The hand-written shape's `set(key: string, …)` is wider than flatpickr's keyed `set`, so assigning the resolved instance fails. `src/lib/date-range.ts:4` already imports the real type, so use the same import here.

`src/components/Summary.svelte` line 4, old:
```svelte
  import { mountRangePicker } from '../lib/date-range';
```
new:
```svelte
  import type { Instance as FlatpickrInstance } from 'flatpickr/dist/types/instance';
  import { mountRangePicker } from '../lib/date-range';
```
Line 31 (line 32 after the edit above), old:
```svelte
  let fp: { destroy(): void; set(key: string, val: unknown): void } | undefined;
```
new:
```svelte
  let fp: FlatpickrInstance | undefined;
```

- [ ] **Step 3: SentStep.svelte — suppress the missing qrcode types in place**

Task 8 deletes this file. An in-file directive means no new dependency or `.d.ts` that someone would later have to remember to remove.

`src/components/SentStep.svelte` lines 31-32, old:
```svelte
    import('qrcode').then(({ default: QRCode }) =>
      QRCode.toDataURL(trackingUrl, { errorCorrectionLevel: 'M', margin: 0, width: 96 }).then((url) => {
```
new:
```svelte
    // @ts-expect-error qrcode ships no types; this file is deleted in the OTA wizard rewrite, so it gets no @types dependency
    import('qrcode').then(({ default: QRCode }) =>
      QRCode.toDataURL(trackingUrl, { errorCorrectionLevel: 'M', margin: 0, width: 96 }).then((url: string) => {
```

- [ ] **Step 4: tsconfig.node.json — type-check both Vite configs**

`vite.berth-map.config.ts` has never been type-checked. Add it to `include`. `tsconfig.node.json` line 22, old:
```json
  "include": ["vite.config.ts"]
```
new:
```json
  "include": ["vite.config.ts", "vite.berth-map.config.ts"]
```

- [ ] **Step 5: Re-run the type check**

Run: `npm run check; echo "exit=$?"`

Expected: PASS, `exit=0`. svelte-check prints `COMPLETED 172 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` (in a terminal: `svelte-check found 0 errors and 0 warnings`). Then `tsc -p tsconfig.node.json` runs and prints nothing.

Run: `npx tsc -p tsconfig.node.json --listFiles | grep -i 'sidon-booking-widget/vite\.'`

Expected: two lines, ending `/vite.config.ts` and `/vite.berth-map.config.ts`.

- [ ] **Step 6: Proxy check against the current config (expected failure)**

This uses a throwaway header-echo upstream on :3999 and Vite on :5199. Those ports keep clear of a real OTA on :3000 and the default :5173. Vite runs directly, not through `npx`, so `kill` stops the real process.
```bash
node -e "require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({url:q.url,headers:q.headers}))}).listen(3999)" &
OTA_DEMO_BASE_URL=http://localhost:3999 OTA_DEMO_API_KEY=test-key node node_modules/vite/bin/vite.js --port 5199 --strictPort > /tmp/vite-demo.log 2>&1 &
until curl -s -o /dev/null http://localhost:5199/; do sleep 0.5; done
curl -s -i -H 'X-Api-Key: spoof' -H 'X-Client-Ip: 9.9.9.9' 'http://localhost:5199/api/marina/guest/demo-marina?from=2026-11-01&to=2026-11-03' | head -5
kill %1 %2
```
Expected: FAIL. You get `HTTP/1.1 200 OK` with `Content-Type: text/html`, which is Vite's SPA fallback serving `demo/index.html`. The JSON echo does not appear.

- [ ] **Step 7: vite.config.ts — add the dev proxy**

Line 1, old:
```ts
import { defineConfig } from 'vite';
```
new:
```ts
import { defineConfig, loadEnv } from 'vite';
```
Lines 20-26, old:
```ts
export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      root: 'demo',
      plugins: [svelte(svelteOptions)],
    };
  }
```
new:
```ts
export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    // The demo pages omit api-origin, so the widgets call the relative
    // /api/marina/guest/... exactly as they do behind a site's astro-proxy
    // forwarder; this proxy plays the forwarder's part against a local OTA.
    // OTA_DEMO_* come from demo/.env.local (gitignored via *.local) or the
    // shell, and lack the VITE_ prefix, so the key is added here, server-side,
    // and never reaches the browser. X-Client-Ip overwrites any inbound value,
    // as the forwarder does, so OTA's per-visitor rate limits key on one IP.
    const env = loadEnv(mode, fileURLToPath(new URL('./demo', import.meta.url)), 'OTA_DEMO_');
    return {
      root: 'demo',
      plugins: [svelte(svelteOptions)],
      server: {
        proxy: {
          '/api/marina/guest': {
            target: env.OTA_DEMO_BASE_URL || 'http://localhost:3000',
            changeOrigin: true,
            headers: { 'X-Api-Key': env.OTA_DEMO_API_KEY ?? '', 'X-Client-Ip': '127.0.0.1' },
          },
        },
      },
    };
  }
```
The build branch (from line 28 on) is unchanged.

- [ ] **Step 8: Rewrite demo/index.html**

These changes point the demo at OTA:
- slug `demo-marina` everywhere
- no `api-origin`
- the past `from`/`to` dates and the Sidon-only `berth="B32"` are removed
- the Maps key stays a placeholder
- the log also prints `sidon-booking-status`

Whole file:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>sidon-booking-widget demo</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        max-width: 900px;
        margin: 40px auto;
        padding: 0 20px;
        background: #f2f2f2;
      }
      h1 {
        font-size: 20px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 32px;
        margin-top: 24px;
      }
      .col h2 {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: #666;
      }
      #log {
        margin-top: 32px;
        background: #111;
        color: #0f0;
        font:
          12px/1.5 ui-monospace,
          monospace;
        padding: 12px;
        border-radius: 8px;
        max-height: 200px;
        overflow: auto;
        white-space: pre-wrap;
      }
      /* Pirates-Bight-style re-theme, proving CSS-custom-property theming
         crosses the shadow boundary without any component fork. */
      .themed {
        --brand-navy: #0e3a3e;
        --brand-gold: #d49a3c;
        --brand-ink: #0e3a3e;
      }
    </style>
  </head>
  <body>
    <h1>sidon-booking-widget — dev harness</h1>
    <p>
      Talking to a local OTA through the Vite dev proxy in <code>vite.config.ts</code>: no
      <code>api-origin</code>, so the widgets make the same relative <code>/api/marina/guest/…</code> calls a
      site makes through its astro-proxy forwarder. In the OTA repo run
      <code>node scripts/seed-marina-demo.js</code>, then put the key it prints in <code>demo/.env.local</code>
      as <code>OTA_DEMO_API_KEY=…</code> (plus <code>OTA_DEMO_BASE_URL=…</code> if OTA is not on
      <code>http://localhost:3000</code>). The marina's booking page (<code>booking_url</code>) is
      <a href="/booking.html">/booking.html</a>.
    </p>

    <div class="row">
      <div class="col">
        <h2>Default theme</h2>
        <sidon-booking-widget
          marina="demo-marina"
          length="12"
          locale="it"
          maps-api-key="YOUR_DEV_MAPS_KEY"
          map-style="chart"
        ></sidon-booking-widget>
      </div>
      <div class="col themed">
        <h2>Re-themed via CSS custom properties</h2>
        <sidon-booking-widget marina="demo-marina" length="10" locale="en"></sidon-booking-widget>
      </div>
      <div class="col">
        <h2>Dark variant (Fox/Pevero)</h2>
        <sidon-booking-widget marina="demo-marina" length="14" locale="en" variant="dark"></sidon-booking-widget>
      </div>
    </div>

    <div class="row">
      <div class="col" style="flex-basis: 100%;">
        <h2>Berth map + quick-book (chart style)</h2>
        <sidon-berth-map
          marina="demo-marina"
          maps-api-key="YOUR_DEV_MAPS_KEY"
          map-style="chart"
          locale="en"
          book-path="/book"
          eyebrow="Campo ormeggio"
          card-title="Il campo ormeggio"
          intro="Scegli le date, imposta la lunghezza della barca e tocca la boa sulla mappa adatta."
          show-weather="true"
        ></sidon-berth-map>
      </div>
    </div>

    <div id="log"></div>

    <script type="module" src="./main.ts"></script>
    <script type="module">
      const log = document.getElementById('log');
      const write = (msg) => {
        log.textContent += `${msg}\n`;
        log.scrollTop = log.scrollHeight;
      };
      document.querySelectorAll('sidon-booking-widget').forEach((el, i) => {
        el.addEventListener('sidon-step-change', (e) => write(`[widget ${i}] step-change: ${JSON.stringify(e.detail)}`));
        el.addEventListener('sidon-booked', (e) => write(`[widget ${i}] booked: ${JSON.stringify(e.detail)}`));
        el.addEventListener('sidon-booking-status', (e) => write(`[widget ${i}] booking-status: ${JSON.stringify(e.detail)}`));
      });
      document.querySelectorAll('sidon-berth-map').forEach((el, i) => {
        el.addEventListener('sidon-berth-selected', (e) => write(`[berth-map ${i}] berth-selected: ${JSON.stringify(e.detail)}`));
        el.addEventListener('sidon-loa-change', (e) => write(`[berth-map ${i}] loa-change: ${JSON.stringify(e.detail)}`));
        el.addEventListener('sidon-quickbook-submit', (e) => write(`[berth-map ${i}] quickbook-submit: ${JSON.stringify(e.detail)}`));
      });
    </script>
  </body>
</html>
```

- [ ] **Step 9: Create demo/booking.html**

Vite dev serves any `.html` under the `demo/` root at its own path, so no config is needed. Whole file:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- First in <head>, before anything is fetched: this page's URL carries
         ?booking=&token= (the marina's booking_url), and the token must never
         leave in a Referer header. Real sites send the
         `Referrer-Policy: no-referrer` response header instead. -->
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>sidon-booking-widget booking page demo</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        max-width: 640px;
        margin: 40px auto;
        padding: 0 20px;
        background: #f2f2f2;
      }
      h1 {
        font-size: 20px;
      }
      #log {
        margin-top: 32px;
        background: #111;
        color: #0f0;
        font:
          12px/1.5 ui-monospace,
          monospace;
        padding: 12px;
        border-radius: 8px;
        max-height: 200px;
        overflow: auto;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h1>sidon-booking-widget — booking page</h1>
    <p>Opened from the emailed link (<code>/booking.html?booking={id}&amp;token={token}</code>).</p>

    <sidon-booking-widget marina="demo-marina" booking-id locale="en"></sidon-booking-widget>

    <div id="log"></div>

    <script type="module" src="./main.ts"></script>
    <script type="module">
      const log = document.getElementById('log');
      document.querySelector('sidon-booking-widget').addEventListener('sidon-booking-status', (e) => {
        log.textContent += `booking-status: ${JSON.stringify(e.detail)}\n`;
      });
    </script>
  </body>
</html>
```

- [ ] **Step 10: Verify — proxy, pages, type check, build**

Run the same harness as Step 6, plus a check on the booking page:
```bash
node -e "require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({url:q.url,headers:q.headers}))}).listen(3999)" &
OTA_DEMO_BASE_URL=http://localhost:3999 OTA_DEMO_API_KEY=test-key node node_modules/vite/bin/vite.js --port 5199 --strictPort > /tmp/vite-demo.log 2>&1 &
until curl -s -o /dev/null http://localhost:5199/; do sleep 0.5; done
curl -s -H 'X-Api-Key: spoof' -H 'X-Client-Ip: 9.9.9.9' 'http://localhost:5199/api/marina/guest/demo-marina?from=2026-11-01&to=2026-11-03'; echo
curl -s -X POST -H 'Content-Type: application/json' -d '{}' 'http://localhost:5199/api/marina/guest/demo-marina/bookings'; echo
curl -s http://localhost:5199/booking.html | grep -c '<meta name="referrer" content="no-referrer" />'
kill %1 %2
```
Expected: PASS.
- The first curl echoes `"url":"/api/marina/guest/demo-marina?from=2026-11-01&to=2026-11-03"` with `"host":"localhost:3999"`, `"x-api-key":"test-key"` and `"x-client-ip":"127.0.0.1"`. The spoofed inbound values are overwritten.
- The POST echoes `"content-type":"application/json"`, `"content-length":"2"` and the same two injected headers.
- The grep prints `1`.

Run: `npm run check; echo "exit=$?"`. Expected: 0 errors (as in Step 5) and `exit=0`. This also type-checks the new `loadEnv`/`server.proxy` code under `tsconfig.node.json`.

Run: `npm run build`. Expected: ends with `✓ built in …`. The build branch is untouched; this guards the `({ command, mode })` signature change.

Optional, against a real OTA once Task 1 has run:
1. Put the seed's key in `demo/.env.local` as `OTA_DEMO_API_KEY=<key>`.
2. Run `npm run dev` and open `http://localhost:5173/`.

Requests to `/api/marina/guest/demo-marina…` now reach OTA. The 0.4.17 elements still default `api-origin` to `https://sidonmarine.uk` and speak Sidon's API, so the demo shows load errors until Tasks 5-8 land. That is expected.

- [ ] **Step 11: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/components/Summary.svelte src/components/SentStep.svelte tsconfig.node.json vite.config.ts demo/index.html demo/booking.html && git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "Baseline: green type check, local OTA dev proxy, OTA demo pages

npm run check failed on 3 pre-existing svelte-check errors, so its tsc
half never ran. Summary.svelte now types its flatpickr handle with the
real Instance type (as date-range.ts does); SentStep.svelte, removed
with the OTA wizard rewrite, suppresses qrcode's missing types in
place. tsconfig.node.json now also covers vite.berth-map.config.ts.

The dev server proxies /api/marina/guest to a local OTA
(OTA_DEMO_BASE_URL, default http://localhost:3000), adding X-Api-Key
(OTA_DEMO_API_KEY from the gitignored demo/.env.local) and X-Client-Ip
server-side like the astro-proxy forwarder. The demo pages use the
demo-marina slug with api-origin omitted, plus demo/booking.html for
booking-id mode with a no-referrer policy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: astro-proxy — createMarinaProxy

Repo `W` = `C:/Users/robert/source/repos/sidon-booking-widget`. Contract R17, R18, R21.

**Files:**
- Create: `W/src/astro-proxy.ts` (a self-contained forwarder; Task 4 appends `createMarinaClient` to the same file)
- Create: `W/tsconfig.proxy.json`
- Create: `W/scripts/check-astro-proxy.ts`
- Modify: `W/package.json`. Line numbers are as of 0.4.17; Task 2 may shift them.
  - `exports`, lines 18-21: add `./astro-proxy`.
  - `scripts.build`, line 28: append the tsc step.
  - `scripts.check`, line 31: append the proxy type check.
  - Add `scripts.test` after line 31.

**Interfaces:**
- Consumes: Task 2's green `npm run check`. No other task's code.
- Produces, all exported from `W/src/astro-proxy.ts`:
  - `export type MarinaKeys = string | Record<string, string>`
  - `export interface MarinaProxyOptions { otaBaseUrl: string; keys: MarinaKeys; timeoutMs?: number }`
  - `export interface AstroLikeContext { request: Request; params: Record<string, string | undefined>; readonly clientAddress: string }`
  - `export type AstroLikeRoute = (context: AstroLikeContext) => Promise<Response>`
  - `export function createMarinaProxy(options: MarinaProxyOptions): AstroLikeRoute`
- Also produced:
  - Module-private helpers `keyFor(keys: MarinaKeys, slug: string): string | null` (prototype-safe) and `jsonError(status: number, error: string): Response`. Task 4 may reuse them inside the same file.
  - `package.json` `exports["./astro-proxy"] = { types: "./dist/astro-proxy.d.ts", import: "./dist/astro-proxy.js" }`.
  - `"test": "node scripts/check-astro-proxy.ts"`. Task 5 extends it to `node scripts/check-astro-proxy.ts && node scripts/check-ota.ts`.
- JSON error bodies the widget's `readError` will see:
  - 404 `{"error":"Not found"}`
  - 413 `{"error":"Request body too large"}`
  - 502 `{"error":"Booking service unavailable"}`
  - 504 `{"error":"Booking service timed out"}`

- [ ] **Step 1: Write the failing check**

Create `W/scripts/check-astro-proxy.ts`:

```ts
// Assert-based check for createMarinaProxy (no test runner: Node strips the
// types itself). fetch is stubbed on globalThis, so nothing leaves the
// process; every "404 without calling fetch" case asserts the stub saw no
// call, because a rejected path that still reached OTA would carry the
// site's API key.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMarinaProxy } from '../src/astro-proxy.ts';
import type { AstroLikeContext, AstroLikeRoute } from '../src/astro-proxy.ts';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let reply: (init: RequestInit) => Promise<Response> = async () =>
  new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  calls.push({ url: String(input), init });
  return reply(init);
}) as typeof fetch;

// tsc emits the file unbundled, so any import (even type-only: it survives
// into the .d.ts) would dangle in dist/ and break consumers at runtime.
const source = readFileSync(new URL('../src/astro-proxy.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /^\s*import\b/m, 'astro-proxy.ts must not import anything');
assert.doesNotMatch(source, /^\s*export\b.*\bfrom\b/m, 'astro-proxy.ts must not re-export');

const proxy = createMarinaProxy({ otaBaseUrl: 'https://ota.test', keys: 'key-1' });

// Astro hands the route an already-decoded params.path; request.url only
// matters for its query string.
function ctx(
  path: string | undefined,
  init: RequestInit = {},
  search = '',
  clientAddress: string | Error = '203.0.113.7',
): AstroLikeContext {
  return {
    request: new Request(`https://site.test/api/marina/guest/x${search}`, init),
    params: { path },
    get clientAddress() {
      if (clientAddress instanceof Error) throw clientAddress;
      return clientAddress;
    },
  };
}

async function call(route: AstroLikeRoute, c: AstroLikeContext) {
  calls = [];
  const res = await route(c);
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

const sent = (name: string) => new Headers(calls[0].init.headers).get(name);

// --- happy path: URL, query, allowlisted headers, key, client IP ---
{
  const { res, body } = await call(proxy, ctx('fox/bookings/b1', {
    headers: {
      'User-Agent': 'UA/1',
      'X-Booking-Token': 'tok',
      'X-File-Name': 'passport.pdf',
      'Content-Type': 'application/json',
      Cookie: 'session=1',
      Authorization: 'Bearer staff',
      'X-Forwarded-For': '6.6.6.6',
      'X-Client-Ip': '6.6.6.6',
      'X-Api-Key': 'forged',
    },
  }, '?arrival=2026-06-01&departure=2026-06-03'));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ota.test/api/marina/guest/fox/bookings/b1?arrival=2026-06-01&departure=2026-06-03');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(sent('user-agent'), 'UA/1');
  assert.equal(sent('x-booking-token'), 'tok');
  assert.equal(sent('x-file-name'), 'passport.pdf');
  assert.equal(sent('content-type'), 'application/json');
  assert.equal(sent('x-api-key'), 'key-1', 'inbound X-Api-Key never wins');
  assert.equal(sent('x-client-ip'), '203.0.113.7', 'X-Client-Ip comes from clientAddress, overwriting the inbound value');
  assert.equal(sent('cookie'), null);
  assert.equal(sent('authorization'), null);
  assert.equal(sent('x-forwarded-for'), null);
  assert.deepEqual([...new Headers(calls[0].init.headers).keys()].sort(),
    ['content-type', 'user-agent', 'x-api-key', 'x-booking-token', 'x-client-ip', 'x-file-name']);
}

// --- clientAddress throws (adapter without it) or is empty: header omitted ---
{
  await call(proxy, ctx('fox', { headers: { 'X-Client-Ip': '6.6.6.6' } }, '', new Error('ClientAddressNotAvailable')));
  assert.equal(calls.length, 1);
  assert.equal(sent('x-client-ip'), null);
  await call(proxy, ctx('fox', {}, '', ''));
  assert.equal(sent('x-client-ip'), null);
}

// --- path guard: 404 JSON and fetch never called ---
for (const path of [
  undefined,                       // /api/marina/guest itself
  'x/../bookings',                 // staff route via a dot segment
  'fox/../../bookings',            // %252e%252e/%252e%252e/bookings as Astro 6.4+/7 decodes it
  'fox/%2e%2e/%2e%2e/bookings',    // the same request as Astro 6.1 decodes it (one round)
  'x%2f..%2f..%2fmcp',             // x%252f..%252f..%252fmcp: decodeURI never decodes %2F
  'x/../../mcp',
  '..', '.', 'fox/.', 'fox//bookings', '/fox', 'fox/',
  'fox/a\\..\\..\\mcp', 'fox/%', 'fox/a\u0000b', 'fox/a\nb', 'fox/a\tb', 'fox/a\u007fb',
]) {
  const { res, body } = await call(proxy, ctx(path));
  assert.equal(res.status, 404, `path ${JSON.stringify(path)}`);
  assert.deepEqual(body, { error: 'Not found' });
  assert.equal(calls.length, 0, `path ${JSON.stringify(path)} must not reach OTA`);
}

// --- methods: only GET, HEAD (sent upstream as GET) and POST ---
for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
  const { res } = await call(proxy, ctx('fox/bookings/b1', { method }));
  assert.equal(res.status, 404, method);
  assert.equal(calls.length, 0, method);
}
{
  const { res } = await call(proxy, ctx('fox', { method: 'HEAD' }, '?from=2026-06-01'));
  assert.equal(res.status, 200);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].url, 'https://ota.test/api/marina/guest/fox?from=2026-06-01');
}

// --- POST body is forwarded byte for byte ---
{
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  await call(proxy, ctx('fox/bookings/b1/documents', {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'application/pdf' },
  }, '?requirement_id=r1'));
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(new Uint8Array(calls[0].init.body as ArrayBuffer), bytes);
  assert.equal(sent('content-type'), 'application/pdf');
  assert.equal(calls[0].url, 'https://ota.test/api/marina/guest/fox/bookings/b1/documents?requirement_id=r1');
}

// --- 4.5 MB cap: declared Content-Length, then the real byte count ---
{
  const declared = await call(proxy, ctx('fox/bookings', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': '4500001' },
  }));
  assert.equal(declared.res.status, 413);
  assert.deepEqual(declared.body, { error: 'Request body too large' });
  assert.equal(calls.length, 0);

  const actual = await call(proxy, ctx('fox/bookings', {
    method: 'POST', body: new Uint8Array(4_500_001), headers: { 'Content-Type': 'application/pdf' },
  }));
  assert.equal(actual.res.status, 413);
  assert.equal(calls.length, 0);

  const atCap = await call(proxy, ctx('fox/bookings', {
    method: 'POST', body: new Uint8Array(4_500_000), headers: { 'Content-Type': 'application/pdf' },
  }));
  assert.equal(atCap.res.status, 200);
  assert.equal(calls.length, 1);
}

// --- multi-key map: slug selects the key; unknown (or prototype) slug is 404 ---
{
  const multi = createMarinaProxy({ otaBaseUrl: 'https://ota.test/', keys: { fox: 'key-fox', pevero: 'key-pevero' } });
  await call(multi, ctx('pevero/availability'));
  assert.equal(sent('x-api-key'), 'key-pevero');
  await call(multi, ctx('fox'));
  assert.equal(sent('x-api-key'), 'key-fox');
  for (const slug of ['nope', 'constructor', '__proto__', 'toString']) {
    const { res, body } = await call(multi, ctx(`${slug}/availability`));
    assert.equal(res.status, 404, slug);
    assert.deepEqual(body, { error: 'Not found' });
    assert.equal(calls.length, 0, slug);
  }
}

// --- response: fresh Response, allowlisted headers, status and body kept ---
{
  reply = async () => new Response('{"error":"Too many requests"}', {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '30',
      'ratelimit-limit': '10',
      'ratelimit-remaining': '0',
      ratelimit: 'limit=10, remaining=0, reset=30',
      'content-encoding': 'gzip',
      'content-length': '49',
      'set-cookie': 'a=1',
      'x-powered-by': 'Express',
    },
  });
  const { res, body } = await call(proxy, ctx('fox/bookings', { method: 'POST', body: '{}' }));
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: 'Too many requests' });
  assert.deepEqual([...res.headers.keys()].sort(),
    ['cache-control', 'content-type', 'ratelimit', 'ratelimit-limit', 'ratelimit-remaining', 'retry-after']);
  assert.equal(res.headers.get('retry-after'), '30');
  // Clerk's middleware appends headers to the route's Response; a fetch()
  // Response's headers are immutable, so this would throw on a pass-through.
  res.headers.set('x-clerk-test', '1');

  reply = async () => new Response(null, { status: 204 });
  assert.equal((await call(proxy, ctx('fox'))).res.status, 204);
}

// --- upstream redirect: 502, Location never reaches the browser ---
{
  reply = async () => new Response(null, { status: 301, headers: { location: 'http://evil.test/' } });
  const { res, body } = await call(proxy, ctx('fox'));
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'Booking service unavailable' });
  assert.equal(res.headers.get('location'), null);
}

// --- network failure: 502 JSON, not Astro's HTML 500 page ---
{
  reply = async () => { throw new TypeError('fetch failed'); };
  const { res, body } = await call(proxy, ctx('fox'));
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'Booking service unavailable' });
}

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
  const { res, body } = await call(fast, ctx('fox'));
  assert.equal(res.status, 504);
  assert.deepEqual(body, { error: 'Booking service timed out' });
}

console.log('check-astro-proxy: ok');
```

- [ ] **Step 2: Add the `test` script and watch it fail**

In `W/package.json`, change:

```json
    "check": "svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json"
  },
```

to:

```json
    "check": "svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json",
    "test": "node scripts/check-astro-proxy.ts"
  },
```

Node 25 (v25.9.0 here) strips TS types natively: no flag, no loader, no ExperimentalWarning. `"type": "module"` makes the `.ts` file ESM, so top-level `await` works.

Run:

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm test
```

Expected: FAIL (exit 1) with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\robert\source\repos\sidon-booking-widget\src\astro-proxy.ts' imported from C:\Users\robert\source\repos\sidon-booking-widget\scripts\check-astro-proxy.ts
```

- [ ] **Step 3: Implement `src/astro-proxy.ts`**

Create `W/src/astro-proxy.ts`:

```ts
// Server-side half of the widget: an Astro route that relays the browser's
// /api/marina/guest/* calls to OTA with the site's API key, so the key never
// reaches the page. Consumers mount it at
// src/pages/api/marina/guest/[...path].ts.
//
// Deliberately one self-contained file: tsc emits it to dist/ unbundled and
// Astro SSR loads it from node_modules, so a relative runtime import (which
// would be extensionless) or a node: import (edge runtimes) would break it.
// Erasable TS only, so scripts/check-astro-proxy.ts runs it under Node's
// type stripping with no build step. Never import the element entries here:
// they call customElements.define at import time, which throws on a server.

/** One OTA API key, or `{ [slug]: key }` for a site serving marinas on several properties. */
export type MarinaKeys = string | Record<string, string>;

export interface MarinaProxyOptions {
  /** OTA origin, e.g. `https://ota.example.com`. */
  otaBaseUrl: string;
  keys: MarinaKeys;
  /** Upstream timeout; Render cold starts can take most of a minute. */
  timeoutMs?: number;
}

// The slice of Astro's APIContext the proxy reads. A function taking this is
// assignable to astro's APIRoute, so the package needs no astro dependency.
export interface AstroLikeContext {
  request: Request;
  params: Record<string, string | undefined>;
  // Astro's getter throws when the adapter can't supply an address.
  readonly clientAddress: string;
}

export type AstroLikeRoute = (context: AstroLikeContext) => Promise<Response>;

const GUEST_PREFIX = '/api/marina/guest/';
// Vercel's function body limit; OTA's own upload cap (4 MiB) is stricter.
const MAX_BODY_BYTES = 4_500_000;
const REQUEST_HEADERS = ['content-type', 'x-file-name', 'x-booking-token', 'user-agent'];
// Never content-encoding/content-length: Node's fetch has already decoded
// the body but keeps those headers. Never set-cookie or location.
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'ratelimit'];
// Astro has already percent-decoded params.path (repeatedly, in 6.4+), so a
// `%` left over, a backslash or a control character is an evasion attempt.
const BAD_SEGMENT = /[\\%\u0000-\u001f\u007f]/;

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Own-property lookup: a slug like `constructor` must not resolve to
// Object.prototype's function and be sent as a key.
function keyFor(keys: MarinaKeys, slug: string): string | null {
  if (typeof keys === 'string') return keys || null;
  return keys && Object.hasOwn(keys, slug) ? keys[slug] || null : null;
}

// Astro's getter throws (ClientAddressNotAvailable) on adapters without
// one; OTA then rate-limits the request in its per-property bucket.
function clientIp(context: AstroLikeContext): string | null {
  try {
    return context.clientAddress || null;
  } catch {
    return null;
  }
}

export function createMarinaProxy({ otaBaseUrl, keys, timeoutMs = 60_000 }: MarinaProxyOptions): AstroLikeRoute {
  return async (context) => {
    const { request } = context;
    // Astro dispatches HEAD to the GET export; OTA only needs to see GET.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (method !== 'GET' && method !== 'POST') return jsonError(404, 'Not found');

    const path = context.params.path ?? '';
    const segments = path.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..' || BAD_SEGMENT.test(s))) {
      return jsonError(404, 'Not found');
    }
    // Belt and braces: whatever the guard missed, the resolved URL must still
    // sit under the guest prefix — the API key also opens staff routes.
    const url = new URL(GUEST_PREFIX + path, otaBaseUrl);
    if (!url.pathname.startsWith(GUEST_PREFIX)) return jsonError(404, 'Not found');
    url.search = new URL(request.url).search;

    const key = keyFor(keys, segments[0]);
    if (!key) return jsonError(404, 'Not found');

    let body: ArrayBuffer | undefined;
    if (method === 'POST') {
      if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
        return jsonError(413, 'Request body too large');
      }
      // Buffered rather than streamed: Node's fetch rejects a stream body
      // without duplex:'half', and a buffer gives OTA a Content-Length.
      // ponytail: a chunked body is read fully before this check; Vercel caps
      // it at 4.5 MB before we run, count bytes off the stream if self-hosted.
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return jsonError(413, 'Request body too large');
    }

    // Built from scratch, so cookies, Authorization, X-Forwarded-For and any
    // inbound X-Client-Ip / X-Api-Key never reach OTA.
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('x-api-key', key);
    const ip = clientIp(context);
    if (ip) headers.set('x-client-ip', ip);

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Caught here because a throw renders Astro's HTML 500 page, which the
      // widget can't parse.
      if ((err as Error | null)?.name === 'TimeoutError') return jsonError(504, 'Booking service timed out');
      return jsonError(502, 'Booking service unavailable');
    }
    // OTA's guest routes never redirect; a 3xx is infrastructure (e.g. an
    // http→https hop) and its Location must not reach the browser.
    if (upstream.status >= 300 && upstream.status < 400) return jsonError(502, 'Booking service unavailable');

    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (RESPONSE_HEADERS.includes(name) || name.startsWith('ratelimit-')) out.set(name, value);
    });
    // Always a new Response: a fetch() Response's headers are immutable and
    // Clerk's middleware appends to them, which would throw.
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
```

- [ ] **Step 4: Run the check again**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm test
```

Expected: PASS. The output is `check-astro-proxy: ok`, exit 0, in about 1 s. There is no 60 s hang because `AbortSignal.timeout` timers are unref'd.

- [ ] **Step 5: Emit the file in the build, export it, type-check it**

Create `W/tsconfig.proxy.json`:

```jsonc
{
  // Emits src/astro-proxy.ts on its own (no bundler) as the last build step.
  // lib DOM + no @types: only web-standard globals (fetch, Request, URL),
  // so the file also runs on edge runtimes and a node: import fails here.
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023", "DOM"],
    "module": "esnext",
    "types": [],
    "strict": true,
    "erasableSyntaxOnly": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "files": ["src/astro-proxy.ts"]
}
```

`rootDir` is explicit because TS 6 defaults it to the tsconfig's directory, which would emit to `dist/src/`.

In `W/package.json`, change the `exports` block. Old:

```json
    "./berth-map": {
      "types": "./dist/custom-element-berth-map.d.ts",
      "import": "./dist/sidon-berth-map.js"
    }
  },
```

New:

```json
    "./berth-map": {
      "types": "./dist/custom-element-berth-map.d.ts",
      "import": "./dist/sidon-berth-map.js"
    },
    "./astro-proxy": {
      "types": "./dist/astro-proxy.d.ts",
      "import": "./dist/astro-proxy.js"
    }
  },
```

Change `build`. The tsc step goes last because the berth-map build empties `dist/`. Old:

```json
    "build": "vite build --config vite.berth-map.config.ts && node scripts/rename-berth-map-types.mjs && vite build",
```

New:

```json
    "build": "vite build --config vite.berth-map.config.ts && node scripts/rename-berth-map-types.mjs && vite build && tsc -p tsconfig.proxy.json",
```

Change `check`. If Task 2 rewrote this line, append ` && tsc -p tsconfig.proxy.json --noEmit` to its end instead. Old:

```json
    "check": "svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json",
```

New:

```json
    "check": "svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json && tsc -p tsconfig.proxy.json --noEmit",
```

- [ ] **Step 6: Check, build, smoke-import**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && npm run check && npm test && npm run build && ls dist && node --input-type=module -e "import('@forgebuild/sidon-booking-widget/astro-proxy').then(m => console.log(typeof m.createMarinaProxy))"
```

Expected:
- `npm run check`: svelte-check ends `COMPLETED … 0 ERRORS 0 WARNINGS` (`astro-proxy.ts` is also inside `tsconfig.app.json`'s `src/**/*.ts` and adds no errors). Both `tsc` runs print nothing, exit 0.
- `npm test`: `check-astro-proxy: ok`.
- `npm run build`: exit 0 (the vite-plugin-dts API Extractor version note is pre-existing).
- `ls dist`:
  ```
  astro-proxy.d.ts
  astro-proxy.js
  custom-element-berth-map.d.ts
  custom-element.d.ts
  favicon.svg
  sidon-berth-map.js
  sidon-booking-widget.js
  ```
- The smoke import resolves through the new `exports` entry by package self-reference and loads on plain Node, with no `customElements`. It prints `function`.

- [ ] **Step 7: Commit**

`dist/` is gitignored and `package-lock.json` is unchanged (no new dependencies).

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/astro-proxy.ts scripts/check-astro-proxy.ts tsconfig.proxy.json package.json
git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "astro-proxy: createMarinaProxy, the site forwarder for the OTA guest API" -m "Self-contained src/astro-proxy.ts, emitted by tsc as the last build step and exported as ./astro-proxy. Path/method/header allowlists, 4.5 MB body cap, X-Client-Ip from clientAddress, multi-key slug map, upstream 3xx and network errors -> 502, timeout -> 504, always a fresh Response with allowlisted headers. npm test runs scripts/check-astro-proxy.ts under Node's type stripping." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: astro-proxy — createMarinaClient

Server-side and build-time reads go straight to OTA using the site's key. The client returns OTA's raw snake_case JSON and does no caching (R19). It sits in the same self-contained file as `createMarinaProxy` (R17), so it has no imports and uses erasable TS only. It reuses Task 3's `MarinaKeys`, `keyFor` and `GUEST_PREFIX`, which keeps the keys rule identical to the forwarder's.

**Files:**
- Modify: `C:/Users/robert/source/repos/sidon-booking-widget/scripts/check-astro-proxy.ts`
  - Line 8: the value import from `../src/astro-proxy.ts`.
  - Append after the last line, which is line 245 in Task 3's version: `console.log('check-astro-proxy: ok');`.
- Modify: `C:/Users/robert/source/repos/sidon-booking-widget/src/astro-proxy.ts`
  - Append after the last line, which is line 142 in Task 3's version: the closing `}` of `createMarinaProxy`.
  - Nothing above that line changes.

**Interfaces:**
- Consumes:
  - From Task 3, in `src/astro-proxy.ts`:
    - `export type MarinaKeys = string | Record<string, string>`
    - `keyFor(keys: MarinaKeys, slug: string): string | null`, an own-property lookup that returns null for an unknown slug, a prototype slug or an empty key
    - `const GUEST_PREFIX = '/api/marina/guest/'`
  - From Task 3, in `scripts/check-astro-proxy.ts`:
    - the default `assert` import from `node:assert/strict`
    - the top-level `let calls: Call[]` and `let reply: (init: RequestInit) => Promise<Response>`, which the `globalThis.fetch` stub uses
    - `sent(name)`, which reads a header from `calls[0]`
  - From Task 3, in `package.json`: `check` ends with `tsc -p tsconfig.proxy.json --noEmit`.
  - From OTA's key rail:
    - `GET /api/marina/guest/:marina[?from&to]` and `GET /api/marina/guest/:marina/doc-requirements` (`O/src/routes/marina.js:41,43`).
    - The 404 body `{error:'Marina not found'}` (`O/src/controllers/marinaGuest.js:23`).
    - The 429 body `{error:'Too many requests'}` with `Retry-After` in seconds. The limiter allows 100/min and is keyed per `X-Api-Key` when the request has no `X-Client-Ip` (`O/src/middleware/rateLimiter.js:11-22`).
- Produces (exported from `src/astro-proxy.ts`, later `@forgebuild/sidon-booking-widget/astro-proxy`):
  ```ts
  export interface MarinaClientOptions { otaBaseUrl: string; keys: MarinaKeys; sleep?: (ms: number) => Promise<void>; }
  export class MarinaClientError extends Error { status: number; constructor(message: string, status: number) }
  export function createMarinaClient(o: MarinaClientOptions): {
    slugs: string[];                                                                  // map keys, [] for a single key
    getMarina: (slug: string, range?: { from: string; to: string }) => Promise<any>;  // raw GET /:slug payload | null
    getDocRequirements: (slug: string) => Promise<any[] | null>;                      // raw bare array | null
  }
  ```
  - Both getters return `null` on an OTA 404. They also return `null` without sending a request for:
    - a slug outside the `keys` map, including `constructor` and `__proto__`
    - the slugs `''`, `.` and `..`
  - Any other non-2xx response throws `MarinaClientError` with `.status`. The message is OTA's `{error}`, or `OTA request failed (<status>)` when the body is not JSON.
  - A 429 is retried up to 3 times. Each wait is the `Retry-After` value in seconds, capped at 30. When the header is missing or is an HTTP-date, the wait is 5 seconds.
  - A missing `otaBaseUrl` or `keys` throws `createMarinaClient: otaBaseUrl and keys are required` when the client is constructed.

- [ ] **Step 1: Write the failing check**

In `scripts/check-astro-proxy.ts`, change line 8:

```ts
import { createMarinaProxy } from '../src/astro-proxy.ts';
```
→
```ts
import { createMarinaClient, createMarinaProxy, MarinaClientError } from '../src/astro-proxy.ts';
```

Then append this block at the very end of the file, after `console.log('check-astro-proxy: ok');`:

```ts

// --- createMarinaClient: SSR / build-time reads straight from OTA ---
{
  const OTA = 'https://ota.test';
  // OTA's replies, one per expected fetch; a fetch beyond them fails loudly.
  let queue: Response[] = [];
  reply = async () => {
    const res = queue.shift();
    if (!res) throw new Error('unexpected fetch');
    return res;
  };
  const ota = (...replies: Response[]) => {
    calls = [];
    queue = replies;
  };
  // Stubbed sleep: records the 429 waits instead of really waiting.
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const tooMany = (retryAfter?: string) =>
    json({ error: 'Too many requests' }, 429, retryAfter === undefined ? {} : { 'retry-after': retryAfter });
  const clientError = (status: number, message: string) => (e: unknown) =>
    e instanceof MarinaClientError && e.status === status && e.message === message;
  // Raw OTA shape (snake_case, NUMERIC as strings): must come back untouched.
  const payload = { marina: { slug: 'fox', name: 'Fox Marina' }, berths: [{ label: 'A1', length_m: '12.00', available: true }], currency: 'EUR' };

  // An unset OTA_API_KEY must fail at startup, not read as "no such marina".
  assert.throws(() => createMarinaClient({ otaBaseUrl: OTA, keys: '' }), /otaBaseUrl and keys are required/);
  assert.throws(() => createMarinaClient({ otaBaseUrl: '', keys: 'k' }), /otaBaseUrl and keys are required/);

  // Multi-key map: slugs lists it; the slug picks the key; from/to pass through.
  const multi = createMarinaClient({ otaBaseUrl: OTA, keys: { fox: 'key-fox', pevero: 'key-pevero' }, sleep });
  assert.deepEqual(multi.slugs, ['fox', 'pevero']);
  ota(json(payload));
  assert.deepEqual(await multi.getMarina('fox', { from: '2027-06-01', to: '2027-06-03' }), payload);
  assert.equal(calls[0].url, `${OTA}/api/marina/guest/fox?from=2027-06-01&to=2027-06-03`);
  assert.equal(sent('x-api-key'), 'key-fox');
  ota(json(payload));
  await multi.getMarina('pevero');
  assert.equal(calls[0].url, `${OTA}/api/marina/guest/pevero`);
  assert.equal(sent('x-api-key'), 'key-pevero');
  // A slug outside the map is "no such marina" for this site: null, no request.
  ota();
  for (const slug of ['nope', 'constructor', '__proto__', 'toString']) assert.equal(await multi.getMarina(slug), null, slug);
  assert.equal(calls.length, 0);

  // Single key: no slugs; doc requirements are OTA's bare array.
  const single = createMarinaClient({ otaBaseUrl: `${OTA}/`, keys: 'site-key', sleep });
  assert.deepEqual(single.slugs, []);
  const reqs = [{ id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', type: 'passport', name: 'Passport', description: null, fields: [], mandatory: true }];
  ota(json(reqs));
  assert.deepEqual(await single.getDocRequirements('fox'), reqs);
  assert.equal(calls[0].url, `${OTA}/api/marina/guest/fox/doc-requirements`);
  assert.equal(sent('x-api-key'), 'site-key');
  // The slug is one encoded segment; '.' / '..' would resolve out of /guest/ with the key.
  ota(json(payload));
  await single.getMarina('a/b c');
  assert.equal(calls[0].url, `${OTA}/api/marina/guest/a%2Fb%20c`);
  ota();
  for (const slug of ['', '.', '..']) assert.equal(await single.getDocRequirements(slug), null, JSON.stringify(slug));
  assert.equal(calls.length, 0);

  // 404 -> null (the page can 404); any other non-2xx -> MarinaClientError with the status.
  ota(json({ error: 'Marina not found' }, 404), json({ error: 'Marina not found' }, 404));
  assert.equal(await single.getMarina('gone'), null);
  assert.equal(await single.getDocRequirements('gone'), null);
  ota(json({ error: 'Internal server error' }, 500));
  await assert.rejects(single.getMarina('fox'), clientError(500, 'Internal server error'));
  // An edge / proxy error page is not JSON: fallback message, never a SyntaxError.
  ota(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(single.getMarina('fox'), clientError(502, 'OTA request failed (502)'));

  // 429: up to 3 retries, waiting Retry-After seconds (absent / HTTP-date -> 5, cap 30).
  ota(tooMany('2'), tooMany(), tooMany('120'), json(payload));
  assert.deepEqual(await single.getMarina('fox'), payload);
  assert.deepEqual(waits, [2000, 5000, 30000]);
  assert.equal(calls.length, 4);
  waits.length = 0;
  ota(tooMany('Wed, 21 Oct 2026 07:28:00 GMT'), tooMany('0'), tooMany('1'), tooMany('1'));
  await assert.rejects(single.getDocRequirements('fox'), clientError(429, 'Too many requests'));
  assert.deepEqual(waits, [5000, 0, 1000]);
  assert.equal(calls.length, 4, 'gives up after the 3rd retry');
  assert.equal(queue.length, 0);
}

console.log('check-astro-proxy: createMarinaClient assertions passed');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-astro-proxy.ts`

Expected: exit 1 at module link time, before any assertion runs (Task 3's included):
```
SyntaxError: The requested module '../src/astro-proxy.ts' does not provide an export named 'MarinaClientError'
```

- [ ] **Step 3: Implement**

Append to the end of `src/astro-proxy.ts`, after the closing `}` of `createMarinaProxy`:

```ts

// ---- Server client: SSR / build-time reads straight from OTA ----

export interface MarinaClientOptions {
  /** OTA origin, e.g. `https://ota.example.com`. */
  otaBaseUrl: string;
  keys: MarinaKeys;
  /** Waits between 429 retries; injectable so the check doesn't really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class MarinaClientError extends Error {
  // A declared field, not a `public status` parameter property: those
  // aren't erasable, and Node's type stripping runs this file as-is.
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'MarinaClientError';
    this.status = status;
  }
}

// Returns OTA's raw JSON (snake_case, NUMERIC columns as strings): each site
// maps the few fields it reads; the widget adapts its own copy. No cache:
// sites wrap this in theirs, and SSR availability must stay fresh.
export function createMarinaClient({
  otaBaseUrl,
  keys,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: MarinaClientOptions) {
  // Fail at startup: an unset OTA_API_KEY must not read as "no such marina".
  if (!otaBaseUrl || !keys) throw new Error('createMarinaClient: otaBaseUrl and keys are required');

  // null = no such marina (OTA 404, or a slug outside the keys map), so a page can 404.
  async function get(slug: string, suffix: string, query = ''): Promise<any> {
    const key = keyFor(keys, slug);
    // '.' / '..' survive encodeURIComponent and would resolve out of /guest/, key attached.
    if (!key || slug === '' || slug === '.' || slug === '..') return null;
    const url = new URL(GUEST_PREFIX + encodeURIComponent(slug) + suffix + query, otaBaseUrl);
    // Build-time reads carry no X-Client-Ip, so a whole prerender shares one
    // 100/min bucket per key: wait out a 429 rather than fail the build.
    for (let retry = 0; ; retry++) {
      const res = await fetch(url, { headers: { 'x-api-key': key } });
      if (res.status === 429 && retry < 3) {
        await res.body?.cancel(); // free the connection while we wait
        // NaN when absent or an HTTP-date; OTA's limiter sends seconds.
        const secs = parseInt(res.headers.get('retry-after') ?? '', 10);
        await sleep(Math.min(secs >= 0 ? secs : 5, 30) * 1000);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        // OTA errors are {error}; an edge / proxy error page may not be JSON at all.
        const body: any = await res.json().catch(() => null);
        throw new MarinaClientError(
          typeof body?.error === 'string' ? body.error : `OTA request failed (${res.status})`,
          res.status,
        );
      }
      return res.json();
    }
  }

  return {
    /** The configured slugs (`[]` for a single key): a multi-marina site's "other marinas". */
    slugs: typeof keys === 'string' ? [] : Object.keys(keys),
    /** `GET /api/marina/guest/:slug[?from&to]`: the map payload, or null. */
    getMarina: (slug: string, range?: { from: string; to: string }): Promise<any> =>
      get(slug, '', range ? `?${new URLSearchParams({ from: range.from, to: range.to })}` : ''),
    /** `GET /api/marina/guest/:slug/doc-requirements`: OTA's bare array, or null. */
    getDocRequirements: (slug: string): Promise<any[] | null> => get(slug, '/doc-requirements'),
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && node scripts/check-astro-proxy.ts`

Expected: exit 0, with these two lines last:
```
check-astro-proxy: ok
check-astro-proxy: createMarinaClient assertions passed
```

- [ ] **Step 5: Type checks**

Run: `cd C:/Users/robert/source/repos/sidon-booking-widget && npm run check`

Expected:
- `svelte-check found 0 errors`. `tsconfig.app.json` includes `src/**/*.ts`, so this strict-checks `astro-proxy.ts` too.
- Then `tsc -p tsconfig.node.json` and `tsc -p tsconfig.proxy.json --noEmit` both exit 0 with no output.
- The second `tsc` uses lib DOM and `types: []`, so it fails if the new code reaches for any Node-only global.

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/astro-proxy.ts scripts/check-astro-proxy.ts && git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "$(cat <<'EOF'
astro-proxy: createMarinaClient for SSR / build-time reads

Raw OTA payloads per slug (same keys rule as the forwarder), null on 404,
MarinaClientError with the status otherwise; 429s are waited out via
Retry-After (cap 30 s, 3 retries) so a prerender sharing one key bucket
doesn't fail the build.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Widget data layer on the OTA guest API

`W` is the repo at `C:/Users/robert/source/repos/sidon-booking-widget`. Every command below is for Git Bash and runs from `W`.

**Files:**
- Create: `W/scripts/check-ota.ts`
- Create: `W/src/lib/ota.ts`
- Create: `W/src/lib/booking-session.ts`
- Create: `W/src/lib/upload-prep.ts`
- Modify (whole-file rewrite): `W/src/lib/types.ts`, all 85 lines
- Modify (whole-file rewrite): `W/src/lib/marina-api.ts`, all 155 lines
- Modify (whole-file rewrite): `W/src/lib/stripe.ts`, all 59 lines
- Modify: `W/package.json`. Change only the `"test"` line inside `"scripts"`, which is lines 26-32 before Task 3. Task 3 added that line.
- Delete: `W/src/lib/guest-token.ts`
- Leave alone on purpose: `W/src/lib/berth-pricing.ts`. `BerthMap.svelte` still imports it, and it still type-checks against the new `Berth`. Task 6 deletes it.

**Interfaces:**
- Consumes:
  - Task 3's `package.json` script `"test": "node scripts/check-astro-proxy.ts"`.
  - The OTA guest payloads that plan A ships, as extended by Task 1 (R20). For `GET …/bookings/:id` that adds `documents[]` and `booking.expired`. Both are read defensively: a missing `documents` gives `[]`, and a missing `expired` gives `false`.
- Produces (exact contract names):
  - `src/lib/types.ts`: every type in the contract block. `MarinaData.fromPrice`, `UploadedDoc` and `ContractPreviewResponse` are removed.
  - `src/lib/ota.ts`: everything the contract lists:
    - `guestBase`, `langOf`
    - `adaptMarina`, `adaptRequirements`, `adaptAvailability`, `adaptBooking`, `adaptBookingView`, `adaptCreated`
    - `toCreateBody`, `fitsBerth`, `pickCheapest`, `formatMoney`, `asciiFileName`, `readError`

    It also exports two extra helpers that `marina-api.ts` uses: `adaptContract(raw): GuestContract` and `adaptDocument(raw): GuestDocument`.
  - `src/lib/marina-api.ts`:
    - `MarinaApiError`, with `.status: number` (0 means a network failure).
    - `getMarina`, `getDocRequirements`, `getAvailability`, `createBooking`, `getBooking`, `confirmPayment`, `cancelBooking`, `uploadDocument`, `agreeContract`, `getAblyTokenRequest`, each with exactly the contract signature.
  - `src/lib/booking-session.ts`: `loadSession`, `saveSession`, `clearSession`, `takeSessionFromUrl`.
  - `src/lib/upload-prep.ts`: `prepareUpload`, `MAX_UPLOAD_BYTES`.
  - `src/lib/stripe.ts`: `createPaymentSession(opts): Promise<StripePaymentSession>` and `interface StripePaymentSession { confirm(): Promise<void>; destroy(): void }`. It returns a Promise because `loadStripe` is async, so callers must `await` it.
- Behaviour later tasks rely on:
  - `formatMoney` follows R13 to the letter:
    - `formatMoney(null, …)` returns `''`.
    - With an empty symbol it returns plain `Intl.NumberFormat(lang, { style: 'currency', currency })`. `formatMoney(90, 'EUR', '', 'en')` is `'€90.00'`, the same text Task 10's `totalText` builds.
    - With a non-empty symbol it returns `${symbol}${amount}`, e.g. `'$1234'`.
  - `getDocRequirements` now throws `MarinaApiError` on a non-2xx response. The old version returned `[]`.
  - `uploadDocument` applies `asciiFileName` itself.
  - `getAvailability` sends `boat_beam_m` only when it is a positive number.

- [ ] **Step 1: Write the failing check `scripts/check-ota.ts`**

The fixtures copy OTA's exact shapes from `O/src/controllers/marinaGuest.js`:

| Handler | Lines / source |
|---|---|
| `getMarinaMap` | :49-62 |
| `getAvailability` | :77-80. `total_price` is priceStay's `fromCents(...)` string. |
| `getDocRequirements` | :84-89 |
| `guestView` | :124-131 |
| `getGuestBooking` | :217, plus R20's `documents` and `expired` |
| `createGuestBooking` | :189 |

```ts
// Assert-based check for src/lib/ota.ts, the one place OTA's snake_case
// guest API is mapped to the widget's camelCase types. Fixtures copy the
// exact shapes OTA sends (src/controllers/marinaGuest.js getMarinaMap,
// getAvailability, getDocRequirements, guestView, getGuestBooking,
// createGuestBooking; NUMERIC columns arrive as strings). Run with
// `node scripts/check-ota.ts` (Node 22.18+ strips the types natively),
// which is why ota.ts may only have type-only relative imports.
import assert from 'node:assert/strict';
import {
  adaptAvailability,
  adaptBooking,
  adaptBookingView,
  adaptCreated,
  adaptDocument,
  adaptMarina,
  adaptRequirements,
  asciiFileName,
  fitsBerth,
  formatMoney,
  guestBase,
  langOf,
  pickCheapest,
  readError,
  toCreateBody,
} from '../src/lib/ota.ts';

// ---- guestBase ------------------------------------------------------------
assert.equal(guestBase('', 'sea-co'), '/api/marina/guest/sea-co');
assert.equal(guestBase('https://site.test/', 'sea co'), 'https://site.test/api/marina/guest/sea%20co');
assert.equal(guestBase('https://site.test', 'fox'), 'https://site.test/api/marina/guest/fox');

// ---- langOf -----------------------------------------------------------------
assert.equal(langOf('it-IT'), 'it');
assert.equal(langOf('FR'), 'fr');
assert.equal(langOf('es'), 'es');
assert.equal(langOf('de-DE'), 'en');
assert.equal(langOf(''), 'en');
assert.equal(langOf(null), 'en');
assert.equal(langOf(undefined), 'en');

// ---- adaptMarina --------------------------------------------------------------
const layoutRaw = { svg: '<svg data-layout="1"></svg>', sw_lat: 43.549, sw_lng: 7.019, ne_lat: 43.551, ne_lng: 7.021, rotation: null };
const rawMap = {
  marina: {
    name: 'Demo Marina', slug: 'demo-marina', description: 'Sheltered harbour', lat: 43.55, lng: 7.02,
    phone: '+33 4 00 00 00 00', email: 'harbour@demo.test', website: 'https://demo.test', layout: layoutRaw,
  },
  pontoons: [
    { id: '7d1c0f9e-0000-4000-8000-000000000001', name: 'A', svg_data: '<svg id="a"></svg>', sw_lat: 43.5491, sw_lng: 7.0191, ne_lat: 43.5501, ne_lng: 7.0201, rotation: 12.5, sort_order: 0 },
    { id: '7d1c0f9e-0000-4000-8000-000000000002', name: 'B', svg_data: null, sw_lat: 43.5, sw_lng: 7.0, ne_lat: 43.6, ne_lng: 7.1, rotation: null, sort_order: 1 },
    { id: '7d1c0f9e-0000-4000-8000-000000000003', name: 'C', svg_data: '<svg id="c"></svg>', sw_lat: null, sw_lng: null, ne_lat: null, ne_lng: null, rotation: null, sort_order: 2 },
  ],
  berths: [
    { label: 'A1', pontoon_id: '7d1c0f9e-0000-4000-8000-000000000001', lat: 43.5495, lng: 7.0195, rotation: 90, length_m: '12.00', min_length_m: '8.50', beam_m: '4.20', depth_m: '3.00', price_per_night: '4.50', price_mode: 'per_metre', available: true },
    { label: 'A2', pontoon_id: null, lat: null, lng: null, rotation: null, length_m: null, min_length_m: null, beam_m: null, depth_m: null, price_per_night: null, price_mode: 'fixed', available: false },
  ],
  price_tiers: [
    { valid_from: '2026-06-01', valid_to: '2026-09-30', max_length_m: '15.00', max_beam_m: null, price_per_night: '80.00', price_per_month: null, price_per_year: null },
    { valid_from: '2026-06-01', valid_to: '2026-09-30', max_length_m: '25.00', max_beam_m: '6.50', price_per_night: '140.00', price_per_month: '3000.00', price_per_year: null },
  ],
  pois: [{ label: 'Fuel', type: 'fuel', lat: 43.55, lng: 7.02 }],
  images: [],
  currency: 'EUR',
  stripe_publishable_key: 'pk_test_123',
};
assert.deepEqual(adaptMarina(rawMap), {
  profile: { slug: 'demo-marina', name: 'Demo Marina', lat: 43.55, lng: 7.02, phone: '+33 4 00 00 00 00', email: 'harbour@demo.test' },
  berths: [
    { berthId: 'A1', pontoonId: '7d1c0f9e-0000-4000-8000-000000000001', pricePerNight: 4.5, priceMode: 'per_metre', status: 'available', lat: 43.5495, lng: 7.0195, rotation: 90, lengthM: 12, minLengthM: 8.5, beamM: 4.2, depthM: 3 },
    { berthId: 'A2', pontoonId: null, pricePerNight: null, priceMode: 'fixed', status: 'occupied', lat: null, lng: null, rotation: null, lengthM: null, minLengthM: null, beamM: null, depthM: null },
  ],
  priceTiers: [
    { validFrom: '2026-06-01', validTo: '2026-09-30', maxLenM: 15, maxBeamM: null, pricePerNight: 80 },
    { validFrom: '2026-06-01', validTo: '2026-09-30', maxLenM: 25, maxBeamM: 6.5, pricePerNight: 140 },
  ],
  stripePublishableKey: 'pk_test_123',
  currency: 'EUR',
  // Pontoon B has no drawing and C isn't placed: neither can be overlaid.
  overlays: [{ svgData: '<svg id="a"></svg>', swLat: 43.5491, swLng: 7.0191, neLat: 43.5501, neLng: 7.0201, rotation: 12.5 }],
  layout: { svgData: '<svg data-layout="1"></svg>', swLat: 43.549, swLng: 7.019, neLat: 43.551, neLng: 7.021, rotation: null },
});
assert.equal(adaptMarina({ ...rawMap, marina: { ...rawMap.marina, layout: null } }).layout, null);
assert.equal(adaptMarina({ ...rawMap, marina: { ...rawMap.marina, layout: { ...layoutRaw, ne_lat: null } } }).layout, null);
assert.deepEqual(adaptMarina({ marina: rawMap.marina, currency: 'GBP', stripe_publishable_key: null }).berths, []);

// ---- adaptRequirements --------------------------------------------------------
assert.deepEqual(adaptRequirements([
  { id: '5b0e2a4c-0000-4000-8000-000000000001', type: 'insurance', name: 'Insurance certificate', description: null, fields: [{ name: 'policy_no', label: 'Policy', type: 'text' }], mandatory: true },
  { id: '5b0e2a4c-0000-4000-8000-000000000002', type: 'registration', name: 'Registration', description: 'Small ships register', fields: [], mandatory: false },
]), [
  { id: '5b0e2a4c-0000-4000-8000-000000000001', type: 'insurance', name: 'Insurance certificate', description: '', mandatory: true },
  { id: '5b0e2a4c-0000-4000-8000-000000000002', type: 'registration', name: 'Registration', description: 'Small ships register', mandatory: false },
]);
// Sidon's {requirements: [...]} wrapper is not OTA's shape.
assert.deepEqual(adaptRequirements({ requirements: [] }), []);

// ---- adaptAvailability ----------------------------------------------------------
assert.deepEqual(adaptAvailability([
  { label: 'A1', pontoon_id: '7d1c0f9e-0000-4000-8000-000000000001', length_m: '12.00', beam_m: '4.20', depth_m: '3.00', nights: 3, total_price: '162.00', tier_id: null },
  { label: 'B4', pontoon_id: null, length_m: null, beam_m: null, depth_m: null, nights: 3, total_price: null, tier_id: null },
]), [
  { label: 'A1', lengthM: 12, beamM: 4.2, depthM: 3, nights: 3, totalPrice: 162 },
  { label: 'B4', lengthM: null, beamM: null, depthM: null, nights: 3, totalPrice: null },
]);

// ---- adaptBooking / adaptBookingView / adaptCreated / adaptDocument -------------
const rawBooking = {
  id: '0b7d6c1e-4f6a-4f4e-9a57-2b1f0c9d8e7a', status: 'hold', berth_label: 'A1', marina_name: 'Demo Marina',
  arrival: '2026-07-01', departure: '2026-07-04', contact_name: 'Ada Lovelace', contact_email: 'ada@example.test',
  boat_name: 'Analytical', boat_length_m: '11.50', boat_beam_m: null, total_price: '162.00', currency: 'EUR',
  payment_status: 'none', hold_expires_at: '2026-10-11T10:30:00.000Z', locale: 'it', doc_count: 0, expired: false,
};
const booking = {
  id: '0b7d6c1e-4f6a-4f4e-9a57-2b1f0c9d8e7a', status: 'hold', expired: false, berthLabel: 'A1', marinaName: 'Demo Marina',
  arrival: '2026-07-01', departure: '2026-07-04', contactName: 'Ada Lovelace', contactEmail: 'ada@example.test',
  boatName: 'Analytical', boatLengthM: 11.5, boatBeamM: null, totalPrice: 162, currency: 'EUR',
  paymentStatus: 'none', holdExpiresAt: '2026-10-11T10:30:00.000Z', locale: 'it', docCount: 0,
};
assert.deepEqual(adaptBooking(rawBooking), booking);
const { expired: _omit, ...noExpired } = rawBooking; // create/cancel responses may not carry it
assert.equal(adaptBooking(noExpired).expired, false);
assert.equal(adaptBooking({ ...rawBooking, status: 'cancelled', expired: true }).expired, true);
assert.equal(adaptBooking({ ...rawBooking, departure: null, total_price: null }).totalPrice, null);
assert.equal(adaptBooking({ ...rawBooking, locale: 'xx' }).locale, 'en');

const payment = { clientSecret: 'pi_1_secret_2', publishableKey: 'pk_test_123' };
const rawPayment = { client_secret: 'pi_1_secret_2', publishable_key: 'pk_test_123' };
assert.deepEqual(adaptBookingView({
  booking: { ...rawBooking, status: 'pending', payment_status: 'held', doc_count: 1 },
  payment: null,
  contract: { template_id: '9a8b7c6d-0000-4000-8000-000000000001', rendered_body: '# Berth agreement\nAda Lovelace, berth A1', agreed_at: null },
  documents: [{ id: 'd0c00000-0000-4000-8000-000000000001', requirement_id: '5b0e2a4c-0000-4000-8000-000000000001', file_name: 'insurance.pdf', status: 'pending', submitted_at: '2026-10-11T10:05:00.000Z' }],
}), {
  booking: { ...booking, status: 'pending', paymentStatus: 'held', docCount: 1 },
  payment: null,
  contract: { templateId: '9a8b7c6d-0000-4000-8000-000000000001', renderedBody: '# Berth agreement\nAda Lovelace, berth A1', agreedAt: null },
  documents: [{ id: 'd0c00000-0000-4000-8000-000000000001', requirementId: '5b0e2a4c-0000-4000-8000-000000000001', fileName: 'insurance.pdf', status: 'pending', submittedAt: '2026-10-11T10:05:00.000Z' }],
});
// A hold resuming its card step; no contract; a server without the documents list.
assert.deepEqual(adaptBookingView({ booking: rawBooking, payment: rawPayment, contract: null }), { booking, payment, contract: null, documents: [] });

assert.deepEqual(adaptCreated({ booking: rawBooking, booking_token: 'tok.abc', payment: rawPayment }), { booking, token: 'tok.abc', payment });
assert.equal(adaptCreated({ booking: rawBooking, booking_token: 'tok.abc', payment: null }).payment, null);

// The upload response carries more than the view needs.
assert.deepEqual(adaptDocument({
  id: 'd0c00000-0000-4000-8000-000000000002', requirement_id: null, type: null, file_name: 'scan.jpg',
  content_type: 'image/jpeg', size_bytes: 123456, status: 'pending', submitted_at: '2026-10-11T10:06:00.000Z',
}), { id: 'd0c00000-0000-4000-8000-000000000002', requirementId: null, fileName: 'scan.jpg', status: 'pending', submittedAt: '2026-10-11T10:06:00.000Z' });

// ---- toCreateBody -----------------------------------------------------------
assert.deepEqual(toCreateBody({
  berthLabel: 'A1', arrival: '2026-07-01', departure: '2026-07-04', contactName: ' Ada Lovelace ', contactEmail: 'ada@example.test ',
  contactPhone: '+44 7700 900000', boatName: 'Analytical ', boatLengthM: 11.5, boatBeamM: 3.9, notes: ' Arriving late ', locale: 'it',
}), {
  berth_label: 'A1', arrival: '2026-07-01', departure: '2026-07-04', contact_name: 'Ada Lovelace', contact_email: 'ada@example.test',
  contact_phone: '+44 7700 900000', boat_name: 'Analytical', boat_length_m: 11.5, boat_beam_m: 3.9, notes: 'Arriving late', locale: 'it',
});
// Blank optionals are left out rather than sent empty.
assert.deepEqual(toCreateBody({
  berthLabel: 'A1', arrival: '2026-07-01', departure: '2026-07-04', contactName: 'Ada', contactEmail: 'ada@example.test',
  contactPhone: '  ', boatName: 'Analytical', boatLengthM: 11.5, boatBeamM: null, notes: '', locale: 'en',
}), {
  berth_label: 'A1', arrival: '2026-07-01', departure: '2026-07-04', contact_name: 'Ada', contact_email: 'ada@example.test',
  boat_name: 'Analytical', boat_length_m: 11.5, locale: 'en',
});

// ---- fitsBerth (OTA's berthFitError) ---------------------------------------
const limits = { lengthM: 12, minLengthM: 8, beamM: 4 };
const open = { lengthM: null, minLengthM: null, beamM: null };
assert.equal(fitsBerth(limits, 10), true); // no boat beam passed: beam not checked
assert.equal(fitsBerth(limits, 12), true); // length is inclusive
assert.equal(fitsBerth(limits, 12.01), false); // too long
assert.equal(fitsBerth(limits, 8), true); // minimum is inclusive
assert.equal(fitsBerth(limits, 7.99), false); // too short
assert.equal(fitsBerth(limits, 10, 4), true);
assert.equal(fitsBerth(limits, 10, 4.1), false); // too wide
assert.equal(fitsBerth(limits, 10, null), true); // unknown boat beam: beam not checked
assert.equal(fitsBerth(open, 60, 20), true); // a null limit means no limit
assert.equal(fitsBerth({ lengthM: null, minLengthM: 10, beamM: null }, 9), false);
assert.equal(fitsBerth({ lengthM: 10, minLengthM: null, beamM: null }, 9, 99), true);

// ---- pickCheapest ----------------------------------------------------------
const av = (label: string, totalPrice: number | null, lengthM: number | null) => ({ label, lengthM, beamM: null, depthM: null, nights: 3, totalPrice });
assert.equal(pickCheapest([]), null);
assert.equal(pickCheapest([av('A', 300, 12), av('B', 200, 15), av('C', 200, 10), av('D', null, 8)]), 'C');
assert.equal(pickCheapest([av('D', null, 8), av('E', 500, 20)]), 'E'); // unpriced sorts last
assert.equal(pickCheapest([av('F', null, 14), av('G', null, 9)]), 'G'); // all unpriced: smallest berth
assert.equal(pickCheapest([av('H', 100, null), av('I', 100, 30)]), 'I'); // no length limit counts as biggest

// ---- formatMoney (contract R13) --------------------------------------------
assert.equal(formatMoney(null, 'EUR', '', 'en'), '');
// No symbol: plain Intl currency style, so whole amounts keep their cents;
// Task 10's totalText is built the same way and must match this text.
assert.equal(formatMoney(90, 'EUR', '', 'en'), '€90.00');
assert.equal(formatMoney(162.5, 'GBP', '', 'en'), '£162.50');
assert.equal(formatMoney(1234.5, 'EUR', '', 'it'), new Intl.NumberFormat('it', { style: 'currency', currency: 'EUR' }).format(1234.5));
// A symbol attribute wins over the property currency, prefixed verbatim.
assert.equal(formatMoney(1234, 'GBP', '$', 'en'), '$1234');
assert.equal(formatMoney(1234.5, 'GBP', 'XPF ', 'en'), 'XPF 1234.5');
// No usable ISO code: the bare number, never a RangeError.
assert.equal(formatMoney(10, null, '', 'en'), '10');
assert.equal(formatMoney(10, 'NOPE', '', 'en'), '10');

// ---- asciiFileName ---------------------------------------------------------
assert.equal(asciiFileName('Pässport ñ.pdf'), 'P_ssport _.pdf');
assert.equal(asciiFileName('scan.jpg'), 'scan.jpg');
assert.equal(asciiFileName('a\u0000b\nc.png'), 'a_b_c.png');
assert.equal(asciiFileName('x'.repeat(300)).length, 200);

// ---- readError -------------------------------------------------------------
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
assert.equal(await readError(json({ error: 'Berth not found' }, 404), 'Booking failed'), 'Berth not found');
assert.equal(await readError(json({ error: 'Card payment could not be set up; please try again', details: 'stripe says no' }, 502), 'Booking failed'), 'Card payment could not be set up; please try again');
assert.equal(await readError(new Response('<html><body>Bad gateway</body></html>', { status: 502 }), 'Booking failed'), 'Booking failed');
assert.equal(await readError(new Response(null, { status: 500 }), 'Booking failed'), 'Booking failed');
assert.equal(await readError(json({}, 400), 'Booking failed'), 'Booking failed');

console.log('check-ota: ok');
```

- [ ] **Step 2: Run the check and watch it fail**

Run: `node scripts/check-ota.ts`

Expected: exit 1 with
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\src\lib\ota.ts' imported from …\scripts\check-ota.ts
```

- [ ] **Step 3: Rewrite `src/lib/types.ts`** (whole file)

```ts
// The widget's own camelCase view of OTA's marina guest API. Only
// lib/ota.ts knows OTA's snake_case shapes; everything else uses these.

/** The four languages OTA sends emails in (marinaGuard.js LOCALES). */
export type BookLang = 'en' | 'it' | 'fr' | 'es';

export interface MarinaProfile {
  slug: string;
  name: string;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  email: string | null;
}

export interface Berth {
  /** OTA's berth label; also the SVG's `data-berth-id`. */
  berthId: string;
  pontoonId: string | null;
  pricePerNight: number | null;
  priceMode: 'per_metre' | 'fixed';
  status: 'available' | 'occupied';
  lat: number | null;
  lng: number | null;
  rotation: number | null;
  /** null = the berth records no such limit (it fits any boat on that axis). */
  lengthM: number | null;
  minLengthM: number | null;
  beamM: number | null;
  depthM: number | null;
}

export interface PriceTier {
  validFrom: string;
  /** Inclusive: the last night the tier covers. */
  validTo: string;
  maxLenM: number;
  maxBeamM: number | null;
  pricePerNight: number;
}

export interface OverlayRow {
  svgData: string;
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  rotation: number | null;
}

export interface OtherMarina {
  name: string;
  lat: number;
  lng: number;
  logoMark: string | null;
  /** Host-supplied link — the package owns no routing convention, so this
      is always precomputed by the consumer, never built internally. */
  href: string | null;
}

export interface MarinaData {
  profile: MarinaProfile;
  berths: Berth[];
  priceTiers: PriceTier[];
  /** The property's own key; the card form uses the one returned with the
      booking (PaymentSession), which is the key that matters. */
  stripePublishableKey: string | null;
  /** ISO 4217, upper case (the property's currency). */
  currency: string;
  overlays: OverlayRow[];
  /** Single combined-layout overlay, if the marina has one (distinct from
      the per-pontoon `overlays`). */
  layout: OverlayRow | null;
}

export interface DocRequirement {
  id: string;
  type: string;
  name: string;
  description: string;
  mandatory: boolean;
}

/** A free berth that fits the boat, priced by OTA's priceStay. */
export interface AvailableBerth {
  label: string;
  lengthM: number | null;
  beamM: number | null;
  depthM: number | null;
  nights: number;
  /** null = the marina has no price for this stay (email-confirm path). */
  totalPrice: number | null;
}

export type BookingStatus = 'hold' | 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface GuestBooking {
  id: string;
  status: BookingStatus;
  /** A hold that lapsed before it was confirmed (shown apart from a cancel). */
  expired: boolean;
  berthLabel: string;
  marinaName: string;
  arrival: string;
  departure: string | null;
  contactName: string;
  contactEmail: string | null;
  boatName: string | null;
  boatLengthM: number | null;
  boatBeamM: number | null;
  totalPrice: number | null;
  currency: string | null;
  /** none | held | captured | released | refunded */
  paymentStatus: string;
  /** ISO timestamp: hold expiry while `hold`, the marina's reply deadline while `pending`. */
  holdExpiresAt: string | null;
  locale: BookLang;
  docCount: number;
}

export interface GuestDocument {
  id: string;
  requirementId: string | null;
  fileName: string | null;
  status: 'pending' | 'verified' | 'rejected';
  submittedAt: string;
}

export interface PaymentSession {
  clientSecret: string;
  publishableKey: string;
}

export interface GuestContract {
  templateId: string | null;
  renderedBody: string;
  agreedAt: string | null;
}

export interface BookingView {
  booking: GuestBooking;
  payment: PaymentSession | null;
  contract: GuestContract | null;
  documents: GuestDocument[];
}

export interface CreateBookingInput {
  berthLabel: string;
  arrival: string;
  departure: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  boatName: string;
  boatLengthM: number;
  boatBeamM?: number | null;
  notes?: string;
  locale: BookLang;
}

export interface CreatedBooking {
  booking: GuestBooking;
  token: string;
  payment: PaymentSession | null;
}

/** Proof of access to one booking: OTA checks `token` as X-Booking-Token. */
export interface BookingSession {
  id: string;
  token: string;
}
```

- [ ] **Step 4: Create `src/lib/ota.ts`** (whole file)

```ts
// Pure mapping between OTA's marina guest API and the widget's types.
// OTA (src/controllers/marinaGuest.js) speaks snake_case and returns
// NUMERIC columns as strings ("12.50"); the components only ever see the
// camelCase numbers in ./types. No runtime imports: scripts/check-ota.ts
// runs this file under Node's type stripping, which erases `import type`
// but can't resolve the extensionless paths Vite uses.
import type {
  AvailableBerth,
  Berth,
  BookLang,
  BookingView,
  CreateBookingInput,
  CreatedBooking,
  DocRequirement,
  GuestBooking,
  GuestContract,
  GuestDocument,
  MarinaData,
  OverlayRow,
  PaymentSession,
} from './types';

const LANGS: BookLang[] = ['en', 'it', 'fr', 'es'];

// NUMERIC arrives as a string, DOUBLE PRECISION as a number, and an
// unrecorded limit as null; anything unparseable is treated as unrecorded.
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function guestBase(apiOrigin: string, slug: string): string {
  return `${apiOrigin.replace(/\/$/, '')}/api/marina/guest/${encodeURIComponent(slug)}`;
}

// OTA silently turns any other locale into 'en', so 'it-IT' must become 'it'
// here or an Italian page would get English emails.
export function langOf(locale: string | null | undefined): BookLang {
  const l = (locale ?? '').slice(0, 2).toLowerCase() as BookLang;
  return LANGS.includes(l) ? l : 'en';
}

// A pontoon without a drawing, or not yet placed on the map, can't be
// ground-overlaid, so it's dropped rather than drawn at 0,0.
function overlay(svg: unknown, r: any): OverlayRow | null {
  const swLat = num(r.sw_lat), swLng = num(r.sw_lng), neLat = num(r.ne_lat), neLng = num(r.ne_lng);
  if (typeof svg !== 'string' || !svg || swLat == null || swLng == null || neLat == null || neLng == null) return null;
  return { svgData: svg, swLat, swLng, neLat, neLng, rotation: num(r.rotation) };
}

export function adaptMarina(raw: any): MarinaData {
  const m = raw.marina ?? {};
  return {
    profile: { slug: m.slug, name: m.name, lat: num(m.lat), lng: num(m.lng), phone: m.phone ?? null, email: m.email ?? null },
    berths: (raw.berths ?? []).map((b: any): Berth => ({
      berthId: b.label,
      pontoonId: b.pontoon_id ?? null,
      pricePerNight: num(b.price_per_night),
      priceMode: b.price_mode === 'fixed' ? 'fixed' : 'per_metre',
      // OTA's `available` already folds in maintenance, holds and bookings
      // overlapping the requested dates; the map paints every "no" alike.
      status: b.available === true ? 'available' : 'occupied',
      lat: num(b.lat),
      lng: num(b.lng),
      rotation: num(b.rotation),
      lengthM: num(b.length_m),
      minLengthM: num(b.min_length_m),
      beamM: num(b.beam_m),
      depthM: num(b.depth_m),
    })),
    priceTiers: (raw.price_tiers ?? []).map((t: any) => ({
      validFrom: t.valid_from,
      validTo: t.valid_to,
      maxLenM: Number(t.max_length_m),
      maxBeamM: num(t.max_beam_m),
      pricePerNight: Number(t.price_per_night),
    })),
    stripePublishableKey: raw.stripe_publishable_key ?? null,
    currency: raw.currency ?? '',
    // Pontoons carry `svg_data`; the marina layout's markup is `svg`.
    overlays: (raw.pontoons ?? []).map((p: any) => overlay(p.svg_data, p)).filter((o: OverlayRow | null): o is OverlayRow => o !== null),
    layout: m.layout ? overlay(m.layout.svg, m.layout) : null,
  };
}

// OTA returns a bare array (Sidon wrapped it in {requirements}).
export function adaptRequirements(raw: any): DocRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => ({
    id: String(r.id),
    type: r.type ?? '',
    name: r.name ?? '',
    description: r.description ?? '',
    mandatory: r.mandatory !== false,
  }));
}

export function adaptAvailability(raw: any): AvailableBerth[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b: any) => ({
    label: b.label,
    lengthM: num(b.length_m),
    beamM: num(b.beam_m),
    depthM: num(b.depth_m),
    nights: Number(b.nights),
    totalPrice: num(b.total_price),
  }));
}

export function adaptBooking(raw: any): GuestBooking {
  return {
    id: raw.id,
    status: raw.status,
    // Only GET booking is guaranteed to carry it; elsewhere absent = false.
    expired: raw.expired === true,
    berthLabel: raw.berth_label,
    marinaName: raw.marina_name,
    arrival: raw.arrival,
    departure: raw.departure ?? null,
    contactName: raw.contact_name,
    contactEmail: raw.contact_email ?? null,
    boatName: raw.boat_name ?? null,
    boatLengthM: num(raw.boat_length_m),
    boatBeamM: num(raw.boat_beam_m),
    totalPrice: num(raw.total_price),
    currency: raw.currency ?? null,
    paymentStatus: raw.payment_status ?? 'none',
    holdExpiresAt: raw.hold_expires_at ?? null,
    locale: langOf(raw.locale),
    docCount: Number(raw.doc_count) || 0,
  };
}

// OTA sends `payment` only for a card-path hold; both halves are needed to
// mount the Payment Element.
function adaptPayment(p: any): PaymentSession | null {
  return p?.client_secret && p?.publishable_key ? { clientSecret: p.client_secret, publishableKey: p.publishable_key } : null;
}

export function adaptContract(raw: any): GuestContract {
  return { templateId: raw.template_id ?? null, renderedBody: raw.rendered_body ?? '', agreedAt: raw.agreed_at ?? null };
}

// Also maps the upload response, which carries more than the view needs.
export function adaptDocument(raw: any): GuestDocument {
  return {
    id: raw.id,
    requirementId: raw.requirement_id ?? null,
    fileName: raw.file_name ?? null,
    status: raw.status,
    submittedAt: raw.submitted_at,
  };
}

export function adaptBookingView(raw: any): BookingView {
  return {
    booking: adaptBooking(raw.booking),
    payment: adaptPayment(raw.payment),
    contract: raw.contract ? adaptContract(raw.contract) : null,
    documents: (raw.documents ?? []).map(adaptDocument),
  };
}

export function adaptCreated(raw: any): CreatedBooking {
  return { booking: adaptBooking(raw.booking), token: raw.booking_token, payment: adaptPayment(raw.payment) };
}

// Blank optionals are left out so OTA stores NULL rather than ''.
export function toCreateBody(input: CreateBookingInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    berth_label: input.berthLabel,
    arrival: input.arrival,
    departure: input.departure,
    contact_name: input.contactName.trim(),
    contact_email: input.contactEmail.trim(),
    boat_name: input.boatName.trim(),
    boat_length_m: input.boatLengthM,
    locale: input.locale,
  };
  const phone = input.contactPhone?.trim();
  if (phone) body.contact_phone = phone;
  if (input.boatBeamM != null) body.boat_beam_m = input.boatBeamM;
  const notes = input.notes?.trim();
  if (notes) body.notes = notes;
  return body;
}

// OTA's berthFitError (src/lib/marinaGuard.js): each limit is skipped when
// the berth doesn't record it, and beam only when the boat's is known.
export function fitsBerth(b: Pick<Berth, 'lengthM' | 'minLengthM' | 'beamM'>, loa: number, beam?: number | null): boolean {
  if (b.lengthM != null && loa > b.lengthM) return false;
  if (b.minLengthM != null && loa < b.minLengthM) return false;
  if (b.beamM != null && beam != null && beam > b.beamM) return false;
  return true;
}

// The list is already OTA's free, fitting berths. Cheapest total wins;
// unpriced berths go last; a tie goes to the smaller berth, keeping big
// berths free for big boats (an unlimited length counts as the biggest).
export function pickCheapest(list: AvailableBerth[]): string | null {
  const key = (v: number | null) => v ?? Infinity;
  const best = [...list].sort((a, b) => key(a.totalPrice) - key(b.totalPrice) || key(a.lengthM) - key(b.lengthM))[0];
  return best?.label ?? null;
}

// Contract R13. A non-empty `currency-symbol` attribute wins (some sites
// price in a currency other than the property's) and is prefixed as-is;
// otherwise the property's ISO code goes through Intl's currency style.
export function formatMoney(amount: number | null, currency: string | null, symbolOverride: string, lang: BookLang): string {
  if (amount == null) return '';
  if (!symbolOverride && currency) {
    try {
      return new Intl.NumberFormat(lang, { style: 'currency', currency }).format(amount);
    } catch {
      // Not an ISO code: fall through to the bare number.
    }
  }
  return `${symbolOverride}${amount}`;
}

// fetch() throws on a non-Latin-1 header value; OTA narrows the stored
// name further to [\w.\- ].
export function asciiFileName(name: string): string {
  return name.replace(/[^\x20-\x7E]/g, '_').slice(0, 200);
}

// OTA errors are {error, details?}; a forwarder, proxy or CDN in between
// can answer with HTML or nothing, which must never surface as a
// SyntaxError. `details` is left out: it can be a raw Stripe message.
export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = JSON.parse(await res.text());
    if (typeof data?.error === 'string' && data.error) return data.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}
```

- [ ] **Step 5: Run the check again**

Run: `node scripts/check-ota.ts`

Expected: `check-ota: ok`, exit 0.

A pass also shows that Node erased the `import type … from './types'` in `ota.ts`. If it hadn't, the run would fail with `ERR_MODULE_NOT_FOUND` for `src/lib/types`. Keep the `import type { … }` form, because `import { type X }` leaves a runtime import behind.

- [ ] **Step 6: Wire the check into `npm test`**

In `package.json`, under `"scripts"`, edit the line Task 3 added. Keep its trailing comma if it has one.

Old:
```json
    "test": "node scripts/check-astro-proxy.ts"
```
New:
```json
    "test": "node scripts/check-astro-proxy.ts && node scripts/check-ota.ts"
```

Run: `npm test`

Expected: exit 0. Task 3's check prints first, then `check-ota: ok`.

- [ ] **Step 7: Rewrite `src/lib/marina-api.ts`** (whole file)

```ts
// Browser client for OTA's marina guest API (/api/marina/guest/:slug/...).
// Calls go to the host site's own forwarder (createMarinaProxy), which adds
// the API key server-side, so `apiOrigin` defaults to '' (same origin) and
// no secret ever reaches the page. Responses are mapped to the widget's
// camelCase types in ota.ts; every failure becomes a MarinaApiError with
// the HTTP status (0 = network) and OTA's own {error} text when it sent one.
// Type-only import — erased at build time, so this doesn't pull the ably
// client into this module's bundle.
import type { TokenRequest } from 'ably';
import type {
  AvailableBerth,
  BookingSession,
  BookingView,
  CreateBookingInput,
  CreatedBooking,
  DocRequirement,
  GuestBooking,
  GuestContract,
  GuestDocument,
  MarinaData,
} from './types';
import {
  adaptAvailability,
  adaptBooking,
  adaptBookingView,
  adaptContract,
  adaptCreated,
  adaptDocument,
  adaptMarina,
  adaptRequirements,
  asciiFileName,
  guestBase,
  readError,
  toCreateBody,
} from './ota';

export class MarinaApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call(url: string, fallback: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new MarinaApiError(fallback, 0);
  }
  if (!res.ok) throw new MarinaApiError(await readError(res, fallback), res.status);
  try {
    return await res.json();
  } catch {
    // A 200 that isn't JSON (e.g. a site's HTML fallback page) is still a failure.
    throw new MarinaApiError(fallback, res.status);
  }
}

// Every POST except the upload is JSON, data-less actions included ('{}'),
// so the forwarder and OTA's JSON parser always see a well-formed request.
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const bookingUrl = (apiOrigin: string, slug: string, s: BookingSession, path = '') =>
  `${guestBase(apiOrigin, slug)}/bookings/${encodeURIComponent(s.id)}${path}`;

// OTA answers 404 for a wrong token, so a booking id alone reveals nothing.
const tokenHeader = (s: BookingSession) => ({ 'X-Booking-Token': s.token });

export async function getMarina(apiOrigin: string, slug: string, range?: { from: string; to: string }): Promise<MarinaData> {
  // OTA 400s on a zero-night or inverted range (flatpickr lets a guest pick
  // the same day twice); with no dates it answers for tonight.
  const qs = range && range.to > range.from ? `?${new URLSearchParams(range)}` : '';
  return adaptMarina(await call(`${guestBase(apiOrigin, slug)}${qs}`, 'Failed to load marina data'));
}

export async function getDocRequirements(apiOrigin: string, slug: string): Promise<DocRequirement[]> {
  return adaptRequirements(await call(`${guestBase(apiOrigin, slug)}/doc-requirements`, 'Failed to load document requirements'));
}

// Free berths that fit the boat, each priced by OTA's priceStay, so the
// widget never does its own price maths.
export async function getAvailability(
  apiOrigin: string,
  slug: string,
  q: { arrival: string; departure: string; boatLengthM: number; boatBeamM?: number | null },
): Promise<AvailableBerth[]> {
  const params = new URLSearchParams({ arrival: q.arrival, departure: q.departure, boat_length_m: String(q.boatLengthM) });
  // OTA 400s on a beam that isn't positive; no beam means beam isn't checked.
  if (q.boatBeamM) params.set('boat_beam_m', String(q.boatBeamM));
  return adaptAvailability(await call(`${guestBase(apiOrigin, slug)}/availability?${params}`, 'Failed to load availability'));
}

// Creates a 30-minute hold. `payment` is set only on the card path.
export async function createBooking(apiOrigin: string, slug: string, input: CreateBookingInput): Promise<CreatedBooking> {
  return adaptCreated(await call(`${guestBase(apiOrigin, slug)}/bookings`, 'Booking failed', post(toCreateBody(input))));
}

export async function getBooking(apiOrigin: string, slug: string, s: BookingSession): Promise<BookingView> {
  return adaptBookingView(await call(bookingUrl(apiOrigin, slug, s), 'Failed to load your booking', { headers: tokenHeader(s) }));
}

// 409 = the card isn't authorised yet (or the booking moved on); 410 = the
// hold lapsed first. Callers branch on MarinaApiError.status.
export async function confirmPayment(apiOrigin: string, slug: string, s: BookingSession): Promise<GuestBooking> {
  const data = await call(bookingUrl(apiOrigin, slug, s, '/confirm-payment'), 'Payment could not be confirmed', post({}, tokenHeader(s)));
  return adaptBooking(data.booking);
}

export async function cancelBooking(apiOrigin: string, slug: string, s: BookingSession): Promise<GuestBooking> {
  const data = await call(bookingUrl(apiOrigin, slug, s, '/cancel'), 'Could not cancel the booking', post({}, tokenHeader(s)));
  return adaptBooking(data.booking);
}

// Raw body, not JSON/base64: OTA sniffs the bytes (PDF, JPEG or PNG only)
// and caps the body at 4 MiB; prepareUpload (upload-prep.ts) gets it there.
export async function uploadDocument(
  apiOrigin: string,
  slug: string,
  s: BookingSession,
  p: { blob: Blob; contentType: string; fileName: string; requirementId: string },
): Promise<GuestDocument> {
  const url = bookingUrl(apiOrigin, slug, s, `/documents?requirement_id=${encodeURIComponent(p.requirementId)}`);
  return adaptDocument(await call(url, 'Upload failed', {
    method: 'POST',
    headers: { ...tokenHeader(s), 'Content-Type': p.contentType, 'X-File-Name': asciiFileName(p.fileName) },
    body: p.blob,
  }));
}

export async function agreeContract(apiOrigin: string, slug: string, s: BookingSession): Promise<GuestContract> {
  return adaptContract(await call(bookingUrl(apiOrigin, slug, s, '/contract'), 'Could not record your agreement', post({}, tokenHeader(s))));
}

// Call this from Ably's authCallback every time it fires: a TokenRequest
// is single-use, so replaying one breaks the hourly renewal. null = 503,
// Ably isn't configured on OTA (the caller falls back to polling).
export async function getAblyTokenRequest(apiOrigin: string, slug: string, s: BookingSession): Promise<TokenRequest | null> {
  try {
    return await call(bookingUrl(apiOrigin, slug, s, '/ably-token'), 'Live updates are unavailable', { headers: tokenHeader(s) });
  } catch (err) {
    if (err instanceof MarinaApiError && err.status === 503) return null;
    throw err;
  }
}
```

- [ ] **Step 8: Rewrite `src/lib/stripe.ts`** (whole file)

```ts
// Stripe Payment Element wrapper — ported from sidon-ai's book-payment.ts.
// Mounts against a real DOM element reference (not a selector string).
// IMPORTANT: `mount` must be a light-DOM node — Stripe.js has no official
// Shadow DOM support (stripe/stripe-js#143, stripe/stripe-js#399). Handing
// it a node that lives inside the widget's shadow root leaves the Payment
// Element stuck on its loading skeleton forever (every network request
// succeeds, nothing throws — it just never resolves). Callers create the
// mount node as a light-DOM child of the host custom element and project
// it into the shadow layout via a <slot>.
// OTA creates the PaymentIntent on the property's own Stripe account (no
// Connect), so there is no stripeAccount to pass.
import type { StripeElements, StripePaymentElement } from '@stripe/stripe-js';

export interface StripePaymentSession {
  /** Authorises the card (manual capture); the caller then tells OTA via confirm-payment. */
  confirm(): Promise<void>;
  destroy(): void;
}

export async function createPaymentSession(opts: {
  publishableKey: string;
  clientSecret: string;
  locale: string;
  mount: HTMLElement;
  colorPrimary?: string;
}): Promise<StripePaymentSession> {
  const { loadStripe } = await import('@stripe/stripe-js');
  const stripe = await loadStripe(opts.publishableKey);
  if (!stripe) throw new Error('Stripe failed to load');

  const color = opts.colorPrimary || '#16365b';
  const elements: StripeElements = stripe.elements({
    clientSecret: opts.clientSecret,
    locale: (opts.locale || 'auto') as never,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: color,
        colorText: color,
        colorDanger: '#cc4949',
        fontFamily: 'Inter, system-ui, sans-serif',
        borderRadius: '10px',
      },
    },
  });
  const paymentElement: StripePaymentElement = elements.create('payment', { layout: 'tabs' });
  paymentElement.mount(opts.mount);

  return {
    async confirm() {
      // OTA's PaymentIntents are card-only, so 'if_required' never redirects.
      const { error } = await stripe.confirmPayment({ elements, redirect: 'if_required' });
      if (error) throw new Error(error.message || 'Card authorisation failed');
    },
    destroy() {
      paymentElement.destroy();
    },
  };
}
```

- [ ] **Step 9: Create `src/lib/booking-session.ts` and `src/lib/upload-prep.ts`**

`src/lib/booking-session.ts`:
```ts
// The booking token is a bearer secret for one booking, so it lives in
// sessionStorage (this tab only, gone when it closes), keyed per marina,
// never in localStorage. Storage can throw (privacy modes, sandboxed
// iframes); then the booking simply doesn't survive a reload.
import type { BookingSession } from './types';

const key = (slug: string) => `sidon-booking:${slug}`;

export function loadSession(slug: string): BookingSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(key(slug)) ?? 'null');
    return typeof s?.id === 'string' && typeof s?.token === 'string' ? { id: s.id, token: s.token } : null;
  } catch {
    return null;
  }
}

export function saveSession(slug: string, s: BookingSession): void {
  try {
    sessionStorage.setItem(key(slug), JSON.stringify({ id: s.id, token: s.token }));
  } catch {
    // Storage unavailable: see above.
  }
}

export function clearSession(slug: string): void {
  try {
    sessionStorage.removeItem(key(slug));
  } catch {
    // Storage unavailable: see above.
  }
}

// Booking-page mode: OTA's emails link to the marina's booking_url filled
// as ?booking={id}&token={token}. The token comes out of the address bar
// at once so analytics (page_location), history and shared links never
// carry it; the caller saves the session.
export function takeSessionFromUrl(): BookingSession | null {
  const url = new URL(location.href);
  const id = url.searchParams.get('booking');
  const token = url.searchParams.get('token');
  if (token) {
    url.searchParams.delete('token');
    history.replaceState(history.state, '', url);
  }
  return id && token ? { id, token } : null;
}
```

`src/lib/upload-prep.ts`:
```ts
// OTA accepts only PDF, JPEG or PNG (sniffed from the bytes) up to 4 MiB
// (express.raw limit '4mb'). Phones hand over HEIC/WebP and 10 MB photos,
// so any other image, or an oversize JPEG/PNG, is re-encoded here as a
// JPEG no larger than 2000 px on its longest side. PDFs can't be shrunk
// in the browser, so an oversize one is refused with a clear message.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 2000;
const NOT_SUPPORTED = 'Please upload a PDF, JPEG or PNG';

export async function prepareUpload(
  file: File,
): Promise<{ blob: Blob; contentType: 'application/pdf' | 'image/jpeg' | 'image/png'; fileName: string }> {
  // Some platforms report no MIME type for a PDF, hence the extension check.
  if (file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name))) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('PDF files must be 4 MB or smaller');
    return { blob: file, contentType: 'application/pdf', fileName: file.name };
  }
  if ((file.type === 'image/jpeg' || file.type === 'image/png') && file.size <= MAX_UPLOAD_BYTES) {
    return { blob: file, contentType: file.type, fileName: file.name };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not an image this browser can decode (e.g. HEIC outside Safari, a Word file).
    throw new Error(NOT_SUPPORTED);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(NOT_SUPPORTED);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const fileName = `${file.name.replace(/\.[^.]*$/, '')}.jpg`;
  for (const quality of [0.85, 0.7]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_UPLOAD_BYTES) return { blob, contentType: 'image/jpeg', fileName };
  }
  throw new Error('That image is too large; please upload a smaller one');
}
```

`booking-session.ts` and `upload-prep.ts` use browser globals (`sessionStorage`, `history`, `createImageBitmap`, canvas), so `check-ota.ts` can't run them. `npm run check` type-checks them, and Task 10's e2e run exercises them.

- [ ] **Step 10: Delete `src/lib/guest-token.ts`**

Run: `git rm -q src/lib/guest-token.ts`

OTA has no equivalent of the localStorage guest token, the base64 upload or the `extractedData` autofill. OTA identifies the guest by the booking token, and extraction never reaches the key rail.

- [ ] **Step 11: Verify that tests pass and type errors stay in the three components Tasks 7–8 rewrite**

Run: `npm test`

Expected: exit 0, ending in `check-ota: ok`.

Run: `npx svelte-check --tsconfig ./tsconfig.app.json --output machine | grep ' ERROR ' | cut -d'"' -f2 | sort | uniq -c`

Expected, assuming Task 2 already cleared the 3 baseline errors in `Summary.svelte` and `SentStep.svelte`:
```
     17 src\\BookingWidget.svelte
      4 src\\components\\DocumentsStep.svelte
      1 src\\components\\SentStep.svelte
```

What the errors are:
- `BookingWidget.svelte`: imports that no longer exist (`./lib/guest-token`, `mountPaymentElement`, `uploadGuestDoc`, `createIntent`, `submitBooking`, `getContractPreview`, `CreateIntentResult`, `UploadedDoc`, `ContractPreviewResponse`). The rest are knock-on implicit-any errors and string-vs-number requirement-id errors.
- `DocumentsStep.svelte`: `UploadedDoc` is gone, and requirement ids are now strings.
- `SentStep.svelte`: `getAblyToken` is gone.

No other file may report an error. These must all be clean:
- every `src/lib/*.ts`, including `berth-pricing.ts` and `date-range.ts`
- `BerthMap.svelte`, `BerthMapView.svelte`, `DetailsStep.svelte`, `QuickBookCard.svelte`

They still compile against the new types: `getMarina`'s signature is unchanged, and they call `Number()` on `Berth` fields that are now plain numbers.

`npm run check` keeps exiting 1 until Task 8. Task 6 owns `BerthMap.svelte` and Task 7 owns the booking view. Task 8 replaces `BookingWidget.svelte`, `SentStep.svelte` and `DocumentsStep.svelte`.

`npm run build` also fails at the widget build until Task 8, with Rolldown reporting the missing exports listed above. Its first half, `vite build --config vite.berth-map.config.ts`, still builds.

- [ ] **Step 12: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add scripts/check-ota.ts package.json src/lib/types.ts src/lib/ota.ts src/lib/marina-api.ts src/lib/stripe.ts src/lib/booking-session.ts src/lib/upload-prep.ts
git -C C:/Users/robert/source/repos/sidon-booking-widget commit -F - <<'EOF'
Data layer on OTA's marina guest API

types.ts is rewritten for OTA (string ids, berth labels, holds, guest
booking view). ota.ts holds the pure snake_case -> camelCase adapters
plus the fit rule, auto-pick, money (R13), locale and error helpers,
checked by scripts/check-ota.ts under npm test. marina-api.ts now calls
/api/marina/guest/:slug with X-Booking-Token, sessions live in
sessionStorage, uploads are prepared as PDF/JPEG/PNG <= 4 MiB, and the
Stripe session has no Connect account. guest-token.ts is removed.

BookingWidget, SentStep and DocumentsStep don't type-check until they
are rewritten on this layer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
(`git rm` in Step 10 already staged the deletion of `guest-token.ts`.)

---

### Task 6: <sidon-berth-map> on OTA data

Repo `W` = `C:/Users/robert/source/repos/sidon-booking-widget`. Contract R3, R4, R5, R13, R16.

**Files:**
- Modify: `W/src/BerthMap.svelte`. The script block (35-220) and the markup (222-266) are rewritten. `<svelte:options>` (1-33) and `<style>` (268-312) stay byte-identical. The whole file is given below.
- Modify: `W/src/components/BerthMapView.svelte`, lines 2-4, 35-44, 170-182, 269-274, 299-315, 359-363, 365-394 and 447-466.
- Delete: `W/src/lib/berth-pricing.ts`. Its only importer is `BerthMap.svelte:41`.
- Scratch, never committed: `W/demo/map-only.html` is created in Step 5 and removed at the end of that step.
- Read only, no change:
  - `W/src/components/QuickBookCard.svelte`: its props `totalLabel: string | null`, `seasonRanges` and `locale` already fit.
  - `W/src/lib/date-range.ts`: the contract `PriceTier` keeps `validFrom`/`validTo`, so `seasonRangesFromTiers` and `applySeasonGate` work unchanged.

**Interfaces:**
- **Consumes (Task 5):**
  - `getMarina(apiOrigin, slug, range?: {from: string; to: string}): Promise<MarinaData>`
  - `getAvailability(apiOrigin, slug, q: {arrival: string; departure: string; boatLengthM: number; boatBeamM?: number | null}): Promise<AvailableBerth[]>` (both in `W/src/lib/marina-api.ts`)
  - `pickCheapest(list: AvailableBerth[]): string | null`
  - `formatMoney(amount: number | null, currency: string | null, symbolOverride: string, lang: BookLang): string`
  - `langOf(locale): BookLang`
  - `fitsBerth(b: Pick<Berth,'lengthM'|'minLengthM'|'beamM'>, loa: number, beam?: number | null): boolean` (all four in `W/src/lib/ota.ts`)
  - Types `MarinaData`, `Berth`, `AvailableBerth`, `OverlayRow`, `OtherMarina` from `W/src/lib/types.ts`
  - Unchanged: `localIso`, `parseISODate`, `seasonRangesFromTiers`
- **Consumes (Task 2):** the dev server's `/api/marina/guest` proxy to the local OTA, and the `demo-marina` slug from `O/scripts/seed-marina-demo.js`. Step 5 only.
- **Produces: `<sidon-berth-map>`**
  - Same attributes and `otherMarinas` property.
  - Defaults change: `api-origin` → `''` (R2) and `currency-symbol` → `''` (R13: an empty symbol means `Intl` formatting with the marina's `currency`).
  - Events keep their names and detail fields:
    - `sidon-berth-selected {berthId: string | null}`: user clicks only.
    - `sidon-loa-change {loa: number}`
    - `sidon-quickbook-submit {from: string | null, to: string | null, length: number, berth: string | null}`: cancelable.
  - `book-path` navigation now merges `from`/`to`/`length`/`berth` into book-path's own query and keeps its hash.
- **Produces: `components/BerthMapView.svelte`**
  - Props are unchanged: `{ mapsApiKey; mapStyle: 'chart'|'coastal'; center; navy; gold; logoMark?; marinaName?; otherMarinas; berths: Berth[]; overlays; layout; loa; selectedBerth: string | null; onBerthClick: (berthId: string | null) => void }`.
  - Behaviour change that Task 8 inherits: a berth is clickable only when `status === 'available' && fitsBerth(berth, loa)`.
    - Chart style: booked berths are painted `BOOKED` and non-fitting ones `NO_FIT`, both with `clickable:false`.
    - Coastal style: an unknown SVG label gets `data-status="occupied"` and a non-fitting one gets `data-fit="small"`.
  - Clicking the selected berth still calls `onBerthClick(null)`.
  - Task 8's handler must still check its own availability list (R5).
- **Removed:** `derivedNightlyPrice`, `pickBestFit`, `nightlyFromTiers`.

- [ ] **Step 1: Red check: the 0.x pricing and defaults are still there**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget
grep -nE "berth-pricing|sidonmarine\.uk|currencySymbol = '€'|manualSelection" src/BerthMap.svelte; grep -n "?? 'available'" src/components/BerthMapView.svelte
```
Expected (fail):
- `BerthMap.svelte` matches at lines 41, 74, 77, 120, 158, 161, 163 and 170.
- `BerthMapView.svelte` matches at lines 172 and 180.

- [ ] **Step 2: Delete `berth-pricing.ts` and rewrite `src/BerthMap.svelte`**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && git rm --ignore-unmatch src/lib/berth-pricing.ts
```

Replace the whole of `W/src/BerthMap.svelte` with:

```svelte
<svelte:options
  customElement={{
    tag: 'sidon-berth-map',
    shadow: 'open',
    props: {
      marina: { attribute: 'marina', type: 'String' },
      mapsApiKey: { attribute: 'maps-api-key', type: 'String' },
      apiOrigin: { attribute: 'api-origin', type: 'String' },
      mapStyle: { attribute: 'map-style', type: 'String' },
      locale: { attribute: 'locale', type: 'String' },
      currencySymbol: { attribute: 'currency-symbol', type: 'String' },
      from: { attribute: 'from', type: 'String' },
      to: { attribute: 'to', type: 'String' },
      length: { attribute: 'length', type: 'Number' },
      berth: { attribute: 'berth', type: 'String' },
      bookPath: { attribute: 'book-path', type: 'String' },
      logoMark: { attribute: 'logo-mark', type: 'String' },
      marinaName: { attribute: 'marina-name', type: 'String' },
      otherMarinas: { type: 'Array' },
      mapHeight: { attribute: 'map-height', type: 'String' },
      showWeather: { attribute: 'show-weather', type: 'Boolean' },
      eyebrow: { attribute: 'eyebrow', type: 'String' },
      cardTitle: { attribute: 'card-title', type: 'String' },
      intro: { attribute: 'intro', type: 'String' },
      rangeLabel: { attribute: 'range-label', type: 'String' },
      rangePlaceholder: { attribute: 'range-placeholder', type: 'String' },
      lengthLabel: { attribute: 'length-label', type: 'String' },
      selectedLabel: { attribute: 'selected-label', type: 'String' },
      selectedPlaceholder: { attribute: 'selected-placeholder', type: 'String' },
      ctaLabel: { attribute: 'cta-label', type: 'String' },
    },
  }}
/>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import BerthMapView from './components/BerthMapView.svelte';
  import QuickBookCard from './components/QuickBookCard.svelte';
  import WeatherPanel from './components/WeatherPanel.svelte';
  import { getAvailability, getMarina } from './lib/marina-api';
  import { formatMoney, langOf, pickCheapest } from './lib/ota';
  import { localIso, parseISODate, seasonRangesFromTiers } from './lib/date-range';
  import type { AvailableBerth, MarinaData, OtherMarina } from './lib/types';

  interface Props {
    marina: string;
    mapsApiKey: string;
    apiOrigin?: string;
    mapStyle?: 'chart' | 'coastal';
    locale?: string;
    currencySymbol?: string;
    from?: string;
    to?: string;
    length?: number;
    berth?: string;
    bookPath?: string;
    logoMark?: string | null;
    marinaName?: string;
    otherMarinas?: OtherMarina[];
    mapHeight?: string;
    showWeather?: boolean;
    eyebrow?: string;
    cardTitle?: string;
    intro?: string;
    rangeLabel?: string;
    rangePlaceholder?: string;
    lengthLabel?: string;
    selectedLabel?: string;
    selectedPlaceholder?: string;
    ctaLabel?: string;
  }
  let {
    marina, mapsApiKey,
    // '' = the page's own origin: the site's /api/marina/guest forwarder
    // adds the OTA key server-side, so the browser never calls OTA itself.
    apiOrigin = '',
    mapStyle = 'chart',
    locale = 'en',
    // '' = format with the marina's ISO currency via Intl; a non-empty
    // symbol keeps the 0.x `${symbol}${amount}` look for sites that set it.
    currencySymbol = '',
    from: fromAttr = '',
    to: toAttr = '',
    length: lengthAttr = 15,
    berth: berthAttr = '',
    bookPath = '',
    logoMark = null,
    marinaName = '',
    otherMarinas = [],
    mapHeight = '480px',
    showWeather = false,
    eyebrow,
    cardTitle,
    intro,
    rangeLabel,
    rangePlaceholder,
    lengthLabel,
    selectedLabel,
    selectedPlaceholder = 'Tap a buoy',
    ctaLabel,
  }: Props = $props();

  function emit(name: string, detail: unknown, cancelable = false) {
    const ev = new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable });
    $host()?.dispatchEvent(ev);
    return ev;
  }

  let loa = $state(untrack(() => (lengthAttr && lengthAttr > 0 ? lengthAttr : 15)));
  let from = $state<Date | null>(untrack(() => {
    const parsed = parseISODate(fromAttr);
    if (parsed) return parsed;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }));
  let to = $state<Date | null>(untrack(() => {
    const parsed = parseISODate(toAttr);
    if (parsed) return parsed;
    const base = parseISODate(fromAttr) ?? new Date(new Date().setHours(0, 0, 0, 0));
    return new Date(base.getTime() + 86400000);
  }));
  let selectedBerth = $state<string | null>(untrack(() => berthAttr || null));
  let marinaData = $state<MarinaData | null>(null);
  // Set only while the marina has never loaded: the map slot is dropped
  // rather than showing an empty map centred on 0,0.
  let loadFailed = $state(false);
  // OTA's own answer to "what can this boat book for these dates": free,
  // fitting berths with total_price from the same priceStay the booking
  // uses. null = not known (first fetch pending, query invalid, or the
  // fetch failed) - nothing is pickable or priced then.
  let available = $state<AvailableBerth[] | null>(null);

  // Google Maps' Circle overlay reads fillColor/strokeColor as literal
  // paint values (Canvas under the hood) — it can't resolve CSS `var()`
  // syntax the way a real stylesheet property can. Resolve the host's
  // actual computed --brand-navy/--brand-gold once on mount instead of
  // handing BerthMapView the raw var() string.
  let resolvedNavy = $state('#16365b');
  let resolvedGold = $state('#c9a86b');
  onMount(() => {
    const host = $host();
    if (!host) return;
    const cs = getComputedStyle(host);
    resolvedNavy = cs.getPropertyValue('--brand-navy').trim() || resolvedNavy;
    resolvedGold = cs.getPropertyValue('--brand-gold').trim() || resolvedGold;
  });

  // ---- fetch marina data, re-fetch (debounced) on date change ----------
  // apiOrigin/marina are read synchronously so a changed attribute refetches
  // (read inside the timeout they were never tracked).
  $effect(() => {
    const origin = apiOrigin;
    const slug = marina;
    const range = from && to ? { from: localIso(from), to: localIso(to) } : undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      getMarina(origin, slug, range).then(
        (data) => {
          if (cancelled) return;
          marinaData = data;
          loadFailed = false;
        },
        // Caught so a dead api-origin or unknown slug is a console warning,
        // not an unhandled rejection; a failed refetch keeps the last good
        // data on screen.
        (err) => {
          if (cancelled) return;
          loadFailed = !marinaData;
          console.warn('[sidon-berth-map] marina data failed to load', err);
        },
      );
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  });

  const seasonRanges = $derived(marinaData ? seasonRangesFromTiers(marinaData.priceTiers) : []);

  // ---- availability, re-fetched (debounced) on dates / LOA change -------
  // Debounced like the marina fetch so stepping the length doesn't fire a
  // request per click; `cancelled` drops answers for a superseded query.
  $effect(() => {
    const origin = apiOrigin;
    const slug = marina;
    const boatLengthM = loa;
    const arrival = from ? localIso(from) : '';
    const departure = to ? localIso(to) : '';
    // OTA 400s a same-day range or a non-positive length: nothing to ask.
    if (!arrival || departure <= arrival || !(boatLengthM > 0)) {
      available = null;
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      getAvailability(origin, slug, { arrival, departure, boatLengthM }).then(
        (list) => { if (!cancelled) available = list; },
        () => { if (!cancelled) available = null; },
      );
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  });

  // ---- auto-pick: keep the current pick while OTA still offers it, else
  // take the cheapest offered berth. Never emits sidon-berth-selected (only
  // user clicks do), same as 0.x.
  $effect(() => {
    if (!available) return;
    if (selectedBerth && available.some((a) => a.label === selectedBerth)) return;
    selectedBerth = pickCheapest(available);
  });

  function onBerthClick(berthId: string | null) {
    // The map already greys what OTA doesn't offer, but availability lands
    // asynchronously: re-check so a click during a refetch can't select a
    // berth the booking would refuse.
    if (berthId !== null && !available?.some((a) => a.label === berthId)) return;
    selectedBerth = berthId;
    emit('sidon-berth-selected', { berthId });
  }

  // ---- loa-change event (same name/shape as <sidon-booking-widget>) -----
  $effect(() => {
    emit('sidon-loa-change', { loa });
  });

  const selectedBerthLabel = $derived(selectedBerth ?? selectedPlaceholder);

  const lang = $derived(langOf(locale));
  // OTA's total for the selected berth, never client maths, so the card
  // shows exactly what the guest will be charged.
  const totalLabel = $derived.by(() => {
    const total = available?.find((a) => a.label === selectedBerth)?.totalPrice ?? null;
    return total == null ? null : `· ${formatMoney(total, marinaData?.currency ?? null, currencySymbol, lang)}`;
  });

  function handleSubmit() {
    const detail = {
      from: from ? localIso(from) : null,
      to: to ? localIso(to) : null,
      length: loa,
      berth: selectedBerth,
    };
    const ev = emit('sidon-quickbook-submit', detail, true);
    if (!bookPath || ev.defaultPrevented) return;
    // Merge into book-path's own query (keeping its hash) instead of
    // appending '?...': '/book?lang=it' used to become
    // '/book?lang=it?from=...', which corrupts lang and loses `from`.
    const url = new URL(bookPath, window.location.href);
    if (detail.from && detail.to) {
      url.searchParams.set('from', detail.from);
      url.searchParams.set('to', detail.to);
    }
    if (loa) url.searchParams.set('length', String(loa));
    if (selectedBerth) url.searchParams.set('berth', selectedBerth);
    window.location.href = url.href;
  }
</script>

<div class="sbm-root">
  {#if !loadFailed}
    <div class="sbm-map-slot" style="min-height: {mapHeight}">
      <BerthMapView
        {mapsApiKey}
        {mapStyle}
        center={{ lat: marinaData?.profile.lat ?? 0, lng: marinaData?.profile.lng ?? 0 }}
        navy={resolvedNavy}
        gold={resolvedGold}
        {logoMark}
        {marinaName}
        {otherMarinas}
        berths={marinaData?.berths ?? []}
        overlays={marinaData?.overlays ?? []}
        layout={marinaData?.layout ?? null}
        {loa}
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
  {#if showWeather}
    <div class="sbm-weather-slot">
      <WeatherPanel lat={marinaData?.profile.lat ?? 0} lng={marinaData?.profile.lng ?? 0} />
    </div>
  {/if}
</div>

<style>
  /* Grid-stack: map and card share one cell instead of the card being
     position:absolute over a fixed-height root. That way the row grows
     to fit whichever is taller, so a tall card (long title/intro copy)
     pushes the container's height instead of overflowing past it into
     whatever the host page puts after the widget. The map slot stretches
     (align-self default) to fill that row instead of sitting pinned at
     min-height, so a card taller than map-height doesn't leave dead
     whitespace below a short map. */
  .sbm-root {
    display: grid;
    width: 100%;
  }
  .sbm-map-slot {
    grid-area: 1 / 1;
    width: 100%;
    min-height: 480px;
  }
  .sbm-card-slot {
    grid-area: 1 / 1;
    align-self: start;
    justify-self: start;
    z-index: 10;
    width: min(520px, calc(100% - 24px));
    margin: 12px;
  }
  @media (min-width: 768px) {
    .sbm-card-slot {
      margin: 48px 0 0 48px;
    }
  }
  .sbm-weather-slot {
    grid-area: 1 / 1;
    align-self: center;
    justify-self: end;
    z-index: 5;
    margin-right: 24px;
    display: none;
  }
  @media (min-width: 768px) {
    .sbm-weather-slot {
      display: block;
    }
  }
</style>
```

(WeatherPanel already skips `0,0`, so it needs no gating.)

- [ ] **Step 3: `src/components/BerthMapView.svelte`: availability-shaped clicks and paint**

3a. Lines 2-4. Old:
```ts
  import { onMount } from 'svelte';
  import { loadGoogleMaps } from '../lib/google-maps-loader';
  import type { Berth, OverlayRow, OtherMarina } from '../lib/types';
```
New:
```ts
  import { onMount, untrack } from 'svelte';
  import { loadGoogleMaps } from '../lib/google-maps-loader';
  import { fitsBerth } from '../lib/ota';
  import type { Berth, OverlayRow, OtherMarina } from '../lib/types';
```

3b. Lines 35-37. Old:
```ts
  // Buoy-circle state (chart style). Keyed by berthId so reactive effects
  // below can restyle/re-select without re-creating circles.
  const circles = new Map<string, { circle: any; lengthM: number; tooSmall: boolean }>();
```
New:
```ts
  // Buoy-circle state (chart style). Keyed by berthId so reactive effects
  // below can restyle/re-select without re-creating circles. `pickable` =
  // free and fits this LOA by OTA's own rule (fitsBerth) - the same set
  // GET availability returns, so nothing else may look or act clickable.
  type CircleEntry = { circle: any; berth: Berth; pickable: boolean };
  const circles = new Map<string, CircleEntry>();
```

3c. Line 44. Old:
```ts
  const TOO_SMALL = { fillColor: '#b8b8b8', fillOpacity: 0.08, strokeColor: '#b8b8b8', strokeOpacity: 0.5, strokeWeight: 1 };
```
New:
```ts
  const NO_FIT = { fillColor: '#b8b8b8', fillOpacity: 0.08, strokeColor: '#b8b8b8', strokeOpacity: 0.5, strokeWeight: 1 };
  // Same grey as the coastal style's occupied berths, so both styles read
  // "booked" the same way.
  const BOOKED = { fillColor: '#888888', fillOpacity: 0.15, strokeColor: '#888888', strokeOpacity: 0.4, strokeWeight: 1 };
  // One floor/default for creation and the ping, so a pinged sub-5m or
  // unknown-length berth settles back to the radius it was drawn with.
  const radiusOf = (b: Berth) => Math.max(5, b.lengthM || 15);
```

3d. Lines 170-173 (`patchBerths`). Old:
```ts
    const berthMap: Record<string, { price: number | string | null; status: string; rotation: number | null }> = {};
    for (const b of berths) {
      if (b.berthId) berthMap[b.berthId] = { price: b.pricePerNight, status: b.status ?? 'available', rotation: b.rotation };
    }
```
New:
```ts
    const berthMap: Record<string, { price: number | null; status: string; rotation: number | null }> = {};
    for (const b of berths) {
      if (b.berthId) berthMap[b.berthId] = { price: b.pricePerNight, status: b.status, rotation: b.rotation };
    }
```

3e. Lines 180-182. Old:
```ts
        const status = info?.status ?? 'available';
        el.setAttribute('data-status', status);
        const sf = statusStyles[status] ?? statusStyles.available;
```
New:
```ts
        // A label the payload doesn't list (an inactive berth, or an SVG
        // drawn before a re-label) is unavailable: OTA won't book it.
        const status = info?.status ?? 'occupied';
        el.setAttribute('data-status', status);
        const sf = statusStyles[status] ?? statusStyles.occupied;
```

3f. Lines 269-274 (`SvgGroundOverlay` `onAdd`). Old:
```ts
          if (!g || g.getAttribute('data-status') !== 'available') return;
          const id = g.getAttribute('data-berth-id');
          onBerthClick(selectedBerth === id ? null : id);
        });
        this.overlayView.getPanes().overlayMouseTarget.appendChild(this.div);
        paintSvgSelection();
```
New:
```ts
          if (!g || g.getAttribute('data-status') !== 'available' || g.hasAttribute('data-fit')) return;
          const id = g.getAttribute('data-berth-id');
          onBerthClick(selectedBerth === id ? null : id);
        });
        this.overlayView.getPanes().overlayMouseTarget.appendChild(this.div);
        paintSvgState();
```

3g. Lines 299-315. Old:
```ts
  // Stamp data-selected="1" on the SVG berth group matching `selectedBerth`.
  // Reads from this component's own root node (the widget's shadow tree),
  // not `document` — the SVG overlay nodes live inside the shadow DOM.
  function paintSvgSelection() {
    const root = mapEl?.getRootNode() as Document | ShadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-berth-id][data-selected="1"]').forEach((el) => el.removeAttribute('data-selected'));
    if (!selectedBerth) return;
    const el = root.querySelector<HTMLElement>(`[data-berth-id="${CSS.escape(selectedBerth)}"]`);
    el?.setAttribute('data-selected', '1');
  }

  function paint(entry: { circle: any; lengthM: number; tooSmall: boolean }, berthId: string) {
    if (berthId === selectedBerth) entry.circle.setOptions(SELECTED);
    else if (entry.tooSmall) entry.circle.setOptions(TOO_SMALL);
    else entry.circle.setOptions(FIT);
  }
```
New:
```ts
  // Stamp data-selected="1" on the SVG berth group matching `selectedBerth`,
  // and data-fit="small" on listed berths this boat doesn't fit (the
  // injected overlay CSS greys those and turns their pointer events off).
  // Reads from this component's own root node (the widget's shadow tree),
  // not `document` — the SVG overlay nodes live inside the shadow DOM.
  function paintSvgState() {
    const root = mapEl?.getRootNode() as Document | ShadowRoot;
    if (!root) return;
    const byId = new Map(berths.map((b) => [b.berthId, b]));
    root.querySelectorAll('[data-berth-id]').forEach((el) => {
      const id = el.getAttribute('data-berth-id') ?? '';
      const b = byId.get(id);
      if (b && !fitsBerth(b, loa)) el.setAttribute('data-fit', 'small');
      else el.removeAttribute('data-fit');
      if (id === selectedBerth) el.setAttribute('data-selected', '1');
      else el.removeAttribute('data-selected');
    });
  }

  function paint(entry: CircleEntry, berthId: string) {
    const booked = entry.berth.status !== 'available';
    entry.pickable = !booked && fitsBerth(entry.berth, loa);
    const look = berthId === selectedBerth ? SELECTED : booked ? BOOKED : entry.pickable ? FIT : NO_FIT;
    entry.circle.setOptions({ ...look, clickable: entry.pickable });
  }
```

3h. Lines 359-363. Old:
```ts
  // Re-stamp the SVG selection highlight whenever selectedBerth changes.
  $effect(() => {
    selectedBerth;
    paintSvgSelection();
  });
```
New:
```ts
  // Re-stamp SVG selection/fit whenever the selection, LOA or berth data
  // changes. Read up front: with no overlay mounted yet the stamp loop
  // never touches them, and the effect must still track all three.
  $effect(() => {
    selectedBerth; loa; berths;
    paintSvgState();
  });
```

3i. Lines 368-389 (the loop in `buildChartCircles`). Old:
```ts
    for (const b of berths) {
      if (b.lat == null || b.lng == null || !b.berthId) continue;
      const lengthM = Math.max(5, Number(b.lengthM) || 15);
      const circle = new (window as any).google.maps.Circle({
        map, center: { lat: b.lat, lng: b.lng }, radius: lengthM, clickable: true, ...FIT,
      });
      const entry = { circle, lengthM: Number(b.lengthM) || 0, tooSmall: false };
      circles.set(b.berthId, entry);
      // Circles are rebuilt from scratch on every marina-data refresh (date
      // change, initial fetch resolving after first paint, ...), but the
      // auto-pick effect in BerthMap.svelte skips reassigning selectedBerth
      // when the current pick still fits - so its *value* often doesn't
      // change across a refresh, and the reactive re-paint effect below
      // never fires to re-apply SELECTED. Paint each circle correctly at
      // creation time instead of assuming a later effect will catch it.
      entry.tooSmall = loa > 0 && entry.lengthM > 0 && entry.lengthM < loa;
      paint(entry, b.berthId);
      circle.addListener('click', () => onBerthClick(b.berthId === selectedBerth ? null : b.berthId));
      circle.addListener('mouseover', () => { if (!entry.tooSmall && b.berthId !== selectedBerth) circle.setOptions(HOVER); });
      circle.addListener('mouseout', () => { if (b.berthId !== selectedBerth) paint(entry, b.berthId!); });
      bounds.extend({ lat: b.lat, lng: b.lng });
    }
```
New:
```ts
    for (const b of berths) {
      if (b.lat == null || b.lng == null || !b.berthId) continue;
      const circle = new (window as any).google.maps.Circle({
        map, center: { lat: b.lat, lng: b.lng }, radius: radiusOf(b), ...FIT,
      });
      const entry: CircleEntry = { circle, berth: b, pickable: false };
      circles.set(b.berthId, entry);
      // Circles are rebuilt from scratch on every marina-data refresh (date
      // change, initial fetch resolving after first paint, ...), but the
      // auto-pick effect in BerthMap.svelte skips reassigning selectedBerth
      // when the current pick is still offered - so its *value* often doesn't
      // change across a refresh, and the reactive re-paint effect below
      // never fires to re-apply SELECTED. Paint each circle correctly at
      // creation time instead of assuming a later effect will catch it.
      // untrack: paint() reads selectedBerth and loa; tracked here they made
      // this rebuild (and its fitBounds, which throws away the user's zoom)
      // re-run on every click and LOA step. The re-paint effect covers both.
      untrack(() => paint(entry, b.berthId));
      circle.addListener('click', () => onBerthClick(b.berthId === selectedBerth ? null : b.berthId));
      circle.addListener('mouseover', () => { if (entry.pickable && b.berthId !== selectedBerth) circle.setOptions(HOVER); });
      circle.addListener('mouseout', () => { if (b.berthId !== selectedBerth) paint(entry, b.berthId); });
      bounds.extend({ lat: b.lat, lng: b.lng });
    }
```

3j. Lines 451-466. Old:
```ts
  let previousSelectedBerth: string | null = null;
  $effect(() => {
    const newlySelected = selectedBerth != null && selectedBerth !== previousSelectedBerth;
    for (const [berthId, entry] of circles) {
      entry.tooSmall = loa > 0 && entry.lengthM > 0 && entry.lengthM < loa;
      entry.circle.setOptions({ clickable: !entry.tooSmall });
      paint(entry, berthId);
      if (newlySelected && berthId === selectedBerth) {
        // Same floor/default as the circle's radius at creation (line ~343)
        // - entry.lengthM itself isn't floored, so reusing it directly would
        // settle sub-5m berths back to the wrong (too-small) radius.
        pingRadius(entry.circle, Math.max(5, entry.lengthM || 15));
      }
    }
    previousSelectedBerth = selectedBerth;
  });
```
New:
```ts
  let previousSelectedBerth: string | null = null;
  $effect(() => {
    // Read loa up front, not only inside paint(): before the first circles
    // exist the loop never runs, and the effect must still track LOA.
    loa;
    const newlySelected = selectedBerth != null && selectedBerth !== previousSelectedBerth;
    for (const [berthId, entry] of circles) {
      paint(entry, berthId);
      if (newlySelected && berthId === selectedBerth) pingRadius(entry.circle, radiusOf(entry.berth));
    }
    previousSelectedBerth = selectedBerth;
  });
```

- [ ] **Step 4: Green check: leftovers gone, map files type-clean**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget
grep -nE "berth-pricing|sidonmarine\.uk|currencySymbol = '€'|manualSelection" src/BerthMap.svelte; grep -n "?? 'available'\|TOO_SMALL\|paintSvgSelection" src/components/BerthMapView.svelte; grep -rn "berth-pricing" src
```
Expected: no output.

```bash
npm run check
```
Expected: svelte-check fails, but only in the legacy booking files that Task 5 lists as expected to fail until Task 8 (`BookingWidget.svelte` and its step components). Because of the `&&`, `tsc -p tsconfig.node.json` does not run. Check the file set and gate the map files:

```bash
npx svelte-check --tsconfig ./tsconfig.app.json --output machine | grep ' ERROR ' | cut -d'"' -f2 | sort -u
npx svelte-check --tsconfig ./tsconfig.app.json --output machine | grep ' ERROR ' | grep -E 'BerthMap|QuickBookCard|WeatherPanel|date-range|google-maps-loader'
```
Expected:
- The first command lists only Task 5's legacy booking files.
- The second prints nothing.

`npm run build` stays red until Task 8 because of the legacy `BookingWidget.svelte` imports.

- [ ] **Step 5: Smoke-test the berth map alone (local OTA and the Task 2 dev proxy running)**

You can't use `demo/index.html` here. Its `main.ts` also imports `src/custom-element.ts`, and until Task 8 the legacy `BookingWidget.svelte` fails to transform. That breaks the whole module graph, so `<sidon-berth-map>` would never register.

Instead, use a scratch page that loads only the berth-map entry. Do not commit it. Vite's dev root is `demo/`, so the page is served at `/map-only.html`. Vite resolves the inline module's `../src/...` import relative to the HTML file on disk, just as it does for `main.ts`.

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget
cat > demo/map-only.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>sidon-berth-map only (scratch)</title>
  </head>
  <body style="max-width: 900px; margin: 40px auto; font-family: system-ui, sans-serif">
    <sidon-berth-map
      marina="demo-marina"
      maps-api-key="YOUR_DEV_MAPS_KEY"
      map-style="chart"
      locale="en"
      book-path="/book?lang=it"
    ></sidon-berth-map>
    <script type="module">
      // Only the berth-map entry: demo/main.ts also pulls in the booking
      // widget, whose legacy imports break the shared module graph until Task 8.
      import '../src/custom-element-berth-map.ts';
      for (const name of ['sidon-berth-selected', 'sidon-loa-change', 'sidon-quickbook-submit']) {
        document.addEventListener(name, (e) => console.log(name, JSON.stringify(e.detail)));
      }
    </script>
  </body>
</html>
EOF
npm run dev
```

Open `http://localhost:5173/map-only.html` with DevTools open (Console and Network tabs), then check the following:
- **Network:**
  - About 200 ms after load there is one `GET /api/marina/guest/demo-marina?from=…&to=…` and one `GET /api/marina/guest/demo-marina/availability?arrival=…&departure=…&boat_length_m=15`. A second pair appears only if the season gate moves the dates into the next season.
  - Clicking the length `+` three times quickly adds exactly one more availability request, with the final length. It adds no marina request.
- **Card:**
  - The selected label is the berth from the availability response with the cheapest non-null `total_price`.
  - The total equals that berth's `total_price`, formatted in the marina's currency (the page sets no `currency-symbol`).
  - The console shows `sidon-loa-change` but no `sidon-berth-selected` for the auto-pick.
- **Submit detail and cancelable:**
  - In the console, run `document.querySelector('sidon-berth-map').addEventListener('sidon-quickbook-submit', (e) => e.preventDefault(), { once: true })`, then click the CTA.
  - The console logs `sidon-quickbook-submit {"from":"…","to":"…","length":15,"berth":"<label>"}` and the page does not navigate.
- **book-path merge:** click the CTA again. The address bar shows `/book?lang=it&from=…&to=…&length=…&berth=…`, not `?lang=it?from=…`. The page at that URL doesn't matter. Go back to `/map-only.html`.
- **Load failure:**
  - In the console, run `const el = document.createElement('sidon-berth-map'); el.setAttribute('marina', 'no-such-marina'); el.setAttribute('maps-api-key', 'x'); document.body.append(el);`.
  - The second card renders with no map slot.
  - The console shows one `[sidon-berth-map] marina data failed to load` warning and no `Uncaught (in promise)`.
- **Chart style, only when `maps-api-key` in the scratch page is set to a real Maps key:**
  - Berths booked for the dates are grey and ignore clicks.
  - Raising the length above a berth's `length_m` greys that berth, and clicking it logs nothing.
  - Clicking a gold berth logs `sidon-berth-selected {"berthId":"<label>"}` and does not re-fit the map.

Stop the dev server, then remove the scratch page:

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget && rm demo/map-only.html && git status --short demo
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/BerthMap.svelte src/components/BerthMapView.svelte && git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "Berth map on OTA guest data: availability-driven pick and total" -m "Auto-pick and the card total come from GET availability (OTA's fit rule and priceStay); booked, unknown and non-fitting berths are grey and unclickable in both map styles; book-path keeps its own query; api-origin and currency-symbol default to ''; a failed first load drops the map instead of an unhandled rejection. Removes berth-pricing.ts." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Step 2's `git rm` already staged the `berth-pricing.ts` deletion, so the commit includes it.)

---

### Task 7: Booking view (booking-page mode UI)

Repo `W` = `C:/Users/robert/source/repos/sidon-booking-widget`. This task builds the view the guest sees after booking. It has a status hero for hold, pending, confirmed, declined, cancelled and expired; payment resume (R10); a check-your-email panel; booking details; documents (R12); the contract; cancel and start-over; and live updates (R11). Labels come in en/it/fr/es (R13), and every API error is shown (R15). The element is not wired up here; Task 8 does that.

**Files:**
- Create: `W/src/components/BookingView.svelte`
- Create: `W/src/components/DocumentsSection.svelte`
- Create: `W/src/components/ContractSection.svelte`
- Modify: `W/src/lib/i18n.ts`. Line numbers are from 0.4.17; Tasks 2–6 do not touch this file. Every change is an addition:
  - the `./types` type import, above line 4
  - the `BookLabels` type, after line 41
  - the `it`, `en`, `fr` and `es` objects, after lines 80, 117, 154 and 191
  - `getLabels`, after line 198

**Interfaces:**
- Consumes (from Task 5, contract names):
  - `lib/types.ts`: `BookLang`, `BookingSession`, `BookingStatus`, `BookingView`, `DocRequirement`, `GuestBooking`, `GuestContract`, `GuestDocument`, `PaymentSession`.
  - `lib/marina-api.ts`:
    - `MarinaApiError` has a `.status`: `0` means a network failure, and a status under 400 means the body wasn't JSON. In both cases the message is only the English fallback.
    - Functions: `getBooking`, `getDocRequirements`, `confirmPayment`, `cancelBooking`, `uploadDocument`, `agreeContract`, and `getAblyTokenRequest`, which returns `null` on 503.
  - `lib/ota.ts`: `formatMoney`.
  - `lib/upload-prep.ts`: `prepareUpload`. It throws an English `Error`:
    - a PDF over 4 MiB fails on size;
    - an image still over 4 MiB after re-encoding fails with a message containing "too large";
    - any other failure means the type is wrong.
  - `lib/stripe.ts`: `createPaymentSession({ publishableKey, clientSecret, locale, mount, colorPrimary }): Promise<{ confirm(): Promise<void>; destroy(): void }>`.
  - Existing helper: `parseISODate` from `lib/date-range.ts`.
- Produces:
  - `BookingView.svelte` props, exactly as in the contract: `{ apiOrigin: string; slug: string; session: BookingSession; lang: BookLang; currencySymbol: string; variant: 'navy'|'dark'; host: HTMLElement; onstatus: (status: BookingStatus, previous: BookingStatus | null) => void; onstartover?: () => void }`.
    - `onstatus` fires after every successful load whose status differs from the last one seen. On the first load `previous` is `null`. Task 8 emits `sidon-booking-status {bookingId, status}` only when `previous !== null`.
    - `apiOrigin`, `slug` and `session` are read once, on mount. To show a different booking, remount with `{#key session.id}`.
    - Before calling `onstartover`, the view cancels the booking if it is a `hold` (best effort). The caller clears the session.
    - `host` must be the custom element, captured with `$host()` during component init.
    - Stripe mounts into a light-DOM `<div slot="sidon-booking-payment">` on `host`. That node is removed on unmount.
  - `DocumentsSection.svelte` props: `{ apiOrigin, slug, session, lang, booking: GuestBooking, requirements: DocRequirement[], documents: GuestDocument[], onchange: () => void }`. BookingView loads `getDocRequirements` once and passes the result down.
  - `ContractSection.svelte` props, exactly as in the contract: `{ apiOrigin, slug, session, lang, booking: GuestBooking, contract: GuestContract, onchange: () => void }`.
  - `lib/i18n.ts`: `getLabels(lang: BookLang): BookLabels`, plus these booking-view keys:
    - `hero`, `waitingForMarina`, `holdUntil`, `checkEmailTitle`, `checkEmailBody`
    - `loadingBooking`, `bookingNotFound`, `loadFailed`, `retry`
    - `detailsHeading`, `berth`, `dates`, `boat`, `priceOnRequest`
    - `documentsHeading`, `docsAfterSend`, `docState`
    - `uploadTooLarge`, `uploadBadType`, `uploadLimit`, `uploadFailed`, `networkError`
    - `contractHeading`, `agree`, `contractAgreedOn`
    - `cancelBooking`, `cancelConfirm`, `startOver`
  - These existing keys are reused and must survive Task 8's cleanup: `skipperName`, `email`, `total`, `paymentHold`, `paymentNote`, `payAndSend`, `sending`, `upload`, `replace`, `uploading`, `uploadedToday`, `uploadedOn`, `tapToUpload`, `readAgree`, `agreement`.

- [ ] **Step 1: Create `W/src/components/DocumentsSection.svelte`**

```svelte
<script lang="ts">
  import { getLabels } from '../lib/i18n';
  import { MarinaApiError, uploadDocument } from '../lib/marina-api';
  import { prepareUpload } from '../lib/upload-prep';
  import type { BookLang, BookingSession, DocRequirement, GuestBooking, GuestDocument } from '../lib/types';

  interface Props {
    apiOrigin: string;
    slug: string;
    session: BookingSession;
    lang: BookLang;
    booking: GuestBooking;
    requirements: DocRequirement[];
    documents: GuestDocument[];
    onchange: () => void;
  }
  let { apiOrigin, slug, session, lang, booking, requirements, documents, onchange }: Props = $props();

  const labels = $derived(getLabels(lang));
  // OTA takes files only once the request is with the marina (409 while `hold`).
  const open = $derived(booking.status === 'pending' || booking.status === 'confirmed');

  // Upload responses, so a row flips at once rather than after the parent's
  // refetch; the refetched copy (same id) wins as soon as it arrives.
  let uploaded = $state<GuestDocument[]>([]);
  let busy = $state<Record<string, string>>({});
  let error = $state<string | null>(null);
  const all = $derived([...documents, ...uploaded.filter((u) => !documents.some((d) => d.id === u.id))]);

  // The newest file per requirement: a rejected one stays on record after a re-upload.
  function latest(requirementId: string): GuestDocument | null {
    let best: GuestDocument | null = null;
    for (const d of all) {
      if (d.requirementId === requirementId && (!best || Date.parse(d.submittedAt) > Date.parse(best.submittedAt))) best = d;
    }
    return best;
  }

  function when(iso: string): string {
    const d = new Date(iso);
    if (isNaN(+d)) return '';
    const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return labels.uploadedToday(time);
    return labels.uploadedOn(d.toLocaleDateString(lang, { day: 'numeric', month: 'short' }), time);
  }

  // prepareUpload refuses a file on size (a PDF over 4 MiB, or an image still
  // over it after re-encoding) or on type, in English; the guest gets their
  // own language. Its PDF test is mirrored here: a PDF only ever fails on size.
  function prepError(file: File, err: unknown): string {
    const pdf = file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
    return pdf || (err instanceof Error && /too large/i.test(err.message)) ? labels.uploadTooLarge : labels.uploadBadType;
  }

  async function pick(req: DocRequirement, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // picking the same file again must fire `change`
    if (!file) return;
    error = null;
    busy = { ...busy, [req.id]: file.name };
    try {
      const prepared = await prepareUpload(file).catch((err: unknown) => {
        error = prepError(file, err);
        return null;
      });
      if (!prepared) return;
      const doc = await uploadDocument(apiOrigin, slug, session, { ...prepared, requirementId: req.id });
      uploaded = [...uploaded, doc];
      onchange();
    } catch (err) {
      // Status 0 is a network failure and anything under 400 a reply that
      // wasn't JSON (a misrouted forwarder): both carry only an English fallback.
      error =
        !(err instanceof MarinaApiError) || err.status < 400
          ? labels.uploadFailed
          : err.status === 413
            ? labels.uploadTooLarge
            : err.status === 429
              ? labels.uploadLimit
              : err.message;
    } finally {
      const { [req.id]: _done, ...rest } = busy;
      busy = rest;
    }
  }
</script>

<div class="sbw-docs">
  <div class="sbw-docs-heading">{labels.documentsHeading}</div>
  {#if !open}<p class="sbw-docs-note">{labels.docsAfterSend}</p>{/if}
  {#each requirements as req (req.id)}
    {@const doc = latest(req.id)}
    {@const file = busy[req.id]}
    {@const canUpload = open && !file && (!doc || doc.status === 'rejected')}
    <svelte:element
      this={canUpload ? 'label' : 'div'}
      class="sbw-doc-row"
      class:sbw-doc-can={canUpload}
      class:sbw-doc-busy={!!file}
      class:sbw-doc-done={!file && doc?.status === 'verified'}
      class:sbw-doc-pending={!file && doc?.status === 'pending'}
      class:sbw-doc-rejected={!file && doc?.status === 'rejected'}
      class:sbw-doc-locked={!open}
    >
      <div class="sbw-doc-main">
        <div class="sbw-doc-icon" aria-hidden="true">
          {#if file}
            <svg class="sbw-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          {:else if doc?.status === 'verified'}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          {:else if doc?.status === 'pending'}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          {:else}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
          {/if}
        </div>
        <div class="sbw-doc-text">
          <div class="sbw-doc-name">
            {req.name}{#if req.mandatory}<span class="sbw-required"> *</span>{/if}
            {#if doc && !file}<span class="sbw-doc-time">{when(doc.submittedAt)}</span>{/if}
          </div>
          <div class="sbw-doc-sub">
            {file ? `${labels.uploading} ${file}` : doc ? labels.docState[doc.status] : req.description || (open ? labels.tapToUpload : '')}
          </div>
        </div>
      </div>
      {#if canUpload || file}
        <span class="sbw-doc-cta">{file ? labels.uploading : doc ? labels.replace : labels.upload}</span>
      {/if}
      {#if canUpload}
        <input type="file" accept="image/*,application/pdf" class="sbw-visually-hidden" onchange={(e) => pick(req, e)} />
      {/if}
    </svelte:element>
  {/each}
  {#if error}<div class="sbw-docs-error" role="alert">{error}</div>{/if}
</div>

<style>
  /* Row styling carried over from the 0.4 DocumentsStep. */
  .sbw-docs {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 20px 20px;
    color: var(--brand-ink, #252525);
  }
  .sbw-docs-heading {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-docs-note {
    margin: 0;
    font-size: 13px;
    color: #666;
  }
  .sbw-docs-error {
    font-size: 14px;
    color: #cc4949;
  }
  .sbw-doc-row {
    display: flex;
    align-items: stretch;
    border: 1px solid #e4e7ec;
    border-radius: var(--sbw-radius, 10px);
    overflow: hidden;
    background: #fff;
  }
  .sbw-doc-row.sbw-doc-can {
    cursor: pointer;
  }
  /* The file input is visually hidden, so show keyboard focus on the row. */
  .sbw-doc-row:focus-within {
    outline: 2px solid var(--brand-navy, #16365b);
    outline-offset: 2px;
  }
  .sbw-doc-row.sbw-doc-done {
    border-color: var(--brand-navy, #16365b);
    background: var(--brand-navy, #16365b);
    color: #fff;
  }
  .sbw-doc-row.sbw-doc-pending {
    border-color: var(--brand-navy, #16365b);
  }
  .sbw-doc-row.sbw-doc-rejected {
    border-color: #cc4949;
  }
  .sbw-doc-rejected .sbw-doc-sub {
    color: #cc4949;
    opacity: 1;
  }
  .sbw-doc-row.sbw-doc-locked {
    opacity: 0.6;
  }
  .sbw-doc-row.sbw-doc-busy {
    cursor: not-allowed;
  }
  .sbw-doc-main {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    min-width: 0;
    padding: 16px;
  }
  .sbw-doc-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .sbw-doc-busy .sbw-doc-icon,
  .sbw-doc-pending .sbw-doc-icon {
    color: var(--brand-navy, #16365b);
  }
  .sbw-spin {
    animation: sbw-spin 0.8s linear infinite;
  }
  @keyframes sbw-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .sbw-doc-text {
    min-width: 0;
    flex: 1;
  }
  .sbw-doc-name {
    font-size: 16px;
    font-weight: 600;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .sbw-doc-time {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    opacity: 0.8;
  }
  .sbw-doc-sub {
    font-size: 13px;
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sbw-required {
    color: #cc4949;
  }
  .sbw-doc-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 20px;
    border-left: 1px solid #e4e7ec;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--brand-navy, #16365b);
  }
  .sbw-doc-row.sbw-doc-can:hover .sbw-doc-cta {
    background: var(--brand-navy, #16365b);
    color: #fff;
  }
  /* 'dark' variant (Fox/Pevero), set on BookingView's root: flush corners
     and a solid-ink CTA/verified fill instead of navy. */
  :global(.sbw-variant-dark) .sbw-doc-row {
    border-radius: 0;
  }
  :global(.sbw-variant-dark) .sbw-doc-row.sbw-doc-done {
    border-color: var(--brand-ink, #252525);
    background: var(--brand-ink, #252525);
  }
  :global(.sbw-variant-dark) .sbw-doc-row.sbw-doc-can .sbw-doc-cta {
    background: var(--brand-ink, #252525);
    color: #fff;
  }
  :global(.sbw-variant-dark) .sbw-doc-row.sbw-doc-can:hover .sbw-doc-cta {
    background: var(--brand-gold, #c9a86b);
    color: var(--brand-ink, #252525);
  }
  .sbw-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
```

- [ ] **Step 2: Create `W/src/components/ContractSection.svelte`**

```svelte
<script lang="ts">
  import { getLabels } from '../lib/i18n';
  import { MarinaApiError, agreeContract } from '../lib/marina-api';
  import type { BookLang, BookingSession, GuestBooking, GuestContract } from '../lib/types';

  interface Props {
    apiOrigin: string;
    slug: string;
    session: BookingSession;
    lang: BookLang;
    booking: GuestBooking;
    contract: GuestContract;
    onchange: () => void;
  }
  let { apiOrigin, slug, session, lang, booking, contract, onchange }: Props = $props();

  const labels = $derived(getLabels(lang));
  let checked = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  // The agree response, so the form closes at once rather than after the parent's refetch.
  let agreedNow = $state<string | null>(null);
  const agreedAt = $derived(contract.agreedAt ?? agreedNow);
  // OTA accepts agreement only while the request is with the marina.
  const canAgree = $derived(!agreedAt && (booking.status === 'pending' || booking.status === 'confirmed'));

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });

  async function agree() {
    if (!checked || saving) return;
    saving = true;
    error = null;
    try {
      agreedNow = (await agreeContract(apiOrigin, slug, session)).agreedAt;
    } catch (err) {
      // 409: agreed in another tab, or the status moved on; the refetch shows which.
      // Under 400 (0 = network) there is no OTA message, only an English fallback.
      if (!(err instanceof MarinaApiError)) error = err instanceof Error ? err.message : String(err);
      else if (err.status < 400) error = labels.networkError;
      else if (err.status !== 409) error = err.message;
    } finally {
      saving = false;
      onchange();
    }
  }
</script>

<div class="sbw-contract">
  <div class="sbw-contract-heading">{labels.contractHeading}</div>
  <!-- Text, never {@html}: the body is a template filled with guest input. pre-wrap keeps its line breaks. -->
  <div class="sbw-contract-body">{contract.renderedBody}</div>
  {#if agreedAt}
    <p class="sbw-contract-agreed">{labels.contractAgreedOn(fmtDate(agreedAt))}</p>
  {:else if canAgree}
    <label class="sbw-agree-row">
      <input type="checkbox" bind:checked />
      <span>{labels.readAgree} <strong>{labels.agreement}</strong>.</span>
    </label>
    <button type="button" class="sbw-btn-primary" onclick={agree} disabled={!checked || saving}>
      {saving ? labels.sending : labels.agree}
    </button>
  {/if}
  {#if error}<div class="sbw-contract-error" role="alert">{error}</div>{/if}
</div>

<style>
  /* Carried over from the 0.4 DetailsStep contract block. */
  .sbw-contract {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 20px 20px;
  }
  .sbw-contract-heading {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-contract-body {
    max-height: 280px;
    overflow-y: auto;
    padding: 16px;
    border-radius: 14px;
    border: 1px solid rgba(37, 37, 37, 0.08);
    background: #fafafa;
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
    color: var(--brand-navy, #16365b);
  }
  .sbw-agree-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--brand-navy, #16365b);
    cursor: pointer;
  }
  .sbw-contract-agreed {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #1f9d55;
  }
  .sbw-contract-error {
    font-size: 14px;
    color: #cc4949;
  }
</style>
```

- [ ] **Step 3: Create `W/src/components/BookingView.svelte`**

The light-DOM Stripe mount copies `BookingWidget.svelte:428-487` from 0.4.17. A native `<slot>` is created with DOM APIs inside a shadow anchor, and the mount node is appended to `host`. The slot has its own name, so the wizard's leftover `slot="payment"` node can never be projected here.

```svelte
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import DocumentsSection from './DocumentsSection.svelte';
  import ContractSection from './ContractSection.svelte';
  import { getLabels } from '../lib/i18n';
  import { formatMoney } from '../lib/ota';
  import { parseISODate } from '../lib/date-range';
  import { createPaymentSession } from '../lib/stripe';
  import {
    MarinaApiError,
    getBooking,
    getDocRequirements,
    confirmPayment,
    cancelBooking,
    getAblyTokenRequest,
  } from '../lib/marina-api';
  import type {
    BookLang,
    BookingSession,
    BookingStatus,
    BookingView as View,
    DocRequirement,
    PaymentSession,
  } from '../lib/types';

  interface Props {
    apiOrigin: string;
    slug: string;
    session: BookingSession;
    lang: BookLang;
    currencySymbol: string;
    variant: 'navy' | 'dark';
    /** The custom element itself. Stripe can't mount inside the shadow root,
        so the card form goes into a light-DOM child of this node. */
    host: HTMLElement;
    /** Every observed status change; `previous` is null on the first load. */
    onstatus: (status: BookingStatus, previous: BookingStatus | null) => void;
    /** Shown as "Start a new booking" when set. A `hold` is cancelled first. */
    onstartover?: () => void;
  }
  let { apiOrigin, slug, session, lang, currencySymbol, variant, host, onstatus, onstartover }: Props = $props();

  // Not 'payment': the wizard's payment node may still sit in the host's
  // light DOM, and a shared slot name would project both card forms here.
  const SLOT = 'sidon-booking-payment';
  const POLL_MS = 30_000;

  const labels = $derived(getLabels(lang));

  let view = $state<View | null>(null);
  let requirements = $state<DocRequirement[]>([]);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let busy = $state(false);
  // confirm-payment answered 410: the hold lapsed before the card was
  // authorised. OTA keeps the row as `hold` until its sweep releases it,
  // so the expired state is tracked here until a refetch shows `expired`.
  let lapsed = $state(false);
  let showCard = $state(false);
  let cardReady = $state(false);
  let slotAnchor = $state<HTMLElement | null>(null);

  // Plain handles, never read by the template.
  let card: { confirm(): Promise<void>; destroy(): void } | null = null;
  let cardEl: HTMLElement | null = null;
  let lastStatus: BookingStatus | null = null;
  let resumed = false;
  let requirementsAsked = false;
  let loadSeq = 0;
  let destroyed = false;
  let realtime: { close(): void } | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // Under 400 (0 = network) a MarinaApiError has no OTA message, only an
  // English fallback; Stripe's own errors arrive already localised.
  const errorText = (err: unknown) =>
    err instanceof MarinaApiError && err.status < 400 ? labels.networkError : err instanceof Error ? err.message : String(err);
  const fmtDate = (ymd: string | null) =>
    parseISODate(ymd)?.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' }) ?? '';
  const fmtTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : '';

  async function load() {
    const seq = ++loadSeq;
    if (!requirementsAsked) {
      requirementsAsked = true;
      getDocRequirements(apiOrigin, slug).then(
        (r) => (requirements = r),
        () => (requirementsAsked = false), // retried on the next load; the booking still shows
      );
    }
    try {
      const next = await getBooking(apiOrigin, slug, session);
      // Ably, polling, visibility and own actions can overlap: only the newest load lands.
      if (destroyed || seq !== loadSeq) return;
      view = next;
      loadError = null;
      const status = next.booking.status;
      if (status !== lastStatus) {
        const previous = lastStatus;
        lastStatus = status;
        onstatus(status, previous);
      }
      if (status !== 'hold') dropCard();
      else if (next.payment && !resumed) {
        resumed = true;
        void resume(next.payment);
      }
    } catch (err) {
      // A failed refetch keeps the last good view; the next one retries.
      if (destroyed || seq !== loadSeq || view) return;
      loadError = err instanceof MarinaApiError && err.status === 404 ? labels.bookingNotFound : labels.loadFailed;
    }
  }

  // Payment resume asks OTA first. A guest who closed the tab after Stripe
  // authorised the card (but before confirm-payment ran) has a
  // `requires_capture` PaymentIntent, which the Payment Element can't mount
  // on; confirm-payment promotes that booking to `pending` instead.
  async function resume(payment: PaymentSession) {
    try {
      await confirmPayment(apiOrigin, slug, session);
      await load();
    } catch (err) {
      if (err instanceof MarinaApiError && err.status === 410) lapsed = true;
      // 409 "not authorised yet" is the normal case. Any other failure also
      // gets the card form: pay() asks confirm-payment again anyway.
      else await mountCard(payment);
    }
  }

  async function mountCard(payment: PaymentSession) {
    if (cardEl) return;
    showCard = true;
    await tick(); // the panel, and its slot anchor, render first
    if (destroyed || !slotAnchor) return;
    // Stripe.js has no Shadow DOM support (see lib/stripe.ts): the mount
    // node is a light-DOM child of the host, projected here by a native
    // <slot> created with DOM APIs (a literal <slot> in this template would
    // be taken by Svelte's own slot mechanism instead).
    const slotEl = document.createElement('slot');
    slotEl.name = SLOT;
    slotAnchor.appendChild(slotEl);
    const el = document.createElement('div');
    el.slot = SLOT;
    host.appendChild(el);
    cardEl = el;
    try {
      const stripe = await createPaymentSession({
        publishableKey: payment.publishableKey,
        clientSecret: payment.clientSecret,
        locale: lang,
        mount: el,
        // Stripe's iframe can't resolve var(); hand it the computed colour.
        colorPrimary: getComputedStyle(host).getPropertyValue('--brand-navy').trim() || '#16365b',
      });
      if (cardEl !== el) return stripe.destroy(); // dropped while Stripe loaded
      card = stripe;
      cardReady = true;
    } catch (err) {
      actionError = errorText(err);
    }
  }

  function dropCard() {
    card?.destroy();
    card = null;
    cardEl?.remove();
    cardEl = null;
    showCard = false;
    cardReady = false;
  }

  async function pay() {
    if (!card || busy) return;
    busy = true;
    actionError = null;
    let cardError: unknown = null;
    try {
      await card.confirm();
    } catch (err) {
      cardError = err;
    }
    try {
      // Asked even after a Stripe error: on a retry the card may already be
      // authorised (Stripe then rejects a second confirm), and OTA's check of
      // the PaymentIntent is what counts.
      await confirmPayment(apiOrigin, slug, session);
      dropCard();
    } catch (err) {
      if (err instanceof MarinaApiError && err.status === 410) {
        lapsed = true;
        dropCard();
      } else actionError = errorText(cardError ?? err);
    } finally {
      busy = false;
    }
    await load();
  }

  async function cancel() {
    if (busy || !window.confirm(labels.cancelConfirm)) return;
    busy = true;
    actionError = null;
    try {
      await cancelBooking(apiOrigin, slug, session);
      dropCard();
    } catch (err) {
      actionError = errorText(err);
    } finally {
      busy = false;
    }
    await load();
  }

  async function startOver() {
    if (busy) return;
    busy = true;
    // A hold blocks the berth and counts toward OTA's per-email cap until it
    // lapses. Best effort: the sweep releases it within 30 minutes anyway.
    if (view?.booking.status === 'hold') await cancelBooking(apiOrigin, slug, session).catch(() => {});
    dropCard();
    busy = false;
    onstartover?.();
  }

  // Live updates: Ably's `updated` event only says "something changed", so
  // every message refetches the booking.
  async function startLive() {
    try {
      const Ably = (await import('ably')).default;
      if (destroyed) return;
      const rt = new Ably.Realtime({
        // A fresh TokenRequest on every (re)auth: a replayed one fails at renewal.
        authCallback: (_params, cb) => {
          getAblyTokenRequest(apiOrigin, slug, session).then(
            (tokenRequest) => {
              if (tokenRequest) return cb(null, tokenRequest);
              cb('Live updates are not configured', null);
              startPolling(); // 503: this OTA has no Ably key
            },
            (err) => cb(errorText(err), null),
          );
        },
      });
      realtime = rt;
      rt.connection.on(['failed', 'suspended'], () => startPolling());
      rt.channels
        .get(`marina-booking:${session.id}`)
        .subscribe('updated', () => void load())
        .catch(() => startPolling());
    } catch {
      startPolling();
    }
  }

  function startPolling() {
    realtime?.close();
    realtime = null;
    if (destroyed || pollTimer) return;
    pollTimer = setInterval(() => {
      const status = view?.booking.status;
      // Never while `hold`: that GET retrieves the PaymentIntent from Stripe.
      // Declined/cancelled are final, so they're skipped too.
      if (!document.hidden && (status === 'pending' || status === 'confirmed')) void load();
    }, POLL_MS);
  }

  onMount(() => {
    void load();
    void startLive();
    // Staff document decisions publish nothing to the guest, so coming back
    // to the tab is the cue to look again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(pollTimer);
      realtime?.close();
      dropCard();
    };
  });
</script>

<div class="sbw-view" class:sbw-variant-dark={variant === 'dark'}>
  {#if !view}
    {#if loadError}
      <div class="sbw-view-error sbw-view-error-first" role="alert">{loadError}</div>
      <div class="sbw-view-actions">
        <button type="button" class="sbw-btn-secondary" onclick={() => load()}>{labels.retry}</button>
        {#if onstartover}
          <button type="button" class="sbw-btn-secondary" onclick={startOver} disabled={busy}>{labels.startOver}</button>
        {/if}
      </div>
    {:else}
      <div class="sbw-view-loading">{labels.loadingBooking}</div>
    {/if}
  {:else}
    {@const b = view.booking}
    {@const h = b.expired || lapsed ? 'expired' : b.status}
    <div
      class="sbw-hero"
      class:sbw-hero-ok={h === 'confirmed'}
      class:sbw-hero-bad={h === 'declined' || h === 'cancelled' || h === 'expired'}
      role="status"
    >
      <div class="sbw-hero-icon" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          {#if h === 'hold'}
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          {:else if h === 'pending' || h === 'confirmed'}
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          {:else}
            <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
          {/if}
        </svg>
      </div>
      <div class="sbw-hero-eyebrow">{labels.hero[h].eyebrow}</div>
      <h3 class="sbw-hero-title">{labels.hero[h].title}</h3>
      <p class="sbw-hero-body">{labels.hero[h].body}</p>
      {#if h === 'pending'}
        <p class="sbw-hero-live"><span class="sbw-live-dot"></span>{labels.waitingForMarina}</p>
      {/if}
    </div>

    {#if h === 'hold' && showCard}
      <div class="sbw-panel">
        <div class="sbw-panel-heading">
          <span>{labels.paymentHold}</span>
          <span class="sbw-panel-amount">{labels.total} {formatMoney(b.totalPrice, b.currency, currencySymbol, lang)}</span>
        </div>
        <p class="sbw-panel-note">{labels.paymentNote}</p>
        <p class="sbw-panel-note">{labels.holdUntil(fmtTime(b.holdExpiresAt))}</p>
        <div class="sbw-card" bind:this={slotAnchor}></div>
        <button type="button" class="sbw-btn-primary" onclick={pay} disabled={busy || !cardReady}>
          {busy ? labels.sending : labels.payAndSend}
        </button>
      </div>
    {:else if h === 'hold' && !view.payment}
      <div class="sbw-panel">
        <div class="sbw-panel-heading"><span>{labels.checkEmailTitle}</span></div>
        <p class="sbw-panel-note">{labels.checkEmailBody(fmtTime(b.holdExpiresAt))}</p>
      </div>
    {/if}

    <div class="sbw-facts-heading">{labels.detailsHeading}</div>
    <dl class="sbw-facts">
      <div><dt>{labels.berth}</dt><dd>{b.berthLabel} · {b.marinaName}</dd></div>
      <div><dt>{labels.dates}</dt><dd>{fmtDate(b.arrival)} – {fmtDate(b.departure)}</dd></div>
      <div>
        <dt>{labels.boat}</dt>
        <dd>{[b.boatName, b.boatLengthM != null ? `${b.boatLengthM} m` : null].filter(Boolean).join(' · ')}</dd>
      </div>
      <div><dt>{labels.skipperName}</dt><dd>{b.contactName}</dd></div>
      {#if b.contactEmail}<div><dt>{labels.email}</dt><dd>{b.contactEmail}</dd></div>{/if}
      <div>
        <dt>{labels.total}</dt>
        <dd>{b.totalPrice == null ? labels.priceOnRequest : formatMoney(b.totalPrice, b.currency, currencySymbol, lang)}</dd>
      </div>
    </dl>

    {#if requirements.length && (h === 'hold' || h === 'pending' || h === 'confirmed')}
      <DocumentsSection {apiOrigin} {slug} {session} {lang} booking={b} {requirements} documents={view.documents} onchange={load} />
    {/if}
    {#if view.contract && (h === 'pending' || h === 'confirmed')}
      <ContractSection {apiOrigin} {slug} {session} {lang} booking={b} contract={view.contract} onchange={load} />
    {/if}

    {#if actionError}<div class="sbw-view-error" role="alert">{actionError}</div>{/if}
    {#if h === 'hold' || h === 'pending' || onstartover}
      <div class="sbw-view-actions">
        {#if h === 'hold' || h === 'pending'}
          <button type="button" class="sbw-btn-secondary" onclick={cancel} disabled={busy}>{labels.cancelBooking}</button>
        {/if}
        {#if onstartover}
          <button type="button" class="sbw-btn-secondary" onclick={startOver} disabled={busy}>{labels.startOver}</button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .sbw-view {
    display: flex;
    flex-direction: column;
    color: var(--brand-ink, #252525);
  }
  .sbw-view-loading {
    padding: 32px 20px;
    font-size: 14px;
    text-align: center;
    color: #666;
  }
  .sbw-view-error {
    margin: 0 20px 16px;
    font-size: 14px;
    color: #cc4949;
  }
  .sbw-view-error-first {
    margin-top: 24px;
  }
  /* Hero: the 0.4 SentStep panel, one state per OTA status (+ expired). */
  .sbw-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
    padding: 32px 20px;
  }
  .sbw-hero-icon {
    width: 56px;
    height: 56px;
    border-radius: 999px;
    background: var(--brand-gold, #c9a86b);
    color: var(--brand-navy, #16365b);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sbw-hero-ok .sbw-hero-icon {
    background: #1f9d55;
    color: #fff;
  }
  .sbw-hero-bad .sbw-hero-icon {
    background: #cc4949;
    color: #fff;
  }
  .sbw-hero-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: var(--brand-gold, #c9a86b);
  }
  .sbw-hero-ok .sbw-hero-eyebrow {
    color: #1f9d55;
  }
  .sbw-hero-bad .sbw-hero-eyebrow {
    color: #cc4949;
  }
  .sbw-hero-title {
    font-size: 32px;
    font-weight: 400;
    text-transform: uppercase;
    color: var(--brand-navy, #16365b);
    margin: 0;
  }
  .sbw-hero-body {
    font-size: 14px;
    color: #252525;
    max-width: 420px;
    line-height: 1.7;
    margin: 0;
  }
  .sbw-hero-live {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12px;
    color: #666;
  }
  .sbw-live-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--brand-gold, #c9a86b);
    animation: sbw-pulse 1.6s ease-in-out infinite;
  }
  @keyframes sbw-pulse {
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sbw-live-dot {
      animation: none;
    }
  }
  .sbw-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0 20px 20px;
    padding: 16px;
    border: 1px solid #e4e7ec;
    border-radius: var(--sbw-radius, 10px);
  }
  .sbw-panel-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-panel-amount {
    font-size: 22px;
    font-weight: 500;
    color: var(--brand-navy, #16365b);
  }
  .sbw-panel-note {
    font-size: 12px;
    color: #252525;
    line-height: 1.6;
    margin: 0;
  }
  .sbw-card {
    padding: 14px;
    border-radius: 12px;
    border: 1px solid #e4e7ec;
    background: #fff;
  }
  .sbw-facts-heading {
    padding: 0 20px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    margin: 10px 0 0;
    padding: 0 20px 20px;
  }
  .sbw-facts dt {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #666;
  }
  .sbw-facts dd {
    margin: 2px 0 0;
    font-size: 15px;
    color: var(--brand-navy, #16365b);
    overflow-wrap: anywhere;
  }
  .sbw-view-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 0 20px 20px;
  }
  /* Buttons mirror StepNav's Back/Next. The primary one is :global so
     ContractSection's Agree button picks up the same variant styling. */
  .sbw-btn-secondary {
    height: 52px;
    padding: 0 24px;
    border-radius: var(--sbw-radius, 10px);
    border: 1px solid rgba(37, 37, 37, 0.15);
    background: transparent;
    color: var(--brand-navy, #16365b);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .sbw-btn-secondary:hover:not(:disabled) {
    background: #fafafa;
  }
  .sbw-view :global(.sbw-btn-primary) {
    height: 56px;
    border-radius: var(--sbw-radius, 10px);
    border: none;
    background: var(--brand-gold, #c9a86b);
    color: var(--brand-navy, #16365b);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .sbw-view :global(.sbw-btn-primary:hover:not(:disabled)) {
    background: var(--brand-navy, #16365b);
    color: #fff;
  }
  .sbw-btn-secondary:disabled,
  .sbw-view :global(.sbw-btn-primary:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* 'dark' variant (Fox/Pevero): flush corners, solid ink, gold on hover. */
  .sbw-variant-dark .sbw-btn-secondary {
    border-radius: 0;
    color: var(--brand-ink, #252525);
  }
  .sbw-view.sbw-variant-dark :global(.sbw-btn-primary) {
    border-radius: 0;
    background: var(--brand-ink, #252525);
    color: #fff;
  }
  .sbw-view.sbw-variant-dark :global(.sbw-btn-primary:hover:not(:disabled)) {
    background: var(--brand-gold, #c9a86b);
    color: var(--brand-ink, #252525);
  }
</style>
```

- [ ] **Step 4: Run the type check and watch it fail on the missing `getLabels`**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget
npx svelte-check --tsconfig ./tsconfig.app.json --output machine | grep -E "ERROR .*(BookingView|DocumentsSection|ContractSection)"
```

Expected: exactly three lines, one per new file. The leading timestamps will differ.

```
… ERROR "src\\components\\DocumentsSection.svelte" 2:12 "Module '\"../lib/i18n\"' has no exported member 'getLabels'."
… ERROR "src\\components\\ContractSection.svelte" 2:12 "Module '\"../lib/i18n\"' has no exported member 'getLabels'."
… ERROR "src\\components\\BookingView.svelte" 5:12 "Module '\"../lib/i18n\"' has no exported member 'getLabels'."
```

- [ ] **Step 5: Extend `W/src/lib/i18n.ts`**

5a. Replace:

```ts
export type BookLocale = 'it' | 'en' | 'fr' | 'es';
```
with:
```ts
import type { BookLang, BookingStatus, GuestDocument } from './types';

export type BookLocale = 'it' | 'en' | 'fr' | 'es';
```

5b. In `BookLabels`, replace:

```ts
  bookingCancelledBody: string;
};
```
with:
```ts
  bookingCancelledBody: string;
  // ---- booking view (BookingView, DocumentsSection, ContractSection) ----
  /** One hero per OTA status, plus `expired` (a hold that lapsed unpaid). */
  hero: Record<BookingStatus | 'expired', { eyebrow: string; title: string; body: string }>;
  waitingForMarina: string;
  holdUntil: (time: string) => string;
  checkEmailTitle: string;
  checkEmailBody: (time: string) => string;
  loadingBooking: string;
  bookingNotFound: string;
  loadFailed: string;
  retry: string;
  detailsHeading: string;
  berth: string;
  dates: string;
  boat: string;
  priceOnRequest: string;
  documentsHeading: string;
  docsAfterSend: string;
  docState: Record<GuestDocument['status'], string>;
  uploadTooLarge: string;
  uploadBadType: string;
  uploadLimit: string;
  uploadFailed: string;
  /** A MarinaApiError with no OTA message (status 0 = network, or a non-JSON reply). */
  networkError: string;
  contractHeading: string;
  agree: string;
  contractAgreedOn: (date: string) => string;
  cancelBooking: string;
  cancelConfirm: string;
  startOver: string;
};
```

5c. In `it`, replace:

```ts
    bookingCancelledBody: 'Il porto non ha potuto accogliere la tua barca per quelle date. Prova date diverse o contattali direttamente.',
```
with:
```ts
    bookingCancelledBody: 'Il porto non ha potuto accogliere la tua barca per quelle date. Prova date diverse o contattali direttamente.',
    hero: {
      hold: {
        eyebrow: 'Quasi fatto',
        title: 'Completa la prenotazione',
        body: 'Il tuo ormeggio è riservato mentre completi la prenotazione. Alla marina non è ancora stato inviato nulla.',
      },
      pending: {
        eyebrow: 'Richiesta ricevuta',
        title: 'In mano al porto',
        body: 'Abbiamo inviato la tua richiesta alla marina. Ti risponderanno via email a breve.',
      },
      confirmed: {
        eyebrow: 'Prenotazione confermata',
        title: 'Sei dentro',
        body: 'Il porto ha confermato il tuo ormeggio. Ti abbiamo inviato i dettagli via email.',
      },
      declined: {
        eyebrow: 'Prenotazione rifiutata',
        title: 'Nessun posto stavolta',
        body: 'Il porto non ha potuto accogliere la tua barca per quelle date. Prova date diverse o contattali direttamente.',
      },
      cancelled: {
        eyebrow: 'Prenotazione annullata',
        title: 'Annullata',
        body: 'Questa prenotazione è stata annullata. Per qualsiasi domanda contatta la marina.',
      },
      expired: {
        eyebrow: 'Riserva scaduta',
        title: 'Tempo scaduto',
        body: "La prenotazione non è stata completata in tempo, quindi l'ormeggio è stato rilasciato. Puoi prenotare di nuovo.",
      },
    },
    waitingForMarina: 'In attesa della marina · questa pagina si aggiorna da sola',
    holdUntil: (time) => `Riservato per te fino alle ${time}`,
    checkEmailTitle: 'Controlla la tua email',
    checkEmailBody: (time) =>
      `Ti abbiamo inviato un link per confermare la prenotazione. Aprilo entro le ${time}, altrimenti l'ormeggio verrà rilasciato.`,
    loadingBooking: 'Caricamento della prenotazione…',
    bookingNotFound: 'Non troviamo questa prenotazione. Usa il link ricevuto via email.',
    loadFailed: 'Impossibile caricare la prenotazione. Controlla la connessione e riprova.',
    retry: 'Riprova',
    detailsHeading: 'La tua prenotazione',
    berth: 'Ormeggio',
    dates: 'Date',
    boat: 'Barca',
    priceOnRequest: 'Prezzo su richiesta',
    documentsHeading: 'Documenti',
    docsAfterSend: 'Potrai caricare i documenti dopo che la richiesta sarà stata inviata alla marina.',
    docState: { pending: 'Ricevuto · in verifica', verified: 'Verificato', rejected: 'Non accettato · caricalo di nuovo' },
    uploadTooLarge: 'Il file supera i 4 MB. Carica un PDF più piccolo oppure una foto.',
    uploadBadType: 'Carica un file PDF, JPEG o PNG.',
    uploadLimit: 'Troppi caricamenti. Attendi qualche minuto e riprova.',
    uploadFailed: 'Caricamento non riuscito. Riprova.',
    networkError: 'Impossibile contattare il servizio di prenotazione. Controlla la connessione e riprova.',
    contractHeading: 'Contratto di ormeggio',
    agree: 'Accetto',
    contractAgreedOn: (date) => `Accettato il ${date}`,
    cancelBooking: 'Annulla prenotazione',
    cancelConfirm: "Vuoi annullare questa prenotazione? L'ormeggio verrà rilasciato.",
    startOver: 'Nuova prenotazione',
```

5d. In `en`, replace:

```ts
    bookingCancelledBody: "The harbour couldn't take your boat on those dates. Please try different dates or reach out directly.",
```
with:
```ts
    bookingCancelledBody: "The harbour couldn't take your boat on those dates. Please try different dates or reach out directly.",
    hero: {
      hold: {
        eyebrow: 'Almost done',
        title: 'Finish your booking',
        body: 'Your berth is held while you finish. Nothing has been sent to the marina yet.',
      },
      pending: {
        eyebrow: 'Request received',
        title: "On the harbour's desk",
        body: "We've sent your request to the marina. You'll hear back by email shortly.",
      },
      confirmed: {
        eyebrow: 'Booking confirmed',
        title: "You're in",
        body: "The harbour has confirmed your mooring. We've emailed you the details.",
      },
      declined: {
        eyebrow: 'Booking declined',
        title: 'No space this time',
        body: "The harbour couldn't take your boat on those dates. Please try different dates or reach out directly.",
      },
      cancelled: {
        eyebrow: 'Booking cancelled',
        title: 'Cancelled',
        body: 'This booking has been cancelled. Contact the marina if you have any questions.',
      },
      expired: {
        eyebrow: 'Hold expired',
        title: 'Time ran out',
        body: "The booking wasn't completed in time, so the berth was released. You're welcome to book again.",
      },
    },
    waitingForMarina: 'Waiting for the marina · this page updates by itself',
    holdUntil: (time) => `Held for you until ${time}`,
    checkEmailTitle: 'Check your email',
    checkEmailBody: (time) =>
      `We've emailed you a link to confirm this booking. Open it before ${time}, or the berth is released.`,
    loadingBooking: 'Loading your booking…',
    bookingNotFound: "We couldn't find this booking. Please use the link in your email.",
    loadFailed: "We couldn't load your booking. Check your connection and try again.",
    retry: 'Try again',
    detailsHeading: 'Your booking',
    berth: 'Berth',
    dates: 'Dates',
    boat: 'Boat',
    priceOnRequest: 'Price on request',
    documentsHeading: 'Documents',
    docsAfterSend: 'You can upload documents once your request has been sent to the marina.',
    docState: { pending: 'Received · awaiting review', verified: 'Verified', rejected: 'Not accepted · please upload again' },
    uploadTooLarge: 'That file is over 4 MB. Please upload a smaller PDF, or a photo instead.',
    uploadBadType: 'Please upload a PDF, JPEG or PNG.',
    uploadLimit: 'Too many uploads. Please wait a few minutes and try again.',
    uploadFailed: 'Upload failed. Please try again.',
    networkError: "Couldn't reach the booking service. Check your connection and try again.",
    contractHeading: 'Berth agreement',
    agree: 'Agree',
    contractAgreedOn: (date) => `Agreed on ${date}`,
    cancelBooking: 'Cancel booking',
    cancelConfirm: 'Cancel this booking? The berth will be released.',
    startOver: 'Start a new booking',
```

5e. In `fr`, replace:

```ts
    bookingCancelledBody: "La capitainerie n'a pas pu vous accueillir à ces dates. Essayez d'autres dates ou contactez-les directement.",
```
with:
```ts
    bookingCancelledBody: "La capitainerie n'a pas pu vous accueillir à ces dates. Essayez d'autres dates ou contactez-les directement.",
    hero: {
      hold: {
        eyebrow: 'Presque fini',
        title: 'Finalisez votre réservation',
        body: "Votre place est réservée le temps de finaliser. Rien n'a encore été envoyé à la marina.",
      },
      pending: {
        eyebrow: 'Demande reçue',
        title: 'Sur le bureau du capitaine',
        body: 'Nous avons envoyé votre demande à la marina. Vous recevrez une réponse par email sous peu.',
      },
      confirmed: {
        eyebrow: 'Réservation confirmée',
        title: "C'est validé",
        body: "La capitainerie a confirmé votre poste d'amarrage. Les détails sont dans votre email.",
      },
      declined: {
        eyebrow: 'Réservation refusée',
        title: 'Pas de place cette fois',
        body: "La capitainerie n'a pas pu vous accueillir à ces dates. Essayez d'autres dates ou contactez-les directement.",
      },
      cancelled: {
        eyebrow: 'Réservation annulée',
        title: 'Annulée',
        body: 'Cette réservation a été annulée. Contactez la marina pour toute question.',
      },
      expired: {
        eyebrow: 'Délai dépassé',
        title: 'Temps écoulé',
        body: "La réservation n'a pas été finalisée à temps, la place a donc été libérée. Vous pouvez réserver à nouveau.",
      },
    },
    waitingForMarina: 'En attente de la marina · cette page se met à jour toute seule',
    holdUntil: (time) => `Réservé pour vous jusqu'à ${time}`,
    checkEmailTitle: 'Vérifiez vos emails',
    checkEmailBody: (time) =>
      `Nous vous avons envoyé un lien pour confirmer cette réservation. Ouvrez-le avant ${time}, sinon la place sera libérée.`,
    loadingBooking: 'Chargement de votre réservation…',
    bookingNotFound: 'Réservation introuvable. Utilisez le lien reçu par email.',
    loadFailed: 'Impossible de charger votre réservation. Vérifiez votre connexion et réessayez.',
    retry: 'Réessayer',
    detailsHeading: 'Votre réservation',
    berth: 'Poste',
    dates: 'Dates',
    boat: 'Bateau',
    priceOnRequest: 'Prix sur demande',
    documentsHeading: 'Documents',
    docsAfterSend: 'Vous pourrez envoyer vos documents une fois la demande transmise à la marina.',
    docState: { pending: 'Reçu · en cours de vérification', verified: 'Vérifié', rejected: 'Refusé · merci de le renvoyer' },
    uploadTooLarge: 'Ce fichier dépasse 4 Mo. Envoyez un PDF plus léger ou une photo.',
    uploadBadType: 'Veuillez envoyer un fichier PDF, JPEG ou PNG.',
    uploadLimit: "Trop d'envois. Patientez quelques minutes puis réessayez.",
    uploadFailed: "L'envoi a échoué. Réessayez.",
    networkError: 'Impossible de joindre le service de réservation. Vérifiez votre connexion et réessayez.',
    contractHeading: "Contrat d'amarrage",
    agree: "J'accepte",
    contractAgreedOn: (date) => `Accepté le ${date}`,
    cancelBooking: 'Annuler la réservation',
    cancelConfirm: 'Annuler cette réservation ? La place sera libérée.',
    startOver: 'Nouvelle réservation',
```

5f. In `es`, replace:

```ts
    bookingCancelledBody: 'El puerto no pudo acomodar tu barco en esas fechas. Prueba con otras fechas o contáctales directamente.',
```
with:
```ts
    bookingCancelledBody: 'El puerto no pudo acomodar tu barco en esas fechas. Prueba con otras fechas o contáctales directamente.',
    hero: {
      hold: {
        eyebrow: 'Casi listo',
        title: 'Completa tu reserva',
        body: 'Tu amarre está reservado mientras terminas. Todavía no se ha enviado nada a la marina.',
      },
      pending: {
        eyebrow: 'Solicitud recibida',
        title: 'En manos del puerto',
        body: 'Hemos enviado tu solicitud a la marina. Recibirás una respuesta por email en breve.',
      },
      confirmed: {
        eyebrow: 'Reserva confirmada',
        title: 'Tienes plaza',
        body: 'El puerto ha confirmado tu amarre. Te hemos enviado los detalles por email.',
      },
      declined: {
        eyebrow: 'Reserva rechazada',
        title: 'Sin sitio esta vez',
        body: 'El puerto no pudo acomodar tu barco en esas fechas. Prueba con otras fechas o contáctales directamente.',
      },
      cancelled: {
        eyebrow: 'Reserva cancelada',
        title: 'Cancelada',
        body: 'Esta reserva ha sido cancelada. Si tienes alguna duda, contacta con la marina.',
      },
      expired: {
        eyebrow: 'Reserva caducada',
        title: 'Se acabó el tiempo',
        body: 'La reserva no se completó a tiempo, así que el amarre se ha liberado. Puedes volver a reservar.',
      },
    },
    waitingForMarina: 'Esperando a la marina · esta página se actualiza sola',
    holdUntil: (time) => `Reservado para ti hasta las ${time}`,
    checkEmailTitle: 'Revisa tu email',
    checkEmailBody: (time) =>
      `Te hemos enviado un enlace para confirmar esta reserva. Ábrelo antes de las ${time} o el amarre se liberará.`,
    loadingBooking: 'Cargando tu reserva…',
    bookingNotFound: 'No encontramos esta reserva. Usa el enlace de tu email.',
    loadFailed: 'No pudimos cargar tu reserva. Comprueba tu conexión e inténtalo de nuevo.',
    retry: 'Reintentar',
    detailsHeading: 'Tu reserva',
    berth: 'Amarre',
    dates: 'Fechas',
    boat: 'Barco',
    priceOnRequest: 'Precio a consultar',
    documentsHeading: 'Documentos',
    docsAfterSend: 'Podrás subir los documentos cuando tu solicitud se haya enviado a la marina.',
    docState: { pending: 'Recibido · en revisión', verified: 'Verificado', rejected: 'No aceptado · vuelve a subirlo' },
    uploadTooLarge: 'El archivo supera los 4 MB. Sube un PDF más pequeño o una foto.',
    uploadBadType: 'Sube un archivo PDF, JPEG o PNG.',
    uploadLimit: 'Demasiadas subidas. Espera unos minutos e inténtalo de nuevo.',
    uploadFailed: 'No se pudo subir el archivo. Inténtalo de nuevo.',
    networkError: 'No se pudo contactar con el servicio de reservas. Comprueba tu conexión e inténtalo de nuevo.',
    contractHeading: 'Contrato de amarre',
    agree: 'Acepto',
    contractAgreedOn: (date) => `Aceptado el ${date}`,
    cancelBooking: 'Cancelar reserva',
    cancelConfirm: '¿Cancelar esta reserva? El amarre quedará libre.',
    startOver: 'Nueva reserva',
```

5g. After `getBookLabels`, which ends at line 198, add the function below. Leave `getBookLabels` in place: `BookingWidget.svelte` calls it until Task 8.

```ts

/** Labels for an already-normalised language (`langOf` in ota.ts). */
export function getLabels(lang: BookLang): BookLabels {
  return L[lang] ?? L.en;
}
```

- [ ] **Step 6: Run the type check again: the new files are clean, and the known wizard errors are unchanged**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget
npx svelte-check --tsconfig ./tsconfig.app.json --output machine | grep -E "(ERROR|WARNING) .*(BookingView|DocumentsSection|ContractSection|i18n)"
npx svelte-check --tsconfig ./tsconfig.app.json --output machine | grep " ERROR " | awk '{print $3}' | sort | uniq -c
npm run check; echo "exit $?"
npx tsc -p tsconfig.node.json; echo "exit $?"
```

Expected:
- The first `grep` prints nothing.
- The count shows the same 22 errors as after Task 6, and nothing else. Task 8 clears them.

```
     17 "src\\BookingWidget.svelte"
      4 "src\\components\\DocumentsStep.svelte"
      1 "src\\components\\SentStep.svelte"
```

- `npm run check` prints `exit 1`. Its svelte-check summary is `COMPLETED … 22 ERRORS 0 WARNINGS 3 FILES_WITH_PROBLEMS`; in a TTY it reads `svelte-check found 22 errors and 0 warnings in 3 files`.
- Because the svelte-check half fails, its `&&` never runs `tsc`. The separate `tsc -p tsconfig.node.json` prints `exit 0`.

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/components/BookingView.svelte src/components/DocumentsSection.svelte src/components/ContractSection.svelte src/lib/i18n.ts
git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "Booking view: status, payment resume, documents, contract, cancel" -m "BookingView (booking-page mode on the OTA guest API) with DocumentsSection and ContractSection, plus en/it/fr/es labels. Payment resume calls confirm-payment before mounting Stripe; live updates use Ably with a per-auth token fetch and fall back to a 30 s poll outside hold. Upload, network and agreement errors are shown in the guest's language. Not wired into the element yet (next task)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Booking widget wizard on OTA

Repo: `W` = `C:/Users/robert/source/repos/sidon-booking-widget`. Rulings: R1, R2, R5–R9, R13–R15.

**Files:**
- Modify `W/src/lib/i18n.ts`:
  - Add the `WizardLabels` type and the `BookLabels.wizard` group.
  - Relabel `steps` in all 4 locales.
  - Delete `getBookLabels`. Its only caller is the old `BookingWidget.svelte`, which this task rewrites.
  - Anchors: the `export type BookLabels = {` / `steps: [string, string, string];` pair (baseline lines 6-7), the four `steps: [...]` lines (baseline 46, 83, 120, 157) and `export function getBookLabels` (baseline 195). Earlier tasks shift these line numbers, so match on content.
- Modify `W/src/components/Stepper.svelte`, lines 2-16: drop `step1Complete`, so only earlier steps are clickable.
- Modify `W/src/components/StepNav.svelte`, line 19: add `role="alert"` to the error.
- Rewrite `W/src/components/DetailsStep.svelte` (whole file).
- Create `W/src/components/PaymentStep.svelte`.
- Rewrite `W/src/BookingWidget.svelte` (whole file).
- Delete `W/src/components/SentStep.svelte` and `W/src/components/DocumentsStep.svelte`. Also delete these if they are still present: `W/src/lib/guest-token.ts` (Task 5) and `W/src/lib/berth-pricing.ts` (Task 6).
- Modify `W/package.json` and `W/package-lock.json` to remove the `qrcode` dependency.

**Interfaces:**
- Consumes:
  - `lib/types.ts` (Task 5): `BookLang`, `MarinaData`, `AvailableBerth`, `BookingStatus`, `BookingSession`, `CreatedBooking`, `PaymentSession`, `OtherMarina`.
  - `lib/ota.ts` (Task 5): `langOf`, `pickCheapest`, `formatMoney`.
  - `lib/marina-api.ts` (Task 5): `MarinaApiError` (`.status`; `0` = no HTTP answer, e.g. offline), `getMarina`, `getAvailability`, `createBooking`, `confirmPayment`, `cancelBooking`.
  - `lib/booking-session.ts` (Task 5): `loadSession`, `saveSession`, `clearSession`, `takeSessionFromUrl`.
  - `lib/stripe.ts`: `createPaymentSession({ publishableKey, clientSecret, locale, mount, colorPrimary })`, which resolves to `{ confirm(), destroy() }`.
  - `lib/i18n.ts` (Task 7): `getLabels(lang: BookLang): BookLabels`.
  - `components/BookingView.svelte` (Task 7) with props `{ apiOrigin, slug, session, lang, currencySymbol, variant, host, onstatus, onstartover? }`. The view cancels a `hold` itself before it calls `onstartover`.
  - `components/BerthMapView.svelte` (Task 6), with its current props.
  - `lib/date-range.ts`: `localIso`, `parseISODate`.
- Produces:
  - `<sidon-booking-widget>` 1.0:
    - Every existing attribute is kept. The new `booking-id` attribute (String) counts as present when its value is `''`.
    - Defaults change to `api-origin=''` and `currency-symbol=''`.
    - Events:
      - `sidon-step-change {step:1|2|3}`
      - `sidon-loa-change {loa}` (wizard only)
      - `sidon-booked {bookingId: uuid, marina: slug}` when step 3 is reached
      - `sidon-booking-status {bookingId, status}` on every status change the booking view reports after its first load
  - `components/PaymentStep.svelte`: props `{ payment: PaymentSession; host: HTMLElement; lang: BookLang; locale: string; totalLabel: string }`, plus `export async function confirm(): Promise<void>`.
  - `components/DetailsStep.svelte`: `$bindable` props `contactName`, `contactEmail`, `contactPhone`, `boatName`, `boatBeamM`, `notes`, plus a `labels` prop.
  - `lib/i18n.ts`: `export type WizardLabels` and `BookLabels.wizard: WizardLabels`. `getBookLabels` is removed.

This task adds no unit test. The pure helpers the wizard uses (`langOf`, `pickCheapest`, `formatMoney`) are already covered by Task 5's `scripts/check-ota.ts`. Per R21, this task's UI is verified by `npm run check`, `npm run build` and Task 10's e2e.

- [ ] **Step 1: Wizard labels in `src/lib/i18n.ts`, and drop `getBookLabels`**

The labels sit under one `wizard` group so they can't collide with the booking-view keys Task 7 adds.

Edit 1. Old:
```ts
export type BookLabels = {
  steps: [string, string, string];
```
New:
```ts
// Wizard-only copy (steps 1-2, plus booking-page mode's broken-link
// message). Grouped so it can't collide with the booking view's keys.
export type WizardLabels = {
  boatBeam: string;
  errDates: string;
  errLength: string;
  errNoBerth: string;
  errName: string;
  errBoatName: string;
  errEmail: string;
  errTaken: string;
  errTooMany: string;
  errPayment: string;
  errUnavailable: string;
  errNetwork: string;
  errLoad: string;
  errCardLoading: string;
  linkInvalid: string;
};

export type BookLabels = {
  steps: [string, string, string];
  wizard: WizardLabels;
```

Edit 2 (it). Old:
```ts
    steps: ['Documenti', 'Invia', 'Conferma'],
```
New:
```ts
    steps: ['Dati', 'Pagamento', 'Prenotazione'],
    wizard: {
      boatBeam: 'Baglio (m)',
      errDates: 'Scegli le date di arrivo e partenza.',
      errLength: "Indica la lunghezza dell'imbarcazione.",
      errNoBerth: 'Nessun posto barca adatto a questa imbarcazione in queste date. Prova altre date o contatta la marina.',
      errName: 'Inserisci il nome del comandante.',
      errBoatName: "Inserisci il nome dell'imbarcazione.",
      errEmail: 'Inserisci un indirizzo email valido.',
      errTaken: 'Quel posto barca è appena stato prenotato. Abbiamo aggiornato la disponibilità: controlla il posto e riprova.',
      errTooMany: 'Troppi tentativi di prenotazione. Riprova più tardi o contatta la marina.',
      errPayment: 'Non è stato possibile preparare il pagamento con carta. Riprova.',
      errUnavailable: 'La prenotazione online non è disponibile al momento. Contatta la marina.',
      errNetwork: 'Impossibile raggiungere il servizio di prenotazione. Controlla la connessione e riprova.',
      errLoad: 'Impossibile caricare la disponibilità degli ormeggi. Riprova.',
      errCardLoading: 'Il modulo della carta si sta ancora caricando. Attendi un momento.',
      linkInvalid: "Questo link di prenotazione è incompleto. Apri di nuovo il link nell'email di prenotazione.",
    },
```

Edit 3 (en). Old:
```ts
    steps: ['Documents', 'Send', 'Confirm'],
```
New:
```ts
    steps: ['Details', 'Payment', 'Booking'],
    wizard: {
      boatBeam: 'Beam (m)',
      errDates: 'Please pick arrival and departure dates.',
      errLength: 'Please set your boat length.',
      errNoBerth: 'No berth fits this boat on these dates. Try other dates or contact the marina.',
      errName: "Please enter the skipper's name.",
      errBoatName: 'Please enter the boat name.',
      errEmail: 'Please enter a valid email address.',
      errTaken: "That berth has just been taken. We've refreshed availability: please check the berth and try again.",
      errTooMany: 'Too many booking attempts. Please try again later or contact the marina.',
      errPayment: 'Card payment could not be set up. Please try again.',
      errUnavailable: 'Online booking is not available right now. Please contact the marina.',
      errNetwork: 'Could not reach the booking service. Please check your connection and try again.',
      errLoad: 'Could not load berth availability. Please try again.',
      errCardLoading: 'The card form is still loading. Please wait a moment.',
      linkInvalid: 'This booking link is incomplete. Please open the link in your booking email again.',
    },
```

Edit 4 (fr). Old:
```ts
    steps: ['Documents', 'Envoyer', 'Confirmer'],
```
New:
```ts
    steps: ['Détails', 'Paiement', 'Réservation'],
    wizard: {
      boatBeam: 'Largeur (m)',
      errDates: "Choisissez les dates d'arrivée et de départ.",
      errLength: 'Indiquez la longueur de votre bateau.',
      errNoBerth: "Aucune place ne convient à ce bateau à ces dates. Essayez d'autres dates ou contactez la marina.",
      errName: 'Saisissez le nom du capitaine.',
      errBoatName: 'Saisissez le nom du bateau.',
      errEmail: 'Saisissez une adresse email valide.',
      errTaken: "Cette place vient d'être réservée. Les disponibilités ont été actualisées : vérifiez la place et réessayez.",
      errTooMany: 'Trop de tentatives de réservation. Réessayez plus tard ou contactez la marina.',
      errPayment: "Le paiement par carte n'a pas pu être préparé. Réessayez.",
      errUnavailable: "La réservation en ligne n'est pas disponible pour le moment. Contactez la marina.",
      errNetwork: 'Impossible de joindre le service de réservation. Vérifiez votre connexion et réessayez.',
      errLoad: 'Impossible de charger les disponibilités. Réessayez.',
      errCardLoading: 'Le formulaire de carte est encore en cours de chargement. Patientez un instant.',
      linkInvalid: 'Ce lien de réservation est incomplet. Ouvrez à nouveau le lien de votre email de réservation.',
    },
```

Edit 5 (es). Old:
```ts
    steps: ['Documentos', 'Enviar', 'Confirmar'],
```
New:
```ts
    steps: ['Datos', 'Pago', 'Reserva'],
    wizard: {
      boatBeam: 'Manga (m)',
      errDates: 'Elige las fechas de llegada y salida.',
      errLength: 'Indica la eslora de tu barco.',
      errNoBerth: 'Ningún amarre admite este barco en esas fechas. Prueba otras fechas o contacta con la marina.',
      errName: 'Escribe el nombre del capitán.',
      errBoatName: 'Escribe el nombre del barco.',
      errEmail: 'Escribe un email válido.',
      errTaken: 'Ese amarre se acaba de reservar. Hemos actualizado la disponibilidad: revisa el amarre y vuelve a intentarlo.',
      errTooMany: 'Demasiados intentos de reserva. Inténtalo más tarde o contacta con la marina.',
      errPayment: 'No se pudo preparar el pago con tarjeta. Inténtalo de nuevo.',
      errUnavailable: 'La reserva online no está disponible ahora mismo. Contacta con la marina.',
      errNetwork: 'No se pudo conectar con el servicio de reservas. Revisa tu conexión e inténtalo de nuevo.',
      errLoad: 'No se pudo cargar la disponibilidad de amarres. Inténtalo de nuevo.',
      errCardLoading: 'El formulario de la tarjeta aún se está cargando. Espera un momento.',
      linkInvalid: 'Este enlace de reserva está incompleto. Vuelve a abrir el enlace del email de tu reserva.',
    },
```

Edit 6. Delete these four lines and the blank line that follows them. Nothing calls `getBookLabels` once Step 5 rewrites `BookingWidget.svelte`. `BookLocale` stays because the `L` table's type still uses it.
```ts
export function getBookLabels(locale: string | null | undefined): BookLabels {
  const lc = (locale ?? 'en').toLowerCase() as BookLocale;
  return L[lc] ?? L.en;
}
```

- [ ] **Step 2: Rewrite `src/components/DetailsStep.svelte`**

The form keeps only the contract's fields, with their maxlengths. Document locks, the contract and the payment block are removed.

```svelte
<script lang="ts">
  import type { BookLabels } from '../lib/i18n';

  // The maxlengths mirror OTA's guest validation (marinaGuard.js): a name
  // or boat name over 100 characters comes back as "… is required" and a
  // phone over 30 is silently dropped, so the inputs stop at the limit.
  interface Props {
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    boatName: string;
    boatBeamM: number | null;
    notes: string;
    labels: BookLabels;
  }

  let {
    contactName = $bindable(''),
    contactEmail = $bindable(''),
    contactPhone = $bindable(''),
    boatName = $bindable(''),
    boatBeamM = $bindable(null),
    notes = $bindable(''),
    labels,
  }: Props = $props();
</script>

<div class="sbw-details">
  <div class="sbw-details-heading">{labels.yourDetails}</div>
  <div class="sbw-field-grid">
    <div class="sbw-field">
      <label for="sbw-contact-name">{labels.skipperName} <span class="sbw-required">*</span></label>
      <input id="sbw-contact-name" type="text" required maxlength="100" autocomplete="name" bind:value={contactName} />
    </div>
    <div class="sbw-field">
      <label for="sbw-boat-name">{labels.boatName} <span class="sbw-required">*</span></label>
      <input id="sbw-boat-name" type="text" required maxlength="100" bind:value={boatName} />
    </div>
  </div>
  <div class="sbw-field-grid">
    <div class="sbw-field">
      <label for="sbw-email">{labels.email} <span class="sbw-required">*</span></label>
      <input id="sbw-email" type="email" required maxlength="255" autocomplete="email" bind:value={contactEmail} />
    </div>
    <div class="sbw-field">
      <label for="sbw-phone">{labels.phone}</label>
      <input id="sbw-phone" type="tel" maxlength="30" autocomplete="tel" bind:value={contactPhone} />
    </div>
  </div>
  <div class="sbw-field-grid">
    <div class="sbw-field">
      <label for="sbw-beam">{labels.wizard.boatBeam}</label>
      <input id="sbw-beam" type="number" min="0.1" step="0.1" inputmode="decimal" bind:value={boatBeamM} />
    </div>
  </div>
  <div class="sbw-field">
    <label for="sbw-notes">{labels.notes}</label>
    <textarea id="sbw-notes" rows="3" maxlength="2000" bind:value={notes}></textarea>
  </div>
</div>

<style>
  .sbw-details {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 20px;
  }
  .sbw-details-heading {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-field-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .sbw-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sbw-field label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-field input,
  .sbw-field textarea {
    height: 48px;
    padding: 0 14px;
    border: 1px solid #e4e7ec;
    border-radius: var(--sbw-radius, 10px);
    font-size: 15px;
    color: var(--brand-navy, #16365b);
    background: #fff;
    outline: none;
    font-family: inherit;
  }
  .sbw-field textarea {
    height: auto;
    padding: 10px 14px;
    resize: vertical;
  }
  .sbw-field input:focus,
  .sbw-field textarea:focus {
    border-color: var(--brand-navy, #16365b);
  }
</style>
```

- [ ] **Step 3: Create `src/components/PaymentStep.svelte`**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { getLabels } from '../lib/i18n';
  import { createPaymentSession } from '../lib/stripe';
  import type { BookLang, PaymentSession } from '../lib/types';

  interface Props {
    payment: PaymentSession;
    /** The custom element itself: the card form mounts into a light-DOM
        child of it (see onMount). */
    host: HTMLElement;
    lang: BookLang;
    /** Stripe Elements locale. The widget passes the normalised language:
        Stripe's fixed locale list has no tags like it-IT. */
    locale: string;
    totalLabel: string;
  }
  let { payment, host, lang, locale, totalLabel }: Props = $props();

  const labels = $derived(getLabels(lang));
  // Its own slot name, so this mount can never be confused with the
  // booking view's card mount on the same host.
  const SLOT = 'sbw-payment-step';

  let anchor: HTMLDivElement;
  let session: { confirm(): Promise<void>; destroy(): void } | null = null;
  let error = $state<string | null>(null);

  // Stripe.js has no Shadow DOM support (stripe/stripe-js#143, #399): a
  // mount node inside the shadow tree leaves the Payment Element on its
  // loading skeleton forever. So the mount node is a light-DOM child of the
  // host, projected into this spot through a native <slot> created with
  // plain DOM APIs — a literal <slot> in this template would be taken by
  // Svelte's own slot mechanism, since this component isn't the element root.
  onMount(() => {
    const slot = document.createElement('slot');
    slot.name = SLOT;
    anchor.appendChild(slot);
    const mount = document.createElement('div');
    mount.slot = SLOT;
    host.appendChild(mount);
    let gone = false;
    (async () => {
      try {
        const s = await createPaymentSession({
          publishableKey: payment.publishableKey,
          clientSecret: payment.clientSecret,
          locale,
          mount,
          colorPrimary: getComputedStyle(host).getPropertyValue('--brand-navy').trim() || '#16365b',
        });
        if (gone) s.destroy();
        else session = s;
      } catch (err) {
        if (!gone) error = err instanceof Error ? err.message : labels.wizard.errNetwork;
      }
    })();
    return () => {
      gone = true;
      session?.destroy();
      session = null;
      mount.remove();
    };
  });

  /** Authorises the card; throws with Stripe's own message when it fails. */
  export async function confirm(): Promise<void> {
    if (!session) throw new Error(labels.wizard.errCardLoading);
    await session.confirm();
  }
</script>

<div class="sbw-payment">
  <div class="sbw-payment-heading">
    <span>{labels.paymentHold}</span>
    <span class="sbw-payment-amount">{labels.total} {totalLabel}</span>
  </div>
  <p class="sbw-payment-note">{labels.paymentNote}</p>
  <div class="sbw-payment-element" bind:this={anchor}></div>
  {#if error}<div class="sbw-payment-error" role="alert">{error}</div>{/if}
</div>

<style>
  .sbw-payment {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 20px;
  }
  .sbw-payment-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #252525;
  }
  .sbw-payment-amount {
    font-size: 22px;
    font-weight: 500;
    color: var(--brand-navy, #16365b);
  }
  .sbw-payment-note {
    font-size: 12px;
    color: #252525;
    line-height: 1.6;
    margin: 0;
  }
  .sbw-payment-element {
    padding: 14px;
    border-radius: 12px;
    border: 1px solid #e4e7ec;
    background: #fff;
  }
  .sbw-payment-error {
    font-size: 13px;
    color: #cc4949;
  }
</style>
```

- [ ] **Step 4: Make the Stepper back-only and announce StepNav errors**

`src/components/Stepper.svelte`. Old:
```ts
  interface Props {
    active: number;
    labels: [string, string, string];
    step1Complete: boolean;
    onStepClick: (n: number) => void;
  }
  let { active, labels, step1Complete, onStepClick }: Props = $props();

  function selectable(n: number): boolean {
    if (active === 3) return false;
    if (n < active) return true;
    if (n === active + 1) return !(active === 1 && !step1Complete);
    return false;
  }
```
New:
```ts
  interface Props {
    active: number;
    labels: [string, string, string];
    onStepClick: (n: number) => void;
  }
  let { active, labels, onStepClick }: Props = $props();

  // Only earlier steps are clickable: going forward always runs Next (which
  // creates the hold), and step 3 is the booking itself, with no way back.
  function selectable(n: number): boolean {
    return active !== 3 && n < active;
  }
```

`src/components/StepNav.svelte`. Old:
```svelte
  <div class="sbw-error">{error}</div>
```
New:
```svelte
  <div class="sbw-error" role="alert">{error}</div>
```

- [ ] **Step 5: Rewrite `src/BookingWidget.svelte` (whole file)**

Name the element's local `hostEl`, not `host`. A local variable named `host` makes svelte2tsx read `$host` as a store subscription to it, and svelte-check then fails with "'$host' used before its declaration".

```svelte
<svelte:options
  customElement={{
    tag: 'sidon-booking-widget',
    shadow: 'open',
    props: {
      marina: { attribute: 'marina', type: 'String' },
      apiOrigin: { attribute: 'api-origin', type: 'String' },
      from: { attribute: 'from', type: 'String' },
      to: { attribute: 'to', type: 'String' },
      length: { attribute: 'length', type: 'Number' },
      berth: { attribute: 'berth', type: 'String' },
      locale: { attribute: 'locale', type: 'String' },
      currencySymbol: { attribute: 'currency-symbol', type: 'String' },
      variant: { attribute: 'variant', type: 'String' },
      mapsApiKey: { attribute: 'maps-api-key', type: 'String' },
      mapStyle: { attribute: 'map-style', type: 'String' },
      mapHeight: { attribute: 'map-height', type: 'String' },
      mapWidth: { attribute: 'map-width', type: 'String' },
      mapGap: { attribute: 'map-gap', type: 'String' },
      width: { attribute: 'width', type: 'String' },
      logoMark: { attribute: 'logo-mark', type: 'String' },
      marinaName: { attribute: 'marina-name', type: 'String' },
      otherMarinas: { type: 'Array' },
      bookingId: { attribute: 'booking-id', type: 'String' },
    },
  }}
/>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Summary from './components/Summary.svelte';
  import BerthMapView from './components/BerthMapView.svelte';
  import Stepper from './components/Stepper.svelte';
  import DetailsStep from './components/DetailsStep.svelte';
  import PaymentStep from './components/PaymentStep.svelte';
  import StepNav from './components/StepNav.svelte';
  import BookingView from './components/BookingView.svelte';

  import { getLabels } from './lib/i18n';
  import { langOf, pickCheapest, formatMoney } from './lib/ota';
  import { localIso, parseISODate } from './lib/date-range';
  import { MarinaApiError, getMarina, getAvailability, createBooking, confirmPayment, cancelBooking } from './lib/marina-api';
  import { loadSession, saveSession, clearSession, takeSessionFromUrl } from './lib/booking-session';
  import type { AvailableBerth, BookingSession, BookingStatus, CreatedBooking, MarinaData, OtherMarina } from './lib/types';

  interface Props {
    /** The marina's OTA slug. */
    marina: string;
    /** Origin of the site's /api/marina/guest forwarder. '' (default) is
        this page's own origin, so every call is a relative URL. */
    apiOrigin?: string;
    from?: string;
    to?: string;
    length?: number;
    berth?: string;
    locale?: string;
    /** Non-empty: amounts render as `${symbol}${amount}`. Empty (default):
        Intl currency format of the marina's own currency. */
    currencySymbol?: string;
    /** Visual theme for the Next/Back buttons and the booking view.
          'navy' — gold Next button, navy on hover (Positano).
          'dark' — solid #252525 Next button, gold on hover (Fox/Pevero). */
    variant?: 'navy' | 'dark';
    /** Map is only rendered when this is set - no separate on/off prop. */
    mapsApiKey?: string;
    mapStyle?: 'chart' | 'coastal';
    mapHeight?: string;
    /** '100vw' breaks the map out of the widget's own narrow card (it
        escapes .sbw-root's rounded-corner clipping to do this) for a
        full-bleed look; any other value (default '100%') keeps it inside
        the card like every other section. */
    mapWidth?: string;
    /** Space between the map and the summary/stepper card below it. */
    mapGap?: string;
    /** Sets :host's own max-width (default '560px'). The widget centers
        itself via margin:auto within whatever space its container gives
        it, same as the reference's fixed-width + centered card. */
    width?: string;
    logoMark?: string | null;
    marinaName?: string;
    otherMarinas?: OtherMarina[];
    /** Present = this element is the site's booking page and shows the
        booking from the emailed ?booking=&token= link; a non-empty value
        overrides the id in the link. A String attribute (not Boolean)
        because Svelte passes those through as-is: `booking-id` with no
        value arrives as '', an absent attribute leaves this undefined. */
    bookingId?: string | null;
  }
  let {
    marina,
    apiOrigin = '',
    from: fromAttr = '',
    to: toAttr = '',
    length: lengthAttr = 15,
    berth: berthAttr = '',
    locale = 'en',
    currencySymbol = '',
    variant = 'navy',
    mapsApiKey = '',
    mapStyle = 'chart',
    mapHeight = '280px',
    mapWidth = '100%',
    mapGap = '0px',
    width = '560px',
    logoMark = null,
    marinaName = '',
    otherMarinas = [],
    bookingId: bookingIdAttr,
  }: Props = $props();

  // $host() compiles to the element Svelte's custom-element wrapper passes
  // in, so one read here holds for the widget's whole lifetime. Not named
  // `host`: a local `host` would turn `$host` into a store subscription.
  const hostEl = $host();

  function emit(name: string, detail: unknown) {
    hostEl.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  const lang = $derived(langOf(locale));
  const labels = $derived(getLabels(lang));

  // ---- mode ----------------------------------------------------------------
  // Decided once, at creation. With `booking-id` this element is the site's
  // booking page: the session comes from the emailed link (whose token then
  // leaves the address bar) or, after a reload, from this tab's saved copy.
  // Without it, a session saved by an earlier booking in this tab resumes at
  // step 3, so a reload shows that booking instead of 409ing on its own hold.
  const bookingPage = untrack(() => bookingIdAttr != null);
  let session = $state<BookingSession | null>(untrack(() => (bookingPage ? pageSession() : loadSession(marina))));
  let step = $state<1 | 2 | 3>(untrack(() => (bookingPage || session ? 3 : 1)));

  function pageSession(): BookingSession | null {
    const fromLink = takeSessionFromUrl();
    if (fromLink) {
      const s = { id: bookingIdAttr || fromLink.id, token: fromLink.token };
      saveSession(marina, s);
      return s;
    }
    const saved = loadSession(marina);
    return saved && (!bookingIdAttr || saved.id === bookingIdAttr) ? saved : null;
  }

  // ---- wizard state ----------------------------------------------------------
  // Attributes seed the wizard's initial values only — this widget can be
  // dropped into a page it doesn't control, so it never rewrites the host
  // page's URL to stay in sync. `untrack` documents that the one-time read
  // below is intentional, not a missed reactivity bug.
  let loa = $state(untrack(() => (lengthAttr && lengthAttr > 0 ? lengthAttr : 15)));
  // Seed a real default range (today → +3 nights) up front when no from/to
  // attributes are given, rather than leaving these null and relying on
  // Summary's flatpickr `defaultDate` to report back — flatpickr doesn't
  // fire `onChange` for a programmatic default, only for an actual user
  // pick, so availability and the price would otherwise never load until
  // the guest manually touches the date field.
  let from = $state<Date | null>(
    untrack(() => {
      const parsed = parseISODate(fromAttr);
      if (parsed) return parsed;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return today;
    }),
  );
  let to = $state<Date | null>(
    untrack(() => {
      const parsed = parseISODate(toAttr);
      if (parsed) return parsed;
      const base = parseISODate(fromAttr) ?? new Date(new Date().setHours(0, 0, 0, 0));
      return new Date(base.getTime() + 86400000 * 3);
    }),
  );
  let manualBerth = $state<string | null>(null);

  let contactName = $state('');
  let contactEmail = $state('');
  let contactPhone = $state('');
  let boatName = $state('');
  let boatBeamM = $state<number | null>(null);
  let notes = $state('');

  let marinaData = $state<MarinaData | null>(null);
  let available = $state<AvailableBerth[]>([]);
  // Shared by the map-data and availability loads: either failing shows it,
  // either succeeding clears it (availability alone is enough to book).
  let loadError = $state<string | null>(null);
  // Bumped after a 409/404 on create so availability and the map re-fetch
  // straight away instead of on the guest's next input change.
  let refreshTick = $state(0);

  // The hold Next created on step 1; step 2 needs its payment and total.
  let created = $state<CreatedBooking | null>(null);
  let paymentStep = $state.raw<ReturnType<typeof PaymentStep>>();
  let sending = $state(false);
  let navError = $state<string | null>(null);

  // Google Maps' Circle overlay reads fillColor/strokeColor as literal paint
  // values - it can't resolve CSS var() the way a real stylesheet property
  // can. Resolve the host's actual computed --brand-navy/--brand-gold once
  // on mount instead of handing BerthMapView the raw var() string (same
  // approach as BerthMap.svelte).
  let resolvedNavy = $state('#16365b');
  let resolvedGold = $state('#c9a86b');
  onMount(() => {
    const cs = getComputedStyle(hostEl);
    resolvedNavy = cs.getPropertyValue('--brand-navy').trim() || resolvedNavy;
    resolvedGold = cs.getPropertyValue('--brand-gold').trim() || resolvedGold;
  });

  // Any layout shift inside the widget (map settling, availability arriving,
  // a webfont swapping in) can leave an already-open date-range calendar
  // positioned against a now-stale layout - flatpickr only repositions on
  // open or on a real window resize/scroll, not on unrelated DOM changes.
  // Dispatching a synthetic resize on every actual size change of the widget
  // itself (rather than a one-shot nudge tied to a specific known cause)
  // nudges flatpickr's own resize handler to recalculate regardless of what
  // caused the shift.
  onMount(() => {
    const observer = new ResizeObserver(() => {
      window.dispatchEvent(new Event('resize'));
    });
    observer.observe(hostEl);
    return () => observer.disconnect();
  });

  // :host is a pseudo-selector, not a template element - Svelte has no
  // `style="..."` binding for it, so a width prop has to be applied by
  // setting the host's own inline style directly (which also wins over
  // the CSS fallback below without needing !important).
  onMount(() => {
    hostEl.style.maxWidth = width;
  });

  // ---- derived -------------------------------------------------------------
  const beam = $derived(boatBeamM != null && boatBeamM > 0 ? boatBeamM : null);
  const freeBerths = $derived((marinaData?.berths ?? []).filter((b) => b.status === 'available'));
  // A berth with no recorded length takes any boat (OTA's fit rule), so it
  // lifts the cap rather than counting as 0.
  const maxLoa = $derived(
    !freeBerths.length || freeBerths.some((b) => b.lengthM == null)
      ? 200
      : Math.max(...freeBerths.map((b) => b.lengthM ?? 0)),
  );
  // OTA's availability list decides both the berth and the price: a manual
  // pick (map click or `berth` attribute) counts only while that list still
  // offers it for these dates and this boat, otherwise the cheapest berth.
  const chosenLabel = $derived(
    manualBerth && available.some((b) => b.label === manualBerth) ? manualBerth : pickCheapest(available),
  );
  const chosen = $derived(available.find((b) => b.label === chosenLabel) ?? null);
  const priceLabel = $derived(
    chosen?.totalPrice != null ? formatMoney(chosen.totalPrice, marinaData?.currency ?? null, currencySymbol, lang) : null,
  );

  // `loa` starts at a hardcoded default (or the `length` attribute) before
  // any real berth data has loaded, so it can end up larger than every
  // berth this marina actually has (e.g. default 15m vs. an all-12m
  // marina) — availability then offers nothing and no berth is selected
  // on load. Nudge it down once, the first time real berth data arrives —
  // a ONE-TIME adjustment, not an ongoing clamp, so it doesn't fight the
  // guest's own later use of the +/- stepper (already bounded by maxLoa on
  // every step via Summary's own Math.min).
  let loaSeeded = false;
  $effect(() => {
    if (loaSeeded || !freeBerths.length) return;
    loaSeeded = true;
    if (loa > maxLoa) loa = maxLoa;
  });

  // Keep manualBerth in sync with the host-driven `berth` attribute after
  // mount (e.g. a map click on the host page) — but only while the guest is
  // still on step 1: past that, the hold is keyed to the chosen berth. Only
  // the attribute is tracked, so returning to step 1 doesn't overwrite a
  // berth the guest has since picked on the widget's own map.
  $effect(() => {
    const b = berthAttr;
    untrack(() => {
      if (step === 1) manualBerth = b || null;
    });
  });

  // ---- map data: re-fetch (debounced) on date change ----------------------
  // Berth `status` is date-scoped server-side. Only the map and the length
  // cap use this, so it runs while the wizard is open; `wizardOpen` changes
  // only when step 3 is entered or left, so going 1 → 2 doesn't re-fetch.
  const wizardOpen = $derived(step !== 3);
  $effect(() => {
    if (!wizardOpen) return;
    const range = from && to ? { from: localIso(from), to: localIso(to) } : undefined;
    void refreshTick;
    let cancelled = false;
    const timer = setTimeout(() => {
      getMarina(apiOrigin, marina, range)
        .then((data) => {
          if (cancelled) return;
          marinaData = data;
          loadError = null;
        })
        .catch(() => {
          if (!cancelled) loadError = labels.wizard.errLoad;
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // ---- availability: free, fitting berths priced by OTA (debounced) -------
  // Step 1 only: once the hold exists its berth reads as taken (the guest's
  // own hold counts), so a re-fetch on step 2 would auto-pick it away.
  $effect(() => {
    if (step !== 1 || !from || !to || +to <= +from || !(loa > 0)) return;
    const q = { arrival: localIso(from), departure: localIso(to), boatLengthM: loa, boatBeamM: beam };
    void refreshTick;
    let cancelled = false;
    const timer = setTimeout(() => {
      getAvailability(apiOrigin, marina, q)
        .then((list) => {
          if (cancelled) return;
          available = list;
          loadError = null;
        })
        .catch(() => {
          if (!cancelled) loadError = labels.wizard.errLoad;
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // ---- events ----------------------------------------------------------------
  $effect(() => {
    emit('sidon-step-change', { step });
  });

  // Lets a host page (e.g. its own map) grey out berths that don't fit as
  // the guest adjusts boat length in Summary's own +/- control.
  $effect(() => {
    if (!bookingPage) emit('sidon-loa-change', { loa });
  });

  // ---- handlers --------------------------------------------------------------
  // Only on step 1: past that, the hold is keyed to the chosen berth.
  function handleMapBerthClick(label: string | null) {
    if (step === 1) manualBerth = label;
  }

  // The Stepper only offers earlier steps, i.e. Back.
  function handleStepClick(n: number) {
    if (n < step) void goBack();
  }

  function goNext() {
    if (sending) return;
    navError = null;
    if (step === 1) void createHold();
    else if (step === 2) void pay();
  }

  // The same check OTA applies, so a typo fails here, not after a round trip.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function invalidDetails(): string | null {
    const w = labels.wizard;
    if (!from || !to || +to <= +from) return w.errDates;
    if (!(loa > 0)) return w.errLength;
    if (!chosenLabel) return w.errNoBerth;
    if (!contactName.trim()) return w.errName;
    if (!boatName.trim()) return w.errBoatName;
    if (!EMAIL_RE.test(contactEmail.trim())) return w.errEmail;
    return null;
  }

  // Next on step 1: POST bookings puts a 30-minute hold on the berth.
  async function createHold() {
    const invalid = invalidDetails();
    if (invalid) return void (navError = invalid);
    sending = true;
    try {
      const c = await createBooking(apiOrigin, marina, {
        berthLabel: chosenLabel!,
        arrival: localIso(from!),
        departure: localIso(to!),
        contactName: contactName.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim() || undefined,
        boatName: boatName.trim(),
        boatLengthM: loa,
        boatBeamM: beam,
        notes: notes.trim() || undefined,
        locale: lang,
      });
      const s = { id: c.booking.id, token: c.token };
      session = s;
      saveSession(marina, s);
      // No payment means no price, or a property that takes no cards: the
      // hold then waits for the emailed confirm link (the view explains).
      if (c.payment) {
        created = c;
        step = 2;
      } else {
        reachBooking(s.id);
      }
    } catch (err) {
      failCreate(err);
    } finally {
      sending = false;
    }
  }

  // OTA's own 400 wording is specific (arrival in the past, boat too long…),
  // so it shows as is; everything else gets translated copy.
  function failCreate(err: unknown) {
    const w = labels.wizard;
    // Status 0 is MarinaApiError's "no answer at all" (offline, DNS, CORS).
    if (!(err instanceof MarinaApiError) || err.status === 0) return void (navError = w.errNetwork);
    // Taken since availability loaded (409) or no longer bookable (404):
    // re-fetch so the auto-pick moves to a berth that is actually free.
    if (err.status === 409 || err.status === 404) refreshTick++;
    const byStatus: Record<number, string> = { 404: w.errTaken, 409: w.errTaken, 429: w.errTooMany, 502: w.errPayment, 503: w.errUnavailable };
    navError = byStatus[err.status] ?? (err.status >= 500 ? w.errUnavailable : err.message);
  }

  // Pay on step 2.
  async function pay() {
    const s = session;
    if (!s || !paymentStep) return;
    sending = true;
    try {
      // A declined card throws Stripe's own (localised) message and keeps
      // the guest on this step to try another card.
      await paymentStep.confirm();
    } catch (err) {
      navError = err instanceof Error ? err.message : labels.wizard.errNetwork;
      sending = false;
      return;
    }
    // The card is held. confirm-payment promotes the hold to pending; if
    // that call fails, the booking view retries it on load and shows
    // pending, the card form or "expired" from its answer.
    await confirmPayment(apiOrigin, marina, s).catch(() => {});
    sending = false;
    reachBooking(s.id);
  }

  function reachBooking(id: string) {
    created = null;
    step = 3;
    emit('sidon-booked', { bookingId: id, marina });
  }

  // Back from payment releases the hold: until it lapses it blocks the
  // berth (for this guest too) and counts toward OTA's 3-per-email cap.
  async function goBack() {
    const s = session;
    if (sending || step !== 2 || !s) return;
    navError = null;
    sending = true;
    const released = await cancelBooking(apiOrigin, marina, s).then(
      () => true,
      // A 4xx means the hold is already gone (lapsed or cancelled). No answer
      // (status 0), a 429 or a 5xx leaves it live, so stay here rather than
      // strand it.
      (err) => err instanceof MarinaApiError && err.status >= 400 && err.status < 500 && err.status !== 429,
    );
    sending = false;
    if (!released) return void (navError = labels.wizard.errNetwork);
    clearSession(marina);
    session = null;
    created = null;
    step = 1;
  }

  // The booking view's "Start a new booking". The view has already released
  // a live hold (same reasons as Back) before calling this, so only the
  // wizard resets here.
  function startOver() {
    clearSession(marina);
    session = null;
    navError = null;
    step = 1;
  }

  function onStatus(status: BookingStatus, previous: BookingStatus | null) {
    // The first load (previous null) isn't a change; hosts hear transitions.
    if (previous !== null && session) emit('sidon-booking-status', { bookingId: session.id, status });
  }
</script>

<!-- The booking view (step 3 and the booking page) never loads Google Maps:
     that page carries the booking token and allows no third-party script
     beyond Stripe's. -->
{#if mapsApiKey && step !== 3 && !loadError}
  <div
    class="sbw-map-slot"
    class:sbw-map-slot--full-bleed={mapWidth === '100vw'}
    style="height: {mapHeight}; width: {mapWidth}; margin-bottom: {mapGap};"
  >
    <BerthMapView
      {mapsApiKey}
      {mapStyle}
      center={{ lat: marinaData?.profile.lat ?? 0, lng: marinaData?.profile.lng ?? 0 }}
      navy={resolvedNavy}
      gold={resolvedGold}
      {logoMark}
      {marinaName}
      {otherMarinas}
      berths={marinaData?.berths ?? []}
      overlays={marinaData?.overlays ?? []}
      layout={marinaData?.layout ?? null}
      {loa}
      selectedBerth={chosenLabel}
      onBerthClick={handleMapBerthClick}
    />
  </div>
{/if}
<div class="sbw-root">
  {#if bookingPage}
    {#if session}
      <BookingView {apiOrigin} slug={marina} {session} {lang} {currencySymbol} {variant} host={hostEl} onstatus={onStatus} />
    {:else}
      <div class="sbw-load-error" role="alert">{labels.wizard.linkInvalid}</div>
    {/if}
  {:else}
    {#if step !== 3}
      <Summary
        bind:loa
        bind:from
        bind:to
        berthLabel={chosenLabel ?? '—'}
        {priceLabel}
        {maxLoa}
        {locale}
        disabled={step !== 1}
      />
    {/if}
    <Stepper active={step} labels={labels.steps} onStepClick={handleStepClick} />
    {#if loadError && step !== 3}
      <div class="sbw-load-error" role="alert">{loadError}</div>
    {/if}

    {#if step === 1}
      <DetailsStep
        bind:contactName
        bind:contactEmail
        bind:contactPhone
        bind:boatName
        bind:boatBeamM
        bind:notes
        {labels}
      />
    {:else if step === 2 && created?.payment}
      <PaymentStep
        bind:this={paymentStep}
        payment={created.payment}
        host={hostEl}
        {lang}
        locale={lang}
        totalLabel={formatMoney(created.booking.totalPrice, created.booking.currency, currencySymbol, lang)}
      />
    {:else if step === 3 && session}
      <BookingView
        {apiOrigin}
        slug={marina}
        {session}
        {lang}
        {currencySymbol}
        {variant}
        host={hostEl}
        onstatus={onStatus}
        onstartover={startOver}
      />
    {/if}

    <StepNav {step} {sending} error={navError} {labels} {variant} onBack={goBack} onNext={goNext} />
  {/if}
</div>

<style>
  :host {
    --sbw-radius: 10px;
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
    box-sizing: border-box;
    max-width: 560px; /* fallback until the width prop's effect runs; see script */
    margin: 0 auto;
  }
  :host * {
    box-sizing: border-box;
  }
  .sbw-root {
    border-radius: var(--sbw-radius);
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
  }
  /* Inline, not a replacement for the card: the guest can still change
     dates or length, and the next successful load clears it. */
  .sbw-load-error {
    padding: 16px 20px;
    font-size: 14px;
    color: #cc4949;
    background: #fff;
  }
  /* Sits outside .sbw-root (not a child of it) specifically so map-width
     can be set to 100vw and actually break out full-bleed - .sbw-root's
     own overflow:hidden (for its rounded corners) would otherwise clip
     anything wider than the card right back down to the card's width,
     no matter what width/margin the child itself asks for. */
  .sbw-map-slot {
    border-radius: var(--sbw-radius) var(--sbw-radius) 0 0;
    overflow: hidden;
  }
  .sbw-map-slot--full-bleed {
    /* Standard full-bleed trick: escapes a centered ancestor of any width
       by sizing to the viewport and pulling back by the half-difference.
       Only correct when width is actually 100vw (see class:sbw-map-slot--
       full-bleed above) - applying this margin at any other width would
       misposition it instead of centering it. */
    margin-left: calc(50% - 50vw);
    margin-right: calc(50% - 50vw);
    border-radius: 0;
  }
</style>
```

- [ ] **Step 6: Delete the dead steps and helpers, and drop `qrcode`**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget rm --ignore-unmatch src/components/SentStep.svelte src/components/DocumentsStep.svelte src/lib/guest-token.ts src/lib/berth-pricing.ts
npm --prefix C:/Users/robert/source/repos/sidon-booking-widget uninstall qrcode
cd C:/Users/robert/source/repos/sidon-booking-widget && grep -rnwE "getBookLabels|guest-token|berth-pricing|qrcode|mountPaymentElement|getContractPreview|createIntent|submitBooking|uploadGuestDoc|getAblyToken|step1Complete" src package.json
```
Expected:
- `git rm` prints `rm '<path>'` for each file that is still tracked.
- `npm uninstall` prints `removed N packages`, and `package.json` no longer lists `qrcode`.
- `grep` prints nothing and exits 1. If it prints a line, an earlier task left a reference behind; fix that reference before going on.
- The pattern leaves out the names `SentStep` and `DocumentsStep` because Task 7's CSS comments mention them. Step 8's `git status` shows those two files as `D`.

- [ ] **Step 7: Type-check, test and build**

```bash
cd C:/Users/robert/source/repos/sidon-booking-widget
npm run check
npm test
npm run build
ls dist/sidon-booking-widget.js dist/sidon-berth-map.js dist/astro-proxy.js
grep -c "booking-id" dist/sidon-booking-widget.js
```
Expected:
- `npm run check`: svelte-check reports `0 errors` and no warnings from the files this task touches. `tsc -p tsconfig.node.json` prints nothing.
- `npm test`: `check-astro-proxy.ts` and `check-ota.ts` both pass and exit 0.
- `npm run build`: finishes with `✓ built`. `ls` lists all three files. `grep -c` prints `1`, which shows the `booking-id` attribute is registered on the element.

- [ ] **Step 8: Commit**

```bash
git -C C:/Users/robert/source/repos/sidon-booking-widget add src/BookingWidget.svelte src/components/DetailsStep.svelte src/components/PaymentStep.svelte src/components/Stepper.svelte src/components/StepNav.svelte src/lib/i18n.ts package.json package-lock.json
git -C C:/Users/robert/source/repos/sidon-booking-widget status --short
git -C C:/Users/robert/source/repos/sidon-booking-widget commit -m "$(cat <<'EOF'
Wizard on OTA: details, payment, booking view

Step 1 puts a 30-minute hold (POST bookings) on the cheapest berth OTA
offers for the dates and boat. Step 2 authorises the card and calls
confirm-payment. Step 3 shows the booking view in place. Back releases
the hold, a saved session resumes at the booking view, and booking-id
turns the element into the site's booking page.

Drops the pre-booking documents/contract steps, the guest-token
helpers, getBookLabels and the qrcode dependency.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected `git status --short` before the commit:
- `M` for `src/BookingWidget.svelte`, `src/components/DetailsStep.svelte`, `src/components/Stepper.svelte`, `src/components/StepNav.svelte`, `src/lib/i18n.ts`, `package.json` and `package-lock.json`.
- `A` for `src/components/PaymentStep.svelte`.
- `D` for `src/components/SentStep.svelte`, `src/components/DocumentsStep.svelte`, and any other file Step 6 removed.
- No other entries.

---

### Task 9: 1.0.0 docs, typings and package hygiene

Repo: `W` = `C:/Users/robert/source/repos/sidon-booking-widget` (Git Bash path `/c/Users/robert/source/repos/sidon-booking-widget`). This task runs after Tasks 2–8. By then `npm test`, `dist/astro-proxy.{js,d.ts}`, `createMarinaClient` and the 1.0 element props exist, and Task 8 has already uninstalled `qrcode`.

**How the typings get into dist:** both element entries are side-effect imports, so vite-plugin-dts produces an empty `export {}` for each. API Extractor, which its `rollupTypes` mode uses, also drops `declare global` blocks. So the typings are written by hand in one file, `src/elements.d.ts`. A new build step, `scripts/write-element-types.mjs`, runs after both vite builds. It copies that file verbatim to `dist/elements.d.ts` and writes `dist/custom-element.d.ts` and `dist/custom-element-berth-map.d.ts`, each containing only `export * from './elements.js';`. There is one shared copy rather than one per entry: with two copies, a page importing both entries would declare the same global `HTMLElementTagNameMap` keys twice, with two distinct types. vite-plugin-dts and `scripts/rename-berth-map-types.mjs` existed only to produce those empty files, so this task deletes them.

**Files:**
- Create: `W/src/elements.d.ts`
- Create: `W/scripts/write-element-types.mjs`
- Delete: `W/scripts/rename-berth-map-types.mjs`
- Delete: `W/public/favicon.svg`. Vite copies `public/` into `dist/`, so the favicon shipped in the package. Dev uses the root `demo/`, so nothing serves it.
- Modify: `W/vite.config.ts`. Line numbers are as of 0.4.17; Task 2 only changes line 1 and the serve branch.
  - line 3: remove the `dts` import
  - lines 9-12: build-mode header comment
  - lines 29-32: build `plugins`
- Modify: `W/vite.berth-map.config.ts`
  - line 3: remove the `dts` import
  - lines 12-20: header comment
  - lines 24-27: `plugins`
- Modify: `W/package.json`
  - `version` (line 3)
  - `description` (line 4)
  - the `build` script, as Task 3 left it
  - merge `dependencies` into `devDependencies`
  - remove `vite-plugin-dts`
- Modify: `W/package-lock.json` (only through npm)
- Rewrite: `W/README.md`

**Interfaces:**
- Consumes:
  - From Task 3: `createMarinaProxy({ otaBaseUrl, keys, timeoutMs = 60000 })`; `dist/astro-proxy.{js,d.ts}`, built by `tsc -p tsconfig.proxy.json` as the last build step; and `exports["./astro-proxy"]`.
  - From Task 4: `createMarinaClient({ otaBaseUrl, keys })`, which returns `{ slugs, getMarina(slug, {from,to}?), getDocRequirements(slug) }`, and the exported class `MarinaClientError` (`.status`).
  - From Tasks 3/5: `npm test`; from Task 2: `npm run check` (0 errors, from Task 8 on).
  - From Tasks 6–8: element props and events per R1/R5/R7/R9–R13/R16.
    - The booking-page prop is `bookingId` (attribute `booking-id`, type String, `string | null`).
    - `sidon-loa-change` is not dispatched in booking-page mode.
    - `qrcode` has been uninstalled.
  - From Task 1: OTA `scripts/seed-marina-demo.js`.
- Produces:
  - `dist/elements.d.ts`, exporting `OtherMarina`, `SidonBookingStatus`, `SidonStepChangeDetail`, `SidonLoaChangeDetail`, `SidonBookedDetail`, `SidonBookingStatusDetail`, `SidonBerthSelectedDetail`, `SidonQuickbookSubmitDetail`, `SidonBookingWidgetElement` and `SidonBerthMapElement`.
  - Global `HTMLElementTagNameMap` and `HTMLElementEventMap` entries.
  - Both entry `.d.ts` files re-export `dist/elements.d.ts`.
  - `@forgebuild/sidon-booking-widget@1.0.0`, with no `dependencies`.

- [ ] **Step 1: Write the failing consumer check (scratch dir, outside the repo)**

Pack the current build, install the tarball into a scratch consumer, and type-check it the way an Astro site uses the package: the README's forwarder map form and server client, `skipLibCheck: false`, and bundler resolution.

```bash
W=/c/Users/robert/source/repos/sidon-booking-widget
S=/tmp/sbw-consumer
cd "$W" && npm run build
rm -rf "$S" && mkdir -p "$S"
cat > "$S/check.ts" <<'EOF'
// Scratch consumer: type-checks the packed package the way a site uses it.
import '@forgebuild/sidon-booking-widget';
import '@forgebuild/sidon-booking-widget/berth-map';
import type { SidonBookingWidgetElement, SidonBerthMapElement, SidonBookingStatus } from '@forgebuild/sidon-booking-widget';
import { createMarinaProxy, createMarinaClient, MarinaClientError } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Without the HTMLElementTagNameMap entries these are Element | null and don't assign.
const widget: SidonBookingWidgetElement | null = document.querySelector('sidon-booking-widget');
const map: SidonBerthMapElement | null = document.querySelector('sidon-berth-map');

if (map) map.otherMarinas = [{ name: 'Pevero Mooring', lat: 41.117, lng: 9.394, logoMark: null, href: '/pevero' }];
widget?.addEventListener('sidon-booked', (e) => console.log(e.detail.bookingId.toUpperCase()));
widget?.addEventListener('sidon-booking-status', (e) => { const s: SidonBookingStatus = e.detail.status; console.log(s); });
map?.addEventListener('sidon-quickbook-submit', (e) => { const berth: string | null = e.detail.berth; console.log(berth); });

// The README's forwarder route (map form) and server client.
const proxy = createMarinaProxy({ otaBaseUrl: 'https://ota.example.com', keys: { 'fox-mooring': 'key-1', 'pevero-mooring': 'key-1' } });
export const GET = proxy;
export const POST = proxy;
const client = createMarinaClient({ otaBaseUrl: 'https://ota.example.com', keys: 'key-1' });
export const slugs: string[] = client.slugs;
export const marina = client.getMarina('fox-mooring', { from: '2026-06-01', to: '2026-06-08' });
export const requirements = client.getDocRequirements('fox-mooring');
export const isRateLimited = (err: unknown) => err instanceof MarinaClientError && err.status === 429;
EOF
cat > "$S/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false,
    "target": "es2023",
    "lib": ["es2023", "dom"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": []
  },
  "files": ["check.ts"]
}
EOF
cd "$W" && npm pack --pack-destination "$S"
cd "$S" && npm init -y >/dev/null && npm install --no-audit --no-fund ./forgebuild-sidon-booking-widget-*.tgz
node "$W/node_modules/typescript/bin/tsc" -p "$S"
```

Expected:
- `npm install` prints `added N packages` with N > 1, because `ably`, `@stripe/stripe-js` and `flatpickr` are installed with it.
- `tsc` exits 2 with:

```
check.ts(4,15): error TS2305: Module '"@forgebuild/sidon-booking-widget"' has no exported member 'SidonBookingWidgetElement'.
check.ts(4,42): error TS2305: Module '"@forgebuild/sidon-booking-widget"' has no exported member 'SidonBerthMapElement'.
check.ts(4,64): error TS2305: Module '"@forgebuild/sidon-booking-widget"' has no exported member 'SidonBookingStatus'.
check.ts(12,43): error TS7006: Parameter 'e' implicitly has an 'any' type.
check.ts(13,51): error TS7006: Parameter 'e' implicitly has an 'any' type.
check.ts(14,50): error TS7006: Parameter 'e' implicitly has an 'any' type.
```

- [ ] **Step 2: Write the hand-written element typings**

Create `W/src/elements.d.ts`:

```ts
// Hand-written typings for <sidon-booking-widget> and <sidon-berth-map>.
// The entry modules only register the elements (side-effect imports), so
// generated declarations come out as an empty `export {}`. The build copies
// this file verbatim to dist/elements.d.ts and both entry .d.ts files
// re-export it (scripts/write-element-types.mjs), which is why it imports
// nothing: a relative import would dangle in dist/.
//
// Keep it in step with the `props` blocks in BookingWidget.svelte and
// BerthMap.svelte and the events they emit. `npm run check` skips .d.ts
// files (skipLibCheck), so check an edit with:
//   npx tsc --ignoreConfig --noEmit --skipLibCheck false --lib es2023,dom src/elements.d.ts

/** Peer-marina logo pin. Mirrors OtherMarina in lib/types.ts. */
export interface OtherMarina {
  name: string;
  lat: number;
  lng: number;
  logoMark: string | null;
  /** Always host-supplied: the package owns no site's routing. */
  href: string | null;
}

/** OTA booking status. An expired booking reports `cancelled`. */
export type SidonBookingStatus = 'hold' | 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface SidonStepChangeDetail { step: 1 | 2 | 3 }
/** The booking widget fires this from the wizard only, never in booking-page mode. */
export interface SidonLoaChangeDetail { loa: number }
/** `bookingId` is OTA's booking UUID, `marina` the marina slug. */
export interface SidonBookedDetail { bookingId: string; marina: string }
export interface SidonBookingStatusDetail { bookingId: string; status: SidonBookingStatus }
/** A berth label, or null when deselected. */
export interface SidonBerthSelectedDetail { berthId: string | null }
/** Dates are `YYYY-MM-DD`; `berth` is a berth label. */
export interface SidonQuickbookSubmitDetail { from: string | null; to: string | null; length: number; berth: string | null }

// Element properties mirror the attributes, camelCased; optional like them.
export interface SidonBookingWidgetElement extends HTMLElement {
  /** OTA marina slug. */
  marina?: string;
  /** '' (default) = this page's origin, where the forwarder route lives. */
  apiOrigin?: string;
  from?: string;
  to?: string;
  length?: number;
  berth?: string;
  locale?: string;
  currencySymbol?: string;
  variant?: 'navy' | 'dark';
  /** Present (even empty) = booking-page mode; a value overrides `?booking=`. */
  bookingId?: string | null;
  mapsApiKey?: string;
  mapStyle?: 'chart' | 'coastal';
  mapHeight?: string;
  mapWidth?: string;
  mapGap?: string;
  width?: string;
  logoMark?: string | null;
  marinaName?: string;
  otherMarinas?: OtherMarina[];
}

export interface SidonBerthMapElement extends HTMLElement {
  /** OTA marina slug. */
  marina?: string;
  mapsApiKey?: string;
  /** '' (default) = this page's origin, where the forwarder route lives. */
  apiOrigin?: string;
  mapStyle?: 'chart' | 'coastal';
  locale?: string;
  currencySymbol?: string;
  from?: string;
  to?: string;
  length?: number;
  berth?: string;
  bookPath?: string;
  logoMark?: string | null;
  marinaName?: string;
  otherMarinas?: OtherMarina[];
  mapHeight?: string;
  showWeather?: boolean;
  eyebrow?: string;
  cardTitle?: string;
  intro?: string;
  rangeLabel?: string;
  rangePlaceholder?: string;
  lengthLabel?: string;
  selectedLabel?: string;
  selectedPlaceholder?: string;
  ctaLabel?: string;
}

declare global {
  interface HTMLElementTagNameMap {
    'sidon-booking-widget': SidonBookingWidgetElement;
    'sidon-berth-map': SidonBerthMapElement;
  }
  // Dispatched with bubbles + composed, so listeners on any ancestor
  // element get the typed detail too.
  interface HTMLElementEventMap {
    'sidon-step-change': CustomEvent<SidonStepChangeDetail>;
    'sidon-loa-change': CustomEvent<SidonLoaChangeDetail>;
    'sidon-booked': CustomEvent<SidonBookedDetail>;
    'sidon-booking-status': CustomEvent<SidonBookingStatusDetail>;
    'sidon-berth-selected': CustomEvent<SidonBerthSelectedDetail>;
    'sidon-quickbook-submit': CustomEvent<SidonQuickbookSubmitDetail>;
  }
}
```

Run:

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget && npx tsc --ignoreConfig --noEmit --skipLibCheck false --lib es2023,dom src/elements.d.ts; echo "exit $?"
```

Expected: `exit 0` and no other output. TS 6 needs `--ignoreConfig` when files are passed on the command line and a `tsconfig.json` is present.

- [ ] **Step 3: Ship the typings in the build; drop vite-plugin-dts, the rename script and the favicon**

Create `W/scripts/write-element-types.mjs`:

```js
// The element entries only register custom elements (side-effect imports),
// so generated declarations would be an empty `export {}`. Ship the
// hand-written src/elements.d.ts instead: one copy at dist/elements.d.ts,
// re-exported by both entry declaration files. One copy, not one per entry,
// because a page importing both entries would otherwise declare the same
// global HTMLElementTagNameMap keys twice with two distinct types.
// Runs after both vite builds: the berth-map build empties dist/.
import { copyFileSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
copyFileSync(new URL('../src/elements.d.ts', import.meta.url), new URL('elements.d.ts', dist));
for (const entry of ['custom-element.d.ts', 'custom-element-berth-map.d.ts']) {
  writeFileSync(new URL(entry, dist), "export * from './elements.js';\n");
}
```

Delete the old rename step and the shipped favicon:

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget && rm scripts/rename-berth-map-types.mjs public/favicon.svg
```

`W/vite.config.ts`, imports:

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import dts from 'vite-plugin-dts';
import { fileURLToPath } from 'node:url';
```
→
```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
```

`W/vite.config.ts`, header comment:

```ts
//  - `vite build`: library build producing a single self-contained ES module
//    (Svelte runtime bundled in — consumers have no peer dependency) plus
//    a .d.ts, so the widget works both as an npm import and as a plain
//    <script type="module"> include.
```
→
```ts
//  - `vite build`: library build producing a single self-contained ES module
//    (Svelte runtime bundled in — consumers have no peer dependency), so the
//    widget works both as an npm import and as a plain <script type="module">
//    include. No .d.ts is generated: the entry is a side-effect import, so
//    the typings are hand-written (src/elements.d.ts, copied to dist/ by
//    scripts/write-element-types.mjs).
```

`W/vite.config.ts`, build branch:

```ts
    plugins: [
      svelte(svelteOptions),
      dts({ rollupTypes: true, entryRoot: 'src', tsconfigPath: './tsconfig.app.json' }),
    ],
    build: {
```
→
```ts
    plugins: [svelte(svelteOptions)],
    build: {
```

`W/vite.berth-map.config.ts`, imports:

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import dts from 'vite-plugin-dts';
import { fileURLToPath } from 'node:url';
```
→
```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
```

`W/vite.berth-map.config.ts`, header comment:

```ts
// This build runs FIRST in package.json's `build` script (before the main
// `vite.config.ts` build), on a freshly emptied `dist/` — hence
// `emptyOutDir: true` here. It must run first because vite-plugin-dts's
// `rollupTypes` mode resolves its declaration output path from package.json's
// shared "types" field, so both builds' .d.ts output lands at the same
// dist/custom-element.d.ts regardless of this config's own `outDir`/`fileName`.
// package.json's `build` script relocates this build's colliding output to
// dist/custom-element-berth-map.d.ts (via scripts/rename-berth-map-types.mjs)
// before the widget build runs and writes the real dist/custom-element.d.ts.
```
→
```ts
// This build runs FIRST in package.json's `build` script (before the main
// `vite.config.ts` build), on a freshly emptied `dist/` — hence
// `emptyOutDir: true` here and `false` there, so the second build keeps
// this one's output.
```

`W/vite.berth-map.config.ts`, plugins:

```ts
  plugins: [
    svelte(svelteOptions),
    dts({ rollupTypes: true, entryRoot: 'src', tsconfigPath: './tsconfig.app.json' }),
  ],
```
→
```ts
  plugins: [svelte(svelteOptions)],
```

`W/package.json`, `build` script. The old line is the one Task 3 left. `tsc` stays last (R17):

```json
    "build": "vite build --config vite.berth-map.config.ts && node scripts/rename-berth-map-types.mjs && vite build && tsc -p tsconfig.proxy.json",
```
→
```json
    "build": "vite build --config vite.berth-map.config.ts && vite build && node scripts/write-element-types.mjs && tsc -p tsconfig.proxy.json",
```

Run:

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget && npm run build && ls dist && cat dist/custom-element.d.ts dist/custom-element-berth-map.d.ts
```

Expected:
- `ls dist` lists exactly `astro-proxy.d.ts  astro-proxy.js  custom-element-berth-map.d.ts  custom-element.d.ts  elements.d.ts  sidon-berth-map.js  sidon-booking-widget.js`. `favicon.svg` is not there.
- `export * from './elements.js';` is printed twice.

- [ ] **Step 4: Package hygiene (version, description, no runtime dependencies)**

`W/package.json`, description:

```json
  "description": "Drop-in berth booking widget (custom element) backed by sidon-ai's public marina API.",
```
→
```json
  "description": "Berth booking and berth map custom elements for marinas on OTA, plus an Astro forwarder route and server client.",
```

Then run:

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget
npm version 1.0.0 --no-git-tag-version
npm uninstall vite-plugin-dts
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
// Both element bundles inline every dependency (external: []), so consumers need none at runtime.
const all = { ...p.devDependencies, ...p.dependencies };
p.devDependencies = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
delete p.dependencies;
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
npm install --no-audit --no-fund
npm ls --omit=dev
grep -cE '"dependencies"|qrcode' package.json
```

Expected:
- `npm version` prints `v1.0.0`.
- `npm uninstall` exits 0.
- `npm ls --omit=dev` prints `@forgebuild/sidon-booking-widget@1.0.0 C:\Users\robert\source\repos\sidon-booking-widget` followed by `(empty)`.
- The final grep prints `0`. This confirms there is no `dependencies` block and that Task 8's `qrcode` removal held.

Deliberately left alone: `license` stays `UNLICENSED`, and no `repository` field is added. Both are the owner's call at publish.

- [ ] **Step 5: Rewrite README.md for 1.0**

Replace `W/README.md` with:

````markdown
# @forgebuild/sidon-booking-widget

Drop-in berth booking for marinas on OTA. The package provides two
[custom elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components) compiled from
Svelte, plus a server entry for Astro sites.

| Import | What it is |
|---|---|
| `@forgebuild/sidon-booking-widget` | `<sidon-booking-widget>`: the booking wizard, and the booking page guests come back to |
| `@forgebuild/sidon-booking-widget/berth-map` | `<sidon-berth-map>`: a Google map of the marina's berths with a quick-book card |
| `@forgebuild/sidon-booking-widget/astro-proxy` | `createMarinaProxy` (the forwarder route) and `createMarinaClient` (server-side reads) |

Each element is one self-contained ES module. The Svelte runtime and every npm dependency are
bundled in, so an element works on any page with one import and one tag.

The elements never call OTA directly. They call `/api/marina/guest/…` on the page's own origin. A
forwarder route there adds the OTA API key and passes the request on, so the key never reaches the
browser.

```
browser      <sidon-booking-widget> / <sidon-berth-map>
               │  /api/marina/guest/{slug}/…  (same origin)
               ▼
your site    src/pages/api/marina/guest/[...path].ts  (createMarinaProxy adds X-Api-Key)
               ▼
OTA          /api/marina/guest/{slug}/…

your server and build code ── createMarinaClient (X-Api-Key) ──► OTA
```

## Install

```bash
npm install @forgebuild/sidon-booking-widget@^1.0.0
```

The package is public on npm, so you need no registry config or token. It has no runtime
dependencies.

The forwarder and any server code read two variables from the server environment. If a
prerendered page reads marina data, the build needs them too; see
[Build-time reads](#build-time-reads).

```
OTA_BASE_URL=https://ota.example.com   # OTA's API origin
OTA_API_KEY=…                          # the OTA property's API key
```

## The forwarder route

Every site that shows either element needs this route, at exactly this path. The elements build
their URLs as `/api/marina/guest/{slug}/…`.

```ts
// src/pages/api/marina/guest/[...path].ts
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Astro finds this by reading this file's source text, so it has to be
// written out here; re-exporting it from a package doesn't work.
export const prerender = false;

const proxy = createMarinaProxy({
  otaBaseUrl: import.meta.env.OTA_BASE_URL,
  keys: import.meta.env.OTA_API_KEY,
});

export const GET = proxy;
export const POST = proxy;
```

The route works with `output: 'server'`. It also works with `output: 'static'` plus an adapter. On
a static site, the literal `prerender = false` is what makes the route run on demand.

**Marinas on several OTA properties.** Each property has its own key, so pass a map from marina
slug to key. The first path segment (the slug) picks the key. An unknown slug gets a 404, and each
slug can appear only once.

```ts
const proxy = createMarinaProxy({
  otaBaseUrl: import.meta.env.OTA_BASE_URL,
  keys: {
    'fox-mooring': import.meta.env.OTA_API_KEY_SARDINIA,
    'pevero-mooring': import.meta.env.OTA_API_KEY_SARDINIA,
    'pirates-bight': import.meta.env.OTA_API_KEY_BVI,
  },
});
```

What the forwarder does:

- **Routes.** It forwards `GET`, `HEAD` (sent on as `GET`) and `POST` requests under
  `/api/marina/guest/` only. Any other path gets a 404. So does a path with an empty, `.` or `..`
  segment, or with a `\`, `%` or control character in it.
- **Request headers.** It passes on only `Content-Type`, `X-File-Name`, `X-Booking-Token` and
  `User-Agent`, and never cookies. It adds `X-Api-Key`. It also adds `X-Client-Ip`, taken from
  Astro's `clientAddress`, so OTA rate-limits each visitor rather than the whole site. If the
  adapter provides no client address, the header is left out.
- **Errors.**
  - A body over 4.5 MB gets a 413.
  - If OTA is unreachable or answers with a redirect, the forwarder returns 502.
  - If OTA doesn't answer within `timeoutMs` (default `60000`), it returns 504.
- **Response.** It answers with a new `Response`. That response carries only OTA's
  `Content-Type`, `Cache-Control`, `Retry-After` and `RateLimit*` headers, so middleware that adds
  headers (such as Clerk's) keeps working.

The forwarder passes on every guest route, so a site's own enquiry form can post through it too,
to `/api/marina/guest/{slug}/enquiries`.

**OTA's limits**, per visitor IP:

- 10 bookings, 30 document uploads and 10 enquiries an hour
- 100 requests a minute
- at most 3 upcoming bookings per email address

Over a limit, OTA answers 429 and the elements show its message.

## Server-side reads: `createMarinaClient`

```ts
// src/lib/marina.ts (server only)
import { createMarinaClient } from '@forgebuild/sidon-booking-widget/astro-proxy';

export const marinaClient = createMarinaClient({
  otaBaseUrl: import.meta.env.OTA_BASE_URL,
  keys: import.meta.env.OTA_API_KEY, // or the same slug → key map as the forwarder
});
```

```astro
---
import { marinaClient } from '../lib/marina';

const data = await marinaClient.getMarina('fox-mooring', { from: '2026-06-01', to: '2026-06-08' });
if (!data) return new Response(null, { status: 404 });
const { marina, berths, price_tiers, currency } = data;
---
```

- `getMarina(slug, { from, to }?)` returns OTA's payload unchanged, in snake_case: `marina`,
  `pontoons`, `berths`, `price_tiers`, `pois`, `images`, `currency` and
  `stripe_publishable_key`. It returns `null` when OTA answers 404.
  - Each berth's `available` flag covers `[from, to)`, or today if you pass no dates.
  - NUMERIC values (`length_m`, `price_per_night`, …) arrive as strings, so wrap them in
    `Number()`.
- `getDocRequirements(slug)` returns the marina's active document requirements as OTA sends them.
  It returns `null` on a 404.
- `slugs` lists the slugs of a `keys` map, or `[]` for a single key. Use it in
  `getStaticPaths`, for example.
- Any other error status throws a `MarinaClientError` (also exported). Its `status` property holds
  the HTTP status.

### Build-time reads

A prerendered page reads OTA from the build machine. So `OTA_BASE_URL` and `OTA_API_KEY` must be
set in the build environment as well as at runtime.

Build reads carry no visitor IP, so all of a build's reads share the key's budget of 100 requests a
minute. The client retries a 429 up to 3 times. Before each retry it waits `Retry-After` seconds,
capped at 30, or 5 seconds when OTA sends no `Retry-After`.

The client caches nothing. When many pages read the same marina, read it once per build:

```ts
const marinas = new Map<string, ReturnType<typeof marinaClient.getMarina>>();
export function getMarinaOnce(slug: string) {
  if (!marinas.has(slug)) marinas.set(slug, marinaClient.getMarina(slug));
  return marinas.get(slug)!;
}
```

## `<sidon-booking-widget>`

```astro
<sidon-booking-widget marina="fox-mooring" locale="it"></sidon-booking-widget>

<script>
  import '@forgebuild/sidon-booking-widget';
</script>
```

Astro doesn't need the `@astrojs/svelte` integration for this, because a custom element is just
an HTML tag. Without a bundler, load `dist/sidon-booking-widget.js` with `<script type="module">`.

The wizard has three steps:

1. **Details**: dates, boat length and berth (with an optional map), then the guest's contact and
   boat details. *Next* puts a 30-minute hold on the berth.
2. **Payment**: Stripe's Payment Element. The card is authorised at this step and captured when the
   marina confirms the booking. The authorisation is released if the booking is declined, cancelled
   or expires.
   - This step appears only when the stay has a price and the property has both Stripe keys.
   - Otherwise OTA emails the guest a confirm link, and the hold waits 30 minutes for it.
   - *Back* cancels the hold.
3. **Booking**: the [booking view](#the-booking-page), shown in place.

The widget keeps the booking's id and token in `sessionStorage`, per marina. After a reload it
shows the booking view again, with a *Start a new booking* action.

### Attributes

| Attribute | Default | Description |
|---|---|---|
| `marina` | required | The marina's OTA slug. |
| `api-origin` | `''` (this page's origin) | Where the forwarder route lives. Leave it unset. The forwarder sends no CORS headers, so another origin works only if you add them. |
| `from` / `to` | today / +3 nights | Initial `YYYY-MM-DD` range. |
| `length` | `15` | Initial boat length in metres. |
| `berth` | | Pre-selected berth label. It's used only if that berth is free and the boat fits. Otherwise the widget picks the cheapest free berth that fits, and the shorter berth on a tie. |
| `locale` | `en` | `en`, `it`, `fr` or `es`. Only the first two letters count (`it-IT` is `it`), and any other value means `en`. It also sets the language of OTA's emails about the booking. |
| `currency-symbol` | `''` | When empty, amounts are formatted in the marina's currency with `Intl.NumberFormat`. Set it, to `$` for example, to show that fixed symbol before amounts instead. |
| `variant` | `navy` | `navy` or `dark`; see [Theming](#theming). |
| `booking-id` | absent | When present, the element is in [booking-page mode](#the-booking-page). A value overrides the booking id in the URL. |
| `maps-api-key` | | Google Maps JS API key. The map renders only when this is set. It never renders on step 3 or in booking-page mode. |
| `map-style` | `chart` | `chart` (buoy circles) or `coastal` (SVG pontoon overlays). |
| `map-height` / `map-width` / `map-gap` | `280px` / `100%` / `0px` | The map's size, and the gap below it. `map-width="100vw"` breaks the map out of the card. |
| `width` | `560px` | The element's max width, read once at mount. |
| `logo-mark` / `marina-name` | | The marina's logo pin on the map. |
| `otherMarinas` (JS property) | `[]` | Peer-marina pins; see [`otherMarinas`](#othermarinas-js-property). |

The attributes set only the starting state. The widget never rewrites the host page's URL, except
to remove `token` from the booking page's URL. If the page needs to follow the widget's state,
listen for the events.

### Events

The element dispatches these events with `bubbles: true, composed: true`, so they cross the shadow
root and can be caught anywhere on the page:

| Event | `detail` | When |
|---|---|---|
| `sidon-step-change` | `{ step: 1 \| 2 \| 3 }` | On mount and at every step change (1 Details, 2 Payment, 3 Booking). |
| `sidon-loa-change` | `{ loa: number }` | On mount and whenever the boat length changes (wizard only; not in booking-page mode). |
| `sidon-booked` | `{ bookingId: string, marina: string }` | Once, on reaching step 3. `bookingId` is OTA's booking UUID and `marina` is the slug. The booking is then `pending` (card authorised) or a `hold` (waiting for the emailed confirm link). |
| `sidon-booking-status` | `{ bookingId: string, status: string }` | Whenever the status changes after the booking view first loads, on step 3 or in booking-page mode. The status is `hold`, `pending`, `confirmed`, `declined` or `cancelled`. An expired booking reports `cancelled`. |

### Removed in 1.0

- **Documents and the contract** are no longer in the wizard. They need the booking's token, so
  they're in the booking view now. The contract preview before booking, and filling the details
  form from a scanned document, are gone.
- **The QR code on the confirmation step.** Once the marina has a `booking_url`, OTA's emails carry
  the booking-page link and its QR code.
- **Per-marina email branding.** OTA's emails use the property's branding.
- **The old defaults.** `api-origin` used to default to `https://sidonmarine.uk`, and
  `currency-symbol` to `€`.

## The booking page

Each site hosts one page per marina where guests follow and manage their booking. OTA's emails
link to this page, and OTA's email confirm link redirects to it.

```astro
---
// src/pages/berths/booking.astro: a bare page, no analytics or tag manager
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your berth booking</title>
  </head>
  <body>
    <sidon-booking-widget marina="fox-mooring" booking-id></sidon-booking-widget>
    <script>
      import '@forgebuild/sidon-booking-widget';
    </script>
  </body>
</html>
```

The page can be prerendered or rendered on demand. In the browser, the widget reads
`?booking=&token=` from the URL and keeps both values in `sessionStorage`. It then removes `token`
from the address bar with `history.replaceState`.

Requirements:

1. **The marina's `booking_url`** must be exactly `<page URL>?booking={id}&token={token}`, for
   example `https://www.example.com/berths/booking?booking={id}&token={token}`.
   - Set it with `PUT /api/marina/marinas/:id` and the body `{ "booking_url": "…" }`. OTA rejects a
     URL that lacks either placeholder.
   - Until it's set, guest emails carry no booking link, and the confirm link ends on a plain OTA
     page.
2. **`Referrer-Policy: no-referrer`**, because the URL carries the booking token. Set it in one of
   two ways:
   - The `<meta name="referrer">` tag shown above. Put it near the top of `<head>`, so it comes
     before anything loads.
   - The response header. On an on-demand page, call
     `Astro.response.headers.set('Referrer-Policy', 'no-referrer')`. On Vercel, you can add a
     `headers` rule in `vercel.json` instead.
3. **No third-party scripts except Stripe's, and no analytics.**
   - Analytics and tag managers record the full URL, token included, before the widget can remove
     the token. For example, GTM's `page_location` keeps the query string.
   - On this page the widget itself loads only Stripe.js, and opens an Ably connection for live
     status.
   - It never loads Google Maps or weather on this page, even with `maps-api-key` set.

The booking view shows:

- the status (hold, pending, confirmed, declined, cancelled or expired) and the booking's details
- card payment to finish the booking, while it's a `hold` with a card payment
- "check your email" and the hold's expiry time, for a `hold` without a card payment
- an upload for each of the marina's document requirements, while the booking is pending or
  confirmed
- the marina's contract to read and agree to, if the marina has one
- a cancel action, while the booking is a hold or pending

The status updates live over Ably. When Ably isn't available, the view polls every 30 seconds
instead.

## `<sidon-berth-map>`

```astro
<sidon-berth-map
  marina="fox-mooring"
  maps-api-key={import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY}
  map-style="chart"
  book-path="/services/book"
></sidon-berth-map>

<script>
  import '@forgebuild/sidon-booking-widget/berth-map';
</script>
```

This element shows a map of the marina's berths, as buoy circles or SVG pontoon overlays. A
floating quick-book card on the map has dates, boat length, the selected berth and a submit button.
The element reads the marina through the same forwarder.

- In either style, guests can't pick a booked berth or one under maintenance.
- If a pontoon SVG has a berth label that OTA doesn't list, that berth counts as unavailable.
- The card's total, and its automatic pick (the cheapest free berth that fits), come from OTA's
  availability route. So the price shown is the price charged.

### Attributes

| Attribute | Default | Description |
|---|---|---|
| `marina` | required | The marina's OTA slug. |
| `maps-api-key` | required | Google Maps JS API key. |
| `api-origin` | `''` | Same as for `<sidon-booking-widget>`. |
| `map-style` | `chart` | `chart` (buoy circles) or `coastal` (SVG pontoon overlays). |
| `map-height` | `480px` | Map height. |
| `show-weather` | absent | Boolean. Adds a weather panel (Open-Meteo). |
| `locale` / `currency-symbol` | `en` / `''` | Same as for `<sidon-booking-widget>`. |
| `from` / `to` / `length` / `berth` | today / +1 night / `15` / none | Initial state, same as for `<sidon-booking-widget>`. |
| `book-path` | | If set, submitting the card navigates here with `from`, `to`, `length` and `berth` query parameters. A `sidon-quickbook-submit` listener can call `preventDefault()` to stop the navigation. Without `book-path`, the element only fires the event and the host page handles routing. |
| `logo-mark` / `marina-name` | | The marina's logo pin at the map centre. |
| `eyebrow` / `card-title` / `intro` | | Optional heading lines above the card's fields. Each is left out when unset. The attribute is `card-title` rather than `title` because `title` would show the browser's tooltip. |
| `range-label` / `range-placeholder` / `length-label` / `selected-label` / `selected-placeholder` / `cta-label` | "Arrival – Departure", "", "Boat length (m)", "Selected buoy", "Tap a buoy", "Book a mooring" | The card's copy. |

### `otherMarinas` (JS property)

Peer-marina logo pins. This is structured data, so set it as a JS property rather than an HTML
attribute:

```ts
document.querySelector('sidon-berth-map')!.otherMarinas = [
  { name: 'Pevero Mooring', lat: 41.117, lng: 9.394, logoMark: 'https://…/pevero-mark.svg', href: '/m/pevero-mooring/berths' },
];
```

The host page always supplies `href`. The package doesn't know any site's routes, so it never
builds peer-marina links itself.

### Events

These events also use `bubbles: true, composed: true`:

- `sidon-berth-selected` sends `{ berthId: string | null }`: the berth label, or `null` when the
  berth is deselected.
- `sidon-loa-change` sends `{ loa: number }`. It has the same name and shape as the booking
  widget's event, so one listener covers both elements.
- `sidon-quickbook-submit` sends `{ from, to, length, berth }` and is dispatched with
  `cancelable: true`.

## TypeScript

Both entries ship typings for the elements:

- `document.querySelector('sidon-booking-widget')` returns a `SidonBookingWidgetElement`.
- `document.querySelector('sidon-berth-map')` returns a `SidonBerthMapElement`.
- Listeners on these elements get typed event details.

```ts
document.querySelector('sidon-berth-map')?.addEventListener('sidon-quickbook-submit', (e) => {
  console.log(e.detail.from, e.detail.to, e.detail.length, e.detail.berth);
});
```

You can also import the element and detail types:

```ts
import type { SidonBerthMapElement, SidonQuickbookSubmitDetail } from '@forgebuild/sidon-booking-widget';
```

## Theming

Both elements render in a shadow root with their own CSS. They don't depend on the host page's
stylesheet and don't clash with it. Brand colours and fonts reach inside as inherited CSS custom
properties:

```css
sidon-booking-widget,
sidon-berth-map {
  --brand-navy: #0e3a3e;
  --brand-gold: #d49a3c;
  --brand-ink: #0e3a3e; /* dark card surface */
  --brand-font-title: 'Teko', sans-serif; /* berth-map card heading */
  --brand-font-body: 'Hind', sans-serif; /* berth-map card and weather panel */
}
```

When these are unset, the elements use `#16365b` navy, `#c9a86b` gold, `#252525` ink and a system
sans-serif font.

On `<sidon-booking-widget>`, the `variant` attribute switches the buttons and document rows
between two styles:

- `navy` (the default): gold buttons that turn navy on hover, with rounded corners.
- `dark`: solid `--brand-ink` buttons that turn gold on hover, with square corners.

## Migrating from 0.4.x / 0.2.x

Earlier versions talked to sidon-ai:

- 0.2.x and 0.4.16 were published as `@robooko/sidon-booking-widget` on GitHub Packages.
- 0.4.17 was published as `@forgebuild/sidon-booking-widget`.

1.0 talks to OTA through your own forwarder. To migrate:

1. **Package.** From `@robooko`:
   ```bash
   npm uninstall @robooko/sidon-booking-widget
   npm install @forgebuild/sidon-booking-widget@^1.0.0
   ```
   - Change every `@robooko/sidon-booking-widget` import, including `/berth-map`, to
     `@forgebuild/sidon-booking-widget`.
   - Delete the `@robooko:registry=https://npm.pkg.github.com` and
     `//npm.pkg.github.com/:_authToken=…` lines from `.npmrc`. If the file is then empty, delete
     it.

   From 0.4.17, just run `npm install @forgebuild/sidon-booking-widget@^1.0.0`.
2. **Forwarder.** Add [the forwarder route](#the-forwarder-route), and set `OTA_BASE_URL` and
   `OTA_API_KEY`.
3. **`marina`.** Replace the sidon-ai `ownerId` (`org_…`) with the marina's OTA slug.
4. **`api-origin`.** Remove it. If it still points at sidon-ai (`https://sidonmarine.uk`), every
   call goes there and the elements show a load error.
5. **`currency-symbol`.** Remove it to format amounts in the marina's currency, or keep it to force
   a prefix. It no longer defaults to `€`.
6. **Booking page.** Documents and the contract moved out of the wizard into the booking view.
   Host [the booking page](#the-booking-page) and set the marina's `booking_url`. Without that page,
   a guest who closes the tab has nowhere to upload documents or agree to the contract.
7. **Events.**
   - `sidon-booked`'s `bookingId` is now OTA's UUID string.
   - `sidon-booking-status` reports every OTA status: `hold`, `pending`, `confirmed`, `declined` and
     `cancelled`. It used to report only `confirmed` and `cancelled`, and it didn't exist in 0.2.x.
     It now also fires on the booking page.
   - `sidon-loa-change` doesn't fire in booking-page mode.
   - The wizard steps are now 1 Details, 2 Payment, 3 Booking.
   - Berth ids are still berth labels, in `berth`, `sidon-berth-selected` and
     `sidon-quickbook-submit`.
8. **Server-side reads.** Replace direct fetches of sidon-ai's `/api/marina/public/{ownerId}` with
   [`createMarinaClient`](#server-side-reads-createmarinaclient).
   - Its payload is in OTA's snake_case (`marina.lat`, `berths[].label`, `available`, `length_m`),
     not sidon-ai's camelCase (`profile.lat`, `berthId`, `status`, `lengthM`).
   - NUMERIC values come back as strings.

## Development

```bash
npm install
npm run dev      # vite dev server for demo/, importing the same src/ entries consumers get
npm run check    # svelte-check and tsc; must report 0 errors
npm test         # node assert scripts in scripts/ (astro-proxy and the OTA adapter)
npm run build    # dist/
```

`npm run build` runs four steps in order:

1. The `<sidon-berth-map>` build (`vite.berth-map.config.ts`), which empties `dist/`.
2. The `<sidon-booking-widget>` build (`vite.config.ts`).
3. `scripts/write-element-types.mjs`, which copies the hand-written `src/elements.d.ts` to
   `dist/elements.d.ts` and writes the two entry `.d.ts` files that re-export it.
4. `tsc -p tsconfig.proxy.json`, which writes `dist/astro-proxy.js` and its `.d.ts`.

The demo runs against a local OTA:

1. Create the demo marina with OTA's `node scripts/seed-marina-demo.js`, which prints the API key.
2. Put `OTA_DEMO_API_KEY=<key>` in `demo/.env.local`. If OTA isn't on `http://localhost:3000`, add
   `OTA_DEMO_BASE_URL` too.

The dev server then acts as the forwarder.

## Publishing

```bash
npm login                          # an npm account with publish rights on @forgebuild
npm version <patch|minor|major>    # bumps package.json and the lockfile, commits, tags
npm pack --dry-run                 # README.md, package.json and 7 files in dist/
npm publish
git push && git push --tags
```

`npm publish` runs `prepublishOnly` first, which rebuilds `dist/`, so a stale build can't ship.
Version 0.4.8 shipped a stale build before this script was added.
````

- [ ] **Step 6: Verify (type check, tests, build, tarball, scratch consumer)**

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget
npm run check && npm test && npm run build && npm pack --dry-run
```

Expected:
- `svelte-check found 0 errors`. The `tsc` runs print nothing.
- `npm test` passes.
- The build succeeds.
- `npm pack --dry-run` shows `package: @forgebuild/sidon-booking-widget@1.0.0` and `total files: 9`. The Tarball Contents are exactly these files (sizes vary):

```
README.md
dist/astro-proxy.d.ts
dist/astro-proxy.js
dist/custom-element-berth-map.d.ts
dist/custom-element.d.ts
dist/elements.d.ts
dist/sidon-berth-map.js
dist/sidon-booking-widget.js
package.json
```

Re-run the Step 1 consumer check against the new tarball:

```bash
W=/c/Users/robert/source/repos/sidon-booking-widget
S=/tmp/sbw-consumer
rm -rf "$S/node_modules" "$S/package.json" "$S/package-lock.json" "$S"/*.tgz
cd "$W" && npm pack --pack-destination "$S"
cd "$S" && npm init -y >/dev/null && npm install --no-audit --no-fund ./forgebuild-sidon-booking-widget-1.0.0.tgz && npm ls --all
node "$W/node_modules/typescript/bin/tsc" -p "$S" && echo "types ok"
cd "$S" && node --input-type=module -e "const m = await import('@forgebuild/sidon-booking-widget/astro-proxy'); for (const k of ['createMarinaProxy', 'createMarinaClient', 'MarinaClientError']) if (typeof m[k] !== 'function') throw new Error('missing export ' + k); console.log('astro-proxy ok');"
```

Expected:
- `added 1 package`: the package needs no runtime dependencies.
- `npm ls --all` shows only `@forgebuild/sidon-booking-widget@1.0.0` under `sbw-consumer@1.0.0`.
- `types ok`, with no tsc errors.
- `astro-proxy ok`: the server entry imports in Node with nothing else installed.

Clean up: `rm -rf /tmp/sbw-consumer`.

- [ ] **Step 7: Commit**

```bash
W=/c/Users/robert/source/repos/sidon-booking-widget
git -C "$W" add README.md package.json package-lock.json vite.config.ts vite.berth-map.config.ts src/elements.d.ts scripts/write-element-types.mjs scripts/rename-berth-map-types.mjs public/favicon.svg
git -C "$W" status --short
git -C "$W" commit -m "$(cat <<'EOF'
1.0.0: README for OTA, element typings, package hygiene

README rewritten for the OTA guest API: the forwarder route,
createMarinaClient, the booking page's requirements and a migration guide
from 0.4.x/0.2.x. Hand-written src/elements.d.ts (HTMLElementTagNameMap,
event details) ships as dist/elements.d.ts, re-exported by both entry
typings, replacing the empty vite-plugin-dts output and its rename step.
No runtime dependencies (both bundles inline them), and the favicon no
longer ships.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Before the commit, `status --short` should print exactly:

```
M  README.md
M  package-lock.json
M  package.json
D  public/favicon.svg
D  scripts/rename-berth-map-types.mjs
A  scripts/write-element-types.mjs
A  src/elements.d.ts
M  vite.berth-map.config.ts
M  vite.config.ts
```

Do not tag, push or publish (R22).

---

### Task 10: End-to-end verification against local OTA

This task drives both elements in a real browser against a local OTA and the Task 1 demo seed. It adds no product code. If a check fails, Step 15 fixes the cause, starting with a failing check, and the fix's commit is noted against the item in the Step 17 results.

**Files:**
- Create (scratch, under the gitignored `O/.superpowers/`, never committed):
  - `O/.superpowers/planb/e2e/preload.js`
  - `O/.superpowers/planb/e2e/facts.js`
  - `O/.superpowers/planb/e2e/show.js`
  - `O/.superpowers/planb/e2e/confirm.js`
  - `O/.superpowers/planb/e2e/stripe.js`
  - `O/.superpowers/planb/e2e/passport.pdf`
  - `O/.superpowers/planb/e2e/boat-papers.png`
  - Generated by `facts.js`: `facts.json`, `inject.txt`, `record.txt`, `state.txt`
- Modify (gitignored by `*.local`): `W/demo/.env.local`, the `OTA_DEMO_API_KEY` line only.
- Product code: none. Step 15 handles defects.

**Interfaces:**
- Consumes:
  - Task 1:
    - `O/scripts/seed-marina-demo.js`. It is idempotent and prints the API key. It must give the demo marina `booking_url` = `http://localhost:5173/booking.html?booking={id}&token={token}`, at least two active document requirements and an active contract template.
    - The R20 OTA follow-ups: `documents[]`, `booking.expired`, and the rule that a zero total takes the email path.
  - Task 2:
    - The demo dev proxy: `/api/marina/guest/*` → `http://localhost:3000`, with `X-Api-Key` added from `OTA_DEMO_API_KEY` in `W/demo/.env.local`.
    - `W/demo/index.html`.
    - `W/demo/booking.html`, which contains `<sidon-booking-widget booking-id marina="<slug>">`.
    - `npm run check`; `npm test` comes from Tasks 3/5.
  - Elements: `<sidon-berth-map>`, and `<sidon-booking-widget>` (wizard and `booking-id` mode).
    - In `BookingWidget`: `reachBooking` emits `sidon-booked` synchronously, and `sidon-step-change` comes from an `$effect`.
    - `BookingView`: `load()` asks `doc-requirements` once, then `GET booking`. Polling starts only when `ably-token` fails, and never runs while the status is `hold`. It also refetches on `visibilitychange`.
    - `DocumentsSection`: a row offers upload only when it has no file or its file was rejected.
    - `ContractSection`: a checkbox, then Agree.
  - The `en` labels the expectations quote:
    - `hero.hold|pending|cancelled|expired.eyebrow` = 'Almost done' / 'Request received' / 'Booking cancelled' / 'Hold expired'
    - `checkEmailTitle` = 'Check your email'
    - `docsAfterSend`
    - `docState.pending` = 'Received · awaiting review'
    - `uploadedToday` = 'Uploaded <time>'
    - `contractAgreedOn` = 'Agreed on <date>'
    - `cancelBooking` = 'Cancel booking'
    - `startOver` = 'Start a new booking'
  - Events:
    - `sidon-loa-change {loa}`
    - `sidon-quickbook-submit {from,to,length,berth}`
    - `sidon-step-change {step}`
    - `sidon-booked {bookingId, marina}`
    - `sidon-booking-status {bookingId, status}`
  - Session: `sessionStorage['sidon-booking:'+slug]` = `BookingSession {id, token}`.
  - Guest routes, as called by `getMarina`, `getDocRequirements`, `getAvailability`, `createBooking`, `getBooking`, `confirmPayment`, `cancelBooking`, `uploadDocument`, `agreeContract` and `getAblyTokenRequest`.
- Produces: no code. The results checklist in Step 17.

**Timing:** each booking must be confirmed within 30 minutes of its POST: Step 6 → Step 7, and inside Step 13. After 30 minutes the sweep releases the hold and the confirm link answers 410.

- [ ] **Step 1: Preflight: gates green, ports free**

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget && npm test && npm run check
for port in 3000 5173; do netstat -ano | awk -v p=":$port" -v port="$port" '$2 ~ p"$" && $4 == "LISTENING" { print "port " port " in use by PID " $5 }' | sort -u; done
grep -o '<sidon-booking-widget[^>]*>' /c/Users/robert/source/repos/sidon-booking-widget/demo/booking.html
```

Expected:
- `npm test` passes both check scripts.
- `npm run check` reports `svelte-check found 0 errors`, and `tsc` prints nothing.
- The port loop prints nothing. If it lists a PID, an earlier dev server is still running (for example the user's own OTA `npm run dev`). Stop it with the Step 16 loop and note that Step 16 must restart it.
- The `grep` prints one tag that has `booking-id` and a `marina="…"` value. Step 3 checks that value against the seed.

- [ ] **Step 2: Scratch helpers and fixtures (gitignored)**

```bash
mkdir -p /c/Users/robert/source/repos/OTA/.superpowers/planb/e2e
cat > /c/Users/robert/source/repos/OTA/.superpowers/planb/e2e/preload.js <<'EOF'
// Plan B e2e only (gitignored scratch). Preloaded into src/server.js:
//   node -r ./.superpowers/planb/e2e/preload.js src/server.js
require('dotenv').config();
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('e2e preload: local DB only');

// No real guest emails from a test run. marinaEmails builds its Resend
// client at require time, so load it while the key is hidden; server.js's
// own dotenv call puts the key back for everything else.
delete process.env.RESEND_API_KEY;
require('../../../src/lib/marinaEmails');

// Fixture uploads must not reach the private blob store (local .env has no
// BLOB_READ_WRITE_TOKEN anyway) or paid extraction: keep them in memory,
// the same seam scripts/check-marina-http.js uses.
const docs = require('../../../src/lib/marinaDocuments');
const blobs = new Map();
docs.store = {
  put: async (p, buf) => { blobs.set(p, buf); },
  get: async () => null,
  del: async (ps) => { ps.forEach((p) => blobs.delete(p)); },
};
docs.extractDocument = async () => {};
EOF
cat > /c/Users/robert/source/repos/OTA/.superpowers/planb/e2e/facts.js <<'EOF'
// Plan B e2e facts (gitignored scratch). Finds the demo marina Task 1
// seeded, checks it suits this run, and asks OTA itself for dates, a boat
// length and the auto-pick, so the browser checks compare against OTA's
// numbers rather than hand-typed ones. Writes facts.json plus the
// browser_evaluate functions inject.txt, record.txt and state.txt.
//   cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/facts.js
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('local DB only');
const pool = require('../../../src/db');

const OTA = 'http://localhost:3000';
const BOOKING_URL = 'http://localhost:5173/booking.html?booking={id}&token={token}';
const EVENTS = ['sidon-step-change', 'sidon-booked', 'sidon-booking-status', 'sidon-loa-change', 'sidon-berth-selected', 'sidon-quickbook-submit'];
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const out = (name, text) => fs.writeFileSync(path.join(__dirname, name), text);

(async () => {
  try {
    assert.ok(process.env.MARINA_BOOKING_TOKEN_SECRET, 'MARINA_BOOKING_TOKEN_SECRET must be set in OTA .env');
    // Step 7 proves a status change reaches an open page over Ably.
    assert.ok(process.env.ABLY_API_KEY, 'ABLY_API_KEY must be set in OTA .env');
    const { rows } = await pool.query(
      `SELECT m.id, m.slug, m.auto_confirm, p.api_key, p.api_key_enabled, p.stripe_secret_key, p.stripe_publishable_key,
              to_char((now() AT TIME ZONE p.timezone)::date, 'YYYY-MM-DD') AS today
         FROM marina m JOIN property p ON p.id = m.property_id
        WHERE m.booking_url = $1 AND m.status = 'active'`, [BOOKING_URL]);
    assert.equal(rows.length, 1, `exactly one active marina must have booking_url ${BOOKING_URL} (Task 1 seed)`);
    const m = rows[0];
    assert.ok(m.api_key && m.api_key_enabled, 'the demo property needs an enabled api_key');
    assert.equal(m.auto_confirm, false, 'auto_confirm must be off: the confirm link would confirm the booking and guest cancel would 409');
    assert.ok(!m.stripe_secret_key && !m.stripe_publishable_key, 'the demo property has Stripe keys: run `node -r dotenv/config .superpowers/planb/e2e/stripe.js clear`, then re-run');
    const reqs = (await pool.query("SELECT id, name FROM marina_doc_requirement WHERE marina_id = $1 AND status = 'active' ORDER BY sort_order, name", [m.id])).rows;
    // Step 8 puts one file in each of two rows: a row holding a pending file offers no second upload.
    assert.ok(reqs.length >= 2, 'the seed needs two active document requirements');
    const tpl = await pool.query("SELECT 1 FROM marina_contract_template WHERE marina_id = $1 AND status = 'active' AND min_nights <= 2", [m.id]);
    assert.ok(tpl.rowCount >= 1, 'the seed needs an active contract template that applies to a 2-night stay');

    // The map's season gate moves out-of-season dates, so keep the stay
    // inside one active tier when the marina has tiers.
    const tiers = (await pool.query("SELECT to_char(valid_from, 'YYYY-MM-DD') AS f, to_char(valid_to, 'YYYY-MM-DD') AS t FROM marina_price_tier WHERE marina_id = $1 AND status = 'active' ORDER BY valid_from", [m.id])).rows;
    let arrival = addDays(m.today, 14);
    if (tiers.length) {
      const t = tiers.find((x) => addDays(arrival > x.f ? arrival : x.f, 1) <= x.t);
      assert.ok(t, 'no active price tier has room for 2 nights from today+14');
      if (t.f > arrival) arrival = t.f;
    }
    const departure = addDays(arrival, 2);

    const H = { 'X-Api-Key': m.api_key };
    const G = `${OTA}/api/marina/guest/${encodeURIComponent(m.slug)}`;
    let loa = null;
    let list = [];
    for (const L of [12, 10, 15, 8, 20, 6, 25, 30, 40]) {
      const r = await fetch(`${G}/availability?arrival=${arrival}&departure=${departure}&boat_length_m=${L}`, { headers: H });
      const body = await r.json();
      assert.equal(r.status, 200, `GET availability -> ${r.status} ${JSON.stringify(body)}`);
      list = body;
      if (list.some((b) => Number(b.total_price) > 0)) { loa = L; break; }
    }
    assert.ok(loa, 'no boat length from 6 to 40 m has a free berth priced above zero on those dates; the seed needs one');
    // R5 auto-pick: cheapest non-null total, tie -> smaller length_m, null totals last.
    const pick = [...list].sort((a, b) => (a.total_price == null) - (b.total_price == null)
      || Number(a.total_price) - Number(b.total_price) || Number(a.length_m) - Number(b.length_m))[0];
    assert.ok(Number(pick.total_price) > 0, `auto-pick ${pick.label} is zero-priced, so the card path (Step 14) can't run`);

    const qr = await fetch(`${G}/quote`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ berth_label: pick.label, arrival, departure, boat_length_m: loa }) });
    const quote = await qr.json();
    assert.equal(qr.status, 200, JSON.stringify(quote));
    assert.equal(quote.total_price, pick.total_price, 'OTA availability and quote disagree');
    const mr = await fetch(`${G}?from=${arrival}&to=${departure}`, { headers: H });
    const map = await mr.json();
    assert.equal(mr.status, 200, JSON.stringify(map));

    const facts = {
      key: m.api_key, slug: m.slug, today: m.today, arrival, departure, loa,
      pick: pick.label, total: quote.total_price, currency: quote.currency,
      // What R13 renders with locale en and no currency-symbol attribute.
      totalText: new Intl.NumberFormat('en', { style: 'currency', currency: quote.currency }).format(Number(quote.total_price)),
      free: map.berths.filter((b) => b.available).map((b) => b.label),
      taken: map.berths.filter((b) => !b.available).map((b) => b.label),
      requirements: reqs,
    };
    out('facts.json', JSON.stringify(facts, null, 2));

    const S = JSON.stringify;
    const sessionKey = S(`sidon-booking:${m.slug}`);
    // Listeners go on once per page; a later run only empties the log, so no event is recorded twice.
    const record = `window.__events = []; if (!window.__rec) { window.__rec = true; for (const n of ${S(EVENTS)}) document.addEventListener(n, (e) => window.__events.push({ type: n, detail: e.detail }), true); }`;
    out('record.txt', `() => { ${record} return { href: location.href, marina: document.querySelector('sidon-booking-widget')?.getAttribute('marina') ?? null, session: sessionStorage.getItem(${sessionKey}) }; }`);
    // fileInputs = open upload rows; checkboxes = the contract's agree box (the
    // only checkbox once the details form is gone); stripeFrame = the Payment
    // Element, which lives in the host's light DOM.
    out('state.txt', `() => { const w = document.querySelector('sidon-booking-widget'); const r = w?.shadowRoot; return { href: location.href, events: window.__events ?? null, session: sessionStorage.getItem(${sessionKey}), fileInputs: r ? r.querySelectorAll('input[type=file]').length : null, checkboxes: r ? r.querySelectorAll('input[type=checkbox]').length : null, stripeFrame: !!w?.querySelector('iframe[name^="__privateStripeFrame"]') }; }`);
    const attrs = `marina="${m.slug}" from="${arrival}" to="${departure}" length="${loa}" locale="en"`;
    out('inject.txt', `() => {
  ${record}
  // Replace the demo's own elements so every attribute is exact; keep its Maps key.
  const mapsKey = document.querySelector('sidon-berth-map')?.getAttribute('maps-api-key') ?? '';
  document.querySelectorAll('sidon-booking-widget, sidon-berth-map').forEach((el) => el.remove());
  const box = document.createElement('div');
  box.innerHTML = '<sidon-berth-map id="e2e-map" ${attrs} map-style="chart"></sidon-berth-map><sidon-booking-widget id="e2e-wizard" ${attrs}></sidon-booking-widget>';
  box.querySelector('#e2e-map').setAttribute('maps-api-key', mapsKey);
  document.body.prepend(box);
  return { mapsKey: mapsKey && mapsKey !== 'YOUR_DEV_MAPS_KEY' ? 'set' : 'none', session: sessionStorage.getItem(${sessionKey}) };
}`);
    console.log(JSON.stringify({ ...facts, key: `${facts.key.slice(0, 8)}…` }, null, 2));
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
EOF
cat > /c/Users/robert/source/repos/OTA/.superpowers/planb/e2e/show.js <<'EOF'
// The latest e2e bookings on the demo property, with documents and the
// contract signature: the DB side of each browser check.
//   cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/show.js
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('local DB only');
const pool = require('../../../src/db');
const { key } = require('./facts.json');
(async () => {
  const { rows } = await pool.query(
    `SELECT mb.id, mb.status, mb.payment_status, mb.cancel_reason, mb.total_price, mb.currency, mb.locale,
            mb.contact_email, mb.contact_phone, mb.hold_expires_at, mb.stripe_payment_intent_id IS NOT NULL AS has_pi,
            (SELECT json_agg(json_build_object('requirement_id', d.requirement_id, 'file_name', d.file_name,
                    'content_type', d.content_type, 'status', d.status) ORDER BY d.submitted_at)
               FROM marina_document d WHERE d.booking_id = mb.id) AS documents,
            (SELECT s.agreed_at FROM marina_contract_signature s WHERE s.booking_id = mb.id) AS agreed_at
       FROM marina_booking mb JOIN property p ON p.id = mb.property_id
      WHERE p.api_key = $1 AND mb.contact_email LIKE 'e2e-%@example.com'
      ORDER BY mb.created_at DESC LIMIT 4`, [key]);
  // Same machine and time zone as the browser, so this matches the hold panel's clock time.
  console.dir(rows.map((r) => ({ ...r, hold_local: r.hold_expires_at && r.hold_expires_at.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }) })), { depth: null });
  await pool.end();
})();
EOF
cat > /c/Users/robert/source/repos/OTA/.superpowers/planb/e2e/confirm.js <<'EOF'
// Stands in for the emailed confirm link. OTA stores only the link token's
// sha256, so the newest e2e hold gets a token known here (as
// scripts/check-marina-http.js:78-79 does) and the link is printed.
//   cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/confirm.js
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('local DB only');
const crypto = require('crypto');
const pool = require('../../../src/db');
const { key } = require('./facts.json');
(async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `UPDATE marina_booking b SET confirm_token_hash = $2
      WHERE b.id = (SELECT mb.id FROM marina_booking mb JOIN property p ON p.id = mb.property_id
                     WHERE p.api_key = $1 AND mb.status = 'hold' AND mb.contact_email LIKE 'e2e-%@example.com'
                     ORDER BY mb.created_at DESC LIMIT 1)
      RETURNING b.id`, [key, crypto.createHash('sha256').update(token).digest('hex')]);
  if (rows.length !== 1) throw new Error('no e2e hold to confirm');
  console.log(`http://localhost:3000/api/marina/confirm-booking/${rows[0].id}/${token}`);
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
EOF
cat > /c/Users/robert/source/repos/OTA/.superpowers/planb/e2e/stripe.js <<'EOF'
// `set` puts the platform's Stripe TEST pair on the demo property, so the
// wizard takes the card path; `clear` restores the email path.
//   cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/stripe.js set|clear
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) throw new Error('local DB only');
const mode = process.argv[2];
if (mode !== 'set' && mode !== 'clear') throw new Error('usage: stripe.js set|clear');
// One account's pair: a pk from another account fails at the Payment Element.
const sk = process.env.PLATFORM_STRIPE_SECRET_KEY || '';
const pk = process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY || '';
if (mode === 'set' && !(sk.startsWith('sk_test_') && pk.startsWith('pk_test_'))) {
  console.log('SKIP: no Stripe test key pair in OTA .env');
  process.exit(0);
}
const pool = require('../../../src/db');
const { key } = require('./facts.json');
pool.query('UPDATE property SET stripe_secret_key = $2, stripe_publishable_key = $3 WHERE api_key = $1', mode === 'set' ? [key, sk, pk] : [key, null, null])
  .then((r) => console.log(r.rowCount !== 1 ? 'FAIL: demo property not found' : mode === 'set' ? 'Stripe test keys set on the demo property' : 'Stripe keys cleared from the demo property'))
  .finally(() => pool.end());
EOF
cd /c/Users/robert/source/repos/OTA && node - <<'EOF'
// Smallest files OTA's magic-byte sniff accepts: a PDF header and a 1x1 PNG.
const fs = require('fs');
const dir = '.superpowers/planb/e2e';
fs.writeFileSync(`${dir}/passport.pdf`, '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
fs.writeFileSync(`${dir}/boat-papers.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
EOF
git -C /c/Users/robert/source/repos/OTA check-ignore -q .superpowers/planb/e2e/facts.js && echo ignored
```

Expected:
- The last line prints `ignored`.
- `e2e/` holds the 5 scripts and the 2 fixtures. The PNG is 70 bytes.

- [ ] **Step 3: Seed, start OTA, compute the facts**

```bash
cd /c/Users/robert/source/repos/OTA && node scripts/seed-marina-demo.js
```

Expected: the seed prints the demo API key. It is idempotent.

Start OTA with the Bash tool and `run_in_background: true`:

```bash
cd /c/Users/robert/source/repos/OTA && node -r ./.superpowers/planb/e2e/preload.js src/server.js
```

This is the same `src/server.js` that `npm run dev` runs, with two differences:
- The preload keeps emails, blobs and extraction local.
- There is no nodemon. After an OTA fix, restart OTA by hand.

Expected log: `Server running on port 3000`.

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/facts.js
grep -q "marina=\"$(node -p "require('C:/Users/robert/source/repos/OTA/.superpowers/planb/e2e/facts.json').slug")\"" /c/Users/robert/source/repos/sidon-booking-widget/demo/booking.html && echo booking.html slug ok
```

Expected:
- `facts.js` prints JSON with these fields:
  - `slug`
  - `arrival` and `departure`: 2 nights, starting today+14 or later
  - `loa`, `pick`, `total`, `currency`
  - `totalText`, for example `€160.00`
  - `free` and `taken`
  - `requirements`: two or more
- It writes `facts.json`, `inject.txt`, `record.txt` and `state.txt`.
- The `grep` line prints `booking.html slug ok`.
- `fetch failed` means OTA is not up yet. Re-run.
- `FAIL …` means a seed gap. Fix Task 1's seed under Step 15, then re-run the seed and `facts.js`.

- [ ] **Step 4: Point the demo at local OTA and start it**

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget
KEY=$(node -p "require('C:/Users/robert/source/repos/OTA/.superpowers/planb/e2e/facts.json').key")
rest=$(grep -v '^OTA_DEMO_API_KEY=' demo/.env.local 2>/dev/null)
printf '%s\n' ${rest:+"$rest"} "OTA_DEMO_API_KEY=$KEY" > demo/.env.local
git check-ignore -q demo/.env.local && echo ignored
```

Expected: `ignored`. Any other lines in `.env.local` are kept.

Start the demo with `run_in_background: true`. `--strictPort` makes Vite fail instead of moving to another port, because `booking_url` hard-codes 5173:

```bash
cd /c/Users/robert/source/repos/sidon-booking-widget && npm run dev -- --strictPort
```

Expected log: `VITE v8… ready` and `Local: http://localhost:5173/`.

```bash
SLUG=$(node -p "require('C:/Users/robert/source/repos/OTA/.superpowers/planb/e2e/facts.json').slug")
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:5173/api/marina/guest/$SLUG"
curl -s -w '\n%{http_code}\n' "http://localhost:5173/api/marina/guest/no-such-marina"
```

Expected:
- `200`. curl sent no key, so this proves the proxy added it.
- Then `{"error":"Marina not found"}` and `404`.

- [ ] **Step 5: (1) Berth map shows availability, and the quick-book total equals OTA's quote**

1. `mcp__playwright__browser_navigate` to `http://localhost:5173/`. This is tab 0.
2. `mcp__playwright__browser_evaluate` with `function` set to the contents of `O/.superpowers/planb/e2e/inject.txt`. Expected: `{ mapsKey: 'set' | 'none', session: null }`.
3. `mcp__playwright__browser_wait_for` with `time: 3`.
4. `mcp__playwright__browser_network_requests` with `static: false` and `filter: "/api/"`. Expected entries, each with status 200:
   - `GET http://localhost:5173/api/marina/guest/<slug>?from=<arrival>&to=<departure>`
   - `GET http://localhost:5173/api/marina/guest/<slug>/availability?arrival=<arrival>&departure=<departure>&boat_length_m=<loa>`, with no `boat_beam_m`.
   - Earlier entries come from the demo's own elements, which ran before they were replaced. They are relative URLs too.
5. `mcp__playwright__browser_network_request` on the map-payload entry with `part: "response-body"`. Expected: the berths with `available: true` are exactly `facts.free`.
6. `mcp__playwright__browser_snapshot` with `target: "#e2e-map"`. Expected:
   - The selected-berth text is `facts.pick`. This is the auto-pick, because there is no `berth` attribute.
   - The card total contains `facts.totalText`.
7. `mcp__playwright__browser_snapshot` with `target: "#e2e-wizard"`. Expected: the summary shows berth `facts.pick` and a price containing `facts.totalText`. Both come from the same availability call (R5).
8. Visual check:
   - If `mapsKey` was `'set'`, run `mcp__playwright__browser_take_screenshot`. Expected: a chart-style map centred on the marina, with one circle per berth that has lat/lng. The `facts.taken` berths use the unavailable paint, and `facts.pick` is highlighted.
   - If it was `'none'`, record "map visual skipped (demo has no Maps key)".
9. Click the card's CTA (use the ref from item 6's snapshot). Then `mcp__playwright__browser_evaluate` with `state.txt`. Expected:
   - `events` contains `{type:'sidon-loa-change', detail:{loa:<loa>}}`.
   - `events` contains `{type:'sidon-quickbook-submit', detail:{from:'<arrival>', to:'<departure>', length:<loa>, berth:'<pick>'}}`.
   - `href` is unchanged, because there is no `book-path`.

- [ ] **Step 6: (2) Wizard email path: details → book → step 3 "check your email" hold panel**

1. Check the input limits (R14) with `mcp__playwright__browser_evaluate`:

```js
() => [...document.querySelector('#e2e-wizard').shadowRoot.querySelectorAll('input, textarea')]
  .filter((i) => i.type !== 'hidden' && i.type !== 'file')
  .map((i) => ({ tag: i.tagName.toLowerCase(), type: i.type, name: i.name || i.id || i.getAttribute('aria-label') || i.placeholder, maxLength: i.maxLength }))
```

   Expected (ignore any summary inputs in the result):
   - contact name: `maxLength` 100
   - email: `type: "email"`
   - phone: `maxLength` 30
   - boat name: `maxLength` 100
   - notes textarea: `maxLength` 2000

2. Get a fresh email with `date +%s` and use `e2e-<n>@example.com`. OTA caps upcoming bookings per email, so every run needs a new address.
3. `mcp__playwright__browser_snapshot` with `target: "#e2e-wizard"`. Then `mcp__playwright__browser_type` these values:
   - name: `E2E Guest`
   - email: the address from item 2
   - phone: `+44 7700 900123`
   - boat name: `Test Wave`
   - notes: `plan B e2e`

   Leave beam empty. Click Next.
4. `mcp__playwright__browser_wait_for` with `time: 3`, then `mcp__playwright__browser_network_requests` with `static: false` and `filter: "/api/"`. Expected new entries since Step 5. The POST comes first; the GETs may arrive in any order:
   - `POST …/<slug>/bookings` → 201
   - `GET …/<slug>/doc-requirements` → 200
   - `GET …/<slug>/bookings/<id>` → 200
   - `GET …/<slug>/bookings/<id>/ably-token` → 200
5. `mcp__playwright__browser_network_request` on the POST, twice:
   - With `part: "request-body"`. Expected JSON:
     - `berth_label:'<pick>'`, `arrival`, `departure`
     - `contact_name:'E2E Guest'`, `contact_email`, `contact_phone:'+44 7700 900123'`
     - `boat_name:'Test Wave'`, `boat_length_m:<loa>` (a number), `notes:'plan B e2e'`, `locale:'en'`
     - `boat_beam_m` is absent or null.
   - With `part: "response-body"`. Expected: `booking.status:'hold'`, `booking.total_price:'<total>'`, `payment:null`, and a `booking_token`.
6. `mcp__playwright__browser_snapshot` with `target: "#e2e-wizard"`. Expected, shown in place of the form:
   - The hero shows 'Almost done' (`hero.hold`).
   - The panel shows 'Check your email' (`checkEmailTitle`), and its text names a clock time. Item 8 gives the time to compare.
   - The documents heading shows the `docsAfterSend` note ('You can upload documents once your request has been sent to the marina.') above locked requirement rows.
   - There is no contract section.
   - 'Cancel booking' and 'Start a new booking' are shown.
7. `mcp__playwright__browser_evaluate` with `state.txt`. Expected:
   - `events` include `{type:'sidon-step-change', detail:{step:1}}` (from mount), `{type:'sidon-booked', detail:{bookingId:'<uuid>', marina:'<slug>'}}`, and `{type:'sidon-step-change', detail:{step:3}}`. They never include `{step:2}`.
   - The order of `sidon-booked` and `{step:3}` is not checked. `reachBooking` emits `sidon-booked` synchronously, while the step event comes from an `$effect` on the next flush, so `sidon-booked` normally comes first.
   - `session` is `{"id":"<same uuid>","token":"<43 chars of [A-Za-z0-9_-]>"}`.
   - `fileInputs: 0`, `checkboxes: 0` and `stripeFrame: false`.
8. Run `show.js`:

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/show.js
```

   Expected, on the newest row:
   - `id` is the session id.
   - `status: 'hold'`, `total_price: '<total>'`, `contact_phone: '+44 7700 900123'`, `locale: 'en'`, `has_pi: false`.
   - `hold_local` is about 30 minutes ahead, and its hour and minute appear in the 'Check your email' panel.

- [ ] **Step 7: (3) Confirm the hold through the emailed link: Ably update, booking page shows pending, token stripped**

1. Tab 0 must stay selected for this whole item. Open the link outside the browser first, so the status change can reach tab 0 only over Ably:

```bash
cd /c/Users/robert/source/repos/OTA && URL=$(node -r dotenv/config .superpowers/planb/e2e/confirm.js | tail -1) && echo "$URL" && curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$URL"
```

   Expected:
   - The printed URL's id is the Step 6 session id.
   - curl prints `303 http://localhost:5173/booking.html?booking=<id>&token=<t>`, where `<t>` equals the session token. The token is an HMAC of the id, so it is deterministic.
2. `mcp__playwright__browser_wait_for` with `time: 5`, then `state.txt`. Expected:
   - `events` gained `{type:'sidon-booking-status', detail:{bookingId:'<id>', status:'pending'}}`.
   - `fileInputs` equals the number of requirements, and `checkboxes: 1`.
   - `mcp__playwright__browser_network_requests` with `static: false` and `filter: "bookings/<id>$"` lists exactly 2 GETs: the first load and the Ably-triggered refetch.
   - Ably is the only possible cause. Tab 0 never lost visibility, and no poll is running, because `ably-token` answered 200 and polling never runs during a hold.
3. `mcp__playwright__browser_snapshot` with `target: "#e2e-wizard"`. Expected:
   - The hero shows 'Request received' (`hero.pending`) and the 'Waiting for the marina' line.
   - The 'Check your email' panel is gone.
4. `show.js`. Expected: `status: 'pending'`, and `hold_expires_at` has moved to the staff response deadline (more than 23 hours ahead).
5. `mcp__playwright__browser_tabs` with `action: "new"` and `url` set to the same `$URL`. This is tab 1. For a booking that is already pending, OTA answers the link with the same 303.
6. `mcp__playwright__browser_wait_for` with `time: 3`, then `mcp__playwright__browser_evaluate` with `record.txt`. Expected:
   - `href` is `http://localhost:5173/booking.html?booking=<id>`, with `token` removed (R9).
   - `marina` is `<slug>`.
   - `session` equals tab 0's `{id, token}`.
7. `mcp__playwright__browser_snapshot`, then `state.txt`. Expected:
   - The hero shows 'Request received'.
   - There is one documents row per `facts.requirements` name, each offering 'Upload'. `fileInputs` equals the number of requirements.
   - The contract section has the agree checkbox and an Agree button that stays disabled until the box is ticked. `checkboxes: 1`.
   - 'Cancel booking' is shown. 'Start a new booking' is not, because the booking page has no `onstartover`.

- [ ] **Step 8: (4) Upload a passport PDF and a PNG → rows show received**

1. In tab 1, click the first requirement row's 'Upload' control. The row is a `<label>` around a hidden file input, so the tool reports a file chooser. Answer it with `mcp__playwright__browser_file_upload` and `paths: ["C:/Users/robert/source/repos/OTA/.superpowers/planb/e2e/passport.pdf"]`.
2. `mcp__playwright__browser_wait_for` with `time: 3`, then `mcp__playwright__browser_network_requests` with `static: false` and `filter: "/api/"`. Expected:
   - `POST http://localhost:5173/api/marina/guest/<slug>/bookings/<id>/documents?requirement_id=<requirements[0].id>` → 201
   - followed by a `GET …/bookings/<id>` refetch → 200.
3. `mcp__playwright__browser_network_request` on that POST with `part: "request-headers"`. Expected headers:
   - `content-type: application/pdf`
   - `x-file-name: passport.pdf`
   - `x-booking-token: <session token>`
4. Upload `C:/Users/robert/source/repos/OTA/.superpowers/planb/e2e/boat-papers.png` into the second row the same way. Expected:
   - `POST …/documents?requirement_id=<requirements[1].id>` → 201.
   - Headers include `content-type: image/png` (R12 sends a PNG of 4 MiB or less as it is) and `x-file-name: boat-papers.png`.
5. `mcp__playwright__browser_snapshot`, then `state.txt`. Expected:
   - Each of the two rows shows 'Received · awaiting review' (`docState.pending`) and an 'Uploaded <hh:mm>' stamp (`uploadedToday`). Neither row has an 'Upload' or 'Replace' control: a row reopens only after staff reject its file.
   - `fileInputs: 0`.
   - The rows don't show file names. `show.js` checks those.
6. `show.js`. Expected: `documents` holds 2 entries, and their `requirement_id` values match the rows used:
   - `{file_name:'passport.pdf', content_type:'application/pdf', status:'pending'}`
   - `{file_name:'boat-papers.png', content_type:'image/png', status:'pending'}`

- [ ] **Step 9: (5) Agree the contract**

1. `mcp__playwright__browser_snapshot`. Expected: the contract text is rendered for this booking. It contains `E2E Guest`, because the seed template uses `{{sailor_name}}`.
2. Tick the checkbox 'I have read and agree to the berth agreement.', then click 'Agree'. Expected:
   - `POST …/bookings/<id>/contract` → 201.
   - Its `request-headers` include `content-type: application/json`, and its `request-body` is `{}`.
   - A `GET …/bookings/<id>` refetch follows.
   - The section shows 'Agreed on <date>' (`contractAgreedOn`).
   - `state.txt` shows `checkboxes: 0`.
3. `show.js`. Expected: `agreed_at` is not null, and `status` is still `pending` (`auto_confirm` is off).

- [ ] **Step 10: (6) Cancel → cancelled hero + `sidon-booking-status`**

1. In tab 1, run `mcp__playwright__browser_evaluate` with `record.txt` to start a fresh event log. The listeners are not added a second time.
2. Click 'Cancel booking'. The tool reports a dialog. Call `mcp__playwright__browser_handle_dialog` with `accept: false`. Expected:
   - `filter: "/cancel"` lists nothing.
   - The hero still shows 'Request received'.
3. Click 'Cancel booking' again, then `mcp__playwright__browser_handle_dialog` with `accept: true`. Expected:
   - `POST …/bookings/<id>/cancel` → 200, then a `GET` refetch.
   - The hero shows 'Booking cancelled' (`hero.cancelled`), not 'Hold expired'.
   - The documents section, the contract section and 'Cancel booking' are gone. `state.txt` shows `fileInputs: 0` and `checkboxes: 0`.
4. `state.txt`. Expected: `events` is exactly `[{type:'sidon-booking-status', detail:{bookingId:'<id>', status:'cancelled'}}]`.
5. `show.js`. Expected: `status: 'cancelled'` and `cancel_reason: 'cancelled by guest'`.
6. Select tab 0 with `mcp__playwright__browser_tabs` (`action: "select"`, `index: 0`), wait 5 s, then `state.txt`. Expected:
   - `events` gained `{type:'sidon-booking-status', detail:{bookingId:'<id>', status:'cancelled'}}`. It came over Ably, or from the visibility refetch when the tab came back to the front.
   - The snapshot of `#e2e-wizard` shows 'Booking cancelled'.

- [ ] **Step 11: Network and console audit (both tabs, before any reload)**

Run these on tab 0, then on tab 1. Each tab's list resets when that tab navigates.

1. `mcp__playwright__browser_network_requests` with `static: false` and `filter: "/api/"`. Expected:
   - Every entry starts with `http://localhost:5173/api/marina/guest/<slug>`.
   - The single exception is tab 1's first document, `http://localhost:3000/api/marina/confirm-booking/…`. That is the emailed link itself, not a widget call.
2. `filter: "sidonmarine"`. Expected: nothing on either tab.
3. `filter: "[?&]token="`. Expected:
   - tab 0: nothing.
   - tab 1: only the `booking.html?booking=…&token=…` document. That URL is the `booking_url`, by design. No `/api/` URL appears.
4. `filter` set to the session token value. Expected: the same result as item 3. The booking token travels only in the `X-Booking-Token` header.
5. `mcp__playwright__browser_network_request` on one `GET …/bookings/<id>` from each tab, with `part: "request-headers"`. Expected: `x-booking-token: <session token>`.
6. Tab 1 only: `filter: "googleapis|open-meteo"`. Expected: nothing (R9: the booking page loads no maps or weather).
7. `mcp__playwright__browser_console_messages` with `level: "error"` on each tab. Expected: nothing. The one exception is Google Maps key errors on tab 0 when Step 5 reported `mapsKey: 'none'`.

- [ ] **Step 12: (7) Reload resumes from sessionStorage**

1. Tab 1: `mcp__playwright__browser_navigate` to `http://localhost:5173/booking.html?booking=<id>`. This URL has no token, so the session can only come from sessionStorage. Then run `record.txt`. Expected:
   - `href` is unchanged, and `session` is still `{id, token}`.
   - `GET …/bookings/<id>` → 200, and its `request-headers` carry `x-booking-token` = the session token.
   - The hero shows 'Booking cancelled'.
2. Tab 0: `mcp__playwright__browser_navigate` to `http://localhost:5173/`, then `inject.txt`. Expected:
   - The result has a non-null `session`.
   - `#e2e-wizard` renders the booking view for `<id>` ('Booking cancelled') with 'Start a new booking', not the step-1 form (R8).
   - `GET …/bookings/<id>` → 200. The demo's own widgets resumed the booking too, before `inject.txt` replaced them.
3. Click 'Start a new booking'. Expected:
   - No `POST …/cancel` is sent, because the booking is already cancelled.
   - `state.txt` shows `session: null`, and `events` gained `{step:1}`.
   - The snapshot shows the empty step-1 details form.

- [ ] **Step 13: (R11) No polling while `hold`, polling after it (Ably forced off)**

The local `.env` has `ABLY_API_KEY`, so `BookingView` never polls unless `ably-token` fails. This step makes it fail in tab 0 only.

1. In tab 0, `mcp__playwright__browser_run_code_unsafe` with `code`:

```js
async (page) => {
  // What an OTA without an Ably key answers (marinaGuest.ablyToken).
  await page.route('**/ably-token', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Live updates are not configured' }) }));
  return 'ably-token -> 503';
}
```

2. `record.txt`. Get a fresh `date +%s`. Snapshot `#e2e-wizard` and type these values:
   - name: `E2E Poll`
   - email: `e2e-poll-<n>@example.com`
   - boat name: `Poll Wave`

   Click Next.
3. `mcp__playwright__browser_wait_for` with `time: 3`, then `filter: "/api/"`. Expected:
   - `POST …/bookings` → 201, with `payment: null` in `response-body`. Call this booking `<id3>`.
   - `GET …/bookings/<id3>` → 200.
   - At least one `GET …/bookings/<id3>/ably-token` → 503.
   - The snapshot shows 'Almost done' and 'Check your email'.
4. `mcp__playwright__browser_wait_for` with `time: 30`, then again with `time: 10`. That is 40 s or more, longer than one 30 s poll interval. Then `filter: "bookings/<id3>$"`. Expected: exactly 1 entry, the first load. Nothing was fetched while the booking was a hold.
5. With tab 0 still selected:

```bash
cd /c/Users/robert/source/repos/OTA && URL=$(node -r dotenv/config .superpowers/planb/e2e/confirm.js | tail -1) && echo "$URL" && curl -s -o /dev/null -w '%{http_code}\n' "$URL"
```

   Expected: the URL's id is `<id3>`, and curl prints `303`.
6. `mcp__playwright__browser_wait_for` with `time: 30`, then with `time: 5`. Then `filter: "bookings/<id3>$"` and `state.txt`. Expected:
   - There are 2 or 3 entries: at least one poll tick landed after the confirm. Ticks are 30 s apart.
   - `events` contains `{type:'sidon-booking-status', detail:{bookingId:'<id3>', status:'pending'}}`.
   - The snapshot shows 'Request received'.
   - The poll is the only possible cause: Ably is off, and the tab stayed in front.
7. Clean up:
   - Click 'Cancel booking' and `mcp__playwright__browser_handle_dialog` with `accept: true`. Expected: `POST …/bookings/<id3>/cancel` → 200 and 'Booking cancelled'.
   - `mcp__playwright__browser_run_code_unsafe` with `code`: `async (page) => { await page.unroute('**/ably-token'); return 'unrouted'; }`.
   - Click 'Start a new booking'. Expected: the step-1 form.

- [ ] **Step 14: (8) Card path with Stripe TEST keys (skip if none)**

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/stripe.js set
```

If this prints `SKIP`, record "card path skipped: no Stripe test keys" and go to Step 15. Otherwise, the expected output is `Stripe test keys set on the demo property`. Then, in tab 0, which shows the step-1 form with Step 13's values still filled in:

1. `record.txt`. Type name `E2E Card` and email `e2e-card-<date +%s>@example.com`, then click Next. Wait 5 s. Expected:
   - `POST …/bookings` → 201 (`<id1>`). Its `response-body` has `payment: { client_secret: 'pi_…_secret_…', publishable_key: 'pk_test_…' }`.
   - `state.txt` events gain `{type:'sidon-step-change', detail:{step:2}}`, and `stripeFrame: true`: the Payment Element is mounted in the host's light DOM.
   - The step shows `facts.totalText`.
2. Click Back. Expected:
   - `POST …/bookings/<id1>/cancel` → 200 (R7), and `{step:1}` is emitted.
   - `show.js` shows `<id1>` with `cancelled` and `cancel_reason: 'cancelled by guest'`.
3. Click Next again. Expected: a new `POST …/bookings` → 201 (`<id2>`), and step 2.
4. Take a snapshot. In the Stripe iframe fields, use `mcp__playwright__browser_type` to enter:
   - card number: `4242 4242 4242 4242`
   - expiry: `12 / 34`
   - CVC: `123`
   - postal code, if shown: `12345`
5. Simulate a closed tab between Stripe's authorisation and OTA's confirm: `mcp__playwright__browser_run_code_unsafe` with `code`: `async (page) => { await page.route('**/confirm-payment', (r) => r.abort(), { times: 1 }); return 'aborted once'; }`. Then click 'Pay & send' and `mcp__playwright__browser_wait_for` with `time: 15`. Expected:
   - Requests to `api.stripe.com` (third-party, allowed); the card is now authorised.
   - `POST …/bookings/<id2>/confirm-payment` failed (aborted). The widget shows an error message, not a blank or crashed view.
   - `show.js` on `<id2>`: still `status: 'hold'`, `has_pi: true`.
5b. Reload tab 0 (`mcp__playwright__browser_navigate` to the same demo URL), then `record.txt` and wait 10 s. Expected:
   - The session resumes: `GET …/bookings/<id2>` → 200, then `POST …/bookings/<id2>/confirm-payment` → 200 — confirm-payment runs BEFORE any Payment Element mount (R10).
   - `stripeFrame` is `false` (no Payment Element remounted on an authorised intent).
   - The snapshot shows 'Request received', with no hold panel.
6. `show.js` on `<id2>`. Expected: `status: 'pending'`, `payment_status: 'held'`, `has_pi: true`.
7. Clean up: click 'Cancel booking' and accept the dialog. Expected:
   - `POST …/cancel` → 200, and the hero shows 'Booking cancelled'.
   - `show.js` on `<id2>` shows `payment_status: 'released'`.
8. Audit tab 0 again with Step 11 items 1, 3 and 4. Expected: every `/api/` URL is a relative guest URL, and no booking token appears in any URL.
9. Restore the email path:

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config .superpowers/planb/e2e/stripe.js clear
```

Expected: `Stripe keys cleared from the demo property`.

- [ ] **Step 15: Any outcome that doesn't match → fix it in the owning code, failing check first, then re-run**

1. Find the owner of the failure:
   - the widget: `W/src/…`
   - OTA: `O/src/…`
   - the seed: `O/scripts/seed-marina-demo.js`
   - the demo page or proxy: `W/demo/…`, `W/vite.config.ts`
2. Write the failing check:
   - Pure widget logic (`W/src/lib/ota.ts`, `W/src/astro-proxy.ts`): add an assert that reproduces the observed input to `W/scripts/check-ota.ts` or `W/scripts/check-astro-proxy.ts`. Run `cd /c/Users/robert/source/repos/sidon-booking-widget && npm test`. It must fail on that assert.
   - OTA behaviour: add a `check(...)` above `// (later tasks append here)` in `O/scripts/check-marina-http.js`. Run `cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js`. It must print `FAIL <name>`.
3. Fix the code and re-run the same command. Expected: it passes (`all passed` for OTA). For widget changes, also run `npm run check` and expect 0 errors. UI-only defects have no pure check. For those, `npm run check` plus a re-run of the failing step is the check.
4. Restart what the fix touched:
   - OTA: stop it (Step 16) and re-run the Step 3 start command.
   - Vite hot-reloads `src/`. Restart it only for `vite.config.ts` or `.env.local` changes.
   - Seed: re-run the seed and `facts.js`.

   Then re-run the failing step from its start. If it needs a fresh booking, begin at Step 6.
   - A `429` on `POST …/bookings` after several runs within one hour comes from OTA's 10-per-hour guest booking limit for one IP. The demo proxy sends every request as `127.0.0.1`. Restart OTA to reset its in-memory counter.
5. Commit each fix on its own, in its repo, staging exactly the files it changed. For example, for an `ota.ts` fix:

```bash
git -C /c/Users/robert/source/repos/sidon-booking-widget add src/lib/ota.ts scripts/check-ota.ts && git -C /c/Users/robert/source/repos/sidon-booking-widget commit -m "Fix adaptBooking total for null currency (plan B e2e)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

6. Note the fix's commit hash next to its item in Step 17.

- [ ] **Step 16: Stop the servers and the browser**

1. `mcp__playwright__browser_close`.
2. Stop the background commands from Steps 3 and 4 with `TaskStop` and their task ids, or by port:

```bash
for port in 3000 5173; do
  for pid in $(netstat -ano | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do taskkill //PID "$pid" //T //F; done
done
```

   Expected: a `SUCCESS: The process with PID … has been terminated.` line for each. Re-running Step 1's port loop prints nothing.
3. If Step 1 stopped a dev server that was already running, restart it with `run_in_background: true`: `cd /c/Users/robert/source/repos/OTA && npm run dev`.
4. Leave `O/.superpowers/planb/e2e/` and `W/demo/.env.local` in place for re-runs. Both are gitignored.

- [ ] **Step 17: Record the results and commit**

Tick each item as you observe it. For an item that failed, add the Step 15 fix commit. For an item that did not run, write `skipped: <reason>`.

- [ ] 1. Map:
  - The map payload and the availability request use relative URLs.
  - The card's berth is `facts.pick`, and its total contains `facts.totalText` (= OTA `/quote`).
  - The quick-book submit detail is exact.
  - The visual check was done, or skipped because there is no Maps key.
- [ ] 2. Wizard email path:
  - The POST body is exact. The response is 201 with `hold` and `payment: null`.
  - Step 3 shows 'Almost done' and 'Check your email' with the `hold_expires_at` time.
  - The documents rows are locked (0 file inputs), and there is no contract section.
  - `sidon-booked` and `{step:3}` fired, and `{step:2}` never did.
  - The session was saved.
- [ ] 3. Confirm link:
  - curl got a 303 to `booking.html` carrying the session token.
  - Tab 0 received `sidon-booking-status {status:'pending'}` over Ably, with exactly 2 GETs and no tab switch.
  - Tab 1, through the same link: the token is stripped, the hero shows 'Request received', the rows offer Upload, and the contract shows its agree checkbox.
- [ ] 4. Documents:
  - The PDF and the PNG each got 201, with the right `Content-Type`, `X-File-Name` and `X-Booking-Token`.
  - Both rows show 'Received · awaiting review' and 'Uploaded <time>', with no upload control.
  - The DB holds 2 `pending` documents with the right file names.
- [ ] 5. Contract:
  - The request got 201 with a `{}` body.
  - The section shows 'Agreed on <date>'.
  - The signature row exists, and the booking is still `pending`.
- [ ] 6. Cancel:
  - Dismissing the dialog sent nothing.
  - Accepting it showed 'Booking cancelled', and `sidon-booking-status {status:'cancelled'}` arrived in both tabs.
  - The DB has `cancelled by guest`.
- [ ] 7. Reload:
  - The booking page resumed from sessionStorage with no token in the URL.
  - The wizard resumed the booking view.
  - 'Start a new booking' cleared the session without a cancel call.
- [ ] R11 polling: with `ably-token` forced to 503, there were no `GET booking` calls for 40 s or more while the booking was a `hold`. The first poll after the confirm showed `pending` and emitted `sidon-booking-status`.
- [ ] 8. Card path (or `skipped: no Stripe test keys`):
  - The Payment Element mounted in light DOM.
  - Back cancelled the hold.
  - With confirm-payment aborted once after paying with 4242, the booking stayed `hold`; the reload resumed it with confirm-payment 200 before any Payment Element mount, then `pending`/`held`.
  - Cancel released the payment.
  - The keys were cleared again.
- [ ] Network:
  - Every widget call is `http://localhost:5173/api/marina/guest/<slug>…`.
  - No API URL carries the booking token, and `/bookings/:id…` calls carry `X-Booking-Token`.
  - `booking.html` loads no maps or weather.
- [ ] Console: no errors. Google Maps key errors are allowed only when there is no Maps key.

```bash
git -C /c/Users/robert/source/repos/sidon-booking-widget status --short
git -C /c/Users/robert/source/repos/OTA status --short
```

Expected:
- Neither repo has entries from this task.
- OTA shows only the entries that were already there: `?? =` and `?? src/db/seed-extras.sql.pre-multi-property.bak`.
- The scratch files and `demo/.env.local` are ignored.
- Step 15 already committed any defect fix, with explicit paths and a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. If no defect was found, there is nothing to commit.

---


## Release (not part of this plan — needs the user's go-ahead)

1. `npm login` for the `@forgebuild` scope (the stored token returns 401).
2. In `W`: push the 3 already-unpushed 0.4.x commits plus this plan's commits; tag `v1.0.0`.
3. `npm publish` from `W` (`prepublishOnly` runs the build).
4. In `O`: push Task 1 (Render deploys `main`); set `MARINA_BOOKING_TOKEN_SECRET` on Render first, or guest bookings answer 503.
5. Consumer PRs (forwarder route, `@forgebuild/sidon-booking-widget@^1.0.0`, slugs, booking pages, `booking_url` per marina) are plan D.
