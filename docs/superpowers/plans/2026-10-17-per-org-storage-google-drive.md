# Per-org storage (Google Drive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marina per-booking documents go to the org's own Google Drive (connected per Clerk org, QuickBooks-style); OTA keeps only the record and has no fallback store.

**Architecture:** A generic `org_integration` table (one row per org per provider, tokens AES-256-GCM encrypted) and one `src/lib/integrations.js` module (provider map, signed state, locked token refresh) behind `/api/integrations/:provider/*`. `src/lib/googleDrive.js` creates folders and uploads via Drive REST v3 with `fetch`. The marina upload route resolves property → org → Drive and refuses with clear errors when anything is missing.

**Tech Stack:** Node/Express, `pg`, Node `crypto`, `fetch`. No new dependencies. Dashboard: ota-table-bookings (Astro + TS).

**Spec:** `docs/superpowers/specs/2026-10-17-per-org-storage-google-drive-design.md`

## Global Constraints

- No code path writes a marina document anywhere OTA owns. No fallback, ever.
- Sailor documents (`sailor_document*`, `sailor-docs/`, `store`) and `putPublic` are untouched.
- Google scope: exactly `https://www.googleapis.com/auth/drive.file`. Auth URL params include `access_type=offline`, `prompt=consent`.
- Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `INTEGRATIONS_ENCRYPTION_KEY` (32 bytes, base64; `openssl rand -base64 32`).
- Tokens never leave the server; status responses never include them.
- OTA never deletes or edits a file in a marina's Drive.
- Error copy (exact `error` strings; `details` wording free):
  - `"This marina can't accept document uploads yet"` — 409, details `"The marina has not connected document storage"` or `"The marina's Google Drive connection needs to be reconnected"`.
  - `"Google Drive upload failed"` — 502.
  - `"Google Drive is not configured on this server"` — 503, details lists the missing env var names.
- Staff warning copy: `"Guests can't upload documents: connect Google Drive in Settings"` (or `"...: reconnect Google Drive in Settings"`).
- Checks follow the repo pattern: `node -r dotenv/config scripts/check-*.js`, local DB only, fakes behind module seams.
- Commits straight to `main`; do not push (pushing deploys to Render).

## Review Focus

1. **Folder deleted in Drive by the marina** → cached folder id 404s on upload. Expect: drop that cached id (and its descendants), recreate, retry once; still failing → 502. Test in Task 4.
2. **Google refresh response without `refresh_token`** (normal for Google) → keep the stored refresh token, don't null it. Test in Task 2.
3. **`invalid_grant` on refresh** (revoked in Google account) → row gets `reconnect_required = true`; upload returns the 409 reconnect copy; status shows it. Test in Tasks 2 and 5.
4. **Property with null `clerk_org_id`** (imported marinas allow it) → same 409 "not connected", not a 500. Test in Task 5.
5. **Callback replay / forged / stale state** → 400 page; state carries provider + timestamp, valid 1 hour. Test in Task 3.

---

### Task 1: Migration A (additive) + schema

**Files:**
- Create: `src/db/migrate-2026-10-17-org-integrations.sql`
- Modify: `src/db/schema.sql` (after `organization`; `marina_document` block ~1446)

**Interfaces:**
- Produces: table `org_integration(clerk_org_id VARCHAR(255) REFERENCES organization(clerk_org_id) ON DELETE CASCADE, provider VARCHAR(30), account_email VARCHAR(255), refresh_token TEXT, access_token TEXT, access_token_expires_at TIMESTAMPTZ, settings JSONB NOT NULL DEFAULT '{}', reconnect_required BOOLEAN NOT NULL DEFAULT false, connected_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (clerk_org_id, provider))`. Token columns hold ciphertext only (comment says so).
- Produces: `marina_document.drive_file_id TEXT`, `marina_document.drive_web_link TEXT`, `blob_pathname` nullable.

- [ ] **Step 1:** Write the migration, idempotent (`IF NOT EXISTS`, `ALTER COLUMN blob_pathname DROP NOT NULL`), header comment pointing at the spec. Mirror into `schema.sql` (schema keeps `blob_pathname`/`file_deleted_at` until Task 6).
- [ ] **Step 2:** `psql "$DATABASE_URL" -f src/db/migrate-2026-10-17-org-integrations.sql` twice locally. Expected: no errors both times.
- [ ] **Step 3:** `node -r dotenv/config scripts/check-marina-http.js` → all `ok` (nothing changed behaviourally).
- [ ] **Step 4:** Commit `Org integrations: migration A (org_integration, marina_document drive columns)`.

### Task 2: `src/lib/integrations.js` — crypto, state, providers, tokens

**Files:**
- Create: `src/lib/integrations.js`
- Test: `scripts/check-integrations.js` (no network; DB for the token test, throwaway org row deleted at end)

**Interfaces:**
- Produces:
  - `encrypt(plain: string) -> string` (`v1:<iv>:<tag>:<ct>` base64 parts), `decrypt(s: string) -> string` (throws on tamper).
  - `signState(orgId, provider) -> string`, `verifyState(state, maxAgeMs = 3600000) -> { orgId, provider } | null`. HMAC-SHA256 keyed on `INTEGRATIONS_ENCRYPTION_KEY`, timing-safe compare; format `${orgId}.${provider}.${ts}.${sig}`.
  - `PROVIDERS.google_drive = { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', revokeUrl: 'https://oauth2.googleapis.com/revoke', scope: 'https://www.googleapis.com/auth/drive.file', env: ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI'], extraAuthParams: { access_type: 'offline', prompt: 'consent' } }`.
  - `missingEnv(provider) -> string[]` (includes `INTEGRATIONS_ENCRYPTION_KEY` when unset).
  - `class IntegrationError extends Error { status, details }`.
  - `tokenRequest(provider, params) -> body` (form POST, client id/secret in body; `invalid_grant` → `IntegrationError(409, 'reconnect')` with `code = 'invalid_grant'`).
  - `getAccessToken(orgId, provider) -> string`: row lock (`FOR UPDATE`, same shape as `quickbooks.getAccessToken`); missing row → `IntegrationError(409, 'not_connected')`; `reconnect_required` → `IntegrationError(409, 'reconnect')`; refresh 60 s before expiry; keep old refresh token when the response omits one; on `invalid_grant` set `reconnect_required = true` (commit that) and rethrow.
  - `getIntegration(orgId, provider) -> row | null` (decrypted tokens never returned — returns `{ account_email, settings, reconnect_required, connected_at }`), `setSettings(orgId, provider, settings)`.
  - Seam: `module.exports.fetch = (...a) => fetch(...a)`; all HTTP goes through `module.exports.fetch`.

- [ ] **Step 1: Write the failing checks** in `scripts/check-integrations.js`:
  - `decrypt(encrypt('tok')) === 'tok'`; two encrypts differ; flipping one ciphertext char → throws.
  - `verifyState(signState('org_a','google_drive'))` deep-equals `{ orgId: 'org_a', provider: 'google_drive' }`; tampered sig → null; `ts` 2 h old → null; garbage/undefined → null.
  - `missingEnv('google_drive')` lists exactly the unset vars.
  - getAccessToken: insert org + integration with expired access token; fake fetch returns `{ access_token: 'new', expires_in: 3600 }` (no refresh_token) → returns `'new'`, stored refresh token still decrypts to the original.
  - fake fetch returns 400 `{ error: 'invalid_grant' }` → throws `code === 'invalid_grant'`, row has `reconnect_required = true`; next call throws `'reconnect'` without calling fetch.
- [ ] **Step 2:** Run `node -r dotenv/config scripts/check-integrations.js` → fails (module missing).
- [ ] **Step 3:** Implement `src/lib/integrations.js` per Interfaces (AES-256-GCM, 12-byte IV).
- [ ] **Step 4:** Run the check → all pass.
- [ ] **Step 5:** Commit `Org integrations: encrypted tokens, signed state, locked refresh`.

### Task 3: `/api/integrations/:provider/*` routes

**Files:**
- Create: `src/controllers/integrations.js`, `src/routes/integrations.js`
- Modify: `src/app.js` (mount `/api/integrations`), `src/docs/swagger.js` (4 paths, tag `Integrations`)
- Test: `scripts/check-integrations.js` (add an HTTP section: app on port 0, `integrations.fetch` faked)

**Interfaces:**
- Consumes: Task 2 exports.
- Produces routes (auth exactly like `src/routes/quickbooks.js`; `:provider` not in `PROVIDERS` → 404 `{ error: 'Unknown integration' }`):
  - `GET /:provider/connect` (authenticateOrg, admin) → `{ url }`; 503 config copy when `missingEnv` non-empty.
  - `GET /:provider/callback` (no auth) → verify state (provider must match path) → exchange code → `GET https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)` for `account_email` → upsert row: tokens encrypted, `settings = '{}'`, `reconnect_required = false`, `connected_at = now()`; ensures an `organization` row exists (`INSERT ... ON CONFLICT DO NOTHING`). Plain-text HTML responses like QuickBooks' (cancelled / invalid link / failed / "Google Drive connected. You can close this tab and return to Settings.").
  - `GET /:provider/status` (authenticateOrg) → `{ configured, connected, account_email, reconnect_required, connected_at }`.
  - `POST /:provider/disconnect` (authenticateOrg, admin) → best-effort revoke (`POST revokeUrl?token=<refresh>`, errors logged only) → delete row → `{ connected: false }`.
- For checks, the bearer middleware is bypassed the same way other HTTP checks do it (follow `check-multi-property-http.js`); if none exists, test the controller functions with fake `req`/`res`.

- [ ] **Step 1: Failing checks:** unknown provider → 404; connect with an env var unset → 503 and `details` names it; callback with forged state → 400; callback with state for `google_drive` on another provider path → 400; valid callback (fake token + about responses) → 200 and a row whose `access_token` column ≠ the plain token and `decrypt` gives it back, `account_email` set; status → `connected: true`, no token fields in JSON; disconnect → row gone, revoke URL was called; disconnect when revoke fetch throws → still 200 and row gone.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement controller + routes + mount + swagger.
- [ ] **Step 4:** Run → pass; `node -r dotenv/config scripts/check-quickbooks.js` still passes.
- [ ] **Step 5:** Commit `Org integrations: connect, callback, status, disconnect routes`.

### Task 4: `src/lib/googleDrive.js` — folders and upload

**Files:**
- Create: `src/lib/googleDrive.js`
- Test: `scripts/check-integrations.js` (Drive section, fake fetch)

**Interfaces:**
- Consumes: `getAccessToken`, `getIntegration`, `setSettings`, `module.exports.fetch` from Task 2.
- Produces: `uploadMarinaDocument(orgId, { path: string[], fileName, contentType, buf }) -> { id, webViewLink }`.
  - `path` is folder names under the root, e.g. `['OTA', propertyName, marinaName, '2026-11-02 Ann Smith (1a2b3c4d)']`.
  - Folder ids cached in `settings.folders` keyed by the joined path prefix (`'OTA'`, `'OTA/Prop'`, ...). Missing → create (`POST https://www.googleapis.com/drive/v3/files?fields=id` with `{ name, mimeType: 'application/vnd.google-apps.folder', parents }`), cache, persist with `setSettings`.
  - Upload: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`, `multipart/related` body (JSON metadata `{ name, parents: [folderId] }` + file part).
  - Upload or folder create 404 on a cached parent → remove that cache key and every key under it, rebuild, retry once.
  - Folder names: strip `/` and control chars, trim, max 100 chars.
  - Any other non-2xx → `IntegrationError(502, 'Google Drive upload failed', details)`.

- [ ] **Step 1: Failing checks:** first upload creates 4 folders then uploads (assert call order and `parents` chain) and returns `{ id, webViewLink }`; second upload to the same path creates 0 folders; second upload to a sibling booking folder creates 1; cached booking folder returns 404 once → recreated and upload succeeds; upload 500 → throws status 502; name `'A/B\n'` becomes `'AB'`.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `Google Drive: folder cache and multipart upload`.

### Task 5: Marina documents go to Drive; OTA store removed from the marina path

**Files:**
- Modify: `src/lib/marinaDocuments.js` (remove `docPath`; `retentionOnce` keeps nothing for marina docs or `marina-docs-archive/` — delete the function and `startMarinaRetentionJob` if nothing else remains, and its caller; `extractDocument(docId, buf)` takes the buffer)
- Modify: `src/controllers/marinaDocuments.js` (`uploadDocument`, list/verification SELECTs, delete `streamDocumentFile`)
- Modify: `src/routes/marina.js` (remove `GET /documents/:id/file`)
- Modify: `src/controllers/marinaBookings.js:74` (`file_deleted_at` → `drive_web_link`)
- Modify: `src/controllers/marinaGuest.js` (`requirementsStatus` and `getGuestBooking` add `document_uploads`)
- Modify: `src/server.js:12,27` (drop `startMarinaRetentionJob` if removed)
- Create: `src/lib/marinaStorage.js`
- Modify: `src/docs/swagger.js` (drop file route; document new fields)
- Test: `scripts/check-marina-http.js`

**Interfaces:**
- Consumes: `uploadMarinaDocument` (Task 4), `getIntegration`, `missingEnv`, `IntegrationError` (Task 2).
- Produces: `marinaStorage.status(propertyId) -> { ok: true, orgId } | { ok: false, reason: 'not_configured' | 'not_connected' | 'reconnect' }` (null `clerk_org_id` → `not_connected`).
- Upload flow: existing checks (status, sniff, requirement, max 10) → `status()`; not ok → 409/503 with the Global Constraints copy → `uploadMarinaDocument` (`IntegrationError` 409 `reconnect` → 409 reconnect copy; 502 → 502) → INSERT row with `drive_file_id`, `drive_web_link`, `blob_pathname` NULL → `extractDocument(d.id, buf)` (not awaited) → republish → 201. Folder path: `['OTA', property.name, marina.name, `${arrival} ${contact_name} (${id.slice(0, 8)})`]`.
- Staff JSON (`listBookingDocuments`, `getBookingVerification`, `marinaBookings` list) include `drive_web_link`, drop `file_deleted_at`. `getBookingVerification` adds `document_uploads: { ok, reason }` and `warning: string | null` (staff copy when unmet mandatory requirements and not ok).
- Guest JSON adds `document_uploads: boolean`. `drive_web_link`/`drive_file_id` never reach the guest rail.

- [ ] **Step 1: Update `check-marina-http.js`:** replace the `docs.store` fake's use for marina docs with a fake `googleDrive.uploadMarinaDocument` (records calls, returns `{ id: 'f'+n, webViewLink: 'https://drive/f'+n }`) and a stub org + `org_integration` row for the throwaway property (property gets a `clerk_org_id`). New/changed checks:
  - upload with Drive connected → 201; row has `drive_file_id`, `blob_pathname` NULL; fake got path `['OTA', 'Marina HTTP Check', 'Porto HTTP', <starts with arrival>]`; extraction stub called with the buffer.
  - no `org_integration` row → 409, `error === "This marina can't accept document uploads yet"`, no row inserted, fake not called.
  - property `clerk_org_id` NULL → same 409.
  - `reconnect_required = true` → 409 with reconnect details.
  - fake throws `IntegrationError(502, ...)` → 502, no row.
  - `GOOGLE_CLIENT_ID` unset → 503 naming it.
  - staff list includes `drive_web_link`; `GET /api/marina/documents/:id/file` → 404.
  - verification with an unmet mandatory requirement and no Drive → `warning === "Guests can't upload documents: connect Google Drive in Settings"`.
  - guest booking view + requirements-status → `document_uploads` true/false; R20 check asserts no `drive_` key in guest JSON.
  - delete the retention check; auto-confirm fixture INSERT uses `drive_file_id` instead of `blob_pathname`.
- [ ] **Step 2:** Run `node -r dotenv/config scripts/check-marina-http.js` → new checks fail.
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** Run `check-marina-http.js`, `check-marina.js`, `check-sailor-documents-http.js`, `check-sailor-documents.js`, `check-integrations.js` → all pass. `grep -rn "marina-docs\|docPath\|streamDocumentFile" src` → no hits.
- [ ] **Step 5:** Commit `Marina documents: upload to the org's Google Drive, no OTA store`.

### Task 6: Purge script + migration B

**Files:**
- Create: `scripts/purge-marina-document-files.js`
- Create: `src/db/migrate-2026-10-17-marina-document-drop-blob.sql`
- Modify: `src/db/schema.sql` (drop `blob_pathname`, `file_deleted_at` from `marina_document`)

**Interfaces:**
- Script: default dry run prints `{ rows, row_files, archive_objects }` (rows in `marina_document`; rows with a non-null `blob_pathname` and null `file_deleted_at`; objects under `marina-docs-archive/`, all pages via `cursor`). `--commit`: `store.del` the row files and every `marina-docs-archive/` object, then `DELETE FROM marina_document` in one transaction, then print the same counts (all 0). Refuses `--commit` without `BLOB_READ_WRITE_TOKEN`. Never touches `sailor-docs/` (assert every deleted path starts with `marina-docs`).
- Migration B: `ALTER TABLE marina_document DROP COLUMN IF EXISTS blob_pathname, DROP COLUMN IF EXISTS file_deleted_at;`. Header comment: run only after the Task 5 code serves on live, the purge has committed, AND OTA `cutover/cleanup` (which deletes the retired Sidon importer that still writes `blob_pathname`) is merged.

- [ ] **Step 1:** Write the script; local dry run (`node -r dotenv/config scripts/purge-marina-document-files.js`) prints counts and changes nothing (re-count matches).
- [ ] **Step 2:** `BLOB_READ_WRITE_TOKEN= node -r dotenv/config scripts/purge-marina-document-files.js --commit` → refuses with a message naming `BLOB_READ_WRITE_TOKEN`, exit code ≠ 0, row count unchanged.
- [ ] **Step 3:** Write migration B + schema change. Do NOT run it locally until `cutover/cleanup` is on main (it breaks `check-import-sidon.js`).
- [ ] **Step 4:** Commit `Marina documents: purge script and column-drop migration (B)`.

### Task 7: Dashboard (ota-table-bookings)

**Files:**
- Modify: `src/pages/settings.astro` (new tab `google-drive` next to `quickbooks`, same card markup: status line, Connect, Disconnect)
- Modify: `src/scripts/settings-client.ts` (mirror the `qbo*` block against `/api/integrations/google_drive/*`; status text: `Connected as <email> since <date>.` / `Not connected.` / `Reconnect needed — Google access was revoked.` / `Not available — this deployment has no Google Drive app configured.`)
- Modify: `src/scripts/marina-booking-detail.ts`, `src/scripts/marina-booking-dialog.ts` (document open = `window.open(d.drive_web_link, '_blank', 'noopener')`; remove the `/file` blob fetch + retention text; render `v.warning` as a warning row above requirements when non-null)

**Interfaces:**
- Consumes: Task 3 routes; Task 5 JSON (`drive_web_link`, `warning`, `document_uploads`).

- [ ] **Step 1:** Implement settings tab + client.
- [ ] **Step 2:** Implement document link + warning.
- [ ] **Step 3:** `npm run build` (or the repo's `astro check`) → no type errors.
- [ ] **Step 4:** Manual smoke against local OTA (PORT=3100 if 3000 is taken): Settings tab shows "Not available" with env unset, and "Not connected." with env set; a booking with a mandatory requirement shows the warning.
- [ ] **Step 5:** Commit in ota-table-bookings `Settings: Google Drive connection; marina documents open in Drive`.

### Task 8: Rollout (user-gated; nothing here without an explicit OK)

- [ ] **R1 (user):** Google Cloud project → enable Drive API → OAuth consent screen (External, scope `drive.file`) → Web client with redirect `https://ota-u6ii.onrender.com/api/integrations/google_drive/callback` (plus `http://localhost:3000/...` for dev).
- [ ] **R2 (user):** Render env `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `INTEGRATIONS_ENCRYPTION_KEY`.
- [ ] **R3:** Migration A on live (additive, safe under old code).
- [ ] **R4:** Push OTA main (Render deploys). Smoke: `/api/integrations/google_drive/status` 200; guest upload on a marina with no Drive → 409 copy.
- [ ] **R5:** Purge dry run on live → show counts to the user → `--commit` only on their OK.
- [ ] **R6:** Push dashboard (Vercel). Connect a real Drive on a test org; upload a test document; confirm the file + folders in Drive and the staff link opens.
- [ ] **R7 (later, ~2026-10-31):** after `cutover/cleanup` is merged and pushed, run migration B on live.
- [ ] **Follow-up (other repos):** widget/booking sites hide upload UI when `document_uploads === false`.
