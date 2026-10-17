# Marina cutover runbook (Sidon Marina → OTA), October 2026

Spec: `docs/superpowers/specs/2026-10-10-ota-marina-unification-design.md`, section "Cutover" (amended in `5ac187f`). Plans: `docs/superpowers/plans/2026-10-11-marina-module-b-widget-1.0.md`, `2026-10-12-marina-module-c-dashboard.md` and `2026-10-12-marina-module-d-import-cutover.md`.

**Every step marked ⚠ needs the user's go-ahead at the time it runs.** That covers every push, merge, deploy, npm publish, Vercel or Render env change, live migration, `gh repo create`, `gh repo archive`, tag push, reset of sidon-marina's local `master`, and blob deletion. Approval for one ⚠ step doesn't carry to the next. Pushing OTA `main` deploys production on Render, and pushing a site's `master`/`main` deploys it on Vercel.

Repos (Git Bash paths): `O` = `/c/Users/robert/source/repos/OTA`, `W` = `…/sidon-booking-widget`, `D` = `…/ota-table-bookings`, `PB` = `…/pirates-bight`, `TT` = `…/tested-trappist`, `SEA` = `…/sea-company`, `PO` = `…/portals`, `MP` = `…/marina-di-positano`, `SM` = `…/sidon-marina`, `SA` = `…/sidon-ai`, `APP` = `…/sidon-marina-app`.

Never paste a key, token, DB URL, email address or Sidon owner id into a log, commit, PR or chat. The importer prints aliases (`o_xxxxxx`), slugs and counts only.

## Prerequisites

1. Plans B and C are complete and live: OTA `main` (Render) and D `main` (Vercel) were pushed on 2026-10-14, and D serves plan C's `/marina` dashboard.
2. Done 2026-10-14: `@forgebuild/sidon-booking-widget@1.1.0` is on npm (`latest`) and tagged `v1.1.0` in W. Check: `npm view @forgebuild/sidon-booking-widget version` prints `1.1.0`.
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

Lockfiles (G6): 1.1.0 was already on npm when plan D ran, so PB, TT, PO and MP's `cutover/switch` commits already carry the lockfile resolving `@forgebuild/sidon-booking-widget` 1.1.0 from npm. SEA's branch does the same when plan D Task 7 runs. No separate lockfile step remains.

Env timing: every site inlines `import.meta.env` at build time, so **redeploy after every Vercel env change** (TT's `astro:env` secrets are read at runtime, but redeploy anyway).

## Step 1 — Dark deploy

Nothing user-visible changes.

1. ⚠ Push O `main` (plan D's importer, seed option and this runbook; plan C's OTA changes are already live): `git -C O push origin main`. Render deploys. Check that `GET /api/marina/marinas` (bearer) answers 200.
2. D `main` (plan C dashboard) is already live. `/marina` shows the interim page for every property until a property has an active OTA marina.
3. ⚠ Set `OTA_BASE_URL` (the OTA origin) in Vercel **Preview only** for PB, TT, SEA and MP, and `OTA_API_KEY` (that property's key from the dashboard org modal) where the site doesn't have it yet. **PB and TT already use `OTA_API_KEY` for their PMS pages (rooms, dining, reservations): confirm it is that marina's property key and never remove it.** `OTA_BASE_URL` is the kill switch on every site. Production stays without `OTA_BASE_URL` until Step 6, so the kill switch keeps Production unchanged even if a branch were merged early.
   For MP and PO, which have no remote yet, ⚠ create the private repo from `master`, then push the branch, so `master` stays the default branch and nothing switch-related is on it:
   ```bash
   cd /c/Users/robert/source/repos/marina-di-positano && git switch master && gh repo create robooko/marina-di-positano --private --source . --push && git push origin cutover/switch
   cd /c/Users/robert/source/repos/portals && git switch master && gh repo create robooko/portals --private --source . --push && git push origin cutover/switch
   ```
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
3. ⚠ End-to-end on Pirates Bight's Preview. This writes to live OTA (a guest booking, Stripe calls on the property's keys, Resend email), so run it only after the final live import (Step 4.4):
   - ⚠ First set Pirates Bight's `booking_url` (Settings → Marina) to `<PB preview origin>/booking?booking={id}&token={token}`. OTA only emails a booking link when `booking_url` is set.
   - hold → card → pending → booking page (from the email link) → upload → verify in `/marina-bookings` → contract → confirm → capture. If the property's Stripe keys are live, use a real card and refund it afterwards in `/marina-bookings` (cancel & refund).
   - then a guest cancel, a hold left to expire (sweep), and the closed-tab case (close the tab after the card step, reopen the booking link, and payment resumes).
   - Afterwards: cancel every test booking. They are guest bookings on an imported marina, so the importer now refuses any re-import (R11); a re-import would need them deleted by hand first (⚠). Step 6.5 replaces the Preview `booking_url` with the production one.
4. The dashboard `/marina` for each created property's org shows tiles and the staff map, and the nav shows Marina.

## Step 6 — Switch

In this order, each ⚠:

1. Check that each consumer `cutover/switch` carries its 1.1.0 lockfile (see Branches).
2. Fill in SM `cutover/switch`'s `MARINA_SITES` values with the production origins (one commit on that branch, `node scripts/check-cutover.ts && npm run build`).
3. Set `OTA_BASE_URL` in Vercel **Production** for PB, TT, SEA and MP, and `OTA_API_KEY` where the site doesn't have it yet (PB and TT already do, for their PMS pages: confirm, never remove).
4. Merge the consumer PRs: PB, TT, SEA and MP (`gh pr merge --merge`). Vercel deploys each. Merge PO's too, but don't deploy it (it has no Vercel project).
5. Set each marina's `booking_url` in the dashboard (Settings → Marina):

   | site | `booking_url` |
   |---|---|
   | PB | `https://pirates-bight.vercel.app/booking?booking={id}&token={token}` |
   | TT | `https://tested-trappist-three.vercel.app/booking?booking={id}&token={token}` |
   | SEA (Fox) | `https://sea-company.vercel.app/booking/fox-mooring?booking={id}&token={token}` (SEA master 7c05149 uses path pages) |
   | SEA (Pevero) | `https://sea-company.vercel.app/booking/pevero-mooring?booking={id}&token={token}` |
   | MP | `https://marina-di-positano.vercel.app/booking?booking={id}&token={token}` |
   | PO | `https://portals-lemon-psi.vercel.app/booking?booking={id}&token={token}` |

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
5. The archive under `marina-docs-archive/` (the 32 document copies and the `sidon-messages/` export, which holds sailor names, emails and message bodies) is purged automatically 90 days after import by OTA's daily retention job. Nothing to do; check it is gone after 90 days.

## Rollback (until step 7)

In this order, so nothing reverted calls a Sidon that still refuses it:

1. ⚠ Lift the freeze first: revert SM's `cutover/switch` and `cutover/freeze` merges on `master` and push. Vercel deploys; check `/api/marina/*` writes work again and `/m/<slug>` renders.
2. ⚠ Restore the old site env vars removed at Step 6.9 (PB `SIDON_URL`, `SIDON_API_KEY`; TT `SIDON_URL`, `SIDON_APIKEY`, `PUBLIC_SIDON_MARINA_ID`, `PUBLIC_SIDON_ORIGIN`; SEA `SIDON_URL`, `PUBLIC_SIDON_ORIGIN`, `NODE_AUTH_TOKEN`; MP `SIDON_URL`, `PUBLIC_SIDON_ORIGIN`, `NODE_AUTH_TOKEN`) and sidon-ai's five removed at Step 6.8.
3. ⚠ Revert the consumer merges (`git revert -m 1 <merge sha>` on each site's `master`, then push) and remove `OTA_BASE_URL` from their Production env (the kill switch; never remove PB's or TT's `OTA_API_KEY`, which their PMS pages need). Redeploy each.
4. ⚠ Revert sidon-ai's merge on its `master` and push (Vercel deploys).
5. ⚠ Revert O's `cutover/switch` merge on `main` and push. That restores `GET /api/marina/sidon-bookings` and the old `list_marina_bookings`.
6. ⚠ In the dashboard Settings, set the imported marinas to inactive, so `/marina` falls back to the interim page.
7. Bookings made in OTA in between are re-entered in Sidon by hand (none are expected). A re-import after rollback is refused once OTA holds a guest booking, an enquiry, or any change to an imported booking, document or contract on an imported marina (R11). Delete those by hand first, with the user's go-ahead.

## Notes (spec amendments)

- Tier dates: Sidon's tier timestamps are imported as the date the operator typed (`slice(0,10)`), not "the date part in the property timezone". Zones behind +01:00 would otherwise shift a day (plan D R12).
- `property.sidon_marina_id` holds only the first owner of a created property. Re-runs find properties through `marina.sidon_owner_id` first (R9).
- Documents: only in-retention `marina-docs/*` files would be copied, and `sailor-docs/*` are never read (R14, G4). On today's data, that means no document file is copied.
- Re-keyed owners' requirements and templates are imported only when the target marina has none of that kind (R13).
- Pending bookings that lapsed are imported as `cancelled` with `cancel_reason = 'expired'` (R15).
