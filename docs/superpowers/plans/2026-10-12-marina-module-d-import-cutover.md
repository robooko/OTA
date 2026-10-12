# Marina module, plan D: Sidon import, consumer PRs, cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the single marina cutover needs, built and verified but not released. That means a re-runnable `scripts/import-sidon-marina.js` that moves Sidon's marina data into OTA and prints a reconciled report. It also means one `cutover/switch` branch per consumer site on widget `^1.1.0` with its own forwarder and booking page, the sidon-marina freeze and switch branches, and the sidon-ai marina-removal branch. Finally, the OTA and dashboard switch/cleanup branches, plus a runbook that says when each of these is pushed, merged and run.

**Architecture:** The importer is one CommonJS file. Its CLI wraps exported functions: `readSource` reads Sidon with raw SQL and explicit column lists, `planMapping` is the pure mapping, and `importSidon` writes inside one transaction owned by the caller. So `scripts/check-import-sidon.js` can run the same functions against a `sidon_fixture` schema in the local DB, inside a transaction that is rolled back. Imported rows get UUIDs derived from Sidon ids, so a re-run keeps booking ids, booking tokens and blob paths. Every consumer site gets the same things: the same forwarder file, a bare `/booking` page, and a lazily built `createMarinaClient`, so a missing key hides booking instead of crashing the build. Each site is verified against local OTA, using the plan B demo seed under the site's own slug. Changes that must not reach production early live on named branches. The runbook (last task) is the only place that pushes, merges, publishes, deploys, migrates live or creates repos, and only with the user's go-ahead.

**Tech Stack:** Node 25 + Express/pg (OTA scripts and `node:assert` checks; `@vercel/blob` 2.8 behind `src/lib/marinaDocuments.js`'s seams), Astro 6.4/7.1 + `@astrojs/vercel` (consumer sites, sidon-marina, sidon-ai), `@forgebuild/sidon-booking-widget@1.1.0` + `/astro-proxy` (plan C), Astro 7 + Clerk + Playwright (dashboard), `gh` CLI (runbook only), Git Bash on Windows.

**Spec:** `docs/superpowers/specs/2026-10-10-ota-marina-unification-design.md` (amended 2026-10-12 in `5ac187f`: sidon-marina's public marina pages redirect to each marina's own site). Relevant sections: "Cutover" steps 1–7, the consumer table under "The forwarder, the server client and the widget", "Dashboard" (Settings cleanup) and "Testing approach" (Import). The binding rulings are `.superpowers/plancd/rulings-d.md` (plan C's are `rulings-c.md`). The research behind this plan is in the survey reports in `.superpowers/plancd/`: `sidon-import.md`, `consumer-sites.md`, `sidon-retire.md`, `ota-staff-api.md` and `dashboard.md`. The binding contract below summarises them.

## Global Constraints

- Repo roots: `O` = `C:/Users/robert/source/repos/OTA`, `W` = `C:/Users/robert/source/repos/sidon-booking-widget`, `D` = `C:/Users/robert/source/repos/ota-table-bookings`, `PB` = `…/pirates-bight`, `TT` = `…/tested-trappist`, `SEA` = `…/sea-company`, `PO` = `…/portals`, `MP` = `…/marina-di-positano`, `SM` = `…/sidon-marina`, `SA` = `…/sidon-ai`, `APP` = `…/sidon-marina-app`.
- Prerequisite: plan C is complete. `W/package.json` version is `1.1.0`, and D `main` carries plan C's `/marina` branch, nav rule and `scripts/check-marina.ts`. Any task that consumes these checks it first and stops if it's missing.
- **Nothing in plan D pushes, merges, publishes to npm, deploys, applies a live migration, archives a repo or creates a repo.** Those are runbook steps, done with the user's go-ahead.
- Branch names (R4): `cutover/freeze` (SM), `cutover/switch` (O, PB, TT, SEA, PO, MP, SM, SA), `cutover/cleanup` (O, D). Tasks end with a commit on the branch. Safe-any-time work (the importer, its check, the demo-seed tweak, the runbook) is committed on O `main`.
- Dirty-tree gate (R6) for SEA, SA, SM and APP. The task's first command is `git -C <repo> status --short`. If it prints anything other than `?? .scratch-cancel-booking.mjs` (SM only), stop and report.
- SM branches are cut from `origin/master` (local `master` is 7 AI commits ahead). SA, SEA, PB, TT, PO and MP branches are cut from local `master`. O and D branches are cut from `main`, except O `cutover/cleanup`, which is cut from O `cutover/switch`.
- Env names: `SIDON_DATABASE_URL` (source; added to O `.env` by hand, never committed), `DATABASE_URL` / `DATABASE_URL_LIVE` (target), `BLOB_READ_WRITE_TOKEN` (private store), `BLOB_PUBLIC_READ_WRITE_TOKEN` (public store), `MARINA_BOOKING_TOKEN_SECRET`, `OTA_BASE_URL` + `OTA_API_KEY` (every consumer site), `OTA_DASHBOARD_URL` (SM, default `https://hotal.forge-build.co.uk`), `MARINA_DEMO_SLUG` (O demo seed, local only).
- Map files: `O/.superpowers/import-map.local.json` and `O/.superpowers/import-map.live.json`, gitignored (`O/.gitignore` has `.superpowers/`). Each holds per-target property ids, so there is one per target.
- Retention: 90 days. Private paths: `marina-docs/{property_id}/{booking_id}/sidon-{sidon_document_id}.{ext}`, `marina-docs-archive/sidon/{alias}/{sidon_document_id}.{ext}` and `marina-archive/messages-{alias}.json`. Public images go to `marina-images/{property_id}/{marina_id}.{ext}` via `putPublic` (which adds a random suffix).
- Widget: committed dependency `"@forgebuild/sidon-booking-widget": "^1.1.0"`. Local verification uses the tarball `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz`. Consumer tasks never commit `package-lock.json`; the runbook refreshes and commits it after `npm publish`.
- Local OTA for site checks runs as `PORT=3100 npm start` from `O`, so `OTA_BASE_URL=http://localhost:3100`. Site dev ports: PB 4400, TT 4315, SEA 4321, PO 4401, MP 4404 (MP is HTTPS with mkcert, so use `curl -k https://localhost:4404`).
- Never print secrets (API keys, tokens, DB URLs) or personal data (emails, names, Sidon owner ids) in reports, commit messages or logs. Importer output shows counts, owner aliases (`o_xxxxxx`), slugs and created-property names from the map file. The demo seed's `api_key=` line is local-only and stays in shell variables.
- Commits list explicit paths only (never `-A`/`.`), and the message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **The currency of a reused property is not the marina's.** BBYC's property is GBP while its Sidon marina is `eur`; Pirates Bight Dev is `usd`. A guest would be charged the right number in the wrong currency. Pinned in Task 1 (`planMapping` adds a refusal for any owner whose currency differs from its property's and has no `currency_decision`, and `loadMap` rejects `reprice`). Also pinned in Task 2 (`drop_prices` imports berths with NULL `price_per_night` and no tiers; `accept_as_property_currency` keeps the numbers) and Task 3 (imported bookings carry the property's upper-case currency; `total_price` is NULL under `drop_prices`).
- **Re-running the import.** Rehearsal loops and a re-run attempted after Switch must keep booking ids, booking tokens and blob paths stable. A re-run must refuse rather than cascade-delete a real guest's booking or enquiry. Pinned in Task 2 (two consecutive runs produce identical marina/berth ids and counts; a `source = 'guest'` booking or an `event_inquiry` on an imported marina makes a commit run throw `ImportRefused` with the row still present, and a dry run only warns), Task 3 (booking ids, and so `bookingToken(id)`, identical across runs) and Task 4 (the second run writes the same private-store pathnames and archive paths; public image URLs differ per run because `putPublic` adds a random suffix, and the previous run's public copies are left behind, which is accepted).
- **Day boundaries.** Sidon tier timestamps are `…T00:00:00.000+01:00`, and properties sit behind UTC (Pirates Bight UTC-4, BBYC UTC-10). The cutover "today" is computed in the property's timezone. Other edges are a pending `expires_at` that equals now, a departure on the cutover date, and the 90-day retention boundary. Pinned in Task 1 (`tierDate`, `mapBookingStatus` and `insideRetention` edge assertions) and Task 3 (occupancy arrival equals `propertyToday` for a `Pacific/Tahiti` fixture property).
- **Personal data escaping.** Sidon-ai wallet files (`sailor-docs/*`) are never fetched. Import output contains no emails, names or owner ids. Booking tokens don't leak through `Referer` from a consumer booking page. Pinned in Task 1 (`formatPlan(plan)` output contains none of the fixture's emails, sailor/guest names or owner ids), Task 4 (a `fetchBlob` spy never receives a URL whose `sourcePath` starts with `sailor-docs/`, and `formatReport(report)` contains none of the fixture's emails, names or owner ids) and in Tasks 5–9 (the booking page responds with a `referrer-policy: no-referrer` header, the referrer meta tag and `noindex`).
- **OTA env missing on a consumer deploy.** If Preview or the build env lacks `OTA_API_KEY`/`OTA_BASE_URL`, `createMarinaClient` throws at module load, which fails the build or 500s every page. Instead, booking must disappear and the VHF/phone fallback must show. Pinned in Tasks 5–9: an empty-env `npm run build` succeeds (tested-trappist: `OTA_BASE_URL=` only, G7), the page that normally carries booking (PB `/berths`, TT `/facilities`, SEA the Fox/Pevero berths pages in `dist`, PO `/berths`, MP `/berths`) renders the VHF/phone fallback with no `<sidon-booking-widget`, and `GET /api/marina/guest/<slug>` answers `503 {"error":"Online booking is not available"}`.

---

## Binding contract

These are the rulings and shared interfaces every task below implements. Where a task's text disagrees with this section, this section wins.

### Design rulings (binding — do not re-decide)

R1 (U1) sidon-marina's `/m/<slug>/*` and `/[lang]/m/<slug>/*` 301-redirect at Switch to each marina's own consumer site. SM keeps its marketing home and chatbot, plus a static "this booking link is no longer valid" page at the old booking route. SM holds no OTA keys and gets no forwarder.
R2 (U2) portals and marina-di-positano get new PRIVATE repos under `robooko` at a runbook step: `gh repo create robooko/<name> --private --source . --push`, run only with the user's go-ahead. Each then gets a PR like the other sites. portals stays undeployed ("ready when it launches").
R3 (U3) There is no property switcher (plan C rules it out).
R4 (D1) Every change that must not reach production before its runbook step lives on a named branch, never `main`/`master`, and its task ends with a commit on that branch, not a push or merge. The names are `cutover/<step>-<what>`-style: `cutover/freeze` (SM), `cutover/switch` (each consumer site, O, SM, SA) and `cutover/cleanup` (O, D). The runbook says when each is pushed or merged.
R5 (D2) Code that is safe to deploy any time (the import script, OTA checks, docs) goes on O `main` as normal commits, not pushed.
R6 (D3) Repos with uncommitted work (sea-company, sidon-ai, sidon-marina, sidon-marina-app) are not touched until the user commits or stashes it. The task starts with a `git status --short` gate that stops and reports when the tree is dirty. SM's local `master` is 7 commits ahead (AI branch `88ee507`, unapplied columns), so SM branches are cut from `origin/master`. Tagging `ai-replies-shelved` at `88ee507` is a runbook step, and so is resetting local `master`, which needs the user's explicit approval. SM's untracked `.scratch-cancel-booking.mjs` is never committed.
R7 (D4) The importer uses two connections: source `SIDON_DATABASE_URL` and target `DATABASE_URL`, or `DATABASE_URL_LIVE` with `--live`. It refuses when the source and target URLs are equal. Source queries run in `BEGIN READ ONLY`. It uses raw SQL with explicit column lists, because 8 Sidon table names collide with OTA's. Target writes happen in ONE transaction per run.
R8 (D5) Modes: `--map <file>` prints the reconciled mapping (grouping, re-keys, currency flags, slugs, skips) and writes nothing. `--dry-run` runs the whole import inside the transaction, ROLLS BACK and prints the report. The default commits. `--no-files` skips blob copies (local rehearsals). `--live` targets `DATABASE_URL_LIVE`.
R9 (D6) There is one map file per target (`import-map.local.json`, `import-map.live.json`, gitignored under `O/.superpowers/` or passed by path). It maps every Sidon owner id to one of `{ action: 'property', property_id }`, `{ action: 'create', name, timezone, clerk_org_id, currency? }`, `{ action: 'skip', reason }` or `{ action: 'rekey', to_owner }`. Each owner can also carry a `currency_decision` and a `slug` override. `currency_decision` is `'accept_as_property_currency'` or `'drop_prices'`; `'reprice'` is not supported in phase 1. The script never matches by name. A created property gets its name, upper-cased currency, timezone and `clerk_org_id` (required; the script refuses without it), plus `api_key` with `api_key_enabled = true`. Its starter tokens are written inline in the same transaction (`grantStarter` uses its own pool), and `sidon_marina_id` is set to the first owner id for that property. Re-runs find targets via `marina.sidon_owner_id`, then `property.sidon_marina_id`.
R10 (D7) Imported rows get deterministic UUIDs derived from Sidon ids: uuid v5-style, from the sha1 of `sidon:<table>:<id>` formatted as a UUID. So re-runs keep booking ids, booking tokens and blob paths stable.
R11 (D8) A re-run deletes everything under marinas whose `sidon_owner_id` is in the map, then inserts. A non-dry re-run is refused when any mapped marina has a `marina_booking.source <> 'import'` row or any `event_inquiry` row (Switch has happened).
R12 (D9) Tier dates are the `slice(0,10)` of Sidon's timestamps (operator intent), not a timezone conversion. The spec text is amended in the runbook's notes.
R13 (D10) Re-keyed owners (`o_b97ea0` → Positano, `o_f54f18` → Puerto Portals per the survey) have their bookings and documents imported against the target's berths by label. Their duplicate berths are not imported. Their doc requirements and templates are imported only when the target has none of that kind. `o_0ddee1` is skipped unless the map file says `rekey`.
R14 (D11) Documents: copy into the private store only those whose booking is inside retention, meaning not departed more than 90 days ago and not cancelled/declined more than 90 days ago by `updated_at`. The rest are inserted with `file_deleted_at = now()` and the would-be `blob_pathname`, with no copy. Unlinked or orphaned Sidon docs (`marina-docs/*` with no imported booking) are copied to `marina-docs-archive/` and listed. `sailor-docs/*` files are never read or touched. Images (including webp) go to the OTA public store via `putPublic` with the source content type.
R15 (D12) Bookings follow spec Cutover step 4. A `pending` booking past its expiry, with NULL expiry, or already departed becomes `cancelled` with `cancel_reason = 'expired'`. Invalid emails (blank or no `@`) become NULL. Overlap violations and berth-less bookings are skipped and reported, using a savepoint per booking to catch `23P01`.
R16 (D13) Occupancy bookings follow the spec: open-ended and `confirmed`, with arrival = the cutover date = the target property's today, and `contact_name` = `guest_name`, or `'Reserved'` when blank.
R17 (D14) Messages go to a JSON export in the private archive store (`marina-archive/messages-<owner>.json`), skipped with `--no-files`.
R18 (D15) Tests: `O/scripts/check-import-sidon.js` builds a small FIXTURE source in a separate local schema (`sidon_fixture`, created and dropped by the check, with the same column names as Sidon's live tables per the survey). It runs the importer functions against the local OTA DB inside a rolled-back transaction, covering mapping, re-key, currency refusal, status mapping, occupancy, dedupe and re-run idempotence, the retention rule, deterministic ids and refusal after Switch. The blob store is stubbed through the same seam as `check-marina-http.js`.
R19 (D16) O branch `cutover/switch`: rewrite `list_marina_bookings` and delete the `GET /api/marina/sidon-bookings` route, controller and Swagger entry. O branch `cutover/cleanup`, merged two weeks after Switch, removes `PUT /api/marina/key`, `POST /api/marina/key/clear`, the `sidon_marina_id`/`sidon_marina_key_set` fields in `/api/property/me` and Swagger, `update_property`'s `sidon_marina_id` argument and the `get_property` text. THEN a separate migration file drops `property.sidon_marina_id`, `property.sidon_marina_key`, `marina.sidon_owner_id` and `marina_booking.legacy_payment_intent_id`. The user applies it after the cleanup deploy is live.
R20 (D17) Dashboard `cutover/switch`: nothing (plan C's `/marina` branch is already live). Dashboard `cutover/cleanup`: remove the Settings Sidon fields, the `sidon_marina_id` nav rule (the nav shows only when there is at least one active marina), the interim `/marina` page branch and the Sidon path in `marina-client.ts`.
R21 (D18) Consumer env is `OTA_BASE_URL` + `OTA_API_KEY` everywhere (the README names). They are set server-side, and in the Vercel build env where pages read at build time, for Preview AND Production. Kill switch: hide booking when `OTA_API_KEY` is unset, keeping the existing VHF/phone fallbacks.
R22 (D19) The widget is `@forgebuild/sidon-booking-widget@^1.1.0`, plan C's version; `npm publish` is a runbook prerequisite. PRs are verified locally against an `npm pack` of W, but the committed dependency is the npm range. sea-company and positano drop the `@robooko` dependency and its `.npmrc` lines.
R23 (D20) Each site gets a forwarder route at `src/pages/api/marina/guest/[...path].ts` with the literal `export const prerender = false`, GET/POST, and keys from env. It also gets a booking page at `/booking` (or the site's locale-prefixed equivalent) with `<meta name="referrer" content="no-referrer">` AND a `Referrer-Policy: no-referrer` response header, `noindex`, and excluded from the sitemap. `booking_url` = `<production origin>/booking?booking={id}&token={token}`, set per marina at Switch through the dashboard Settings (plan C). The production origins are runbook inputs.
R24 (D21) Remove the `api-origin` and `currency-symbol` attributes (amounts then use Intl in the property currency), except where the runbook's map sign-off records a forced symbol (the BBYC decision).
R25 (D22) pirates-bight: Clerk's injected script on the booking page is accepted (first-party auth, not analytics) and noted in the PR.
R26 (D23) portals: lazy hand-off. Create the hold via `/availability` + `POST bookings` through the forwarder, then `location.assign` to the booking page, which resumes payment. Delete the hand-rolled Stripe/contract/pre-booking-upload code. SSR berths via `createMarinaClient`.
R27 (D24) positano: keep its hand-rolled map, with a small adapter to the OTA payload at its two fetch points. Use widget 1.x for booking. SSR and build reads go via `createMarinaClient`.
R28 (D25) sea-company: Fox + Pevero sit on one OTA property with one key. The build-time price grid comes via `createMarinaClient`. Keep the camelCase component types via an adapter.
R29 (D26) tested-trappist: the slug is whatever the signed-off map prints for BBYC (a runbook input). The task uses a constant `BBYC_SLUG` set from the map sign-off, default `bora-bora-yacht-club`. The quick-book hand-off is left as is.
R30 (D27) Verification per site: `npx astro check` (if configured), `npm run build`, then the dev server plus `curl /api/marina/guest/<slug>` against local OTA, using the plan B demo seed with a slug override via env, and a check that the booking page renders. No site has a test runner, and none is added.
R31 (D28) sidon-marina `cutover/freeze` (from `origin/master`): `src/middleware.ts` (before `clerkMiddleware`) returns 503 JSON with CORS headers for every non-GET/HEAD/OPTIONS request to `/api/marina/*`. GETs that write (apikey, stripe/status, org auto-provision) are accepted as they are.
R32 (D29) sidon-marina `cutover/switch` (on top of freeze): `/api/marina/*` returns 410 JSON with a pointer. Dashboard routes (`/marina*`) 301 to the OTA dashboard URL (runbook input `OTA_DASHBOARD_URL`, default `https://hotal.forge-build.co.uk`). `/m/<slug>/*` and `/[lang]/m/<slug>/*` 301 to each marina's site, through a slug → origin map in code whose values are runbook inputs. The old booking route becomes a static "link no longer valid" page. Remove `NavAuth`/`OrganizationSwitcher` from `NavMarinaSite`. Delete the hand-rolled public booking UI, MarinaMessageSticky and the enquiry drawer (the pages now redirect).
R33 (D30) sidon-ai `cutover/switch`: remove the marina features (6 files plus edits, per the survey), the four unused env vars, the unused deps (flatpickr, @stripe/stripe-js, ably) if nothing else uses them, and the marina lines in the privacy/terms copy. The `sailor-docs` wallet is untouched. Verify with `rg` for leftovers, `npm run build`, and Playwright against dev.
R34 (D31) sidon-marina-app is archived via `gh repo archive` at the runbook step. There is no code task.
R35 (D32) The runbook `O/docs/superpowers/runbooks/2026-10-marina-cutover.md` is written by the last task. It lists every step of spec Cutover 1–7 with exact commands, the inputs to collect (Clerk org ids, timezones, currencies, slugs, production origins, OTA dashboard URL), sign-off points, verification commands, rollback, and which branch merges when. Prerequisites: npm login and publishing 1.1.0; the Render env vars `MARINA_BOOKING_TOKEN_SECRET`, `BLOB_READ_WRITE_TOKEN` and `BLOB_PUBLIC_READ_WRITE_TOKEN`; and the live R4 migration (multi-property) before creating any properties that share a Clerk org (otherwise use distinct orgs).
R36 (conventions) The conventions are the same as plan C: explicit-path commits ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; a failing check first for pure logic; Windows/Git Bash; local OTA may need `PORT=3100`. Never print secrets or personal data; the import report shows counts and owner aliases only.

**Architect's gap fills (binding; they apply R1–R36 where the rulings are silent):**

G1 Owners with `action: 'create'` that share identical `clerk_org_id` AND `name` go to ONE created property (SEA Company = Fox + Pevero). Their `timezone` and their effective `currency` must agree, or the map is refused. The first owner, in map-file order, becomes `property.sidon_marina_id`.
G2 Map keys and `rekey.to_owner` accept a real owner id or its alias. `alias(ownerId) = 'o_' + sha1(ownerId).hex.slice(0, 6)`. An alias matching more than one source owner is refused. All printed output uses aliases.
G3 A reused (`action: 'property'`) property is never written to: no change to `currency`, `timezone` or `sidon_marina_id`. Pirates Bight's interim value keeps working until cleanup.
G4 R14's "never read" applies to every `sailor-docs/*` file. A document linked to an imported booking whose `file_url` path starts with `sailor-docs/` is inserted as not-copied: `file_deleted_at = now()`, the would-be `blob_pathname`, `content_type` from its extension (`pdf` → `application/pdf`, `jpg`/`jpeg` → `image/jpeg`, `png` → `image/png`, else `application/octet-stream`), `size_bytes = 0`, and it is counted as `documents_sailor_docs`. Out-of-retention documents get the same extension-derived type and `size_bytes = 0`. Unlinked `sailor-docs/*` rows are neither inserted nor archived; they're only counted (`sailor_docs_unlinked`). If fetching an in-retention `marina-docs/*` file fails or its magic bytes don't sniff, the document is inserted as not-copied and counted (`documents_fetch_failed`). Consequence, surfaced at the runbook's map sign-off: on today's data every document linked to an imported booking is a `sailor-docs/*` file (the 32 `marina-docs/*` all have NULL `booking_id`), so the import copies no document file; staff see the document rows with the file marked deleted. Changing that would mean changing R14, which only the user can do.
G5 R11's guard is evaluated in every mode. A commit run throws `ImportRefused`. A dry run records a `warnings[]` line, then sets `event_inquiry.marina_id = NULL` for those marinas inside its rolled-back transaction so the delete can proceed.
G6 Consumer tasks install the widget with `npm install --no-save <tarball>` BEFORE hand-editing `package.json`. They commit `package.json` (and `.npmrc` removals) but never `package-lock.json`. The runbook runs `npm install` on each `cutover/switch` branch after `npm publish` and commits the lockfile.
G7 Kill switch, shared by every site: booking UI, build-time reads and the forwarder are active only when BOTH `OTA_BASE_URL` and `OTA_API_KEY` are non-empty. Otherwise the forwarder answers `503 {"error":"Online booking is not available"}`. tested-trappist keeps `OTA_API_KEY` as its existing required `astro:env` secret (its PMS pages already need it) and gains `OTA_BASE_URL` as an optional server envField, so there the switch is effectively `OTA_BASE_URL`.
G8 sea-company's single booking page carries the marina in the query: `booking_url` = `<origin>/booking?marina=<slug>&booking={id}&token={token}`, with `marina` whitelisted to `fox-mooring` | `pevero-mooring` (anything else → 404).
G9 SM redirect mechanics. `output: 'static'` means middleware never sees prerendered pages, so the switch branch deletes the public marina pages and adds SSR catch-alls that redirect. The middleware handles only `/api/marina/*` and `/marina*`.
G10 The column-drop migration commit also deletes `scripts/import-sidon-marina.js` and `scripts/check-import-sidon.js`, because they read `marina.sidon_owner_id`.
G11 The O demo seed gains `MARINA_DEMO_SLUG` (default `demo-marina`), so each site's hard-coded slug resolves on local OTA. Several slugs seeded in turn share the one "Marina Demo" property and key.
G12 Booking pages set no `locale` attribute. Widget 1.1 then uses the booking's own locale (plan C, C6).
G13 An owner absent from the map is auto-skipped only when it has no child rows other than messages (reason `'no child rows'`). Any other absent owner is a refusal.

### Shared interfaces (exact names)

#### O — `scripts/import-sidon-marina.js` (Tasks 1–4 produce; Task 14 deletes it at cleanup; Task 16's runbook calls the CLI)

This is a CommonJS module. The CLI runs only when `require.main === module`. Its first lines are `require('dotenv').config()` and `require('../src/db')`; the second keeps pg DATE values as `'YYYY-MM-DD'` strings. It reuses `emailKey` (`src/lib/spaBookingGuard.js`), `propertyToday(client, propertyId)` (`src/lib/marinaQueries.js`), `STARTER_BALANCE` (`src/lib/tokens.js`), `unknownPlaceholders` (`src/lib/marinaContracts.js`) and the module object `docs = require('../src/lib/marinaDocuments')`. Blobs are always written through `docs.store.put(pathname, buf, contentType)` and `docs.putPublic(pathname, buf, contentType)` so the check can swap them.

```js
// CLI (from O, Git Bash):
//   node scripts/import-sidon-marina.js --map [<map-file>] [--live]
//   node scripts/import-sidon-marina.js [<map-file>] --dry-run [--live] [--no-files]
//   node scripts/import-sidon-marina.js [<map-file>] [--live] [--no-files]
// <map-file> defaults to .superpowers/import-map.local.json (.superpowers/import-map.live.json with --live).
// Refusals print `refused: <message>` to stderr and exit 1 (no stack). Report/plan go to stdout.
// pg ssl rule for both clients: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }.
// Commit/dry-run with files on and BLOB_READ_WRITE_TOKEN or BLOB_PUBLIC_READ_WRITE_TOKEN unset -> refused.

class ImportRefused extends Error {}
function alias(ownerId)                  // -> 'o_' + sha1(ownerId) hex .slice(0, 6)
function uid(table, id)                  // -> UUID from sha1(`sidon:${table}:${id}`) hex h:
                                         //    `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`
                                         //    tables: 'marina' (owner_id), 'pontoon', 'berth', 'tier', 'requirement', 'template',
                                         //    'poi', 'image', 'booking', 'occupancy' (Sidon berth id), 'signature', 'document'
function slugify(name)                   // lower-case; runs of [^a-z0-9] -> '-'; trim '-'
function tierDate(text)                  // -> String(text).slice(0, 10)
function cleanEmail(s)                   // -> trimmed string if it has >= 1 char before '@', else null
function mapBookingStatus(b, today, now) // b: { status, expires_at: Date|null, departure_date: 'YYYY-MM-DD' }
                                         // -> { status, cancel_reason: 'expired' | null } | null (unknown status)
                                         // pending -> cancelled/'expired' when expires_at == null || expires_at <= now || departure_date < today
function insideRetention(b, today, now)  // b: { status (mapped), departure: string|null, updated_at: Date }
                                         // false when departure !== null && departure < today - 90 days,
                                         // or status in ('cancelled','declined') && updated_at < now - 90 days; else true
function loadMap(path)                   // -> ImportMap; throws ImportRefused (bad JSON/shape, 'reprice', create without clerk_org_id)
async function readSource(src, schema = 'public')   // -> Source; schema must match /^[a-z_]+$/; SELECTs only, never BEGIN/COMMIT
                                                    //    (the CLI wraps it in BEGIN READ ONLY ... COMMIT on the source client;
                                                    //    the check calls it inside its own transaction)
async function readTargets(dst, source, map)        // -> Targets (read-only)
function planMapping(source, map, targets)          // -> Plan (pure)
async function importSidon(dst, source, plan, opts) // -> Report; runs inside the caller's transaction; throws ImportRefused
function formatPlan(plan)                           // -> string (aliases, slugs, map-file property names only)
function formatReport(report)                       // -> string (aliases, slugs, counts and archive paths only)
// Task 4 (documents), pure:
function sourcePath(fileUrl)             // -> new URL(fileUrl).pathname without the leading '/', decodeURIComponent'd;
                                         //    null when fileUrl is null/blank/not a URL. Sidon file_url values are full
                                         //    https://<store>.public.blob.vercel-storage.com/<path> URLs.
function extOf(path)                     // -> lower-cased extension of the last path segment, or 'bin' (null path / no '.')
function typeFromExt(ext)                // pdf -> 'application/pdf', jpg|jpeg -> 'image/jpeg', png -> 'image/png',
                                         //    else 'application/octet-stream' (G4)
module.exports = { ImportRefused, alias, uid, slugify, tierDate, cleanEmail, mapBookingStatus, insideRetention,
  loadMap, readSource, readTargets, planMapping, importSidon, formatPlan, formatReport, sourcePath, extOf, typeFromExt };
```

```ts
// ImportMap (the JSON file)
type CurrencyDecision = 'accept_as_property_currency' | 'drop_prices';
type OwnerEntry =
  | { action: 'property'; property_id: string; currency_decision?: CurrencyDecision; slug?: string }
  | { action: 'create'; name: string; timezone: string; clerk_org_id: string; currency?: string; currency_decision?: CurrencyDecision; slug?: string }
  | { action: 'skip'; reason: string }
  | { action: 'rekey'; to_owner: string };            // owner id or alias of a profiled, importing owner
interface ImportMap { owners: Record<string /* owner id or alias */, OwnerEntry> }

// Source: rows keyed by Sidon's own column names, exactly these columns (readSource's explicit lists;
// the fixture schema creates the same tables with these columns).
interface Source {
  profiles:     { owner_id, slug, name, lat, lng, description, phone, email, website, response_window_hours, currency, updated_at }[];   // marina_profile
  layouts:      { owner_id, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation }[];                                                        // marina_layout
  overlays:     { id, owner_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order }[];                                  // marina_overlay
  berths:       { id, owner_id, berth_id, overlay_id, lat, lng, length_m, min_length_m, beam_m, depth_m, status, guest_name, notes, price_per_night, price_mode, rotation }[];  // marina_berth
  tiers:        { id, owner_id, valid_from, valid_to, max_len_m, max_beam_m, price_per_night, price_per_month, price_per_year, created_at }[];  // marina_price_tier
  bookings:     { id, owner_id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, notes, status, payment_intent_id, amount_cents, expires_at, created_at, updated_at }[];  // berth_booking, ORDER BY created_at, id
  requirements: { id, owner_id, type, name, description, schema, mandatory, sort_order }[];                                                // marina_doc_requirement
  documents:    { id, owner_id, requirement_id, booking_id, status, notes, submitted_at, verified_at, type, file_url, file_name, extracted_data, expiry_date }[];  // marina_document
  templates:    { id, owner_id, name, body_markdown, min_nights, active, created_at }[];                                                    // marina_contract_template
  signatures:   { id, owner_id, template_id, booking_id, rendered_body, signed_at, ip_address, user_agent }[];                              // marina_contract_signature
  pois:         { id, owner_id, label, type, lat, lng }[];                                                                                  // marina_poi
  images:       { id, owner_id, url, description, sort_order, created_at }[];                                                               // marina_image
  messages:     { id, owner_id, sailor_id, enquiry_cookie_hash, sailor_email, sailor_name, direction, body, created_at, read_at }[];        // marina_message
}

interface Targets {
  properties: Record<string /* property_id */, { currency: string; timezone: string; clerk_org_id: string | null }>; // every 'property' id + every re-run hit
  reruns: Record<string /* create key */, string /* property_id */>;   // via marina.sidon_owner_id, then property.sidon_marina_id = first owner
}

interface PlannedProperty {
  key: string;                      // property_id for 'property'; `create:${clerk_org_id}:${name}` for 'create'
  property_id: string | null;       // null only while it is still to be created
  create: { name: string; timezone: string; clerk_org_id: string; currency: string } | null;  // non-null only if INSERT is needed
  currency: string;                 // upper-case ISO: the reused/re-run property's, or create.currency (map currency ?? profile currency)
  owners: string[];                 // importing owner ids, map-file order; owners[0] -> sidon_marina_id when created
}
interface PlannedOwner {
  owner_id: string; alias: string;
  action: 'import' | 'rekey' | 'skip';
  property_key: string | null;      // import
  slug: string | null;              // import: map slug ?? profile.slug ?? slugify(name); must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  prices: 'keep' | 'drop';          // import: 'drop' iff currency_decision === 'drop_prices'
  rekey_to: string | null;          // rekey: owner id of the target
  reason: string | null;            // skip
}
interface Plan {
  properties: PlannedProperty[];
  owners: PlannedOwner[];           // every owner seen in any source table
  currencyFlags: { alias: string; marina_currency: string; property_currency: string; decision: CurrencyDecision | null }[];
  suggestions: { alias: string; rekey_to_alias: string | null }[];   // profile-less owners; evidence: overlay ids, labels unique to one profile, documents pointing at its bookings
  refusals: string[];               // non-empty -> importSidon throws ImportRefused(refusals.join('; '))
}

interface ImportOptions {
  mode: 'dry-run' | 'commit';       // importSidon never COMMITs/ROLLBACKs; the CLI does, by mode
  target: 'local' | 'live';
  files: boolean;                   // false = --no-files: no fetch, no store/putPublic, no messages export; rows identical otherwise; image url = Sidon url
  fetchBlob?: (url: string) => Promise<{ buf: Buffer; contentType: string | null }>;  // default: fetch(url, { signal: AbortSignal.timeout(30000) })
  now?: Date;                       // default new Date()
}
interface MarinaCounts {
  pontoons: number; berths: number; berths_duplicate: number; pontoon_nulled: number;
  tiers: number; requirements: number; templates: number; pois: number; images: number;
  bookings: number; bookings_no_berth: number; bookings_overlap: number; pending_expired: number; emails_nulled: number;
  occupancy: number; occupancy_overlap: number; signatures: number;
  documents_copied: number; documents_not_copied: number; documents_sailor_docs: number; documents_fetch_failed: number;
}
interface Report {
  mode: 'dry-run' | 'commit'; target: 'local' | 'live'; files: boolean;
  properties: { key: string; property_id: string; created: boolean; today: string }[];
  marinas: { alias: string; slug: string; property_id: string; counts: MarinaCounts }[];  // re-keyed rows counted under their target
  rekeys: { alias: string; to_alias: string }[];
  skips: { alias: string; reason: string }[];
  currencyFlags: Plan['currencyFlags'];
  unknownPlaceholders: { alias: string; template_id: string; fields: string[] }[];
  archived: string[];               // R14 "listed": marina-docs-archive/sidon/{alias}/{id}.{ext} paths (would-be paths under files:false)
  sailor_docs_unlinked: number; messages_exported: number;
  warnings: string[];
}
```

`importSidon` order inside the one transaction:
1. R11 guard (G5).
2. Create properties. Each created property gets `api_key = 'prop_' + crypto.randomBytes(32).toString('hex')`, `api_key_enabled = true` and `sidon_marina_id = owners[0]`. Starter tokens are granted inline, only for newly created properties and only when `STARTER_BALANCE > 0`: `UPDATE property SET token_balance = token_balance + $2 WHERE id = $1 RETURNING token_balance`, then `INSERT INTO property_token_ledger (property_id, delta, balance_after, reason) VALUES ($1, $2, $3, 'starter')`.
3. `DELETE FROM marina WHERE sidon_owner_id = ANY($1)` over all importing owners.
4. For each importing owner: the marina (`id = uid('marina', owner_id)`, `sidon_owner_id`, layout from `layouts`, `''` → NULL, `response_window_hours ?? 24`), then pontoons, berths, tiers, requirements, templates, POIs and images. Berth status `available`/`occupied`/`reserved` → `active` and `maintenance` → `maintenance`. A berth's `pontoon_id` is NULL when it points at another owner's overlay (counted in `pontoon_nulled`). Numbers are rounded to 2 dp. `drop_prices` sets berth `price_per_night` to NULL and imports no tiers.
5. Re-keyed owners: requirements are imported only when the target has none of that `type`, templates only when the target has none.
6. Bookings, all owners, in `created_at, id` order, each under `SAVEPOINT b`. `23P01` → overlap skip. A booking is matched to a berth by label in the target marina; a miss → no-berth skip. Fields: `currency` = the property's, `payment_status 'none'`, `legacy_payment_intent_id`, `total_price = amount_cents / 100` (NULL under `drop_prices`), `created_at`/`updated_at` preserved, and `contact_email_key = emailKey(email)`.
7. Occupancy.
8. Signatures for imported bookings only. `signer_email` = the booking's cleaned email; `agreed_at = signed_at`.
9. Documents, every Sidon document row, classified by `p = sourcePath(file_url)`, `ext = extOf(p)` and whether its `booking_id` maps to a booking imported in step 6:
   - linked, `p` starts with `marina-docs/`, inside retention (`insideRetention` on the imported booking's mapped status, departure and preserved `updated_at`, with that property's `today`), files on: `fetchBlob(file_url)`, `sniffType(buf)`; on success `docs.store.put(blob_pathname, buf, sniffed)` and insert with `content_type = sniffed`, `size_bytes = buf.length`, `file_deleted_at` NULL (`documents_copied`); a fetch error or null sniff → not-copied (`documents_fetch_failed`, also counted in `documents_not_copied`).
   - linked, `p` starts with `marina-docs/`, outside retention or files off → not-copied (`documents_not_copied`).
   - linked, `p` starts with `sailor-docs/` (or `p` null) → not-copied, never fetched (`documents_sailor_docs`).
   - not-copied rows: `file_deleted_at = now()`, `content_type = typeFromExt(ext)`, `size_bytes = 0`. Every inserted row: `id = uid('document', id)`, `blob_pathname = marina-docs/{property_id}/{booking_id}/sidon-{id}.{ext}`, the booking's `marina_id`, `requirement_id` via the requirement map or NULL, `type`, `file_name`, `extracted_data = JSON.parse` (NULL when blank/unparsable), `expiry_date = expiry_date?.toISOString().slice(0, 10) ?? null`, `status`, `notes`, `submitted_at`, `verified_at`.
   - unlinked (NULL `booking_id`, or a booking that was skipped or belongs to a skipped owner), `p` starts with `marina-docs/` → `marina-docs-archive/sidon/{alias of the doc's owner_id}/{id}.{ext}` pushed to `Report.archived`; with files on it is fetched and `docs.store.put` with the source content type (a fetch failure adds a `warnings[]` line, path still listed). Not inserted.
   - unlinked, any other `p` → only `sailor_docs_unlinked += 1`.
10. Messages export (files on only): per owner with messages, `docs.store.put(\`marina-archive/messages-${alias}.json\`, Buffer.from(JSON.stringify(rows)), 'application/json')` with the `Source.messages` columns; `messages_exported` = rows exported. (R17's `<owner>` is the owner's alias, so the path never shows an owner id.)
11. Return the Report.

Expected live numbers (survey `sidon-import.md` §4, adjusted for R14/G4; the runbook's Step 4 reconciles against these): berths 1,156 imported + 80 `berths_duplicate`; bookings 139 + 5 `bookings_no_berth` + 1 `bookings_overlap` (+3 of skipped `o_0ddee1`); `pending_expired` 66; occupancy 275; signatures 4. Documents differ from §4, which assumed copying `sailor-docs/*`: `documents_copied` 0, `documents_sailor_docs` 383, `Report.archived` 32 paths, `sailor_docs_unlinked` 169 (383 + 32 + 169 = 584). Messages exported 41.

#### O — `scripts/check-import-sidon.js` (Task 1 creates; Tasks 2–4 append checks; Task 14 deletes it)

Run it as `node -r dotenv/config scripts/check-import-sidon.js`, from O. It uses the `check-marina.js` harness: refuse a `neon.tech|render.com` DATABASE_URL, use one `pg.Client`, `BEGIN`, a `SAVEPOINT c` per `check(name, fn)`, `ROLLBACK` at the end, and `process.exitCode = failed ? 1 : 0`. Inside the transaction it runs `CREATE SCHEMA sidon_fixture`, the fixture tables (exactly the `Source` column lists, with Sidon types: owner ids text, serial ids int, dates text `YYYY-MM-DD`, tier dates text `YYYY-MM-DDT00:00:00.000+01:00`, timestamps timestamptz) and the fixture rows. Helper `const fixture = () => readSource(db, 'sidon_fixture')`. Blob stubs: `docs.store = { put: async (p, buf) => { blobs.set(p, buf); }, get: async () => null, del: async () => {} }` and `docs.putPublic = async (p) => 'https://public.example/' + p`, plus `fetchBlob` returning `%PDF-` or WebP buffers and recording each URL. It sets `process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret'` before requiring anything (Task 3 compares `bookingToken(id)` across runs). Each importer run in a check calls `readTargets` and `planMapping` afresh, so a second run sees the first run's created property through `Targets.reruns`. Each later task appends above the line `// (later tasks append checks here)`.

#### O — demo seed (Task 5 produces; Tasks 5–9 consume)

`scripts/seed-marina-demo.js` accepts `MARINA_DEMO_SLUG`. It sets `const SLUG = process.env.MARINA_DEMO_SLUG || 'demo-marina'`, validated against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and uses `SLUG` in place of the literal `'demo-marina'` (the `put` key and the `slug=` output line). The output keeps the same machine-readable lines: `api_key=<key>` and `slug=<slug>`.

#### Consumer sites — shared pieces (Tasks 5–9)

Widget tarball, built once per machine:

```bash
mkdir -p /c/tmp/plan-d
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"   # must print 1.1.0, else stop (plan C not done)
(cd /c/Users/robert/source/repos/sidon-booking-widget && npm run build && npm pack --pack-destination /c/tmp/plan-d)
# -> C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
```

The forwarder, `src/pages/api/marina/guest/[...path].ts`, is this exact text everywhere except tested-trappist (see below):

```ts
// OTA's guest API for the booking widget, with this site's property key
// added server-side (the browser never sees it). Only /api/marina/guest/*.
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Astro reads this flag from this file's source text, so it can't come
// from the package.
export const prerender = false;

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;

// Kill switch: without both env vars booking is hidden, and this answers
// one clear JSON 503 instead of a proxy with no key (404 for every slug).
const proxy = otaBaseUrl && apiKey
  ? createMarinaProxy({ otaBaseUrl, keys: apiKey })
  : () => new Response(JSON.stringify({ error: 'Online booking is not available' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

export const GET = proxy;
export const POST = proxy;
```

tested-trappist variant: `import { OTA_API_KEY, OTA_BASE_URL } from 'astro:env/server';` replaces the two `import.meta.env` reads, written as `const otaBaseUrl = OTA_BASE_URL; const apiKey = OTA_API_KEY;` (G7). Everything else is identical. Its `astro.config.mjs` env schema gains exactly `OTA_BASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),` next to the existing `OTA_API_KEY` line, and loses `SIDON_URL`, `SIDON_APIKEY`, `PUBLIC_SIDON_MARINA_ID` and `PUBLIC_SIDON_ORIGIN`.

Env timing (every site): Astro inlines `import.meta.env` reads into the server bundle at build time, so adding, changing or clearing `OTA_BASE_URL`/`OTA_API_KEY` in Vercel takes effect only after a redeploy (tested-trappist's `astro:env` secrets are read at runtime). The runbook says "redeploy" after every env change.

OTA's guest map payload, `GET /api/marina/guest/:slug[?from&to]` (`OTA/src/controllers/marinaGuest.js` `getMarinaMap`), which `createMarinaClient().getMarina(slug)` returns raw and the SEA, PO and MP adapters (and the PO/MP browser fetch adapters) map from:
```ts
{
  marina: { name, slug, description, lat: number|null, lng: number|null, phone, email, website,
            layout: { svg, sw_lat, sw_lng, ne_lat, ne_lng, rotation } | null },
  pontoons: { id /* uuid */, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order }[],
  berths: { label, pontoon_id: string|null, lat, lng, rotation, length_m: string|null, min_length_m, beam_m, depth_m,
            price_per_night: string|null, price_mode: 'per_metre'|'fixed', available: boolean }[],   // NUMERIC as strings; inactive berths omitted
  price_tiers: { valid_from, valid_to /* inclusive */, max_length_m: string, max_beam_m: string|null,
                 price_per_night: string, price_per_month: string|null, price_per_year: string|null }[],
  pois: { label, type, lat, lng }[],
  images: { url, description }[],
  currency: string,                 // upper-case ISO, e.g. 'EUR'
  stripe_publishable_key: string|null,
}
```
`getDocRequirements(slug)` returns OTA's bare array `{ id /* uuid */, type, name, description, fields: {name,label,type}[], mandatory }[]` or `null`. `GET .../availability?arrival&departure&boat_length_m[&boat_beam_m]` returns `{ label, pontoon_id, length_m, beam_m, depth_m, nights, total_price, tier_id }[]` (free berths that fit). `POST .../bookings` returns `201 { booking: { id, ... }, booking_token, payment: { client_secret, publishable_key } | null }`; errors are `{ error }`.

The booking page, `src/pages/booking.astro` (SEA adds the `?marina=` whitelist, G8), has this shape:

```astro
---
// OTA's guest emails and confirm link land here with ?booking=&token=.
// Bare on purpose (no site layout, analytics or fonts): the token is in the URL.
export const prerender = false;
Astro.response.headers.set('Referrer-Policy', 'no-referrer');
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Your booking — {MARINA_NAME}</title>
  </head>
  <body>
    <main style="max-width:680px;margin:0 auto;padding:24px 0">
      <sidon-booking-widget marina={SLUG} booking-id variant="dark" marina-name={MARINA_NAME} logo-mark={LOGO} style={BRAND_STYLE}></sidon-booking-widget>
    </main>
    <script>import '@forgebuild/sidon-booking-widget';</script>
  </body>
</html>
```

There is no `locale` attribute (G12), no `api-origin` and no `currency-symbol` (R24). The page is SSR, so `@astrojs/sitemap` doesn't list it. The task asserts that the built sitemap has no `/booking` entry, and adds `sitemap({ filter: (p) => !p.includes('/booking') })` only if it does.

Lazy server client, in each site that reads at build/SSR time (`SEA`, `PO`, `MP`: `src/lib/marina-api.ts`):

```ts
import { createMarinaClient } from '@forgebuild/sidon-booking-widget/astro-proxy';
const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;
// Kill switch: no env -> no client (createMarinaClient throws on empty values).
const client = otaBaseUrl && apiKey ? createMarinaClient({ otaBaseUrl, keys: apiKey }) : null;
export const bookingEnabled = client !== null;
// getMarina(...) returns null when !bookingEnabled; callers render the VHF/phone fallback.
```

PB and TT have no server reads. They gate the booking block inline: PB on `import.meta.env.OTA_BASE_URL && import.meta.env.OTA_API_KEY`, and TT on `OTA_BASE_URL` from `astro:env/server` (G7).

Booking paths and URLs (runbook inputs fill `<origin>`):

| site | slug(s) | booking page file | `booking_url` |
|---|---|---|---|
| PB | `pirates-bight` | `src/pages/booking.astro` | `<origin>/booking?booking={id}&token={token}` |
| TT | `BBYC_SLUG` (`src/lib/marina.ts`: `export const BBYC_SLUG = 'bora-bora-yacht-club';`) | `src/pages/booking.astro` | `<origin>/booking?booking={id}&token={token}` |
| SEA | `fox-mooring`, `pevero-mooring` | `src/pages/booking.astro` (`?marina=`) | `<origin>/booking?marina=<slug>&booking={id}&token={token}` |
| PO | `puerto-portals` | `src/pages/booking.astro` | `<origin>/booking?booking={id}&token={token}` |
| MP | `marina-di-positano` (`MARINA_SLUG` in `src/lib/marina-api.ts`) | `src/pages/booking.astro` | `<origin>/booking?booking={id}&token={token}` |

Site verification procedure. Every site task runs this; `<slug>`, `<port>` and `<scheme>` come from the site:

Shell variables do not survive between Bash tool calls, so every command that needs the key re-derives it in the same command with `KEY=$(...)`. Re-seeding is idempotent and keeps the same key, and the key is never echoed. `<curl>` is `curl -s` (`curl -sk` for MP's HTTPS).

```bash
# O (once per site): demo marina under the site's slug(s) + local OTA
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=<slug> node scripts/seed-marina-demo.js | grep -v '^api_key='   # repeat per slug (SEA: both)
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start      # run_in_background; needs MARINA_BOOKING_TOKEN_SECRET in O/.env
# site (each line is one Bash call, from the site root)
npx astro check                # baseline on master first; error count must not increase
KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=<slug> node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npm run build
OTA_BASE_URL= OTA_API_KEY= npm run build                      # kill switch: must succeed (TT: OTA_BASE_URL= only, G7)
KEY=$(...same...); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npx astro dev --port <port>   # run_in_background
<curl> <scheme>://localhost:<port>/api/marina/guest/<slug> | head -c 300                           # JSON with "marina"
<curl> -X POST <scheme>://localhost:<port>/api/marina/guest/<slug>/bookings -H 'Content-Type: application/json' \
  -d '{"berth_label":"A2","arrival":"<today+30>","departure":"<today+32>","contact_name":"Plan D","contact_email":"plan-d+<site>@example.com","boat_name":"Check","boat_length_m":9}'
#   -> 201 {booking:{id}, booking_token}. A 409 on a re-run means the previous run's booking still holds A2: use "A4".
<curl> -D - "<scheme>://localhost:<port>/booking?booking=<id>&token=<token>" -o /tmp/booking.html | grep -i '^referrer-policy: no-referrer'   # and status 200
#   SEA: /booking?marina=<slug>&booking=<id>&token=<token>
grep -c 'sidon-booking-widget' /tmp/booking.html; grep -c 'content="no-referrer"' /tmp/booking.html; grep -c 'noindex' /tmp/booking.html   # each >= 1
# kill-switch dev: stop the dev server, restart with OTA_BASE_URL= OTA_API_KEY= (TT: OTA_BASE_URL= only); then the booking-carrying page
# (Review Focus 5 list) has no <sidon-booking-widget and shows the fallback, and <curl> /api/marina/guest/<slug> -> 503 {"error":"Online booking is not available"}
# end: stop the dev server and the local OTA server
```

#### SM — `src/lib/cutover.ts` (Task 10 creates it on `cutover/freeze`; Task 11 extends it on `cutover/switch`; no runtime imports, so Node can test it directly)

```ts
export type CutoverPhase = 'freeze' | 'switch';
export const CUTOVER_PHASE: CutoverPhase = 'freeze';          // the cutover/switch commit changes this to 'switch'
export const OTA_DASHBOARD_DEFAULT = 'https://hotal.forge-build.co.uk';
export type CutoverAction =
  | { kind: 'readonly' }                                      // 503
  | { kind: 'gone' }                                          // 410
  | { kind: 'preflight' }                                     // 204
  | { kind: 'redirect'; location: string }                    // 301
  | null;                                                     // fall through
// freeze: pathname.startsWith('/api/marina/') && method not in GET|HEAD|OPTIONS -> readonly
// switch: '/api/marina/...' -> OPTIONS ? preflight : gone (every method);
//         pathname === '/marina' || startsWith('/marina/') -> redirect `${dashboardUrl}/marina`
export function cutoverAction(phase: CutoverPhase, method: string, pathname: string, dashboardUrl: string): CutoverAction;
// switch branch only:
export const MARINA_SITES: Record<string, string>;            // slug -> the marina's home URL on its own site (runbook inputs); defaults:
// { 'pirates-bight': 'https://pirates-bight.vercel.app/', 'fox-mooring': 'https://sea-company.vercel.app/',
//   'pevero-mooring': 'https://sea-company.vercel.app/pevero-mooring', 'marina-di-positano': 'https://marina-di-positano.vercel.app/',
//   'puerto-portals': 'https://portals.vercel.app/' }
// Matches /^\/(?:[a-z]{2}\/)?m\/([^/]+)(?:\/(.*))?$/ and returns MARINA_SITES[slug] exactly (every sub-page -> that one URL;
// the sites' paths don't line up with Sidon's). Rest matching /^booking\/[^/]+\/?$/ -> null (old-link page);
// unknown slug (e.g. BBYC, which SM never served), no match -> null.
export function marinaSiteRedirect(pathname: string): string | null;
```

`src/middleware.ts`: `export const onRequest = sequence(cutover, clerkMiddleware());`, where `cutover` is a `defineMiddleware` that maps the action to a `Response`, with `CORS_HEADERS` from `./lib/cors` and `Content-Type: application/json`.
- 503 body: `{"error":"Sidon Marina is read-only while marinas move to a new booking system. Please try again later."}`, plus `Retry-After: 86400`.
- 410 body: `{"error":"Sidon Marina has moved to OTA","details":"Berth booking now runs on each marina's own website; staff use <DASH>/marina"}`.
- `DASH = import.meta.env.OTA_DASHBOARD_URL || OTA_DASHBOARD_DEFAULT`.

The check is `SM/scripts/check-cutover.ts`, run as `node scripts/check-cutover.ts`. It imports `../src/lib/cutover.ts` and uses `node:assert/strict`.

The switch branch's pages:
- Delete everything under `src/pages/m/**` and `src/pages/[lang]/m/**`, except `src/pages/m/[slug]/booking/[id].astro`. That one stays a 302 but is rewritten to need no content or DB lookup (today it calls `getMarinaContent`, which reads Sidon's DB through `getMarinaGeo`): `return Astro.redirect(\`/en/m/${Astro.params.slug}/booking/${Astro.params.id}\`, 302);` with `export const prerender = false;`.
- Add `src/pages/m/[slug]/[...path].astro` and `src/pages/[lang]/m/[slug]/[...path].astro` (`export const prerender = false`; `marinaSiteRedirect(Astro.url.pathname)` → `Astro.redirect(to, 301)`, else `new Response(null, { status: 404 })`).
- Replace `src/pages/[lang]/m/[slug]/booking/[id].astro` with a static notice ("This booking link is no longer valid. Please contact the marina."). It is SSR (`export const prerender = false;`), does no DB or content read, renders no booking data and carries `<meta name="robots" content="noindex">`. Astro ranks `booking/[id]` above the `[...path]` rest route, so the notice wins for old links.
- `src/components/marina/NavMarinaSite.astro`: delete the `NavAuth`, `NavAuthFallback`, `SignedIn`/`OrganizationSwitcher` and `appearance` imports and their markup; both `href="/marina"` links become `href={\`${import.meta.env.OTA_DASHBOARD_URL || OTA_DASHBOARD_DEFAULT}/marina\`}` (`OTA_DASHBOARD_DEFAULT` imported from `../../lib/cutover`). The page that holds it (`/`) is prerendered, so the runbook sets `OTA_DASHBOARD_URL` in SM's Vercel env before the switch build.
- Delete `MarinaMessageSticky.astro`, `MarinaEnquiryDrawer.astro` and every hand-rolled public booking component/script (survey `sidon-retire.md` §2 list) plus any layout or lib file whose last importer was deleted; keep a file that a remaining file still imports (e.g. through `marina-dashboard/MarinaMapTab.astro`). `npm run build` plus an import `rg` decide.

#### O — switch (Task 13) and cleanup (Task 14)

On `cutover/switch`, `mcp-server/tools.js` `list_marina_bookings` becomes:
```js
{
  name: 'list_marina_bookings',
  description: 'Berth bookings across this property\'s marinas, paged ({ total, data }), ordered by arrival then berth. from = bookings departing after this date (open-ended always included), to = arriving before it. Guest checkouts in progress (holds) are never listed.',
  inputSchema: {
    from: z.string().optional().describe('YYYY-MM-DD'), to: z.string().optional().describe('YYYY-MM-DD'),
    status: z.enum(['pending', 'confirmed', 'declined', 'cancelled']).optional(),
    marina_id: z.string().optional(), berth_id: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
  },
  run: (query) => apiRequest('GET', '/api/marina/bookings', { query }),
}
```
Also on `cutover/switch`: delete the `/sidon-bookings` route line (`src/routes/marina.js:24`), `listMarinaBookings` and `SIDON_API_ORIGIN` from `src/controllers/marina.js`, and the `'/api/marina/sidon-bookings'` entry in `src/docs/swagger.js` (~line 637). `scripts/check-marina.js` (~line 232) currently asserts `list_marina_bookings` "stays on the interim proxy until Switch"; on `cutover/switch` that assertion flips first (failing): `list_marina_bookings` called with `{ from: '2027-06-01', status: 'pending', limit: 50 }` makes exactly the call `GET /api/marina/bookings` with `query` deep-equal to those args, and its `run` source no longer contains `sidon-bookings`.

`cutover/cleanup`, commit 1:
- Delete `src/controllers/marina.js`, plus its `require` and the `/key` and `/key/clear` routes (and the "Interim Sidon link" comment).
- Remove the `'/api/marina/key'` and `'/api/marina/key/clear'` entries from `src/docs/swagger.js`, and the `sidon_marina_id`/`sidon_marina_key_set` properties from the `/api/property/me` GET and PUT schemas (`src/docs/swagger.js:181-182`).
- `src/controllers/property.js` `getCurrentProperty`/`updateCurrentProperty` (routes `GET`/`PUT /api/property/me`) stop reading and writing `sidon_marina_id`/`sidon_marina_key`: drop them from both column lists, the `sidon_marina_id` destructure and its 400 validation, the two `CASE` lines and their `$12`/`$13` params. A body `sidon_marina_id` is ignored (200), and the SQL parameters are renumbered.
- `mcp-server/tools.js`: remove `sidon_marina_id` from `get_property`'s description and from `update_property`'s `inputSchema`.
- Failing first, in `scripts/check-marina-http.js` (above its later-tasks marker): `GET /api/property/me` has neither `sidon_marina_id` nor `sidon_marina_key_set` keys; `PUT /api/property/me` with `{ sidon_marina_id: 'org_x' }` answers 200 and the next GET still has no such key; `PUT /api/marina/key` answers 404.

`cutover/cleanup`, commit 2: the migration `src/db/migrate-2026-10-12-drop-sidon-columns.sql`, mirrored in `src/db/schema.sql`:
```sql
-- Run ONLY after the cutover/cleanup code is live on Render (nothing reads these any more).
ALTER TABLE property DROP COLUMN IF EXISTS sidon_marina_id, DROP COLUMN IF EXISTS sidon_marina_key;
ALTER TABLE marina DROP COLUMN IF EXISTS sidon_owner_id;
ALTER TABLE marina_booking DROP COLUMN IF EXISTS legacy_payment_intent_id;
```
The `schema.sql` mirror removes the two property columns and their comment block (above `sidon_marina_id` in `CREATE TABLE property`), `sidon_owner_id` from `CREATE TABLE marina` and `legacy_payment_intent_id` from `CREATE TABLE marina_booking`. The same commit deletes `scripts/import-sidon-marina.js` and `scripts/check-import-sidon.js` (G10). Never run it with `scripts/run-migration.js` in a task, because that also hits `DATABASE_URL_LIVE`. A task verifies it only inside a rolled-back transaction on `DATABASE_URL` (`BEGIN; <file>; ROLLBACK;`).

Acceptance after commit 2: `rg -n "sidon_marina|sidon_owner_id|legacy_payment_intent_id|sidon-bookings|SIDON_API_ORIGIN" src mcp-server scripts -g '!src/db/migrate-2026-10-1[01]-*'` prints only `src/db/migrate-2026-10-12-drop-sidon-columns.sql` (the older migrations that added the columns stay as history).

#### D — cleanup (Task 15)

Plan C's layout this builds on (`contract-c.md`): `src/scripts/marina-client.ts` is a router (`const marinas = await loadMarinas(); marinas.length ? await import('./marina-dashboard') : await import('./marina-interim');`), `src/scripts/marina-interim.ts` holds today's Sidon code with `await import('sidon-booking-widget-legacy/berth-map')`, `loadMarinas()` and `loadProperty()` live in `src/scripts/sidebar-modules-widget.ts`, and D calls OTA through the existing `apiFetch(path, options?, token?)` (`src/scripts/api-client.ts`). At cleanup: `marina-client.ts` becomes `await import('./marina-dashboard');` with no branch (or the page imports `marina-dashboard` directly), `marina-interim.ts` is deleted, the interim markup in `src/pages/marina.astro` (`#marina-empty` with its "Add your Sidon marina ID" text, `#marina-map`, `#marina-bookings`) is deleted, `loadProperty()`'s type drops `sidon_marina_id`/`sidon_marina_key_set`, and the nav rule becomes `(await loadMarinas()).length > 0`. The staff-forwarder smoke case in `tests/marina-interim.spec.ts` stays.

Acceptance is that `rg -n -i "sidon_marina|sidon-marina-id|sidon-marina-key|sidon-bookings|SIDON_API_ORIGIN|marina\.sidonmarine\.uk|sidon marina|sidon-booking-widget-legacy" D/src D/package.json D/tests` prints nothing. The package name `@forgebuild/sidon-booking-widget` and the element `sidon-berth-map` stay. Removed: the Settings Sidon form (`#marina-form`, `#sidon-marina-id`, `#sidon-marina-key`, `#sidon-marina-save` in `settings.astro`) and its logic in `settings-client.ts` (`saveSidonMarinaKey`, `loadSidonMarina`, the submit handler and its `[data-marina]` toggle); the `sidon_marina_id` branch and type fields in `sidebar-modules-widget.ts` and the matching comment in `Layout.astro`; the interim branch of `/marina` and the Sidon path of `marina-client.ts` (plus the `MarinaBooking` Sidon type); plan C's npm alias `sidon-booking-widget-legacy` (`package.json` + `package-lock.json` via `npm uninstall sidon-booking-widget-legacy`); any plan C Playwright case that asserts the interim page (the nav/interim cases in `tests/marina-interim.spec.ts` are rewritten to "no active marina → no Marina nav; ≥1 → nav + dashboard"). The nav shows Marina iff `GET /api/marina/marinas` returns at least one row. `/marina` always renders plan C's dashboard.

#### Runbook (Task 16)

The file is `O/docs/superpowers/runbooks/2026-10-marina-cutover.md`. Its sections, in this order: `## Prerequisites`, `## Inputs to collect`, `## Branches and when they merge`, `## Step 1 — Dark deploy`, `## Step 2 — Map`, `## Step 3 — Freeze`, `## Step 4 — Import`, `## Step 5 — Verify`, `## Step 6 — Switch`, `## Step 7 — Clean up`, `## Rollback (until step 7)`, `## Notes (spec amendments)`.

Every outward action in it (npm login/publish, any push, merge, deploy, Vercel/Render env change, live migration, `gh repo create`, `gh repo archive`, tag push, local `master` reset, blob deletion) is marked "needs the user's go-ahead". Required content beyond R35: the G6 lockfile step on each consumer `cutover/switch` branch after `npm publish`; "redeploy after every env change" (env timing above); `OTA_DASHBOARD_URL` set in SM's Vercel env before the switch build; Step 4's expected numbers are the "Expected live numbers" list above (not §4's document columns); Step 2's sign-off records the G4 consequence (no document file is copied); Step 6 sets each `booking_url` from the booking-paths table. `## Branches and when they merge` lists every branch named in this contract: SM `cutover/freeze` (Step 3), SM/PB/TT/SEA/PO/MP/SA/O `cutover/switch` (Step 6; PO and MP after their `gh repo create`, PO merged but not deployed), O and D `cutover/cleanup` (Step 7, two weeks after Switch; the column-drop migration on live only after the O cleanup deploy is live).

### Plan conventions

- Each task has **Files**, **Interfaces** (Consumes/Produces using the names above), and then `- [ ]` steps. Pure logic gets a failing check first: run it (expect failure), implement, run it again (expect pass), run the repo's other gates, then commit. The commit is `git -C <repo> add <explicit paths> && git -C <repo> commit -m "..."` (never `-A`); the message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Repos without pure logic (consumer sites, sidon-ai, dashboard cleanup) verify by the stated commands instead.
- Gates:
  - O: `node -r dotenv/config scripts/check-import-sidon.js` (until Task 14's commit 2 deletes it), `node -r dotenv/config scripts/check-marina.js`, `node -r dotenv/config scripts/check-marina-http.js` (run from O, local DB only; each ends `all passed`).
  - Sites: the verification procedure above.
  - SM: `node scripts/check-cutover.ts` + `npm run build`.
  - SA: `rg` + `npm run build` + Playwright.
  - D: `npx astro check`, `npm run build`, `node scripts/check-marina.ts`, `npx playwright test tests/marina*.spec.ts`.
- Branch work: `git -C <repo> switch -c <branch> <base>`. Never commit to `main`/`master` except O `main` (importer, check, seed, runbook). Never push. Leave the repo on the task's branch at the end and say so.
- Complete code in every code step (no "similar to", no TODO). Match the surrounding comment style (explain why). Locate edit points in non-OTA repos by code markers, not survey line numbers; WIP commits can shift those.
- Windows host; commands are for Git Bash; absolute `/c/Users/robert/source/repos/...` paths. Long-running servers use `run_in_background` and are stopped at the end of the task.
- Personal-data hygiene in logs: never `cat` a `.env`, a map file with real ids, or a seed's `api_key=` line into output. Keep them in shell variables.

---

## Tasks

### Task 1: Importer read side, mapping plan and its check (O main)

Repo `O` = `C:/Users/robert/source/repos/OTA`, branch `main`. Run every command from `O` in Git Bash. This task creates the module and the check harness that Tasks 2–4 extend. It writes to no database except inside the check's rolled-back transaction, and it never connects to Sidon: the CLI's `--map` mode reads Sidon, but only the runbook runs it (Step 2).

**Files:**
- Create: `scripts/import-sidon-marina.js`: pure helpers, `loadMap`, `readSource`, `readTargets`, `planMapping`, `formatPlan`, and the CLI with `--map` only.
- Create: `scripts/check-import-sidon.js`: the harness, the `sidon_fixture` schema and its rows, and the Task 1 checks, ending with the marker `// (later tasks append checks here)`.
- Not touched: the untracked `=` and `src/db/seed-extras.sql.pre-multi-property.bak`.

**Interfaces:**
- Consumes: `require('../src/db')` (DATE parser), the `check-marina.js` harness pattern, and the plan A columns `property.sidon_marina_id` and `marina.sidon_owner_id`.
- Produces (contract names): `ImportRefused`, `alias`, `uid`, `slugify`, `tierDate`, `cleanEmail`, `mapBookingStatus`, `insideRetention`, `loadMap`, `readSource`, `readTargets`, `planMapping` and `formatPlan`. Task 2 replaces three blocks by anchor: the top-of-file block starting `require('dotenv').config();`, the `module.exports = {` statement and the CLI block `if (require.main === module) {`.
- In the check: `db`, `check(name, fn)`, `one`, `assert`, `fixture()`, `mapFile(owners)`, `plan(owners)`, the 13 `sidon_fixture.*` tables with exactly the `Source` columns, and the marker line.
- Fixture owners: `FOX` and `PEV` share one created property (G1). `BB` reuses a GBP property with a eur marina. `GHOST` is profile-less, and its re-key suggestion is FOX. `CHAT` has messages only, so it is auto-skipped (G13). `AMB` has a booking on a label that exists in two marinas, so it gets no suggestion; its map key is its alias (G2).

- [ ] **Step 1: Write the failing check**

Create `scripts/check-import-sidon.js`:

```js
// Checks scripts/import-sidon-marina.js against the local DB. A small Sidon
// fixture lives in its own schema (sidon_fixture: Sidon's table names collide
// with OTA's), and everything happens inside one transaction that is rolled
// back. Never point this at the live DB.
//   node -r dotenv/config scripts/check-import-sidon.js
process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret';
require('../src/db'); // DATE as 'YYYY-MM-DD' strings
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const I = require('./import-sidon-marina');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

// Sidon's live types (survey sidon-import.md §1), only the columns the importer reads.
const FIXTURE_DDL = `
CREATE SCHEMA sidon_fixture;
CREATE TABLE sidon_fixture.marina_profile (owner_id text PRIMARY KEY, slug text, name text NOT NULL, lat double precision, lng double precision,
  description text, phone text, email text, website text, response_window_hours int, currency text NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_layout (owner_id text PRIMARY KEY, svg_data text, sw_lat double precision, sw_lng double precision,
  ne_lat double precision, ne_lng double precision, rotation real);
CREATE TABLE sidon_fixture.marina_overlay (id serial PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, svg_data text, sw_lat double precision,
  sw_lng double precision, ne_lat double precision, ne_lng double precision, rotation double precision, sort_order int);
CREATE TABLE sidon_fixture.marina_berth (id serial PRIMARY KEY, owner_id text NOT NULL, berth_id text NOT NULL, overlay_id int, lat double precision,
  lng double precision, length_m real, min_length_m real, beam_m real, depth_m real, status text NOT NULL, guest_name text, notes text,
  price_per_night real, price_mode text, rotation real);
CREATE TABLE sidon_fixture.marina_price_tier (id serial PRIMARY KEY, owner_id text NOT NULL, valid_from text NOT NULL, valid_to text NOT NULL,
  max_len_m real NOT NULL, max_beam_m real, price_per_night int NOT NULL, price_per_month int, price_per_year int, created_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.berth_booking (id serial PRIMARY KEY, owner_id text NOT NULL, berth_id text NOT NULL, sailor_name text NOT NULL,
  sailor_email text NOT NULL, boat_name text NOT NULL, boat_loa real, boat_beam real, arrival_date text NOT NULL, departure_date text NOT NULL,
  notes text, status text NOT NULL, payment_intent_id text, amount_cents int, expires_at timestamptz, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_doc_requirement (id serial PRIMARY KEY, owner_id text NOT NULL, type text NOT NULL, name text NOT NULL,
  description text, schema text NOT NULL, mandatory int NOT NULL, sort_order int);
CREATE TABLE sidon_fixture.marina_document (id serial PRIMARY KEY, owner_id text NOT NULL, requirement_id int NOT NULL, booking_id int,
  status text NOT NULL, notes text, submitted_at timestamptz NOT NULL, verified_at timestamptz, type text, file_url text, file_name text,
  extracted_data text, expiry_date timestamptz);
CREATE TABLE sidon_fixture.marina_contract_template (id serial PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, body_markdown text NOT NULL,
  min_nights int, active int NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_contract_signature (id serial PRIMARY KEY, owner_id text NOT NULL, template_id int NOT NULL, booking_id int NOT NULL,
  rendered_body text NOT NULL, signed_at timestamptz NOT NULL, ip_address text, user_agent text);
CREATE TABLE sidon_fixture.marina_poi (id serial PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL, type text NOT NULL,
  lat double precision NOT NULL, lng double precision NOT NULL);
CREATE TABLE sidon_fixture.marina_image (id serial PRIMARY KEY, owner_id text NOT NULL, url text NOT NULL, description text, sort_order int,
  created_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_message (id serial PRIMARY KEY, owner_id text NOT NULL, sailor_id text, enquiry_cookie_hash text, sailor_email text,
  sailor_name text, direction text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL, read_at timestamptz);
`;

// Owners: FOX and PEV share one created property (G1), BB reuses a GBP
// property with a eur marina (currency flag), GHOST is profile-less with
// berths on FOX's overlay (re-key suggestion), CHAT has only messages
// (auto-skip, G13), AMB has bookings whose label is in FOX and PEV (no
// single suggestion).
const FOX = 'org_fixFox', PEV = 'org_fixPevero', BB = 'org_fixBbyc', GHOST = 'user_fixGhost', CHAT = 'user_fixChat', AMB = 'user_fixAmb';
const EMAIL = 'skipper.fixture@example.com', SAILOR = 'Fixture Skipper', GUEST = 'Fixture Guest';
const FIXTURE_ROWS = `
INSERT INTO sidon_fixture.marina_profile VALUES
  ('${FOX}', 'fox-mooring', 'Fox Mooring', 41.1, 9.5, '', '', '', NULL, 24, 'eur', '2026-08-01T00:00:00Z'),
  ('${PEV}', NULL, 'Pevero Mooring', 41.1, 9.5, 'Moorings', NULL, 'office.fixture@example.com', NULL, 24, 'eur', '2026-08-01T00:00:00Z'),
  ('${BB}', 'bbyc', 'Fixture Yacht Club', -16.5, -151.7, NULL, NULL, NULL, NULL, 24, 'eur', '2026-08-01T00:00:00Z');
INSERT INTO sidon_fixture.marina_layout VALUES ('${FOX}', '<svg/>', 41.0, 9.4, 41.2, 9.6, 12.5);
INSERT INTO sidon_fixture.marina_overlay (id, owner_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order) VALUES
  (1, '${FOX}', 'Pontoon A', '<path/>', 41.0, 9.4, 41.1, 9.5, 0, 1);
INSERT INTO sidon_fixture.marina_berth (id, owner_id, berth_id, overlay_id, length_m, beam_m, status, guest_name, price_per_night, price_mode) VALUES
  (1, '${FOX}', 'A1', 1, 12, 4, 'available', NULL, 5, 'per_metre'),
  (2, '${FOX}', 'S1', 1, 10, 3.5, 'occupied', '${GUEST}', 5, 'per_metre'),
  (3, '${PEV}', 'S1', NULL, 15, 5, 'available', NULL, 80, 'fixed'),
  (4, '${BB}', 'B1', NULL, 20, 6, 'reserved', NULL, 100, 'fixed'),
  (5, '${GHOST}', 'A1', 1, 12, 4, 'available', NULL, 5, 'per_metre');
INSERT INTO sidon_fixture.marina_price_tier (id, owner_id, valid_from, valid_to, max_len_m, price_per_night, created_at) VALUES
  (1, '${FOX}', '2026-06-01T00:00:00.000+01:00', '2026-09-30T00:00:00.000+01:00', 15, 50, '2026-04-01T10:00:00Z');
INSERT INTO sidon_fixture.berth_booking (id, owner_id, berth_id, sailor_name, sailor_email, boat_name, arrival_date, departure_date, status, amount_cents, expires_at, created_at, updated_at) VALUES
  (2, '${FOX}', 'A1', '${SAILOR}', '${EMAIL}', 'Fixture Boat', '2026-07-01', '2026-07-05', 'confirmed', 20000, NULL, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z'),
  (1, '${FOX}', 'A1', '${SAILOR}', '${EMAIL}', 'Fixture Boat', '2026-06-01', '2026-06-03', 'pending', NULL, '2026-05-02T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
  (3, '${AMB}', 'S1', '${SAILOR}', '${EMAIL}', 'Fixture Boat', '2026-06-10', '2026-06-12', 'cancelled', NULL, NULL, '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z');
INSERT INTO sidon_fixture.marina_doc_requirement (owner_id, type, name, schema, mandatory) VALUES ('${FOX}', 'insurance', 'Insurance', '[]', 1);
INSERT INTO sidon_fixture.marina_document (owner_id, requirement_id, booking_id, status, submitted_at, type, file_url, file_name) VALUES
  ('${FOX}', 1, 2, 'verified', '2026-06-20T00:00:00Z', 'insurance', 'https://x.public.blob.vercel-storage.com/sailor-docs/u/1.pdf', 'ins.pdf');
INSERT INTO sidon_fixture.marina_contract_template (owner_id, name, body_markdown, active, created_at) VALUES ('${FOX}', 'Contract', 'I, {{sailor_name}}', 1, '2026-04-03T00:00:00Z');
INSERT INTO sidon_fixture.marina_contract_signature (owner_id, template_id, booking_id, rendered_body, signed_at) VALUES ('${FOX}', 1, 2, 'I, ${SAILOR}', '2026-06-21T00:00:00Z');
INSERT INTO sidon_fixture.marina_poi (owner_id, label, type, lat, lng) VALUES ('${FOX}', 'Fuel dock', 'fuel', 41.11, 9.51);
INSERT INTO sidon_fixture.marina_image (owner_id, url, created_at) VALUES ('${FOX}', 'https://x.public.blob.vercel-storage.com/marina/f/1.webp', '2026-04-06T00:00:00Z');
INSERT INTO sidon_fixture.marina_message (owner_id, sailor_email, sailor_name, direction, body, created_at) VALUES
  ('${CHAT}', '${EMAIL}', '${SAILOR}', 'in', 'Hello', '2026-05-01T00:00:00Z');
`;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
    // Every check starts from the same fixture: nothing one check inserts is seen by the next.
    await db.query('ROLLBACK TO SAVEPOINT c');
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const fixture = () => I.readSource(db, 'sidon_fixture');
  let n = 0;
  const mapFile = (owners) => {
    const f = path.join(os.tmpdir(), `check-import-sidon-${process.pid}-${n++}.json`);
    fs.writeFileSync(f, JSON.stringify({ owners }));
    return f;
  };
  const plan = async (owners) => {
    const source = await fixture();
    const map = I.loadMap(mapFile(owners));
    return I.planMapping(source, map, await I.readTargets(db, source, map));
  };

  try {
    await db.query(FIXTURE_DDL);
    await db.query(FIXTURE_ROWS);
    const BBP = (await one(`INSERT INTO property (name, currency, timezone) VALUES ('Fixture BB', 'GBP', 'Pacific/Tahiti') RETURNING id`)).id;
    const SEA = { action: 'create', name: 'Fixture SEA', timezone: 'Europe/Rome', clerk_org_id: 'org_check_sea' };
    const baseMap = () => ({
      [FOX]: { ...SEA }, [PEV]: { ...SEA, slug: 'pevero-mooring' },
      [BB]: { action: 'property', property_id: BBP, currency_decision: 'drop_prices' },
      [GHOST]: { action: 'rekey', to_owner: I.alias(FOX) }, [I.alias(AMB)]: { action: 'skip', reason: 'ambiguous' }, // keyed by alias (G2)
    });

    await check('pure: alias and uid are deterministic and well-formed', async () => {
      assert.match(I.alias(FOX), /^o_[0-9a-f]{6}$/);
      assert.equal(I.alias(FOX), I.alias(FOX));
      const u = I.uid('booking', 42);
      assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(u, I.uid('booking', 42));
      assert.notEqual(u, I.uid('document', 42));
      assert.equal((await one('SELECT $1::uuid::text AS u', [u])).u, u);
    });

    await check('pure: slugify, tierDate, cleanEmail', async () => {
      assert.equal(I.slugify('  Marina di Positano!! '), 'marina-di-positano');
      assert.equal(I.tierDate('2026-06-01T00:00:00.000+01:00'), '2026-06-01'); // not 2026-05-31 in a zone behind +01:00
      assert.equal(I.cleanEmail('  a@b.c '), 'a@b.c');
      for (const bad of ['', '   ', 'nobody', '@b.c', null]) assert.equal(I.cleanEmail(bad), null);
    });

    await check('pure: mapBookingStatus edges (Review Focus 3)', async () => {
      const now = new Date('2026-10-12T12:00:00Z');
      const today = '2026-10-12';
      const b = (status, expires_at, departure_date = '2026-11-01') => I.mapBookingStatus({ status, expires_at, departure_date }, today, now);
      const expired = { status: 'cancelled', cancel_reason: 'expired' };
      assert.deepEqual(b('pending', new Date(now)), expired);                               // expires exactly now
      assert.deepEqual(b('pending', null), expired);
      assert.deepEqual(b('pending', new Date('2026-10-20T00:00:00Z'), '2026-10-11'), expired); // departed
      assert.deepEqual(b('pending', new Date('2026-10-20T00:00:00Z'), today), { status: 'pending', cancel_reason: null }); // departs today
      assert.deepEqual(b('confirmed', null, '2026-01-01'), { status: 'confirmed', cancel_reason: null });
      assert.equal(b('paid', null), null);
    });

    await check('pure: insideRetention 90-day boundary (Review Focus 3)', async () => {
      const now = new Date('2026-10-12T12:00:00Z');
      const today = '2026-10-12';
      const r = (status, departure, updated_at = now) => I.insideRetention({ status, departure, updated_at }, today, now);
      assert.equal(r('confirmed', '2026-07-14'), true);   // today - 90
      assert.equal(r('confirmed', '2026-07-13'), false);  // today - 91
      assert.equal(r('confirmed', null), true);           // open-ended
      assert.equal(r('cancelled', '2026-12-01', new Date(now.getTime() - 90 * 864e5)), true);
      assert.equal(r('declined', '2026-12-01', new Date(now.getTime() - 90 * 864e5 - 1000)), false);
      assert.equal(r('pending', '2026-12-01', new Date('2020-01-01')), true);
    });

    await check('loadMap refuses bad files, reprice and create without clerk_org_id', async () => {
      const bad = path.join(os.tmpdir(), `check-import-sidon-${process.pid}-bad.json`);
      fs.writeFileSync(bad, '{not json');
      assert.throws(() => I.loadMap(bad), I.ImportRefused);
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'property', property_id: BBP, currency_decision: 'reprice' } })), /reprice/);
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'create', name: 'X', timezone: 'Europe/Rome' } })), /clerk_org_id/);
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'merge' } })), /unknown action/);
      assert.equal(I.loadMap(mapFile(baseMap())).owners[BB].property_id, BBP);
    });

    await check('readSource reads exactly the Source columns, bookings by created_at', async () => {
      await assert.rejects(I.readSource(db, 'x; drop'), I.ImportRefused);
      const s = await fixture();
      assert.deepEqual(Object.keys(s.profiles[0]), ['owner_id', 'slug', 'name', 'lat', 'lng', 'description', 'phone', 'email', 'website', 'response_window_hours', 'currency', 'updated_at']);
      assert.deepEqual(Object.keys(s.bookings[0]), ['id', 'owner_id', 'berth_id', 'sailor_name', 'sailor_email', 'boat_name', 'boat_loa', 'boat_beam', 'arrival_date', 'departure_date', 'notes', 'status', 'payment_intent_id', 'amount_cents', 'expires_at', 'created_at', 'updated_at']);
      assert.deepEqual(s.bookings.map((b) => b.id), [1, 2, 3]);
      assert.equal(s.tiers[0].valid_from, '2026-06-01T00:00:00.000+01:00');
      assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length])),
        { profiles: 3, layouts: 1, overlays: 1, berths: 5, tiers: 1, bookings: 3, requirements: 1, documents: 1, templates: 1, signatures: 1, pois: 1, images: 1, messages: 1 });
    });

    await check('plan: FOX + PEV share one created property, map order, alias keys (G1, G2)', async () => {
      const p = await plan(baseMap());
      assert.deepEqual(p.refusals, []);
      const sea = p.properties.find((x) => x.create);
      assert.deepEqual(sea, { key: 'create:org_check_sea:Fixture SEA', property_id: null,
        create: { name: 'Fixture SEA', timezone: 'Europe/Rome', clerk_org_id: 'org_check_sea', currency: 'EUR' }, currency: 'EUR', owners: [FOX, PEV] });
      const by = Object.fromEntries(p.owners.map((o) => [o.owner_id, o]));
      assert.equal(by[FOX].slug, 'fox-mooring');
      assert.equal(by[PEV].slug, 'pevero-mooring');
      assert.equal(by[GHOST].action, 'rekey');
      assert.equal(by[GHOST].rekey_to, FOX);
      assert.deepEqual([by[AMB].action, by[AMB].reason], ['skip', 'ambiguous']);
      assert.deepEqual([by[CHAT].action, by[CHAT].reason], ['skip', 'no child rows']); // G13
    });

    await check('plan: currency of a reused property differs -> flagged; refused without a decision (Review Focus 1)', async () => {
      const ok = await plan(baseMap());
      assert.deepEqual(ok.currencyFlags, [{ alias: I.alias(BB), marina_currency: 'EUR', property_currency: 'GBP', decision: 'drop_prices' }]);
      assert.equal(ok.owners.find((o) => o.owner_id === BB).prices, 'drop');
      const m = baseMap();
      delete m[BB].currency_decision;
      const p = await plan(m);
      assert.equal(p.refusals.length, 1);
      assert.match(p.refusals[0], new RegExp(`^${I.alias(BB)}: marina currency EUR differs from property currency GBP`));
    });

    await check('plan: refusals (tz mismatch, absent owner with rows, profile-less import, bad rekey, slugs)', async () => {
      const r = async (edit) => { const m = baseMap(); edit(m); return (await plan(m)).refusals.join(' | '); };
      assert.match(await r((m) => { m[PEV].timezone = 'Europe/London'; }), /timezone\/currency differ/);
      assert.match(await r((m) => { delete m[I.alias(AMB)]; }), new RegExp(`${I.alias(AMB)} is not in the map and has rows`));
      assert.match(await r((m) => { m[GHOST] = { ...SEA, clerk_org_id: 'org_x' }; }), /has no marina profile/);
      assert.match(await r((m) => { m[GHOST] = { action: 'rekey', to_owner: AMB }; }), /is not an importing owner/);
      assert.match(await r((m) => { m[PEV].slug = 'fox-mooring'; }), /both use slug "fox-mooring"/);
      assert.match(await r((m) => { m[PEV].slug = 'Bad Slug'; }), /is not a valid slug/);
      assert.match(await r((m) => { m[BB].property_id = '00000000-0000-0000-0000-000000000000'; }), /not found on the target/);
      assert.match(await r((m) => { m.o_ffffff = { action: 'skip', reason: 'x' }; }), /o_ffffff matches no Sidon owner/);
    });

    await check('plan: re-key suggestions for profile-less owners', async () => {
      const p = await plan(baseMap());
      const byAlias = (a, b) => a.alias.localeCompare(b.alias);
      assert.deepEqual([...p.suggestions].sort(byAlias), [
        { alias: I.alias(AMB), rekey_to_alias: null },        // its S1 is in FOX and PEV
        { alias: I.alias(GHOST), rekey_to_alias: I.alias(FOX) }, // FOX's overlay and FOX-only label
      ].sort(byAlias));
    });

    await check('readTargets: a re-run finds the created property via marina.sidon_owner_id, then property.sidon_marina_id', async () => {
      const P = (await one(`INSERT INTO property (name, currency, timezone, sidon_marina_id) VALUES ('Fixture SEA', 'EUR', 'Europe/Rome', $1) RETURNING id`, [FOX])).id;
      let p = await plan(baseMap());
      assert.equal(p.properties.find((x) => x.key.startsWith('create:')).property_id, P);
      assert.equal(p.properties.find((x) => x.key.startsWith('create:')).create, null);
      await db.query(`UPDATE property SET sidon_marina_id = NULL WHERE id = $1`, [P]);
      await db.query(`INSERT INTO marina (property_id, name, slug, sidon_owner_id) VALUES ($1, 'Pevero', 'pevero-mooring', $2)`, [P, PEV]);
      p = await plan(baseMap());
      assert.equal(p.properties.find((x) => x.key.startsWith('create:')).property_id, P);
    });

    await check('formatPlan: aliases, slugs and map names only (Review Focus 4)', async () => {
      const m = baseMap();
      delete m[BB].currency_decision;
      const text = I.formatPlan(await plan(m));
      assert.match(text, /create "Fixture SEA" \(EUR, Europe\/Rome\)/);
      assert.match(text, new RegExp(`${I.alias(GHOST)}: suggest rekey -> ${I.alias(FOX)}`));
      assert.match(text, /refusals:/);
      for (const secret of [FOX, PEV, BB, GHOST, CHAT, AMB, EMAIL, 'office.fixture@example.com', SAILOR, GUEST]) assert.ok(!text.includes(secret), `formatPlan leaks ${secret}`);
    });

    // (later tasks append checks here)
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"`

Expected: `Error: Cannot find module './import-sidon-marina'` and `exit=1`.

- [ ] **Step 3: Write the module**

Create `scripts/import-sidon-marina.js`:

```js
// Moves Sidon Marina's marina data into OTA (spec: Cutover steps 2 and 4).
// Reads Sidon with raw SQL and explicit column lists (8 of its table names
// are OTA's too, and its drizzle schema.ts lists columns live doesn't have),
// plans the mapping from a map file, and writes in one target transaction.
//   node scripts/import-sidon-marina.js --map [<map-file>] [--live]
// <map-file> defaults to .superpowers/import-map.local.json (.live.json with --live).
// Output carries owner aliases, slugs and counts only: never a name, an
// email or a Sidon owner id.
require('dotenv').config();
require('../src/db'); // DATE as 'YYYY-MM-DD' strings, for every pg client in the process
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');

class ImportRefused extends Error {}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const alias = (ownerId) => 'o_' + sha1(String(ownerId)).slice(0, 6);

// UUID v5-style from Sidon identity, so re-runs keep booking ids (and with
// them booking tokens and blob paths) stable.
function uid(table, id) {
  const h = sha1(`sidon:${table}:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Sidon tier dates look like '2026-06-01T00:00:00.000+01:00': the date the
// operator typed. Converting zones would move it a day for zones behind +01:00.
const tierDate = (text) => String(text).slice(0, 10);

function cleanEmail(s) {
  const t = String(s ?? '').trim();
  return t.indexOf('@') >= 1 ? t : null;
}

const STATUSES = new Set(['pending', 'confirmed', 'declined', 'cancelled']);
// A pending request nobody answered before it lapsed (or before the stay
// ended) is dead: OTA would never act on it.
function mapBookingStatus(b, today, now) {
  if (!STATUSES.has(b.status)) return null;
  if (b.status === 'pending' && (b.expires_at == null || b.expires_at <= now || b.departure_date < today)) {
    return { status: 'cancelled', cancel_reason: 'expired' };
  }
  return { status: b.status, cancel_reason: null };
}

const daysBefore = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// Mirrors marinaDocuments.retentionOnce: a file it would delete on its first
// pass is not worth copying.
function insideRetention(b, today, now) {
  if (b.departure !== null && b.departure < daysBefore(today, 90)) return false;
  if ((b.status === 'cancelled' || b.status === 'declined') && b.updated_at < new Date(now.getTime() - 90 * 864e5)) return false;
  return true;
}

const DECISIONS = new Set(['accept_as_property_currency', 'drop_prices']);
function loadMap(path) {
  let map;
  try { map = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (err) { throw new ImportRefused(`map file ${path}: ${err.message}`); }
  if (!map || typeof map.owners !== 'object' || Array.isArray(map.owners)) throw new ImportRefused('map file: "owners" must be an object');
  for (const [key, e] of Object.entries(map.owners)) {
    const at = `map owner ${key.startsWith('o_') ? key : alias(key)}`;
    if (!e || !['property', 'create', 'skip', 'rekey'].includes(e.action)) throw new ImportRefused(`${at}: unknown action`);
    if (e.currency_decision === 'reprice') throw new ImportRefused(`${at}: currency_decision 'reprice' is not supported in phase 1`);
    if (e.currency_decision != null && !DECISIONS.has(e.currency_decision)) throw new ImportRefused(`${at}: unknown currency_decision`);
    if (e.action === 'property' && typeof e.property_id !== 'string') throw new ImportRefused(`${at}: property_id is required`);
    if (e.action === 'create') {
      // Without an org the owner's first sign-in auto-creates a second, empty property.
      if (!e.clerk_org_id) throw new ImportRefused(`${at}: clerk_org_id is required for create`);
      if (!e.name || !e.timezone) throw new ImportRefused(`${at}: name and timezone are required for create`);
    }
    if (e.action === 'skip' && !e.reason) throw new ImportRefused(`${at}: skip needs a reason`);
    if (e.action === 'rekey' && !e.to_owner) throw new ImportRefused(`${at}: rekey needs to_owner`);
  }
  return map;
}

// Exactly the live columns (survey sidon-import.md §1); schema is
// 'sidon_fixture' in the check.
const SOURCE_SQL = {
  profiles: 'SELECT owner_id, slug, name, lat, lng, description, phone, email, website, response_window_hours, currency, updated_at FROM %s.marina_profile ORDER BY owner_id',
  layouts: 'SELECT owner_id, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation FROM %s.marina_layout ORDER BY owner_id',
  overlays: 'SELECT id, owner_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order FROM %s.marina_overlay ORDER BY id',
  berths: 'SELECT id, owner_id, berth_id, overlay_id, lat, lng, length_m, min_length_m, beam_m, depth_m, status, guest_name, notes, price_per_night, price_mode, rotation FROM %s.marina_berth ORDER BY id',
  tiers: 'SELECT id, owner_id, valid_from, valid_to, max_len_m, max_beam_m, price_per_night, price_per_month, price_per_year, created_at FROM %s.marina_price_tier ORDER BY id',
  bookings: 'SELECT id, owner_id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, notes, status, payment_intent_id, amount_cents, expires_at, created_at, updated_at FROM %s.berth_booking ORDER BY created_at, id',
  requirements: 'SELECT id, owner_id, type, name, description, schema, mandatory, sort_order FROM %s.marina_doc_requirement ORDER BY id',
  documents: 'SELECT id, owner_id, requirement_id, booking_id, status, notes, submitted_at, verified_at, type, file_url, file_name, extracted_data, expiry_date FROM %s.marina_document ORDER BY id',
  templates: 'SELECT id, owner_id, name, body_markdown, min_nights, active, created_at FROM %s.marina_contract_template ORDER BY id',
  signatures: 'SELECT id, owner_id, template_id, booking_id, rendered_body, signed_at, ip_address, user_agent FROM %s.marina_contract_signature ORDER BY id',
  pois: 'SELECT id, owner_id, label, type, lat, lng FROM %s.marina_poi ORDER BY id',
  images: 'SELECT id, owner_id, url, description, sort_order, created_at FROM %s.marina_image ORDER BY id',
  messages: 'SELECT id, owner_id, sailor_id, enquiry_cookie_hash, sailor_email, sailor_name, direction, body, created_at, read_at FROM %s.marina_message ORDER BY id',
};

// SELECTs only: the caller owns the transaction (the CLI opens it READ ONLY).
async function readSource(src, schema = 'public') {
  if (!/^[a-z_]+$/.test(schema)) throw new ImportRefused(`bad source schema ${schema}`);
  const out = {};
  for (const [k, sql] of Object.entries(SOURCE_SQL)) out[k] = (await src.query(sql.replace('%s', schema))).rows;
  return out;
}

const TABLES = Object.keys(SOURCE_SQL);
const ownersIn = (source) => [...new Set(TABLES.flatMap((t) => source[t].map((r) => r.owner_id)))].sort();

// Map keys may be an owner id or its alias (G2). Returns owner id -> entry,
// plus refusals for keys matching no owner or an ambiguous alias.
function resolveKeys(map, owners) {
  const byOwner = new Map();
  const refusals = [];
  const find = (key) => {
    if (owners.includes(key)) return key;
    const hits = owners.filter((o) => alias(o) === key);
    if (hits.length > 1) { refusals.push(`alias ${key} matches ${hits.length} owners: use the owner id`); return null; }
    if (!hits.length) { refusals.push(`map key ${key.startsWith('o_') ? key : alias(key)} matches no Sidon owner`); return null; }
    return hits[0];
  };
  for (const [key, entry] of Object.entries(map.owners)) {
    const id = find(key);
    if (id) byOwner.set(id, entry);
  }
  return { byOwner, refusals, find };
}

const createKey = (e) => `create:${e.clerk_org_id}:${e.name}`;

// Read-only: the target state the plan depends on.
async function readTargets(dst, source, map) {
  const owners = ownersIn(source);
  const { byOwner } = resolveKeys(map, owners);
  const properties = {};
  const reruns = {};
  const loadProps = async (ids) => {
    const { rows } = await dst.query('SELECT id, currency, timezone, clerk_org_id FROM property WHERE id::text = ANY($1)', [ids]);
    for (const r of rows) properties[r.id] = { currency: r.currency, timezone: r.timezone, clerk_org_id: r.clerk_org_id };
  };
  await loadProps([...byOwner.values()].filter((e) => e.action === 'property').map((e) => e.property_id));
  const groups = new Map();
  for (const [id, e] of byOwner) if (e.action === 'create') groups.set(createKey(e), [...(groups.get(createKey(e)) || []), id]);
  for (const [key, ids] of groups) {
    // A previous run's property: by its marinas first (one per owner), then
    // by the first owner it was created for.
    const { rows: [m] } = await dst.query('SELECT property_id FROM marina WHERE sidon_owner_id = ANY($1) LIMIT 1', [ids]);
    const { rows: [p] } = m ? { rows: [] } : await dst.query('SELECT id FROM property WHERE sidon_marina_id = ANY($1) LIMIT 1', [ids]);
    const pid = m?.property_id ?? p?.id;
    if (pid) reruns[key] = pid;
  }
  await loadProps(Object.values(reruns));
  return { properties, reruns };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Pure: everything the import will do, or why it won't.
function planMapping(source, map, targets) {
  const owners = ownersIn(source);
  const { byOwner, refusals, find } = resolveKeys(map, owners);
  const profile = new Map(source.profiles.map((p) => [p.owner_id, p]));
  const hasRows = (id) => TABLES.some((t) => t !== 'messages' && source[t].some((r) => r.owner_id === id));
  const plan = { properties: [], owners: [], currencyFlags: [], suggestions: [], refusals };
  const propByKey = new Map();

  // Importing owners first, in map-file order (owners[0] becomes sidon_marina_id).
  for (const [id, e] of byOwner) {
    if (e.action !== 'property' && e.action !== 'create') continue;
    const a = alias(id);
    const p = profile.get(id);
    if (!p) { refusals.push(`${a} has no marina profile: rekey or skip it`); continue; }
    let pp;
    if (e.action === 'property') {
      const t = targets.properties[e.property_id];
      if (!t) { refusals.push(`${a}: property ${e.property_id} not found on the target`); continue; }
      pp = propByKey.get(e.property_id);
      if (!pp) {
        pp = { key: e.property_id, property_id: e.property_id, create: null, currency: t.currency.toUpperCase(), owners: [] };
        propByKey.set(pp.key, pp);
        plan.properties.push(pp);
      }
    } else {
      const key = createKey(e);
      const currency = String(e.currency ?? p.currency).toUpperCase();
      pp = propByKey.get(key);
      if (!pp) {
        const rerun = targets.reruns[key];
        pp = rerun
          ? { key, property_id: rerun, create: null, currency: targets.properties[rerun].currency.toUpperCase(), owners: [], timezone: e.timezone, wanted: currency }
          : { key, property_id: null, create: { name: e.name, timezone: e.timezone, clerk_org_id: e.clerk_org_id, currency }, currency, owners: [], timezone: e.timezone, wanted: currency };
        propByKey.set(key, pp);
        plan.properties.push(pp);
      } else if (pp.timezone !== e.timezone || pp.wanted !== currency) {
        // G1: owners sharing one created property must agree on both.
        refusals.push(`${a}: timezone/currency differ from the other owners of "${e.name}"`);
        continue;
      }
    }
    pp.owners.push(id);
    const slug = e.slug ?? p.slug ?? slugify(p.name);
    if (!SLUG.test(slug)) refusals.push(`${a}: slug "${slug}" is not a valid slug`);
    const marinaCurrency = String(p.currency).toUpperCase();
    const decision = e.currency_decision ?? null;
    if (marinaCurrency !== pp.currency) {
      plan.currencyFlags.push({ alias: a, marina_currency: marinaCurrency, property_currency: pp.currency, decision });
      // A guest would pay the right number in the wrong currency.
      if (!decision) refusals.push(`${a}: marina currency ${marinaCurrency} differs from property currency ${pp.currency}; set currency_decision`);
    }
    plan.owners.push({ owner_id: id, alias: a, action: 'import', property_key: pp.key, slug,
      prices: decision === 'drop_prices' ? 'drop' : 'keep', rekey_to: null, reason: null });
  }
  for (const pp of plan.properties) { delete pp.timezone; delete pp.wanted; }

  const importing = new Set(plan.owners.map((o) => o.owner_id));
  const slugs = new Map();
  for (const o of plan.owners) {
    if (slugs.has(o.slug)) refusals.push(`${o.alias} and ${slugs.get(o.slug)} both use slug "${o.slug}"`);
    slugs.set(o.slug, o.alias);
  }

  for (const id of owners) {
    if (importing.has(id)) continue;
    const a = alias(id);
    const e = byOwner.get(id);
    if (e?.action === 'property' || e?.action === 'create') continue; // refused above
    if (e?.action === 'skip') { plan.owners.push({ owner_id: id, alias: a, action: 'skip', property_key: null, slug: null, prices: 'keep', rekey_to: null, reason: e.reason }); continue; }
    if (e?.action === 'rekey') {
      const to = find(e.to_owner);
      if (to && !importing.has(to)) refusals.push(`${a}: rekey target ${alias(to)} is not an importing owner`);
      if (to) plan.owners.push({ owner_id: id, alias: a, action: 'rekey', property_key: null, slug: null, prices: 'keep', rekey_to: to, reason: null });
      continue;
    }
    // G13: absent owners are auto-skipped only when nothing but messages hangs off them.
    if (!hasRows(id)) plan.owners.push({ owner_id: id, alias: a, action: 'skip', property_key: null, slug: null, prices: 'keep', rekey_to: null, reason: 'no child rows' });
    else refusals.push(`${a} is not in the map and has rows: add property/create/rekey/skip`);
  }

  // Re-key hints for profile-less owners: the overlays their berths sit on,
  // and labels that exist in exactly one profiled marina.
  const labelsOf = new Map();
  for (const b of source.berths) if (profile.has(b.owner_id)) labelsOf.set(b.berth_id, [...new Set([...(labelsOf.get(b.berth_id) || []), b.owner_id])]);
  const overlayOwner = new Map(source.overlays.map((o) => [o.id, o.owner_id]));
  for (const id of owners) {
    if (profile.has(id) || !hasRows(id)) continue;
    const cands = new Set();
    for (const b of source.berths) if (b.owner_id === id && overlayOwner.has(b.overlay_id) && profile.has(overlayOwner.get(b.overlay_id))) cands.add(overlayOwner.get(b.overlay_id));
    for (const r of [...source.berths, ...source.bookings]) {
      const hit = r.owner_id === id && labelsOf.get(r.berth_id);
      if (hit && hit.length === 1) cands.add(hit[0]);
    }
    plan.suggestions.push({ alias: alias(id), rekey_to_alias: cands.size === 1 ? alias([...cands][0]) : null });
  }
  return plan;
}

// For terminals and sign-off: aliases, slugs and map-file property names only.
function formatPlan(plan) {
  const name = (key) => {
    const pp = plan.properties.find((p) => p.key === key);
    return pp.create ? `create "${pp.create.name}" (${pp.create.currency}, ${pp.create.timezone})` : `${pp.property_id} (${pp.currency})`;
  };
  const out = ['properties:'];
  for (const pp of plan.properties) out.push(`  ${name(pp.key)} <- ${pp.owners.map(alias).join(', ')}`);
  out.push('owners:');
  for (const o of plan.owners) {
    if (o.action === 'import') out.push(`  ${o.alias} import as ${o.slug}${o.prices === 'drop' ? ' (prices dropped)' : ''}`);
    else if (o.action === 'rekey') out.push(`  ${o.alias} rekey -> ${alias(o.rekey_to)}`);
    else out.push(`  ${o.alias} skip: ${o.reason}`);
  }
  if (plan.currencyFlags.length) out.push('currency flags:', ...plan.currencyFlags.map((f) => `  ${f.alias}: marina ${f.marina_currency}, property ${f.property_currency}, decision ${f.decision ?? 'none'}`));
  if (plan.suggestions.length) out.push('profile-less owners:', ...plan.suggestions.map((s) => `  ${s.alias}: ${s.rekey_to_alias ? `suggest rekey -> ${s.rekey_to_alias}` : 'no single match (skip, or rekey by hand)'}`));
  if (plan.refusals.length) out.push('refusals:', ...plan.refusals.map((r) => `  ${r}`));
  return out.join('\n');
}

module.exports = { ImportRefused, alias, uid, slugify, tierDate, cleanEmail, mapBookingStatus, insideRetention,
  loadMap, readSource, readTargets, planMapping, formatPlan };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const mapFile = argv.find((a) => !a.startsWith('--')) ?? `.superpowers/import-map.${live ? 'live' : 'local'}.json`;
  const ssl = (url) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

  const main = async () => {
    if (!argv.includes('--map')) throw new ImportRefused('only --map is available until the import steps land');
    const dstKey = live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL';
    const srcUrl = process.env.SIDON_DATABASE_URL;
    const dstUrl = process.env[dstKey];
    if (!srcUrl) throw new ImportRefused('SIDON_DATABASE_URL is not set');
    if (!dstUrl) throw new ImportRefused(`${dstKey} is not set`);
    if (srcUrl === dstUrl) throw new ImportRefused(`SIDON_DATABASE_URL and ${dstKey} are the same database`);
    const map = loadMap(mapFile);
    const src = new Client({ connectionString: srcUrl, ssl: ssl(srcUrl) });
    const dst = new Client({ connectionString: dstUrl, ssl: ssl(dstUrl) });
    await src.connect();
    await dst.connect();
    try {
      // READ ONLY makes Postgres itself refuse any write to Sidon.
      await src.query('BEGIN READ ONLY');
      const source = await readSource(src);
      await src.query('COMMIT');
      const plan = planMapping(source, map, await readTargets(dst, source, map));
      console.log(formatPlan(plan));
      if (plan.refusals.length) process.exitCode = 1;
    } finally {
      await src.end();
      await dst.end();
    }
  };

  main().catch((err) => {
    if (!(err instanceof ImportRefused)) throw err; // a real bug: let Node print the stack
    console.error(`refused: ${err.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the check again**

Run: `node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"`

Expected:
```
ok   pure: alias and uid are deterministic and well-formed
ok   pure: slugify, tierDate, cleanEmail
ok   pure: mapBookingStatus edges (Review Focus 3)
ok   pure: insideRetention 90-day boundary (Review Focus 3)
ok   loadMap refuses bad files, reprice and create without clerk_org_id
ok   readSource reads exactly the Source columns, bookings by created_at
ok   plan: FOX + PEV share one created property, map order, alias keys (G1, G2)
ok   plan: currency of a reused property differs -> flagged; refused without a decision (Review Focus 1)
ok   plan: refusals (tz mismatch, absent owner with rows, profile-less import, bad rekey, slugs)
ok   plan: re-key suggestions for profile-less owners
ok   readTargets: a re-run finds the created property via marina.sidon_owner_id, then property.sidon_marina_id
ok   formatPlan: aliases, slugs and map names only (Review Focus 4)
all passed
exit=0
```

- [ ] **Step 5: CLI refusals, without touching Sidon**

Run: `SIDON_DATABASE_URL= node scripts/import-sidon-marina.js --map; echo "exit=$?"; node scripts/import-sidon-marina.js; echo "exit=$?"`

Expected: `refused: SIDON_DATABASE_URL is not set` with `exit=1`, then `refused: only --map is available until the import steps land` with `exit=1`. There should be no stack traces.

- [ ] **Step 6: The other O gates still pass**

Run: `set -o pipefail; node -r dotenv/config scripts/check-marina.js | tail -n 1 && node -r dotenv/config scripts/check-marina-http.js | tail -n 1`

Expected: `all passed` twice.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/robert/source/repos/OTA && git add scripts/import-sidon-marina.js scripts/check-import-sidon.js && git commit -m "Marina import: Sidon read side, mapping plan and its check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: one commit with 2 files. Nothing is pushed.

---

### Task 2: Importer writes properties, catalogue and the re-run guard (O main)

Repo `O` = `C:/Users/robert/source/repos/OTA`, branch `main`. Run every command from `O` in Git Bash. The importer file and the check both come from Task 1, so this task locates its edit points by code anchors, not line numbers.

**Files:**
- Modify: `C:/Users/robert/source/repos/OTA/scripts/import-sidon-marina.js` (created by Task 1). This task touches four places:
  - the top-of-file `require` block;
  - a new writing block, inserted immediately above `module.exports = {`;
  - the `module.exports` statement;
  - the CLI block `if (require.main === module) { … }`.
- Modify: `C:/Users/robert/source/repos/OTA/scripts/check-import-sidon.js` (created by Task 1). One block is inserted directly above the line `// (later tasks append checks here)`.
- Not touched: the untracked `=` and `src/db/seed-extras.sql.pre-multi-property.bak` in `O`. They are never staged.

**Interfaces:**
- Consumes:
  - From Task 1, exactly as named in the contract: `ImportRefused`, `alias(ownerId)`, `uid(table, id)`, `tierDate(text)`, `loadMap(path)`, `readSource(src, schema)`, `readTargets(dst, source, map)`, `planMapping(source, map, targets)` → `Plan` (`properties[]` with `key`/`property_id`/`create`/`currency`/`owners`; `owners[]` with `action` `'import'|'rekey'|'skip'`, `property_key`, `slug`, `prices`, `rekey_to`, `reason`; `currencyFlags`; `refusals`) and `formatPlan(plan)`.
  - Task 1's check harness: `db` (one `pg.Client` inside `BEGIN`), `check(name, fn)` (a `SAVEPOINT c` per check, rolled back after it), `assert` (`node:assert/strict`) and the marker line.
  - `propertyToday(client, propertyId)` from `src/lib/marinaQueries.js:4`.
  - `STARTER_BALANCE` from `src/lib/tokens.js:36`.
  - `unknownPlaceholders(body)` from `src/lib/marinaContracts.js:15`.
- Produces:
  - `async function importSidon(dst, source, plan, opts: ImportOptions) -> Report`. It covers contract order steps 1–5 (refusals, guard, properties, delete, catalogue, re-keys). It never runs BEGIN/COMMIT/ROLLBACK.
  - `function formatReport(report) -> string`. It prints aliases, slugs, property ids and counts. Task 4 extends it.
  - CLI modes `--dry-run` (rolled back) and the default commit, alongside Task 1's `--map`.
  - Module-level helpers that Tasks 3–4 reuse: `nz(v)` (`''` → NULL), `round2(n)`, `zeroCounts()` (every `MarinaCounts` key set to 0) and `BERTH_STATUS`.
  - Locals inside `importSidon` that Tasks 3–4 use. Tasks 3–4 insert their steps between the re-key loop and `return report;`:
    - `propertyIdOf: Map<PlannedProperty.key, uuid>`
    - `todayOf: Map<property_id, 'YYYY-MM-DD'>`
    - `marinas: Map<importing owner id, M>`, where `M = { id, property_id, owner_id, alias, prices: 'keep'|'drop', counts: MarinaCounts, pontoons: Map<overlay id, uuid>, labels: Map<label, berth uuid>, reqTypes: Set<type> }`
    - `marinaOf(ownerId) -> M | undefined`. It returns the target's `M` for a re-keyed owner, and `undefined` for a skipped owner.
    - `berthIds: Map<Sidon berth id, { id, marina: M }>`
    - `requirementIds: Map<Sidon requirement id, uuid>`
    - `templateIds: Map<Sidon template id, uuid>`

- [ ] **Step 1: Append the failing checks**

The checks build their own in-memory `Source` with three owners, so they don't depend on Task 1's shared fixture rows. `readSource` is pinned by Task 1's fixture checks.
- A is created as a new property.
- B reuses a GBP property, while its Sidon marina is `eur`.
- G is profile-less and re-keyed to A.

In `C:/Users/robert/source/repos/OTA/scripts/check-import-sidon.js`, insert this block directly above the line `// (later tasks append checks here)` (same indentation as the checks above it):

```js
    // ── Properties, catalogue and the re-run guard ──
    // Three owners of our own, held in memory (readSource is pinned by the
    // fixture checks above): A is created, B reuses a GBP property while its
    // Sidon marina is eur, and G is profile-less and re-keyed to A. Each run
    // re-reads targets and re-plans, as the CLI does.
    {
      const I = require('./import-sidon-marina');
      const { STARTER_BALANCE } = require('../src/lib/tokens');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const rows = async (sql, params) => (await db.query(sql, params)).rows;
      const A = 'org_t2_alpha', B = 'org_t2_beta', G = 'user_t2_ghost';
      const at = (s) => new Date(s);
      const REQ_FIELDS = [{ name: 'policy_number', label: 'Policy number', type: 'string' }];
      const berth = (id, owner_id, label, overlay_id, status, extra = {}) => ({
        id, owner_id, berth_id: label, overlay_id, lat: null, lng: null, length_m: 12, min_length_m: null, beam_m: 4, depth_m: 3,
        status, guest_name: null, notes: '', price_per_night: 5, price_mode: 'per_metre', rotation: null, ...extra,
      });
      const SRC = {
        profiles: [
          { owner_id: A, slug: 't2-alpha', name: 'Alpha Check', lat: 41.1, lng: 9.5, description: '', phone: '', email: '', website: null,
            response_window_hours: null, currency: 'eur', updated_at: at('2026-08-01T00:00:00Z') },
          { owner_id: B, slug: 't2-beta', name: 'Beta Check', lat: -16.5, lng: -151.7, description: 'Lagoon moorings', phone: null, email: null, website: null,
            response_window_hours: 48, currency: 'eur', updated_at: at('2026-08-01T00:00:00Z') },
        ],
        layouts: [{ owner_id: A, svg_data: '<svg viewBox="0 0 10 10"/>', sw_lat: 41.0, sw_lng: 9.4, ne_lat: 41.2, ne_lng: 9.6, rotation: 12.5 }],
        overlays: [
          { id: 9101, owner_id: A, name: 'Pontoon A', svg_data: '<path/>', sw_lat: 41.0, sw_lng: 9.4, ne_lat: 41.1, ne_lng: 9.5, rotation: 0, sort_order: null },
          { id: 9102, owner_id: B, name: 'Pontoon B', svg_data: null, sw_lat: null, sw_lng: null, ne_lat: null, ne_lng: null, rotation: null, sort_order: 2 },
        ],
        berths: [
          berth(9201, A, 'A1', 9101, 'available', { length_m: 12.199999809265137 }), // float4 noise -> 12.20
          berth(9202, A, 'A2', 9102, 'occupied', { price_mode: null }),            // B's overlay: cross-owner, counted
          berth(9203, A, 'A3', 9999, 'maintenance', { price_per_night: null, price_mode: 'fixed' }), // dangling overlay
          berth(9204, G, 'A1', 9101, 'available'),                                 // re-keyed duplicate of A1
          berth(9205, G, 'G9', null, 'reserved'),                                  // re-keyed, new label
          berth(9206, B, 'B1', 9102, 'available', { price_per_night: 80, price_mode: 'fixed' }),
        ],
        tiers: [
          { id: 9301, owner_id: A, valid_from: '2026-06-01T00:00:00.000+01:00', valid_to: '2026-09-30T00:00:00.000+01:00', max_len_m: 15.5, max_beam_m: null,
            price_per_night: 50, price_per_month: 1200, price_per_year: null, created_at: at('2026-04-01T10:00:00Z') },
          { id: 9302, owner_id: B, valid_from: '2026-05-01T00:00:00.000+01:00', valid_to: '2026-10-31T00:00:00.000+01:00', max_len_m: 20, max_beam_m: 6,
            price_per_night: 70, price_per_month: null, price_per_year: null, created_at: at('2026-04-02T10:00:00Z') },
        ],
        bookings: [],
        requirements: [
          { id: 9401, owner_id: A, type: 'insurance', name: 'Insurance', description: '', schema: JSON.stringify(REQ_FIELDS), mandatory: 1, sort_order: null },
          { id: 9402, owner_id: G, type: 'insurance', name: 'Insurance (old)', description: null, schema: '[]', mandatory: 1, sort_order: 1 },
          { id: 9403, owner_id: G, type: 'passport', name: 'Passport', description: null, schema: '[]', mandatory: 0, sort_order: 2 },
        ],
        documents: [],
        templates: [
          { id: 9501, owner_id: A, name: 'Berth contract', body_markdown: 'I, {{sailor_name}}, insured under {{acord25.policy_number}}', min_nights: null, active: 1, created_at: at('2026-04-03T10:00:00Z') },
          { id: 9502, owner_id: G, name: 'Old contract', body_markdown: 'Old', min_nights: 0, active: 1, created_at: at('2026-04-04T10:00:00Z') },
          { id: 9503, owner_id: B, name: 'Draft contract', body_markdown: 'Draft for {{boat_name}}', min_nights: 4, active: 0, created_at: at('2026-04-05T10:00:00Z') },
        ],
        signatures: [],
        pois: [{ id: 9601, owner_id: A, label: 'Fuel dock', type: 'fuel', lat: 41.11, lng: 9.51 }],
        images: [{ id: 9701, owner_id: A, url: 'https://sidon.example/marina/a/1.webp', description: null, sort_order: null, created_at: at('2026-04-06T10:00:00Z') }],
        messages: [],
      };
      const MAP_FILE = path.join(os.tmpdir(), 'check-import-sidon-t2.json');
      const run = async (P, mode = 'commit', decision = 'drop_prices') => {
        fs.writeFileSync(MAP_FILE, JSON.stringify({ owners: {
          [A]: { action: 'create', name: 'T2 Alpha Co', timezone: 'Europe/Rome', clerk_org_id: 'org_check_t2' },
          [B]: { action: 'property', property_id: P, currency_decision: decision },
          [G]: { action: 'rekey', to_owner: A },
        } }));
        const map = I.loadMap(MAP_FILE);
        const plan = I.planMapping(SRC, map, await I.readTargets(db, SRC, map));
        return I.importSidon(db, SRC, plan, { mode, target: 'local', files: false });
      };
      // B's property: GBP behind UTC, with an interim sidon_marina_id that must survive (G3).
      const beta = async () => (await rows(
        `INSERT INTO property (name, currency, timezone, sidon_marina_id) VALUES ('T2 Beta Check', 'GBP', 'Pacific/Tahiti', 'org_t2_interim') RETURNING id`))[0].id;
      const todayIn = async (tz) => (await rows('SELECT (now() AT TIME ZONE $1)::date::text AS d', [tz]))[0].d;
      const MA = I.uid('marina', A), MB = I.uid('marina', B);
      const starterRows = STARTER_BALANCE > 0 ? [{ delta: STARTER_BALANCE, balance_after: STARTER_BALANCE, reason: 'starter' }] : [];

      await check('import: created property has the map fields, an enabled prop_ key, sidon_marina_id = first owner, one starter grant', async () => {
        const report = await run(await beta());
        const created = report.properties.filter((p) => p.created);
        assert.equal(created.length, 1);
        const [p] = await rows('SELECT * FROM property WHERE id = $1', [created[0].property_id]);
        assert.deepEqual([p.name, p.currency, p.timezone, p.clerk_org_id, p.sidon_marina_id, p.api_key_enabled],
          ['T2 Alpha Co', 'EUR', 'Europe/Rome', 'org_check_t2', A, true]);
        assert.match(p.api_key, /^prop_[0-9a-f]{64}$/);
        assert.equal(p.token_balance, STARTER_BALANCE > 0 ? STARTER_BALANCE : 0);
        assert.deepEqual(await rows('SELECT delta, balance_after, reason FROM property_token_ledger WHERE property_id = $1', [p.id]), starterRows);
        assert.equal(created[0].today, await todayIn('Europe/Rome'));
      });

      await check('import: a reused property is never written (currency, timezone, sidon_marina_id, tokens; G3)', async () => {
        const P = await beta();
        const snap = async () => (await rows('SELECT currency, timezone, sidon_marina_id, token_balance, api_key FROM property WHERE id = $1', [P]))[0];
        const before = await snap();
        const report = await run(P);
        assert.deepEqual(await snap(), before);
        assert.deepEqual(await rows('SELECT id FROM property_token_ledger WHERE property_id = $1', [P]), []);
        assert.deepEqual(report.properties.find((p) => p.property_id === P), { key: P, property_id: P, created: false, today: await todayIn('Pacific/Tahiti') });
        assert.deepEqual(report.currencyFlags.map((f) => [f.alias, f.decision]), [[I.alias(B), 'drop_prices']]);
      });

      await check('import: marina, pontoons, berths, tiers, requirements, templates, POIs and images map field by field', async () => {
        const report = await run(await beta(), 'commit', 'accept_as_property_currency');
        const PA = report.properties.find((p) => p.created).property_id;
        const [m] = await rows('SELECT * FROM marina WHERE id = $1', [MA]);
        assert.deepEqual(
          [m.property_id, m.sidon_owner_id, m.name, m.slug, m.description, m.phone, m.email, m.website, m.layout_svg, m.layout_rotation, m.response_window_hours, m.status],
          [PA, A, 'Alpha Check', 't2-alpha', null, null, null, null, '<svg viewBox="0 0 10 10"/>', 12.5, 24, 'active']);
        assert.equal((await rows('SELECT response_window_hours FROM marina WHERE id = $1', [MB]))[0].response_window_hours, 48);
        assert.deepEqual(await rows('SELECT id, name, sort_order FROM marina_pontoon WHERE marina_id = ANY($1) ORDER BY sort_order', [[MA, MB]]),
          [{ id: I.uid('pontoon', 9101), name: 'Pontoon A', sort_order: 0 }, { id: I.uid('pontoon', 9102), name: 'Pontoon B', sort_order: 2 }]);
        const berths = await rows('SELECT id, pontoon_id, label, length_m, price_per_night, price_mode, notes, status FROM marina_berth WHERE marina_id = $1 ORDER BY label', [MA]);
        assert.deepEqual(berths.map((b) => Object.values(b)), [
          [I.uid('berth', 9201), I.uid('pontoon', 9101), 'A1', '12.20', '5.00', 'per_metre', null, 'active'],
          [I.uid('berth', 9202), null, 'A2', '12.00', '5.00', 'per_metre', null, 'active'],
          [I.uid('berth', 9203), null, 'A3', '12.00', null, 'fixed', null, 'maintenance'],
          [I.uid('berth', 9205), null, 'G9', '12.00', '5.00', 'per_metre', null, 'active'],
        ]);
        assert.deepEqual(await rows(
          `SELECT id, valid_from, valid_to, max_length_m, max_beam_m, price_per_night, price_per_month, price_per_year, created_at
           FROM marina_price_tier WHERE marina_id = $1`, [MA]),
        [{ id: I.uid('tier', 9301), valid_from: '2026-06-01', valid_to: '2026-09-30', max_length_m: '15.50', max_beam_m: null,
          price_per_night: '50.00', price_per_month: '1200.00', price_per_year: null, created_at: at('2026-04-01T10:00:00Z') }]);
        assert.deepEqual(await rows('SELECT id, type, name, description, fields, mandatory, sort_order FROM marina_doc_requirement WHERE marina_id = $1 ORDER BY sort_order', [MA]), [
          { id: I.uid('requirement', 9401), type: 'insurance', name: 'Insurance', description: null, fields: REQ_FIELDS, mandatory: true, sort_order: 0 },
          { id: I.uid('requirement', 9403), type: 'passport', name: 'Passport', description: null, fields: [], mandatory: false, sort_order: 2 },
        ]);
        assert.deepEqual(await rows('SELECT id, marina_id, status, min_nights, created_at FROM marina_contract_template WHERE marina_id = ANY($1) ORDER BY min_nights', [[MA, MB]]), [
          { id: I.uid('template', 9501), marina_id: MA, status: 'active', min_nights: 0, created_at: at('2026-04-03T10:00:00Z') },
          { id: I.uid('template', 9503), marina_id: MB, status: 'inactive', min_nights: 4, created_at: at('2026-04-05T10:00:00Z') },
        ]);
        assert.deepEqual(report.unknownPlaceholders, [{ alias: I.alias(A), template_id: I.uid('template', 9501), fields: ['acord25.policy_number'] }]);
        assert.deepEqual(await rows('SELECT id, label, type, lat, lng FROM marina_poi WHERE marina_id = $1', [MA]),
          [{ id: I.uid('poi', 9601), label: 'Fuel dock', type: 'fuel', lat: 41.11, lng: 9.51 }]);
        assert.deepEqual(await rows('SELECT id, url, description, sort_order, created_at FROM marina_image WHERE marina_id = $1', [MA]),
          [{ id: I.uid('image', 9701), url: 'https://sidon.example/marina/a/1.webp', description: null, sort_order: 0, created_at: at('2026-04-06T10:00:00Z') }]);
      });

      await check('import: re-key drops duplicate labels (counted), cross-owner overlay -> pontoon NULL (counted), dangling overlay -> NULL', async () => {
        const report = await run(await beta());
        const a = report.marinas.find((m) => m.alias === I.alias(A)).counts;
        assert.deepEqual(
          [a.pontoons, a.berths, a.berths_duplicate, a.pontoon_nulled, a.tiers, a.requirements, a.templates, a.pois, a.images],
          [1, 4, 1, 1, 1, 2, 1, 1, 1]);
        assert.deepEqual(report.rekeys, [{ alias: I.alias(G), to_alias: I.alias(A) }]);
        assert.equal(report.marinas.some((m) => m.alias === I.alias(G)), false);
        assert.deepEqual(await rows('SELECT id FROM marina_berth WHERE id = $1', [I.uid('berth', 9204)]), []);
      });

      await check('import: drop_prices -> NULL berth prices and no tiers; accept_as_property_currency keeps them (Review Focus 1)', async () => {
        const P = await beta();
        const priced = async () => ({
          berth: (await rows("SELECT price_per_night FROM marina_berth WHERE marina_id = $1 AND label = 'B1'", [MB]))[0].price_per_night,
          tiers: (await rows('SELECT price_per_night FROM marina_price_tier WHERE marina_id = $1', [MB])).map((t) => t.price_per_night),
        });
        const dropped = await run(P, 'commit', 'drop_prices');
        assert.deepEqual(await priced(), { berth: null, tiers: [] });
        assert.equal(dropped.marinas.find((m) => m.alias === I.alias(B)).counts.tiers, 0);
        await run(P, 'commit', 'accept_as_property_currency');
        assert.deepEqual(await priced(), { berth: '80.00', tiers: ['70.00'] });
      });

      await check('import: a second run keeps marina/berth/tier ids, counts and the created property; report has aliases only (Review Focus 2)', async () => {
        const P = await beta();
        const snapshot = async () => ({
          marinas: await rows('SELECT id, property_id FROM marina WHERE sidon_owner_id = ANY($1) ORDER BY id', [[A, B]]),
          berths: (await rows('SELECT b.id FROM marina_berth b JOIN marina m ON m.id = b.marina_id WHERE m.sidon_owner_id = ANY($1) ORDER BY b.id', [[A, B]])).map((r) => r.id),
          tiers: (await rows('SELECT t.id FROM marina_price_tier t JOIN marina m ON m.id = t.marina_id WHERE m.sidon_owner_id = ANY($1) ORDER BY t.id', [[A, B]])).map((r) => r.id),
          properties: (await rows("SELECT id FROM property WHERE clerk_org_id = 'org_check_t2'")).map((r) => r.id),
        });
        const first = await run(P, 'commit', 'accept_as_property_currency');
        const s1 = await snapshot();
        const second = await run(P, 'commit', 'accept_as_property_currency');
        assert.deepEqual(await snapshot(), s1);
        assert.equal(s1.properties.length, 1);
        assert.equal(s1.berths.length, 5);
        assert.deepEqual(second.marinas, first.marinas);
        assert.deepEqual(second.properties.map((p) => [p.property_id, p.created]), first.properties.map((p) => [p.property_id, false]));
        assert.deepEqual(await rows('SELECT delta, balance_after, reason FROM property_token_ledger WHERE property_id = $1', [s1.properties[0]]), starterRows);
        const text = I.formatReport(second);
        for (const s of [A, B, G, 'Alpha Check', 'Beta Check', 'org_check_t2']) assert.equal(text.includes(s), false, `report leaks ${s}`);
        assert.ok(text.includes(I.alias(A)) && text.includes('t2-alpha'));
      });

      await check('import: a guest booking on an imported marina refuses a commit run (row kept), a dry run warns (Review Focus 2)', async () => {
        const P = await beta();
        await run(P);
        const [{ id: g }] = await rows(
          `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, arrival, departure, status, source)
           SELECT property_id, marina_id, id, 'Guest Check', '2027-06-01', '2027-06-03', 'confirmed', 'guest' FROM marina_berth WHERE id = $1 RETURNING id`,
          [I.uid('berth', 9201)]);
        await assert.rejects(run(P), (e) => e instanceof I.ImportRefused && e.message.includes(I.alias(A)) && /Switch/.test(e.message));
        assert.equal((await rows('SELECT id FROM marina_booking WHERE id = $1', [g])).length, 1);
        const dry = await run(P, 'dry-run');
        assert.equal(dry.warnings.filter((w) => w.includes(I.alias(A)) && /Switch/.test(w)).length, 1);
      });

      await check('import: an enquiry on an imported marina refuses a commit run (row kept), a dry run warns and unlinks it (Review Focus 2)', async () => {
        const P = await beta();
        const PA = (await run(P)).properties.find((p) => p.created).property_id;
        const [{ id: e }] = await rows(
          `INSERT INTO event_inquiry (property_id, name, email, marina_id) VALUES ($1, 'Enquiry Check', 'enquiry@example.com', $2) RETURNING id`, [PA, MA]);
        await assert.rejects(run(P), (err) => err instanceof I.ImportRefused && err.message.includes(I.alias(A)));
        assert.equal((await rows('SELECT marina_id FROM event_inquiry WHERE id = $1', [e]))[0].marina_id, MA);
        const dry = await run(P, 'dry-run');
        assert.ok(dry.warnings.some((w) => w.includes(I.alias(A)) && /enquir/.test(w)));
        assert.equal((await rows('SELECT marina_id FROM event_inquiry WHERE id = $1', [e]))[0].marina_id, null);
        assert.equal((await rows('SELECT id FROM marina WHERE id = $1', [MA])).length, 1);
      });

      fs.rmSync(MAP_FILE, { force: true });
    }

```

- [ ] **Step 2: Run the check and watch the new cases fail**

Run: `node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"`

Expected: Task 1's checks print `ok   …`. Each of the 8 new checks prints `FAIL import: …` followed by `TypeError: I.importSidon is not a function`, because Task 1 exports no `importSidon`. The output ends:
```
8 FAILED
exit=1
```

- [ ] **Step 3: Require the shared helpers once, at the top**

In `scripts/import-sidon-marina.js`, replace Task 1's top-of-file require lines with exactly the block below. That is the contiguous block that starts `require('dotenv').config();`; any header comment above it stays. Tasks 3–4 use `emailKey` and `docs`. Requiring everything here once means a later task never adds a duplicate `const`.

```js
require('dotenv').config();
require('../src/db'); // DATE as 'YYYY-MM-DD' strings, for every pg client in the process
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const { emailKey } = require('../src/lib/spaBookingGuard');
const { propertyToday } = require('../src/lib/marinaQueries');
const { STARTER_BALANCE } = require('../src/lib/tokens'); // the pool behind it is lazy; nothing connects
const { unknownPlaceholders } = require('../src/lib/marinaContracts');
const docs = require('../src/lib/marinaDocuments');
```

- [ ] **Step 4: Add `importSidon` (steps 1–5) and `formatReport`**

Insert this block immediately above `module.exports = {`:

```js
// ── Writing: one target transaction, owned by the caller ──

const nz = (v) => (v === '' ? null : v); // two Sidon profiles store '' for "not set"
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100); // Sidon's float4 noise -> NUMERIC(…,2)
const BERTH_STATUS = { available: 'active', occupied: 'active', reserved: 'active', maintenance: 'maintenance' };
const zeroCounts = () => ({
  pontoons: 0, berths: 0, berths_duplicate: 0, pontoon_nulled: 0,
  tiers: 0, requirements: 0, templates: 0, pois: 0, images: 0,
  bookings: 0, bookings_no_berth: 0, bookings_overlap: 0, pending_expired: 0, emails_nulled: 0,
  occupancy: 0, occupancy_overlap: 0, signatures: 0,
  documents_copied: 0, documents_not_copied: 0, documents_sailor_docs: 0, documents_fetch_failed: 0,
});

async function importSidon(dst, source, plan, opts) {
  if (plan.refusals.length) throw new ImportRefused(plan.refusals.join('; '));
  const report = {
    mode: opts.mode, target: opts.target, files: opts.files,
    properties: [], marinas: [], rekeys: [], skips: [], currencyFlags: plan.currencyFlags,
    unknownPlaceholders: [], archived: [], sailor_docs_unlinked: 0, messages_exported: 0, warnings: [],
  };
  const importing = plan.owners.filter((o) => o.action === 'import');
  const ownerIds = importing.map((o) => o.owner_id);
  const byOwner = (rows, ownerId) => rows.filter((r) => r.owner_id === ownerId);

  // 1. Re-run guard (R11, G5). The delete below cascades through every
  // booking on these marinas, so once a guest has booked or enquired in OTA
  // (Switch has happened) a commit must stop rather than erase them. A dry
  // run reports the same thing and carries on, since nothing it writes is
  // kept.
  const { rows: hits } = await dst.query(
    `SELECT m.id, m.sidon_owner_id,
            (SELECT count(*) FROM marina_booking b WHERE b.marina_id = m.id AND b.source <> 'import')::int AS bookings,
            (SELECT count(*) FROM event_inquiry e WHERE e.marina_id = m.id)::int AS enquiries
     FROM marina m WHERE m.sidon_owner_id = ANY($1)`, [ownerIds]);
  const switched = hits.filter((h) => h.bookings || h.enquiries);
  if (switched.length) {
    const lines = switched.map((h) =>
      `${alias(h.sidon_owner_id)} has ${h.bookings} non-import booking(s) and ${h.enquiries} enquiry(ies) in OTA: Switch has happened and a re-import would delete them`);
    if (opts.mode === 'commit') throw new ImportRefused(lines.join('; '));
    report.warnings.push(...lines.map((l) => `${l} (dry run continues; nothing is kept)`));
    // event_inquiry.marina_id has no ON DELETE, so the delete would fail on
    // it; unlinking inside this rolled-back transaction lets the rehearsal finish.
    await dst.query('UPDATE event_inquiry SET marina_id = NULL WHERE marina_id = ANY($1)', [switched.map((h) => h.id)]);
  }

  // 2. Properties. A reused one is never written (G3): its currency,
  // timezone and interim sidon_marina_id stay exactly as staff set them.
  const propertyIdOf = new Map();
  const todayOf = new Map();
  for (const p of plan.properties) {
    let id = p.property_id;
    if (p.create) {
      id = (await dst.query(
        `INSERT INTO property (name, clerk_org_id, currency, timezone, api_key, api_key_enabled, sidon_marina_id)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
        [p.create.name, p.create.clerk_org_id, p.create.currency.toUpperCase(), p.create.timezone,
          'prop_' + crypto.randomBytes(32).toString('hex'), p.owners[0]])).rows[0].id;
      // grantStarter() opens its own pool connection, which is bound to
      // DATABASE_URL even under --live and sits outside this transaction, so
      // the same two writes are made here instead.
      if (STARTER_BALANCE > 0) {
        const { rows: [{ token_balance }] } = await dst.query(
          'UPDATE property SET token_balance = token_balance + $2 WHERE id = $1 RETURNING token_balance', [id, STARTER_BALANCE]);
        await dst.query(
          `INSERT INTO property_token_ledger (property_id, delta, balance_after, reason) VALUES ($1, $2, $3, 'starter')`,
          [id, STARTER_BALANCE, token_balance]);
      }
    }
    propertyIdOf.set(p.key, id);
    todayOf.set(id, await propertyToday(dst, id));
    report.properties.push({ key: p.key, property_id: id, created: !!p.create, today: todayOf.get(id) });
  }

  // 3. Everything under the mapped marinas goes; every child FK cascades.
  await dst.query('DELETE FROM marina WHERE sidon_owner_id = ANY($1)', [ownerIds]);

  // 4. Each importing owner's marina and catalogue, under ids derived from
  // Sidon's (R10), so a re-run lands on the same rows.
  const marinas = new Map();
  const rekeyTo = new Map(plan.owners.filter((o) => o.action === 'rekey').map((o) => [o.owner_id, o.rekey_to]));
  const marinaOf = (ownerId) => marinas.get(rekeyTo.get(ownerId) ?? ownerId);
  const overlayIds = new Set(source.overlays.map((ov) => ov.id));
  const berthIds = new Map();
  const requirementIds = new Map();
  const templateIds = new Map();

  const insertBerth = async (m, b) => {
    // One label per marina: a re-keyed owner's copy of a target berth is a duplicate, not a second berth (R13).
    if (m.labels.has(b.berth_id)) { m.counts.berths_duplicate++; return; }
    let pontoonId = null;
    if (b.overlay_id != null) {
      pontoonId = m.pontoons.get(b.overlay_id) ?? null;
      // An id with no overlay at all is plain NULL. One that exists but belongs to another owner is counted,
      // because it means that owner's map drew this berth.
      if (!pontoonId && overlayIds.has(b.overlay_id)) m.counts.pontoon_nulled++;
    }
    const status = BERTH_STATUS[b.status];
    if (!status) report.warnings.push(`${m.alias}: berth ${b.id} has unknown status '${b.status}', imported as inactive`);
    const id = uid('berth', b.id);
    await dst.query(
      `INSERT INTO marina_berth (id, property_id, marina_id, pontoon_id, label, lat, lng, rotation, length_m, min_length_m, beam_m, depth_m,
         price_per_night, price_mode, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, m.property_id, m.id, pontoonId, b.berth_id, b.lat, b.lng, b.rotation,
        round2(b.length_m), round2(b.min_length_m), round2(b.beam_m), round2(b.depth_m),
        m.prices === 'drop' ? null : round2(b.price_per_night), nz(b.price_mode) ?? 'per_metre', nz(b.notes), status ?? 'inactive']);
    m.labels.set(b.berth_id, id);
    berthIds.set(b.id, { id, marina: m });
    m.counts.berths++;
  };

  const insertRequirement = async (m, r) => {
    let fields;
    try { fields = JSON.parse(r.schema); } catch { throw new ImportRefused(`${m.alias}: requirement ${r.id} has a schema that is not JSON`); }
    const id = uid('requirement', r.id);
    await dst.query(
      `INSERT INTO marina_doc_requirement (id, property_id, marina_id, type, name, description, fields, mandatory, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      // pg would send a JS array as a Postgres array, so JSONB gets text.
      [id, m.property_id, m.id, r.type, r.name, nz(r.description), JSON.stringify(fields ?? []), r.mandatory === 1, r.sort_order ?? 0]);
    requirementIds.set(r.id, id);
    m.reqTypes.add(r.type);
    m.counts.requirements++;
  };

  const insertTemplate = async (m, t) => {
    const id = uid('template', t.id);
    await dst.query(
      `INSERT INTO marina_contract_template (id, property_id, marina_id, name, body_markdown, min_nights, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, m.property_id, m.id, t.name, t.body_markdown, t.min_nights ?? 0, t.active === 1 ? 'active' : 'inactive', t.created_at]);
    templateIds.set(t.id, id);
    m.counts.templates++;
    const fields = unknownPlaceholders(t.body_markdown);
    if (fields.length) report.unknownPlaceholders.push({ alias: alias(t.owner_id), template_id: id, fields });
  };

  for (const o of importing) {
    const prof = source.profiles.find((p) => p.owner_id === o.owner_id);
    if (!prof) throw new ImportRefused(`${o.alias} has no marina_profile to import (map it to rekey or skip)`);
    const lay = source.layouts.find((l) => l.owner_id === o.owner_id);
    const pid = propertyIdOf.get(o.property_key);
    const m = {
      id: uid('marina', o.owner_id), property_id: pid, owner_id: o.owner_id, alias: o.alias, prices: o.prices,
      counts: zeroCounts(), pontoons: new Map(), labels: new Map(), reqTypes: new Set(),
    };
    await dst.query(
      `INSERT INTO marina (id, property_id, name, slug, description, phone, email, website, lat, lng,
         layout_svg, layout_sw_lat, layout_sw_lng, layout_ne_lat, layout_ne_lng, layout_rotation,
         response_window_hours, sidon_owner_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'active')`,
      [m.id, pid, prof.name, o.slug, nz(prof.description), nz(prof.phone), nz(prof.email), nz(prof.website), prof.lat, prof.lng,
        nz(lay?.svg_data) ?? null, lay?.sw_lat ?? null, lay?.sw_lng ?? null, lay?.ne_lat ?? null, lay?.ne_lng ?? null, lay?.rotation ?? null,
        prof.response_window_hours ?? 24, o.owner_id]);
    marinas.set(o.owner_id, m);
    report.marinas.push({ alias: o.alias, slug: o.slug, property_id: pid, counts: m.counts });

    for (const ov of byOwner(source.overlays, o.owner_id)) {
      const id = uid('pontoon', ov.id);
      await dst.query(
        `INSERT INTO marina_pontoon (id, property_id, marina_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, pid, m.id, nz(ov.name) ?? 'Dock', ov.svg_data, ov.sw_lat, ov.sw_lng, ov.ne_lat, ov.ne_lng, ov.rotation, ov.sort_order ?? 0]);
      m.pontoons.set(ov.id, id); // by overlay id, never by name: names repeat across owners
      m.counts.pontoons++;
    }
    for (const b of byOwner(source.berths, o.owner_id)) await insertBerth(m, b);
    // drop_prices: the numbers are in the marina's currency, not the property's, so none are kept (Review Focus 1).
    if (m.prices === 'keep') {
      for (const t of byOwner(source.tiers, o.owner_id)) {
        await dst.query(
          `INSERT INTO marina_price_tier (id, property_id, marina_id, valid_from, valid_to, max_length_m, max_beam_m,
             price_per_night, price_per_month, price_per_year, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          // Tier prices are whole units already (Sidon multiplies by 100 at checkout).
          [uid('tier', t.id), pid, m.id, tierDate(t.valid_from), tierDate(t.valid_to), round2(t.max_len_m), round2(t.max_beam_m),
            t.price_per_night, t.price_per_month, t.price_per_year, t.created_at]);
        m.counts.tiers++;
      }
    }
    for (const r of byOwner(source.requirements, o.owner_id)) await insertRequirement(m, r);
    for (const t of byOwner(source.templates, o.owner_id)) await insertTemplate(m, t);
    for (const p of byOwner(source.pois, o.owner_id)) {
      await dst.query(
        `INSERT INTO marina_poi (id, property_id, marina_id, label, type, lat, lng) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uid('poi', p.id), pid, m.id, p.label, nz(p.type), p.lat, p.lng]);
      m.counts.pois++;
    }
    for (const img of byOwner(source.images, o.owner_id)) {
      await dst.query(
        `INSERT INTO marina_image (id, property_id, marina_id, url, description, sort_order, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uid('image', img.id), pid, m.id, img.url /* Sidon's own public URL, what --no-files keeps */, nz(img.description), img.sort_order ?? 0, img.created_at]);
      m.counts.images++;
    }
  }

  // 5. Re-keyed owners land in their target's marina (R13). Catalogue rows
  // only fill gaps, so the target's own requirements and templates win.
  for (const o of plan.owners.filter((x) => x.action === 'rekey')) {
    const m = marinas.get(o.rekey_to);
    report.rekeys.push({ alias: o.alias, to_alias: m.alias });
    for (const b of byOwner(source.berths, o.owner_id)) await insertBerth(m, b);
    const targetTypes = new Set(m.reqTypes);
    for (const r of byOwner(source.requirements, o.owner_id)) if (!targetTypes.has(r.type)) await insertRequirement(m, r);
    if (m.counts.templates === 0) for (const t of byOwner(source.templates, o.owner_id)) await insertTemplate(m, t);
    const dropped = ['overlays', 'tiers', 'pois', 'images'].reduce((n, k) => n + byOwner(source[k], o.owner_id).length, 0);
    if (dropped) report.warnings.push(`${o.alias} (re-keyed to ${m.alias}): ${dropped} overlay/tier/POI/image row(s) not imported`);
  }
  report.skips = plan.owners.filter((o) => o.action === 'skip').map((o) => ({ alias: o.alias, reason: o.reason }));

  return report;
}

// For terminals and sign-off notes: aliases, slugs, property ids and counts
// only. It never carries a name, email or Sidon owner id.
function formatReport(report) {
  const r = report;
  const out = [`import ${r.mode === 'commit' ? 'committed' : 'dry run (rolled back)'}; target ${r.target}; files ${r.files ? 'on' : 'off'}`];
  out.push('properties:', ...r.properties.map((p) => `  ${p.property_id} ${p.created ? 'created' : 'reused'} (today ${p.today})`));
  out.push('marinas:');
  for (const m of r.marinas) {
    out.push(`  ${m.alias} ${m.slug} -> ${m.property_id}`);
    out.push('    ' + Object.entries(m.counts).map(([k, v]) => `${k}=${v}`).join(' '));
  }
  if (r.rekeys.length) out.push('re-keyed:', ...r.rekeys.map((k) => `  ${k.alias} -> ${k.to_alias}`));
  if (r.skips.length) out.push('skipped:', ...r.skips.map((s) => `  ${s.alias}: ${s.reason}`));
  if (r.currencyFlags.length) {
    out.push('currency flags:', ...r.currencyFlags.map((f) =>
      `  ${f.alias}: marina ${f.marina_currency}, property ${f.property_currency}, decision ${f.decision ?? 'none'}`));
  }
  if (r.unknownPlaceholders.length) {
    out.push('template placeholders that render blank:', ...r.unknownPlaceholders.map((u) => `  ${u.alias} template ${u.template_id}: ${u.fields.join(', ')}`));
  }
  if (r.warnings.length) out.push('warnings:', ...r.warnings.map((w) => `  ${w}`));
  return out.join('\n');
}

```

- [ ] **Step 5: Export both**

Replace the whole `module.exports = { … };` statement with this (Task 4 adds `sourcePath`, `extOf` and `typeFromExt`):

```js
module.exports = { ImportRefused, alias, uid, slugify, tierDate, cleanEmail, mapBookingStatus, insideRetention,
  loadMap, readSource, readTargets, planMapping, importSidon, formatPlan, formatReport };
```

- [ ] **Step 6: Wire `--dry-run` and commit into the CLI**

Replace the whole `if (require.main === module) { … }` block with the block below. The `--map` branch is Task 1's behaviour: print `formatPlan(plan)`, exit 1 when it has refusals, write nothing. If Task 1's `--map` branch reads differently, keep its body verbatim in place of the `if (mapOnly)` body.

```js
if (require.main === module) {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const mapOnly = argv.includes('--map');
  const mode = argv.includes('--dry-run') ? 'dry-run' : 'commit';
  const files = !argv.includes('--no-files');
  const mapFile = argv.find((a) => !a.startsWith('--')) ?? `.superpowers/import-map.${live ? 'live' : 'local'}.json`;
  const ssl = (url) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

  const main = async () => {
    const dstKey = live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL';
    const srcUrl = process.env.SIDON_DATABASE_URL;
    const dstUrl = process.env[dstKey];
    if (!srcUrl) throw new ImportRefused('SIDON_DATABASE_URL is not set');
    if (!dstUrl) throw new ImportRefused(`${dstKey} is not set`);
    // 8 Sidon table names are OTA's too: one database for both would read OTA as Sidon.
    if (srcUrl === dstUrl) throw new ImportRefused(`SIDON_DATABASE_URL and ${dstKey} are the same database`);
    if (!mapOnly && files && !(process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_PUBLIC_READ_WRITE_TOKEN)) {
      throw new ImportRefused('BLOB_READ_WRITE_TOKEN and BLOB_PUBLIC_READ_WRITE_TOKEN must both be set (or pass --no-files)');
    }
    const map = loadMap(mapFile);
    const src = new Client({ connectionString: srcUrl, ssl: ssl(srcUrl) });
    const dst = new Client({ connectionString: dstUrl, ssl: ssl(dstUrl) });
    await src.connect();
    await dst.connect();
    try {
      if (!mapOnly) await dst.query('BEGIN');
      try {
        // READ ONLY makes Postgres itself refuse any write to Sidon.
        await src.query('BEGIN READ ONLY');
        const source = await readSource(src);
        await src.query('COMMIT');
        const plan = planMapping(source, map, await readTargets(dst, source, map));
        if (mapOnly) {
          console.log(formatPlan(plan));
          if (plan.refusals.length) process.exitCode = 1;
          return;
        }
        const report = await importSidon(dst, source, plan, { mode, target: live ? 'live' : 'local', files });
        await dst.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK');
        console.log(formatReport(report));
      } catch (err) {
        if (!mapOnly) await dst.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      await src.end();
      await dst.end();
    }
  };

  main().catch((err) => {
    if (!(err instanceof ImportRefused)) throw err; // a real bug: let Node print the stack and exit 1
    console.error(`refused: ${err.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 7: Run the check again**

Run: `node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"`

Expected: Task 1's checks stay `ok`, and the new lines read:
```
ok   import: created property has the map fields, an enabled prop_ key, sidon_marina_id = first owner, one starter grant
ok   import: a reused property is never written (currency, timezone, sidon_marina_id, tokens; G3)
ok   import: marina, pontoons, berths, tiers, requirements, templates, POIs and images map field by field
ok   import: re-key drops duplicate labels (counted), cross-owner overlay -> pontoon NULL (counted), dangling overlay -> NULL
ok   import: drop_prices -> NULL berth prices and no tiers; accept_as_property_currency keeps them (Review Focus 1)
ok   import: a second run keeps marina/berth/tier ids, counts and the created property; report has aliases only (Review Focus 2)
ok   import: a guest booking on an imported marina refuses a commit run (row kept), a dry run warns (Review Focus 2)
ok   import: an enquiry on an imported marina refuses a commit run (row kept), a dry run warns and unlinks it (Review Focus 2)

all passed
exit=0
```

- [ ] **Step 8: CLI refusals (no database is touched)**

Both refusals fire before any connection is made. The target URL is passed straight from `.env` into the variable, so it is never echoed.

Run: `SIDON_DATABASE_URL=$(node -e "require('dotenv').config(); process.stdout.write(process.env.DATABASE_URL)") node scripts/import-sidon-marina.js --dry-run --no-files; echo "exit=$?"`

Expected:
```
refused: SIDON_DATABASE_URL and DATABASE_URL are the same database
exit=1
```

Run: `SIDON_DATABASE_URL=postgresql://nobody@localhost:1/none BLOB_READ_WRITE_TOKEN= BLOB_PUBLIC_READ_WRITE_TOKEN= node scripts/import-sidon-marina.js --dry-run; echo "exit=$?"`

Expected (dotenv never overrides a variable the shell already set, even an empty one):
```
refused: BLOB_READ_WRITE_TOKEN and BLOB_PUBLIC_READ_WRITE_TOKEN must both be set (or pass --no-files)
exit=1
```

The real dry run against Sidon (`--dry-run --no-files` with the local map file) is a runbook rehearsal step (Step 4). It needs `SIDON_DATABASE_URL` and a signed-off map, so it isn't run here.

- [ ] **Step 9: The other O gates**

Run: `node -r dotenv/config scripts/check-marina.js; echo "exit=$?"` → ends `all passed`, `exit=0`.

Run: `node -r dotenv/config scripts/check-marina-http.js; echo "exit=$?"` → ends `all passed`, `exit=0`.

- [ ] **Step 10: Commit on O main**

```bash
git -C /c/Users/robert/source/repos/OTA status --short   # expect the two files below, plus the pre-existing untracked '=' and the .bak (never staged)
git -C /c/Users/robert/source/repos/OTA add scripts/import-sidon-marina.js scripts/check-import-sidon.js
git -C /c/Users/robert/source/repos/OTA commit -F - <<'EOF'
Sidon import: properties, catalogue and the re-run guard

importSidon now creates the mapped properties (an enabled prop_ key,
sidon_marina_id = first owner, the starter grant inline in the same
transaction) and never writes a reused one. It deletes and re-inserts
each mapped marina's catalogue under ids derived from Sidon's, and
imports re-keyed owners' new berths and missing catalogue rows into
their target. drop_prices keeps no berth price or tier.

A commit run is refused once a guest booking or enquiry exists on an
imported marina; a dry run warns and unlinks the enquiry inside its
rolled-back transaction. The CLI gains --dry-run (rolled back) and
commit, printing an alias-only report.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

Nothing is pushed. The repo stays on `main`.

---

### Task 3: Importer bookings, occupancy and signatures (O main)

Repo `O` = `C:/Users/robert/source/repos/OTA`, branch `main` (R5). This task implements contract `importSidon` order steps 6–8 (R13, R15, R16). Commands are for Git Bash and run from `O`, because the scripts load `.env` from the working directory. The local DB is the only target.

**Files:**
- Modify: `O/scripts/import-sidon-marina.js` (Task 1 creates it, Task 2 extends it, so line numbers are not fixed yet; locate the edits by code marker):
  - insert the new functions directly above the line `async function importSidon(`
  - insert one call directly above the final `return report;` of `importSidon`
- Modify: `O/scripts/check-import-sidon.js`: insert one block directly above `    // (later tasks append checks here)`, and keep the marker after it.

**Interfaces:**
- Consumes:
  - From Task 1, in the same module: `alias`, `uid`, `cleanEmail`, `mapBookingStatus(b, today, now)`, `readTargets`, `planMapping`. Also the module header's `const { propertyToday } = require('../src/lib/marinaQueries');` and `const { emailKey } = require('../src/lib/spaBookingGuard');`.
  - From Task 2: `importSidon(dst, source, plan, opts)` builds `report` with one `report.marinas` entry per importing owner (`alias(owner_id)`), whose `counts` is a zeroed `MarinaCounts`, plus `report.warnings: string[]`. Before `return report;` it has already written the marinas (`uid('marina', owner_id)`), the berths (`uid('berth', sidon berth id)`; re-keyed owners' duplicate berths are not imported) and the templates (`uid('template', id)`; re-keyed owners' templates only when the target has none).
  - Plan fields: `PlannedOwner.action`, `.rekey_to` (the target's owner id) and `.prices`.
  - `ImportOptions.now`.
  - Existing code: `propertyToday(client, propertyId)` (`src/lib/marinaQueries.js:4`), `emailKey` (`src/lib/spaBookingGuard.js:30`), `bookingToken(id)` (`src/lib/marinaToken.js`, used by the check only).
  - The check harness's `db` (`pg.Client`) and `check(name, fn)`.
- Produces:
  - `async function importBookings(dst, source, plan, report, opts)` returns `Map<number /* Sidon booking id */, ImportedBooking>`, where `ImportedBooking = { id, owner_id /* target owner id */, property_id, marina_id, status /* mapped */, cancel_reason, departure, updated_at, today, email }`.
  - Inside `importSidon` it is called as `const imported = await importBookings(dst, source, plan, report, opts);`. Task 4's step 9 reads `imported` to classify documents and to evaluate `insideRetention({ status, departure, updated_at }, today, now)`.
  - Counters filled per target marina: `bookings`, `bookings_no_berth`, `bookings_overlap`, `pending_expired`, `emails_nulled`, `occupancy`, `occupancy_overlap`, `signatures`.

- [ ] **Step 1: Confirm Tasks 1–2 are in place**

```bash
cd /c/Users/robert/source/repos/OTA && git status --short scripts/ && grep -c "^async function importSidon(" scripts/import-sidon-marina.js && grep -c "(later tasks append checks here)" scripts/check-import-sidon.js && grep -n "require('../src/lib/marinaQueries')\|require('../src/lib/spaBookingGuard')" scripts/import-sidon-marina.js
```

Expected:
- `git status --short scripts/` prints nothing, because Tasks 1–2 are committed.
- Each count prints `1`.
- The last grep prints the two header `require` lines.

If the grep prints no `marinaQueries` line, add `const { propertyToday } = require('../src/lib/marinaQueries');` directly below `require('../src/db');`. If it prints no `spaBookingGuard` line, add `const { emailKey } = require('../src/lib/spaBookingGuard');` in the same place. Make no other change in this step.

Then run `node -r dotenv/config scripts/check-import-sidon.js`. Expected: the last line is `all passed` (Tasks 1–2 baseline).

- [ ] **Step 2: Write the failing checks**

In `O/scripts/check-import-sidon.js`, insert this block directly above `    // (later tasks append checks here)`:

```js
    // ---- Task 3: bookings, occupancy, signatures (R13, R15, R16) ----
    // Block-scoped so these names never collide with earlier tasks' helpers.
    // In-memory Source objects (the exact readSource shape) keep these cases
    // independent of the shared sidon_fixture rows.
    {
      const I = require('./import-sidon-marina');
      const { propertyToday } = require('../src/lib/marinaQueries');
      const { emailKey } = require('../src/lib/spaBookingGuard');
      const { bookingToken } = require('../src/lib/marinaToken');
      const OA = 'org_t3_alpha';    // created property in Pacific/Tahiti (UTC-10, like BBYC)
      const OR = 'org_t3_rekey';    // profile-less, re-keyed onto OA
      const OB = 'org_t3_sterling'; // reuses a GBP property with a eur profile
      const TZ = 'Pacific/Tahiti';
      const hour = 3600 * 1000;
      // Days relative to the Tahiti property's own today (now() is fixed for
      // the whole transaction), so "covers today" holds at any UTC hour.
      const day = async (offset) => (await db.query(
        'SELECT ((now() AT TIME ZONE $1)::date + $2::int)::text AS d', [TZ, offset])).rows[0].d;
      const empty = () => ({ profiles: [], layouts: [], overlays: [], berths: [], tiers: [], bookings: [], requirements: [],
        documents: [], templates: [], signatures: [], pois: [], images: [], messages: [] });
      const profile = (owner_id, slug, currency) => ({ owner_id, slug, name: slug, lat: null, lng: null, description: null,
        phone: null, email: null, website: null, response_window_hours: null, currency, updated_at: new Date('2026-01-01T00:00:00Z') });
      const berth = (id, owner_id, label, status, guest_name = null) => ({ id, owner_id, berth_id: label, overlay_id: null,
        lat: null, lng: null, length_m: 12, min_length_m: null, beam_m: 4, depth_m: null, status, guest_name, notes: null,
        price_per_night: 3, price_mode: 'per_metre', rotation: null });
      let seq = 0;
      // Source.bookings is in created_at, id order: each call is one second later.
      const booking = (id, owner_id, label, arrival, departure, status, extra = {}) => {
        const at = new Date(Date.UTC(2026, 2, 1, 0, 0, seq++));
        return { id, owner_id, berth_id: label, sailor_name: `Sailor ${id}`, sailor_email: `sailor${id}@example.com`,
          boat_name: `Boat ${id}`, boat_loa: 10, boat_beam: 3.5, arrival_date: arrival, departure_date: departure, notes: null,
          status, payment_intent_id: null, amount_cents: 10000, expires_at: null, created_at: at, updated_at: at, ...extra };
      };
      const alphaSource = async () => {
        seq = 0;
        const s = empty();
        s.profiles.push(profile(OA, 't3-alpha', 'eur'));
        s.berths.push(berth(9301, OA, 'A1', 'available'), berth(9302, OA, 'A2', 'available'),
          berth(9303, OA, 'A3', 'occupied', '  Capt Nemo  '), berth(9304, OA, 'A4', 'reserved', '   '),
          berth(9305, OA, 'A5', 'occupied'), berth(9306, OA, 'A6', 'occupied'),
          berth(9311, OR, 'A1', 'occupied'));
        s.bookings.push(
          booking(9401, OA, 'A1', '2030-06-01', '2030-06-05', 'confirmed', { sailor_email: '  Sailor.One+x@Example.com ',
            boat_loa: 12.346, boat_beam: 4.004, amount_cents: 12345, payment_intent_id: 'pi_t3_1', notes: 'n1' }),
          booking(9402, OA, 'A1', '2030-06-03', '2030-06-07', 'confirmed'),
          booking(9403, OA, 'Z9', '2030-06-01', '2030-06-03', 'confirmed'),
          booking(9404, OA, 'A2', '2030-07-01', '2030-07-05', 'pending', { expires_at: new Date(Date.now() - hour) }),
          booking(9405, OA, 'A2', '2030-07-10', '2030-07-12', 'pending'),
          booking(9406, OA, 'A2', '2030-08-01', '2030-08-03', 'pending', { expires_at: new Date(Date.now() + 24 * hour) }),
          booking(9407, OA, 'A2', '2030-09-01', '2030-09-03', 'declined', { sailor_email: 'no-at-sign' }),
          booking(9408, OA, 'A2', '2030-09-01', '2030-09-03', 'cancelled', { sailor_email: '   ' }),
          booking(9409, OA, 'A5', await day(-2), await day(3), 'confirmed'),
          booking(9410, OA, 'A6', await day(10), await day(12), 'confirmed'),
          booking(9411, OR, 'A1', '2031-01-10', '2031-01-12', 'confirmed'));
        s.templates.push({ id: 9601, owner_id: OA, name: 'T3 terms', body_markdown: 'I agree to the marina terms.',
          min_nights: 0, active: 1, created_at: new Date('2026-01-01T00:00:00Z') });
        s.signatures.push(
          { id: 9501, owner_id: OA, template_id: 9601, booking_id: 9401, rendered_body: 'Signed 9401',
            signed_at: new Date('2026-03-02T10:00:00Z'), ip_address: '203.0.113.7', user_agent: 'UA' },
          { id: 9502, owner_id: OA, template_id: 9601, booking_id: 9402, rendered_body: 'Signed 9402',
            signed_at: new Date('2026-03-02T11:00:00Z'), ip_address: null, user_agent: null },
          { id: 9503, owner_id: OR, template_id: 9699, booking_id: 9411, rendered_body: 'Signed 9411',
            signed_at: new Date('2026-03-02T12:00:00Z'), ip_address: null, user_agent: null });
        return s;
      };
      const alphaMap = { owners: {
        [OA]: { action: 'create', name: 'T3 Alpha', timezone: TZ, clerk_org_id: 'org_t3_check' },
        [OR]: { action: 'rekey', to_owner: OA },
      } };
      // Fresh readTargets + planMapping per run, so a second run finds the
      // first run's created property through Targets.reruns.
      const run = async (source, map) => {
        const targets = await I.readTargets(db, source, map);
        return I.importSidon(db, source, I.planMapping(source, map, targets), { mode: 'commit', target: 'local', files: false });
      };
      const countsOf = (report, ownerId) => report.marinas.find((m) => m.alias === I.alias(ownerId)).counts;
      const mb = async (kind, id) => (await db.query('SELECT * FROM marina_booking WHERE id = $1', [I.uid(kind, id)])).rows[0];
      const alpha = async () => countsOf(await run(await alphaSource(), alphaMap), OA);

      await check('T3: expired or expiry-less pending -> cancelled/expired; declined, cancelled, live pending as-is', async () => {
        const c = await alpha();
        const st = async (id) => { const r = await mb('booking', id); return [r.status, r.cancel_reason]; };
        assert.deepEqual(await st(9401), ['confirmed', null]);
        assert.deepEqual(await st(9404), ['cancelled', 'expired']);
        assert.deepEqual(await st(9405), ['cancelled', 'expired']);
        assert.deepEqual(await st(9406), ['pending', null]);
        assert.deepEqual(await st(9407), ['declined', null]);
        assert.deepEqual(await st(9408), ['cancelled', null]);
        assert.equal(c.pending_expired, 2);
        assert.equal(c.bookings, 9); // 11 source rows minus the overlap and the berth-less one
      });
      await check('T3: imported booking fields (R15)', async () => {
        await alpha();
        const r = await mb('booking', 9401);
        const { property_id } = (await db.query('SELECT property_id FROM marina WHERE id = $1', [I.uid('marina', OA)])).rows[0];
        assert.deepEqual([r.property_id, r.marina_id, r.berth_id], [property_id, I.uid('marina', OA), I.uid('berth', 9301)]);
        assert.deepEqual([r.arrival, r.departure], ['2030-06-01', '2030-06-05']);
        assert.deepEqual([r.source, r.locale, r.payment_status, r.hold_expires_at], ['import', 'en', 'none', null]);
        assert.equal(r.legacy_payment_intent_id, 'pi_t3_1');
        assert.deepEqual([r.total_price, r.currency], ['123.45', 'EUR']);
        assert.deepEqual([r.boat_length_m, r.boat_beam_m], ['12.35', '4.00']);
        assert.deepEqual([r.contact_name, r.boat_name, r.notes], ['Sailor 9401', 'Boat 9401', 'n1']);
        assert.equal(r.contact_email, 'Sailor.One+x@Example.com');
        assert.equal(r.contact_email_key, emailKey('Sailor.One+x@Example.com'));
        assert.equal(r.contact_email_key, 'sailor.one@example.com');
        assert.equal(r.created_at.getTime(), Date.UTC(2026, 2, 1, 0, 0, 0));
        assert.equal(r.updated_at.getTime(), Date.UTC(2026, 2, 1, 0, 0, 0));
      });
      await check('T3: blank or @-less emails import as NULL with a NULL key, and are counted', async () => {
        const c = await alpha();
        for (const id of [9407, 9408]) {
          const r = await mb('booking', id);
          assert.deepEqual([r.contact_email, r.contact_email_key], [null, null]);
        }
        assert.equal(c.emails_nulled, 2);
      });
      await check('T3: the later of an overlapping confirmed pair is skipped and counted', async () => {
        const c = await alpha();
        assert.ok(await mb('booking', 9401), 'the earlier one is kept');
        assert.equal(await mb('booking', 9402), undefined);
        assert.equal(c.bookings_overlap, 1);
      });
      await check('T3: a booking whose berth label is not in the target marina is skipped and counted', async () => {
        const c = await alpha();
        assert.equal(await mb('booking', 9403), undefined);
        assert.equal(c.bookings_no_berth, 1);
      });
      await check("T3 (R13): a re-keyed owner's booking lands on the target's berth, counted under the target", async () => {
        const c = await alpha();
        const r = await mb('booking', 9411);
        assert.deepEqual([r.marina_id, r.berth_id], [I.uid('marina', OA), I.uid('berth', 9301)]);
        assert.equal(c.bookings, 9);
      });
      const sterling = async (decision) => {
        const P = (await db.query(
          "INSERT INTO property (name, timezone, currency) VALUES ('T3 Sterling', 'Europe/London', 'GBP') RETURNING id")).rows[0].id;
        seq = 0;
        const s = empty();
        s.profiles.push(profile(OB, 't3-sterling', 'eur'));
        s.berths.push(berth(9321, OB, 'B1', 'available'));
        s.bookings.push(booking(9701, OB, 'B1', '2030-05-01', '2030-05-03', 'confirmed', { amount_cents: 5000 }));
        await run(s, { owners: { [OB]: { action: 'property', property_id: P, currency_decision: decision } } });
        return mb('booking', 9701);
      };
      await check('T3 (Review Focus 1): drop_prices -> the property currency and a NULL total', async () => {
        const r = await sterling('drop_prices');
        assert.deepEqual([r.currency, r.total_price], ['GBP', null]);
      });
      await check('T3 (Review Focus 1): accept_as_property_currency keeps the number, in the property currency', async () => {
        const r = await sterling('accept_as_property_currency');
        assert.deepEqual([r.currency, r.total_price], ['GBP', '50.00']);
      });
      await check("T3 (Review Focus 3): occupancy starts on the Tahiti property's today; blank guest -> Reserved", async () => {
        const c = await alpha();
        const occ = await mb('occupancy', 9303);
        const today = await propertyToday(db, occ.property_id);
        assert.equal(today, await day(0));
        assert.deepEqual([occ.arrival, occ.departure, occ.status, occ.source], [today, null, 'confirmed', 'import']);
        assert.deepEqual([occ.contact_name, occ.total_price, occ.currency, occ.payment_status], ['Capt Nemo', null, 'EUR', 'none']);
        assert.equal(occ.berth_id, I.uid('berth', 9303));
        assert.equal((await mb('occupancy', 9304)).contact_name, 'Reserved');
        assert.equal(await mb('occupancy', 9305), undefined, 'covered today by an imported booking');
        assert.equal(await mb('occupancy', 9306), undefined, 'a future booking blocks the open-ended row');
        assert.equal(await mb('occupancy', 9301), undefined, 'available berth');
        assert.equal(await mb('occupancy', 9311), undefined, 're-keyed duplicate berth is not imported');
        assert.deepEqual([c.occupancy, c.occupancy_overlap], [2, 1]);
      });
      await check('T3 (Review Focus 2): booking ids and bookingToken(id) are identical across two runs', async () => {
        const snapshot = async () => (await db.query(
          'SELECT id FROM marina_booking WHERE marina_id = $1 ORDER BY id', [I.uid('marina', OA)])).rows
          .map((r) => [r.id, bookingToken(r.id)]);
        const c1 = await alpha();
        const first = await snapshot();
        const c2 = await alpha();
        const second = await snapshot();
        assert.equal(first.length, 11); // 9 bookings + 2 occupancy rows
        assert.deepEqual(second, first);
        assert.deepEqual(c2, c1);
        assert.ok(first.some(([id]) => id === I.uid('booking', 9401)));
      });
      await check('T3: signatures exist only for imported bookings', async () => {
        const c = await alpha();
        const { rows } = await db.query(
          'SELECT * FROM marina_contract_signature WHERE booking_id = ANY($1) ORDER BY agreed_at',
          [[9401, 9402, 9403, 9411].map((id) => I.uid('booking', id))]);
        assert.deepEqual(rows.map((r) => r.id), [I.uid('signature', 9501), I.uid('signature', 9503)]);
        const [a, b] = rows;
        assert.deepEqual([a.booking_id, a.template_id, a.rendered_body, a.signer_email, a.ip_address, a.user_agent],
          [I.uid('booking', 9401), I.uid('template', 9601), 'Signed 9401', 'Sailor.One+x@Example.com', '203.0.113.7', 'UA']);
        assert.equal(a.agreed_at.getTime(), Date.parse('2026-03-02T10:00:00Z'));
        assert.equal(a.property_id, (await mb('booking', 9401)).property_id);
        assert.deepEqual([b.booking_id, b.template_id, b.signer_email], [I.uid('booking', 9411), null, 'sailor9411@example.com']);
        assert.equal(c.signatures, 2);
      });
    }
```

- [ ] **Step 3: Run the checks and watch them fail**

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"
```

Expected:
- Every Task 1–2 check prints `ok`.
- The eleven `T3` checks print `FAIL`. Before this task, `importSidon` writes no `marina_booking` or signature rows, so the failures are `TypeError: Cannot read properties of undefined (reading 'status'|'property_id'|'contact_email'|'marina_id'|'currency')`, or an `AssertionError` on counts that are still `0` (`bookings_no_berth`), on `first.length` `0 !== 11`, or on an empty signature list.
- The output ends with `11 FAILED` and `exit=1`.

- [ ] **Step 4: Implement steps 6–8 in the importer**

In `O/scripts/import-sidon-marina.js`, insert directly above `async function importSidon(`:

```js
// ---- importSidon steps 6-8: bookings, occupancy, signatures (R13, R15, R16) ----

// One row under its own savepoint: an exclusion violation (23P01, an
// overlapping live stay on the berth) skips just that row instead of
// aborting the whole run's transaction. Any other error still aborts.
async function insertOrOverlap(dst, sql, params) {
  await dst.query('SAVEPOINT b');
  try {
    await dst.query(sql, params);
    await dst.query('RELEASE SAVEPOINT b');
    return true;
  } catch (err) {
    if (err.code !== '23P01') throw err;
    await dst.query('ROLLBACK TO SAVEPOINT b');
    return false;
  }
}

// Returns Map<Sidon booking id, ImportedBooking> for signatures (here) and
// documents (step 9). Everything is looked up through the deterministic ids
// step 4 wrote, so this needs no in-memory maps from the catalogue steps.
async function importBookings(dst, source, plan, report, opts) {
  const now = opts.now ?? new Date();
  const owners = new Map(plan.owners.map((o) => [o.owner_id, o]));
  // Re-keyed owners' rows are counted under their target (R13).
  const counts = (ownerId) => report.marinas.find((m) => m.alias === alias(ownerId)).counts;
  const targets = new Map();
  const target = async (ownerId) => {
    if (!targets.has(ownerId)) {
      const marinaId = uid('marina', ownerId);
      const { rows: [m] } = await dst.query(
        'SELECT m.property_id, upper(p.currency) AS currency FROM marina m JOIN property p ON p.id = m.property_id WHERE m.id = $1',
        [marinaId]);
      const { rows } = await dst.query('SELECT id, label FROM marina_berth WHERE marina_id = $1', [marinaId]);
      targets.set(ownerId, {
        marina_id: marinaId, property_id: m.property_id, currency: m.currency,
        // "Today" is the target property's own calendar day (Pacific/Tahiti
        // can be a day behind UTC), never the server's.
        today: await propertyToday(dst, m.property_id),
        drop: owners.get(ownerId).prices === 'drop',
        berths: new Map(rows.map((r) => [r.label, r.id])),
      });
    }
    return targets.get(ownerId);
  };

  // Step 6: Source.bookings is already in created_at, id order, so the
  // later of an overlapping pair is the one skipped.
  const imported = new Map();
  for (const b of source.bookings) {
    const o = owners.get(b.owner_id);
    if (!o || o.action === 'skip') continue;
    const targetOwner = o.action === 'rekey' ? o.rekey_to : o.owner_id;
    const t = await target(targetOwner);
    const c = counts(targetOwner);
    const berthId = t.berths.get(b.berth_id);
    if (!berthId) { c.bookings_no_berth += 1; continue; }
    const mapped = mapBookingStatus(b, t.today, now);
    if (!mapped) { report.warnings.push(`${alias(b.owner_id)}: a booking with an unknown status was skipped`); continue; }
    const email = cleanEmail(b.sailor_email);
    const id = uid('booking', b.id);
    const ok = await insertOrOverlap(dst,
      `INSERT INTO marina_booking (id, property_id, marina_id, berth_id, contact_name, contact_email, contact_email_key,
         boat_name, boat_length_m, boat_beam_m, arrival, departure, status, cancel_reason, source, locale,
         total_price, currency, payment_status, legacy_payment_intent_id, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, round($9::numeric, 2), round($10::numeric, 2), $11, $12, $13, $14,
         'import', 'en', $15, $16, 'none', $17, $18, $19, $20)`,
      [id, t.property_id, t.marina_id, berthId, b.sailor_name, email, emailKey(email),
        b.boat_name, b.boat_loa, b.boat_beam, b.arrival_date, b.departure_date, mapped.status, mapped.cancel_reason,
        // drop_prices: the Sidon number is in the marina's currency, not the property's (Review Focus 1).
        b.amount_cents == null || t.drop ? null : b.amount_cents / 100, t.currency,
        b.payment_intent_id, b.notes, b.created_at, b.updated_at]);
    if (!ok) { c.bookings_overlap += 1; continue; }
    c.bookings += 1;
    if (b.status === 'pending' && mapped.cancel_reason === 'expired') c.pending_expired += 1;
    if (email === null) c.emails_nulled += 1;
    imported.set(b.id, { id, owner_id: targetOwner, property_id: t.property_id, marina_id: t.marina_id,
      status: mapped.status, cancel_reason: mapped.cancel_reason, departure: b.departure_date,
      updated_at: b.updated_at, today: t.today, email });
  }

  // Step 7: Sidon kept manual occupancy on the berth; OTA only has bookings,
  // so each still-occupied berth becomes an open-ended stay from today (R16).
  for (const s of source.berths) {
    if (s.status !== 'occupied' && s.status !== 'reserved') continue;
    const o = owners.get(s.owner_id);
    if (!o || o.action !== 'import') continue;
    const t = await target(s.owner_id);
    const berthId = uid('berth', s.id);
    const { rows: [r] } = await dst.query(
      `SELECT EXISTS (SELECT 1 FROM marina_berth WHERE id = $1) AS imported,
              EXISTS (SELECT 1 FROM marina_booking WHERE berth_id = $1 AND status IN ('hold', 'pending', 'confirmed')
                        AND daterange(arrival, departure) @> $2::date) AS covered`,
      [berthId, t.today]);
    if (!r.imported || r.covered) continue;
    const ok = await insertOrOverlap(dst,
      `INSERT INTO marina_booking (id, property_id, marina_id, berth_id, contact_name, arrival, departure, status,
         source, locale, total_price, currency, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'confirmed', 'import', 'en', NULL, $7, 'none')`,
      [uid('occupancy', s.id), t.property_id, t.marina_id, berthId,
        (s.guest_name || '').trim().slice(0, 100) || 'Reserved', t.today, t.currency]);
    counts(s.owner_id)[ok ? 'occupancy' : 'occupancy_overlap'] += 1;
  }

  // Step 8: only for bookings imported above ("skipped with their booking").
  // The template is NULL when it wasn't imported (e.g. a re-keyed owner's,
  // when the target already had one).
  for (const s of source.signatures) {
    const b = imported.get(s.booking_id);
    if (!b) continue;
    // Sidon has no one-signature-per-booking rule; OTA does (UNIQUE booking_id).
    const { rowCount } = await dst.query(
      `INSERT INTO marina_contract_signature (id, property_id, booking_id, template_id, rendered_body, signer_email,
         agreed_at, ip_address, user_agent)
       VALUES ($1, $2, $3, (SELECT id FROM marina_contract_template WHERE id = $4), $5, $6, $7, $8, $9)
       ON CONFLICT (booking_id) DO NOTHING`,
      [uid('signature', s.id), b.property_id, b.id, uid('template', s.template_id), s.rendered_body, b.email,
        s.signed_at, s.ip_address, s.user_agent]);
    counts(b.owner_id).signatures += rowCount;
  }
  return imported;
}
```

Then, inside `importSidon`, insert directly above its final `return report;`:

```js
  // Steps 6-8; step 9 (documents) classifies each Sidon document by `imported`.
  const imported = await importBookings(dst, source, plan, report, opts);
```

- [ ] **Step 5: Run the checks again**

```bash
cd /c/Users/robert/source/repos/OTA && node --check scripts/import-sidon-marina.js && node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"
```

Expected: every line is `ok   …`, including the eleven `T3` lines, and the output ends with `all passed` and `exit=0`.

At this point `imported` is assigned but not yet read. Task 4 reads it, and no linter runs on `scripts/`.

- [ ] **Step 6: Run the other O gates**

```bash
cd /c/Users/robert/source/repos/OTA && set -o pipefail && node -r dotenv/config scripts/check-marina.js | tail -1 && node -r dotenv/config scripts/check-marina-http.js | tail -1
```

Expected: both print `all passed`. The importer is not loaded by either, so they confirm nothing else moved.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/robert/source/repos/OTA && git add scripts/import-sidon-marina.js scripts/check-import-sidon.js && git commit -F - <<'EOF'
Sidon import: bookings, occupancy and contract signatures

Steps 6-8 of importSidon. Bookings go in created_at order, each under its
own savepoint. Overlaps (23P01) and berth-less bookings are skipped and
counted. Expired pending bookings become cancelled/'expired', and invalid
emails become NULL. Bookings carry the property's currency, with
total_price NULL under drop_prices. A re-keyed owner's bookings land on
the target's berths. A berth still occupied or reserved in Sidon becomes
an open-ended confirmed booking from the property's today. Signatures are
imported for imported bookings only. Ids are derived from Sidon ids, so
booking tokens stay the same across re-runs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git -C /c/Users/robert/source/repos/OTA log --oneline -1
```

Expected: one new commit on `main`, which changes only those two paths. Do not push it (R5): the runbook decides when `main` is pushed.

---

### Task 4: Importer documents, images, archive, messages and the full report (O main)

Repo: `O` = `C:/Users/robert/source/repos/OTA`, branch `main`. Commands are Git Bash and run from `O`. Tasks 1–3 created `scripts/import-sidon-marina.js` and `scripts/check-import-sidon.js`, so this task finds its edit points by the contract's fixed signatures and the check marker, not by line numbers.

**Files:**
- Modify: `C:/Users/robert/source/repos/OTA/scripts/import-sidon-marina.js`. There are four anchor edits:
  - the declaration line `async function importSidon(dst, source, plan, opts) {` (renamed);
  - the declaration line `function formatReport(report) {` (renamed);
  - a new block inserted directly above `module.exports = {`;
  - the `module.exports` object (three names added).
- Modify: `C:/Users/robert/source/repos/OTA/scripts/check-import-sidon.js`. One block goes directly above the line `// (later tasks append checks here)`.
- No other files. No migration, because `marina_document`/`marina_image` already have every column used.

**Interfaces:**
- Consumes:
  - Task 1 (same file): `alias(ownerId)`, `uid(table, id)`, `insideRetention(b, today, now)`, `readSource(src, schema)`, `readTargets(dst, source, map)`, `planMapping(source, map, targets)`, `formatReport(report)`, and the module object `docs = require('../src/lib/marinaDocuments')` (its `store.put`, `putPublic` and `sniffType`).
  - Task 1 check harness: `db` (one `pg.Client` inside `BEGIN`), `check(name, fn)` (a `SAVEPOINT c` per check), the `sidon_fixture` tables with exactly the `Source` column lists, and the marker `// (later tasks append checks here)`.
  - Task 2: `importSidon` steps 1–5. Each importing owner's marina is `uid('marina', owner_id)` with `sidon_owner_id` set. Requirements are inserted with `id = uid('requirement', id)`. `marina_image` rows are inserted with `id = uid('image', id)` and `url` = the Sidon URL. `Report.properties[]` (`property_id`, `today`, `created`), `Report.marinas[]` (`alias`, `slug`, `counts`) and `Report.warnings` are built.
  - Task 3: steps 6–8. Imported bookings are `marina_booking.id = uid('booking', id)` with the mapped `status`, `departure` and the preserved `updated_at`.
- Produces (contract names):
  - `sourcePath(fileUrl)`, `extOf(path)`, `typeFromExt(ext)`, exported.
  - `importSidon(dst, source, plan, opts)` now runs Task 2–3's work (renamed `importCore`) and then `importFiles` (contract steps 9–10, plus the image re-hosting).
  - It fills `MarinaCounts.documents_copied | documents_not_copied | documents_sailor_docs | documents_fetch_failed`, `Report.archived: string[]`, `Report.sailor_docs_unlinked` and `Report.messages_exported`.
  - `formatReport(report)` now ends with a files section: aliases, slugs, counts and paths only.
  - Blob paths:
    - `marina-docs/{property_id}/{booking_id}/sidon-{id}.{ext}`
    - `marina-docs-archive/sidon/{alias}/{id}.{ext}`
    - `marina-archive/messages-{alias}.json`
    - `marina-images/{property_id}/{marina_id}.{ext}` (through `putPublic`)

- [ ] **Step 1: Preconditions and anchors**

Run:
```bash
cd /c/Users/robert/source/repos/OTA && git status --short scripts/ && grep -c '^async function importSidon(dst, source, plan, opts) {$' scripts/import-sidon-marina.js && grep -c '^function formatReport(report) {$' scripts/import-sidon-marina.js && grep -n "require('../src/lib/marinaDocuments')" scripts/import-sidon-marina.js && grep -c '^module.exports = {' scripts/import-sidon-marina.js && grep -c '// (later tasks append checks here)' scripts/check-import-sidon.js
```
Expected: no `git status` lines (Tasks 1–3 are committed), then `1`, `1`, a single line `N:const docs = require('../src/lib/marinaDocuments');`, then `1`, `1`. If the `docs` line is missing, add `const docs = require('../src/lib/marinaDocuments');` after the file's other `require` lines. Any other mismatch: stop and report, because Tasks 1–3 deviate from the contract.

Check that the names this task adds are free:
```bash
cd /c/Users/robert/source/repos/OTA && grep -nE '\b(importCore|importFiles|formatCoreReport|formatFiles|extractedJson|defaultFetchBlob|TYPE_BY_EXT|sourcePath|extOf|typeFromExt)\b' scripts/import-sidon-marina.js; echo "exit=$?"
```
Expected: no matches, `exit=1`.

Baseline: `node -r dotenv/config scripts/check-import-sidon.js` → every line `ok …`, last line `all passed`.

- [ ] **Step 2: Write the failing checks**

In `scripts/check-import-sidon.js`, insert this block directly above the line `// (later tasks append checks here)`. It is a block of its own (`{ … }`), so its names can't collide with Task 1–3 declarations. It also uses its own source schema, `sidon_docs`, built `LIKE` the `sidon_fixture` tables, so these rows don't change the counts that earlier checks assert.

```js
    // ---- Task 4: documents, images, archive, messages, report ----
    {
      const { alias, uid, readSource, readTargets, planMapping, importSidon, formatReport, sourcePath, extOf, typeFromExt } = require('./import-sidon-marina');
      const blobSeam = require('../src/lib/marinaDocuments');
      // Own source schema with sidon_fixture's exact column types, so these
      // documents don't disturb what the earlier checks count.
      const S = 'sidon_docs';
      const A = 'org_docsCheckA1';  // imported into a created property
      const SK = 'org_docsCheckS2'; // skipped: its marina-docs go to the archive
      const STORE = 'https://sidonstore.public.blob.vercel-storage.com/';
      const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      await db.query(`CREATE SCHEMA ${S}`);
      for (const t of ['marina_profile', 'marina_layout', 'marina_overlay', 'marina_berth', 'marina_price_tier', 'berth_booking',
        'marina_doc_requirement', 'marina_document', 'marina_contract_template', 'marina_contract_signature', 'marina_poi', 'marina_image', 'marina_message']) {
        await db.query(`CREATE TABLE ${S}.${t} (LIKE sidon_fixture.${t})`);
      }
      await db.query(
        `INSERT INTO ${S}.marina_profile (owner_id, slug, name, lat, lng, description, phone, email, website, response_window_hours, currency, updated_at)
         VALUES ($1, 'docs-check', 'Docs Check Harbour', 43.1, 9.5, '', '', 'harbour@docs-check.example', '', 24, 'eur', now()),
                ($2, 'docs-skip', 'Docs Skip Harbour', 43.2, 9.6, '', '', 'skip@docs-check.example', '', 24, 'eur', now())`, [A, SK]);
      await db.query(
        `INSERT INTO ${S}.marina_berth (id, owner_id, berth_id, overlay_id, lat, lng, length_m, min_length_m, beam_m, depth_m, status, guest_name, notes, price_per_night, price_mode, rotation)
         VALUES (1, $1, 'D1', NULL, 43.1, 9.5, 12, NULL, 4, 3, 'available', NULL, NULL, 50, 'fixed', 0),
                (2, $1, 'D2', NULL, 43.1, 9.5, 12, NULL, 4, 3, 'available', NULL, NULL, 50, 'fixed', 0),
                (3, $2, 'S1', NULL, 43.2, 9.6, 12, NULL, 4, 3, 'available', NULL, NULL, 50, 'fixed', 0)`, [A, SK]);
      // Booking 1 departs in a week (inside retention), booking 2 departed
      // 200 days ago (outside), booking 10 belongs to the skipped owner.
      await db.query(
        `INSERT INTO ${S}.berth_booking (id, owner_id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, notes, status, payment_intent_id, amount_cents, expires_at, created_at, updated_at)
         VALUES (1, $1, 'D1', 'Ann Sailor', 'ann.sailor@docs-check.example', 'Docs One', 10, 3.5, $3, $4, NULL, 'confirmed', NULL, 10000, NULL, now(), now()),
                (2, $1, 'D2', 'Bob Mariner', 'bob.mariner@docs-check.example', 'Docs Two', 10, 3.5, $5, $6, NULL, 'confirmed', NULL, 10000, NULL, now() - interval '210 days', now() - interval '200 days'),
                (10, $2, 'S1', 'Cy Skipper', 'cy.skipper@docs-check.example', 'Docs Skip', 10, 3.5, $3, $4, NULL, 'confirmed', NULL, 10000, NULL, now(), now())`,
        [A, SK, day(5), day(8), day(-205), day(-200)]);
      await db.query(
        `INSERT INTO ${S}.marina_doc_requirement (id, owner_id, type, name, description, schema, mandatory, sort_order)
         VALUES (1, $1, 'insurance', 'Insurance', '', '[{"name":"policy_number","label":"Policy number","type":"string"}]', 1, 0)`, [A]);
      const doc = (id, owner, booking, path, extracted = '{}', expiry = null, requirement = 1) => db.query(
        `INSERT INTO ${S}.marina_document (id, owner_id, requirement_id, booking_id, status, notes, submitted_at, verified_at, type, file_url, file_name, extracted_data, expiry_date)
         VALUES ($1, $2, $3, $4, 'pending', '', now(), NULL, 'insurance', $5, $6, $7, $8)`,
        [id, owner, requirement, booking, STORE + path, path.split('/').pop(), extracted, expiry]);
      await doc(1, A, 1, `marina-docs/${A}/1/1700000000001.PDF`, '{"policy_number":"P-1"}', '2027-03-31T00:00:00Z'); // linked, inside retention -> copied
      await doc(2, A, 2, `marina-docs/${A}/1/1700000000002.jpg`, '');                                            // linked, outside retention
      await doc(3, A, 1, 'sailor-docs/guest/5/passport/scan%20one.png', 'not json', null, 99);                    // linked wallet file, dangling requirement
      await doc(4, A, null, `marina-docs/${A}/1/1700000000004.pdf`);                                              // unlinked -> archive
      await doc(5, SK, 10, `marina-docs/${SK}/1/1700000000005.png`);                                              // skipped owner's booking -> archive
      await doc(6, A, null, 'sailor-docs/guest/6/insurance/wallet.pdf');                                          // unlinked wallet file -> counted only
      await doc(7, A, 1, `marina-docs/${A}/1/broken.pdf`);                                                        // fetch throws
      await doc(8, A, 1, `marina-docs/${A}/1/notpdf.pdf`);                                                        // bytes don't sniff
      await doc(9, A, null, `marina-docs/${A}/1/broken-orphan.pdf`);                                              // archive fetch throws
      await db.query(`INSERT INTO ${S}.marina_image (id, owner_id, url, description, sort_order, created_at) VALUES (1, $1, $2, 'Pontoon D', 0, now())`,
        [A, `${STORE}marina/${A}/1700000000000.webp`]);
      await db.query(
        `INSERT INTO ${S}.marina_message (id, owner_id, sailor_id, enquiry_cookie_hash, sailor_email, sailor_name, direction, body, created_at, read_at)
         VALUES (1, $1, NULL, 'h1', 'ann.sailor@docs-check.example', 'Ann Sailor', 'sailor', 'Is D1 free?', now(), NULL),
                (2, $1, NULL, 'h1', 'ann.sailor@docs-check.example', 'Ann Sailor', 'marina', 'Yes.', now(), NULL),
                (3, $2, NULL, 'h2', 'dee.sailor@docs-check.example', 'Dee Sailor', 'sailor', 'Hello', now(), NULL)`, [A, SK]);
      const PII = [A, SK, 'harbour@docs-check.example', 'skip@docs-check.example', 'ann.sailor@docs-check.example', 'bob.mariner@docs-check.example',
        'cy.skipper@docs-check.example', 'dee.sailor@docs-check.example', 'Ann Sailor', 'Bob Mariner', 'Cy Skipper', 'Dee Sailor'];
      const docsMap = { owners: {
        [A]: { action: 'create', name: 'Docs Check Property', timezone: 'UTC', clerk_org_id: 'org_check_import_docs' },
        [SK]: { action: 'skip', reason: 'check' },
      } };
      // Blob seams swapped on the module object, the same way the importer
      // calls them. fetchBlob records every URL it is asked for.
      const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
      const stubs = () => {
        const s = { blobs: new Map(), publics: [], fetched: [], calls: 0 };
        blobSeam.store = { put: async (p, buf, type) => { s.calls++; s.blobs.set(p, { buf, type }); }, get: async () => null, del: async () => {} };
        blobSeam.putPublic = async (p, buf, type) => { s.calls++; s.publics.push([p, type]); return 'https://public.example/' + p; };
        s.fetchBlob = async (url) => {
          s.calls++; s.fetched.push(url);
          if (url.includes('broken')) throw new Error('fetch failed');
          if (url.endsWith('.webp')) return { buf: WEBP, contentType: 'image/webp' };
          if (url.includes('notpdf')) return { buf: Buffer.from('not a pdf'), contentType: 'application/pdf' };
          return { buf: Buffer.from('%PDF-1.4 check'), contentType: 'application/pdf' };
        };
        return s;
      };
      // Each run reads targets afresh, so a second run finds the created
      // property through Targets.reruns.
      const runDocs = async (files, s) => {
        const source = await readSource(db, S);
        const plan = planMapping(source, docsMap, await readTargets(db, source, docsMap));
        return importSidon(db, source, plan, { mode: 'commit', target: 'local', files, fetchBlob: s.fetchBlob });
      };
      const docRows = async () => (await db.query(
        `SELECT id, blob_pathname, content_type, size_bytes, file_deleted_at IS NOT NULL AS deleted, requirement_id, extracted_data, expiry_date
           FROM marina_document WHERE marina_id = $1 ORDER BY blob_pathname`, [uid('marina', A)])).rows;
      const countsOf = (report) => {
        const c = report.marinas.find((m) => m.alias === alias(A)).counts;
        return [c.documents_copied, c.documents_not_copied, c.documents_sailor_docs, c.documents_fetch_failed];
      };
      const archiveExpected = [`marina-docs-archive/sidon/${alias(A)}/4.pdf`, `marina-docs-archive/sidon/${alias(A)}/9.pdf`, `marina-docs-archive/sidon/${alias(SK)}/5.png`].sort();
      const imageUrl = async () => (await db.query('SELECT url FROM marina_image WHERE id = $1', [uid('image', 1)])).rows[0].url;

      await check('sourcePath, extOf and typeFromExt edges', async () => {
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/marina-docs/org_x/3/1700000000000.pdf'), 'marina-docs/org_x/3/1700000000000.pdf');
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/sailor-docs/guest/5/passport/scan%20one.PNG'), 'sailor-docs/guest/5/passport/scan one.PNG');
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/marina/x/a.webp?download=1'), 'marina/x/a.webp');
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/bad%E0'), null); // malformed escape
        assert.equal(sourcePath(null), null);
        assert.equal(sourcePath('  '), null);
        assert.equal(sourcePath('not a url'), null);
        assert.equal(extOf('sailor-docs/guest/5/passport/scan one.PNG'), 'png');
        assert.equal(extOf('marina-docs/org_x/3/noext'), 'bin');
        assert.equal(extOf('marina-docs/v1.2/noext'), 'bin'); // a dot in a folder is not an extension
        assert.equal(extOf('a/file.'), 'bin');
        assert.equal(extOf(null), 'bin');
        assert.equal(typeFromExt('pdf'), 'application/pdf');
        assert.equal(typeFromExt('jpg'), 'image/jpeg');
        assert.equal(typeFromExt('jpeg'), 'image/jpeg');
        assert.equal(typeFromExt('png'), 'image/png');
        assert.equal(typeFromExt('webp'), 'application/octet-stream');
        assert.equal(typeFromExt('bin'), 'application/octet-stream');
        assert.equal(typeFromExt('toString'), 'application/octet-stream'); // no prototype lookups
      });

      await check('documents: in-retention marina-docs copied; out-of-retention, failed and sailor-docs rows not copied; sailor-docs never fetched', async () => {
        const s = stubs();
        const report = await runDocs(true, s);
        const P = report.properties[0].property_id;
        const path = (b, d, ext) => `marina-docs/${P}/${uid('booking', b)}/sidon-${d}.${ext}`;
        const rows = new Map((await docRows()).map((r) => [r.id, r]));
        assert.deepEqual([...rows.keys()].sort(), [1, 2, 3, 7, 8].map((d) => uid('document', d)).sort());
        assert.deepEqual({ ...rows.get(uid('document', 1)) }, {
          id: uid('document', 1), blob_pathname: path(1, 1, 'pdf'), content_type: 'application/pdf', size_bytes: 14, deleted: false,
          requirement_id: uid('requirement', 1), extracted_data: { policy_number: 'P-1' }, expiry_date: '2027-03-31',
        });
        assert.equal(s.blobs.get(path(1, 1, 'pdf')).type, 'application/pdf');
        for (const [d, b, ext, type] of [[2, 2, 'jpg', 'image/jpeg'], [3, 1, 'png', 'image/png'], [7, 1, 'pdf', 'application/pdf'], [8, 1, 'pdf', 'application/pdf']]) {
          const r = rows.get(uid('document', d));
          assert.deepEqual([r.blob_pathname, r.content_type, r.size_bytes, r.deleted], [path(b, d, ext), type, 0, true], `document ${d}`);
          assert.equal(s.blobs.has(path(b, d, ext)), false, `document ${d} stored`);
        }
        assert.equal(rows.get(uid('document', 3)).requirement_id, null); // Sidon requirement 99 was never imported
        assert.equal(rows.get(uid('document', 3)).extracted_data, null); // 'not json'
        assert.equal(rows.get(uid('document', 2)).extracted_data, null); // ''
        // Review Focus 4: the sidon-ai wallet is never even requested.
        assert.ok(s.fetched.length > 0);
        assert.deepEqual(s.fetched.filter((u) => (sourcePath(u) || '').startsWith('sailor-docs/')), []);
        assert.ok(!s.fetched.some((u) => u.includes('1700000000002')), 'out-of-retention file fetched');
        assert.deepEqual(countsOf(report), [1, 3, 1, 2]);
        assert.equal(report.sailor_docs_unlinked, 1);
      });

      await check('archive paths for unlinked marina-docs, messages export by alias, webp image via putPublic', async () => {
        const s = stubs();
        const report = await runDocs(true, s);
        const P = report.properties[0].property_id;
        assert.deepEqual([...report.archived].sort(), archiveExpected);
        assert.equal(s.blobs.get(`marina-docs-archive/sidon/${alias(A)}/4.pdf`).type, 'application/pdf');
        assert.equal(s.blobs.has(`marina-docs-archive/sidon/${alias(SK)}/5.png`), true);
        assert.equal(s.blobs.has(`marina-docs-archive/sidon/${alias(A)}/9.pdf`), false); // fetch failed: listed and warned, not stored
        assert.ok(report.warnings.some((w) => w.includes(`marina-docs-archive/sidon/${alias(A)}/9.pdf`)));
        const msgs = s.blobs.get(`marina-archive/messages-${alias(A)}.json`);
        assert.equal(msgs.type, 'application/json');
        assert.deepEqual(JSON.parse(msgs.buf.toString()).map((m) => m.id).sort(), [1, 2]);
        assert.equal(s.blobs.has(`marina-archive/messages-${alias(SK)}.json`), true); // skipped owners' messages too
        assert.equal(report.messages_exported, 3);
        assert.ok(![...s.blobs.keys()].some((p) => p.includes(A) || p.includes(SK)), 'owner id in a blob path');
        const imgPath = `marina-images/${P}/${uid('marina', A)}.webp`;
        assert.deepEqual(s.publics, [[imgPath, 'image/webp']]);
        assert.equal(await imageUrl(), 'https://public.example/' + imgPath);
      });

      await check('formatReport lists files by alias and path, with no emails, names or owner ids', async () => {
        const out = formatReport(await runDocs(true, stubs()));
        for (const p of archiveExpected) assert.ok(out.includes(p), `missing ${p}`);
        assert.match(out, /messages exported 3/);
        assert.match(out, /sailor-docs unlinked \(not read\) 1/);
        assert.ok(PII.every((x) => !out.includes(x)), 'report leaks fixture personal data or an owner id');
      });

      await check('a second run writes the same private-store pathnames and archive paths', async () => {
        const s1 = stubs();
        const r1 = await runDocs(true, s1);
        const rows1 = await docRows();
        const s2 = stubs();
        const r2 = await runDocs(true, s2);
        const rows2 = await docRows();
        assert.equal(s1.blobs.size, 5); // document 1, archive 4 and 5, two message exports
        assert.equal(r2.properties[0].created, false);
        assert.deepEqual([...s2.blobs.keys()].sort(), [...s1.blobs.keys()].sort());
        assert.deepEqual([...r2.archived].sort(), [...r1.archived].sort());
        assert.deepEqual(rows2.map((r) => [r.id, r.blob_pathname]), rows1.map((r) => [r.id, r.blob_pathname]));
        // Public image URLs are allowed to differ per run (putPublic adds a random suffix).
      });

      await check('files:false makes no fetch, store, putPublic or export call; rows otherwise the same', async () => {
        const s = stubs();
        const report = await runDocs(false, s);
        assert.equal(s.calls, 0);
        const P = report.properties[0].property_id;
        const rows = await docRows();
        assert.equal(rows.length, 5);
        assert.ok(rows.every((r) => r.deleted && r.size_bytes === 0));
        const d1 = rows.find((r) => r.id === uid('document', 1));
        assert.deepEqual([d1.blob_pathname, d1.content_type], [`marina-docs/${P}/${uid('booking', 1)}/sidon-1.pdf`, 'application/pdf']);
        assert.deepEqual([...report.archived].sort(), archiveExpected); // would-be paths
        assert.equal(report.messages_exported, 0);
        assert.deepEqual(countsOf(report), [0, 4, 1, 0]);
        assert.equal(await imageUrl(), `${STORE}marina/${A}/1700000000000.webp`);
      });
    }

```

- [ ] **Step 3: Run the checks and watch the Task 4 ones fail**

Run: `node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"`

Expected: every Task 1–3 line is still `ok …`. Then:
```
FAIL sourcePath, extOf and typeFromExt edges
     TypeError: sourcePath is not a function
FAIL documents: in-retention marina-docs copied; out-of-retention, failed and sailor-docs rows not copied; sailor-docs never fetched
     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
FAIL archive paths for unlinked marina-docs, messages export by alias, webp image via putPublic
     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
FAIL formatReport lists files by alias and path, with no emails, names or owner ids
     AssertionError [ERR_ASSERTION]: missing marina-docs-archive/sidon/o_…
FAIL a second run writes the same private-store pathnames and archive paths
     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
FAIL files:false makes no fetch, store, putPublic or export call; rows otherwise the same
     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

6 FAILED
exit=1
```
(Each FAIL is followed by its stack. The `o_…` alias is the 6-hex alias of `org_docsCheckA1` or `org_docsCheckS2`. An error at `CREATE TABLE sidon_docs.… (LIKE sidon_fixture.…)` means Task 1's fixture table names differ from the contract: stop and report.)

- [ ] **Step 4: Rename the two contract functions so they can be wrapped**

In `scripts/import-sidon-marina.js`, old:
```js
async function importSidon(dst, source, plan, opts) {
```
new:
```js
async function importCore(dst, source, plan, opts) {
```
Old:
```js
function formatReport(report) {
```
new:
```js
function formatCoreReport(report) {
```
Leave both bodies unchanged. The new `importSidon`/`formatReport` below call them, so the CLI and Task 1–3 checks keep calling the same names.

- [ ] **Step 5: Add steps 9–10, the helpers and the report section**

Insert this block directly above the line `module.exports = {` (function declarations are hoisted, so the CLI block can sit above or below it):

```js
// ---- Steps 9-10: documents, images, the archive and messages ----

const TYPE_BY_EXT = new Map([['pdf', 'application/pdf'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png']]);

// Sidon file_url values are full public-store URLs. The path inside the
// store (marina-docs/, sailor-docs/, marina/) decides what the import does.
function sourcePath(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.trim()) return null;
  try { return decodeURIComponent(new URL(fileUrl).pathname.slice(1)) || null; } catch { return null; }
}

// The extension lands in a blob pathname, so anything unusual becomes 'bin'.
function extOf(path) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(path ?? '').split('/').pop());
  return m ? m[1].toLowerCase() : 'bin';
}

// For rows whose bytes are never read (G4): the type the file name claims.
// A Map, so 'toString' and friends can't hit Object.prototype.
function typeFromExt(ext) {
  return TYPE_BY_EXT.get(ext) || 'application/octet-stream';
}

// Sidon keeps extracted_data as JSON text; blank or broken text -> NULL.
// Re-stringified so pg sends arrays as JSON, not as a Postgres array.
function extractedJson(text) {
  try { return text && String(text).trim() ? JSON.stringify(JSON.parse(text)) : null; } catch { return null; }
}

// Every Sidon URL is on a public store, so no token is needed.
async function defaultFetchBlob(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

async function importSidon(dst, source, plan, opts) {
  const report = await importCore(dst, source, plan, opts); // steps 1-8
  await importFiles(dst, source, plan, opts, report);       // steps 9-10
  return report;
}

// "Linked" means its booking was imported by step 6 of THIS run. That is
// read back from the transaction, so overlap/no-berth skips and skipped
// owners' bookings are simply absent. Every blob call sits behind
// opts.files, so --no-files writes the same rows and touches no store.
async function importFiles(dst, source, plan, opts, report) {
  const { files } = opts;
  const fetchBlob = opts.fetchBlob || defaultFetchBlob;
  const now = opts.now || new Date();
  const importing = plan.owners.filter((o) => o.action === 'import');
  const ownerIds = importing.map((o) => o.owner_id);
  const today = new Map(report.properties.map((p) => [p.property_id, p.today]));
  const counts = new Map();
  for (const o of importing) {
    const c = report.marinas.find((m) => m.alias === o.alias).counts;
    Object.assign(c, { documents_copied: 0, documents_not_copied: 0, documents_sailor_docs: 0, documents_fetch_failed: 0 });
    counts.set(uid('marina', o.owner_id), c); // re-keyed bookings already sit under their target marina
  }
  Object.assign(report, { archived: [], sailor_docs_unlinked: 0, messages_exported: 0 });

  const { rows: booked } = await dst.query(
    `SELECT mb.id, mb.property_id, mb.marina_id, mb.status, mb.departure, mb.updated_at
       FROM marina_booking mb JOIN marina m ON m.id = mb.marina_id
      WHERE mb.id = ANY($1) AND m.sidon_owner_id = ANY($2)`,
    [source.bookings.map((b) => uid('booking', b.id)), ownerIds]);
  const bookings = new Map(booked.map((b) => [b.id, b]));
  const { rows: reqRows } = await dst.query(
    `SELECT r.id FROM marina_doc_requirement r JOIN marina m ON m.id = r.marina_id
      WHERE r.id = ANY($1) AND m.sidon_owner_id = ANY($2)`,
    [source.requirements.map((r) => uid('requirement', r.id)), ownerIds]);
  const reqs = new Set(reqRows.map((r) => r.id));

  for (const d of source.documents) {
    const p = sourcePath(d.file_url);
    const ext = extOf(p);
    const b = d.booking_id == null ? undefined : bookings.get(uid('booking', d.booking_id));
    if (!b) {
      // Unlinked. Sidon's own guest uploads go to the private archive
      // (retentionOnce purges it after 90 days). sailor-docs/* is sidon-ai's
      // wallet: counted, never read.
      if (!p?.startsWith('marina-docs/')) { report.sailor_docs_unlinked += 1; continue; }
      const path = `marina-docs-archive/sidon/${alias(d.owner_id)}/${d.id}.${ext}`;
      report.archived.push(path);
      if (files) {
        const got = await fetchBlob(d.file_url).catch(() => null);
        if (got) await docs.store.put(path, got.buf, got.contentType || typeFromExt(ext));
        else report.warnings.push(`archive copy failed: ${path}`);
      }
      continue;
    }
    const c = counts.get(b.marina_id);
    const pathname = `marina-docs/${b.property_id}/${b.id}/sidon-${d.id}.${ext}`;
    let copied = null;
    if (!p?.startsWith('marina-docs/')) c.documents_sailor_docs += 1; // G4: never fetched
    else if (!files || !insideRetention(b, today.get(b.property_id), now)) c.documents_not_copied += 1;
    else {
      const got = await fetchBlob(d.file_url).catch(() => null);
      const type = got && docs.sniffType(got.buf);
      if (type) {
        await docs.store.put(pathname, got.buf, type);
        copied = { type, size: got.buf.length };
        c.documents_copied += 1;
      } else {
        c.documents_fetch_failed += 1;
        c.documents_not_copied += 1;
      }
    }
    const req = uid('requirement', d.requirement_id);
    // Not-copied rows keep the would-be pathname (NOT NULL) with the file
    // marked deleted, so staff see the document and that its file is gone.
    await dst.query(
      `INSERT INTO marina_document (id, property_id, marina_id, booking_id, requirement_id, type, blob_pathname, file_name,
         content_type, size_bytes, extracted_data, expiry_date, status, notes, submitted_at, verified_at, file_deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $17::boolean THEN NULL ELSE now() END)`,
      [uid('document', d.id), b.property_id, b.marina_id, b.id, reqs.has(req) ? req : null, d.type, pathname, d.file_name,
        copied ? copied.type : typeFromExt(ext), copied ? copied.size : 0, extractedJson(d.extracted_data),
        d.expiry_date ? new Date(d.expiry_date).toISOString().slice(0, 10) : null, // stored at midnight UTC: the UTC date
        d.status, d.notes, d.submitted_at, d.verified_at, copied !== null]);
  }

  if (!files) return;

  // Images were inserted with the Sidon URL (step 4) and are re-hosted here,
  // so every blob call of the run sits behind opts.files. putPublic adds a
  // random suffix: each run gets new URLs and leaves the last run's copies
  // behind (accepted).
  const images = new Map(source.images.map((i) => [uid('image', i.id), i]));
  const { rows: imported } = await dst.query(
    `SELECT i.id, i.property_id, i.marina_id FROM marina_image i JOIN marina m ON m.id = i.marina_id
      WHERE i.id = ANY($1) AND m.sidon_owner_id = ANY($2)`, [[...images.keys()], ownerIds]);
  for (const row of imported) {
    const src = images.get(row.id);
    const got = await fetchBlob(src.url).catch(() => null);
    // Without a copy the row keeps the Sidon URL, which stays public.
    if (!got) { report.warnings.push(`image copy failed: ${alias(src.owner_id)} image ${src.id}`); continue; }
    const ext = extOf(sourcePath(src.url));
    const url = await docs.putPublic(`marina-images/${row.property_id}/${row.marina_id}.${ext}`, got.buf, got.contentType || typeFromExt(ext));
    await dst.query('UPDATE marina_image SET url = $1 WHERE id = $2', [url, row.id]);
  }

  // R17: messages are personal data with no OTA table. One private JSON per
  // owner, any action (skipped owners included), named by alias so the
  // path never shows an owner id.
  for (const [owner, rows] of Map.groupBy(source.messages, (m) => m.owner_id)) {
    await docs.store.put(`marina-archive/messages-${alias(owner)}.json`, Buffer.from(JSON.stringify(rows)), 'application/json');
    report.messages_exported += rows.length;
  }
}

// The files part of the report: counts, the archive's paths (alias + Sidon
// document id) and totals. No URLs, since Sidon URLs contain owner ids.
function formatFiles(report) {
  const lines = ['', `files${report.files ? '' : ' (--no-files: nothing fetched or stored; archive paths are would-be paths)'}`];
  for (const m of report.marinas) {
    const c = m.counts;
    lines.push(`  ${m.alias} ${m.slug}: documents copied ${c.documents_copied}, not copied ${c.documents_not_copied} (fetch failed ${c.documents_fetch_failed}), sailor-docs ${c.documents_sailor_docs}`);
  }
  lines.push(`  archived ${report.archived.length}:`, ...report.archived.map((p) => `    ${p}`));
  lines.push(`  sailor-docs unlinked (not read) ${report.sailor_docs_unlinked}`, `  messages exported ${report.messages_exported}`);
  return lines;
}

function formatReport(report) {
  return [formatCoreReport(report), ...formatFiles(report)].join('\n');
}
```

In `module.exports = { … }`, old:
```js
formatPlan, formatReport };
```
new:
```js
formatPlan, formatReport, sourcePath, extOf, typeFromExt };
```
(If Task 1 wrapped the object across lines, add `sourcePath, extOf, typeFromExt` after `formatReport` the same way. The final export list is the contract's.)

- [ ] **Step 6: Run the checks again**

Run: `node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"`

Expected: every line `ok …`, including:
```
ok   sourcePath, extOf and typeFromExt edges
ok   documents: in-retention marina-docs copied; out-of-retention, failed and sailor-docs rows not copied; sailor-docs never fetched
ok   archive paths for unlinked marina-docs, messages export by alias, webp image via putPublic
ok   formatReport lists files by alias and path, with no emails, names or owner ids
ok   a second run writes the same private-store pathnames and archive paths
ok   files:false makes no fetch, store, putPublic or export call; rows otherwise the same

all passed
exit=0
```
If a Task 1–3 check now fails, it called `importSidon` with `files: true` against fixture documents without the harness `fetchBlob` stub. Pass the harness stub there; never let a check reach the network.

- [ ] **Step 7: Other O gates**

Run:
```bash
cd /c/Users/robert/source/repos/OTA && set -o pipefail && node -r dotenv/config scripts/check-marina.js | tail -1 && node -r dotenv/config scripts/check-marina-http.js | tail -1
```
Expected: `all passed` twice. Neither script loads the importer, so this only confirms nothing else moved.

- [ ] **Step 8: Manual local rehearsal (not a gate; only if `SIDON_DATABASE_URL` is already in `O/.env`, added by hand, and `.superpowers/import-map.local.json` exists)**

Run: `cd /c/Users/robert/source/repos/OTA && node scripts/import-sidon-marina.js --dry-run --no-files`

This rolls back and makes no blob calls. Compare the printed report with the contract's "Expected live numbers", not survey §4's document columns:
- `documents_copied` 0 and `documents_not_copied` 0 on every marina;
- `documents_sailor_docs` summing to 383;
- `archived 32` (would-be paths, every one `marina-docs-archive/sidon/o_xxxxxx/<id>.<ext>`);
- `sailor-docs unlinked (not read) 169`;
- `messages exported 0` (41 only with files on, which is the runbook's live Step 4).

Also check that the output shows no email, name or raw owner id. Don't paste the output anywhere that is committed.

- [ ] **Step 9: Commit**

```bash
cd /c/Users/robert/source/repos/OTA && git add scripts/import-sidon-marina.js scripts/check-import-sidon.js && git commit -m "$(cat <<'EOF'
Sidon import: documents, images, archive and messages export

Steps 9-10 of importSidon. Linked marina-docs files inside retention are
copied to the private store; every other linked document is inserted
not-copied with its would-be path, and sailor-docs/* is never fetched.
Unlinked marina-docs go to marina-docs-archive/sidon/<alias>/, images are
re-hosted through putPublic with their own content type, and messages go
to one private JSON per owner alias. formatReport gains a files section
(aliases, counts and paths only).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: one new commit on O `main`, touching only those two files. Do not push. The runbook's Step 4 runs the importer live with files on.

---

### Task 5: Demo-seed slug option, widget tarball, and pirates-bight cutover/switch

This task touches two repos. In `O` it works on branch `main`; the change is safe at any time (R5). In `PB` = `C:/Users/robert/source/repos/pirates-bight` it works on new branch `cutover/switch`, cut from local `master` (R4). All commands are Git Bash. Nothing is pushed.

**Files:**
- O `main`, Modify: `C:/Users/robert/source/repos/OTA/scripts/seed-marina-demo.js`. The edits are the header comment (lines 1-7), a new `SLUG` block after line 12, the marina `put` key (line 80) and the `slug=` output line (line 123).
- Built, not committed: `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz`. Tasks 6–9 reuse it.
- PB `cutover/switch`:
  - Modify: `C:/Users/robert/source/repos/pirates-bight/package.json` (line 25: the widget range).
  - Create: `C:/Users/robert/source/repos/pirates-bight/src/pages/api/marina/guest/[...path].ts`
  - Create: `C:/Users/robert/source/repos/pirates-bight/src/pages/booking.astro`
  - Modify: `C:/Users/robert/source/repos/pirates-bight/src/components/MooringsWidget.astro` (lines 1-61: frontmatter and markup; the `<script>` at 63-84 is unchanged)
  - Modify: `C:/Users/robert/source/repos/pirates-bight/CLAUDE.md` (line 12: the sidon-ai moorings bullet)
  - Modify, only if Step 15 finds `/booking` in the sitemap: `C:/Users/robert/source/repos/pirates-bight/astro.config.mjs` (line 36, `sitemap()`). Today's sitemap lists the SSR page `/berths/`, so SSR routes are included and the filter is expected to be needed.
  - Never committed: `package-lock.json` (G6). Also not committed: `CLAUDE.local.md`, which is gitignored and holds local notes only.

**Interfaces:**
- Consumes:
  - From the contract: the widget-tarball recipe, the exact forwarder text, the booking-page shape, and the site verification procedure (slug `pirates-bight`, port 4400, scheme `http`).
  - `createMarinaProxy({ otaBaseUrl, keys })` from `@forgebuild/sidon-booking-widget/astro-proxy` (plan C 1.1.0).
  - OTA's guest routes: `GET /api/marina/guest/:slug`, and `POST /api/marina/guest/:slug/bookings` → `201 { booking: { id }, booking_token }`.
  - Rulings R21–R25 and gap fills G6, G7, G11 and G12.
- Produces:
  - `MARINA_DEMO_SLUG` on `O/scripts/seed-marina-demo.js`: `const SLUG = process.env.MARINA_DEMO_SLUG || 'demo-marina'`, validated against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. The output lines stay `api_key=<key>` and `slug=<slug>`. Tasks 6–9 consume this.
  - The tarball `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz`. Tasks 6–9 reuse it.
  - PB `cutover/switch`, which the runbook uses at Step 6:
    - It is pushed and merged there.
    - After `npm publish` the runbook runs `npm install` on it and commits the lockfile.
    - Vercel gets `OTA_BASE_URL` and `OTA_API_KEY` for Preview and Production, then a redeploy.
    - `booking_url` = `<origin>/booking?booking={id}&token={token}`.

- [ ] **Step 1: O — confirm the seed ignores `MARINA_DEMO_SLUG` today**

Run (from O; the key line is filtered out so it is never echoed):
```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | grep -v '^api_key='
```
Expected (FAIL: the slug is still the literal):
```
Marina Demo seeded (property <uuid>)
slug=demo-marina
```

- [ ] **Step 2: O — add `SLUG` to the seed**

`scripts/seed-marina-demo.js` lines 1-7. Old:
```js
// Seeds a local demo marina for the booking widget's demo page: property
// 'Marina Demo' (EUR, Europe/Rome, API key on) with marina demo-marina --
// one pontoon, six berths, a 12-month price tier, two document
// requirements and a contract. Safe to re-run: rows are matched on natural
// keys and updated in place, so ids (and any demo bookings, uploads and
// signatures on them) survive. Local DB only.
//   node scripts/seed-marina-demo.js
```
New:
```js
// Seeds a local demo marina for the booking widget's demo page: property
// 'Marina Demo' (EUR, Europe/Rome, API key on) with marina demo-marina (or
// MARINA_DEMO_SLUG) -- one pontoon, six berths, a 12-month price tier, two
// document requirements and a contract. Safe to re-run: rows are matched on
// natural keys and updated in place, so ids (and any demo bookings, uploads
// and signatures on them) survive. Local DB only.
//   node scripts/seed-marina-demo.js
//   MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js
```
After line 12 (the `refusing to run against a remote DB` guard), insert:
```js

// Consumer sites hard-code their own marina slug (pirates-bight,
// fox-mooring, ...), so a site is checked against local OTA by seeding the
// demo marina under that slug. Every slug shares the one 'Marina Demo'
// property, so they all answer to the same API key.
const SLUG = process.env.MARINA_DEMO_SLUG || 'demo-marina';
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(SLUG)) throw new Error(`MARINA_DEMO_SLUG must be a lower-case slug like pirates-bight (got ${JSON.stringify(SLUG)})`);
```
Line 80, old:
```js
  const M = await put(db, 'marina', { property_id: P, slug: 'demo-marina' }, {
```
New:
```js
  const M = await put(db, 'marina', { property_id: P, slug: SLUG }, {
```
Line 123, old:
```js
    console.log('slug=demo-marina');
```
New:
```js
    console.log(`slug=${SLUG}`);
```

- [ ] **Step 3: O — verify: rejects a bad slug, seeds under the new slug, idempotent, same key**

```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG='Pirates Bight' node scripts/seed-marina-demo.js; echo "exit=$?"
```
Expected: a stack trace whose first line is `Error: MARINA_DEMO_SLUG must be a lower-case slug like pirates-bight (got "Pirates Bight")`, then `exit=1`. Nothing is written, because the check runs before the DB connect.

```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | grep -v '^api_key=' && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | grep -v '^api_key=' && node scripts/seed-marina-demo.js | grep -v '^api_key='
```
Expected: three blocks with the same property id. The slug lines are `slug=pirates-bight`, `slug=pirates-bight` and `slug=demo-marina`.

```bash
cd /c/Users/robert/source/repos/OTA && A=$(MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); B=$(MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); C=$(node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); [ -n "$A" ] && [ "$A" = "$B" ] && [ "$A" = "$C" ] && echo "same key, prefix ${A:0:5}"
```
Expected: `same key, prefix prop_`.

```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config -e "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const {rows}=await c.query(\"SELECT m.slug, COUNT(b.id)::int AS berths FROM marina m JOIN property p ON p.id = m.property_id LEFT JOIN marina_berth b ON b.marina_id = m.id WHERE p.name = 'Marina Demo' GROUP BY m.slug ORDER BY m.slug\");console.log(rows);await c.end()})()"
```
Expected: `[ { slug: 'demo-marina', berths: 6 }, { slug: 'pirates-bight', berths: 6 } ]`. Re-running did not duplicate berths. Later site tasks add more slugs to this list.

- [ ] **Step 4: O — gates**

```bash
cd /c/Users/robert/source/repos/OTA && set -o pipefail && node -r dotenv/config scripts/check-marina.js | tail -n 1
cd /c/Users/robert/source/repos/OTA && set -o pipefail && node -r dotenv/config scripts/check-marina-http.js | tail -n 1
```
Expected: each prints `all passed`.

- [ ] **Step 5: O — commit on `main`**

```bash
git -C /c/Users/robert/source/repos/OTA add scripts/seed-marina-demo.js && git -C /c/Users/robert/source/repos/OTA commit -F - <<'EOF'
Demo seed: MARINA_DEMO_SLUG seeds the demo marina under a site's slug

Each consumer site hard-codes its own marina slug, so plan D checks a site
against local OTA by seeding the demo marina under that slug. Every slug
shares the one Marina Demo property and API key; the default stays
demo-marina.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
Expected: one commit on `main` touching only `scripts/seed-marina-demo.js`. The untracked `=` and `src/db/seed-extras.sql.pre-multi-property.bak` stay untracked.

- [ ] **Step 6: Prerequisite gate — widget 1.1.0, then the tarball**

```bash
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"
```
Expected: `1.1.0`. If it prints anything else, STOP here and report "plan C not done: W is <version>". Today it prints `1.0.0`. Steps 1–5 stand on their own and stay committed.

If `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz` already exists, skip the next command; it is built once per machine.
```bash
mkdir -p /c/tmp/plan-d && cd /c/Users/robert/source/repos/sidon-booking-widget && npm run build && npm pack --pack-destination /c/tmp/plan-d
```
Expected: the build passes and the last line is `forgebuild-sidon-booking-widget-1.1.0.tgz`. Then `ls /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz` lists the file.

- [ ] **Step 7: PB — clean tree and type-check baseline on `master`**

```bash
git -C /c/Users/robert/source/repos/pirates-bight status --short; git -C /c/Users/robert/source/repos/pirates-bight branch --show-current
```
Expected: no status lines, then `master`. If the tree is dirty, STOP and report.

```bash
cd /c/Users/robert/source/repos/pirates-bight && npx astro check 2>&1 | tail -n 4
```
Expected: a `Result (N files):` block. Record its `- X errors` count as the baseline. Step 14 must not exceed it.

- [ ] **Step 8: PB — branch, install the tarball, set the range**

```bash
git -C /c/Users/robert/source/repos/pirates-bight switch -c cutover/switch master
cd /c/Users/robert/source/repos/pirates-bight && npm install --no-save C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz && node -p "require('./node_modules/@forgebuild/sidon-booking-widget/package.json').version" && git status --short
```
Expected: `Switched to a new branch 'cutover/switch'`, then `1.1.0`, then no status lines. `--no-save` leaves `package.json` and `package-lock.json` alone.

Now hand-edit `package.json` line 25. Do not run `npm install` again: 1.1.0 is not on npm yet, so it would fail. Old:
```json
    "@forgebuild/sidon-booking-widget": "^0.4.17",
```
New:
```json
    "@forgebuild/sidon-booking-widget": "^1.1.0",
```

- [ ] **Step 9: PB — create the forwarder**

Create `src/pages/api/marina/guest/[...path].ts` with the contract's exact text:
```ts
// OTA's guest API for the booking widget, with this site's property key
// added server-side (the browser never sees it). Only /api/marina/guest/*.
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Astro reads this flag from this file's source text, so it can't come
// from the package.
export const prerender = false;

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;

// Kill switch: without both env vars booking is hidden, and this answers
// one clear JSON 503 instead of a proxy with no key (404 for every slug).
const proxy = otaBaseUrl && apiKey
  ? createMarinaProxy({ otaBaseUrl, keys: apiKey })
  : () => new Response(JSON.stringify({ error: 'Online booking is not available' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

export const GET = proxy;
export const POST = proxy;
```
The forwarder uses `OTA_API_KEY`, the Pirates Bight property key that `src/lib/pms.ts` and `src/pages/api/*` already use. Its base URL is `OTA_BASE_URL` (R21), not the PMS routes' `PMS_API_BASE_URL`.

- [ ] **Step 10: PB — create the booking page**

Create `src/pages/booking.astro`. It has no Layout, because Layout loads Google Fonts, CookieBanner/GTM, AiChat and VisualEditing. It has no `locale` attribute (G12), and no `api-origin` or `currency-symbol` (R24).
```astro
---
// OTA's guest emails and confirm link land here with ?booking=&token=.
// Bare on purpose (no site layout, analytics or fonts): the token is in the URL.
// Clerk's integration still injects its script into every page; accepted
// (first-party auth, not analytics).
export const prerender = false;
Astro.response.headers.set('Referrer-Policy', 'no-referrer');

const SLUG = 'pirates-bight';
const MARINA_NAME = 'Pirates Bight';
const LOGO = '/favicon.svg';
// Same brand variables as MooringsWidget.astro, so the booking matches /berths.
const BRAND_STYLE = '--brand-navy: #0e3a3e; --brand-gold: #d49a3c; --brand-ink: #0e3a3e;';
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Your booking — {MARINA_NAME}</title>
  </head>
  <body>
    <main style="max-width:680px;margin:0 auto;padding:24px 0">
      <sidon-booking-widget marina={SLUG} booking-id variant="dark" marina-name={MARINA_NAME} logo-mark={LOGO} style={BRAND_STYLE}></sidon-booking-widget>
    </main>
    <script>import '@forgebuild/sidon-booking-widget';</script>
  </body>
</html>
```

- [ ] **Step 11: PB — MooringsWidget on OTA**

In `src/components/MooringsWidget.astro`, replace lines 1-61 (from the opening `---` to the closing `)}` of the fallback) with the block below. Lines 63-84 (the `<script>` hand-off) stay byte-for-byte. In guest mode, 1.1 still reads `from`/`to` only once (plan C R3), so the clone-and-replace stays.
```astro
---
// Live moorings on OTA's marina module: <sidon-berth-map> +
// <sidon-booking-widget> (@forgebuild/sidon-booking-widget 1.x). Both call
// this site's /api/marina/guest/* forwarder (src/pages/api/marina/guest/
// [...path].ts), which adds the property's OTA key server-side, and the
// widget runs the whole booking wizard (documents, contract, card hold)
// against OTA. OTA's guest emails link back to /booking.
export interface Props {
  name: string;
  vhf?: string;
}
const { name, vhf } = Astro.props;

// This marina's slug in OTA (the dashboard's Marina settings).
const marina = 'pirates-bight';
// Kill switch: without both OTA env vars the forwarder only answers 503, so
// show the VHF fallback instead of a widget that can't load. Astro inlines
// these at build time, so changing them in Vercel needs a redeploy.
const bookingEnabled = Boolean(import.meta.env.OTA_BASE_URL && import.meta.env.OTA_API_KEY);
const mapsApiKey = import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY;

const BRAND_STYLE = '--brand-navy: #0e3a3e; --brand-gold: #d49a3c; --brand-ink: #0e3a3e;';
---

{bookingEnabled ? (
  <div class="bg-navy pt-[var(--pb-header-h)] [--pb-header-h:88px] md:[--pb-header-h:112px]">
    {mapsApiKey && (
      <sidon-berth-map
        marina={marina}
        maps-api-key={mapsApiKey}
        map-style="chart"
        map-height="calc(100svh - var(--pb-header-h))"
        show-weather
        locale="en"
        logo-mark="/favicon.svg"
        marina-name={name}
        eyebrow="Norman Island, BVI"
        style={BRAND_STYLE}
      ></sidon-berth-map>
    )}

    <section id="book-mooring" class="bg-cream px-0 md:px-10 py-10 md:py-16 scroll-mt-24">
      <div class="max-w-[680px] mx-auto">
        <sidon-booking-widget
          marina={marina}
          locale="en"
          variant="dark"
          logo-mark="/favicon.svg"
          marina-name={name}
          style={BRAND_STYLE}
        ></sidon-booking-widget>
      </div>
    </section>
  </div>
) : (
  <section class="min-h-[60vh] bg-navy text-white flex items-center justify-center px-4 pt-32 pb-16 text-center">
    <p class="text-white/70">Online mooring bookings aren't available right now. Hail us on VHF {vhf ?? 'CH 16'}.</p>
  </section>
)}
```
With `currency-symbol` gone, amounts are formatted with Intl in the property's own currency.

```bash
cd /c/Users/robert/source/repos/pirates-bight && grep -rn -i "sidon_url\|api-origin\|currency-symbol" src
```
Expected: no output.

- [ ] **Step 12: PB — CLAUDE.md moorings bullet**

`CLAUDE.md` line 12. Old:
```markdown
- **sidon-ai** runs mooring bookings on `/berths` through `@forgebuild/sidon-booking-widget` (`<sidon-berth-map>` + `<sidon-booking-widget>`, in `src/components/MooringsWidget.astro`). Both call sidon-ai's public marina API from the browser; the marina id and origin are parsed from `SIDON_URL`. The widget handles documents, contract and its own Stripe hold via sidon-ai, so mooring bookings don't touch this repo's Stripe account. It reads `from`/`to` only on mount, so the map hand-off swaps in a fresh element.
```
New:
```markdown
- **Moorings** are booked on `/berths` against OTA's marina module through `@forgebuild/sidon-booking-widget` 1.x (`<sidon-berth-map>` + `<sidon-booking-widget>`, in `src/components/MooringsWidget.astro`, slug `pirates-bight`). Both call this site's forwarder `src/pages/api/marina/guest/[...path].ts`, which adds `OTA_API_KEY` server-side and forwards to `OTA_BASE_URL`. Both env vars must be set for Preview and Production; without either, `/berths` shows the VHF fallback and the forwarder answers 503. Astro inlines them at build time, so an env change needs a redeploy. OTA's guest emails link to the bare `/booking` page (no Layout, `Referrer-Policy: no-referrer`, noindex), whose URL is the marina's `booking_url` in OTA's dashboard. The widget runs documents, contract and the card hold through OTA, so mooring bookings don't touch this repo's Stripe account. It reads `from`/`to` only on mount, so the map hand-off swaps in a fresh element.
```
Line 5 (the project's sidon-ai history) and line 22 (never edit sidon-ai) stay.

- [ ] **Step 13: Local OTA with the `pirates-bight` demo marina**

```bash
cd /c/Users/robert/source/repos/OTA && grep -c '^MARINA_BOOKING_TOKEN_SECRET=' .env && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | grep -v '^api_key='
```
Expected: `1`, then the seeded block ending `slug=pirates-bight`.

Start local OTA with `run_in_background`:
```bash
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start
```
Wait until its output shows the server listening on 3100, then check it:
```bash
KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); curl -s -H "X-Api-Key: $KEY" http://localhost:3100/api/marina/guest/pirates-bight | head -c 80
```
Expected: `{"marina":{"name":"Demo Marina","slug":"pirates-bight",...`

- [ ] **Step 14: PB — type check**

```bash
cd /c/Users/robert/source/repos/pirates-bight && npx astro check 2>&1 | tail -n 4
```
Expected: errors ≤ the Step 7 baseline, and none in `booking.astro`, `MooringsWidget.astro` or `[...path].ts`.

- [ ] **Step 15: PB — env build and the sitemap assertion**

Shell-set values override PB's own `.env`, which already holds the live `OTA_API_KEY` and an `OTA_BASE_URL`. Astro loads env through Vite's `loadEnv(mode, root, '')`, and with an empty prefix `process.env` wins.
```bash
cd /c/Users/robert/source/repos/pirates-bight && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npm run build 2>&1 | tail -n 3
cd /c/Users/robert/source/repos/pirates-bight && grep -o '<loc>[^<]*booking[^<]*</loc>' dist/client/sitemap-0.xml; grep -c '<loc>[^<]*/berths/</loc>' dist/client/sitemap-0.xml
```
Expected: the build ends with `Complete!`. The first grep is expected to print `<loc>https://pirates-bight.vercel.app/booking/</loc>`, because `@astrojs/sitemap` lists SSR routes here (`/berths/` is SSR and listed). The second grep prints `1`.

If the first grep printed nothing, skip the edit below and drop `astro.config.mjs` from Step 21's `git add`. Otherwise edit `astro.config.mjs` line 36. Old:
```js
    sitemap(),
```
New:
```js
    // The booking page carries a guest's booking token in its URL and is
    // noindex; it never belongs in the sitemap.
    sitemap({ filter: (p) => !p.includes('/booking') }),
```
Rebuild with the same build command as above, then:
```bash
cd /c/Users/robert/source/repos/pirates-bight && grep -c '<loc>[^<]*booking' dist/client/sitemap-0.xml; grep -c '<loc>[^<]*/berths/</loc>' dist/client/sitemap-0.xml
```
Expected: `0`, then `1`. `/experiences/book/` doesn't contain `/booking`, so it stays listed.

- [ ] **Step 16: PB — empty-env build succeeds (Review Focus 5)**

```bash
cd /c/Users/robert/source/repos/pirates-bight && OTA_BASE_URL= OTA_API_KEY= npm run build 2>&1 | tail -n 3
```
Expected: ends with `Complete!` and no error. PB has no build-time OTA reads, and the forwarder falls back to its 503 handler instead of `createMarinaProxy`.

- [ ] **Step 17: PB — dev against local OTA: forwarder and `/berths` markup**

Start the dev server with `run_in_background`:
```bash
cd /c/Users/robert/source/repos/pirates-bight && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=pirates-bight node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npx astro dev --port 4400
```
Wait until its output shows `http://localhost:4400/`. Then:
```bash
curl -s http://localhost:4400/api/marina/guest/pirates-bight | head -c 300
```
Expected: `{"marina":{"name":"Demo Marina","slug":"pirates-bight","description":"A local demo marina for the booking widget.",...`

```bash
curl -s http://localhost:4400/berths -o C:/tmp/plan-d/pb-berths.html; grep -o '<sidon-booking-widget marina="[^"]*"' C:/tmp/plan-d/pb-berths.html; grep -c -e 'api-origin' -e 'currency-symbol' C:/tmp/plan-d/pb-berths.html
```
Expected: `<sidon-booking-widget marina="pirates-bight"`, then `0`.

- [ ] **Step 18: PB — create a booking through the forwarder, then open the booking page (Review Focus 4)**

```bash
curl -s -o C:/tmp/plan-d/pb-post.json -w '%{http_code}\n' -X POST http://localhost:4400/api/marina/guest/pirates-bight/bookings -H 'Content-Type: application/json' -d "{\"berth_label\":\"A2\",\"arrival\":\"$(date -d '+30 days' +%F)\",\"departure\":\"$(date -d '+32 days' +%F)\",\"contact_name\":\"Plan D\",\"contact_email\":\"plan-d+pb@example.com\",\"boat_name\":\"Check\",\"boat_length_m\":9}"
```
Expected: `201`. A `409` on a re-run means an earlier run's booking still holds A2; repeat with `\"berth_label\":\"A4\"`.

```bash
read ID TOK < <(node -e "const r=require('C:/tmp/plan-d/pb-post.json'); console.log(r.booking.id, r.booking_token)"); curl -s -D - "http://localhost:4400/booking?booking=$ID&token=$TOK" -o C:/tmp/plan-d/pb-booking.html | grep -i -e '^HTTP/' -e '^referrer-policy'
```
Expected:
```
HTTP/1.1 200 OK
referrer-policy: no-referrer
```
```bash
grep -c 'sidon-booking-widget' C:/tmp/plan-d/pb-booking.html; grep -c 'content="no-referrer"' C:/tmp/plan-d/pb-booking.html; grep -c 'noindex' C:/tmp/plan-d/pb-booking.html; grep -o '<sidon-booking-widget[^>]*>' C:/tmp/plan-d/pb-booking.html
```
Expected:
- Each count is ≥ 1.
- The element is `<sidon-booking-widget marina="pirates-bight" booking-id variant="dark" marina-name="Pirates Bight" logo-mark="/favicon.svg" style="--brand-navy: #0e3a3e; --brand-gold: #d49a3c; --brand-ink: #0e3a3e;">`, with no `locale`, `api-origin` or `currency-symbol`.
- A Clerk `<script>` elsewhere in the page is expected and accepted (R25).

- [ ] **Step 19: PB — kill-switch dev (Review Focus 5)**

Stop the Step 17 dev server with TaskStop on its background task. Start this one with `run_in_background`:
```bash
cd /c/Users/robert/source/repos/pirates-bight && OTA_BASE_URL= OTA_API_KEY= npx astro dev --port 4400
```
Once it shows `http://localhost:4400/`:
```bash
curl -s http://localhost:4400/berths -o C:/tmp/plan-d/pb-berths-off.html; grep -c '<sidon-booking-widget' C:/tmp/plan-d/pb-berths-off.html; grep -c 'Hail us on VHF' C:/tmp/plan-d/pb-berths-off.html
curl -s -w '\n%{http_code}\n' http://localhost:4400/api/marina/guest/pirates-bight
```
Expected: `0`, then `1`. Then `{"error":"Online booking is not available"}` and `503`.

- [ ] **Step 20: Stop the background servers**

Use TaskStop on the kill-switch dev server (Step 19) and on local OTA (Step 13). Then:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4400/ ; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/
```
Expected: `000` twice. Nothing is listening any more.

- [ ] **Step 21: PB — commit on `cutover/switch`**

```bash
git -C /c/Users/robert/source/repos/pirates-bight status --short
```
Expected (no `package-lock.json` line; drop `astro.config.mjs` if Step 15 skipped its edit):
```
 M CLAUDE.md
 M astro.config.mjs
 M package.json
 M src/components/MooringsWidget.astro
?? src/pages/api/marina/
?? src/pages/booking.astro
```
```bash
git -C /c/Users/robert/source/repos/pirates-bight add package.json astro.config.mjs CLAUDE.md src/components/MooringsWidget.astro 'src/pages/api/marina/guest/[...path].ts' src/pages/booking.astro && git -C /c/Users/robert/source/repos/pirates-bight commit -F - <<'EOF'
Moorings: book through OTA's marina module (widget 1.1)

- @forgebuild/sidon-booking-widget ^1.1.0. The berth map and booking
  wizard call this site's /api/marina/guest/* forwarder, which adds
  OTA_API_KEY server-side and forwards to OTA_BASE_URL.
- /booking: the bare page OTA's guest emails link to (no Layout,
  Referrer-Policy: no-referrer header and meta, noindex, kept out of the
  sitemap).
- MooringsWidget: slug pirates-bight; no api-origin or currency-symbol, so
  amounts use the property's currency. Booking hides (VHF fallback) and
  the forwarder answers 503 unless OTA_BASE_URL and OTA_API_KEY are both
  set.

For the PR:
- Clerk's integration injects its script into every page, /booking
  included. Accepted: first-party auth, not analytics.
- Vercel needs OTA_BASE_URL (new) and OTA_API_KEY for Preview and
  Production, then a redeploy; SIDON_URL and SIDON_API_KEY can go.
- package-lock.json is refreshed and committed once 1.1.0 is on npm.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git -C /c/Users/robert/source/repos/pirates-bight branch --show-current
```
Expected: one commit, then `cutover/switch`. PB stays on `cutover/switch` with `package-lock.json` unmodified, and O stays on `main` with Step 5's commit. Nothing is pushed. At Step 6 the runbook pushes and merges this branch, commits the lockfile after `npm publish`, sets the Vercel env and redeploys.

---

### Task 6: tested-trappist (BBYC) cutover/switch

Moves BBYC's facilities page onto widget `^1.1.0` against OTA. It adds the site's own forwarder (the `astro:env` variant), a bare `/booking` page and the G7 kill switch on `OTA_BASE_URL`, and drops every Sidon env var. Nothing is pushed. The runbook later runs `npm install` on this branch after `npm publish` and commits the lockfile (G6). At Switch it sets `OTA_BASE_URL` in Vercel for Preview and Production, deletes the four Sidon vars there, redeploys, and sets BBYC's `booking_url`.

**Repo / branch:** TT = `C:/Users/robert/source/repos/tested-trappist`, new branch `cutover/switch` cut from local `master` (`a33f4c0`). Local OTA (O, `main`) is only run, not changed.

**Files:**
- Modify: `TT/package.json:24`. The widget range goes from `^0.4.17` to `^1.1.0`. `package-lock.json` is never committed.
- Modify: `TT/astro.config.mjs:69` (add `OTA_BASE_URL` after `OTA_API_KEY`) and `:74-77` (delete `SIDON_URL`, `SIDON_APIKEY`, `PUBLIC_SIDON_MARINA_ID`, `PUBLIC_SIDON_ORIGIN`).
- Create: `TT/src/lib/marina.ts`.
- Modify: `TT/src/components/FacilitiesPage.astro:1-41`. Whole-file content is given below. The `<script>` at `:43-58`, including the quick-book hand-off, is unchanged.
- Create: `TT/src/pages/api/marina/guest/[...path].ts`.
- Create: `TT/src/pages/booking.astro`.
- Docs: none. `rg -n -i sidon README.md docs` only matches the unrelated `sidon-ball` icon in an old i18n plan, so no doc names a Sidon env var or flow. TT has no `CLAUDE.md`. `.env.local` is gitignored and left alone; its stale `SIDON_*` / `MARINAID` lines are harmless once they are out of the schema.

**Interfaces:**
- Consumes:
  - the widget tarball `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz` (Task 5), with `W/package.json` version `1.1.0`
  - `createMarinaProxy({ otaBaseUrl, keys })` from `@forgebuild/sidon-booking-widget/astro-proxy`
  - the `<sidon-booking-widget>` and `<sidon-berth-map>` elements, 1.1
  - the O demo seed `MARINA_DEMO_SLUG=bora-bora-yacht-club node scripts/seed-marina-demo.js`, whose output lines are `api_key=` and `slug=` (Task 5, G11)
  - OTA's guest API `GET/POST /api/marina/guest/:slug[/…]`
- Produces:
  - `export const BBYC_SLUG = 'bora-bora-yacht-club';` in `src/lib/marina.ts` (R29)
  - the forwarder `src/pages/api/marina/guest/[...path].ts`, the tested-trappist variant: `export const prerender = false`, `GET`/`POST`, and `503 {"error":"Online booking is not available"}` when the kill switch is off
  - the booking page `/booking`, so `booking_url` = `<origin>/booking?booking={id}&token={token}` (the runbook's Step 6 input)
  - the env schema `OTA_API_KEY` (required secret, unchanged) + `OTA_BASE_URL` (optional server secret). The kill switch is `OTA_BASE_URL=` (G7).

- [ ] **Step 1: Gate on plan C and Task 5, and check the tree**

Run each line as its own Bash call:
```bash
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"
ls -l /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
git -C /c/Users/robert/source/repos/tested-trappist status --short
git -C /c/Users/robert/source/repos/tested-trappist rev-parse --abbrev-ref HEAD
```
Expected: `1.1.0`, the tarball listed, an empty status and `master`. If the version isn't `1.1.0` or the tarball is missing, stop and report "plan C / Task 5 not done". If the status prints anything, stop and report it (do not stash).

- [ ] **Step 2: Record the type-check baseline on master**

```bash
cd /c/Users/robert/source/repos/tested-trappist && npx astro check 2>&1 | tail -4
```
Write down the `- N errors` count. Step 9 must not exceed it.

- [ ] **Step 3: Branch and install the 1.1.0 tarball before editing package.json (G6)**

```bash
git -C /c/Users/robert/source/repos/tested-trappist switch -c cutover/switch master
cd /c/Users/robert/source/repos/tested-trappist && npm install --no-save /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
node -p "require('C:/Users/robert/source/repos/tested-trappist/node_modules/@forgebuild/sidon-booking-widget/package.json').version"
git -C /c/Users/robert/source/repos/tested-trappist status --short
```
Expected: `Switched to a new branch 'cutover/switch'`, then `1.1.0`, then an empty status. If `package-lock.json` shows as modified, run `git -C /c/Users/robert/source/repos/tested-trappist checkout -- package-lock.json`. The lockfile is the runbook's job after publish.

Then edit `TT/package.json:24`:
```diff
-    "@forgebuild/sidon-booking-widget": "^0.4.17",
+    "@forgebuild/sidon-booking-widget": "^1.1.0",
```

- [ ] **Step 4: Env schema (G7)**

In `TT/astro.config.mjs`, after the existing `OTA_API_KEY` line (`:69`):
```diff
         OTA_API_KEY: envField.string({ context: 'server', access: 'secret' }),
+        OTA_BASE_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
         RESEND_API_KEY: envField.string({ context: 'server', access: 'secret' }),
```
and delete the four Sidon lines (`:74-77`):
```diff
         RECAPTURE_SECRET: envField.string({ context: 'server', access: 'secret' }),
-        SIDON_URL: envField.string({ context: 'server', access: 'secret' }),
-        SIDON_APIKEY: envField.string({ context: 'server', access: 'secret' }),
-        PUBLIC_SIDON_MARINA_ID: envField.string({ context: 'client', access: 'public', optional: true }),
-        PUBLIC_SIDON_ORIGIN: envField.string({ context: 'client', access: 'public', optional: true }),
         PUBLIC_STRIPE_PUBLISHABLE_KEY: envField.string({ context: 'client', access: 'public' }),
```
Astro's validator accepts `""` for an optional string, so `OTA_BASE_URL=` passes validation as an empty (falsy) value. That is the kill switch. `OTA_API_KEY` stays required because the PMS routes (`src/pages/api/availability.ts` and others) already import it.

- [ ] **Step 5: The slug constant (R29)**

Create `TT/src/lib/marina.ts`:
```ts
// BBYC's marina slug on OTA. It is whatever the signed-off import map prints
// for BBYC (a runbook input). If the sign-off picks another slug, change it
// here before merging; OTA's guest API and the booking page both key on it.
export const BBYC_SLUG = 'bora-bora-yacht-club';
```

- [ ] **Step 6: FacilitiesPage on OTA (R24, R29, G7)**

Replace `TT/src/components/FacilitiesPage.astro:1-41` (frontmatter + markup) with the text below. The `<script>` block from `:43` on stays byte-for-byte. The quick-book hand-off is left as is (R29).
```astro
---
import { OTA_BASE_URL } from "astro:env/server";
import { ui } from "../i18n/ui";
import { BBYC_SLUG } from "../lib/marina";

const locale = (Astro.currentLocale ?? "en") as "en" | "fr";
const t = ui[locale];

const MAPS_API_KEY = "AIzaSyAXiQ_kVoJ0Iljn2N57NhR2gp-JvsmVKEk";
const BRAND_STYLE = "--brand-navy: #000000; --brand-gold: #2dd4bf; --brand-ink: #000000;";
---

{OTA_BASE_URL ? (
	<div class="bg-black">
		<sidon-berth-map
			marina={BBYC_SLUG}
			maps-api-key={MAPS_API_KEY}
			map-style="chart"
			map-height="calc(100vh - 64px)"
			show-weather
			locale={locale}
			logo-mark="/favicon.svg"
			marina-name="Bora Bora Yacht Club"
			style={BRAND_STYLE}
		></sidon-berth-map>

		<section class="bg-white px-0 md:px-10 py-10 md:py-16">
			<div class="max-w-[680px] mx-auto">
				<sidon-booking-widget
					marina={BBYC_SLUG}
					locale={locale}
					variant="dark"
					logo-mark="/favicon.svg"
					marina-name="Bora Bora Yacht Club"
					style={BRAND_STYLE}
				></sidon-booking-widget>
			</div>
		</section>
	</div>
) : (
	// Kill switch (OTA_BASE_URL unset): no online booking, so point sailors at the phone instead.
	<section class="bg-black text-white px-4 py-16">
		<p class="max-w-[680px] mx-auto text-center">
			{t["facilities.noBerths"]}
			<a href="tel:+68940676047" class="underline hover:opacity-80 transition-opacity">(+689) 40 67 60 47</a>
		</p>
	</section>
)}
```
Removed: `api-origin` and `currency-symbol="XPF"` on both elements (R24), so amounts use Intl in the property currency. The runbook's BBYC sign-off may re-add a forced `currency-symbol`. Also removed: the `astro:env/client` import and the gate on the Sidon owner id. The fallback reuses the existing en/fr string `facilities.noBerths` and the Footer's phone number. Before this change, the page rendered nothing at all when booking was off.

- [ ] **Step 7: The forwarder (R23, tested-trappist variant)**

Create `TT/src/pages/api/marina/guest/[...path].ts`:
```ts
// OTA's guest API for the booking widget, with this site's property key
// added server-side (the browser never sees it). Only /api/marina/guest/*.
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';
import { OTA_API_KEY, OTA_BASE_URL } from 'astro:env/server';

// Astro reads this flag from this file's source text, so it can't come
// from the package.
export const prerender = false;

const otaBaseUrl = OTA_BASE_URL;
const apiKey = OTA_API_KEY;

// Kill switch: without both env vars booking is hidden, and this answers
// one clear JSON 503 instead of a proxy with no key (404 for every slug).
const proxy = otaBaseUrl && apiKey
  ? createMarinaProxy({ otaBaseUrl, keys: apiKey })
  : () => new Response(JSON.stringify({ error: 'Online booking is not available' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

export const GET = proxy;
export const POST = proxy;
```

- [ ] **Step 8: The booking page (R23, G12)**

Create `TT/src/pages/booking.astro`. One page serves en and fr: there is no `locale` attribute, so widget 1.1 uses the booking's own locale (G12). It has no `Layout`, because Layout loads Google Fonts and Sanity VisualEditing.
```astro
---
// OTA's guest emails and confirm link land here with ?booking=&token=.
// Bare on purpose (no site layout, analytics or fonts): the token is in the URL.
import { BBYC_SLUG } from '../lib/marina';

export const prerender = false;
Astro.response.headers.set('Referrer-Policy', 'no-referrer');

const MARINA_NAME = 'Bora Bora Yacht Club';
// Same brand colours as FacilitiesPage.
const BRAND_STYLE = '--brand-navy: #000000; --brand-gold: #2dd4bf; --brand-ink: #000000;';
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Your booking — {MARINA_NAME}</title>
  </head>
  <body>
    <main style="max-width:680px;margin:0 auto;padding:24px 0">
      <sidon-booking-widget marina={BBYC_SLUG} booking-id variant="dark" marina-name={MARINA_NAME} logo-mark="/favicon.svg" style={BRAND_STYLE}></sidon-booking-widget>
    </main>
    <script>import '@forgebuild/sidon-booking-widget';</script>
  </body>
</html>
```
TT has no sitemap integration, so there is no sitemap assertion.

- [ ] **Step 9: Leftover scan and type check**

```bash
cd /c/Users/robert/source/repos/tested-trappist && rg -n "SIDON|api-origin|currency-symbol|astro:env/client" src astro.config.mjs
cd /c/Users/robert/source/repos/tested-trappist && npx astro check 2>&1 | tail -4
```
Expected: `rg` matches only the unrelated `PUBLIC_STRIPE_PUBLISHABLE_KEY` consumers, if any use `astro:env/client` (check that none is in `FacilitiesPage.astro`), and no `SIDON`, `api-origin` or `currency-symbol` anywhere. `astro check` must show `- N errors` with N ≤ the Step 2 baseline.

- [ ] **Step 10: Seed the BBYC slug and start local OTA**

```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=bora-bora-yacht-club node scripts/seed-marina-demo.js | grep -v '^api_key='
```
Expected: the output includes `slug=bora-bora-yacht-club` (the key line is filtered out).

Start OTA with `run_in_background` (it needs `MARINA_BOOKING_TOKEN_SECRET` in `O/.env`):
```bash
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start
```
Wait using Monitor with `until curl -s -o /dev/null http://localhost:3100/; do sleep 1; done`.

- [ ] **Step 11: Build with env, then build with the kill switch**

```bash
cd /c/Users/robert/source/repos/tested-trappist && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=bora-bora-yacht-club node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npm run build 2>&1 | tail -3
cd /c/Users/robert/source/repos/tested-trappist && OTA_BASE_URL= npm run build 2>&1 | tail -3
```
Expected: both end with `[build] Complete!` and exit 0. `OTA_API_KEY` stays set from `.env.local` in the second build (G7: the switch on this site is `OTA_BASE_URL`).

- [ ] **Step 12: Dev server, forwarder, facilities page**

Start with `run_in_background`:
```bash
cd /c/Users/robert/source/repos/tested-trappist && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=bora-bora-yacht-club node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npx astro dev --port 4315
```
Wait using Monitor with `until curl -s -o /dev/null http://localhost:4315/facilities; do sleep 2; done`. Then:
```bash
curl -s http://localhost:4315/api/marina/guest/bora-bora-yacht-club | head -c 300; echo
curl -s http://localhost:4315/api/marina/guest/bora-bora-yacht-club | grep -o '"slug":"bora-bora-yacht-club"'
curl -s http://localhost:4315/facilities -o /tmp/tt-fac.html; grep -c '<sidon-booking-widget' /tmp/tt-fac.html; grep -c 'marina="bora-bora-yacht-club"' /tmp/tt-fac.html; grep -c 'currency-symbol\|api-origin' /tmp/tt-fac.html
curl -s http://localhost:4315/fr/facilities | grep -c 'locale="fr"'
```
Expected:
- first: JSON starting `{"marina":{`
- second: `"slug":"bora-bora-yacht-club"`
- the three counts: `1`, `2` (map + widget), `0`
- last: `2`

- [ ] **Step 13: Hold a booking and open the booking page (Review Focus 4)**

```bash
A=$(date -d '+30 days' +%F); D=$(date -d '+32 days' +%F); R=$(curl -s -X POST http://localhost:4315/api/marina/guest/bora-bora-yacht-club/bookings -H 'Content-Type: application/json' -d "{\"berth_label\":\"A2\",\"arrival\":\"$A\",\"departure\":\"$D\",\"contact_name\":\"Plan D\",\"contact_email\":\"plan-d+tt@example.com\",\"boat_name\":\"Check\",\"boat_length_m\":9}"); ID=$(node -p "JSON.parse(process.argv[1]).booking.id" "$R"); TOK=$(node -p "JSON.parse(process.argv[1]).booking_token" "$R"); curl -s -D /tmp/tt-h.txt "http://localhost:4315/booking?booking=$ID&token=$TOK" -o /tmp/tt-booking.html; head -1 /tmp/tt-h.txt; grep -i '^referrer-policy' /tmp/tt-h.txt
grep -c '<sidon-booking-widget' /tmp/tt-booking.html; grep -c 'content="no-referrer"' /tmp/tt-booking.html; grep -c 'noindex' /tmp/tt-booking.html; grep -c 'locale=\|currency-symbol\|api-origin\|fonts.googleapis' /tmp/tt-booking.html
```
Expected: `HTTP/1.1 200 OK` and `Referrer-Policy: no-referrer`, then `1`, `1`, `1`, `0`. If `node -p` throws because `R` is `{"error":…}` with a 409, a previous run still holds A2: re-run with `"berth_label":"A4"`. The token is used only inside the command and is never echoed.

- [ ] **Step 14: Kill-switch dev (Review Focus 5)**

Stop the Step 12 dev server: use `TaskStop` with its task id, or by port:
```bash
for pid in $(netstat -ano | awk -v p=":4315" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do taskkill //PID "$pid" //T //F; done
```
Restart with `run_in_background`. `OTA_API_KEY` stays set from `.env.local`:
```bash
cd /c/Users/robert/source/repos/tested-trappist && OTA_BASE_URL= npx astro dev --port 4315
```
Wait using Monitor as in Step 12, then:
```bash
curl -s -w '\n%{http_code}\n' http://localhost:4315/api/marina/guest/bora-bora-yacht-club
curl -s http://localhost:4315/facilities -o /tmp/tt-fac-off.html; grep -c '<sidon-booking-widget\|<sidon-berth-map' /tmp/tt-fac-off.html; grep -c 'contact us directly' /tmp/tt-fac-off.html; grep -c 'tel:+68940676047' /tmp/tt-fac-off.html
```
Expected:
- `{"error":"Online booking is not available"}` then `503`
- `0`, `1`, then `2` (the fallback's phone link plus the Footer's)

- [ ] **Step 15: Stop the servers**

Stop both background tasks with `TaskStop`, or by port:
```bash
for port in 4315 3100; do for pid in $(netstat -ano | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do taskkill //PID "$pid" //T //F; done; done
```
Expected: afterwards `netstat -ano | grep -E ':(4315|3100) .*LISTENING'` prints nothing.

- [ ] **Step 16: Commit on cutover/switch (no push)**

```bash
git -C /c/Users/robert/source/repos/tested-trappist status --short
git -C /c/Users/robert/source/repos/tested-trappist add package.json astro.config.mjs src/lib/marina.ts src/components/FacilitiesPage.astro "src/pages/api/marina/guest/[...path].ts" src/pages/booking.astro
git -C /c/Users/robert/source/repos/tested-trappist commit -m "Marina booking on OTA: widget 1.1, forwarder, /booking page, OTA_BASE_URL kill switch

- FacilitiesPage uses the OTA slug (src/lib/marina.ts BBYC_SLUG), drops
  api-origin and currency-symbol (Intl in the property currency), and shows
  a phone fallback when OTA_BASE_URL is unset.
- /api/marina/guest/* forwards to OTA with the property key from astro:env;
  503 JSON when OTA_BASE_URL is unset.
- /booking: bare booking-page mode (no-referrer header + meta, noindex,
  no locale so the booking's own locale is used).
- Env schema: add optional OTA_BASE_URL; drop SIDON_URL, SIDON_APIKEY,
  PUBLIC_SIDON_MARINA_ID, PUBLIC_SIDON_ORIGIN.
- package-lock.json is refreshed after the 1.1.0 npm publish.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/tested-trappist log --oneline -1
git -C /c/Users/robert/source/repos/tested-trappist status --short
```
Expected: the first status lists exactly those six paths (plus nothing else, and not `package-lock.json`). After the commit there is one new commit on `cutover/switch` and the status is empty. Leave TT on `cutover/switch`. Nothing is pushed. The runbook pushes and merges it at Step 6, after the G6 lockfile commit and the Vercel env change (add `OTA_BASE_URL`, delete the four Sidon vars, redeploy).

---

### Task 7: sea-company (Fox + Pevero) cutover/switch

Repo `SEA` = `C:/Users/robert/source/repos/sea-company`. Branch `cutover/switch` is cut from local `master`. Implements R21, R22, R23, R24, R28, G6, G7 and G8. Nothing is pushed; the runbook pushes and merges this branch at Step 6, after `npm publish` and the G6 lockfile step.

**Files** (all in SEA, branch `cutover/switch`):
- Delete: `.npmrc` (both lines are `@robooko` only).
- Modify: `package.json` (the `@robooko/sidon-booking-widget` dependency line). `package-lock.json` is NOT committed (G6).
- Create: `src/pages/api/marina/guest/[...path].ts` (the contract's forwarder, verbatim).
- Create: `src/pages/booking.astro` (the bare booking page with the G8 `?marina=` whitelist).
- Modify (whole file): `src/lib/marina-api.ts` (1–75 → lazy `createMarinaClient` plus the camelCase adapter).
- Modify: `src/lib/home-page-data.ts:33-45` (`getMarina(slug)`, null-safe, lower-cased currency).
- Modify (whole file): `src/components/marina-page/BookingMapBlock.astro` (drop `api-origin`/`currency-symbol`, slug prop, `@forgebuild` specifier).
- Modify (whole file): `src/components/marina-page/BookingWidgetBlock.astro` (same, plus the `currencySymbol = '€'` default).
- Modify (whole file): `src/components/marina-page/PageSections.astro` (`marinaSlug` prop replaces `ownerId`; G7 fallback).
- Modify: `src/components/marina-page/RoutedPageBody.astro:31-41` (pass `marinaSlug`).
- Modify (whole file): `.env.example` (Sidon vars → `OTA_BASE_URL`/`OTA_API_KEY`).
- Modify: `CLAUDE.md`, the `**Booking**` bullet and the `### Environment` paragraph (located by text, not line number).

**Interfaces:**
- Consumes:
  - `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz` (Task 5).
  - `createMarinaProxy` and `createMarinaClient` from `@forgebuild/sidon-booking-widget/astro-proxy`. `createMarinaClient(...).getMarina(slug)` returns OTA's raw guest map payload, or `null` on 404.
  - O demo seed `MARINA_DEMO_SLUG` (G11): prints `api_key=` and `slug=` lines.
  - Contract text: the forwarder, the booking-page shape, the lazy server client and the site verification procedure.
- Produces:
  - `src/lib/marina-api.ts`: `export const bookingEnabled: boolean`, `export function getMarina(slug: string): Promise<MarinaData | null>`, and `MarinaProfile { slug, name, lat, lng, currency }`, `Berth { label, pricePerNight, priceMode, lengthM }`, `PriceTier { validFrom, validTo, maxLenM, pricePerNight }`, `MarinaData { profile, berths, priceTiers }`.
  - `GET|POST /api/marina/guest/*` (the forwarder; 503 `{"error":"Online booking is not available"}` under the kill switch).
  - `GET /booking?marina=fox-mooring|pevero-mooring&booking=&token=`. Any other `marina` value → 404.
  - The runbook's Step 6 `booking_url` for each marina: `<origin>/booking?marina=fox-mooring&booking={id}&token={token}` and `<origin>/booking?marina=pevero-mooring&booking={id}&token={token}`.

---

- [ ] **Step 1: Gates (R6 dirty tree, plan C widget, tarball)**

Run each command as its own Bash call:

```bash
git -C /c/Users/robert/source/repos/sea-company status --short
```
Expected: no output. Today it prints ` M CLAUDE.md`, ` M package-lock.json` and ` M package.json`. **If it prints anything, stop and report to the user** (R6: they commit or stash first). Do not touch the repo.

```bash
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"
ls -l /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
```
Expected: `1.1.0`, and the tarball is listed. If either fails, stop: plan C or Task 5's tarball step is not done.

```bash
cd /c/Users/robert/source/repos/sea-company && grep -c '^OTA_' .env .env.local
```
Expected: `.env:0` and `.env.local:0`. The kill-switch checks below rely on no OTA value coming from a dotenv file. If either count is non-zero, stop and report.

- [ ] **Step 2: Baseline `astro check` on master, then branch**

```bash
cd /c/Users/robert/source/repos/sea-company && npx astro check 2>&1 | tail -3
```
Write down the `Result (N files): - X errors` line. Step 11 must not exceed X.

```bash
git -C /c/Users/robert/source/repos/sea-company switch -c cutover/switch master
```
Expected: `Switched to a new branch 'cutover/switch'`.

- [ ] **Step 3: Swap the widget package (R22, G6)**

`.npmrc` is removed first, so npm never resolves its `${NODE_AUTH_TOKEN}` line. Then the tarball is installed `--no-save`, BEFORE `package.json` is edited by hand (G6).

```bash
cd /c/Users/robert/source/repos/sea-company && git rm -q .npmrc && npm install --no-save /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
```

```bash
cd /c/Users/robert/source/repos/sea-company && node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f,'utf8'));delete p.dependencies['@robooko/sidon-booking-widget'];p.dependencies['@forgebuild/sidon-booking-widget']='^1.1.0';p.dependencies=Object.fromEntries(Object.entries(p.dependencies).sort(([a],[b])=>a.localeCompare(b)));require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
```

```bash
cd /c/Users/robert/source/repos/sea-company && node -p "require('./node_modules/@forgebuild/sidon-booking-widget/package.json').version" && git diff package.json && git status --short
```
Expected:
- The version prints `1.1.0`.
- The diff is exactly `-    "@robooko/sidon-booking-widget": "^0.4.16",` and `+    "@forgebuild/sidon-booking-widget": "^1.1.0",`, with the new line directly after `"@astrojs/vercel"`.
- Status shows `D  .npmrc` and ` M package.json`, and NOT `package-lock.json`. (Git may warn about LF → CRLF; that's harmless.)

- [ ] **Step 4: The forwarder (R23)**

Create `src/pages/api/marina/guest/[...path].ts` with the contract's exact text. Its static segments outrank the root `src/pages/[...slug].astro` rest route.

```ts
// OTA's guest API for the booking widget, with this site's property key
// added server-side (the browser never sees it). Only /api/marina/guest/*.
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Astro reads this flag from this file's source text, so it can't come
// from the package.
export const prerender = false;

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;

// Kill switch: without both env vars booking is hidden, and this answers
// one clear JSON 503 instead of a proxy with no key (404 for every slug).
const proxy = otaBaseUrl && apiKey
  ? createMarinaProxy({ otaBaseUrl, keys: apiKey })
  : () => new Response(JSON.stringify({ error: 'Online booking is not available' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

export const GET = proxy;
export const POST = proxy;
```

- [ ] **Step 5: Rewrite `src/lib/marina-api.ts` on the lazy client (R28, G7)**

Replace the whole file. The old `fromPrice`, `stripePublishableKey`, `berthId`, `overlayId`, `status`, `beamM`, `depthM`, `rotation` and `ownerId` fields are read nowhere else (`rg` in Step 11 confirms), so the types keep only what the price grid and the weather strip read.

```ts
// OTA's guest API for Fox Mooring and Pevero Mooring, read at build time
// (every marina page is prerendered). Both marinas sit on one OTA property
// ("SEA Company"), so one key serves both slugs. OTA returns snake_case
// with NUMERIC columns as strings; this keeps the camelCase shape the
// price grid already reads.
import { createMarinaClient } from '@forgebuild/sidon-booking-widget/astro-proxy';

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;
// Kill switch: no env -> no client (createMarinaClient throws on empty
// values), so a deploy without the key builds with booking hidden instead
// of failing.
const client = otaBaseUrl && apiKey ? createMarinaClient({ otaBaseUrl, keys: apiKey }) : null;
export const bookingEnabled = client !== null;

export interface MarinaProfile {
  slug: string;
  name: string;
  lat: number | null;
  lng: number | null;
  /** Upper-case ISO code from OTA, e.g. 'EUR'. */
  currency: string | null;
}

export interface Berth {
  label: string;
  pricePerNight: string | null;
  priceMode: 'per_metre' | 'fixed';
  lengthM: string | null;
}

export interface PriceTier {
  validFrom: string;
  validTo: string;
  maxLenM: number;
  pricePerNight: number;
}

export interface MarinaData {
  profile: MarinaProfile;
  berths: Berth[];
  priceTiers: PriceTier[];
}

// The fields of OTA's guest map payload (GET /api/marina/guest/:slug) this
// site reads.
interface OtaMarina {
  marina: { slug: string; name: string; lat: number | null; lng: number | null };
  berths: { label: string; price_per_night: string | null; price_mode: 'per_metre' | 'fixed'; length_m: string | null }[];
  price_tiers: { valid_from: string; valid_to: string; max_length_m: string; price_per_night: string }[];
  currency: string;
}

const toMarinaData = (d: OtaMarina): MarinaData => ({
  profile: { slug: d.marina.slug, name: d.marina.name, lat: d.marina.lat, lng: d.marina.lng, currency: d.currency },
  berths: d.berths.map((b) => ({ label: b.label, pricePerNight: b.price_per_night, priceMode: b.price_mode, lengthM: b.length_m })),
  priceTiers: d.price_tiers.map((t) => ({
    validFrom: t.valid_from,
    validTo: t.valid_to,
    maxLenM: Number(t.max_length_m),
    pricePerNight: Number(t.price_per_night),
  })),
});

// Once per build: each marina's pages × 4 locales would otherwise refetch
// the same payload (and share one 100/min OTA bucket).
const marinas = new Map<string, Promise<MarinaData | null>>();

/** One marina's live profile, berths and tiers; null when booking is off
    (no env) or OTA has no such slug. Callers then show VHF/phone. */
export function getMarina(slug: string): Promise<MarinaData | null> {
  if (!client) return Promise.resolve(null);
  let hit = marinas.get(slug);
  if (!hit) {
    hit = client.getMarina(slug).then((d: OtaMarina | null) => (d ? toMarinaData(d) : null));
    marinas.set(slug, hit);
  }
  return hit;
}
```

- [ ] **Step 6: `src/lib/home-page-data.ts` reads by slug**

The function's own `slug` argument (`fox-mooring` / `pevero-mooring`) is the OTA slug. OTA's currency is upper-case, but `CURRENCY_SYMBOLS` has lower-case keys.

Old (`:37-45`):
```ts
  if (page && m.ownerId) {
    const marinaApiData = await getMarina(m.ownerId);
    if (marinaApiData.profile.lat != null && marinaApiData.profile.lng != null) {
      weatherProfile = { lat: marinaApiData.profile.lat, lng: marinaApiData.profile.lng };
    }
    priceGridBerths = marinaApiData.berths;
    priceGridTiers = marinaApiData.priceTiers;
    priceGridCurrencySymbol = currencySymbol(marinaApiData.profile.currency);
  }
```
New:
```ts
  // null when booking is off (no OTA env) or OTA has no such marina: the
  // price grid and weather strip then render nothing.
  const marinaApiData = page ? await getMarina(slug) : null;
  if (marinaApiData) {
    if (marinaApiData.profile.lat != null && marinaApiData.profile.lng != null) {
      weatherProfile = { lat: marinaApiData.profile.lat, lng: marinaApiData.profile.lng };
    }
    priceGridBerths = marinaApiData.berths;
    priceGridTiers = marinaApiData.priceTiers;
    // OTA sends 'EUR'; CURRENCY_SYMBOLS is keyed lower-case.
    priceGridCurrencySymbol = currencySymbol(marinaApiData.profile.currency?.toLowerCase());
  }
```

- [ ] **Step 7: Booking blocks drop `api-origin` and `currency-symbol` (R24)**

Replace the whole of `src/components/marina-page/BookingMapBlock.astro`:

```astro
---
// Renders <sidon-berth-map> (@forgebuild/sidon-booking-widget's map +
// quick-book card custom element) in a page's bookingMapBlock section
// (Sanity page-builder block, so this can appear on any page - not just
// the home page). The element fetches its own live berth/marina data from
// OTA through this site's same-origin /api/marina/guest forwarder (the key
// is added server-side), so this component owns no content of its own
// beyond brand colours and the marina's "book" page href. No
// currency-symbol: amounts format in the OTA property's currency (Intl).
// As of widget 0.4.3, the bundled quick-book card
// renders marina.mapCard's eyebrow/title/intro/label copy itself (eyebrow/
// card-title/intro/range-label/range-placeholder/length-label/
// selected-label/selected-placeholder/cta-label attributes) — this
// component just threads mapCard's fields straight through, same as the
// brand colours below. map-height (0.4.5+) is set well above the card's
// own height so the map reads as a backdrop the card floats over, rather
// than being clipped to match the card's (variable, copy-dependent)
// height. The widget import lives in the client <script> below, not up
// here — its top-level `customElements.define()` needs `HTMLElement`,
// which doesn't exist during Astro's server-side prerendering.
export interface MapCard {
  eyebrow?: string;
  title?: string;
  intro?: string;
  rangeLabel?: string;
  rangePlaceholder?: string;
  lengthLabel?: string;
  selectedLabel?: string;
  selectedPlaceholder?: string;
  ctaLabel?: string;
}
export interface Props {
  /** OTA marina slug (fox-mooring / pevero-mooring). */
  slug: string;
  mapsKey?: string;
  navy: string;
  gold: string;
  ink?: string;
  logoMark?: string | null;
  marinaName?: string;
  currentLocale?: string;
  bookHref: string;
  mapCard?: MapCard;
}

const { slug, mapsKey, navy, gold, ink, logoMark, marinaName, currentLocale, bookHref, mapCard } = Astro.props;
---

{slug && mapsKey && (
  <div id="hero-scroll-target">
    <sidon-berth-map
      marina={slug}
      maps-api-key={mapsKey}
      map-style="chart"
      map-height="900px"
      show-weather
      locale={currentLocale}
      book-path={bookHref}
      logo-mark={logoMark}
      marina-name={marinaName}
      eyebrow={mapCard?.eyebrow}
      card-title={mapCard?.title}
      intro={mapCard?.intro}
      range-label={mapCard?.rangeLabel}
      range-placeholder={mapCard?.rangePlaceholder}
      length-label={mapCard?.lengthLabel}
      selected-label={mapCard?.selectedLabel}
      selected-placeholder={mapCard?.selectedPlaceholder}
      cta-label={mapCard?.ctaLabel}
      style={`--brand-navy: ${navy}; --brand-gold: ${gold}; --brand-ink: ${ink ?? navy}; --brand-font-title: 'Teko', sans-serif; --brand-font-body: 'Hind', sans-serif;`}
    ></sidon-berth-map>
  </div>
)}

<script>
  import '@forgebuild/sidon-booking-widget/berth-map';
</script>
```

Replace the whole of `src/components/marina-page/BookingWidgetBlock.astro`:

```astro
---
// Embeds @forgebuild/sidon-booking-widget — the real Stripe-backed booking
// flow, talking to OTA through this site's same-origin /api/marina/guest
// forwarder — as a page-builder section (Sanity bookingWidgetBlock, so this
// can appear on any page). Owns no content of its own; everything comes
// from already-fetched marina data, same spirit as BookingMapBlock. No
// currency-symbol: amounts format in the OTA property's currency (Intl).
//
// Uses the widget's own built-in map (maps-api-key/map-style, no separate
// on/off prop - "map is only rendered when maps-api-key is set"). As of
// 0.4.13, .sbw-map-slot sits outside the widget's rounded/shadowed card
// (.sbw-root) specifically so map-width="100vw" can break out full-bleed
// via the standard centered-ancestor escape trick, instead of being
// clipped to the card's own width. map-height/map-width/map-gap/width
// are set to match sidonmarine.uk's own /book reference page's actual
// measurements (verified by inspecting its DOM directly - that page isn't
// even using the npm widget, it's hand-rolled: full-width 50vh map
// section, separate flat non-rounded 680px summary card below).
export interface Props {
  /** OTA marina slug (fox-mooring / pevero-mooring). */
  slug: string;
  locale?: string;
  navy: string;
  gold: string;
  ink?: string;
  logoMark?: string | null;
  marinaName?: string;
  center?: { lat: number; lng: number } | null;
  mapsKey?: string;
}
const {
  slug, locale = 'en', navy, gold, ink,
  logoMark, marinaName, mapsKey,
} = Astro.props;
---

<section class="relative bg-white px-0 md:px-10 pb-3 md:pb-14">
  <div class="relative max-w-[680px] mx-auto">
    <sidon-booking-widget
      marina={slug}
      locale={locale}
      variant="dark"
      maps-api-key={mapsKey}
      map-style="chart"
      map-height="50vh"
      map-width="100vw"
      map-gap="24px"
      width="680px"
      logo-mark={logoMark}
      marina-name={marinaName}
      style={`--brand-navy: ${ink ?? navy}; --brand-gold: ${gold}; --brand-ink: ${ink ?? navy};`}
    ></sidon-booking-widget>
  </div>
</section>

{/* Same quick-book handoff as book.astro: this section can render on a
    prerendered page, so Astro.url.searchParams in frontmatter is always
    empty — read the real query string client-side instead, before the
    widget module below upgrades the element. */}
<script>
  const el = document.querySelector('sidon-booking-widget');
  if (el) {
    const params = new URLSearchParams(window.location.search);
    for (const key of ['from', 'to', 'length', 'berth']) {
      const value = params.get(key);
      if (value) el.setAttribute(key, value);
    }
  }
</script>
<script>
  import '@forgebuild/sidon-booking-widget';
</script>
```

- [ ] **Step 8: `PageSections` takes `marinaSlug` and shows the G7 fallback; `RoutedPageBody` passes it**

SEA has no VHF/phone fallback today: the blocks simply render nothing when `ownerId` is empty. This adds one, in the one place that dispatches both booking blocks. It uses the content's required `vhf`/`phone`/`phoneLink` fields (`vhf` is like `CH. 15`, and `phoneLink` is bare digits like `+39078996028`). The text is language-neutral, so it needs no per-locale copy.

Replace the whole of `src/components/marina-page/PageSections.astro`:

```astro
---
import HeroBlock from './HeroBlock.astro';
import BookingTeaserBlock from './BookingTeaserBlock.astro';
import PriceGridBlock from './PriceGridBlock.astro';
import BookingMapBlock from './BookingMapBlock.astro';
import BookingWidgetBlock from './BookingWidgetBlock.astro';
import { bookingEnabled } from '../../lib/marina-api';
import type { PageSection } from '../../lib/page-content';

interface Berth {
  lengthM: number | string | null;
  pricePerNight: number | string | null;
  priceMode: string | null;
}
interface PriceTier {
  validFrom: string;
  validTo: string;
}
interface MapCard {
  eyebrow?: string;
  title?: string;
  intro?: string;
  rangeLabel?: string;
  rangePlaceholder?: string;
  lengthLabel?: string;
  selectedLabel?: string;
  selectedPlaceholder?: string;
  ctaLabel?: string;
}

export interface Props {
  sections: PageSection[];
  /** The marina content slug, which is also its OTA slug. */
  marinaSlug: string;
  marina: {
    name: string;
    locale?: string;
    phone?: string;
    phoneLink?: string;
    vhf?: string;
    coordinates?: { lat: string; lng: string };
    brand?: { navy: string; gold: string; ink?: string };
    logoMark?: string;
    mapCard?: MapCard;
  };
  profile?: { lat: number; lng: number } | null;
  berthsHref: string;
  bookHref: string;
  berths?: Berth[];
  priceTiers?: PriceTier[];
  currencySymbol?: string;
  mapsKey?: string;
}
const { sections, marinaSlug, marina, profile, berthsHref, bookHref, berths = [], priceTiers = [], currencySymbol, mapsKey } = Astro.props;
---

{sections.map((section) => {
  if (section._type === 'heroBlock') {
    return (
      <HeroBlock
        marina={marina}
        profile={profile}
        image={section.image}
        subtitleFallback={section.subtitleFallback}
        scrollHint={section.scrollHint}
        coordLabel={section.coordLabel}
        contactLabel={section.contactLabel}
      />
    );
  }
  // Kill switch (no OTA env at build): no widget; the marina's VHF channel
  // and phone instead, so a deploy missing the key still tells sailors how
  // to book.
  if (!bookingEnabled && (section._type === 'bookingMapBlock' || section._type === 'bookingWidgetBlock')) {
    return (
      <section
        id={section._type === 'bookingMapBlock' ? 'hero-scroll-target' : undefined}
        data-booking-fallback
        class="bg-white py-14 md:py-20"
      >
        <div class="max-w-[680px] mx-auto px-5 md:px-10 flex flex-col items-center text-center gap-2 font-[Hind] text-[20px] md:text-[26px] font-medium text-[#0b1927]">
          {marina.vhf && <p>VHF {marina.vhf}</p>}
          {marina.phone && <a href={`tel:${marina.phoneLink ?? marina.phone}`} class="text-[#0b1927] no-underline">{marina.phone}</a>}
        </div>
      </section>
    );
  }
  if (section._type === 'bookingMapBlock') {
    return (
      <BookingMapBlock
        slug={marinaSlug}
        mapsKey={mapsKey}
        navy={marina.brand?.navy ?? ''}
        gold={marina.brand?.gold ?? ''}
        ink={marina.brand?.ink}
        logoMark={marina.logoMark}
        marinaName={marina.name}
        currentLocale={marina.locale}
        bookHref={bookHref}
        mapCard={marina.mapCard}
      />
    );
  }
  if (section._type === 'priceGridBlock') {
    return (
      <PriceGridBlock
        berths={berths}
        tiers={priceTiers}
        locale={marina.locale}
        currencySymbol={currencySymbol}
        eyebrow={section.eyebrow}
        heading={section.heading}
        footnote={section.footnote}
      />
    );
  }
  if (section._type === 'bookingWidgetBlock') {
    return (
      <BookingWidgetBlock
        slug={marinaSlug}
        locale={marina.locale}
        navy={marina.brand?.navy ?? ''}
        gold={marina.brand?.gold ?? ''}
        ink={marina.brand?.ink}
        logoMark={marina.logoMark}
        marinaName={marina.name}
        center={profile}
        mapsKey={mapsKey}
      />
    );
  }
  if (section._type === 'bookingTeaserBlock') {
    return (
      <BookingTeaserBlock
        href={berthsHref}
        eyebrow={section.eyebrow}
        headline={section.headline}
        ctaLabel={section.ctaLabel}
      />
    );
  }
  return null;
})}
```

`src/components/marina-page/RoutedPageBody.astro`. Old:
```astro
      <PageSections
        sections={result.data.page.sections}
        marina={result.data.m}
```
New:
```astro
      <PageSections
        sections={result.data.page.sections}
        marinaSlug={result.marina}
        marina={result.data.m}
```

- [ ] **Step 9: The booking page (R23, G8, G12)**

Create `src/pages/booking.astro`. The static `booking.astro` outranks `[...slug].astro`, and no Sanity `page` has the slug `booking`. Being SSR, it is not listed by `@astrojs/sitemap`.

```astro
---
// OTA's guest emails and confirm link land here with
// ?marina=&booking=&token=. Bare on purpose (no site layout, analytics or
// fonts): the token is in the URL. One page serves both marinas (one OTA
// property, one key); ?marina= picks the slug, and only these two are
// served, so the page can't be pointed at anything else.
import { getMarinaContent } from '../lib/marina-content';

export const prerender = false;
Astro.response.headers.set('Referrer-Policy', 'no-referrer');

const MARINAS = ['fox-mooring', 'pevero-mooring'];
const slug = Astro.url.searchParams.get('marina') ?? '';
if (!MARINAS.includes(slug)) return new Response('Not found', { status: 404 });
const entry = await getMarinaContent(slug);
if (!entry) return new Response('Not found', { status: 404 });
const m = entry.data;
// Same brand vars as BookingWidgetBlock, so the booking view matches /book.
const brandStyle = `--brand-navy: ${m.brand.ink ?? m.brand.navy}; --brand-gold: ${m.brand.gold}; --brand-ink: ${m.brand.ink ?? m.brand.navy};`;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>{`Your booking — ${m.name}`}</title>
  </head>
  <body>
    <main style="max-width:680px;margin:0 auto;padding:24px 0">
      <sidon-booking-widget marina={slug} booking-id variant="dark" marina-name={m.name} logo-mark={m.logoMark} style={brandStyle}></sidon-booking-widget>
    </main>
    <script>import '@forgebuild/sidon-booking-widget';</script>
  </body>
</html>
```

- [ ] **Step 10: `.env.example` and `CLAUDE.md` (R21)**

Replace the whole of `.env.example`:

```
# OTA — live marina data (berths, pricing) and booking for both Fox Mooring
# and Pevero Mooring. Both sit on one OTA property ("SEA Company"), so one
# key serves both slugs. Server-only: read at build time by
# src/lib/marina-api.ts (price grid, weather position) and at request time
# by the /api/marina/guest/* forwarder. Leave either empty to hide booking:
# the booking blocks then show the marina's VHF channel and phone. Set both
# in Vercel for Production AND Preview (the build reads them); a change
# takes effect only after a redeploy.
OTA_BASE_URL=
OTA_API_KEY=

# Google Maps JavaScript API key — powers BerthsGoogleMap.astro. Neither
# Puerto Portals (Mapbox) nor pirates-bight has an equivalent; this is a
# new key this project needs to provision.
PUBLIC_GOOGLE_MAPS_API_KEY=

# Sanity — content for both marinas (Plan 4). Provisioned via the Vercel
# Sanity integration; pull real values with `vercel env pull`. Server-side
# only — no PUBLIC_ prefix needed: the marina pages read at build time
# (prerender=true) and /booking at request time, never in the browser.
SANITY_API_PROJECT_ID=
SANITY_API_DATASET=production
SANITY_API_READ_TOKEN=

# Note: no STRIPE_* vars here — card payment runs on OTA, which hands the
# widget its own publishable key. sea-company never holds a Stripe secret
# key.
```

`CLAUDE.md`. Old:
```
- **Booking**: Stripe via sidon-ai's Connect account — no Stripe secret
  key held here.
```
New:
```
- **Booking**: `@forgebuild/sidon-booking-widget` on OTA's guest API,
  through this site's forwarder (`src/pages/api/marina/guest/[...path].ts`,
  key added server-side). OTA's emails link to `/booking?marina=<slug>&booking=&token=`
  (`src/pages/booking.astro`, `fox-mooring` | `pevero-mooring` only).
  Card payment runs on OTA — no Stripe secret key held here.
```
Old (the paragraph under `### Environment`, up to `never by the deployed app.`):
```
Requires 6 env vars to run: `SIDON_URL`, `PUBLIC_SIDON_ORIGIN`,
`PUBLIC_GOOGLE_MAPS_API_KEY`, `SANITY_API_PROJECT_ID`, `SANITY_API_DATASET`,
`SANITY_API_READ_TOKEN` — see `.env.example` for details on each. The
Sanity vars are server-side only (build-time reads inside `prerender = true`
pages), no `PUBLIC_` prefix needed.
```
New:
```
Requires `PUBLIC_GOOGLE_MAPS_API_KEY`, `SANITY_API_PROJECT_ID`,
`SANITY_API_DATASET`, `SANITY_API_READ_TOKEN`, plus `OTA_BASE_URL` +
`OTA_API_KEY` for booking — see `.env.example` for details on each. One
OTA key serves both marinas (one OTA property). Without both OTA vars the
site still builds: booking is hidden, the booking blocks show VHF/phone and
the forwarder answers 503. The OTA vars must be in Vercel's build env
(Production and Preview); env changes need a redeploy. The Sanity and OTA
vars are server-side only, no `PUBLIC_` prefix needed.
```
Leave the rest of the paragraph (the `studio-sea-company/` sentence) unchanged.

- [ ] **Step 11: Leftover scan and type check**

```bash
cd /c/Users/robert/source/repos/sea-company && rg -n "robooko|SIDON_URL|PUBLIC_SIDON_ORIGIN|api-origin|currency-symbol|ownerId|fromPrice|stripePublishableKey" src .env.example CLAUDE.md package.json
```
Expected: only `src/lib/marina-content.ts:9` and `:63` (`ownerId`, the unused Sanity field, left in place; dropping it from the studio schema is not this task).

```bash
cd /c/Users/robert/source/repos/sea-company && npx astro check 2>&1 | tail -3
```
Expected: the error count is ≤ the Step 2 baseline.

- [ ] **Step 12: Verify against local OTA (contract procedure; `<slug>` = `fox-mooring` and `pevero-mooring`, port 4321, scheme http)**

Each line below is one Bash call. The key is re-derived in the same call and never echoed. Both slugs share the one "Marina Demo" property and key (G11), just as Fox and Pevero will share SEA Company's.

```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=fox-mooring node scripts/seed-marina-demo.js | grep -v '^api_key='
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=pevero-mooring node scripts/seed-marina-demo.js | grep -v '^api_key='
```
Expected: the last lines are `slug=fox-mooring` and `slug=pevero-mooring`.

Local OTA (`run_in_background`):
```bash
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start
```

Build with env. The price grid fills from OTA, and the widgets render without `api-origin`/`currency-symbol`:
```bash
cd /c/Users/robert/source/repos/sea-company && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=fox-mooring node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npm run build 2>&1 | tail -3
cd /c/Users/robert/source/repos/sea-company && grep -c 'Average / night' dist/client/berths/index.html dist/client/pevero-mooring-berths/index.html; grep -c '<sidon-berth-map' dist/client/berths/index.html dist/client/pevero-mooring-berths/index.html; grep -c '<sidon-booking-widget' dist/client/book/index.html dist/client/pevero-mooring-book/index.html; grep -c 'api-origin\|currency-symbol\|data-booking-fallback' dist/client/berths/index.html dist/client/book/index.html; grep -c '/booking' dist/client/sitemap-0.xml
```
Expected:
- The build ends with `Complete!`.
- `Average / night` → 1 on both berths pages.
- `<sidon-berth-map` → 1 on both berths pages.
- `<sidon-booking-widget` → 1 on both book pages.
- `api-origin|currency-symbol|data-booking-fallback` → 0 on both pages.
- Sitemap `/booking` → 0. If it isn't 0, add `sitemap({ filter: (p) => !p.includes('/booking') })` in `astro.config.mjs`, include that file in the commit, rebuild and re-check.

Build without env (kill switch, Review Focus 5):
```bash
cd /c/Users/robert/source/repos/sea-company && OTA_BASE_URL= OTA_API_KEY= npm run build 2>&1 | tail -3
cd /c/Users/robert/source/repos/sea-company && grep -c '<sidon-' dist/client/berths/index.html dist/client/pevero-mooring-berths/index.html dist/client/book/index.html dist/client/pevero-mooring-book/index.html; grep -c 'data-booking-fallback' dist/client/berths/index.html dist/client/pevero-mooring-berths/index.html dist/client/book/index.html dist/client/pevero-mooring-book/index.html; grep -c 'Average / night' dist/client/berths/index.html; grep -o 'VHF [^<]*' dist/client/berths/index.html | head -1
```
Expected:
- The build ends with `Complete!`.
- `<sidon-` → 0 on all four pages.
- `data-booking-fallback` → 1 on all four pages.
- `Average / night` → 0.
- One `VHF CH. …` line prints.

Dev server with env (`run_in_background`):
```bash
cd /c/Users/robert/source/repos/sea-company && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=fox-mooring node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npx astro dev --port 4321
```

Forwarder, both slugs:
```bash
curl -s http://localhost:4321/api/marina/guest/fox-mooring | head -c 300; echo; curl -s http://localhost:4321/api/marina/guest/pevero-mooring | head -c 300
```
Expected: two JSON bodies, each starting `{"marina":{"name":…` with `"slug":"fox-mooring"` and `"slug":"pevero-mooring"` respectively.

Hold through the forwarder, then the booking page (Review Focus 4). The token stays in a shell variable and is never printed:
```bash
R=$(curl -s -X POST http://localhost:4321/api/marina/guest/fox-mooring/bookings -H 'Content-Type: application/json' -d "{\"berth_label\":\"A2\",\"arrival\":\"$(date -d '+30 days' +%F)\",\"departure\":\"$(date -d '+32 days' +%F)\",\"contact_name\":\"Plan D\",\"contact_email\":\"plan-d+sea@example.com\",\"boat_name\":\"Check\",\"boat_length_m\":9}"); ID=$(node -pe 'JSON.parse(process.argv[1]).booking.id' "$R"); TOKEN=$(node -pe 'JSON.parse(process.argv[1]).booking_token' "$R"); echo "booking $ID"; curl -s -D /tmp/sea-h.txt -o /tmp/booking.html "http://localhost:4321/booking?marina=fox-mooring&booking=$ID&token=$TOKEN"; head -1 /tmp/sea-h.txt; grep -i '^referrer-policy' /tmp/sea-h.txt; grep -c 'sidon-booking-widget' /tmp/booking.html; grep -c 'content="no-referrer"' /tmp/booking.html; grep -c 'noindex' /tmp/booking.html; grep -c 'marina="fox-mooring"' /tmp/booking.html; grep -c 'api-origin\|currency-symbol\|locale=' /tmp/booking.html
```
Expected:
- `booking <uuid>`, then `HTTP/1.1 200 OK` and `Referrer-Policy: no-referrer`.
- The four `grep -c` counts are each ≥ 1.
- The last count is 0: no `api-origin`, no `currency-symbol` and no `locale` (G12).
- A JSON parse error means the POST answered 409 because a previous run's hold still occupies A2. Re-run with `"berth_label":"A4"`.

Whitelist (G8):
```bash
for q in 'marina=pevero-mooring&booking=x&token=y' 'marina=other&booking=x&token=y' 'booking=x&token=y'; do curl -s -o /dev/null -w "%{http_code} $q\n" "http://localhost:4321/booking?$q"; done
```
Expected: `200 marina=pevero-mooring…`, `404 marina=other…`, `404 booking=x…`.

Kill-switch dev. Stop the dev server (TaskStop its background task), then start it again without env (`run_in_background`):
```bash
cd /c/Users/robert/source/repos/sea-company && OTA_BASE_URL= OTA_API_KEY= npx astro dev --port 4321
```
```bash
curl -s -w ' %{http_code}\n' http://localhost:4321/api/marina/guest/fox-mooring; curl -s http://localhost:4321/berths | grep -c '<sidon-'; curl -s http://localhost:4321/berths | grep -c 'data-booking-fallback'
```
Expected: `{"error":"Online booking is not available"} 503`, then `0`, then `1`.

Finally, stop the dev server and the local OTA server (TaskStop both background tasks).

- [ ] **Step 13: Commit on `cutover/switch` (no push)**

`.npmrc`'s deletion is already staged by `git rm`. `package-lock.json` stays out (G6: the runbook commits it after `npm publish`). `dist/` is gitignored.

```bash
cd /c/Users/robert/source/repos/sea-company && git add package.json 'src/pages/api/marina/guest/[...path].ts' src/pages/booking.astro src/lib/marina-api.ts src/lib/home-page-data.ts src/components/marina-page/BookingMapBlock.astro src/components/marina-page/BookingWidgetBlock.astro src/components/marina-page/PageSections.astro src/components/marina-page/RoutedPageBody.astro .env.example CLAUDE.md && git status --short
```
Expected: the 11 paths above plus `D  .npmrc` are staged; nothing else is staged; `package-lock.json` is not listed. If Step 12 had to add the sitemap filter, also `git add astro.config.mjs`.

```bash
cd /c/Users/robert/source/repos/sea-company && git commit -m "Switch Fox + Pevero booking to OTA (widget 1.1, forwarder, /booking)

- @robooko/sidon-booking-widget -> @forgebuild/sidon-booking-widget ^1.1.0;
  .npmrc (GitHub Packages only) removed. Lockfile follows after npm publish.
- /api/marina/guest/* forwarder adds the SEA Company property key
  server-side; one key serves fox-mooring and pevero-mooring.
- /booking?marina=fox-mooring|pevero-mooring&booking=&token= (anything
  else 404): bare SSR page, no-referrer header + meta, noindex.
- Build-time price grid reads OTA through a lazy createMarinaClient,
  mapped to the existing camelCase types; blocks pass the content slug.
- No api-origin / currency-symbol: amounts use the property currency.
- Kill switch: without OTA_BASE_URL + OTA_API_KEY the build succeeds,
  booking blocks show VHF/phone and the forwarder answers 503.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git log --oneline -1 && git status --short
```
Expected: one new commit on `cutover/switch`. Status is empty except ` M package-lock.json` if npm touched it (it shouldn't with `--no-save`); never stage it. Leave SEA on `cutover/switch`.

Later, the runbook (not this task) does the rest, each with the user's go-ahead:
- After `npm publish`, runs `npm install` on this branch and commits `package-lock.json`.
- Sets `OTA_BASE_URL`/`OTA_API_KEY` in Vercel (Production and Preview) and redeploys.
- Pushes and opens the PR, merges at Step 6.
- Sets both marinas' `booking_url` to `<origin>/booking?marina=<slug>&booking={id}&token={token}`.
- Removes `SIDON_URL`/`PUBLIC_SIDON_ORIGIN` from Vercel.

---

### Task 8: portals (Puerto Portals) cutover/switch

**Repo / branch:** PO = `C:/Users/robert/source/repos/portals`. It has no git remote and no Vercel project. Branch `cutover/switch` is cut from local `master` (`2dc07ea` at survey time). The task ends with one commit on that branch. Nothing is pushed, no repo is created (R2: `gh repo create robooko/portals --private --source . --push` is a runbook step), and nothing is deployed.

**Files:**
- Create: `src/pages/api/marina/guest/[...path].ts`. This is the forwarder, using the contract's exact text. `src/pages/api/` already exists, empty and untracked.
- Create: `src/pages/booking.astro`. This is the bare booking page.
- Modify (whole file): `src/lib/marina-api.ts` (103 lines). It becomes a lazy `createMarinaClient` adapter.
- Modify (whole file): `src/components/pages/BerthsPageBody.astro` (93 lines). Null means fallback, the slug comes from `MARINA_SLUG`, and the Stripe/brandNavy props go.
- Modify: `src/components/BerthsMap.astro`, at the `marinaId` prop (`:8`, `:30`), `data-marina-id` (`:57`), the `SIDON_ORIGIN` block (`:130-133`), `const marinaId` (`:141`), `overlayForBerth` (`:192`), the live fetch (`:520-523`) and the `fromPrice` pill (`:536-538`).
- Modify: `src/components/BerthsSizeBar.astro`, at the frontmatter types/props (`:13-42`), the `[data-book-flow]` attributes (`:237-254`), step 1 uploads (`:268-286`), the payment and contract rows (`:299-335`), the step 3 summary/QR (`:344-356`), `SIDON_ORIGIN` (`:561-564`), `showFlowStep` (`:876-881`), the upload helpers (`:883-1001`), `submitBooking` + `wirePayment` + `wireContractGate` + `paintStep2Validation` (`:1158-1587`) and the flow wiring (`:1588-1637`).
- Modify: `astro.config.mjs:12`, the sitemap filter.
- Modify: `package.json`, in `dependencies` and `devDependencies`.
- Modify: `.env.example`, rewritten.
- Modify: `CLAUDE.md:9,13-15,34-35,47,55`. These are stale Sidon instructions that would mislead the next agent.
- Not committed: `package-lock.json` (G6), `.env` (gitignored).

Line numbers are from `master` at survey time. Find each edit point by the quoted code markers.

**Interfaces:**
- Consumes:
  - `createMarinaProxy` and `createMarinaClient` from `@forgebuild/sidon-booking-widget/astro-proxy` (W 1.1.0 tarball `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz`).
  - `<sidon-booking-widget booking-id>` from `@forgebuild/sidon-booking-widget`.
  - OTA's guest map payload, `GET .../availability?arrival&departure&boat_length_m[&boat_beam_m]` → `{ label, pontoon_id, length_m, ... }[]`, and `POST .../bookings` → `201 { booking: { id }, booking_token, payment }` / `{ error }`, exactly as the contract specifies.
  - O demo seed with `MARINA_DEMO_SLUG=puerto-portals` (Task 5).
- Produces:
  - `src/lib/marina-api.ts`: `export const MARINA_SLUG = 'puerto-portals'`, `export const bookingEnabled: boolean` and `getMarina(): Promise<MarinaData | null>` (null when booking is off or OTA 404s).
  - `getDocRequirements(): Promise<DocRequirement[]>`.
  - Types `MarinaProfile { slug, ... }`, `Berth { overlayId: string | null, ... }`, `Overlay { id: string, ... }`, `PriceTier { maxBeamM, pricePerMonth, pricePerYear, ... }` and `DocRequirement { id: string, fields, ... }`.
  - The forwarder at `/api/marina/guest/*`. PO's `booking_url` = `<origin>/booking?booking={id}&token={token}` (the runbook sets it at Step 6).

- [ ] **Step 1: Gates (W version, tarball, clean tree), baseline check, branch**

```bash
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"   # must print 1.1.0, else STOP (plan C not done)
ls C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz                                     # else build it per the contract's tarball block (Task 5 does this once)
git -C /c/Users/robert/source/repos/portals status --short                                    # must print nothing, else STOP and report
cd /c/Users/robert/source/repos/portals && npx astro check 2>&1 | tail -3                     # baseline on master: note the "N errors" count
git -C /c/Users/robert/source/repos/portals switch -c cutover/switch master
```

Expected: `1.1.0`, the tarball is listed, the status is empty, the astro check summary is recorded (call it `BASE_ERRORS`), and `Switched to a new branch 'cutover/switch'`.

- [ ] **Step 2: Install the widget from the tarball (G6), then hand-edit `package.json`**

```bash
cd /c/Users/robert/source/repos/portals && npm install --no-save C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
cd /c/Users/robert/source/repos/portals && node -p "require('./node_modules/@forgebuild/sidon-booking-widget/package.json').version"   # 1.1.0
```

Edit `package.json`. Add the widget, and remove the dependencies that lose their last importer in this task. `@stripe/stripe-js` goes with `wirePayment`. `qrcode` and `@types/qrcode` go with the step 3 QR block. `stripe` (server SDK) already has no importer under `src`, `astro.config.mjs` or `studio-portals`, because portals never held a Stripe secret. Step 9's `rg` re-proves all four.

old:
```json
    "@astrojs/vercel": "^10.0.1",
    "@sanity/client": "^7.17.0",
    "@sanity/image-url": "^2.1.1",
    "@stripe/stripe-js": "^9.12.1",
    "@tailwindcss/vite": "^4.2.1",
    "astro": "^6.0.4",
    "flatpickr": "^4.6.13",
    "mapbox-gl": "^3.22.0",
    "qrcode": "^1.5.4",
    "sharp": "^0.34.5",
    "stripe": "^22.4.0",
    "tailwindcss": "^4.2.1",
```
new:
```json
    "@astrojs/vercel": "^10.0.1",
    "@forgebuild/sidon-booking-widget": "^1.1.0",
    "@sanity/client": "^7.17.0",
    "@sanity/image-url": "^2.1.1",
    "@tailwindcss/vite": "^4.2.1",
    "astro": "^6.0.4",
    "flatpickr": "^4.6.13",
    "mapbox-gl": "^3.22.0",
    "sharp": "^0.34.5",
    "tailwindcss": "^4.2.1",
```
old:
```json
    "@astrojs/check": "^0.9.10",
    "@types/qrcode": "^1.5.6",
    "@types/three": "^0.184.0",
```
new:
```json
    "@astrojs/check": "^0.9.10",
    "@types/three": "^0.184.0",
```

Do not run `npm install`/`npm uninstall` again. The runbook refreshes and commits the lockfile after `npm publish`.

- [ ] **Step 3: Create the forwarder `src/pages/api/marina/guest/[...path].ts` (contract text, verbatim)**

```ts
// OTA's guest API for the booking widget, with this site's property key
// added server-side (the browser never sees it). Only /api/marina/guest/*.
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Astro reads this flag from this file's source text, so it can't come
// from the package.
export const prerender = false;

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;

// Kill switch: without both env vars booking is hidden, and this answers
// one clear JSON 503 instead of a proxy with no key (404 for every slug).
const proxy = otaBaseUrl && apiKey
  ? createMarinaProxy({ otaBaseUrl, keys: apiKey })
  : () => new Response(JSON.stringify({ error: 'Online booking is not available' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

export const GET = proxy;
export const POST = proxy;
```

- [ ] **Step 4: Rewrite `src/lib/marina-api.ts` (whole file)**

```ts
// Server-side reads of Puerto Portals' live berths, pricing and pontoons
// from OTA's guest API, with this site's property key (server-only env).
// OTA sends snake_case with NUMERIC columns as strings; this maps them onto
// the camelCase shapes BerthsMap, BerthsSizeBar and BerthsSeasonalPricing
// already take, so those components don't need to know about OTA.
import { createMarinaClient } from '@forgebuild/sidon-booking-widget/astro-proxy';

export const MARINA_SLUG = 'puerto-portals';

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;
// Kill switch: no env -> no client (createMarinaClient throws on empty
// values at module load, which would 500 every page that imports this).
const client = otaBaseUrl && apiKey ? createMarinaClient({ otaBaseUrl, keys: apiKey }) : null;
export const bookingEnabled = client !== null;

export interface MarinaProfile {
  slug: string;
  name: string;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  email: string | null;
}

export interface Berth {
  berthId: string;
  overlayId: string | null;
  pricePerNight: number | null;
  priceMode: 'per_metre' | 'fixed';
  status: 'available' | 'occupied';
  lat: number | null;
  lng: number | null;
  lengthM: number | null;
  beamM: number | null;
  depthM: number | null;
  rotation: number | null;
}

export interface Overlay {
  id: string;
  svgData: string;
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  rotation: number;
}

export interface PriceTier {
  validFrom: string;
  validTo: string; // inclusive, as OTA sends it
  maxLenM: number;
  maxBeamM: number | null;
  pricePerNight: number;
  pricePerMonth: number | null;
  pricePerYear: number | null;
}

export interface MarinaData {
  profile: MarinaProfile;
  berths: Berth[];
  overlays: Overlay[];
  priceTiers: PriceTier[];
  currency: string;
}

export interface DocRequirement {
  id: string;
  type: string;
  name: string;
  description: string | null;
  fields: { name: string; label: string; type: string }[];
  mandatory: boolean;
}

const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

// Berth layout, pricing and doc requirements change on the timescale of
// staff edits, not per visitor: a short TTL absorbs repeat page loads
// without going stale for long enough to matter.
const CACHE_TTL_MS = 60_000;
let marinaCache: { data: MarinaData; expires: number } | null = null;
let docReqCache: { data: DocRequirement[]; expires: number } | null = null;

/** Profile, berths, pontoon overlays and price tiers; null when booking is off or OTA has no such marina. */
export async function getMarina(): Promise<MarinaData | null> {
  if (!client) return null;
  if (marinaCache && marinaCache.expires > Date.now()) return marinaCache.data;
  const d = await client.getMarina(MARINA_SLUG);
  if (!d) return null;
  const marina: MarinaData = {
    profile: { slug: d.marina.slug, name: d.marina.name, lat: d.marina.lat, lng: d.marina.lng, phone: d.marina.phone, email: d.marina.email },
    berths: d.berths.map((b: any): Berth => ({
      berthId: b.label, overlayId: b.pontoon_id, pricePerNight: num(b.price_per_night), priceMode: b.price_mode,
      status: b.available ? 'available' : 'occupied', lat: b.lat, lng: b.lng,
      lengthM: num(b.length_m), beamM: num(b.beam_m), depthM: num(b.depth_m), rotation: b.rotation,
    })),
    overlays: d.pontoons.map((p: any): Overlay => ({
      id: p.id, svgData: p.svg_data ?? '', swLat: p.sw_lat, swLng: p.sw_lng, neLat: p.ne_lat, neLng: p.ne_lng, rotation: p.rotation ?? 0,
    })),
    priceTiers: d.price_tiers.map((t: any): PriceTier => ({
      validFrom: t.valid_from, validTo: t.valid_to, maxLenM: Number(t.max_length_m), maxBeamM: num(t.max_beam_m),
      pricePerNight: Number(t.price_per_night), pricePerMonth: num(t.price_per_month), pricePerYear: num(t.price_per_year),
    })),
    currency: d.currency,
  };
  marinaCache = { data: marina, expires: Date.now() + CACHE_TTL_MS };
  return marina;
}

/** What the marina asks guests for. Listed on the size bar's step 1; uploaded on /booking once the booking exists. */
export async function getDocRequirements(): Promise<DocRequirement[]> {
  if (!client) return [];
  if (docReqCache && docReqCache.expires > Date.now()) return docReqCache.data;
  const requirements: DocRequirement[] = (await client.getDocRequirements(MARINA_SLUG)) ?? [];
  docReqCache = { data: requirements, expires: Date.now() + CACHE_TTL_MS };
  return requirements;
}
```

- [ ] **Step 5: Rewrite `src/components/pages/BerthsPageBody.astro` (whole file)**

```astro
---
import Layout from '../../layouts/Layout.astro';
import BerthsMap from '../BerthsMap.astro';
import BerthsSizeBar from '../BerthsSizeBar.astro';
import WeatherBar from '../WeatherBar.astro';
import BerthsSeasonalPricing from '../BerthsSeasonalPricing.astro';
import { mergeContent } from '../../lib/content';
import { getLocalizedContent } from '../../lib/i18n-content';
import { getSiteSettings, getBerthsPage } from '../../lib/sanity';
import { getMarina, getDocRequirements, MARINA_SLUG, type MarinaData, type DocRequirement } from '../../lib/marina-api';
import type { Locale } from '../../lib/locale';

interface Props { locale: Locale }
const { locale } = Astro.props;

const [settings, berthsPage] = locale === 'en'
  ? await Promise.all([getSiteSettings(), getBerthsPage()])
  : [null, null];
const m = mergeContent(mergeContent(getLocalizedContent(locale), settings), berthsPage);

// OTA is a separate service: an outage, booking switched off (no
// OTA_BASE_URL/OTA_API_KEY) or a marina not yet on OTA must not 500 this
// page. Fall back to zero berths/pricing: the size bar then hides itself
// and the footer's VHF/phone is the way to book.
let live: MarinaData | null = null;
let docRequirements: DocRequirement[] = [];
try {
  [live, docRequirements] = await Promise.all([getMarina(), getDocRequirements()]);
} catch (err) {
  console.warn('[berths] OTA unreachable, rendering with no live data:', err);
}
const marina: MarinaData = live ?? {
  profile: { slug: m.slug, name: m.name, lat: m.geo.lat, lng: m.geo.lng, phone: m.phone, email: m.email },
  berths: [],
  overlays: [],
  priceTiers: [],
  currency: 'EUR',
};

// Depth-by-length lookup for the size bar's draft filter: first depth
// reading wins per length. Keyed String(Number()) so a length of "12.00"
// meets the size bar's String(12).
const sizeDepths: Record<string, number | null> = {};
for (const b of marina.berths) {
  if (b.lengthM == null) continue;
  const k = String(Number(b.lengthM));
  if (sizeDepths[k] == null && b.depthM != null) sizeDepths[k] = Number(b.depthM);
}
---

<Layout marina={m} title={`${m.heroHeadline} — ${m.name}`} heroImage={m.heroImage} locale={locale}>
  <div class="flex flex-col h-[calc(100vh-64px)] md:h-[calc(100vh-72px)]">
    <BerthsMap
      marinaSlug={MARINA_SLUG}
      center={{ lat: marina.profile.lat ?? m.geo.lat, lng: marina.profile.lng ?? m.geo.lng }}
      zones={m.berthZones}
      facilities={m.berthsFacilities}
      overlays={marina.overlays}
      iconsBase="/marinas/puerto-portals/icons"
      heroMode={true}
      fillContainer={true}
      headline={m.heroHeadline}
      slug={m.slug}
      locale={locale}
      zoneAmenities={m.berthZoneAmenities}
      name={m.name}
      tagline={m.tagline}
    />
    <BerthsSizeBar
      tiers={marina.priceTiers}
      sizeDepths={sizeDepths}
      locale={locale}
      docRequirements={docRequirements}
      marinaSlug={MARINA_SLUG}
      currencySymbol="€"
    />
  </div>

  {marina.profile.lat != null && marina.profile.lng != null && (
    <WeatherBar lat={marina.profile.lat} lng={marina.profile.lng} vhf={m.vhf} />
  )}

  <BerthsSeasonalPricing
    tiers={marina.priceTiers}
    locale={locale}
    zones={m.berthZones}
    amenities={m.berthZoneAmenities}
    currencySymbol="€"
  />
</Layout>
```

- [ ] **Step 6: `src/components/BerthsMap.astro`, browser fetch through the forwarder with one adapter at the boundary**

Props (`interface Props {`): old `  marinaId: string;` → new `  marinaSlug: string;`.

Destructure: old `const { marinaId, center, zones,` → new `const { marinaSlug, center, zones,`. The rest of that line is unchanged.

Root data attribute: old `      data-marina-id={marinaId}` → new `      data-marina-slug={marinaSlug}`.

In the `<script>`, old:
```ts
  // portals runs on a different origin than sidon-ai, so the berth-position
  // refresh below (originally a same-origin relative fetch) must target
  // sidon-ai's public, CORS-open marina API explicitly.
  const SIDON_ORIGIN = import.meta.env.PUBLIC_SIDON_ORIGIN;

  const token = import.meta.env.PUBLIC_MAPBOX_TOKEN;
```
new:
```ts
  const token = import.meta.env.PUBLIC_MAPBOX_TOKEN;
```

Old `    const marinaId = root.dataset.marinaId!;` → new `    const marinaSlug = root.dataset.marinaSlug!;`.

Old `    const overlayForBerth = (overlayId: number | null | undefined) => {` → new `    const overlayForBerth = (overlayId: string | null | undefined) => {`. OTA pontoon ids are UUIDs.

Old:
```ts
        const res = await fetch(`${SIDON_ORIGIN}/api/marina/public/${encodeURIComponent(marinaId)}`);
        if (!res.ok) return;
        const data = await res.json() as { berths?: Array<{ berthId: string; overlayId: number | null; lat: number; lng: number; lengthM: number; beamM?: number; depthM?: number; rotation?: number | null; status?: string; pricePerNight?: number | string | null }>; fromPrice?: number | string | null };
        const berths = (data.berths ?? []).filter(b => b.lat != null && b.lng != null);
```
new:
```ts
        // OTA's guest map payload via this site's forwarder (same origin,
        // key added server-side), mapped once here onto the shape the rest
        // of this script reads: label -> berthId, pontoon_id -> overlayId,
        // NUMERIC strings -> numbers, available -> status.
        const res = await fetch(`/api/marina/guest/${encodeURIComponent(marinaSlug)}`);
        if (!res.ok) return;
        const data = await res.json() as { berths?: Array<{ label: string; pontoon_id: string | null; lat: number | null; lng: number | null; length_m: string | null; beam_m: string | null; depth_m: string | null; rotation: number | null; available: boolean; price_per_night: string | null }> };
        const num = (v: string | null) => (v == null ? null : Number(v));
        const allBerths = (data.berths ?? []).map(b => ({
          berthId: b.label, overlayId: b.pontoon_id, lat: b.lat, lng: b.lng,
          lengthM: num(b.length_m), beamM: num(b.beam_m), depthM: num(b.depth_m), rotation: b.rotation,
          status: b.available ? 'available' : 'occupied', pricePerNight: num(b.price_per_night),
        }));
        const prices = allBerths.map(b => b.pricePerNight).filter((p): p is number => p != null);
        const fromPrice = prices.length ? Math.min(...prices) : null;
        const berths = allBerths.filter((b): b is typeof b & { lat: number; lng: number } => b.lat != null && b.lng != null);
```

Old:
```ts
          if (data.fromPrice != null && data.fromPrice !== '') {
            parts.push(statPill(`${FROM_LABEL[scriptLocale] ?? FROM_LABEL.en} ${Number(data.fromPrice).toLocaleString(scriptLocale)}€/${PER_NIGHT_LABEL[scriptLocale] ?? PER_NIGHT_LABEL.en}`, `linear-gradient(135deg, ${GOLD_HI}, ${GOLD})`, INK, 'rgba(180,138,71,0.4)'));
```
new:
```ts
          if (fromPrice != null) {
            parts.push(statPill(`${FROM_LABEL[scriptLocale] ?? FROM_LABEL.en} ${fromPrice.toLocaleString(scriptLocale)}€/${PER_NIGHT_LABEL[scriptLocale] ?? PER_NIGHT_LABEL.en}`, `linear-gradient(135deg, ${GOLD_HI}, ${GOLD})`, INK, 'rgba(180,138,71,0.4)'));
```

- [ ] **Step 7: `src/components/BerthsSizeBar.astro`, lazy hand-off (R26)**

Frontmatter. Old:
```ts
interface DocRequirement {
  id: number;
```
new:
```ts
interface DocRequirement {
  id: string;
```
Old:
```ts
  docRequirements?: DocRequirement[];
  marinaId?: string;
  /** Stripe publishable key — when present, the size-bar booking flow
      mounts a Payment Element on step 2 and authorises a hold before
      the booking is created. */
  stripePk?: string;
  /** Brand navy for Stripe Element's `colorPrimary`. */
  brandNavy?: string;
  currencySymbol?: string;
```
new:
```ts
  docRequirements?: DocRequirement[];
  /** OTA marina slug: the flow books through /api/marina/guest/<slug>. */
  marinaSlug?: string;
  currencySymbol?: string;
```
Old `const { tiers, sizeDepths = {}, label, locale = 'en', docRequirements = [], marinaId, stripePk = '', brandNavy = '#00283a', currencySymbol = '€' } = Astro.props;` → new `const { tiers, sizeDepths = {}, label, locale = 'en', docRequirements = [], marinaSlug, currencySymbol = '€' } = Astro.props;`.

Flow attributes. Old:
```astro
        data-marina-id={marinaId ?? ''}
        data-stripe-pk={stripePk}
        data-brand-navy={brandNavy}
        data-locale={locale}
        data-sending-label={bookT.sending}
        data-currency-symbol={currencySymbol}
        data-uploading-label={bookT.uploading}
        data-replace-label={bookT.replace}
        data-retry-label={formT.retryLabel}
        data-err-no-berth={formT.errNoBerthFree}
        data-err-booking-failed={formT.errBookingFailed}
        data-err-failed-try-again={formT.errFailedTryAgain}
        data-pay-on-arrival-no-stripe={formT.payOnArrivalNoStripe}
        data-pay-on-arrival-no-card={formT.payOnArrivalNoCard}
        data-err-card-form-failed={formT.errCardFormFailed}
        data-err-card-auth-failed={formT.errCardAuthFailed}
        data-night-singular={formT.nightSingular}
```
new:
```astro
        data-marina-slug={marinaSlug ?? ''}
        data-locale={locale}
        data-sending-label={bookT.sending}
        data-currency-symbol={currencySymbol}
        data-err-no-berth={formT.errNoBerthFree}
        data-err-booking-failed={formT.errBookingFailed}
        data-err-failed-try-again={formT.errFailedTryAgain}
        data-night-singular={formT.nightSingular}
```

Step 1 becomes information only. OTA takes uploads only with a booking token, so they move to `/booking`. Old:
```astro
        <div data-step="1" class="flex flex-col gap-2">
          {docRequirements.length === 0 ? (
            <p class="text-[14px]">{bookT.noDocsRequired}</p>
          ) : (
            <ul class="space-y-2">
              {docRequirements.map(d => (
                <li data-req-id={d.id} data-mandatory={d.mandatory ? 'true' : 'false'} data-busy="false" data-done="false" class="flex items-center gap-3 text-[14px]">
                  <svg data-icon-idle width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <svg data-icon-done width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="hidden shrink-0"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
                  <span class="flex-1 min-w-0 truncate">{d.name}</span>
                  <label class="shrink-0 cursor-pointer inline-flex items-center justify-center px-3 h-[32px] rounded-[6px] bg-white text-[#00283a] text-[14px] font-[Hind] font-semibold tracking-[1.5px] uppercase hover:bg-transparent hover:text-white hover:border hover:border-white transition-colors">
                    <span data-upload-label>{bookT.upload}</span>
                    <input type="file" accept="image/*,application/pdf" class="hidden" data-req-file={d.id} />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
```
new:
```astro
        <div data-step="1" class="flex flex-col gap-2">
          {/* Listed for information only: OTA accepts uploads once the
              booking (and its token) exists, so the guest sends them on
              /booking after step 2 hands off. */}
          {docRequirements.length === 0 ? (
            <p class="text-[14px]">{bookT.noDocsRequired}</p>
          ) : (
            <ul class="space-y-2">
              {docRequirements.map(d => (
                <li class="flex items-center gap-3 text-[14px]">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span class="flex-1 min-w-0 truncate">{d.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
```

Payment and contract rows. Delete everything from the blank line after the `<textarea data-field="notes" ...></textarea>` line, through the `          </label>` that closes `data-contract-row`. That covers the `{/* Payment hold (Stripe Payment Element)...` block, `<div data-payment-row ...>…</div>`, the `{/* Contract agreement...` comment and `<label data-contract-row ...>…</label>`. The textarea line is then followed directly by `        </div>`, which closes `data-step="2"`.

Step 3 summary/QR. Old:
```astro
          <p class="text-[14px] leading-[1.5] max-w-[300px]">{formT.requestReceivedBody}</p>
          <div data-booking-summary class="hidden flex-col items-center gap-2 mt-2 px-4 py-3 rounded-[8px] bg-white/5 border border-white/15 text-[13px]">
            <div class="flex items-center gap-2 text-white/70 uppercase tracking-[1.5px] text-[11px]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>
              <span>{formT.berthLabel}</span>
            </div>
            <div class="font-[Roboto] text-[20px] font-semibold tracking-[1px]" data-booking-berth>—</div>
            {/* QR code points at the public booking-tracking URL.
                Generated client-side once we have the booking id —
                lazy-imports the `qrcode` package so it doesn't bloat
                the panel's first-paint bundle. */}
            <div data-booking-qr class="hidden mt-1 p-2 rounded-[6px] bg-white"></div>
            <a data-booking-link href="#" class="text-[12px] underline underline-offset-2 hover:text-[#b48a47] transition-colors">{formT.viewBookingLink}</a>
          </div>
        </div>
```
new:
```astro
          <p class="text-[14px] leading-[1.5] max-w-[300px]">{formT.requestReceivedBody}</p>
        </div>
```

Script head. Old:
```ts
  // portals runs on a different origin than sidon-ai — every booking-flow
  // fetch below (originally same-origin relative paths) targets sidon-ai's
  // public, CORS-open marina API explicitly instead.
  const SIDON_ORIGIN = import.meta.env.PUBLIC_SIDON_ORIGIN;

  const pills =
```
new:
```ts
  const pills =
```

`showFlowStep`. Old:
```ts
    paintFlow(flow);
    paintStep1Validation(flow);
    paintStep2Validation(flow);
  };
```
new:
```ts
    paintFlow(flow);
  };
```

Upload helpers. Delete from the line `  // --- Guest token + upload (ported from services/book.astro) -------------` through the `  };` that closes `handleUpload`, which is the line before `  // Dim stepper — bump the adjacent input by the input's own step (0.1m)`. That removes `GUEST_TOKEN_KEY`, `getGuestToken`, `fileToBase64`, `step1Invalid`, `paintStep1Validation`, `matchKey`, `pickExtracted`, `autoFillStep2` and `handleUpload`. Mandatory uploads no longer gate step 1.

`submitBooking`, `wirePayment`, `wireContractGate` and `paintStep2Validation`. Replace everything from the line `  // Step 2 → submit: POST to the public booking API, then advance to the` up to, but not including, `  document.querySelectorAll<HTMLElement>('[data-book-flow]').forEach(flow => {` with:
```ts
  // Step 2 → submit: create the booking through this site's forwarder,
  // then hand off to /booking, where the widget takes the card (or the
  // emailed confirm), documents and the contract. OTA's /availability
  // already drops taken and too-small berths; take the smallest left.
  const submitBooking = async (flow: HTMLElement): Promise<boolean> => {
    const marinaSlug = flow.dataset.marinaSlug;
    const nextBtn = flow.querySelector<HTMLButtonElement>('[data-step-next]');
    if (!marinaSlug || !nextBtn) return false;
    const val = (sel: string) => (flow.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.value ?? '').trim();
    const sailorName  = val('input[data-field="sailorName"]');
    const boatName    = val('input[data-field="boatName"]');
    const sailorEmail = val('input[data-field="email"]');
    const phone       = val('input[data-field="phone"]');
    const notes       = val('textarea[data-field="notes"]');
    if (!sailorName || !boatName || !sailorEmail) return false;
    // Dimensions + dates live on the shared panel that owns this flow.
    const panelEl = flow.closest('[data-size-panel]') as HTMLElement | null;
    const loa = Number(panelEl?.querySelector<HTMLInputElement>('input[data-dim="loa"]')?.value ?? '0') || 0;
    const beam = Number(panelEl?.querySelector<HTMLInputElement>('input[data-dim="beam"]')?.value ?? '0') || null;
    const dates = panelEl?.querySelector<HTMLInputElement>('[data-book-dates]');
    const fp = (dates as any)?._flatpickr;
    const selected = fp?.selectedDates as Date[] | undefined;
    if (!selected || selected.length !== 2) return false;
    // Local calendar date: toISOString() would move flatpickr's local
    // midnight back a day anywhere east of UTC (Mallorca is UTC+1/+2).
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const arrivalDate = iso(selected[0]);
    const departureDate = iso(selected[1]);

    nextBtn.disabled = true;
    const prevLabel = nextBtn.textContent;
    nextBtn.textContent = flow.dataset.sendingLabel || 'Sending…';
    try {
      const base = `/api/marina/guest/${encodeURIComponent(marinaSlug)}`;
      const q = new URLSearchParams({ arrival: arrivalDate, departure: departureDate, boat_length_m: String(loa) });
      if (beam) q.set('boat_beam_m', String(beam));
      const free = await fetch(`${base}/availability?${q}`).then((r) => (r.ok ? r.json() : []));
      const fit = (free as Array<{ label: string; length_m: string | null }>)
        .sort((a, b) => Number(a.length_m) - Number(b.length_m))[0];
      if (!fit) throw new Error(flow.dataset.errNoBerth || 'No berth free for these dates.');
      const r = await fetch(`${base}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          berth_label: fit.label, arrival: arrivalDate, departure: departureDate,
          contact_name: sailorName, contact_email: sailorEmail, contact_phone: phone || undefined,
          boat_name: boatName, boat_length_m: loa, boat_beam_m: beam ?? undefined,
          notes: notes || undefined, locale: flow.dataset.locale,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.booking?.id) throw new Error(data?.error || flow.dataset.errBookingFailed || 'Booking failed');
      location.assign(`/booking?booking=${data.booking.id}&token=${encodeURIComponent(data.booking_token)}`);
      return true;
    } catch (err: any) {
      // Surface a minimal error; the popover is small — reuse the Next
      // button's label so the sailor sees it fail without another slot.
      nextBtn.textContent = err?.message?.slice(0, 40) || flow.dataset.errFailedTryAgain || 'Failed, try again';
      setTimeout(() => { if (nextBtn) { nextBtn.textContent = prevLabel; nextBtn.disabled = false; } }, 2500);
      return false;
    }
  };

```

Flow wiring. Old:
```ts
  document.querySelectorAll<HTMLElement>('[data-book-flow]').forEach(flow => {
    paintFlow(flow);
    paintStep1Validation(flow);
    wireContractGate(flow);
    wirePayment(flow);
    flow.querySelector('[data-step-next]')?.addEventListener('click', async () => {
      const active = Number(flow.dataset.active ?? '1');
      if (active === 1 && step1Invalid(flow)) {
        paintStep1Validation(flow);
        return;
      }
      if (active === 2) {
        if (flow.dataset.contractRequired === 'true' &&
            flow.querySelector<HTMLInputElement>('[data-contract-agree]')?.checked !== true) {
          return;
        }
        // Authorise the Stripe hold (if mounted) before creating the
        // booking — this way a card decline doesn't leave a phantom
        // pending booking with no payment attached.
        const pay = (flow as any)._sidonPayment as SidonPayment | undefined;
        const nextBtn = flow.querySelector<HTMLButtonElement>('[data-step-next]');
        if (pay) {
          const prev = nextBtn?.textContent ?? '';
          if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = flow.dataset.sendingLabel || 'Sending…'; }
          try {
            await pay.confirm();
          } catch {
            if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = prev; }
            return;
          }
          if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = prev; }
        }
        const ok = await submitBooking(flow);
        if (!ok) return;
      }
      showFlowStep(flow, active + 1);
    });
    flow.querySelector('[data-step-back]')?.addEventListener('click', () => {
      showFlowStep(flow, Number(flow.dataset.active ?? '1') - 1);
    });
    flow.addEventListener('change', (ev) => {
      const input = (ev.target as HTMLElement).closest<HTMLInputElement>('input[type="file"][data-req-file]');
      if (input) handleUpload(flow, input);
    });

    // Stepper items click-back: tapping `1 DOCUMENTS` from step 2 jumps
    // straight back so the sailor doesn't have to find the Back button.
    // Tapping the next-hop (active + 1) clicks the page's Next button so
    // step-1 doc validation still gates forward progress. Step 3 is
    // terminal — no item is interactive then.
```
new:
```ts
  document.querySelectorAll<HTMLElement>('[data-book-flow]').forEach(flow => {
    paintFlow(flow);
    flow.querySelector('[data-step-next]')?.addEventListener('click', async () => {
      const active = Number(flow.dataset.active ?? '1');
      // Step 2 books and navigates to /booking; step 3 only shows while
      // the browser leaves.
      if (active === 2) {
        const ok = await submitBooking(flow);
        if (!ok) return;
      }
      showFlowStep(flow, active + 1);
    });
    flow.querySelector('[data-step-back]')?.addEventListener('click', () => {
      showFlowStep(flow, Number(flow.dataset.active ?? '1') - 1);
    });

    // Stepper items click-back: tapping `1 DOCUMENTS` from step 2 jumps
    // straight back so the sailor doesn't have to find the Back button.
    // Tapping the next-hop (active + 1) clicks the page's Next button so
    // step 2 still goes through submitBooking. Step 3 is terminal — no
    // item is interactive then.
```
Leave the rest of the block (`flow.querySelectorAll<HTMLElement>('[data-step-item]').forEach((item) => {` … `});` and `</script>`) unchanged.

- [ ] **Step 8: Booking page, sitemap, env example, CLAUDE.md**

Create `src/pages/booking.astro`:
```astro
---
// OTA's guest emails and confirm link land here with ?booking=&token=, and
// so does the berths size bar once it has created the booking.
// Bare on purpose (no site layout, analytics or fonts): the token is in the URL.
import { MARINA_SLUG } from '../lib/marina-api';

export const prerender = false;
Astro.response.headers.set('Referrer-Policy', 'no-referrer');
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Your booking — Puerto Portals</title>
  </head>
  <body>
    <main style="max-width:680px;margin:0 auto;padding:24px 0">
      <sidon-booking-widget marina={MARINA_SLUG} booking-id variant="dark" marina-name="Puerto Portals" logo-mark="/marinas/puerto-portals/logo-header.png" style="--brand-navy:#0c2340;--brand-gold:#b48a47;"></sidon-booking-widget>
    </main>
    <script>import '@forgebuild/sidon-booking-widget';</script>
  </body>
</html>
```
It has no `locale` (G12), no `api-origin` and no `currency-symbol` (R24).

Sitemap: check first, then filter. `@astrojs/sitemap` lists every non-dynamic route here even though the pages are SSR (today's `.vercel/output/static/sitemap-0.xml` has `/berths/`).
```bash
cd /c/Users/robert/source/repos/portals && OTA_BASE_URL= OTA_API_KEY= npm run build 2>&1 | tail -2 && grep -o '<loc>[^<]*booking[^<]*</loc>' .vercel/output/static/sitemap-0.xml
```
Expected: the build completes, and the grep prints `<loc>https://portals.vercel.app/booking/</loc>`. That confirms the filter is needed. In `astro.config.mjs`, old:
```js
  integrations: [sitemap()],
```
new:
```js
  // /booking carries a booking token in its URL: never list it.
  integrations: [sitemap({ filter: (page) => !page.includes('/booking') })],
```

Rewrite `.env.example` (whole file):
```bash
# Sanity — dedicated new project for Puerto Portals (not Forge's shared
# project, not pirates-bight's). Unset means the site runs entirely on
# src/lib/content.ts defaults.
SANITY_PROJECT_ID=
SANITY_DATASET=production
SANITY_API_TOKEN=

# OTA — Puerto Portals' berths, pricing and online booking (marina slug
# puerto-portals). Server-only: src/lib/marina-api.ts reads them for the
# berths page, and src/pages/api/marina/guest/[...path].ts forwards the
# browser's booking calls with the key added. Leave either empty and online
# booking is hidden (the footer's VHF/phone stays). Set both in Vercel for
# Preview AND Production; Astro inlines them at build, so redeploy after
# any change. No Stripe key here: the booking page gets OTA's publishable
# key from OTA.
OTA_BASE_URL=
OTA_API_KEY=

# Mapbox — powers the 3D berths map (BerthsMap.astro).
PUBLIC_MAPBOX_TOKEN=
```

`CLAUDE.md`:
- `:9`, old line starting `` - `/berths` is fully built with real feature parity `` → new:
  `` - `/berths` is fully built: a Mapbox GL JS + Three.js 3D map (extruded pontoons, 3D boat hulls, real GLB landmark models, live weather) and a size bar whose flow creates the booking on OTA, then hands off to `/booking`, where `<sidon-booking-widget>` takes the card, documents and the contract. ``
- `:13-15`, the `### Known risk (carried over from sidon-ai unchanged, not introduced here)` heading and its paragraph → new:
  ```markdown
  ### Booking runs on OTA

  Berths, pricing and bookings come from OTA's guest API (marina slug `puerto-portals`) with this site's property key, which stays server-side: `src/lib/marina-api.ts` reads for SSR, and `src/pages/api/marina/guest/[...path].ts` forwards the browser's calls. Without both `OTA_BASE_URL` and `OTA_API_KEY` booking is hidden and the footer's VHF/phone is the way to book. `/booking` is the guest's booking page (OTA's emails link there): bare, `noindex`, `no-referrer`, and kept out of the sitemap, because its URL carries the booking token.
  ```
- `:34` → `` - **Booking**: OTA via `@forgebuild/sidon-booking-widget` (forwarder, server client, and the `/booking` page's element); flatpickr for the size bar's dates. No Stripe key is held here. ``
- `:35`, old `Live berth/pricing data is always fetched from sidon-ai at request time.` → new `Live berth/pricing data is fetched from OTA at request time.`
- `:47` → `` - `src/lib/marina-api.ts` — server-side OTA reads (`getMarina`, `getDocRequirements`, `MARINA_SLUG`, `bookingEnabled`), mapped onto the components' camelCase shapes ``
- `:55` → `` - Browser calls to OTA go to this site's own `/api/marina/guest/...` (relative); the property key never reaches the browser ``

- [ ] **Step 9: Static checks**

```bash
cd /c/Users/robert/source/repos/portals && rg -n 'marina.sidonmarine|PUBLIC_SIDON_ORIGIN|SIDON_URL' src                      # prints nothing
cd /c/Users/robert/source/repos/portals && rg -n "SIDON_ORIGIN|marinaId|marina-id|_sidonPayment|guest-doc-upload|create-intent|contract-preview|wirePayment|wireContractGate|paintStep[12]Validation|handleUpload" src   # prints nothing
cd /c/Users/robert/source/repos/portals && rg -n "@stripe/stripe-js|from 'stripe'|\"stripe\"|qrcode" src astro.config.mjs studio-portals/src package.json   # prints nothing (G6: removed deps have no importer)
cd /c/Users/robert/source/repos/portals && npx astro check 2>&1 | tail -3                                               # error count <= BASE_ERRORS
```

- [ ] **Step 10: Seed the demo marina as `puerto-portals`, start local OTA, build with env**

```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=puerto-portals node scripts/seed-marina-demo.js | grep -v '^api_key='   # ends slug=puerto-portals
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start      # run_in_background; needs MARINA_BOOKING_TOKEN_SECRET in O/.env
cd /c/Users/robert/source/repos/portals && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=puerto-portals node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npm run build 2>&1 | tail -2
cd /c/Users/robert/source/repos/portals && grep -c 'booking' .vercel/output/static/sitemap-0.xml; grep -l 'api/marina/guest' .vercel/output/static/_astro/*.js | wc -l
```

Expected:
- The build ends `[build] Complete!`.
- The sitemap count is `0`.
- At least `1` client chunk carries the forwarder path, which proves the BerthsMap/size bar fetches are bundled relative.

- [ ] **Step 11: Kill-switch build (Review Focus 5)**

```bash
cd /c/Users/robert/source/repos/portals && OTA_BASE_URL= OTA_API_KEY= npm run build 2>&1 | tail -2     # [build] Complete!
```

- [ ] **Step 12: Dev check with env: forwarder, berths flow requests, booking page (Review Focus 4)**

```bash
cd /c/Users/robert/source/repos/portals && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=puerto-portals node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npx astro dev --port 4401   # run_in_background
curl -s http://localhost:4401/api/marina/guest/puerto-portals | head -c 300           # JSON starting {"marina":{"name":...,"slug":"puerto-portals"
curl -s http://localhost:4401/berths -o /tmp/po-berths.html; grep -c 'data-marina-slug="puerto-portals"' /tmp/po-berths.html; grep -c 'data-book-flow' /tmp/po-berths.html   # 2 (map + flow), 1
```

Next is the berths flow's exact availability query and POST body (what `submitBooking` sends, with `locale` from `data-locale`). It runs as one call, so the id and token stay in variables and are never printed:
```bash
A=$(date -d '+30 day' +%F); D=$(date -d '+32 day' +%F); \
L=$(curl -s "http://localhost:4401/api/marina/guest/puerto-portals/availability?arrival=$A&departure=$D&boat_length_m=9" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const a=JSON.parse(s);a.sort((x,y)=>Number(x.length_m)-Number(y.length_m));console.log(a[0]?a[0].label:'NONE')})"); echo "berth=$L"; \
R=$(curl -s -X POST http://localhost:4401/api/marina/guest/puerto-portals/bookings -H 'Content-Type: application/json' -d "{\"berth_label\":\"$L\",\"arrival\":\"$A\",\"departure\":\"$D\",\"contact_name\":\"Plan D\",\"contact_email\":\"plan-d+po-$(date +%s)@example.com\",\"boat_name\":\"Check\",\"boat_length_m\":9,\"locale\":\"es\"}"); \
read ID TOKEN <<< "$(echo "$R" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);console.log(j.booking?j.booking.id+' '+encodeURIComponent(j.booking_token):'ERR '+JSON.stringify(j.error))})")"; echo "booking ok: $([ "$ID" != ERR ] && echo yes || echo "no $TOKEN")"; \
echo "guest view: $(curl -s -o /dev/null -w '%{http_code}' -H "X-Booking-Token: $(node -p "decodeURIComponent('$TOKEN')")" http://localhost:4401/api/marina/guest/puerto-portals/bookings/$ID)"; \
curl -s -D /tmp/po-h.txt -o /tmp/po-booking.html "http://localhost:4401/booking?booking=$ID&token=$TOKEN"; head -1 /tmp/po-h.txt; grep -i '^referrer-policy' /tmp/po-h.txt; \
grep -c 'sidon-booking-widget' /tmp/po-booking.html; grep -c 'content="no-referrer"' /tmp/po-booking.html; grep -c 'noindex' /tmp/po-booking.html
```

Expected:
- `berth=A2`. A3 or A4 is fine if an earlier run's hold covers A2 on those dates; picking from availability avoids the 409.
- `booking ok: yes`.
- `guest view: 200`. This is the booking page's resume read through the forwarder.
- `HTTP/1.1 200 OK` and `Referrer-Policy: no-referrer`.
- Each of the three counts is ≥ 1.

The email is per run because of OTA's 3-upcoming-per-email cap.

- [ ] **Step 13: Dev check with booking off (Review Focus 5)**

Stop the Step 12 dev server, then:
```bash
cd /c/Users/robert/source/repos/portals && OTA_BASE_URL= OTA_API_KEY= npx astro dev --port 4401   # run_in_background
curl -s http://localhost:4401/berths -o /tmp/po-berths-off.html -w '%{http_code}\n'; grep -c 'data-book-flow' /tmp/po-berths-off.html; grep -c '<sidon-booking-widget' /tmp/po-berths-off.html; grep -c 'VHF CH 9' /tmp/po-berths-off.html
curl -s http://localhost:4401/api/marina/guest/puerto-portals -w ' %{http_code}\n'
```

Expected:
- `/berths` returns `200`.
- The counts are `0` (no booking flow), `0` (no widget) and ≥ `1` (the footer's VHF line, alongside its phone link).
- The forwarder answers `{"error":"Online booking is not available"} 503`.

Stop the dev server and the local OTA server (`PORT=3100`).

- [ ] **Step 14: Commit on `cutover/switch` (no push; no repo creation)**

```bash
git -C /c/Users/robert/source/repos/portals status --short    # expect exactly the paths below (no package-lock.json)
git -C /c/Users/robert/source/repos/portals add package.json astro.config.mjs .env.example CLAUDE.md src/lib/marina-api.ts src/components/BerthsMap.astro src/components/BerthsSizeBar.astro src/components/pages/BerthsPageBody.astro src/pages/booking.astro "src/pages/api/marina/guest/[...path].ts"
git -C /c/Users/robert/source/repos/portals commit -m "Book berths through OTA: forwarder, /booking page, widget 1.1

The berths size bar now creates the booking through this site's
forwarder (/api/marina/guest/puerto-portals) and hands off to /booking,
where the widget takes the card, documents and the contract. Server
reads go through a lazily built createMarinaClient; without
OTA_BASE_URL/OTA_API_KEY booking hides and the footer's VHF/phone
stays. Drops the hand-rolled Stripe hold, pre-booking uploads, contract
gate, QR step and the Sidon env, plus @stripe/stripe-js, stripe and
qrcode, which no longer have an importer. The size bar's dates are now
local calendar dates (toISOString shifted them a day east of UTC).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/portals log --oneline -1 && git -C /c/Users/robert/source/repos/portals branch --show-current   # cutover/switch
```

End state: one commit on PO `cutover/switch`, with the repo left on that branch. `node_modules` holds the tarball install and `package-lock.json` is unchanged. Nothing is pushed and no GitHub repo or Vercel project exists. The runbook later runs `gh repo create robooko/portals --private --source . --push` with the user's go-ahead. It then runs `npm install` after `npm publish` and commits the lockfile (G6), opens the PR and merges it at Step 6 without deploying (R2: "ready when it launches"). It sets `booking_url` = `<origin>/booking?booking={id}&token={token}` once an origin exists.

---

### Task 9: marina-di-positano cutover/switch

Repo: `MP` = `C:/Users/robert/source/repos/marina-di-positano`. It has no git remote; `gh repo create robooko/marina-di-positano --private` is a runbook step (R2). Branch `cutover/switch`, cut from local `master` (`2e1679f`). Implements R21, R22 + G6, R23, R24, R27, G7 and G12; Review Focus 4 and 5. Dev is HTTPS (mkcert certs in `MP/.cert/`, wired in `astro.config.mjs`), so every curl is `curl -sk https://localhost:4404/...`. Commands are for Git Bash. Nothing is pushed and no repo is created.

**Files:**
- Modify: `MP/package.json`, line 17 (`@robooko/sidon-booking-widget` becomes `@forgebuild/sidon-booking-widget`). `package-lock.json` is NOT committed (G6).
- Delete (local only, gitignored, nothing to commit): `MP/.npmrc`
- Create: `MP/src/pages/api/marina/guest/[...path].ts` (the contract's forwarder, verbatim)
- Create: `MP/src/pages/booking.astro`
- Modify (whole-file rewrite): `MP/src/lib/marina-api.ts` (lines 1-40)
- Modify (whole-file rewrite): `MP/src/components/pages/BerthsPageBody.astro` (lines 1-101)
- Modify: `MP/src/components/pages/LocationBody.astro`, lines 24-28, 66 and 90-91
- Modify: `MP/src/components/marina-page/BerthsGoogleMap.astro`, line 51
- Modify: `MP/src/scripts/berth-map-google.ts`, lines 83-84, 101-104, 398-407, 430 and 710
- Modify: `MP/astro.config.mjs`, line 17. Only if Step 13's sitemap assertion finds `/booking`, which it will, because SSR static routes such as `/berths/` are already listed in today's `dist/client/sitemap-0.xml`.
- Modify: `MP/CLAUDE.md`, lines 7-12, 28-67, 95-99 and 128-130

**Interfaces:**
- Consumes:
  - The widget tarball `C:/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz` (Task 5), and `W/package.json` version `1.1.0` (plan C).
  - `createMarinaProxy({ otaBaseUrl, keys })` and `createMarinaClient({ otaBaseUrl, keys })` from `@forgebuild/sidon-booking-widget/astro-proxy`. `client.getMarina(slug)` returns OTA's raw guest map payload, or `null` on 404. It throws `MarinaClientError` on other non-OK responses.
  - OTA's guest map payload (contract shape): `marina.{name, slug, lat, lng, phone, email, layout}`, `pontoons[]`, `berths[].{label, lat, lng, rotation, length_m, price_per_night, price_mode, available}`, `price_tiers[]`. `lat`/`lng`/`sw_*`/`ne_*`/`rotation` are DOUBLE PRECISION, so they arrive as JSON numbers; NUMERIC fields arrive as strings.
  - The demo seed with `MARINA_DEMO_SLUG` (Task 5), which prints `api_key=` and `slug=`. Local OTA runs on `PORT=3100`.
  - The contract's site verification procedure with slug `marina-di-positano`, port `4404` and scheme `https` (`curl -sk`).
- Produces:
  - In `MP/src/lib/marina-api.ts`:
    - `export const MARINA_SLUG = 'marina-di-positano'`
    - `export const bookingEnabled: boolean`
    - `export async function getMarina(): Promise<MarinaData | null>`. It returns null when `!bookingEnabled` or OTA 404s.
    - `MarinaProfile = { slug, name, lat, lng, phone, email }`
  - In `berth-map-google.ts`, `BerthMapGoogleConfig.ownerId` is renamed to `slug`. A module-level `fromOta(d)` adapter is added.
  - The forwarder `GET|POST /api/marina/guest/*` (503 `{"error":"Online booking is not available"}` without both env vars).
  - The SSR page `/booking`, with a `Referrer-Policy: no-referrer` header, the referrer meta tag, `noindex`, and no sitemap entry.
  - Runbook inputs:
    - `booking_url` = `<origin>/booking?booking={id}&token={token}` (Step 6).
    - Vercel `OTA_BASE_URL` + `OTA_API_KEY` for Production AND Preview (the build reads them for the prerendered `/location` pages).
    - Delete `SIDON_URL`, `PUBLIC_SIDON_ORIGIN` and `NODE_AUTH_TOKEN`, then redeploy.
    - The G6 lockfile commit after `npm publish`.
  - One commit on MP `cutover/switch`.

- [ ] **Step 1: Gates (stop and report if any fails)**

Run each line as its own Bash call:

```bash
node -p "require('C:/Users/robert/source/repos/sidon-booking-widget/package.json').version"     # must print 1.1.0
ls -l /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz                                   # must exist (Task 5 builds it)
grep -c 'MARINA_DEMO_SLUG' /c/Users/robert/source/repos/OTA/scripts/seed-marina-demo.js        # >= 1 (Task 5)
git -C /c/Users/robert/source/repos/marina-di-positano status --short                           # must print nothing
git -C /c/Users/robert/source/repos/marina-di-positano rev-parse --abbrev-ref HEAD              # master
```

- [ ] **Step 2: Baseline type check on `master`**

```bash
cd /c/Users/robert/source/repos/marina-di-positano && npx astro check 2>&1 | tail -4
```

Record the `Result (N files): - E errors` line. At Step 12 the error count must not be higher than E.

- [ ] **Step 3: Branch**

```bash
git -C /c/Users/robert/source/repos/marina-di-positano switch -c cutover/switch master
```

Expected: `Switched to a new branch 'cutover/switch'`.

- [ ] **Step 4: Swap the widget package (G6: install first, then hand-edit `package.json`)**

The `.npmrc` is gitignored (`.gitignore:36`) and only carried the `@robooko` GitHub Packages registry plus a `${NODE_AUTH_TOKEN}` line. Delete it first, so npm doesn't try to expand an unset token. There is nothing to commit for it.

```bash
cd /c/Users/robert/source/repos/marina-di-positano && rm .npmrc
cd /c/Users/robert/source/repos/marina-di-positano && npm install --no-save /c/tmp/plan-d/forgebuild-sidon-booking-widget-1.1.0.tgz
```

If npm fails with a 401 or 404 from `npm.pkg.github.com` for `@robooko/sidon-booking-widget`, run `npm uninstall --no-save @robooko/sidon-booking-widget` and repeat the install.

Edit `MP/package.json` line 17. Old:

```json
    "@astrojs/vercel": "^10.0.3",
    "@robooko/sidon-booking-widget": "^0.2.1",
```

New:

```json
    "@astrojs/vercel": "^10.0.3",
    "@forgebuild/sidon-booking-widget": "^1.1.0",
```

Remove the old package from `node_modules`, so that any leftover `@robooko` import fails the build instead of silently resolving:

```bash
cd /c/Users/robert/source/repos/marina-di-positano && rm -rf node_modules/@robooko
cd /c/Users/robert/source/repos/marina-di-positano && node -p "require('./node_modules/@forgebuild/sidon-booking-widget/package.json').version"   # 1.1.0
git -C /c/Users/robert/source/repos/marina-di-positano status --short   # exactly: " M package.json" (package-lock.json untouched)
```

- [ ] **Step 5: Create the forwarder `MP/src/pages/api/marina/guest/[...path].ts`**

This is the contract's exact text:

```ts
// OTA's guest API for the booking widget, with this site's property key
// added server-side (the browser never sees it). Only /api/marina/guest/*.
import { createMarinaProxy } from '@forgebuild/sidon-booking-widget/astro-proxy';

// Astro reads this flag from this file's source text, so it can't come
// from the package.
export const prerender = false;

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;

// Kill switch: without both env vars booking is hidden, and this answers
// one clear JSON 503 instead of a proxy with no key (404 for every slug).
const proxy = otaBaseUrl && apiKey
  ? createMarinaProxy({ otaBaseUrl, keys: apiKey })
  : () => new Response(JSON.stringify({ error: 'Online booking is not available' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

export const GET = proxy;
export const POST = proxy;
```

- [ ] **Step 6: Rewrite `MP/src/lib/marina-api.ts` (whole file)**

```ts
// Server-side reads of Marina di Positano's live data (name, lat/lng,
// contacts) from OTA's guest API, with this site's property key. Berths,
// prices and booking stay with the browser: the widget and the hand-rolled
// map both go through the same-origin forwarder at /api/marina/guest/*.
import { createMarinaClient } from '@forgebuild/sidon-booking-widget/astro-proxy';

/** This marina's OTA slug: the forwarder path, the widget and the map all key on it. */
export const MARINA_SLUG = 'marina-di-positano';

const otaBaseUrl = import.meta.env.OTA_BASE_URL;
const apiKey = import.meta.env.OTA_API_KEY;
// Kill switch: no env -> no client (createMarinaClient throws on empty values).
const client = otaBaseUrl && apiKey ? createMarinaClient({ otaBaseUrl, keys: apiKey }) : null;
export const bookingEnabled = client !== null;

export interface MarinaProfile {
  slug: string;
  name: string;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  email: string | null;
}

export interface MarinaData {
  profile: MarinaProfile;
}

// Marina details change on the timescale of staff edits in OTA, not
// per-visitor: a short TTL absorbs repeat page loads without going stale
// for long enough to matter.
const CACHE_TTL_MS = 60_000;
let marinaCache: { data: MarinaData; expires: number } | null = null;

/** Marina profile (slug, name, lat/lng, contacts), or null when booking is
 *  off (no OTA env) or OTA has no such marina. Callers render the VHF/phone
 *  fallback rather than a 404/500. Other OTA errors still throw. */
export async function getMarina(): Promise<MarinaData | null> {
  if (!client) return null;
  if (marinaCache && marinaCache.expires > Date.now()) return marinaCache.data;
  const d = await client.getMarina(MARINA_SLUG);
  if (!d) return null;
  const { slug, name, lat, lng, phone, email } = d.marina;
  const marina: MarinaData = { profile: { slug, name, lat, lng, phone, email } };
  marinaCache = { data: marina, expires: Date.now() + CACHE_TTL_MS };
  return marina;
}
```

- [ ] **Step 7: Rewrite `MP/src/components/pages/BerthsPageBody.astro` (whole file)**

This removes `api-origin` and `currency-symbol` (R24; amounts then use Intl in the property currency) and keys on `profile.slug`. With no marina, the map, WeatherBar and widget are replaced by the VHF/phone contacts.

```astro
---
// Map + booking body. Booking is the @forgebuild/sidon-booking-widget custom
// element — the entire booking surface, talking to OTA through this site's
// forwarder (src/pages/api/marina/guest/[...path].ts). Mirrors sidon-ai's
// BerthsBody.astro composition for the googleMapStyle==='coastal' branch
// (map full-bleed, non-floating WeatherBar, booking section below).
import MarinaPageLayout from '../../layouts/MarinaPageLayout.astro';
import BerthsGoogleMap from '../marina-page/BerthsGoogleMap.astro';
import WeatherBar from '../marina-page/WeatherBar.astro';
import { getMarinaContent } from '../../lib/marina-content';
import { getMarina } from '../../lib/marina-api';
import type { Locale } from '../../lib/locale';

interface Props { locale: Locale }
const { locale } = Astro.props;

const entry = await getMarinaContent(locale);
if (!entry) return new Response('Not found', { status: 404 });
const m = entry.data;

// null = booking off (no OTA env) or no such marina in OTA. The map needs a
// centre too. Either way the page shows the VHF/phone contacts instead of
// failing, so a missing key never takes /berths down.
const profile = (await getMarina())?.profile ?? null;
const center = profile && profile.lat != null && profile.lng != null ? { lat: profile.lat, lng: profile.lng } : null;

const mapsKey = import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY;

const OFFLINE: Record<string, string> = {
  it: 'La prenotazione online non è disponibile. Per un ormeggio contattaci via VHF, telefono o email.',
  en: 'Online booking is not available right now. For a berth, reach us on VHF, by phone or by email.',
  es: 'La reserva online no está disponible. Para un amarre, contáctanos por VHF, teléfono o email.',
  fr: 'La réservation en ligne n’est pas disponible. Pour une place, contactez-nous par VHF, téléphone ou e-mail.',
};
const offline = OFFLINE[locale] ?? OFFLINE.en;

// Map→booking handoff params — the same ?from=&to=&length=&berth= shape
// sidon-ai's own berths pages use.
const params = Astro.url.searchParams;
const bookingFrom = params.get('from') ?? undefined;
const bookingTo = params.get('to') ?? undefined;
const bookingLength = params.get('length') ?? undefined;
const bookingBerth = params.get('berth') ?? undefined;
---

<MarinaPageLayout marina={m} tab="berths" locale={locale} mapsHints={true} title={`Berths — ${m.name}`}>
  {profile && center ? (
    <>
      <div class="flex flex-col h-[50vh]">
        <BerthsGoogleMap
          marinaId={profile.slug}
          center={center}
          mapsKey={mapsKey}
          navy={m.brand.navy}
          gold={m.brand.gold}
          logoMark={m.logoMark}
          marinaName={m.name}
          otherMarinas={[]}
          currentLocale={locale}
          heroMode={true}
          fillContainer={true}
          mapStyle="coastal"
        />
      </div>

      <WeatherBar lat={center.lat} lng={center.lng} vhf={m.vhf} />

      <section class="bg-white py-3 md:py-12">
        <div class="max-w-[680px] mx-auto px-3 md:px-10">
          <sidon-booking-widget
            marina={profile.slug}
            from={bookingFrom}
            to={bookingTo}
            length={bookingLength}
            berth={bookingBerth}
            locale={locale}
            style={`--brand-navy: ${m.brand.navy}; --brand-gold: ${m.brand.gold}; --brand-ink: ${m.brand.ink ?? m.brand.navy};`}
          ></sidon-booking-widget>
        </div>
      </section>
    </>
  ) : (
    <section class="py-16 md:py-24 bg-white">
      <div class="max-w-[720px] mx-auto px-5 md:px-10 text-center">
        <p class="font-[Hind] text-[18px] text-[var(--brand-navy)] mb-6">{offline}</p>
        <div class="flex flex-col items-center gap-3 font-[Hind] text-[16px] text-[var(--brand-navy)]">
          <span>VHF {m.vhf}</span>
          <a href={`tel:${m.phoneLink}`} class="hover:text-[var(--brand-gold)]">{m.phone}</a>
          <a href={`mailto:${m.email}`} class="hover:text-[var(--brand-gold)]">{m.email}</a>
        </div>
      </div>
    </section>
  )}
</MarinaPageLayout>

<script>
  import '@forgebuild/sidon-booking-widget';

  document.addEventListener('sidon-step-change', (ev) => {
    console.log('[sidon-booking-widget] step-change', (ev as CustomEvent).detail);
  });
  document.addEventListener('sidon-booked', (ev) => {
    console.log('[sidon-booking-widget] booked', (ev as CustomEvent).detail);
  });

  // Widget -> map handoff. berth-map-google.ts already ports sidon-ai's
  // applyLoa()/`sidon:loa` listener (greys out too-small berths) but had
  // nothing driving it here, since this build has no #s-length-input /
  // #berth-quick-length of its own — the widget's Summary control (>=0.1.2)
  // is the only LOA input, so forward its changes straight through.
  document.addEventListener('sidon-loa-change', (ev) => {
    document.dispatchEvent(new CustomEvent('sidon:loa', { detail: (ev as CustomEvent).detail }));
  });

  // Map -> widget handoff. berth-map-google.ts dispatches this on every
  // click (including deselect, where detail.berthId is null). The widget
  // reactively re-syncs its `berth` attribute into selection while still
  // on step 1, so this needs no further plumbing on its side.
  document.addEventListener('sidon:berth-selected', (ev) => {
    const berthId = (ev as CustomEvent).detail?.berthId as string | null;
    document.querySelector('sidon-booking-widget')?.setAttribute('berth', berthId ?? '');
  });
</script>
```

- [ ] **Step 8: `MP/src/components/pages/LocationBody.astro`: build without OTA env (Review Focus 5)**

Lines 24-28. Old:

```astro
const { profile } = await getMarina();
if (profile.lat == null || profile.lng == null) return new Response('Not found', { status: 404 });

const mapsKey = import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY;
const hasMap = !!mapsKey;
```

New:

```astro
// This page is prerendered, so this read runs at build time. null (no OTA
// env, or no such marina) must not fail the build: the page drops its map
// pin and WeatherBar and keeps everything else.
const profile = (await getMarina())?.profile ?? null;
const center = profile && profile.lat != null && profile.lng != null ? { lat: profile.lat, lng: profile.lng } : null;

const mapsKey = import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY;
const hasMap = !!mapsKey && center !== null;
```

Line 66. Old:

```astro
  <WeatherBar lat={profile.lat} lng={profile.lng} vhf={m.vhf} />
```

New:

```astro
  {center && <WeatherBar lat={center.lat} lng={center.lng} vhf={m.vhf} />}
```

Lines 90-91. Old:

```astro
{hasMap && (
  <script is:inline define:vars={{ lat: profile.lat, lng: profile.lng, key: mapsKey, navy: m.brand.navy, gold: m.brand.gold, marinaName: m.name, pois: poiMapData }}>
```

New:

```astro
{hasMap && center && (
  <script is:inline define:vars={{ lat: center.lat, lng: center.lng, key: mapsKey, navy: m.brand.navy, gold: m.brand.gold, marinaName: m.name, pois: poiMapData }}>
```

- [ ] **Step 9: The hand-rolled map fetches OTA through the forwarder (R27)**

`MP/src/components/marina-page/BerthsGoogleMap.astro` line 51. Old:

```ts
  ownerId: marinaId,
```

New:

```ts
  slug: marinaId,
```

`MP/src/scripts/berth-map-google.ts` lines 83-84. Old:

```ts
  /** Marina ownerId (Clerk org/user id) — keys the public API fetch. */
  ownerId: string;
```

New:

```ts
  /** Marina slug in OTA — keys the guest API fetch through this site's forwarder. */
  slug: string;
```

Lines 101-104: insert the adapter above `initBerthMapGoogle` and rename the destructured field. Old:

```ts
}

export const initBerthMapGoogle = (cfg: BerthMapGoogleConfig) => {
  const {
    lat, lng, key, ownerId, navy, gold,
```

New:

```ts
}

// OTA's guest payload → the Sidon shape the rest of this file was written
// against. OTA only says available or not (maintenance included; inactive
// berths are omitted), so every unavailable berth paints as 'occupied'.
// SVG data-berth-id values are berth labels, which the import keeps.
const fromOta = (d: any) => d && ({
  berths: (d.berths || []).map((b: any) => ({ berthId: b.label, lengthM: b.length_m, pricePerNight: b.price_per_night,
    priceMode: b.price_mode, status: b.available ? 'available' : 'occupied', lat: b.lat, lng: b.lng, rotation: b.rotation })),
  priceTiers: (d.price_tiers || []).map((t: any) => ({ validFrom: t.valid_from, validTo: t.valid_to, maxLenM: t.max_length_m, pricePerNight: t.price_per_night })),
  overlays: (d.pontoons || []).map((p: any) => ({ svgData: p.svg_data, swLat: p.sw_lat, swLng: p.sw_lng, neLat: p.ne_lat, neLng: p.ne_lng, rotation: p.rotation })),
  layout: d.marina?.layout && { svgData: d.marina.layout.svg, swLat: d.marina.layout.sw_lat, swLng: d.marina.layout.sw_lng,
    neLat: d.marina.layout.ne_lat, neLng: d.marina.layout.ne_lng, rotation: d.marina.layout.rotation },
});

export const initBerthMapGoogle = (cfg: BerthMapGoogleConfig) => {
  const {
    lat, lng, key, slug, navy, gold,
```

Lines 398-407 (unchanged line numbers above, before the insert). Old:

```ts
    // Cross-origin adaptation: this project is a different origin from
    // sidon-ai, so the fetch below (originally a same-origin relative
    // path) must target sidon-ai's public, CORS-open marina API explicitly.
    const SIDON_ORIGIN = import.meta.env.PUBLIC_SIDON_ORIGIN;
    const buildPublicUrl = () => {
      const range = readDateRange();
      const base = `${SIDON_ORIGIN}/api/marina/public/${encodeURIComponent(ownerId)}`;
      if (!range) return base;
      return `${base}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    };
```

New:

```ts
    // Same-origin: this site's forwarder adds the OTA key server-side.
    // OTA takes the same ?from=&to= window.
    const buildPublicUrl = () => {
      const range = readDateRange();
      const base = `/api/marina/guest/${encodeURIComponent(slug)}`;
      if (!range) return base;
      return `${base}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    };
```

Line 430 (the initial fetch). Old:

```ts
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
```

New:

```ts
      .then(r => r.ok ? r.json() : null)
      .then(fromOta)
      .then((data: any) => {
```

Line 710 (`refreshAvailability`). Old:

```ts
            const fresh = await r2.json();
```

New:

```ts
            const fresh = fromOta(await r2.json());
```

- [ ] **Step 10: Create `MP/src/pages/booking.astro` (R23, G12)**

```astro
---
// OTA's guest emails and confirm link land here with ?booking=&token=.
// Bare on purpose (no site layout, analytics or fonts): the token is in the URL.
import { getMarinaContent } from '../lib/marina-content';
import { MARINA_SLUG } from '../lib/marina-api';

export const prerender = false;
Astro.response.headers.set('Referrer-Policy', 'no-referrer');

// Brand from the primary (it) content entry. No locale attribute: widget
// 1.1 shows the booking in the language it was made in.
const m = (await getMarinaContent('it'))!.data;
const BRAND_STYLE = `--brand-navy: ${m.brand.navy}; --brand-gold: ${m.brand.gold}; --brand-ink: ${m.brand.ink ?? m.brand.navy};`;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Your booking — {m.name}</title>
  </head>
  <body>
    <main style="max-width:680px;margin:0 auto;padding:24px 0">
      <sidon-booking-widget marina={MARINA_SLUG} booking-id variant="dark" marina-name={m.name} logo-mark={m.logoMark} style={BRAND_STYLE}></sidon-booking-widget>
    </main>
    <script>import '@forgebuild/sidon-booking-widget';</script>
  </body>
</html>
```

The static `booking.astro` outranks the dynamic `[locale]/index.astro` for `/booking`.

- [ ] **Step 11: Rewrite `MP/CLAUDE.md`'s Sidon mentions**

Lines 7-12. Old:

```markdown
This standalone project is a spin-out of its page from `sidon-ai` (a
multi-tenant marina SaaS at sidonmarine.uk), the same way `pirates-bight`,
`portals` (Puerto Portals), and `sea-company` (Fox/Pevero Mooring) were
previously spun out — but this is the **first spin-out to use
`@robooko/sidon-booking-widget`** for the booking flow instead of
hand-porting sidon-ai's `Book*.astro`/`BerthsSizeBar` components.
```

New:

```markdown
This standalone project began as a spin-out of its page from `sidon-ai`,
the same way `pirates-bight`, `portals` (Puerto Portals), and `sea-company`
(Fox/Pevero Mooring) were. Its live marina data (berths, prices, map,
bookings) now lives in OTA's marina module. Booking is
`@forgebuild/sidon-booking-widget`, which talks to OTA through this site's
forwarder.
```

Lines 28-67 (from `### Why the widget, not hand-ported booking components` through the end of `### Widget v1 limitations …`, just above the `---` on line 69). Replace the whole block with:

```markdown
### Why the widget, not hand-ported booking components

Every prior spin-out re-implemented sidon-ai's booking wizard from scratch,
causing drift. `@forgebuild/sidon-booking-widget` is the entire booking
surface, embedded once on `/berths`, with zero hand-rolled booking code.
`/booking` (bare, `noindex`, no-referrer header and meta, not in the
sitemap) is where OTA's guest emails and confirm link land with
`?booking=&token=`. Its marina `booking_url` is
`<origin>/booking?booking={id}&token={token}`.

### Booking off switch

Booking needs both `OTA_BASE_URL` and `OTA_API_KEY`. They are set server-side,
and in the Vercel build env for Production AND Preview, because the
prerendered `/location` pages read OTA at build time. Without them:
- `/berths` shows the VHF/phone contacts instead of the map and widget.
- `/location` drops its map pin and WeatherBar.
- The forwarder answers 503.

Env changes take effect only after a redeploy, because Astro inlines them at build.

### The map stays hand-rolled

`BerthsGoogleMap` + `berth-map-google.ts` (the coastal palette) is not the
widget's map. It fetches OTA's guest payload through the forwarder
(`/api/marina/guest/marina-di-positano`) and maps it, in one adapter
(`fromOta`), to the shape it was written against. OTA only says whether a
berth is available, so every unavailable berth paints as `occupied`.
```

Lines 95-99. Old:

```markdown
- **Booking**: `@robooko/sidon-booking-widget` (npm, GitHub Packages) — a
  Svelte-compiled custom element wrapping sidon-ai's entire booking wizard.
  No Stripe/Clerk/Postgres code lives in this repo.
- **No Clerk, no Postgres/Drizzle** — no login surface, no local data store.
  Live berth/pricing/map data is fetched from sidon-ai at request time.
```

New:

```markdown
- **Booking**: `@forgebuild/sidon-booking-widget` (public npm) — a
  Svelte-compiled custom element. It calls OTA's guest API through the
  forwarder `src/pages/api/marina/guest/[...path].ts`, which adds the
  property key server-side. No Stripe/Clerk/Postgres code lives in this repo.
- **No Clerk, no Postgres/Drizzle** — no login surface, no local data store.
  Live marina data is read from OTA (`src/lib/marina-api.ts`,
  `createMarinaClient`) at request and build time.
```

Lines 128-130. Old:

```markdown
- Any fetch to sidon-ai's API (server or client-side) must use an absolute
  URL (`SIDON_URL` server-side, `PUBLIC_SIDON_ORIGIN` client-side) — this
  project is a different origin, relative paths won't reach sidon-ai
```

New:

```markdown
- OTA reads go through `getMarina()` (`src/lib/marina-api.ts`) on the
  server and the same-origin forwarder (`/api/marina/guest/...`) in the
  browser — the API key never reaches the browser
```

- [ ] **Step 12: Type check and leftovers**

```bash
cd /c/Users/robert/source/repos/marina-di-positano && npx astro check 2>&1 | tail -4
cd /c/Users/robert/source/repos/marina-di-positano && grep -rn "robooko\|SIDON_URL\|PUBLIC_SIDON_ORIGIN\|sidonmarine\|api/marina/public\|ownerId\|api-origin\|currency-symbol" src package.json astro.config.mjs CLAUDE.md
```

Expected:
- The error count is no higher than the Step 2 baseline E.
- The grep prints only `src/content.config.ts:15` and the four `ownerId:` content lines (the stale, unused content field; out of scope).

- [ ] **Step 13: Seed, start local OTA, build with env; sitemap**

Run each line as its own Bash call. The OTA server uses `run_in_background`.

```bash
cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=marina-di-positano node scripts/seed-marina-demo.js | grep -v '^api_key='
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start
```

Expected seed output ends with `slug=marina-di-positano`. Wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/api/marina/guest/marina-di-positano` prints `401` (OTA up; the key isn't sent). Then:

```bash
cd /c/Users/robert/source/repos/marina-di-positano && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=marina-di-positano node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npm run build 2>&1 | tail -3
cd /c/Users/robert/source/repos/marina-di-positano && for f in $(find dist -path '*location/index.html'); do echo "$f $(grep -c 'wxb-temp' $f)"; done
cd /c/Users/robert/source/repos/marina-di-positano && grep -o '<loc>[^<]*booking[^<]*</loc>' $(find dist -name 'sitemap-0.xml')
```

Expected:
- The build ends with `Complete!`.
- Four location files (`location`, `en/location`, `es/location`, `fr/location`), each with `1` (WeatherBar present).
- The sitemap grep prints `<loc>https://marina-di-positano.vercel.app/booking/</loc>`. `@astrojs/sitemap` lists static SSR routes, as it already does `/berths/`.

Because that `/booking` entry is listed, edit `MP/astro.config.mjs` line 17. If the grep printed nothing, skip this edit and drop `astro.config.mjs` from the commit. Old:

```js
  integrations: [sitemap()],
```

New:

```js
  // /booking carries a guest's booking token and is noindex; @astrojs/sitemap
  // lists static SSR routes (like /berths), so filter it out explicitly.
  integrations: [sitemap({ filter: (p) => !p.includes('/booking') })],
```

Rebuild with the same env command, then:

```bash
cd /c/Users/robert/source/repos/marina-di-positano && grep -c '/booking' $(find dist -name 'sitemap-0.xml')
```

Expected: `0`.

- [ ] **Step 14: Empty-env build (kill switch; Review Focus 5)**

```bash
cd /c/Users/robert/source/repos/marina-di-positano && OTA_BASE_URL= OTA_API_KEY= npm run build 2>&1 | tail -3
cd /c/Users/robert/source/repos/marina-di-positano && for f in $(find dist -path '*location/index.html'); do echo "$f $(grep -c 'wxb-temp' $f)"; done
```

Expected:
- `Complete!`. The prerendered location pages build with no OTA env.
- Four location files, each with `0` (WeatherBar hidden).

- [ ] **Step 15: Dev server with env: forwarder, map fetch, berths page, booking page**

`run_in_background`:

```bash
cd /c/Users/robert/source/repos/marina-di-positano && KEY=$(cd /c/Users/robert/source/repos/OTA && MARINA_DEMO_SLUG=marina-di-positano node scripts/seed-marina-demo.js | sed -n 's/^api_key=//p'); OTA_BASE_URL=http://localhost:3100 OTA_API_KEY=$KEY npx astro dev --port 4404
```

Wait until `curl -sk -o /dev/null -w '%{http_code}' https://localhost:4404/` prints `200`. Then run each line as its own call:

```bash
curl -sk https://localhost:4404/api/marina/guest/marina-di-positano | head -c 300
curl -sk https://localhost:4404/api/marina/guest/marina-di-positano | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log(d.marina.slug,d.berths.map(b=>b.label+':'+b.available).join(' '))})"
curl -sk https://localhost:4404/src/scripts/berth-map-google.ts | grep -c '/api/marina/guest/'
curl -sk https://localhost:4404/src/scripts/berth-map-google.ts | grep -c 'PUBLIC_SIDON_ORIGIN\|api/marina/public'
curl -sk https://localhost:4404/berths -o /c/tmp/plan-d/mp-berths.html; grep -c '<sidon-booking-widget' /c/tmp/plan-d/mp-berths.html; grep -c 'marina="marina-di-positano"' /c/tmp/plan-d/mp-berths.html; grep -c 'api-origin\|currency-symbol' /c/tmp/plan-d/mp-berths.html
```

Expected, in order:
1. JSON starting `{"marina":{"name":`.
2. `marina-di-positano A1:true A2:true A3:true A4:true A5:true A6:false` (A6 is maintenance; another berth can read `false` only if an earlier run's booking covers today).
3. `>= 1`. The map module that Vite serves fetches the same forwarder URL curled above.
4. `0`.
5. `1`, `1`, `0`.

Create a hold through the forwarder and open its booking page:

```bash
A=$(date -d '+30 days' +%F); D=$(date -d '+32 days' +%F); curl -sk -o /c/tmp/plan-d/mp-book.json -w '%{http_code}\n' -X POST https://localhost:4404/api/marina/guest/marina-di-positano/bookings -H 'Content-Type: application/json' -d "{\"berth_label\":\"A2\",\"arrival\":\"$A\",\"departure\":\"$D\",\"contact_name\":\"Plan D\",\"contact_email\":\"plan-d+mp@example.com\",\"boat_name\":\"Check\",\"boat_length_m\":9}"
```

Expected: `201`. A `409` means a previous run's booking still holds A2, so repeat with `"berth_label":\"A4\"`. The token stays in the file and is never echoed.

```bash
ID=$(node -p "require('C:/tmp/plan-d/mp-book.json').booking.id"); TOKEN=$(node -p "require('C:/tmp/plan-d/mp-book.json').booking_token"); curl -sk -D - "https://localhost:4404/booking?booking=$ID&token=$TOKEN" -o /c/tmp/plan-d/mp-booking.html | grep -i -e '^HTTP' -e '^referrer-policy'
grep -c '<sidon-booking-widget' /c/tmp/plan-d/mp-booking.html; grep -c 'content="no-referrer"' /c/tmp/plan-d/mp-booking.html; grep -c 'noindex' /c/tmp/plan-d/mp-booking.html; grep -c 'locale=\|api-origin\|currency-symbol' /c/tmp/plan-d/mp-booking.html
```

Expected:
- `HTTP/1.1 200 OK` and `referrer-policy: no-referrer`.
- Then `1`, `1`, `1`, `0` (Review Focus 4; G12; R24).

Map in a browser (Playwright MCP):
1. `browser_navigate` to `https://localhost:4404/berths`.
2. `browser_wait_for` the text `A1`.
3. `browser_evaluate`: `() => [...document.querySelectorAll('[data-berth-id]')].map(e => e.getAttribute('data-berth-id') + ':' + e.getAttribute('data-status')).join(' ')`.
4. `browser_network_requests`.

Expected:
- The evaluate returns `A1:available A2:available A3:available A4:available A5:available A6:occupied` (fromOta applied).
- The request list shows `GET https://localhost:4404/api/marina/guest/marina-di-positano => 200` and no request to any Sidon origin.

If the console shows a Google Maps key error (`RefererNotAllowedMapError`), record it and rely on the curl checks above. The overlay can't render without Maps.

- [ ] **Step 16: Kill-switch dev (Review Focus 5)**

Stop the Step 15 dev server (TaskStop on its shell). Restart it with `run_in_background`:

```bash
cd /c/Users/robert/source/repos/marina-di-positano && OTA_BASE_URL= OTA_API_KEY= npx astro dev --port 4404
```

Once `https://localhost:4404/` answers 200:

```bash
curl -sk https://localhost:4404/berths -o /c/tmp/plan-d/mp-berths-off.html -w '%{http_code}\n'; grep -c '<sidon-booking-widget' /c/tmp/plan-d/mp-berths-off.html; grep -c 'La prenotazione online' /c/tmp/plan-d/mp-berths-off.html; grep -c 'tel:+390898753260' /c/tmp/plan-d/mp-berths-off.html
curl -sk https://localhost:4404/en/berths -o /dev/null -w '%{http_code}\n'
curl -sk -w '\n%{http_code}\n' https://localhost:4404/api/marina/guest/marina-di-positano
```

Expected:
- `200`, `0`, `1`, `1`.
- `200`.
- `{"error":"Online booking is not available"}` then `503`.

- [ ] **Step 17: Stop servers, check the tree**

Stop the dev server and the local OTA server (TaskStop on both background shells). Then:

```bash
git -C /c/Users/robert/source/repos/marina-di-positano status --short
```

Expected, exactly:

```
 M CLAUDE.md
 M astro.config.mjs
 M package.json
 M src/components/marina-page/BerthsGoogleMap.astro
 M src/components/pages/BerthsPageBody.astro
 M src/components/pages/LocationBody.astro
 M src/lib/marina-api.ts
 M src/scripts/berth-map-google.ts
?? src/pages/api/
?? src/pages/booking.astro
```

There is no `package-lock.json` (G6) and no `.npmrc` (gitignored; deleted locally).

- [ ] **Step 18: Commit on `cutover/switch` (never push; no `gh repo create`, which is a runbook step)**

```bash
git -C /c/Users/robert/source/repos/marina-di-positano add package.json astro.config.mjs CLAUDE.md src/lib/marina-api.ts src/components/pages/BerthsPageBody.astro src/components/pages/LocationBody.astro src/components/marina-page/BerthsGoogleMap.astro src/scripts/berth-map-google.ts src/pages/booking.astro "src/pages/api/marina/guest/[...path].ts"
git -C /c/Users/robert/source/repos/marina-di-positano commit -m "$(cat <<'EOF'
Cutover: book through OTA with widget 1.1

@robooko/sidon-booking-widget 0.2.1 -> @forgebuild/sidon-booking-widget
^1.1.0 (the lockfile is refreshed after npm publish). A forwarder at
/api/marina/guest/* adds the OTA key server-side. A bare /booking page
(no-referrer header and meta, noindex, filtered from the sitemap) is where
OTA's emails and confirm link land.

marina-api.ts reads OTA through a lazy createMarinaClient. Without
OTA_BASE_URL/OTA_API_KEY: booking hides, /berths shows VHF/phone contacts,
the prerendered /location pages build without the pin and WeatherBar, and
the forwarder answers 503. The hand-rolled map fetches through the
forwarder and maps OTA's payload in one adapter (fromOta). api-origin and
currency-symbol are gone (amounts use Intl in the property currency).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git -C /c/Users/robert/source/repos/marina-di-positano log --oneline -1
```

Expected: one new commit on `cutover/switch`. The repo is left on `cutover/switch`. Nothing is pushed and no remote exists.

The runbook does all of this later, with the user's go-ahead:
1. `gh repo create robooko/marina-di-positano --private --source . --push`.
2. `npm install` after `npm publish`, then commit `package-lock.json`.
3. Vercel Production + Preview `OTA_BASE_URL`/`OTA_API_KEY`; remove `SIDON_URL`, `PUBLIC_SIDON_ORIGIN` and `NODE_AUTH_TOKEN`; redeploy.
4. Set the marina's `booking_url` at Step 6.

---

### Task 10: sidon-marina cutover/freeze

**Repo and branch:** SM = `C:/Users/robert/source/repos/sidon-marina`. Create branch `cutover/freeze` from `origin/master` (`efcd6b1`). Never cut it from local `master`, which is 7 AI commits ahead (R6). Don't run `git fetch`: `origin/master` is the local ref.

**Files:**
- Create: `src/lib/cutover.ts`
- Create: `scripts/check-cutover.ts`
- Modify: `src/middleware.ts` (whole file, 4 lines on `origin/master`)
- Never commit: `.scratch-cancel-booking.mjs` (untracked, R6)

**Interfaces:**
- Consumes: `CORS_HEADERS` from `src/lib/cors.ts` (`{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Marina-Key'}`), `defineMiddleware` and `sequence` from `astro:middleware`, and `clerkMiddleware` from `@clerk/astro/server`.
- Produces: the freeze part of `src/lib/cutover.ts`:
  - `type CutoverPhase = 'freeze' | 'switch'`
  - `const CUTOVER_PHASE: CutoverPhase = 'freeze'`
  - `const OTA_DASHBOARD_DEFAULT = 'https://hotal.forge-build.co.uk'`
  - `type CutoverAction` (all four kinds plus `null`)
  - `cutoverAction(phase, method, pathname, dashboardUrl): CutoverAction`. It applies only the freeze rule. Under `'switch'` it returns `null` until Task 11 extends it on `cutover/switch`.
  - It also produces `src/middleware.ts`: `export const onRequest = sequence(cutover, clerkMiddleware());`.
  - Task 11 builds on this branch: it adds `gone`, `preflight` and `redirect` to the middleware mapping, flips `CUTOVER_PHASE`, and adds `MARINA_SITES` and `marinaSiteRedirect`.

- [ ] **Step 1: Dirty-tree gate (R6)**

Run:
```bash
git -C /c/Users/robert/source/repos/sidon-marina status --short
```
Expected: exactly the line `?? .scratch-cancel-booking.mjs`, or nothing. Anything else means stop: don't switch branches, and report the printed lines to the user. They must commit or stash that work first.

Today this check fails. The tree shows ` M astro.config.mjs`, ` M public/favicon.svg` and ` M src/components/marina-dashboard/MarinaMapTab.astro`.

- [ ] **Step 2: Cut the branch from origin/master**

```bash
git -C /c/Users/robert/source/repos/sidon-marina switch -c cutover/freeze origin/master
git -C /c/Users/robert/source/repos/sidon-marina log --oneline -1
```
Expected: `Switched to a new branch 'cutover/freeze'`, then `efcd6b1 Restore /api/ably/token, dropped during the marina split`.

The local `master` ref stays untouched. Don't run `npm install`: `origin/master`'s `package.json` is a subset of local `master`'s (local master only adds `@vercel/functions`), so the existing `node_modules` builds this branch.

- [ ] **Step 3: Write the failing check**

Create `/c/Users/robert/source/repos/sidon-marina/scripts/check-cutover.ts`:

```ts
// Offline checks for the cutover rules in src/lib/cutover.ts. No key, no DB.
//   node scripts/check-cutover.ts
import assert from 'node:assert/strict';
import { CUTOVER_PHASE, OTA_DASHBOARD_DEFAULT, cutoverAction } from '../src/lib/cutover.ts';

const checks: [string, () => void | Promise<void>][] = [];
const check = (name: string, fn: () => void | Promise<void>) => checks.push([name, fn]);

const DASH = OTA_DASHBOARD_DEFAULT;
// Owner dashboard, public widget-0.4 and enquiry routes: all must freeze.
const API_PATHS = ['/api/marina/berths', '/api/marina/bookings', '/api/marina/public/user_x/book', '/api/marina/public/user_x/enquiry'];

check('this branch ships the freeze', () => {
  assert.equal(CUTOVER_PHASE, 'freeze');
  assert.equal(OTA_DASHBOARD_DEFAULT, 'https://hotal.forge-build.co.uk');
});

check('freeze: writes to /api/marina/* are read-only', () => {
  for (const path of API_PATHS) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.deepEqual(cutoverAction('freeze', method, path, DASH), { kind: 'readonly' }, `${method} ${path}`);
    }
  }
});

check('freeze: reads and preflights pass through', () => {
  // OPTIONS must reach the route so widget 0.4 preflights still get 204 + CORS.
  for (const path of [...API_PATHS, '/api/marina/public/list']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(cutoverAction('freeze', method, path, DASH), null, `${method} ${path}`);
    }
  }
});

check('freeze: only /api/marina/* is touched', () => {
  for (const path of ['/marina', '/marina/settings', '/', '/en/m/pirates-bight', '/api/ably/token', '/api/marina', '/api/marinas/x']) {
    for (const method of ['GET', 'POST']) {
      assert.equal(cutoverAction('freeze', method, path, DASH), null, `${method} ${path}`);
    }
  }
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${(err as Error).stack}`); }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 4: Run it and watch it fail**

```bash
cd /c/Users/robert/source/repos/sidon-marina && node scripts/check-cutover.ts
```
Expected: exit 1 with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\robert\source\repos\sidon-marina\src\lib\cutover.ts' imported from C:\Users\robert\source\repos\sidon-marina\scripts\check-cutover.ts
```

Node 25 strips TypeScript types itself, so no loader is needed.

- [ ] **Step 5: Implement `src/lib/cutover.ts`**

Create `/c/Users/robert/source/repos/sidon-marina/src/lib/cutover.ts`. It uses erasable-only TypeScript (no enums or namespaces) so that plain Node can run the check.

```ts
// Sidon Marina's side of the move to OTA (spec "Cutover" steps 3 and 6).
// Pure and import-free so scripts/check-cutover.ts runs it under plain Node;
// src/middleware.ts turns the action into a Response.

export type CutoverPhase = 'freeze' | 'switch';

// The cutover/switch commit changes this to 'switch'.
export const CUTOVER_PHASE: CutoverPhase = 'freeze';

export const OTA_DASHBOARD_DEFAULT = 'https://hotal.forge-build.co.uk';

export type CutoverAction =
  | { kind: 'readonly' }                      // 503
  | { kind: 'gone' }                          // 410
  | { kind: 'preflight' }                     // 204
  | { kind: 'redirect'; location: string }    // 301
  | null;                                     // fall through

// GETs that happen to write (apikey, stripe/status, the /marina org
// auto-provision) stay open on purpose: they touch no booking data and the
// import runs after the freeze. OPTIONS stays open so preflights keep
// answering 204 from the routes.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cutoverAction(phase: CutoverPhase, method: string, pathname: string, dashboardUrl: string): CutoverAction {
  if (phase === 'freeze' && pathname.startsWith('/api/marina/') && !READ_METHODS.has(method)) {
    return { kind: 'readonly' };
  }
  // The switch rules (410, dashboard redirect via dashboardUrl) ship on the
  // cutover/switch branch; until then 'switch' falls through like everything else.
  return null;
}
```

- [ ] **Step 6: Run the check again**

```bash
cd /c/Users/robert/source/repos/sidon-marina && node scripts/check-cutover.ts
```
Expected: exit 0 with:

```
ok   this branch ships the freeze
ok   freeze: writes to /api/marina/* are read-only
ok   freeze: reads and preflights pass through
ok   freeze: only /api/marina/* is touched

all passed
```

- [ ] **Step 7: Wire the middleware**

Replace the whole of `/c/Users/robert/source/repos/sidon-marina/src/middleware.ts`.

Old (`origin/master`):
```ts
import { sequence } from 'astro:middleware';
import { clerkMiddleware } from '@clerk/astro/server';

export const onRequest = sequence(clerkMiddleware());
```

New:
```ts
import { defineMiddleware, sequence } from 'astro:middleware';
import { clerkMiddleware } from '@clerk/astro/server';
import { CORS_HEADERS } from './lib/cors';
import { CUTOVER_PHASE, OTA_DASHBOARD_DEFAULT, cutoverAction } from './lib/cutover';

const DASH = import.meta.env.OTA_DASHBOARD_URL || OTA_DASHBOARD_DEFAULT;

// Cutover: Sidon is read-only until Switch. Runs before clerkMiddleware() so a
// blocked request costs no Clerk call. API routes are all prerender = false,
// so this sees every /api/marina/* request on Vercel.
const cutover = defineMiddleware((ctx, next) => {
  const action = cutoverAction(CUTOVER_PHASE, ctx.request.method, ctx.url.pathname, DASH);
  if (action?.kind === 'readonly') {
    // CORS headers so widget 0.4 on the marinas' own sites sees this 503,
    // not an opaque CORS failure.
    return new Response(
      JSON.stringify({ error: 'Sidon Marina is read-only while marinas move to a new booking system. Please try again later.' }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': '86400' } },
    );
  }
  return next();
});

export const onRequest = sequence(cutover, clerkMiddleware());
```

- [ ] **Step 8: Build gate**

```bash
cd /c/Users/robert/source/repos/sidon-marina && npm run build
```
Expected: exit 0, ending with `[build] Complete!`. The local `.env` supplies the Clerk and Sanity values the build already needs on `origin/master`, so no new env var is required. `OTA_DASHBOARD_URL` is unset here, so the build falls back to `OTA_DASHBOARD_DEFAULT`.

- [ ] **Step 9: Dev smoke of the middleware**

Start the dev server with `run_in_background`:
```bash
cd /c/Users/robert/source/repos/sidon-marina && npx astro dev --port 4390
```

Then run each of these as its own Bash call:
```bash
curl -s -D - -X POST http://localhost:4390/api/marina/berths -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS http://localhost:4390/api/marina/public/list
```
Expected:
- The first call prints `HTTP/1.1 503`, `access-control-allow-origin: *`, `content-type: application/json` and `retry-after: 86400`, with the body `{"error":"Sidon Marina is read-only while marinas move to a new booking system. Please try again later."}`.
- The second call prints `204`.

The POST goes to an authenticated route, so even a broken middleware would answer 401 and write nothing. No GET is sent, so nothing touches Sidon's live DB.

Stop the dev server.

- [ ] **Step 10: Commit on cutover/freeze**

```bash
git -C /c/Users/robert/source/repos/sidon-marina add src/lib/cutover.ts scripts/check-cutover.ts src/middleware.ts
git -C /c/Users/robert/source/repos/sidon-marina commit -m "Cutover freeze: Sidon Marina API is read-only (503) for non-GET requests

Middleware runs before Clerk and answers every POST/PUT/DELETE/PATCH under
/api/marina/* with a CORS-enabled 503 and Retry-After, so the marina sites'
widget 0.4 sees a clear error. Reads and preflights pass. The rule lives in
src/lib/cutover.ts, checked by node scripts/check-cutover.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/sidon-marina status --short
git -C /c/Users/robert/source/repos/sidon-marina log --oneline -2
```
Expected:
- `status` prints only `?? .scratch-cancel-booking.mjs`.
- `log` prints the new commit on top of `efcd6b1`.

SM is left on `cutover/freeze`. Nothing is pushed, local `master` is untouched, and the `ai-replies-shelved` tag isn't created here. Runbook Step 3 is what later pushes `cutover/freeze`, merges it to `master` and deploys it to Vercel production. That needs the user's go-ahead, comes after the tag and the approved local-`master` reset, and ends with a curl of the preview: POST `/api/marina/berths` → 503, OPTIONS `/api/marina/public/<owner>/book` → 204, GET `/api/marina/public/<owner>` → 200.

---

### Task 11: sidon-marina cutover/switch

Repo: `SM` = `C:/Users/robert/source/repos/sidon-marina`. Branch: `cutover/switch`, cut from `cutover/freeze` (Task 10), which was itself cut from `origin/master`. All commands are Git Bash and run from `SM`. Local `master` (`88ee507`, 7 AI commits ahead) is never checked out, reset or committed to. Tagging `ai-replies-shelved` and resetting `master` are runbook steps.

**Files:**
- Modify (full rewrite): `C:/Users/robert/source/repos/sidon-marina/src/lib/cutover.ts` (Task 10's freeze file. The freeze rule is carried over unchanged; this adds the switch rules, `MARINA_SITES`, `marinaSiteRedirect` and `CUTOVER_PHASE = 'switch'`.)
- Modify (full rewrite): `C:/Users/robert/source/repos/sidon-marina/scripts/check-cutover.ts` (Task 10's freeze assertions are kept as the freeze block; switch and redirect cases are added.)
- Modify (full rewrite): `C:/Users/robert/source/repos/sidon-marina/src/middleware.ts` (maps `gone`, `preflight` and `redirect` as well as `readonly`)
- Modify: `C:/Users/robert/source/repos/sidon-marina/src/components/marina/NavMarinaSite.astro` (frontmatter lines 1-6; line 23; lines 27-37; line 61)
- Modify (full rewrite): `C:/Users/robert/source/repos/sidon-marina/src/pages/m/[slug]/booking/[id].astro` (a 302 with no content or DB lookup)
- Modify (full rewrite): `C:/Users/robert/source/repos/sidon-marina/src/pages/[lang]/m/[slug]/booking/[id].astro` (the static "no longer valid" notice)
- Create: `C:/Users/robert/source/repos/sidon-marina/src/pages/m/[slug]/[...path].astro`
- Create: `C:/Users/robert/source/repos/sidon-marina/src/pages/[lang]/m/[slug]/[...path].astro`
- Delete: the public pages
  - every other file under `src/pages/m/`:
    - `[slug]/{index,berths,contacts,location,services,weather,services/book}.astro`
    - `pirates-bight/{berths,contacts,experiences,services/book}.astro`
  - every other file under `src/pages/[lang]/m/`:
    - `[slug]/{index,berths,contacts,location,services,weather,services/book}.astro`
    - `pirates-bight/location.astro`
- Delete: the public-site tree that only those pages reached. An import-graph walk over `origin/master` shows it becomes unreachable once the pages above are gone:
  - all of `src/components/marina-page/**` (48 files). This includes `MarinaMessageSticky.astro`, `MarinaEnquiryDrawer.astro` and every `Berths*`/`Book*` component in the survey's §2 list. It also includes the 5 files in that directory that were already unimported (`BerthsCategoryTabs`, `BerthsHero`, `BerthsIntro`, `WeatherStrip`, `WhatsAppSticky`).
  - all of `src/scripts/**`: `berth-map-google`, `berths-booking-card`, `book-contract`, `book-doc-uploads`, `book-nav`, `book-payment`, `book-resend-email`, `book-success-live` and `date-range-picker` (`.ts`).
  - the layouts `src/layouts/MarinaPageLayout.astro`, `src/layouts/MarinaBookingLayout.astro`, `src/layouts/MarinaBookingPageLayout.astro` and `src/layouts/PiratesBightLayout.astro`
  - `src/components/LenisScroll.astro` (only `MarinaPageLayout` imported it)
  - `src/lib/book-i18n.ts`
  - `src/styles/flatpickr-theme.css` (only `BookSummary` and `berths-booking-card` imported it)
- Kept on purpose, because a remaining file still imports it or it is dashboard/API code for the day-90 clean-up:
  - `src/lib/marina-content.ts` and `src/lib/currency.ts` (imported by `api/marina/public/booking/[id]/resend.ts`, `api/marina/currency.ts` and `lib/email.ts`)
  - `src/content/marinas/*.md` and `src/content.config.ts`
  - `src/components/marina-dashboard/**`, including `MarinaMapTab.astro`, which imports nothing from the deleted set
  - `src/components/NavAuth.astro` and `NavAuthFallback.astro` (no longer mounted, but still importing `MarinaDocuments`/`MarinaContracts`/`MarinaApi`/`MarinaPriceTiers`)
  - `src/lib/clerkAppearance.ts` (still imported by `NavAuth.astro`)
  - `src/layouts/LayoutMarina.astro` and `src/layouts/Layout.astro`
  - every `src/pages/api/**` file and `src/pages/marina.astro`. Middleware makes them unreachable, so a rollback is a redeploy of `cutover/freeze`.
  - `package.json` is unchanged, and `flatpickr`, `lenis` and the other dependencies stay until the day-90 clean-up.
- Never committed: `.scratch-cancel-booking.mjs`.

**Interfaces:**
- Consumes:
  - From Task 10 (`cutover/freeze`): `src/lib/cutover.ts` with `CutoverPhase`, `CUTOVER_PHASE`, `OTA_DASHBOARD_DEFAULT = 'https://hotal.forge-build.co.uk'`, `CutoverAction` and `cutoverAction(phase, method, pathname, dashboardUrl)`. Also `scripts/check-cutover.ts`, and `src/middleware.ts` = `sequence(cutover, clerkMiddleware())`.
  - `CORS_HEADERS` from `src/lib/cors.ts`.
  - Env `OTA_DASHBOARD_URL`. It is optional; `OTA_DASHBOARD_DEFAULT` is the fallback. Astro inlines it at build time.
- Produces:
  - `CUTOVER_PHASE = 'switch'`.
  - `cutoverAction('switch', …)`:
    - `/api/marina/…` + `OPTIONS` → `{ kind: 'preflight' }`.
    - `/api/marina/…` + any other method → `{ kind: 'gone' }`. There is no `/api/marina/guest/` exemption, because SM gets no forwarder (R1).
    - `/marina` and `/marina/…` → `{ kind: 'redirect', location: \`${dashboardUrl}/marina\` }`.
    - anything else → `null`.
  - `export const MARINA_SITES: Record<string, string>` with the contract defaults, and `export function marinaSiteRedirect(pathname: string): string | null`.
  - Middleware responses:
    - 503 `readonly` (unchanged)
    - 410 with `{"error":"Sidon Marina has moved to OTA","details":"Berth booking now runs on each marina's own website; staff use <DASH>/marina"}`, plus `CORS_HEADERS` and `Content-Type: application/json`
    - 204 preflight with `CORS_HEADERS`
    - 301 `Location: <DASH>/marina`
  - Pages:
    - `/m/<slug>/*` and `/<lang>/m/<slug>/*` → 301 to `MARINA_SITES[slug]`; an unknown slug → 404
    - `/m/<slug>/booking/<id>` → 302 to `/en/m/<slug>/booking/<id>`
    - `/<lang>/m/<slug>/booking/<id>` → 200, the static `noindex` notice
  - Branch `cutover/switch` (one commit) for the runbook's Step 6. Before that merge, the runbook replaces the `MARINA_SITES` values with the confirmed production origins and sets `OTA_DASHBOARD_URL` in SM's Vercel env, then redeploys.

- [ ] **Step 1: Gate — Task 10's commit exists and the tree is clean**

Run:
```bash
cd /c/Users/robert/source/repos/sidon-marina && git status --short; git log --oneline -1 cutover/freeze; git merge-base --is-ancestor origin/master cutover/freeze && echo "freeze-on-origin-master"
```
Expected:
- `git status --short` prints exactly `?? .scratch-cancel-booking.mjs`.
- One `cutover/freeze` commit line.
- `freeze-on-origin-master`.

If anything else appears (for example the ` M astro.config.mjs`, ` M public/favicon.svg` and ` M src/components/marina-dashboard/MarinaMapTab.astro` WIP seen on 2026-10-12), or `cutover/freeze` doesn't exist, STOP and report (R6). Do not stash or commit the user's work.

- [ ] **Step 2: Cut the branch and confirm the freeze baseline passes**

Run:
```bash
cd /c/Users/robert/source/repos/sidon-marina && git switch -c cutover/switch cutover/freeze && node scripts/check-cutover.ts; echo "exit=$?"
```
Expected: `Switched to a new branch 'cutover/switch'`, then Task 10's check output, then `exit=0`.

- [ ] **Step 3: Write the failing check**

Replace `scripts/check-cutover.ts` entirely. Its freeze block asserts the same freeze contract Task 10 pinned (R31), so a freeze regression still fails here.

```ts
// Asserts sidon-marina's cutover rules (freeze, then switch). No test runner
// in this repo: Node strips the types, so run `node scripts/check-cutover.ts`.
import assert from 'node:assert/strict';
import { CUTOVER_PHASE, MARINA_SITES, cutoverAction, marinaSiteRedirect } from '../src/lib/cutover.ts';

const DASH = 'https://dash.example';
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const READ = ['GET', 'HEAD', 'OPTIONS'];

// Freeze (spec Cutover step 3): writes to /api/marina/* get 503, reads pass.
for (const m of METHODS) {
  for (const p of ['/api/marina/berths', '/api/marina/public/abc/book']) {
    assert.deepEqual(cutoverAction('freeze', m, p, DASH), READ.includes(m) ? null : { kind: 'readonly' }, `freeze ${m} ${p}`);
  }
}
assert.equal(cutoverAction('freeze', 'POST', '/api/chat', DASH), null, 'freeze leaves the chatbot alone');
assert.equal(cutoverAction('freeze', 'GET', '/marina', DASH), null, 'freeze keeps the dashboard');
assert.equal(cutoverAction('freeze', 'GET', '/m/fox-mooring', DASH), null, 'freeze keeps public pages');

// Switch (spec Cutover step 6): every /api/marina/* call is gone, every method.
// No /api/marina/guest/ exemption: SM has no forwarder (R1).
assert.equal(CUTOVER_PHASE, 'switch');
for (const m of METHODS) {
  for (const p of ['/api/marina/berths', '/api/marina/public/abc/book', '/api/marina/public/list', '/api/marina/guest/fox-mooring']) {
    assert.deepEqual(cutoverAction('switch', m, p, DASH), m === 'OPTIONS' ? { kind: 'preflight' } : { kind: 'gone' }, `switch ${m} ${p}`);
  }
}
for (const m of METHODS) {
  for (const p of ['/marina', '/marina/', '/marina/settings']) {
    assert.deepEqual(cutoverAction('switch', m, p, DASH), { kind: 'redirect', location: `${DASH}/marina` }, `switch ${m} ${p}`);
  }
}
for (const p of ['/', '/marinas', '/api/chat', '/api/ably/token', '/m/fox-mooring', '/en/m/fox-mooring/booking/1']) {
  assert.equal(cutoverAction('switch', 'GET', p, DASH), null, `switch passes ${p}`);
}

// Public marina pages -> the marina's own site (R1). One URL per slug: the
// sites' paths don't line up with Sidon's.
assert.deepEqual(Object.keys(MARINA_SITES).sort(), ['fox-mooring', 'marina-di-positano', 'pevero-mooring', 'pirates-bight', 'puerto-portals']);
for (const [slug, url] of Object.entries(MARINA_SITES)) {
  assert.match(url, /^https:\/\/[^/]+\//, `${slug} is an absolute https URL`);
  for (const p of [`/m/${slug}`, `/m/${slug}/`, `/m/${slug}/berths`, `/m/${slug}/services/book`,
                   `/en/m/${slug}`, `/it/m/${slug}/berths`, `/es/m/${slug}/contacts`, `/fr/m/${slug}/services/book`]) {
    assert.equal(marinaSiteRedirect(p), url, p);
  }
}
assert.equal(marinaSiteRedirect('/it/m/fox-mooring/berths'), MARINA_SITES['fox-mooring']);
assert.equal(marinaSiteRedirect('/m/pevero-mooring'), MARINA_SITES['pevero-mooring']);
assert.notEqual(MARINA_SITES['pevero-mooring'], MARINA_SITES['fox-mooring'], 'Pevero has its own page on the SEA site');

// Old emailed booking links keep the "no longer valid" page; unknown slugs
// (BBYC was never served here) and non-marina paths fall through to 404.
for (const p of ['/en/m/fox-mooring/booking/123', '/en/m/fox-mooring/booking/123/', '/m/fox-mooring/booking/123',
                 '/m/bora-bora-yacht-club', '/en/m/unknown/berths', '/m/constructor', '/m/__proto__/berths',
                 '/', '/marina', '/en/m', '/eng/m/fox-mooring']) {
  assert.equal(marinaSiteRedirect(p), null, p);
}

console.log('check-cutover: all passed');
```

- [ ] **Step 4: Run it and watch it fail**

Run: `cd /c/Users/robert/source/repos/sidon-marina && node scripts/check-cutover.ts; echo "exit=$?"`

Expected: FAIL with
```
SyntaxError: The requested module '../src/lib/cutover.ts' does not provide an export named 'MARINA_SITES'
```
and `exit=1`. The freeze-branch module has no `MARINA_SITES`/`marinaSiteRedirect` yet.

- [ ] **Step 5: Implement the switch rules in `src/lib/cutover.ts`**

Replace the whole file:

```ts
// Sidon Marina's side of the OTA cutover. Pure on purpose (no astro: or env
// imports) so scripts/check-cutover.ts can run it under plain Node.

export type CutoverPhase = 'freeze' | 'switch';
// Freeze (spec step 3) makes /api/marina/* read-only; Switch (step 6) retires
// it and sends staff to the OTA dashboard. Rollback = redeploy cutover/freeze.
export const CUTOVER_PHASE: CutoverPhase = 'switch';
export const OTA_DASHBOARD_DEFAULT = 'https://hotal.forge-build.co.uk';

export type CutoverAction =
  | { kind: 'readonly' }                                      // 503
  | { kind: 'gone' }                                          // 410
  | { kind: 'preflight' }                                     // 204
  | { kind: 'redirect'; location: string }                    // 301
  | null;                                                     // fall through

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cutoverAction(phase: CutoverPhase, method: string, pathname: string, dashboardUrl: string): CutoverAction {
  const api = pathname.startsWith('/api/marina/');
  if (phase === 'freeze') return api && !READ.has(method) ? { kind: 'readonly' } : null;
  // Switch: no Sidon API survives (SM has no forwarder; each marina's own
  // site has one). Preflights still answer so browsers see the 410 body
  // instead of a CORS error.
  if (api) return method === 'OPTIONS' ? { kind: 'preflight' } : { kind: 'gone' };
  if (pathname === '/marina' || pathname.startsWith('/marina/')) return { kind: 'redirect', location: `${dashboardUrl}/marina` };
  return null;
}

// slug -> the marina's home on its own site. Runbook inputs: Step 6 replaces
// these with the confirmed production origins before this branch merges.
// BBYC is absent on purpose: SM never served it.
export const MARINA_SITES: Record<string, string> = {
  'pirates-bight': 'https://pirates-bight.vercel.app/',
  'fox-mooring': 'https://sea-company.vercel.app/',
  'pevero-mooring': 'https://sea-company.vercel.app/pevero-mooring',
  'marina-di-positano': 'https://marina-di-positano.vercel.app/',
  'puerto-portals': 'https://portals.vercel.app/',
};

const MARINA_PATH = /^\/(?:[a-z]{2}\/)?m\/([^/]+)(?:\/(.*))?$/;

export function marinaSiteRedirect(pathname: string): string | null {
  const match = MARINA_PATH.exec(pathname);
  if (!match) return null;
  const [, slug, rest] = match;
  // Old emailed/QR booking links get the "no longer valid" page, not a redirect.
  if (rest !== undefined && /^booking\/[^/]+\/?$/.test(rest)) return null;
  // Every sub-page goes to the one URL: the sites' paths don't line up with
  // Sidon's. hasOwn so '/m/constructor' can't hit Object.prototype.
  return Object.hasOwn(MARINA_SITES, slug) ? MARINA_SITES[slug] : null;
}
```

- [ ] **Step 6: Run the check again**

Run: `cd /c/Users/robert/source/repos/sidon-marina && node scripts/check-cutover.ts; echo "exit=$?"`

Expected: `check-cutover: all passed`, then `exit=0`.

- [ ] **Step 7: Middleware maps every action**

Replace `src/middleware.ts` entirely:

```ts
import { defineMiddleware, sequence } from 'astro:middleware';
import { clerkMiddleware } from '@clerk/astro/server';
import { CORS_HEADERS } from './lib/cors';
import { CUTOVER_PHASE, OTA_DASHBOARD_DEFAULT, cutoverAction } from './lib/cutover';

// Inlined at build time: the runbook sets OTA_DASHBOARD_URL in Vercel before
// the switch build.
const DASH = import.meta.env.OTA_DASHBOARD_URL || OTA_DASHBOARD_DEFAULT;
// CORS on the error bodies so consumer-site browsers (widget 0.4) read the
// 503/410 instead of a CORS failure.
const JSON_CORS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

// Runs before clerkMiddleware so a frozen/retired request costs no Clerk call.
// With output: 'static' only SSR routes reach middleware, which is why the
// public /m/* pages redirect from their own SSR catch-alls instead.
const cutover = defineMiddleware((ctx, next) => {
  const action = cutoverAction(CUTOVER_PHASE, ctx.request.method, ctx.url.pathname, DASH);
  if (!action) return next();
  switch (action.kind) {
    case 'readonly':
      return new Response(JSON.stringify({ error: 'Sidon Marina is read-only while marinas move to a new booking system. Please try again later.' }), {
        status: 503,
        headers: { ...JSON_CORS, 'Retry-After': '86400' },
      });
    case 'gone':
      return new Response(JSON.stringify({ error: 'Sidon Marina has moved to OTA', details: `Berth booking now runs on each marina's own website; staff use ${DASH}/marina` }), {
        status: 410,
        headers: JSON_CORS,
      });
    case 'preflight':
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    case 'redirect':
      return new Response(null, { status: 301, headers: { Location: action.location } });
  }
});

export const onRequest = sequence(cutover, clerkMiddleware());
```

- [ ] **Step 8: Strip the Sidon auth from `NavMarinaSite.astro`**

After Switch, the user-menu "Overview" dialog's `/api/marina/profile` and `/api/marina/images` calls would 410 on the marketing home, so `NavAuth` and the org switcher go.

Lines 1-6, old:
```astro
---
import NavAuth from '../NavAuth.astro';
import NavAuthFallback from '../NavAuthFallback.astro';
import { SignedIn, OrganizationSwitcher } from '@clerk/astro/components';
import { appearance } from '../../lib/clerkAppearance';
---
```
new:
```astro
---
// The marina dashboard moved to OTA at Switch; Sidon's own /marina only redirects.
import { OTA_DASHBOARD_DEFAULT } from '../../lib/cutover';
---
```

Line 23 (desktop), old:
```astro
    <li><a href="/marina" class="no-underline text-sm font-medium text-[#1a2332] hover:text-[#0b1927] transition-colors duration-200">Dashboard</a></li>
```
new:
```astro
    <li><a href={`${import.meta.env.OTA_DASHBOARD_URL || OTA_DASHBOARD_DEFAULT}/marina`} class="no-underline text-sm font-medium text-[#1a2332] hover:text-[#0b1927] transition-colors duration-200">Dashboard</a></li>
```

Lines 27-37, old:
```astro
    <SignedIn>
      <OrganizationSwitcher
        afterSelectOrganizationUrl="/marina"
        afterCreateOrganizationUrl="/marina"
        hidePersonal={true}
        appearance={appearance}
      />
    </SignedIn>
    <NavAuth server:defer>
      <NavAuthFallback slot="fallback" />
    </NavAuth>
    <!-- Hamburger (mobile only) -->
```
new:
```astro
    <!-- Hamburger (mobile only) -->
```

Line 61 (mobile drawer), old:
```astro
      <a href="/marina" class="marina-nav-link px-3 py-3 rounded-lg text-[15px] font-medium text-[#1a2332] hover:text-[#0b1927] hover:bg-[rgba(0,0,0,0.03)] no-underline transition-all duration-150">Dashboard</a>
```
new:
```astro
      <a href={`${import.meta.env.OTA_DASHBOARD_URL || OTA_DASHBOARD_DEFAULT}/marina`} class="marina-nav-link px-3 py-3 rounded-lg text-[15px] font-medium text-[#1a2332] hover:text-[#0b1927] hover:bg-[rgba(0,0,0,0.03)] no-underline transition-all duration-150">Dashboard</a>
```

Check: `rg -n 'href="/marina"|NavAuth|OrganizationSwitcher|SignedIn|appearance' src/components/marina/NavMarinaSite.astro` prints nothing (exit 1).

- [ ] **Step 9: Delete the public pages and the public-site tree**

`--literal-pathspecs` stops git from reading `[lang]` as a glob.

```bash
cd /c/Users/robert/source/repos/sidon-marina && git --literal-pathspecs rm -r -q \
  src/pages/m 'src/pages/[lang]/m' \
  src/components/marina-page src/scripts \
  src/layouts/MarinaPageLayout.astro src/layouts/MarinaBookingLayout.astro \
  src/layouts/MarinaBookingPageLayout.astro src/layouts/PiratesBightLayout.astro \
  src/components/LenisScroll.astro src/lib/book-i18n.ts src/styles/flatpickr-theme.css \
  && git status --short | grep -v '^D ' 
```
Expected: the final `grep` prints only `?? .scratch-cancel-booking.mjs`. Every other line is a staged `D `.

The next two steps re-create the two kept booking routes. Git then records them as modifications.

- [ ] **Step 10: The kept bare booking route — a 302 with no lookups**

Create `src/pages/m/[slug]/booking/[id].astro`:
```astro
---
// Old Sidon emails and QR codes link here. Forward to the locale route's
// "no longer valid" notice with no content or DB lookup, so the route keeps
// working after Sidon's DB is gone.
export const prerender = false;
return Astro.redirect(`/en/m/${Astro.params.slug}/booking/${Astro.params.id}`, 302);
---
```

- [ ] **Step 11: The static notice at the old booking route**

Create `src/pages/[lang]/m/[slug]/booking/[id].astro`:
```astro
---
// Old Sidon booking links land here. The bookings now live in OTA, so this
// page reads nothing and shows nothing about the booking (the old page also
// printed the sailor's email into the HTML).
export const prerender = false;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Booking link no longer valid</title>
  </head>
  <body style="margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0b1927">
    <main style="max-width:520px;margin:15vh auto 0;padding:0 24px;text-align:center">
      <h1 style="font-size:22px;line-height:1.3;margin:0 0 12px">This booking link is no longer valid.</h1>
      <p style="font-size:16px;line-height:1.5;margin:0">Please contact the marina.</p>
    </main>
  </body>
</html>
```

- [ ] **Step 12: The two SSR catch-alls**

Create `src/pages/m/[slug]/[...path].astro`:
```astro
---
// Sidon's public marina pages moved to each marina's own site at Switch.
// SSR because middleware never sees prerendered pages (output: 'static').
import { marinaSiteRedirect } from '../../../lib/cutover';
export const prerender = false;
const to = marinaSiteRedirect(Astro.url.pathname);
if (to) return Astro.redirect(to, 301);
return new Response(null, { status: 404 });
---
```

Create `src/pages/[lang]/m/[slug]/[...path].astro`:
```astro
---
// Sidon's public marina pages moved to each marina's own site at Switch.
// SSR because middleware never sees prerendered pages (output: 'static').
// booking/[id] beside this file outranks the rest route, so old booking
// links still get the notice.
import { marinaSiteRedirect } from '../../../../lib/cutover';
export const prerender = false;
const to = marinaSiteRedirect(Astro.url.pathname);
if (to) return Astro.redirect(to, 301);
return new Response(null, { status: 404 });
---
```

- [ ] **Step 13: No remaining file imports a deleted file**

Run:
```bash
cd /c/Users/robert/source/repos/sidon-marina && rg -n "marina-page/|layouts/(MarinaPageLayout|MarinaBookingLayout|MarinaBookingPageLayout|PiratesBightLayout)|LenisScroll|book-i18n|scripts/(berth-map-google|berths-booking-card|book-[a-z-]+|date-range-picker)|flatpickr-theme|MarinaMessageSticky|MarinaEnquiryDrawer" src; echo "exit=$?"
```
Expected: no matches and `exit=1`. (`marina-page-blocks/` doesn't match `marina-page/`. The `scripts/migrate-berth-*.mjs` comments in `api/marina/berths.ts` and `MarinaMapTab.astro` aren't matched by the narrowed `scripts/` alternation.)

Then:
```bash
cd /c/Users/robert/source/repos/sidon-marina && ls src/pages/m/[slug] src/pages/[lang]/m/[slug] src/pages/m/[slug]/booking src/pages/[lang]/m/[slug]/booking
```
Expected: each `[slug]` directory holds only `[...path].astro` and `booking`, and each `booking` holds only `[id].astro`.

- [ ] **Step 14: Gates — the check and the build**

Run: `cd /c/Users/robert/source/repos/sidon-marina && node scripts/check-cutover.ts && npm run build 2>&1 | tail -5; echo "exit=${PIPESTATUS[0]}"`

Expected:
- `check-cutover: all passed`.
- The build ends with `[build] Complete!`, with no `Could not resolve` or `does not provide an export` error.
- The build no longer needs Sidon's DB at build time, because the prerendered `/m/*` pages that called `getMarinaGeo` are gone. `/` still reads Sanity via `.env`.

- [ ] **Step 15: Dev check of the redirects, the notice and the API**

The `@astrojs/vercel` adapter has no `astro preview`, so use dev. `OTA_DASHBOARD_URL` is not in SM's `.env`, so the default applies. Start it with `run_in_background`:
```bash
cd /c/Users/robert/source/repos/sidon-marina && npx astro dev --port 4355
```
Then run each line as one Bash call (`W='-s -o /dev/null -w %{http_code}|%{redirect_url}\n'` is inlined):
```bash
curl -s -o /dev/null -w '%{http_code}|%{redirect_url}\n' http://localhost:4355/it/m/fox-mooring/berths       # 301|https://sea-company.vercel.app/
curl -s -o /dev/null -w '%{http_code}|%{redirect_url}\n' http://localhost:4355/m/pevero-mooring              # 301|https://sea-company.vercel.app/pevero-mooring
curl -s -o /dev/null -w '%{http_code}|%{redirect_url}\n' http://localhost:4355/en/m/pirates-bight            # 301|https://pirates-bight.vercel.app/
curl -s -o /dev/null -w '%{http_code}|%{redirect_url}\n' http://localhost:4355/m/bora-bora-yacht-club        # 404|
curl -s -o /dev/null -w '%{http_code}|%{redirect_url}\n' http://localhost:4355/m/fox-mooring/booking/1       # 302|http://localhost:4355/en/m/fox-mooring/booking/1
curl -s -w '\n%{http_code}\n' http://localhost:4355/en/m/fox-mooring/booking/1 -o /tmp/sm-notice.html; grep -c 'This booking link is no longer valid.' /tmp/sm-notice.html; grep -c 'name="robots" content="noindex"' /tmp/sm-notice.html   # 200, 1, 1
curl -s -o /dev/null -w '%{http_code}|%{redirect_url}\n' http://localhost:4355/marina                        # 301|https://hotal.forge-build.co.uk/marina
curl -s -X POST -w '\n%{http_code}\n' http://localhost:4355/api/marina/berths                                # {"error":"Sidon Marina has moved to OTA","details":"Berth booking now runs on each marina's own website; staff use https://hotal.forge-build.co.uk/marina"} then 410
curl -s -D - -o /dev/null http://localhost:4355/api/marina/public/list | grep -iE '^HTTP|^access-control-allow-origin'   # HTTP/1.1 410 ..., access-control-allow-origin: *
curl -s -X OPTIONS -o /dev/null -w '%{http_code}\n' http://localhost:4355/api/marina/public/abc/book          # 204
curl -s http://localhost:4355/ | grep -c 'hotal.forge-build.co.uk/marina'                                     # 2 (desktop + mobile Dashboard links)
```
Each result must match its comment. Stop the dev server.

- [ ] **Step 16: Commit on `cutover/switch`**

The `git rm` deletions are already staged. Add the new and modified files by explicit path (never `-A`), then commit:
```bash
cd /c/Users/robert/source/repos/sidon-marina && git --literal-pathspecs add \
  src/lib/cutover.ts scripts/check-cutover.ts src/middleware.ts \
  src/components/marina/NavMarinaSite.astro \
  'src/pages/m/[slug]/booking/[id].astro' 'src/pages/[lang]/m/[slug]/booking/[id].astro' \
  'src/pages/m/[slug]/[...path].astro' 'src/pages/[lang]/m/[slug]/[...path].astro' \
  && git commit -q -m "Cutover switch: retire Sidon's marina API, dashboard and public pages

/api/marina/* answers 410 (OPTIONS 204) with CORS; /marina 301s to the OTA
dashboard (OTA_DASHBOARD_URL, default hotal.forge-build.co.uk). The public
/m/<slug>/* and /<lang>/m/<slug>/* pages are deleted and SSR catch-alls
301 each marina to its own site (MARINA_SITES, runbook inputs). Old booking
links render a static, noindex 'no longer valid' page with no DB read.
NavMarinaSite drops NavAuth and the org switcher, whose dialog would 410.
The hand-rolled booking UI, enquiry drawer, message sticky and the layouts
and scripts only those pages used are deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
  && git status --short && git log --oneline -2 && git branch --show-current
```
Expected:
- `git status --short` prints only `?? .scratch-cancel-booking.mjs`.
- The log shows this commit on top of Task 10's freeze commit.
- The branch is `cutover/switch`.

Do not push, merge or deploy. SM stays on `cutover/switch`, and local `master` is untouched. The runbook's Step 6 replaces the `MARINA_SITES` values with the confirmed origins, sets `OTA_DASHBOARD_URL` in SM's Vercel env, then pushes/merges and redeploys, each with the user's go-ahead. Tagging `ai-replies-shelved` and resetting `master` are runbook steps too.

---

### Task 12: sidon-ai cutover/switch marina removal

Removes every marina feature from sidon-ai (R33): the booking panel, berth overlays, marina inbox, contract and doc-gap prompts. Each of these calls Sidon's marina API, which is retired at Switch. The sailor's document wallet is not touched. The edit points are found by code markers, not by line numbers, because the user's WIP commit (R6) shifts lines.

**Files** (repo SA = `C:/Users/robert/source/repos/sidon-ai`, branch `cutover/switch` cut from local `master`):
- Delete: `src/lib/marina-api.ts`, `src/scripts/sailor-messages.ts`, `src/scripts/berth-circles.ts`, `src/components/app/SailorContract.astro`, `src/components/app/SailorDocGaps.astro`, `tests/marina-overlay-click.spec.ts`, `src/styles/flatpickr-theme-book.css` (nothing imports it).
- Modify `src/scripts/app-map.ts`:
  - remove the `marina-api` import (line 3 today);
  - remove the `__removePricePin?.()` call in the map click handler (~516). Its definition lives in the IIFE being deleted;
  - remove `// ── Marina layout overlays` through EOF (~577–1072).
- Modify `src/components/app/AppSidebar.astro`:
  - remove the `<!-- Marina booking panel` markup (~115–239);
  - replace the `<style is:global>` flatpickr block (~468–509) with a block that keeps only the 3 number-spinner rules;
  - remove the `marina-api` import (~513);
  - remove the `// ── Marina booking panel` block (~2326–2888). The final `</script>` stays.
- Modify `src/pages/app.astro`:
  - remove the SailorContract/SailorDocGaps imports (~6–7);
  - remove the `<!-- Messages dialog -->` block (~118–149);
  - remove the `#messages-btn` button (~269–281);
  - remove the `<SailorDocGaps />`/`<SailorContract />` tags (~352–353);
  - remove 8 `#sailor-thread-messages`/`#sailor-threads` scrollbar selectors (~373–390);
  - remove the `sailor-messages.ts` script tag (~463).
- Modify `src/pages/privacy.astro` (~52, 62, 70, 73, 78, 83, 89), `src/pages/terms.astro` (~52, 58, 68–76, 81, 86–101) and `.env.example` (~15–21).
- Modify `package.json` and `package-lock.json` with `npm uninstall flatpickr @stripe/stripe-js`.
- Untouched:
  - `src/scripts/sailor-documents.ts`
  - `src/pages/api/sailor/documents.ts`, `src/pages/api/sailor/documents/upload.ts`
  - `#docs-dialog`/`#docs-btn`
  - `sailorDocument` in `src/db/schema.ts`
  - `src/lib/extract-document.ts`
  - every `sailor-docs/*` blob
- Scratch (outside the repo, not committed): `C:/tmp/plan-d/sa-cut.mjs`.

**Interfaces:**
- Consumes:
  - R33, the scope.
  - R6, the dirty-tree gate.
  - R4, the branch name `cutover/switch`.
  - Global Constraints: SA branches are cut from local `master`, explicit-path commits, never push.
  - Nothing from OTA, because sidon-ai gets no forwarder and no OTA keys.
- Produces:
  - SA `cutover/switch` with one commit. Task 16 lists it under `## Branches and when they merge` and merges it at `## Step 6 — Switch`, with the user's go-ahead.
  - Two runbook items, both needing the user's go-ahead, with a redeploy after the env change:
    - Removing the Vercel env vars `PUBLIC_MARINA_API_URL`, `MARINA_API_BASE_URL`, `MARINA_API_KEY`, `STRIPE_PRICE_MARINA` and `STRIPE_PRICE_MARINA_PRO` from project `sidon-ai`.
    - The zero-code Switch fallback: unset `PUBLIC_MARINA_API_URL` and redeploy. `MARINA_API_AVAILABLE` then turns every marina call off in the current `master`.

- [ ] **Step 1: Dirty-tree gate (R6)**

```bash
git -C /c/Users/robert/source/repos/sidon-ai status --short
```

Expected: no output. Any output (today it is 9 modified files plus untracked scripts) means **stop and report**. Three of the modified files are ones this task edits: `AppSidebar.astro`, `app.astro` and `app-map.ts`. The user must commit or stash the WIP first. Don't stash on their behalf.

- [ ] **Step 2: Cut the branch from local `master`**

```bash
git -C /c/Users/robert/source/repos/sidon-ai switch -c cutover/switch master
```

Expected: `Switched to a new branch 'cutover/switch'`.

- [ ] **Step 3: Baseline build and Playwright on the untouched branch**

This records what passes before any change, so a later failure can be attributed to the change.

```bash
cd /c/Users/robert/source/repos/sidon-ai && npm run build 2>&1 | tail -3
```

Expected: the output includes `Complete!` and the exit code is 0.

Check that nothing already listens on 4321 (SEA's dev server also uses 4321):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/
```

Expected: `000`.

Start `cd /c/Users/robert/source/repos/sidon-ai && npm run dev` with `run_in_background`. Wait (Monitor until-loop) until `curl -s -o /dev/null -w '%{http_code}' http://localhost:4321/` prints `200`. Then:

```bash
cd /c/Users/robert/source/repos/sidon-ai && npx playwright test tests/sidebar-poi-tab.spec.ts tests/poi-popover-zoom.spec.ts tests/hero-globe.spec.ts --reporter=line 2>&1 | tail -3
```

Expected: `21 passed`.

If the `/app` cases fail because they land on `/sign-in`, the Clerk storageState has expired. Refresh it once while dev is running: `node refresh-auth.mjs > /dev/null && echo refreshed`. Its stdout contains an email and a user id, so it is discarded. Then re-run the tests. Never print or copy `playwright-auth.json`. If anything still fails, write down the failing test titles; Step 9 must fail on exactly that set and no more. Leave dev running.

- [ ] **Step 4: Write the marker-based cut script (outside the repo)**

```bash
mkdir -p /c/tmp/plan-d && cat > /c/tmp/plan-d/sa-cut.mjs <<'EOF'
// Plan D Task 12: cut sidon-ai's marina code by code marker, not line number
// (the user's WIP commits shift lines). Every start marker must match exactly
// once; any miss throws before a single file is written.
import { readFileSync, writeFileSync } from 'node:fs';

const SA = 'C:/Users/robert/source/repos/sidon-ai/';
const out = new Map();

function load(rel) {
  const raw = readFileSync(SA + rel, 'utf8');
  // The checkout is CRLF (core.autocrlf=true); markers below are written with \n.
  return { rel, crlf: raw.includes('\r\n'), src: raw.replace(/\r\n/g, '\n') };
}
// Unique when searched from 0; "first after `from`" otherwise (end markers).
function at(f, marker, from = 0) {
  const i = f.src.indexOf(marker, from);
  if (i < 0) throw new Error(`${f.rel}: marker not found: ${JSON.stringify(marker.slice(0, 70))}`);
  if (from === 0 && f.src.indexOf(marker, i + 1) >= 0) {
    throw new Error(`${f.rel}: marker not unique: ${JSON.stringify(marker.slice(0, 70))}`);
  }
  return i;
}
function swap(f, oldText, newText = '') {
  const i = at(f, oldText);
  f.src = f.src.slice(0, i) + newText + f.src.slice(i + oldText.length);
}
// Delete from a unique start marker up to (not including) the next end marker.
function cutUntil(f, startMarker, endMarker) {
  const s = at(f, startMarker);
  const e = at(f, endMarker, s);
  f.src = f.src.slice(0, s) + f.src.slice(e);
}
function save(f) {
  out.set(f.rel, f.crlf ? f.src.replace(/\n/g, '\r\n') : f.src);
}

// ── src/scripts/app-map.ts
const map = load('src/scripts/app-map.ts');
swap(map, "import { marinaApiUrl, MARINA_API_AVAILABLE } from '../lib/marina-api';\n");
// The price pin is defined inside the marina IIFE; this click handler only cleared it.
swap(map, '    (window as any).__removePricePin?.();\n');
// The marina IIFE runs to the end of the file; keep the newline after the previous `})();`.
map.src = map.src.slice(0, at(map, '\n\n// ── Marina layout overlays') + 1);
save(map);

// ── src/components/app/AppSidebar.astro
const sb = load('src/components/app/AppSidebar.astro');
cutUntil(sb, '  <!-- Marina booking panel', '  <!-- Routes list -->');
{
  const s = at(sb, "<style is:global>\n  @import 'flatpickr/dist/flatpickr.min.css';");
  const e = at(sb, '</style>\n', s) + '</style>\n'.length;
  sb.src = sb.src.slice(0, s) + [
    '<style is:global>',
    "  /* Hide native number spinners. Global on purpose: WatchSchedule's",
    '     #custom-hours on /app relies on it, not only the old berth form. */',
    '  input[type=number]::-webkit-inner-spin-button,',
    '  input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }',
    '  input[type=number] { -moz-appearance: textfield; }',
    '</style>',
    '',
  ].join('\n') + sb.src.slice(e);
}
swap(sb, "  import { marinaApiUrl, MARINA_API_AVAILABLE } from '../../lib/marina-api';\n");
{
  const s = at(sb, '\n\n  // ── Marina booking panel');
  const e = at(sb, '\n</script>', s);
  if (sb.src.slice(e).trim() !== '</script>') {
    throw new Error('AppSidebar: the marina block is not the last thing in the script');
  }
  sb.src = sb.src.slice(0, s) + sb.src.slice(e);
}
save(sb);

// ── src/pages/app.astro
const app = load('src/pages/app.astro');
swap(app, "import SailorContract from '../components/app/SailorContract.astro';\n");
swap(app, "import SailorDocGaps from '../components/app/SailorDocGaps.astro';\n");
cutUntil(app, '      <!-- Messages dialog -->', "      <!-- Documents dialog (sailor's wallet) -->");
cutUntil(app, '        <button\n          id="messages-btn"', '        <button\n          id="docs-btn"');
swap(app, '\n\n    <SailorDocGaps />\n    <SailorContract />\n', '\n');
{
  const sel = /^  :global\(#sailor-thread(?:s|-messages)\)::-webkit-scrollbar[^\n]*,\n/gm;
  const hits = app.src.match(sel)?.length ?? 0;
  if (hits !== 8) throw new Error(`app.astro: expected 8 sailor scrollbar selectors, found ${hits}`);
  app.src = app.src.replace(sel, '');
}
swap(app, '<script src="../scripts/sailor-messages.ts"></script>\n');
save(app);

for (const [rel, text] of out) writeFileSync(SA + rel, text);
console.log('cut:', [...out.keys()].join(', '));
EOF
```

- [ ] **Step 5: Run the cut and delete the six marina files**

```bash
node /c/tmp/plan-d/sa-cut.mjs
```

Expected: `cut: src/scripts/app-map.ts, src/components/app/AppSidebar.astro, src/pages/app.astro`. If it throws `marker not found`/`not unique`, stop. No file has been written in that case. Report the marker; don't fall back to line numbers.

```bash
git -C /c/Users/robert/source/repos/sidon-ai rm src/lib/marina-api.ts src/scripts/sailor-messages.ts src/scripts/berth-circles.ts src/components/app/SailorContract.astro src/components/app/SailorDocGaps.astro tests/marina-overlay-click.spec.ts
```

Expected: six `rm '<path>'` lines.

```bash
git -C /c/Users/robert/source/repos/sidon-ai diff -U0 -- src | grep '^+[^+]'
```

Expected: only lines from the kept number-spinner block in `AppSidebar.astro`. Everything else in the diff is a deletion.

- [ ] **Step 6: Edit the privacy and terms copy and `.env.example`**

These are exact replacements with the Edit tool. Stripe stays in the copy because subscriptions still use it (`src/pages/api/subscribe/*`).

`src/pages/privacy.astro`:

```
old:   <p class="updated">Last updated: 2 April 2026</p>
new:   <p class="updated">Last updated: 12 October 2026</p>
```
```
old:     <li><strong style="color:#e8f1f8;">Profile data</strong> — boat name, length overall (LOA), beam, and fleet preferences you save in the app.</li>
    <li><strong style="color:#e8f1f8;">Booking data</strong> — berth selections, arrival and departure dates, and payment information processed via Stripe.</li>
new:     <li><strong style="color:#e8f1f8;">Profile data</strong> — boat name, length overall (LOA), beam, and fleet preferences you save in the app.</li>
```
```
old:     <li>To provide and maintain the Sidon platform and its features.</li>
    <li>To process berth booking requests and communicate with marina operators on your behalf.</li>
new:     <li>To provide and maintain the Sidon platform and its features.</li>
```
```
old:     <li>To send transactional emails related to your bookings and account.</li>
new:     <li>To send transactional emails related to your account and subscription.</li>
```
```
old: We do not store card numbers, expiry dates, or CVCs on our servers. When a berth is booked, Stripe places a payment hold (manual capture) that is only charged upon marina confirmation.</p>
new: We do not store card numbers, expiry dates, or CVCs on our servers.</p>
```
```
old:     <li><strong style="color:#e8f1f8;">Marina operators</strong> — booking details (name, email, boat dimensions, dates) are shared with the marina you book with.</li>
    <li><strong style="color:#e8f1f8;">Service providers</strong>
new:     <li><strong style="color:#e8f1f8;">Service providers</strong>
```
```
old:   <p>Account and booking data is retained
new:   <p>Account and billing data is retained
```

`src/pages/terms.astro`:

```
old:   <p class="updated">Last updated: 2 April 2026</p>
new:   <p class="updated">Last updated: 12 October 2026</p>
```
```
old: marina discovery, fleet tracking, and berth booking tools.
new: marina discovery and fleet tracking tools.
```
```
old:   <h2>4. Berth bookings</h2>
  <p>When you request a berth through Sidon, you are making a booking request to an independent marina operator. Sidon is not a party to that contract and is not responsible for the marina's acceptance, rejection, or cancellation of a booking.</p>
  <ul>
    <li>Payment holds are placed via Stripe and are only captured upon marina confirmation.</li>
    <li>Cancellation and refund terms are set by the individual marina operator.</li>
    <li>Sidon is not liable for any loss arising from a marina's failure to honour a booking.</li>
  </ul>

  <h2>5. Acceptable use</h2>
new:   <h2>4. Acceptable use</h2>
```
```
old:     <li>Submit false booking requests or fraudulent payment details.</li>
new:     <li>Submit fraudulent payment details.</li>
```
```
old:   <h2>6. Subscriptions and billing</h2>      new:   <h2>5. Subscriptions and billing</h2>
old:   <h2>7. Availability and accuracy</h2>      new:   <h2>6. Availability and accuracy</h2>
old:   <h2>8. Intellectual property</h2>          new:   <h2>7. Intellectual property</h2>
old:   <h2>9. Limitation of liability</h2>        new:   <h2>8. Limitation of liability</h2>
old:   <h2>10. Governing law</h2>                 new:   <h2>9. Governing law</h2>
old:   <h2>11. Changes to these terms</h2>        new:   <h2>10. Changes to these terms</h2>
```
```
old: Marina availability, pricing, and depth data displayed on Sidon
new: Marina information and depth data displayed on Sidon
```

`.env.example`: remove the Ably comment, which describes token minting via the marina origin, and the marina URL block:

```
old: # Ably (realtime messaging) — client-side only; token minting moved to
# the marina repo. Voyage requests tokens from marina's endpoint via
# PUBLIC_MARINA_API_URL below.

# Marina's public API base URL (empty until the marina repo is deployed —
# marina-integrated features degrade gracefully when unset)
PUBLIC_MARINA_API_URL=

# OpenCage
new: # OpenCage
```

Checks:

```bash
cd /c/Users/robert/source/repos/sidon-ai && grep -c -i "berth\|booking" src/pages/privacy.astro src/pages/terms.astro && grep -o '<h2>[0-9]*\.' src/pages/terms.astro | tr -d '\n'; echo
```

Expected: `src/pages/privacy.astro:0`, `src/pages/terms.astro:0`, then `<h2>1.<h2>2.<h2>3.<h2>4.<h2>5.<h2>6.<h2>7.<h2>8.<h2>9.<h2>10.`.

- [ ] **Step 7: Leftover and wallet checks**

```bash
cd /c/Users/robert/source/repos/sidon-ai && rg -n "marina-api|marinaApiUrl|/api/marina|sidonContract|sidonDocGaps|marina-panel|marina-selected|sailor-messages" src
cd /c/Users/robert/source/repos/sidon-ai && rg -n "MARINA_API|PUBLIC_MARINA_API_URL|__showPricePin|__removePricePin|__loadMarinaLayout|__dismissMarinaOverlay|berth-circles|SailorContract|SailorDocGaps|messages-btn|sailor-thread" src tests .env.example
```

Expected: both print nothing.

```bash
git -C /c/Users/robert/source/repos/sidon-ai diff --name-only master -- src/scripts/sailor-documents.ts src/pages/api/sailor src/db/schema.ts src/lib/extract-document.ts
cd /c/Users/robert/source/repos/sidon-ai && grep -c 'id="docs-dialog"\|id="docs-btn"\|scripts/sailor-documents.ts' src/pages/app.astro
```

Expected: the first prints nothing (wallet untouched); the second prints `3`.

- [ ] **Step 8: Remove the dependencies that lost their last importer**

Search tracked files only, excluding docs and the manifests:

```bash
git -C /c/Users/robert/source/repos/sidon-ai grep -l -E "flatpickr|@stripe/stripe-js|from 'ably'|\"ably\"" -- . ':!docs' ':!package.json' ':!package-lock.json'
git -C /c/Users/robert/source/repos/sidon-ai grep -n "flatpickr-theme-book" -- . ':!docs'
```

Expected:
- The first prints `scripts/test-ably-publish.mjs` and `src/styles/flatpickr-theme-book.css`.
- The second prints nothing, so the stylesheet is orphaned.
- `ably` therefore **stays**, because the dev helper `scripts/test-ably-publish.mjs` still imports it. `flatpickr` and `@stripe/stripe-js` have no importers left.
- If the first command prints any other path for `flatpickr` or `@stripe/stripe-js`, keep that dependency too and say so in the commit message.

```bash
git -C /c/Users/robert/source/repos/sidon-ai rm src/styles/flatpickr-theme-book.css
cd /c/Users/robert/source/repos/sidon-ai && npm uninstall flatpickr @stripe/stripe-js 2>&1 | tail -2
cd /c/Users/robert/source/repos/sidon-ai && node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies};console.log(['flatpickr','@stripe/stripe-js','ably'].map(n=>n+':'+(n in d)).join(' '))"
```

Expected:
- `rm 'src/styles/flatpickr-theme-book.css'`.
- npm's output includes `removed 2 packages`.
- The node check prints `flatpickr:false @stripe/stripe-js:false ably:true`.

- [ ] **Step 9: Build and Playwright after the change**

```bash
cd /c/Users/robert/source/repos/sidon-ai && npm run build 2>&1 | tail -3
```

Expected: the output includes `Complete!`, exit 0, and no `Could not resolve` or `Failed to resolve import` lines.

Dev is still running from Step 3. Vite picks up the edits, but the dependency removal needs a fresh start. Stop the background task, start `npm run dev` with `run_in_background` again, and wait for `200` on `http://localhost:4321/`. Then:

```bash
cd /c/Users/robert/source/repos/sidon-ai && npx playwright test tests/sidebar-poi-tab.spec.ts tests/poi-popover-zoom.spec.ts tests/hero-globe.spec.ts --reporter=line 2>&1 | tail -3
```

Expected: `21 passed`, or exactly the Step 3 baseline failures and no new ones.

Stop the background dev server (TaskStop on its task id), then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/
```

Expected: `000`.

- [ ] **Step 10: Commit on `cutover/switch`**

```bash
git -C /c/Users/robert/source/repos/sidon-ai add src/scripts/app-map.ts src/components/app/AppSidebar.astro src/pages/app.astro src/pages/privacy.astro src/pages/terms.astro .env.example package.json package-lock.json
git -C /c/Users/robert/source/repos/sidon-ai status --short
```

Expected: exactly these lines, with nothing untracked and nothing unstaged:
- `D` for the 6 deleted marina files and `src/styles/flatpickr-theme-book.css`
- `M` for the 8 added paths

```bash
git -C /c/Users/robert/source/repos/sidon-ai commit -m "Remove the marina features from the app ahead of the OTA cutover

The berth booking panel, the marina map overlays, the marina inbox and the
contract and doc-gap prompts all called Sidon's marina API, which is retired
when marina booking moves to each marina's own site. The sailor's document
wallet stays. Drops flatpickr and @stripe/stripe-js, which no longer have an
importer (ably stays for scripts/test-ably-publish.mjs), PUBLIC_MARINA_API_URL
from .env.example, and the berth-booking and payment-hold copy from the privacy
policy and terms.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/sidon-ai log --oneline -1 && git -C /c/Users/robert/source/repos/sidon-ai branch --show-current && git -C /c/Users/robert/source/repos/sidon-ai status --short
```

Expected: one new commit, the branch `cutover/switch`, and a clean status. Nothing is pushed. The repo is left on `cutover/switch`. Merging it and removing the five Vercel env vars are Task 16 runbook steps (Step 6, user's go-ahead, redeploy after the env change).

---

### Task 13: OTA cutover/switch (list_marina_bookings, sidon-bookings removal)

Repo: `O` = `C:/Users/robert/source/repos/OTA`, branch `cutover/switch` cut from `main`. All commands are Git Bash and run from `O`. Local DB only.

**Files:**
- Modify: `/c/Users/robert/source/repos/OTA/scripts/check-marina.js` (line 232, inside the `MCP marina tools call the marina routes` check)
- Modify: `/c/Users/robert/source/repos/OTA/mcp-server/tools.js` (lines 754-759, the `list_marina_bookings` object)
- Modify: `/c/Users/robert/source/repos/OTA/src/routes/marina.js` (lines 21-24: delete line 24 and reword the line 21 comment)
- Modify: `/c/Users/robert/source/repos/OTA/src/controllers/marina.js` (lines 3-8 header comment and `SIDON_API_ORIGIN`, lines 34-82 `listMarinaBookings`, line 84 export)
- Modify: `/c/Users/robert/source/repos/OTA/src/docs/swagger.js` (lines 637-639, the `'/api/marina/sidon-bookings'` entry)
- Unchanged: `src/controllers/marinaBookings.js` `listBookings` (route `GET /api/marina/bookings`, `src/routes/marina.js:55`) already serves `from`/`to`/`status`/`berth_id`/`marina_id`/`limit`/`offset` and returns `{ total, data }`. `mcp-server/apiClient.js` `apiRequest(method, path, { query, body })` already drops `undefined`/`null` query values. `setSidonMarinaKey`/`clearSidonMarinaKey` and the `/key` routes stay until Task 14.

**Interfaces:**
- Consumes: the R19 switch half. Gate: the commits from Tasks 1-5 are on O `main` (`scripts/import-sidon-marina.js`, `scripts/check-import-sidon.js`, and `MARINA_DEMO_SLUG` in `scripts/seed-marina-demo.js`). Also consumes the existing `GET /api/marina/bookings` (`bookings.listBookings`) and `createTools(apiRequest)` from `mcp-server/tools.js`.
- Produces: the contract's exact `list_marina_bookings` tool (`run: (query) => apiRequest('GET', '/api/marina/bookings', { query })`). `GET /api/marina/sidon-bookings` is gone (it now falls through to a 404), and so are `listMarinaBookings`, `SIDON_API_ORIGIN` and the Swagger entry. Branch `cutover/switch` is the base Task 14 cuts `cutover/cleanup` from.

- [ ] **Step 1: Gate, then branch**

```bash
cd /c/Users/robert/source/repos/OTA
git status --short
test -f scripts/import-sidon-marina.js && test -f scripts/check-import-sidon.js && grep -q MARINA_DEMO_SLUG scripts/seed-marina-demo.js && echo "tasks 1-5 present"
git switch -c cutover/switch main
```
Expected: `git status --short` prints only `?? =` and `?? src/db/seed-extras.sql.pre-multi-property.bak`. If any tracked file shows up as modified, stop and report. The `test` line prints `tasks 1-5 present`, and `git switch` prints `Switched to a new branch 'cutover/switch'`. If the gate line prints nothing, stop: Tasks 1-5 are not on `main`.

- [ ] **Step 2: Flip the check-marina.js assertion (failing first)**

In `scripts/check-marina.js`, replace line 232:
```js
      assert.equal(t('list_marina_bookings').run.toString().includes('sidon-bookings'), true, 'stays on the interim proxy until Switch');
```
with:
```js
      // Switch: the staff list is OTA's own paged route; the args pass straight through as the query.
      calls.length = 0;
      const args = { from: '2027-06-01', status: 'pending', limit: 50 };
      await t('list_marina_bookings').run(args);
      assert.deepEqual(calls, [['GET', '/api/marina/bookings', { query: { from: '2027-06-01', status: 'pending', limit: 50 } }]]);
      assert.equal(t('list_marina_bookings').run.toString().includes('sidon-bookings'), false, 'no interim proxy after Switch');
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node -r dotenv/config scripts/check-marina.js; echo "exit=$?"`

Expected: FAIL with `exit=1`. Only one check fails:
```
FAIL MCP marina tools call the marina routes
     AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
...
-     '/api/marina/sidon-bookings',
-     undefined
+     '/api/marina/bookings',
+     {
+       query: {
...
1 FAILED
exit=1
```
Every other line reads `ok   …`.

- [ ] **Step 4: Rewrite `list_marina_bookings` in `mcp-server/tools.js`**

Old (lines 754-759):
```js
  {
    name: 'list_marina_bookings',
    description: "Berth bookings at the property's linked Sidon marina (read live from Sidon): berth, sailor, boat, arrival/departure dates, nights, status (pending/confirmed/cancelled...), amount. Every booking Sidon holds, newest first -- filter by date yourself. A pending booking past expires_at is a lapsed hold. Fails if no marina is linked or its API key isn't set.",
    inputSchema: {},
    run: () => apiRequest('GET', '/api/marina/sidon-bookings'),
  },
```
New:
```js
  {
    name: 'list_marina_bookings',
    description: 'Berth bookings across this property\'s marinas, paged ({ total, data }), ordered by arrival then berth. from = bookings departing after this date (open-ended always included), to = arriving before it. Guest checkouts in progress (holds) are never listed.',
    inputSchema: {
      from: z.string().optional().describe('YYYY-MM-DD'), to: z.string().optional().describe('YYYY-MM-DD'),
      status: z.enum(['pending', 'confirmed', 'declined', 'cancelled']).optional(),
      marina_id: z.string().optional(), berth_id: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(),
    },
    run: (query) => apiRequest('GET', '/api/marina/bookings', { query }),
  },
```

- [ ] **Step 5: Delete the route in `src/routes/marina.js`**

Old (lines 21-24):
```js
// Interim Sidon link, removed at cleanup / Switch.
router.put('/key', authenticate, requireRole('admin'), ctrl.setSidonMarinaKey);
router.post('/key/clear', authenticate, requireRole('admin'), ctrl.clearSidonMarinaKey);
router.get('/sidon-bookings', authenticateOrApiKey, ctrl.listMarinaBookings);
```
New:
```js
// Interim Sidon link, removed at cleanup.
router.put('/key', authenticate, requireRole('admin'), ctrl.setSidonMarinaKey);
router.post('/key/clear', authenticate, requireRole('admin'), ctrl.clearSidonMarinaKey);
```
`authenticateOrApiKey` is still used by the routes from line 26 on, so the import on line 17 stays.

- [ ] **Step 6: Delete the proxy from `src/controllers/marina.js`**

Old (lines 1-8):
```js
const pool = require('../db');

// Step 2 of unifying OTA and sidon-marina: berth bookings still live in
// Sidon's database, so OTA reads them through Sidon's keyed bookings
// endpoint, server-side -- the key must never reach a browser (Sidon's CORS
// accepts X-Marina-Key from any origin). Goes away once the marina tables
// move into OTA.
const SIDON_API_ORIGIN = process.env.SIDON_API_ORIGIN || 'https://marina.sidonmarine.uk';
```
New:
```js
const pool = require('../db');

// The stored Sidon key outlives Switch only so a rollback can re-enable the
// old proxy; the whole file goes at cleanup.
```
Then delete lines 34-82 entirely: from `// Sidon errors come back as 502, never 401/403 -- the dashboard's apiFetch` through the closing `}` of `listMarinaBookings`, together with the blank line that follows. Change the export (line 84) from:
```js
module.exports = { setSidonMarinaKey, clearSidonMarinaKey, listMarinaBookings };
```
to:
```js
module.exports = { setSidonMarinaKey, clearSidonMarinaKey };
```
Result: the file is `pool`, the 2-line comment, `setSidonMarinaKey`, `clearSidonMarinaKey` and the export.

- [ ] **Step 7: Delete the Swagger entry in `src/docs/swagger.js`**

Delete lines 637-639 exactly. The `'/api/marina/key'` entry that follows stays:
```js
    '/api/marina/sidon-bookings': {
      get: { tags: ['Marina'], summary: "Berth bookings for the property's linked Sidon marina", description: 'Read from Sidon with the stored marina API key, server-side. Every booking Sidon holds (no date filter), newest first. 409 if no marina or key is set; Sidon failures (including a rejected key) come back as 502.', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: '[{ id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, nights, notes, status, amount_cents, expires_at, created_at }]' }, 409: { description: 'No Sidon marina linked, or no API key set' }, 502: { description: 'Sidon unreachable, rejected the key, or returned an error' } } },
    },
```

- [ ] **Step 8: Run the check again, then the leftovers scan**

```bash
node -r dotenv/config scripts/check-marina.js; echo "exit=$?"
rg -n "sidon-bookings|SIDON_API_ORIGIN|listMarinaBookings" src mcp-server scripts; echo "rg=$?"
node -e "require('./src/app'); require('./src/docs/swagger'); console.log('loads')"
```
Expected:
- `check-marina.js` prints `ok   MCP marina tools call the marina routes`, ends with `all passed`, then `exit=0`.
- `rg` prints nothing, then `rg=1` (no matches).
- The `node -e` line prints `loads` (the route file no longer references a missing handler).

- [ ] **Step 9: Run the other O gates**

```bash
node -r dotenv/config scripts/check-marina-http.js; echo "exit=$?"
node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"
```
Expected: each ends with `all passed` and `exit=0`.

- [ ] **Step 10: Commit on `cutover/switch`**

```bash
git -C /c/Users/robert/source/repos/OTA add scripts/check-marina.js mcp-server/tools.js src/routes/marina.js src/controllers/marina.js src/docs/swagger.js
git -C /c/Users/robert/source/repos/OTA commit -m "Marina Switch: list_marina_bookings reads OTA, interim Sidon proxy removed

list_marina_bookings now calls GET /api/marina/bookings with its filters
(paged { total, data }). GET /api/marina/sidon-bookings, listMarinaBookings,
SIDON_API_ORIGIN and the Swagger entry are deleted. The /key routes stay
until cutover/cleanup.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/Users/robert/source/repos/OTA status --short
git -C /c/Users/robert/source/repos/OTA branch --show-current
```
Expected: one commit, 5 files changed. `status --short` shows only the two untracked files from Step 1, and `branch --show-current` prints `cutover/switch`. Leave O on `cutover/switch`. Do not push or merge. The runbook's Step 6 (Switch) pushes and merges this branch with the user's go-ahead, and Task 14 cuts `cutover/cleanup` from it.

---

### Task 14: OTA cutover/cleanup + column-drop migration

Repo O, branch `cutover/cleanup`, cut from O `cutover/switch` (contract Global Constraints). Two commits: the R19 code cleanup, then the G10 migration and importer removal. The runbook (Task 16, Step 7) merges this branch two weeks after Switch. The user applies the migration on live only after the cleanup deploy is live. Nothing here pushes, merges, deploys or migrates live.

**Files (O, branch `cutover/cleanup`):**

Commit 1:
- Delete: `src/controllers/marina.js`. After Task 13 it holds only `setSidonMarinaKey`/`clearSidonMarinaKey`.
- Modify: `src/routes/marina.js`
  - l.3: the `ctrl` require.
  - l.17: drop `requireRole`, which nothing else in the file uses.
  - l.21-23: the "Interim Sidon link" comment and the `/key` and `/key/clear` routes. Task 13 already removed l.24.
- Modify: `src/docs/swagger.js`
  - l.181-182: the `sidon_marina_id`/`sidon_marina_key_set` properties.
  - The `'/api/marina/key'` and `'/api/marina/key/clear'` entries: l.640-645 on `main`, about l.637-642 after Task 13 removes the `sidon-bookings` entry above them.
- Modify: `src/controllers/property.js` l.56, 70, 89-93, 100-121 (`getCurrentProperty`, `updateCurrentProperty`).
- Modify: `mcp-server/tools.js` l.715 (`get_property` description) and l.729 (`update_property` `sidon_marina_id`).
- Modify: `scripts/check-marina-http.js`: insert above `    // (later tasks append here)` (l.472 on `main`).

Commit 2:
- Create: `src/db/migrate-2026-10-12-drop-sidon-columns.sql`
- Modify: `src/db/schema.sql`
  - l.74-78: the property Sidon comment block and its two columns.
  - l.1205-1207: the marina header comment, which names the import as the only hard delete.
  - l.1231: `sidon_owner_id`.
  - l.1325: `legacy_payment_intent_id`.
- Modify: `scripts/check-marina.js`: delete the one line containing `includes('sidon-bookings')`. That is Task 13's flipped assertion. The `deepEqual` on the `GET /api/marina/bookings` call next to it still pins the route, and the literal would fail the acceptance `rg`.
- Delete: `scripts/import-sidon-marina.js`, `scripts/check-import-sidon.js` (G10).

**Interfaces:**
- Consumes:
  - O `cutover/switch` from Task 13: `list_marina_bookings` on `GET /api/marina/bookings`; the `/sidon-bookings` route, `listMarinaBookings` and `SIDON_API_ORIGIN` already gone; the `check-marina.js` assertion flipped.
  - The check harness in `scripts/check-marina-http.js`: `api(method, path, { body, headers })` on the throwaway property's `X-Api-Key`, and `check(name, fn)`.
  - The gates `check-marina.js`, `check-marina-http.js` and `check-import-sidon.js` (the last one only up to commit 1).
- Produces:
  - `GET /api/property/me` returns `{ id, clerk_org_id, name, slug, currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions, enabled_modules }` with no Sidon keys. Task 15's `loadProperty()` type matches it.
  - `PUT /api/property/me` ignores a body `sidon_marina_id` (200).
  - `PUT /api/marina/key` and `POST /api/marina/key/clear` → 404.
  - MCP `update_property.inputSchema` keys are `currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id`.
  - `src/db/migrate-2026-10-12-drop-sidon-columns.sql`, which Task 16's runbook applies in Step 7 after the cleanup deploy.
  - O is left on `cutover/cleanup`.

- [ ] **Step 1: Gate on Task 13 and cut the branch**

Run (Git Bash):
```bash
git -C /c/Users/robert/source/repos/OTA log --oneline -1 cutover/switch
git -C /c/Users/robert/source/repos/OTA grep -n -e sidon-bookings -e SIDON_API_ORIGIN -e listMarinaBookings cutover/switch -- src mcp-server; echo "grep_exit=$?"
git -C /c/Users/robert/source/repos/OTA status --short
```
Expected:
- The first command prints Task 13's `cutover/switch` commit.
- The second prints no matches and `grep_exit=1`.
- The status shows only the pre-existing untracked `?? =` and `?? src/db/seed-extras.sql.pre-multi-property.bak`.

If the branch is missing, or the grep finds a match, stop and report: Task 13 is not done.

```bash
git -C /c/Users/robert/source/repos/OTA switch -c cutover/cleanup cutover/switch
```
Expected: `Switched to a new branch 'cutover/cleanup'`.

- [ ] **Step 2: Write the failing HTTP checks**

In `O/scripts/check-marina-http.js`, insert this block directly above the line `    // (later tasks append here)`. Keep the marker after it.

```js
    // ---- Plan D Task 14: cleanup (the interim Sidon link is gone) ----
    // Field names are spelled in parts and matched on /^sidon/ so this file
    // passes the cleanup rg, which must find no Sidon column names in scripts/.
    const legacyField = ['sidon', 'marina', 'id'].join('_');
    const sidonKeys = (o) => Object.keys(o).filter((k) => /^sidon/.test(k));
    await check('cleanup: GET /api/property/me has no Sidon link fields', async () => {
      const r = await api('GET', '/api/property/me');
      assert.equal(r.status, 200);
      assert.deepEqual(sidonKeys(r.body), []);
    });
    await check('cleanup: PUT /api/property/me ignores a Sidon marina id', async () => {
      const r = await api('PUT', '/api/property/me', { body: { [legacyField]: 'org_x' } });
      assert.equal(r.status, 200);
      assert.deepEqual(sidonKeys((await api('GET', '/api/property/me')).body), []);
    });
    await check('cleanup: PUT /api/marina/key is gone', async () => {
      assert.equal((await api('PUT', '/api/marina/key', { body: { key: 'mk_checkcheck' } })).status, 404);
    });
    await check('cleanup: MCP property tools no longer mention Sidon', async () => {
      const tools = require('../mcp-server/tools').createTools(async () => ({}));
      const t = (name) => { const x = tools.find((y) => y.name === name); assert.ok(x, `missing tool ${name}`); return x; };
      assert.deepEqual(sidonKeys(t('update_property').inputSchema), []);
      assert.doesNotMatch(t('get_property').description, /sidon/i);
    });
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js; echo "exit=$?"`

Expected: every earlier check prints `ok`, then four failures, `4 FAILED` and `exit=1`:
- `FAIL cleanup: GET /api/property/me has no Sidon link fields`: a deep-equal diff whose actual is `[ 'sidon_marina_id', 'sidon_marina_key_set' ]`.
- `FAIL cleanup: PUT /api/property/me ignores a Sidon marina id`: the same two-key diff on the GET after the PUT.
- `FAIL cleanup: PUT /api/marina/key is gone`: `401 !== 404`, because `authenticate` refuses the X-Api-Key-only request.
- `FAIL cleanup: MCP property tools no longer mention Sidon`: actual `[ 'sidon_marina_id' ]`.

- [ ] **Step 4: Delete the key controller and its routes**

```bash
git -C /c/Users/robert/source/repos/OTA rm src/controllers/marina.js
```

In `O/src/routes/marina.js`, delete line 3:
```js
const ctrl = require('../controllers/marina');
```
Change line 17. Old:
```js
const { authenticate, authenticateOrApiKey, requireRole } = require('../middleware/auth');
```
New:
```js
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');
```
Delete this block, including its trailing blank line, so that `// Literal segments before '/:id' throughout (see eventInquiries.js).` is followed by one blank line and then `router.get('/marinas', ...)`:
```js
// Interim Sidon link, removed at cleanup / Switch.
router.put('/key', authenticate, requireRole('admin'), ctrl.setSidonMarinaKey);
router.post('/key/clear', authenticate, requireRole('admin'), ctrl.clearSidonMarinaKey);

```

- [ ] **Step 5: Swagger**

In `O/src/docs/swagger.js`, delete these six lines entirely (the `'/api/marina/marinas'` entry follows them):
```js
    '/api/marina/key': {
      put: { tags: ['Marina'], summary: "Set the linked Sidon marina's API key (admin only)", description: 'The mk_... key from the Sidon dashboard. Never returned -- GET /api/property/me reports sidon_marina_key_set instead.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['sidon_marina_key'], properties: { sidon_marina_key: { type: 'string' } } } } } }, responses: { 200: { description: '{ sidon_marina_key_set: true }' }, 400: { description: 'Missing, or not an mk_… key' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/marina/key/clear': {
      post: { tags: ['Marina'], summary: "Clear the linked Sidon marina's API key (admin only)", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ sidon_marina_key_set: false }' }, 403: { description: 'Insufficient permissions' } } },
    },
```
Line 181 (`/api/property/me` GET). Old substring:
```js
return_instructions: { type: 'string', nullable: true, description: 'Sent to guests requesting a shop return; also fed to AI replies' }, sidon_marina_id: { type: 'string', nullable: true, description: 'Linked Sidon marina owner id (org_...)' }, sidon_marina_key_set: { type: 'boolean', description: 'Whether the marina API key is stored (the key itself is never returned)' } } } } } } } },
```
New:
```js
return_instructions: { type: 'string', nullable: true, description: 'Sent to guests requesting a shop return; also fed to AI replies' } } } } } } } },
```
Line 182 (`/api/property/me` PUT). Old substring:
```js
return_instructions: { type: 'string', nullable: true, description: 'null clears it; omit to leave unchanged' }, sidon_marina_id: { type: 'string', nullable: true, description: 'Sidon marina owner id (org_...); null clears it. Changing or clearing it also drops the stored marina API key' }, slug:
```
New:
```js
return_instructions: { type: 'string', nullable: true, description: 'null clears it; omit to leave unchanged' }, slug:
```

- [ ] **Step 6: `getCurrentProperty` / `updateCurrentProperty` stop reading and writing the Sidon columns**

In `O/src/controllers/property.js`, replace `getCurrentProperty` and `updateCurrentProperty` (l.53-127, from `async function getCurrentProperty` through the closing `}` of `updateCurrentProperty`) with:

```js
async function getCurrentProperty(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, clerk_org_id, name, slug, currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions, enabled_modules FROM property WHERE id = $1',
      [req.property_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// tax_* fields are optional and off by default -- see
// migrate-2026-09-06-order-tax.sql. Only proshop_order/restaurant_web_order
// (website checkout) apply them today.
async function updateCurrentProperty(req, res, next) {
  try {
    const { currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions, enabled_modules, slug } = req.body;
    if (currency !== undefined && !isValidCurrencyCode(currency)) {
      return res.status(400).json({ error: 'currency must be a 3-letter ISO 4217 code (e.g. GBP)' });
    }
    if (timezone !== undefined && !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'timezone must be a valid IANA timezone name (e.g. Europe/London)' });
    }
    if (tax_rate !== undefined && (typeof tax_rate !== 'number' || !Number.isFinite(tax_rate) || tax_rate < 0 || tax_rate > 100)) {
      return res.status(400).json({ error: 'tax_rate must be a number between 0 and 100' });
    }
    if (return_instructions !== undefined && return_instructions !== null
        && (typeof return_instructions !== 'string' || return_instructions.length > 4000)) {
      return res.status(400).json({ error: 'return_instructions must be a string of at most 4000 characters' });
    }
    // null clears it back to "every module enabled" (the default); anything
    // else must be an array drawn from MODULE_KEYS.
    if (enabled_modules !== undefined && enabled_modules !== null && !isValidEnabledModules(enabled_modules)) {
      return res.status(400).json({ error: `enabled_modules must be an array drawn from: ${MODULE_KEYS.join(', ')}, or null` });
    }
    // Path segment a group website routes on; null clears it.
    if (slug !== undefined && slug !== null && !isValidSlug(slug)) {
      return res.status(400).json({ error: 'slug must be 1-60 lowercase letters, digits or hyphens, or null' });
    }
    const { rows } = await pool.query(
      `UPDATE property SET
         currency            = COALESCE($1, currency),
         timezone            = COALESCE($2, timezone),
         tax_enabled         = COALESCE($3, tax_enabled),
         tax_rate            = COALESCE($4, tax_rate),
         tax_inclusive       = COALESCE($5, tax_inclusive),
         tax_id              = COALESCE($6, tax_id),
         return_instructions = CASE WHEN $8::boolean  THEN $7::text  ELSE return_instructions END,
         enabled_modules     = CASE WHEN $10::boolean THEN $9::jsonb ELSE enabled_modules     END,
         slug                = CASE WHEN $13::boolean THEN $12::text ELSE slug END
       WHERE id = $11
       RETURNING id, name, slug, currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions, enabled_modules`,
      [currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id,
        return_instructions ?? null, return_instructions !== undefined,
        enabled_modules != null ? JSON.stringify(enabled_modules) : null, enabled_modules !== undefined,
        req.property_id,
        slug ?? null, slug !== undefined]
    );
    res.json(rows[0]);
  } catch (err) {
    if (isSlugConflict(err)) return res.status(409).json({ error: SLUG_TAKEN });
    next(err);
  }
}
```
A body `sidon_marina_id` is no longer destructured, so it is ignored like any other unknown field.

- [ ] **Step 7: MCP tools**

In `O/mcp-server/tools.js` (`get_property`, l.715). Old:
```js
    description: 'The property (venue/org) this API key operates for: id, clerk_org_id (the Clerk organization, null if none is linked), name, currency, timezone, tax settings, enabled modules, sidon_marina_id (linked Sidon marina, null if none)',
```
New:
```js
    description: 'The property (venue/org) this API key operates for: id, clerk_org_id (the Clerk organization, null if none is linked), name, currency, timezone, tax settings, enabled modules',
```
In `update_property`'s `inputSchema` (l.729), delete:
```js
      sidon_marina_id: z.string().nullable().optional().describe("Sidon marina owner id (org_...) this property runs, shown on the dashboard's Marina page; null to clear. Changing or clearing it drops the stored marina API key (an admin re-enters it in Settings)"),
```

- [ ] **Step 8: Run the gates**

Run, each from O:
```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js; echo "exit=$?"
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina.js; echo "exit=$?"
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-import-sidon.js; echo "exit=$?"
cd /c/Users/robert/source/repos/OTA && node -e "require('./src/app'); require('./mcp-server/tools'); console.log('loads')"
```
Expected:
- The HTTP check prints the four `ok   cleanup: ...` lines and ends `all passed`, `exit=0`.
- `check-marina.js` and `check-import-sidon.js` each end `all passed`, `exit=0`. The importer still works because the columns still exist.
- The last command prints `loads`, which proves no dangling `require('../controllers/marina')`. If it hangs on the pg pool, stop it with Ctrl-C; seeing `loads` is enough.

- [ ] **Step 9: Commit 1**

```bash
git -C /c/Users/robert/source/repos/OTA add src/routes/marina.js src/docs/swagger.js src/controllers/property.js mcp-server/tools.js scripts/check-marina-http.js
git -C /c/Users/robert/source/repos/OTA commit -F - <<'EOF'
Marina cleanup: remove the interim Sidon link

PUT /api/marina/key and POST /api/marina/key/clear are gone with their
controller. /api/property/me no longer returns or accepts the Sidon
marina id or key flag; a body sidon_marina_id is ignored. MCP
update_property loses that argument and get_property stops naming it.
The columns stay until the follow-up migration, so this deploy can roll
back cleanly.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
(`src/controllers/marina.js` was already staged as deleted by `git rm` in Step 4.)

Expected: `git -C /c/Users/robert/source/repos/OTA show --stat HEAD` lists exactly those six files, with `src/controllers/marina.js` as a deletion.

- [ ] **Step 10: Write the migration**

Create `O/src/db/migrate-2026-10-12-drop-sidon-columns.sql`:
```sql
-- Run ONLY after the cutover/cleanup code is live on Render (nothing reads these any more).
ALTER TABLE property DROP COLUMN IF EXISTS sidon_marina_id, DROP COLUMN IF EXISTS sidon_marina_key;
ALTER TABLE marina DROP COLUMN IF EXISTS sidon_owner_id;
ALTER TABLE marina_booking DROP COLUMN IF EXISTS legacy_payment_intent_id;
```

- [ ] **Step 11: Mirror it in `schema.sql`**

In `O/src/db/schema.sql`, in `CREATE TABLE property`, delete these five lines so `enabled_modules JSONB,` is followed directly by `created_at       TIMESTAMPTZ  DEFAULT now(),`:
```sql
  -- Linked Sidon marina (owner id, org_...) and its API key (mk_...), see
  -- migrate-2026-10-10-property-sidon-marina*.sql. The key is admin-set and
  -- never returned by any GET, like stripe_secret_key.
  sidon_marina_id  VARCHAR(100),
  sidon_marina_key TEXT,
```
Above `CREATE TABLE IF NOT EXISTS marina`, the import is no longer the thing that hard-deletes. Old:
```sql
-- Children of marina cascade on delete: rows are soft-deleted through
-- status in normal use, and the only hard delete is the Sidon import's
-- re-run (delete everything under the mapped marinas, then re-insert).
```
New:
```sql
-- Children of marina cascade on delete: rows are soft-deleted through
-- status in normal use. The cascade served the Sidon import's re-runs
-- (retired at cleanup, migrate-2026-10-12-drop-sidon-columns.sql).
```
In `CREATE TABLE IF NOT EXISTS marina`, delete:
```sql
  sidon_owner_id        TEXT UNIQUE, -- import mapping only; dropped at cleanup
```
In `CREATE TABLE IF NOT EXISTS marina_booking`, delete:
```sql
  legacy_payment_intent_id VARCHAR(255), -- import only (Sidon Connect PI), reference only
```

- [ ] **Step 12: Retire the importer and the leftover check literal**

```bash
git -C /c/Users/robert/source/repos/OTA rm scripts/import-sidon-marina.js scripts/check-import-sidon.js
cd /c/Users/robert/source/repos/OTA && sed -i "/includes('sidon-bookings')/d" scripts/check-marina.js && rg -n "sidon-bookings" scripts/check-marina.js; echo "rg_exit=$?"
```
Expected:
- `git rm` prints `rm 'scripts/import-sidon-marina.js'` and `rm 'scripts/check-import-sidon.js'`.
- The `rg` prints nothing and `rg_exit=1`.
- `git -C /c/Users/robert/source/repos/OTA diff --stat scripts/check-marina.js` shows one deletion. That line is Task 13's `run.toString()` assertion, which only re-stated what the `calls` deep-equal already pins.

- [ ] **Step 13: Verify the migration inside a rolled-back transaction (local DB only)**

Never use `scripts/run-migration.js`, which also hits `DATABASE_URL_LIVE`. Run:
```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config - <<'EOF'
const fs = require('fs');
const { Client } = require('pg');
const url = process.env.DATABASE_URL || '';
if (/neon\.tech|render\.com/.test(url)) throw new Error('refusing to run against a remote DB');
const cols = `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
  WHERE table_schema = 'public' AND (table_name, column_name) IN
    (('property','sidon_marina_id'), ('property','sidon_marina_key'), ('marina','sidon_owner_id'), ('marina_booking','legacy_payment_intent_id'))
  ORDER BY 1`;
(async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('BEGIN');
    console.log('before:', (await db.query(cols)).rows.map((r) => r.c).join(' '));
    const sql = fs.readFileSync('src/db/migrate-2026-10-12-drop-sidon-columns.sql', 'utf8');
    await db.query(sql);
    await db.query(sql); // IF EXISTS: a second application is a no-op
    console.log('after:', (await db.query(cols)).rows.length);
  } finally {
    await db.query('ROLLBACK');
    console.log('rolled back:', (await db.query(cols)).rows.length);
    await db.end();
  }
})();
EOF
```
Expected, exactly:
```
before: marina.sidon_owner_id marina_booking.legacy_payment_intent_id property.sidon_marina_id property.sidon_marina_key
after: 0
rolled back: 4
```
A `cannot drop column ... because other objects depend on it` error means a view or index depends on one of the columns. Stop and report it; do not add `CASCADE`.

- [ ] **Step 14: Gates and the acceptance rg**

Run, each from O:
```bash
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina.js; echo "exit=$?"
cd /c/Users/robert/source/repos/OTA && node -r dotenv/config scripts/check-marina-http.js; echo "exit=$?"
cd /c/Users/robert/source/repos/OTA && rg -n "sidon_marina|sidon_owner_id|legacy_payment_intent_id|sidon-bookings|SIDON_API_ORIGIN" src mcp-server scripts -g '!src/db/migrate-2026-10-1[01]-*'
```
Expected:
- Both checks end `all passed`, `exit=0`. The local DB still has the columns, since Step 13 rolled back; no code reads them any more.
- The `rg` prints only the new migration file (Windows path separators):
```
src\db\migrate-2026-10-12-drop-sidon-columns.sql:2:ALTER TABLE property DROP COLUMN IF EXISTS sidon_marina_id, DROP COLUMN IF EXISTS sidon_marina_key;
src\db\migrate-2026-10-12-drop-sidon-columns.sql:3:ALTER TABLE marina DROP COLUMN IF EXISTS sidon_owner_id;
src\db\migrate-2026-10-12-drop-sidon-columns.sql:4:ALTER TABLE marina_booking DROP COLUMN IF EXISTS legacy_payment_intent_id;
```
Any other line is a leftover: remove it before committing.

- [ ] **Step 15: Commit 2**

```bash
git -C /c/Users/robert/source/repos/OTA add src/db/migrate-2026-10-12-drop-sidon-columns.sql src/db/schema.sql scripts/check-marina.js
git -C /c/Users/robert/source/repos/OTA commit -F - <<'EOF'
Marina cleanup: migration dropping the Sidon columns; retire the importer

Drops property.sidon_marina_id/sidon_marina_key, marina.sidon_owner_id
and marina_booking.legacy_payment_intent_id (mirrored in schema.sql).
Apply it only after the cutover/cleanup code is live on Render. The
Sidon importer and its check go too, since they read
marina.sidon_owner_id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
(The two script deletions were staged by `git rm` in Step 12.)

Expected: `git -C /c/Users/robert/source/repos/OTA show --stat HEAD` lists exactly five files: the new migration, `schema.sql`, `check-marina.js` and the two deleted scripts.

- [ ] **Step 16: End state**

```bash
git -C /c/Users/robert/source/repos/OTA branch --show-current
git -C /c/Users/robert/source/repos/OTA log --oneline cutover/switch..cutover/cleanup
git -C /c/Users/robert/source/repos/OTA status --short
```
Expected:
- The branch is `cutover/cleanup`.
- The log shows exactly two commits: `Marina cleanup: migration dropping the Sidon columns; retire the importer` and `Marina cleanup: remove the interim Sidon link`.
- The status shows only the pre-existing `?? =` and `?? src/db/seed-extras.sql.pre-multi-property.bak`.

O is left on `cutover/cleanup`. Nothing has been pushed, merged, deployed or migrated. Task 16's runbook, Step 7, merges this branch two weeks after Switch, together with D `cutover/cleanup`. After the cleanup deploy is live on Render, with the user's go-ahead, it runs `node scripts/run-migration.js src/db/migrate-2026-10-12-drop-sidon-columns.sql`.

---

### Task 15: Dashboard cutover/cleanup

Repo: `D` = `C:/Users/robert/source/repos/ota-table-bookings`, branch `cutover/cleanup` cut from `main`. All commands are Git Bash and run from `D` unless they `cd` elsewhere. This task implements R20's cleanup half and the contract's "D — cleanup (Task 15)" section. Nothing is pushed. The runbook merges this branch at Step 7, two weeks after Switch.

**Files:**
- Modify: `C:/Users/robert/source/repos/ota-table-bookings/src/pages/settings.astro`. In the Modules tab (`data-settings-tab="modules"`), delete the `<!-- Inside modules-form … -->` comment and the whole `<form id="marina-form">` (lines 187-200 on today's `main`; find them by marker after plan C).
- Modify: `C:/Users/robert/source/repos/ota-table-bookings/src/scripts/settings-client.ts`. Delete the `// ── Sidon marina ──` block through `loadSidonMarina();` (lines 636-708 today), up to `// ── Billing ──`.
- Modify: `C:/Users/robert/source/repos/ota-table-bookings/src/scripts/sidebar-modules-widget.ts`. Change the `loadProperty()` type (line 14 today) and the nav rule in `applySidebarModules()` (lines 40-43 today, as plan C Task 5 left them).
- Modify: `C:/Users/robert/source/repos/ota-table-bookings/src/layouts/Layout.astro`. Change the comment on the `href: '/marina'` nav item (lines 82-83 today).
- Modify: `C:/Users/robert/source/repos/ota-table-bookings/src/pages/marina.astro`. Delete the interim markup (`#marina-empty`, the `<sidon-berth-map>` comment, `#marina-map`, `#marina-bookings`) and the interim-only `<style>` rules. Drop `hidden` from `#marina-dashboard`.
- Modify (full rewrite): `C:/Users/robert/source/repos/ota-table-bookings/src/scripts/marina-client.ts`. It becomes a one-import entry with no branch.
- Delete: `C:/Users/robert/source/repos/ota-table-bookings/src/scripts/marina-interim.ts`. The Sidon `MarinaBooking` type, `SIDON_API_ORIGIN` and the legacy element import all live in this file.
- Modify (via `npm uninstall`): `C:/Users/robert/source/repos/ota-table-bookings/package.json` and `package-lock.json`. The `"sidon-booking-widget-legacy": "npm:@forgebuild/sidon-booking-widget@0.4.17"` alias goes.
- Modify: `C:/Users/robert/source/repos/ota-table-bookings/tests/marina-interim.spec.ts`. Delete the interim, nav and branch cases. Keep the staff-forwarder smoke case(s) verbatim. Add the cleanup cases.
- Unchanged: `scripts/check-marina.ts` and `src/lib/marina-logic.ts`. Plan C put the nav rule inline in `sidebar-modules-widget.ts`, not in `marina-logic.ts`, and Step 3 proves it. Also unchanged: the `@forgebuild/sidon-booking-widget` dependency (vendored 1.1.0), the `sidon-berth-map` element, `src/pages/api/marina/guest/[...path].ts` and `MODULE_KEYS`.

**Interfaces:**
- Consumes (plan C, `contract-c.md`):
  - `loadMarinas(): Promise<MarinaRow[]>`: memoised `GET /api/marina/marinas`, active-only, `[]` on failure or no session.
  - `loadProperty()` in `src/scripts/sidebar-modules-widget.ts`.
  - `src/scripts/marina-dashboard.ts`: a side-effect module that mounts the map through `mountStaffMap`.
  - The `/marina` DOM ids `#marina-dashboard` and `#marina-select`.
  - `tests/marina-helpers.ts`: `uniqueSlug(prefix?)`, `createMarinaViaUi(page, { name, slug }): Promise<string>`, `deactivateMarinaViaUi(page, id)`.
  - The staff forwarder smoke case in `tests/marina-interim.spec.ts`.
- Produces:
  - Nav rule: `[data-marina]` is unhidden iff `(await loadMarinas()).length > 0`.
  - `loadProperty()` typed `Promise<{ id?: string; timezone?: string; currency?: string; enabled_modules?: unknown } | null>`.
  - `/marina` always runs `marina-dashboard`.
  - D `cutover/cleanup` (one commit) for runbook Step 7. Once it is deployed, D no longer calls `PUT /api/marina/key` or `PUT /api/property/me {sidon_marina_id}`, so it can be deployed before or with O `cutover/cleanup` (Task 14).
  - Acceptance: `rg -n -i "sidon_marina|sidon-marina-id|sidon-marina-key|sidon-bookings|SIDON_API_ORIGIN|marina\.sidonmarine\.uk|sidon marina|sidon-booking-widget-legacy" src package.json tests` prints nothing.

- [ ] **Step 1: Gate — plan C is on D `main` and the tree is clean**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git switch main && git status --short
```
Expected: `Switched to branch 'main'` (or `Already on 'main'`) and no `git status` output. Any output means stop and report the dirty paths.

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && test -f scripts/check-marina.ts && test -f src/lib/marina-logic.ts && test -f src/scripts/marina-interim.ts && test -f src/scripts/marina-dashboard.ts && grep -q "marina-interim" src/scripts/marina-client.ts && grep -q "export function loadMarinas" src/scripts/sidebar-modules-widget.ts && grep -q '"sidon-booking-widget-legacy": "npm:@forgebuild/sidon-booking-widget@0.4.17"' package.json && grep -q '"@forgebuild/sidon-booking-widget": "file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz"' package.json && echo gate-ok
```
Expected: `gate-ok`. If it prints nothing, plan C is not on `main`. On 2026-10-12 this is the case: `main` is `f066e74`, there's no `scripts/`, and the widget is `^0.4.17`. Stop and report "Task 15 blocked: plan C not merged on D main" without creating the branch.

- [ ] **Step 2: Baseline gates on `main`, then branch**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts && npx astro check 2>&1 | grep -E '^- [0-9]+ (errors|warnings)'
```
Expected: `check-marina: ok`, then `- 0 errors` and `- 0 warnings` (today's `main` is 0/0). Note the counts; they must not increase after the edits.

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git switch -c cutover/cleanup main
```
Expected: `Switched to a new branch 'cutover/cleanup'`.

- [ ] **Step 3: Confirm there is no nav or Sidon logic in the pure module**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rg -n -i "sidon|marinaNav|showMarina" src/lib/marina-logic.ts scripts/check-marina.ts
```
Expected: nothing (exit 1). Plan C's `marina-logic.ts` exports none of these (contract-c "Dashboard"), so `check-marina.ts` needs no change. If this prints a nav helper that takes `sidon_marina_id`, stop and report: plan C deviated from its contract, and the failing-first edit to `check-marina.ts` has to be planned against the real export.

- [ ] **Step 4: The failing check — the acceptance `rg` before the edits**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rg -n -i "sidon_marina|sidon-marina-id|sidon-marina-key|sidon-bookings|SIDON_API_ORIGIN|marina\.sidonmarine\.uk|sidon marina|sidon-booking-widget-legacy" src package.json tests
```
Expected: FAIL, meaning it prints hits. At minimum:
- `src/layouts/Layout.astro` (the Marina comment)
- `src/pages/marina.astro` (`Add your Sidon marina ID`, `sidon_marina_id is known`)
- `src/pages/settings.astro` (`sidon-marina-id`, `sidon-marina-key`, `sidon-marina-key-status`)
- `src/scripts/settings-client.ts` (the `── Sidon marina ──` block)
- `src/scripts/sidebar-modules-widget.ts` (type and rule)
- `src/scripts/marina-interim.ts` (`SIDON_API_ORIGIN`, `marina.sidonmarine.uk`, `/api/marina/sidon-bookings`, `sidon-booking-widget-legacy/berth-map`, `sidon_marina_id`)
- `package.json` (`sidon-booking-widget-legacy`)
- `tests/marina-interim.spec.ts` (`sidon_marina_id: 'pw-sidon'`, `sidon-bookings`, `marina.sidonmarine.uk`)

- [ ] **Step 5: Settings — remove the Sidon form**

`src/pages/settings.astro`, old (directly after the `module-event_inquiries` checkbox label):
```astro
        <label class="checkbox-field" for="module-event_inquiries"><input type="checkbox" id="module-event_inquiries" value="event_inquiries" /> Event Inquiries</label>
        <!-- Inside modules-form so its 1rem gap spaces it from the checkboxes. -->
        <form id="marina-form" class="settings-form">
          <label for="sidon-marina-id">
            Sidon marina ID
            <input id="sidon-marina-id" type="text" placeholder="org_…" maxlength="100" pattern="[A-Za-z0-9_\-]+" />
          </label>
          <p class="chart-card-subtitle">Adds a Marina page with this marina's berth map. The ID is the last part of its Sidon API URL (…/api/marina/public/<code>org_…</code>).</p>
          <label for="sidon-marina-key">
            Sidon API key
            <input id="sidon-marina-key" type="password" autocomplete="new-password" data-1p-ignore data-lpignore="true" placeholder="mk_…" maxlength="200" />
          </label>
          <p id="sidon-marina-key-status" class="chart-card-subtitle">Shows the marina's bookings on the Marina page. Copy it from the Sidon dashboard's API key setting. Admins only.</p>
          <button id="sidon-marina-save" type="submit" disabled>Save</button>
        </form>
      </div>
```
new:
```astro
        <label class="checkbox-field" for="module-event_inquiries"><input type="checkbox" id="module-event_inquiries" value="event_inquiries" /> Event Inquiries</label>
      </div>
```

`src/scripts/settings-client.ts`, old (everything between `loadEnabledModules();` and the Billing header):
```ts
loadEnabledModules();

// ── Sidon marina ──────────────
// The id rides PUT /me like every other property field; the key is a
// secret with its own admin-only route (same split as the Stripe key) and
// is never read back -- only sidon_marina_key_set. Changing or clearing the
// id drops the key server-side, so the client never has to.

const sidonMarinaInput = document.getElementById('sidon-marina-id') as HTMLInputElement;
const sidonMarinaKeyInput = document.getElementById('sidon-marina-key') as HTMLInputElement;
const sidonMarinaSaveBtn = document.getElementById('sidon-marina-save') as HTMLButtonElement;
let sidonMarinaKeySet = false;

function renderSidonMarinaKey() {
  sidonMarinaKeyInput.placeholder = sidonMarinaKeySet ? 'Saved — enter a new key to replace it' : 'mk_…';
}

// An empty field leaves a saved key alone.
async function saveSidonMarinaKey(): Promise<boolean> {
  const key = sidonMarinaKeyInput.value.trim();
  if (!key) return true;
  const res = await apiFetch('/api/marina/key', {
    method: 'PUT',
    body: JSON.stringify({ sidon_marina_key: key }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    showToast(`Failed to save the API key — ${body?.error ?? 'unknown error'}`, 'error');
    return false;
  }
  sidonMarinaKeySet = body.sidon_marina_key_set;
  sidonMarinaKeyInput.value = '';
  renderSidonMarinaKey();
  return true;
}

(document.getElementById('marina-form') as HTMLFormElement).addEventListener('submit', async (e) => {
  e.preventDefault();
  sidonMarinaSaveBtn.disabled = true;
  try {
    const res = await apiFetch('/api/property/me', {
      method: 'PUT',
      body: JSON.stringify({ sidon_marina_id: sidonMarinaInput.value.trim() || null }),
      signal: AbortSignal.timeout(15000),
    });
    const updated = await res.json().catch(() => null);
    if (!res.ok || !updated) {
      showToast(`Failed to save — ${updated?.error ?? 'unknown error'}`, 'error');
      return;
    }
    sidonMarinaInput.value = updated.sidon_marina_id ?? '';
    for (const el of document.querySelectorAll<HTMLElement>('[data-marina]')) el.hidden = !updated.sidon_marina_id;
    sidonMarinaKeySet = !!updated.sidon_marina_key_set;
    renderSidonMarinaKey();
    if (await saveSidonMarinaKey()) showToast('Marina saved', 'success');
  } catch {
    showToast('Failed to save', 'error');
  } finally {
    sidonMarinaSaveBtn.disabled = false;
  }
});

async function loadSidonMarina() {
  const res = await apiFetch('/api/property/me').catch(() => null);
  const settings: { sidon_marina_id?: string | null; sidon_marina_key_set?: boolean } | null = res?.ok ? await res.json().catch(() => null) : null;
  if (!settings) return; // leave Save disabled -- a save now would clear a real id
  sidonMarinaInput.value = settings.sidon_marina_id ?? '';
  sidonMarinaKeySet = !!settings.sidon_marina_key_set;
  renderSidonMarinaKey();
  sidonMarinaSaveBtn.disabled = false;
}

loadSidonMarina();

// ── Billing ──────────────
```
new:
```ts
loadEnabledModules();

// ── Billing ──────────────
```
`apiFetch` and `showToast` stay imported because the Modules and Billing blocks still use them.

- [ ] **Step 6: Nav rule and the `loadProperty()` type**

`src/scripts/sidebar-modules-widget.ts`. The type line, old (as plan C Task 5 left it):
```ts
let propertyPromise: Promise<{ id?: string; timezone?: string; currency?: string; enabled_modules?: unknown; sidon_marina_id?: string | null; sidon_marina_key_set?: boolean } | null> | undefined;
```
new:
```ts
let propertyPromise: Promise<{ id?: string; timezone?: string; currency?: string; enabled_modules?: unknown } | null> | undefined;
```
In `applySidebarModules()`, old (plan C Task 5's rule: the `loadProperty()` line plus the `if` that unhides `[data-marina]` on `property?.sidon_marina_id || (await loadMarinas()).length > 0`):
```ts
  const property = await loadProperty();
  if (property?.sidon_marina_id || (await loadMarinas()).length > 0) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-marina]')) el.hidden = false;
  }
  const enabledModules = await loadEnabledModules();
```
new:
```ts
  // Marina isn't a module toggle: it shows once the property has at least
  // one active marina (GET /api/marina/marinas is active-only by default).
  if ((await loadMarinas()).length > 0) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-marina]')) el.hidden = false;
  }
  const enabledModules = await loadEnabledModules();
```
The `const property` line goes because the Sidon rule was its only reader in this function. `loadEnabledModules()` still calls `loadProperty()` itself. If plan C's wording of the `if` differs, replace whatever `if` unhides `[data-marina]`; the new block is the same either way.

`src/layouts/Layout.astro`, on the `href: '/marina'` nav item. The comment lines above `marina: true,` are today's text below, or whatever plan C Task 5 updated them to:
```astro
    // Not a module toggle: shown only once Settings has a Sidon marina id
    // (sidebar-modules-widget.ts unhides it).
    marina: true,
```
new:
```astro
    // Not a module toggle: shown once the property has at least one active
    // marina (sidebar-modules-widget.ts unhides it).
    marina: true,
```

- [ ] **Step 7: `/marina` — dashboard only**

`src/scripts/marina-client.ts`, whole file:
```ts
// /marina is the OTA staff dashboard for every property. The Sidon interim
// page (and the 0.4.17 element it needed) went at the cutover cleanup, so
// there is no branch: only the 1.1 element is ever loaded on this page.
import './marina-dashboard';
```

Delete the interim script:
```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rm src/scripts/marina-interim.ts
```

`src/pages/marina.astro`: delete the interim markup, which plan C Task 13 kept with unchanged ids. Old:
```astro
      <p id="marina-empty" class="chart-card-subtitle" hidden>
        No marina linked yet. Add your Sidon marina ID in <a href="/settings">Settings → Modules</a>.
      </p>
      <!-- <sidon-berth-map> (from @forgebuild/sidon-booking-widget, the same
           element the marina websites embed) is created here once the
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
```
new: nothing. If this leaves an interim-only wrapper with no children (today's `<div class="marina-page">`), delete that wrapper too. Keep any wrapper that also holds `#marina-dashboard`.

In the element with `id="marina-dashboard"`, delete its `hidden` attribute. Plan C hid it until the router picked a branch, and there is no router now. If `marina-dashboard.ts` also sets `hidden = false`, that stays harmless.

Then decide which interim CSS goes:
```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rg -n '"marina-map"|"marina-bookings"|marina-map\b|marina-bookings\b' src/pages/marina.astro src/scripts/marina-dashboard.ts src/scripts/marina-staff-map.ts
```
Expected: only `<style>` lines in `marina.astro`. Delete those rules from the `<style>` block: `.marina-map { … }`, `.marina-map:empty { … }`, `.marina-bookings h2 { … }`, the `/* Rows are built in marina-client.ts … */` comment with `.marina-bookings :global(td) { … }`, and `.marina-bookings :global(.muted-text) { … }`. Keep any rule whose class still appears in markup or in those scripts, and keep `.marina-page [hidden]` while `.marina-page` is still used. Re-run the `rg`; expected: nothing.

- [ ] **Step 8: Drop the legacy alias**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npm uninstall sidon-booking-widget-legacy && grep -c "sidon-booking-widget-legacy" package.json package-lock.json; npm ls @forgebuild/sidon-booking-widget
```
Expected: `removed 1 package` (the count may vary), then `package.json:0` and `package-lock.json:0`, then a tree line `@forgebuild/sidon-booking-widget@1.1.0` (from `file:vendor/forgebuild-sidon-booking-widget-1.1.0.tgz`).

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rg -n "legacy|MarinaBooking\b|marina-interim" src astro.config.mjs tsconfig.json
```
Expected: nothing. A leftover `declare module 'sidon-booking-widget-legacy/…'` or a `MarinaBooking` reference means delete that declaration or reference too.

- [ ] **Step 9: Rewrite the interim/nav cases in `tests/marina-interim.spec.ts`**

1. Delete every `test(...)` whose body uses `pw-sidon`, `sidon_marina_id`, `sidon-bookings`, `marina.sidonmarine.uk`, `api-origin`, `#marina-empty`, `#marina-map`, `#marina-bookings` or the branch/nav cases from plan C Tasks 5 and 13.
2. Keep the staff-forwarder smoke case(s) verbatim (they hit `/api/marina/guest/` on the dashboard origin), with the imports and helpers they use. Delete imports that are now unused.
3. Append this block at the end of the file. Merge the two import lines with the file's existing imports, with no duplicate names:
```ts
import { test, expect } from '@playwright/test';
import { uniqueSlug, createMarinaViaUi, deactivateMarinaViaUi } from './marina-helpers';

// After the cutover cleanup the Marina nav depends only on OTA marinas, and
// /marina is always the staff dashboard (no interim page, no Sidon element).
test.describe('Marina nav and /marina (post-cutover)', () => {
  test('no active marina: no Marina nav item', async ({ page }) => {
    // Other specs leave real marinas on the shared test property, so pin the
    // nav's list empty. The regex skips Settings' ?include_inactive=1 fetch.
    await page.route(/\/api\/marina\/marinas$/, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback()
    );
    const marinasRequest = page.waitForRequest(/\/api\/marina\/marinas$/);
    await page.goto('/dashboard');
    await marinasRequest;
    await expect(page.locator('a[data-marina]')).toBeHidden();
  });

  test('Settings has no Sidon form', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('[data-settings-tab="modules"]')).toHaveCount(1);
    await expect(page.locator('#marina-form')).toHaveCount(0);
  });

  test('an active marina: Marina nav item and the dashboard', async ({ page }) => {
    const slug = uniqueSlug();
    const id = await createMarinaViaUi(page, { name: `PW Cleanup ${slug}`, slug });
    try {
      await page.goto('/marina');
      await expect(page.locator('a[data-marina]')).toBeVisible();
      await expect(page.locator('#marina-dashboard')).toBeVisible();
      await expect(page.locator('#marina-select')).toBeVisible();
      await expect(page.locator('#marina-empty, #marina-map, #marina-bookings')).toHaveCount(0);
    } finally {
      await deactivateMarinaViaUi(page, id);
    }
  });
});
```

Then check the other specs:
```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rg -n -i "sidon_marina|sidon-bookings|marina\.sidonmarine\.uk|sidon-booking-widget-legacy|pw-sidon" tests
```
Expected: nothing. A hit in another `tests/marina*.spec.ts` is a plan C case that asserts the interim page or "no request reaches Sidon". Delete that `test(...)` (Sidon is gone, so the case has nothing left to assert) and re-run until nothing prints.

- [ ] **Step 10: Acceptance `rg` passes**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && rg -n -i "sidon_marina|sidon-marina-id|sidon-marina-key|sidon-bookings|SIDON_API_ORIGIN|marina\.sidonmarine\.uk|sidon marina|sidon-booking-widget-legacy" src package.json tests; echo "exit=$?"
```
Expected: only `exit=1`, with no match lines. A remaining hit in a comment, for example in plan C's `marina-dashboard.ts`, gets reworded to name OTA instead.

- [ ] **Step 11: Type check, build, pure check**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npx astro check 2>&1 | grep -E '^- [0-9]+ (errors|warnings)'
```
Expected: no more errors or warnings than Step 2's baseline (`- 0 errors`, `- 0 warnings`). A new `Cannot find name 'loadProperty'`-style error in `sidebar-modules-widget.ts` means a reader of `property` was missed in Step 6. Restore only that reader, typed without the Sidon fields.

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npm run build 2>&1 | tail -3
```
Expected: the last lines include `[build] Complete!` and no `Could not resolve "sidon-booking-widget-legacy` error.

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && node scripts/check-marina.ts
```
Expected: `check-marina: ok`.

- [ ] **Step 12: Playwright against local OTA on :3100**

Free the ports first. A dev server already on 4335 would be reused by Playwright's `webServer` with the wrong `PUBLIC_OTA_API_BASE_URL`:
```bash
for port in 3100 4335; do
  for pid in $(netstat -ano | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do taskkill //PID "$pid" //T //F; done
done
```
Expected: nothing, or a `SUCCESS: … terminated.` line per stopped process.

Start OTA with `run_in_background: true`:
```bash
cd /c/Users/robert/source/repos/OTA && PORT=3100 npm start
```
Wait until it answers, using Monitor with an until-loop on this command:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/marina/marinas
```
Expected: `401` (it is up, and the route needs a bearer).

Run the marina specs. Playwright's `webServer` runs `npm run dev`, which inherits the env var, and Vite lets `process.env` win over `.env`:
```bash
cd /c/Users/robert/source/repos/ota-table-bookings && PUBLIC_OTA_API_BASE_URL=http://localhost:3100 npx playwright test tests/marina*.spec.ts --reporter=line
```
Expected: `N passed` and no `failed` line. N covers `auth.setup.ts` plus every case in `marina-interim` (the forwarder smoke cases plus the 3 new cases), `marina-settings`, `marina-setup`, `marina-bookings`, `marina` and `marina-enquiries`. A failure in `an active marina` where `#marina-dashboard` stays hidden means `marina-dashboard.ts` waits for a router signal; read it and fix it in this task, then re-run.

Stop the servers:
```bash
for port in 3100 4335; do
  for pid in $(netstat -ano | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u); do taskkill //PID "$pid" //T //F; done
done
```
Expected: a `SUCCESS` line for the OTA process. Port 4335 was already stopped by Playwright, so it prints nothing. Running the loop again prints nothing.

- [ ] **Step 13: Commit on `cutover/cleanup`**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git status --short
```
Expected: only the paths listed below: `M` for each modified file and `D src/scripts/marina-interim.ts`. If `playwright-report/` or `test-results/` show up, they are untracked output; don't add them.

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git add src/pages/settings.astro src/scripts/settings-client.ts src/scripts/sidebar-modules-widget.ts src/layouts/Layout.astro src/pages/marina.astro src/scripts/marina-client.ts src/scripts/marina-interim.ts package.json package-lock.json tests/marina-interim.spec.ts && git commit -m "Marina dashboard: cutover cleanup, drop the Sidon interim page, nav rule and Settings form" -m "Sidon is retired, so the Marina nav shows only when the property has an active OTA marina, /marina always runs the staff dashboard, and the Settings Sidon marina id/key form, the interim map/bookings page (marina-interim.ts with its Sidon booking type) and the 0.4.17 sidon-booking-widget-legacy alias are removed. The interim/nav Playwright cases become 'no active marina -> no nav; an active marina -> nav + dashboard'; the staff-forwarder smoke case stays." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(If plan C's `marina-dashboard.ts` comment was reworded in Step 10, or another spec case was deleted in Step 9, add those exact paths to the `git add` list.)

Expected: `[cutover/cleanup <sha>] Marina dashboard: cutover cleanup, …` with 10 files changed, including `delete mode 100644 src/scripts/marina-interim.ts`. `git -C /c/Users/robert/source/repos/ota-table-bookings branch --show-current` prints `cutover/cleanup`. Leave the repo on this branch and don't push. The runbook (Task 16, `## Step 7 — Clean up`) pushes and merges it two weeks after Switch, with the user's go-ahead.

---

### Task 16: The cutover runbook (O main)

Repo `O`, branch `main`. This task writes R35's runbook, which is the only place that pushes, merges, publishes, deploys, migrates live or creates and archives repos. It is a document only: nothing in it is run here.

**Files:**
- Create: `docs/superpowers/runbooks/2026-10-marina-cutover.md`.

**Interfaces:**
- Consumes: every branch from Tasks 5–15, the importer CLI (Tasks 1–4), the demo seed's `MARINA_DEMO_SLUG` (Task 5), the contract's "Expected live numbers", the booking-paths table, the env names and G4/G6/G7.
- Produces: the runbook with the contract's twelve sections in order.

- [ ] **Step 1: Write the runbook**

Create `docs/superpowers/runbooks/2026-10-marina-cutover.md` with exactly this content:

````markdown
# Marina cutover runbook (Sidon Marina → OTA), October 2026

Spec: `docs/superpowers/specs/2026-10-10-ota-marina-unification-design.md`, section "Cutover" (amended in `5ac187f`). Plans: `docs/superpowers/plans/2026-10-11-marina-module-b-widget-1.0.md`, `2026-10-12-marina-module-c-dashboard.md` and `2026-10-12-marina-module-d-import-cutover.md`.

**Every step marked ⚠ needs the user's go-ahead at the time it runs.** That covers every push, merge, deploy, npm publish, Vercel or Render env change, live migration, `gh repo create`, `gh repo archive`, tag push, reset of sidon-marina's local `master`, and blob deletion. Approval for one ⚠ step doesn't carry to the next. Pushing OTA `main` deploys production on Render, and pushing a site's `master`/`main` deploys it on Vercel.

Repos (Git Bash paths): `O` = `/c/Users/robert/source/repos/OTA`, `W` = `…/sidon-booking-widget`, `D` = `…/ota-table-bookings`, `PB` = `…/pirates-bight`, `TT` = `…/tested-trappist`, `SEA` = `…/sea-company`, `PO` = `…/portals`, `MP` = `…/marina-di-positano`, `SM` = `…/sidon-marina`, `SA` = `…/sidon-ai`, `APP` = `…/sidon-marina-app`.

Never paste a key, token, DB URL, email address or Sidon owner id into a log, commit, PR or chat. The importer prints aliases (`o_xxxxxx`), slugs and counts only.

## Prerequisites

1. Plans B and C are complete. `W/package.json` is `1.1.0`, and D `main` has plan C's `/marina` dashboard.
2. ⚠ npm: `cd W && npm login` (the `forgebuild` account; `npm whoami` must print `forgebuild`), then `npm publish`. Check with `npm view @forgebuild/sidon-booking-widget version`, which should print `1.1.0`. If 1.0.0 was never published, 1.1.0 is the first release, and that is fine.
3. ⚠ Render (OTA service) env: `MARINA_BOOKING_TOKEN_SECRET` (`openssl rand -hex 32`), `BLOB_READ_WRITE_TOKEN` (a new private Vercel Blob store) and `BLOB_PUBLIC_READ_WRITE_TOKEN` (a new public store). Render redeploys on save. Check: `curl -s https://<ota-host>/api/marina/guest/nope` answers 404 JSON, not 503.
4. ⚠ Live multi-property migration (R4, `src/db/migrate-2026-10-11-property-org-not-unique.sql`), run by the user before any created property shares a Clerk org with an existing property. Until it has run, give every created property its own new Clerk org.
5. O `.env` (by hand, never committed): `SIDON_DATABASE_URL` (Sidon's Neon URL, read-only use), `DATABASE_URL_LIVE`, and for the live import with files the live `BLOB_READ_WRITE_TOKEN` and `BLOB_PUBLIC_READ_WRITE_TOKEN`.
6. Dirty trees: SEA, SA, SM and APP had uncommitted work when plan D was written. Their branches exist only once the user has committed or stashed it (plan D Tasks 7, 10–12).

## Inputs to collect

Record these in the sign-off note (not in git; they include org ids):

| input | for | notes |
|---|---|---|
| OTA Clerk org id per created property | Step 2 map file | The operator creates each org first (Clerk dashboard). Created properties: Puerto Portals, HOTAL, Marina di Positano, Marina di Amalfi and SEA Company (Fox + Pevero). |
| Clerk org linked to BBYC's property | Step 2 | It has no `clerk_org_id` today. Link it before the import. |
| IANA timezone per created property | Step 2 | HOTAL (37N 27E): confirm `Europe/Istanbul` or `Europe/Athens`. The Italian and Mallorca ones are `Europe/Rome` and `Europe/Madrid`. |
| Pirates Bight and BBYC property timezones | Step 4 | These are reused unchanged, and occupancy arrival = that property's today. Check them in OTA Settings. |
| Currency decision for BBYC (GBP property, eur marina) and Pirates Bight (check its property currency against Sidon `usd`) | Step 2 | `accept_as_property_currency` or `drop_prices`. If BBYC must show a forced symbol, note it for TT. |
| Slug per marina | Step 2 | Default: Sidon's slug, else `slugify(name)`. BBYC's slug sets TT's `BBYC_SLUG`, default `bora-bora-yacht-club`. |
| Production origin per site | Step 6 | PB, TT, SEA, MP (PO has none until it launches). Confirm the real domains, not only `*.vercel.app`. |
| `OTA_DASHBOARD_URL` | Steps 3 and 6 | Default `https://hotal.forge-build.co.uk`. |
| Re-key decision for `o_0ddee1` | Step 2 | The default is skip (it is ambiguous). |

## Branches and when they merge

| repo | branch | made by | merged / pushed at |
|---|---|---|---|
| SM | `cutover/freeze` | plan D Task 10 | Step 3 |
| PB | `cutover/switch` | Task 5 | Step 6 (PR opened at Step 1) |
| TT | `cutover/switch` | Task 6 | Step 6 (PR at Step 1) |
| SEA | `cutover/switch` | Task 7 | Step 6 (PR at Step 1) |
| PO | `cutover/switch` | Task 8 | Step 6, after `gh repo create`; merged, not deployed |
| MP | `cutover/switch` | Task 9 | Step 6, after `gh repo create` (PR at Step 1) |
| SM | `cutover/switch` | Task 11 | Step 6 |
| SA | `cutover/switch` | Task 12 | Step 6 |
| O | `cutover/switch` | Task 13 | Step 6 |
| O | `cutover/cleanup` | Task 14 | Step 7, two weeks after Switch. Its column-drop migration runs on live only after this deploy is live. |
| D | `cutover/cleanup` | Task 15 | Step 7, with or before O `cutover/cleanup` |

O `main` (plan D Tasks 1–5 and 16) and D `main` (plan C) are pushed at Step 1.

Lockfiles (G6): after `npm publish`, on each of PB, TT, SEA, PO and MP's `cutover/switch`, run `npm install`, check that `git diff package-lock.json` resolves `@forgebuild/sidon-booking-widget` to `1.1.0` from the npm registry, then `git add package-lock.json && git commit -m "Lockfile for @forgebuild/sidon-booking-widget 1.1.0"` (message ending with the usual Co-Authored-By line).

Env timing: every site inlines `import.meta.env` at build time, so **redeploy after every Vercel env change** (TT's `astro:env` secrets are read at runtime, but redeploy anyway).

## Step 1 — Dark deploy

Nothing user-visible changes.

1. ⚠ Push O `main` (plan C's OTA follow-ups, plan D's importer and seed option, this runbook): `git -C O push origin main`. Render deploys. Check that `GET /api/marina/marinas` (bearer) answers 200.
2. ⚠ Push D `main` (plan C dashboard). `/marina` shows the interim page for every property until a property has an active OTA marina.
3. ⚠ Set `OTA_BASE_URL` (the OTA origin) and `OTA_API_KEY` (that property's key from the dashboard org modal) in Vercel **Preview only** for PB, TT, SEA and MP. Production stays without them until Step 6, so the kill switch keeps Production unchanged even if a branch were merged early. For MP and PO, first run ⚠ `gh repo create robooko/marina-di-positano --private --source . --push` (and `robooko/portals` the same way), from that repo.
4. ⚠ Push each consumer `cutover/switch` (PB, TT, SEA, MP, PO) and open a PR. Use `gh pr create --base master --head cutover/switch --title "Marina booking on OTA" --body-file <notes>`, with the body from the task's commit message. Each Preview deploy must build. Booking appears only once the map and import exist, so the Preview shows the fallback until Step 5.
5. ⚠ Push SA `cutover/switch` and open its PR (not merged).

## Step 2 — Map

1. Write `O/.superpowers/import-map.live.json` (gitignored). Use the contract shape with the user's inputs, keyed by owner alias:
   - Pirates Bight's profile → `{ "action": "property", "property_id": "<live Pirates Bight id>", "currency_decision": … }`.
   - BBYC → `{ "action": "property", "property_id": "<live BBYC id>", "currency_decision": … }`.
   - Fox and Pevero → two `create` entries with the identical `name: "SEA Company"`, `timezone` and `clerk_org_id`.
   - Puerto Portals, HOTAL, Marina di Positano and Marina di Amalfi → `create`, each with its own org.
   - The other Pirates Bight profile, "Playwright Test Marina" and "nvcnv" → `skip` with a reason.
   - `o_b97ea0` → `{ "action": "rekey", "to_owner": "<Positano alias>" }`, and `o_f54f18` → rekey to Puerto Portals.
   - `o_0ddee1` → `skip` ("ambiguous"), unless the user decided a re-key.
   - `o_813f82` (a message only) is auto-skipped.
   Write `import-map.local.json` the same way, but with local property ids (or `create` everywhere) for the rehearsal.
2. Print the plans:
   ```bash
   cd /c/Users/robert/source/repos/OTA && node scripts/import-sidon-marina.js --map .superpowers/import-map.local.json
   cd /c/Users/robert/source/repos/OTA && node scripts/import-sidon-marina.js --map --live
   ```
   Each must exit 0 with no `refusals:` block. Check the grouping (SEA Company ← two aliases), the re-keys, the currency flags with their decisions, the slugs (unique), and the profile-less suggestions (they must agree with the map's re-keys).
3. Sign-off (user): the printed live plan, plus these recorded consequences:
   - **No document file is copied (G4).** Every document linked to an imported booking is a `sailor-docs/*` file (sidon-ai's wallet), and those are never read. Staff will see the document rows with the file marked deleted. The 32 `marina-docs/*` uploads have no booking, so they go to the archive. Changing this means changing ruling R14.
   - Tier dates are taken as typed (`slice(0,10)`), not converted to the property's timezone (spec amendment, Notes).
   - Public image URLs change on every re-run (accepted).

## Step 3 — Freeze

1. ⚠ Set `OTA_DASHBOARD_URL` in SM's Vercel env (Production) now, so it is in place for the Step 6 build.
2. ⚠ Tag and push the shelved AI work: `git -C SM tag ai-replies-shelved 88ee507 && git -C SM push origin ai-replies-shelved`.
3. ⚠ Merge SM `cutover/freeze` into `origin/master`:
   ```bash
   cd /c/Users/robert/source/repos/sidon-marina && git fetch origin && git push origin cutover/freeze:master
   ```
   This is a fast-forward, because `cutover/freeze` was cut from `origin/master`. If it is refused, `origin/master` moved: rebase `cutover/freeze` onto it, re-run `node scripts/check-cutover.ts && npm run build`, and retry. Vercel deploys it.
4. Check: `curl -s -X POST https://<sidon-marina origin>/api/marina/anything -o /dev/null -w '%{http_code}\n'` prints `503`, and a GET of a public marina page still renders.
5. Tell marina staff that the Sidon dashboard is read-only until Switch (user).
6. ⚠ Only with explicit approval: reset SM's local `master` to `origin/master` (`git -C SM switch master && git -C SM reset --hard origin/master`). The 7 AI commits are kept by the tag.

## Step 4 — Import

All commands run from O.

1. Local rehearsal, with no files:
   ```bash
   node scripts/import-sidon-marina.js .superpowers/import-map.local.json --dry-run --no-files
   node scripts/import-sidon-marina.js .superpowers/import-map.local.json --no-files
   node scripts/import-sidon-marina.js .superpowers/import-map.local.json --no-files     # re-run: same ids, same counts
   ```
2. Reconcile against the expected live numbers (plan D contract):

   | count | expected |
   |---|---|
   | berths imported | 1,156 (+80 `berths_duplicate`) |
   | bookings imported | 139 (+5 `bookings_no_berth`, +1 `bookings_overlap`; the 3 of `o_0ddee1` are skipped) |
   | `pending_expired` | 66 |
   | occupancy | 275 |
   | signatures | 4 |
   | `documents_copied` | 0 |
   | `documents_sailor_docs` | 383 |
   | archived paths | 32 |
   | `sailor_docs_unlinked` | 169 (383 + 32 + 169 = 584) |
   | messages exported | 41 with files on (0 under `--no-files`) |

   Any other difference is explained before going on (for example a booking made in Sidon after the survey).
3. ⚠ Live dry run: `node scripts/import-sidon-marina.js --live --dry-run --no-files`. It must print the same counts.
4. ⚠ Live import with files: `node scripts/import-sidon-marina.js --live`. It needs the live blob tokens in O `.env`. Keep the printed report in the sign-off note.

## Step 5 — Verify

1. Counts match Step 4 (the report, plus the dashboard `/marina-bookings` totals per marina).
2. Each consumer's Preview deploy (Step 1) now renders berths through its forwarder: `curl -s https://<preview>/api/marina/guest/<slug> | head -c 200` shows `"marina"`.
3. End-to-end on Pirates Bight's Preview with Stripe test keys:
   - hold → card → pending → booking page (from the email link) → upload → verify in `/marina-bookings` → contract → confirm → capture;
   - then a guest cancel, a hold left to expire (sweep), and the closed-tab case (close the tab after the card step, reopen the booking link, and payment resumes).
4. The dashboard `/marina` for each created property's org shows tiles and the staff map, and the nav shows Marina.

## Step 6 — Switch

In this order, each ⚠:

1. The lockfile commit on each consumer `cutover/switch` (see Branches).
2. Fill in SM `cutover/switch`'s `MARINA_SITES` values with the production origins (one commit on that branch, `node scripts/check-cutover.ts && npm run build`).
3. Set `OTA_BASE_URL` and `OTA_API_KEY` in Vercel **Production** for PB, TT, SEA and MP.
4. Merge the consumer PRs: PB, TT, SEA and MP (`gh pr merge --merge`). Vercel deploys each. Merge PO's too, but don't deploy it (it has no Vercel project).
5. Set each marina's `booking_url` in the dashboard (Settings → Marina):

   | site | `booking_url` |
   |---|---|
   | PB | `<origin>/booking?booking={id}&token={token}` |
   | TT | `<origin>/booking?booking={id}&token={token}` |
   | SEA (Fox) | `<origin>/booking?marina=fox-mooring&booking={id}&token={token}` |
   | SEA (Pevero) | `<origin>/booking?marina=pevero-mooring&booking={id}&token={token}` |
   | MP | `<origin>/booking?booking={id}&token={token}` |
   | PO | set when it launches |

6. Push and merge O `cutover/switch` (`git -C O push origin cutover/switch`, then `git -C O switch main && git -C O merge --no-edit cutover/switch && git -C O push origin main`). Render deploys. Check: `GET /api/marina/sidon-bookings` → 404.
7. Merge SM `cutover/switch` (`git -C SM push origin cutover/switch:master`). Check: `/api/marina/*` → 410, `/marina` → 301 to the dashboard, `/m/<slug>` → 301 to that marina's site, and an old booking link → the notice page.
8. Merge SA's PR, then remove `PUBLIC_MARINA_API_URL`, `MARINA_API_BASE_URL`, `MARINA_API_KEY`, `STRIPE_PRICE_MARINA` and `STRIPE_PRICE_MARINA_PRO` from Vercel project `sidon-ai` and redeploy. If the merge has to wait, unsetting `PUBLIC_MARINA_API_URL` and redeploying turns sidon-ai's marina calls off with no code change.
9. Remove the old site env vars and redeploy each site: PB `SIDON_URL`, `SIDON_API_KEY`; TT `SIDON_URL`, `SIDON_APIKEY`, `PUBLIC_SIDON_MARINA_ID`, `PUBLIC_SIDON_ORIGIN`; SEA `SIDON_URL`, `PUBLIC_SIDON_ORIGIN` (and `NODE_AUTH_TOKEN` if set); MP `SIDON_URL`, `PUBLIC_SIDON_ORIGIN`, `NODE_AUTH_TOKEN`.
10. ⚠ Archive the Tap to Pay app: `gh repo archive robooko/sidon-marina-app --yes`.
11. Smoke test: one real-site booking page per consumer renders, and a staff confirm in `/marina-bookings` updates live.

## Step 7 — Clean up

1. Once Step 6 is verified, ⚠ delete Sidon's 32 `marina-docs/*` blobs. OTA has its archive copies (Step 4). **Never touch `sailor-docs/*`.** From SM, with SM's blob token in the env, never echoed:
   ```bash
   cd /c/Users/robert/source/repos/sidon-marina && node --env-file=.env -e "const {list,del}=require('@vercel/blob');(async()=>{let c,n=0;do{const r=await list({prefix:'marina-docs/',cursor:c});const u=r.blobs.map(b=>b.url).filter(x=>new URL(x).pathname.startsWith('/marina-docs/'));if(u.length){await del(u);n+=u.length}c=r.cursor}while(c);console.log('deleted',n)})()"
   ```
   Expected: `deleted 32`.
2. Two weeks after Switch: ⚠ push and merge D `cutover/cleanup` (Vercel deploys), then ⚠ O `cutover/cleanup` (`git -C O push origin cutover/cleanup`, then `git -C O switch main && git -C O merge --no-edit cutover/cleanup && git -C O push origin main`; Render deploys).
3. After the O cleanup deploy is live: ⚠ the user runs the column-drop migration on both DBs: `node scripts/run-migration.js src/db/migrate-2026-10-12-drop-sidon-columns.sql` (it hits `DATABASE_URL` and `DATABASE_URL_LIVE`).
4. Keep Sidon's DB read-only for 90 days after Switch, then ⚠ delete it (Neon), and remove `SIDON_DATABASE_URL` from O `.env`.
5. The archive copies under `marina-docs-archive/` are purged 90 days after import (⚠ delete with the same `list`/`del` pattern, prefix `marina-docs-archive/`, on OTA's private store).

## Rollback (until step 7)

1. ⚠ Revert the consumer merges (`git revert -m 1 <merge sha>` on each site's `master`, then push) and remove `OTA_API_KEY` from their Production env (kill switch). Redeploy.
2. ⚠ Revert O's `cutover/switch` merge on `main` and push. That restores `GET /api/marina/sidon-bookings` and the old `list_marina_bookings`.
3. ⚠ In the dashboard Settings, set the imported marinas to inactive, so `/marina` falls back to the interim page.
4. ⚠ Lift the freeze: revert SM's `cutover/switch` and `cutover/freeze` merges on `master` and push.
5. Bookings made in OTA in between are re-entered in Sidon by hand (none are expected). A re-import after rollback is refused once OTA holds a guest booking or enquiry on an imported marina (R11). Delete those by hand first, with the user's go-ahead.

## Notes (spec amendments)

- Tier dates: Sidon's tier timestamps are imported as the date the operator typed (`slice(0,10)`), not "the date part in the property timezone". Zones behind +01:00 would otherwise shift a day (plan D R12).
- `property.sidon_marina_id` holds only the first owner of a created property. Re-runs find properties through `marina.sidon_owner_id` first (R9).
- Documents: only in-retention `marina-docs/*` files would be copied, and `sailor-docs/*` are never read (R14, G4). On today's data, that means no document file is copied.
- Re-keyed owners' requirements and templates are imported only when the target marina has none of that kind (R13).
- Pending bookings that lapsed are imported as `cancelled` with `cancel_reason = 'expired'` (R15).
````

- [ ] **Step 2: Check its shape**

Run:
```bash
cd /c/Users/robert/source/repos/OTA && f=docs/superpowers/runbooks/2026-10-marina-cutover.md && grep '^## ' $f && for b in 'SM | `cutover/freeze`' 'PB | `cutover/switch`' 'TT | `cutover/switch`' 'SEA | `cutover/switch`' 'PO | `cutover/switch`' 'MP | `cutover/switch`' 'SM | `cutover/switch`' 'SA | `cutover/switch`' 'O | `cutover/switch`' 'O | `cutover/cleanup`' 'D | `cutover/cleanup`'; do grep -qF "| $b" $f || echo "missing branch: $b"; done; grep -c '⚠' $f; grep -nE 'prop_[0-9a-f]{8}|postgres(ql)?://|org_[A-Za-z0-9]{10,}' $f; echo "leaks-exit=$?"
```

Expected: the twelve headings in this order: `Prerequisites`, `Inputs to collect`, `Branches and when they merge`, `Step 1 — Dark deploy` … `Step 7 — Clean up`, `Rollback (until step 7)` and `Notes (spec amendments)`. No `missing branch:` line, a `⚠` count above 20, and `leaks-exit=1` (no key, DB URL or org id in the file).

- [ ] **Step 3: Commit**

```bash
cd /c/Users/robert/source/repos/OTA && git add docs/superpowers/runbooks/2026-10-marina-cutover.md && git commit -m "Marina cutover runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: one commit with one file on O `main`. Nothing is pushed.
