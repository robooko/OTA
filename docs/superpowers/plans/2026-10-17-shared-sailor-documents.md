# Shared Sailor Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One OTA-held document set per sailor (keyed by Clerk-verified email), per-marina approvals against versions, and booking sites that enforce required documents with a Clerk token instead of uploading per booking.

**Architecture:** New `sailor_document` / `_version` / `_approval` tables beside the legacy `marina_document`. A `X-Sailor-Token` header (Clerk session token) resolves to a verified email via a stubbable `sailorAuth.resolveSailor`. One shared lib (`src/lib/sailorDocuments.js`) answers "which requirements does this email meet for this marina and stay" and is used by the guest status route, guest booking create, the staff panel and auto-confirm. Legacy per-booking documents keep working (dual read) until the final removal task.

**Tech Stack:** Express, pg, `@clerk/backend` (already installed), Vercel Blob private store via the existing `docs.store`, Anthropic SDK via the existing extraction prompt.

**Spec:** `docs/superpowers/specs/2026-10-17-shared-sailor-documents-design.md`

## Global Constraints

- Document types: exactly `insurance`, `acord25`, `registration`, `uscg_cod`, `passport`, `safety`.
- Expiry required to count as met for `insurance`, `acord25`, `passport`; optional for the rest (null = does not expire).
- "Met" = non-deleted document of the requirement's type, expiry null-allowed per above, and `expiry_date >= departure` (`>= arrival` when departure is null). Several candidates → newest (`created_at`) wins.
- Extraction is advisory: it never writes `expiry_date`, never drives met/unmet or status.
- Sailor identity = Clerk **primary, verified** email, lower-cased. Never an email from a request body.
- Staff see a sailor's documents iff a `marina_booking` at that marina has `email_verified = true` and `lower(contact_email)` = the sailor's email. No time limit.
- Other marinas see only `approval_count` (distinct marinas with an `approved` verdict on any version) — never marina names or notes.
- Files: private store only, path `sailor-docs/<sha256(email)>/<uuid>.<ext>`, PDF/JPEG/PNG sniffed, 4 MB. Caps (my call): 50 documents per sailor, 10 versions per document.
- No new npm dependencies.
- Tests follow the repo pattern: `node -r dotenv/config scripts/check-*.js`, local DB only, `ok`/`FAIL` lines, fixtures under a throwaway property deleted at the end.

## Review Focus

1. A Clerk user whose primary email is **unverified** → treated as no sailor (401), never as that email. (Task 2 test.)
2. Sailor token for A requesting B's version file or deleting B's document → 404, not 403 (don't confirm existence). (Task 3 test.)
3. Staff at marina X fetching a version file of a sailor who only booked at marina Y → 404. (Task 5 test.)
4. Document deleted between "requirements met" on the site and POST booking → booking 409 with that requirement in `missing`. (Task 4 test.)
5. Document whose expiry falls between arrival and departure → unmet for that stay. (Task 1 test.)

---

### Task 1: Schema + requirement-status lib

**Files:**
- Create: `src/db/migrate-2026-10-17-sailor-documents.sql`
- Modify: `src/db/schema.sql` (append the same DDL after the marina module block, ~line 1462)
- Create: `src/lib/sailorDocuments.js`
- Create: `src/lib/sailorDocTypes.js` (types, labels, extraction field lists — copy `TYPE_SCHEMAS` from `sidon-ai/src/pages/api/sailor/documents/upload.ts:9-83`, plus `EXPIRY_REQUIRED = ['insurance','acord25','passport']`)
- Test: `scripts/check-sailor-documents.js`

DDL (exact):
- `sailor_document (id uuid pk, email varchar(255) not null, type varchar(30) not null check (type in (...6 types)), extracted_data jsonb, expiry_date date, created_at timestamptz default now(), deleted_at timestamptz)`, index `(email) where deleted_at is null`.
- `sailor_document_version (id uuid pk, document_id uuid not null references sailor_document on delete cascade, blob_pathname text not null, file_name varchar(255), content_type varchar(50) not null, size_bytes int not null, extracted_data jsonb, uploaded_at timestamptz default now(), file_deleted_at timestamptz)`, index `(document_id)`.
- `sailor_document_approval (id uuid pk, version_id uuid not null references sailor_document_version on delete cascade, marina_id uuid not null references marina on delete cascade, property_id uuid not null references property, status varchar(20) not null check (status in ('approved','rejected')), notes text, staff_user varchar(255), decided_at timestamptz default now(), unique (version_id, marina_id))`.
- `ALTER TABLE marina_booking ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;`
- `marina_doc_requirement.type`: no constraint added (legacy rows); validation lives in Task 6.

**Interfaces — Produces** (`src/lib/sailorDocuments.js`):
- `requirementStatus(db, { marinaId, email, arrival, departure }) -> Promise<Array<{ requirement: {id,type,name,mandatory}, document: {id,type,expiry_date,approval_count,versions:[{id,file_name,uploaded_at}]} | null }>>` — active requirements in `sort_order, name` order; `approval_count` excludes `marinaId`'s own verdicts.
- `missingMandatory(statuses) -> Array<{id,type,name}>`
- `canStaffSee(db, { marinaIds: string[], email }) -> Promise<boolean>`
- `normalEmail(s) -> string` (trim + lower-case)

- [ ] **Step 1: Write failing checks** in `scripts/check-sailor-documents.js` (DB-level, pattern of `scripts/check-marina.js`): fixture property, marina, requirements `insurance` (mandatory), `registration` (optional).
  - `unmet when no document` → both `document: null`; `missingMandatory` = `[insurance]`.
  - `insurance with null expiry is unmet; registration with null expiry is met`.
  - `expiry before departure is unmet; on departure is met` (expiry = departure − 1 → null doc; = departure → doc).
  - `open-ended stay checks expiry against arrival`.
  - `deleted document is unmet`.
  - `newest of two current documents wins`.
  - `approval_count counts other marinas only, approved only` (approvals: marina X approved, marina Y rejected, own marina approved → count 1 when asked as own marina).
  - `canStaffSee true only for a verified booking at one of the marinas` (unverified booking → false; verified at other marina → false; email case differs → true).
- [ ] **Step 2: Run** `node -r dotenv/config scripts/check-sailor-documents.js` → FAIL (module/tables missing).
- [ ] **Step 3: Apply migration** to local DB (`psql $DATABASE_URL -f src/db/migrate-2026-10-17-sailor-documents.sql`) and append DDL to `schema.sql`.
- [ ] **Step 4: Implement** `sailorDocTypes.js` and `sailorDocuments.js` — one SQL query per function; newest-wins via `DISTINCT ON (type) ... ORDER BY type, created_at DESC`.
- [ ] **Step 5: Run** the check → all `ok`.
- [ ] **Step 6: Commit** `Sailor documents: schema and requirement status`.

### Task 2: Sailor auth

**Files:**
- Create: `src/middleware/sailorAuth.js`
- Test: `scripts/check-sailor-documents.js` (add section)

**Interfaces — Produces:**
- `resolveSailor(token) -> Promise<{ email } | null>` — tries each key in `SAILOR_CLERK_SECRET_KEYS` (comma list) with `verifyToken`; on success `createClerkClient({secretKey}).users.getUser(sub)`, takes the address whose id = `primaryEmailAddressId`, returns it only if `verification.status === 'verified'`; `normalEmail` applied. Exported on `module.exports` so checks stub it.
- `authenticateSailor(req,res,next)` — reads `X-Sailor-Token`; missing/null result → `401 { error: 'Sign in required' }`; sets `req.sailor = { email }`.
- `optionalSailor(req,res,next)` — same but no 401 when header absent (invalid token still 401).

- [ ] **Step 1: Failing checks** (drive middleware with a fake req/res, stub `verifyToken`/clerk client by injecting through `module.exports._clerk = { verifyToken, getUser }` seam): `no header → 401`, `unverified primary email → 401`, `verified primary → req.sailor.email lower-cased`, `secondary verified but primary unverified → 401`, `optionalSailor passes through with no header`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Add `SAILOR_CLERK_SECRET_KEYS=` to `.env.example` with a one-line comment.
- [ ] **Step 4: Run** → `ok`.
- [ ] **Step 5: Commit** `Sailor documents: Clerk-token sailor auth`.

### Task 3: Sailor document API (`/api/sailor/documents`)

**Files:**
- Create: `src/controllers/sailorDocuments.js`, `src/routes/sailorDocuments.js`
- Modify: `src/app.js` (mount at `/api/sailor/documents`, `express.json` for it; raw parsing per route like `rawDocSafe` in `src/routes/marina.js:14-15`), `src/lib/marinaDocuments.js` (add `extractSailorVersion(versionId)` reusing the existing prompt with fields from `sailorDocTypes`; writes `version.extracted_data` and copies to `document.extracted_data`; never `expiry_date`), `src/docs/swagger.js`
- Test: `scripts/check-sailor-documents-http.js` (new; harness copied from `scripts/check-marina-http.js:1-50`, stubbing `sailorAuth.resolveSailor = async (t) => t.startsWith('sailor:') ? { email: t.slice(7) } : null` and `docs.extractSailorVersion = async () => {}`)

All routes: `authenticateSailor`, no API key. Rate limit uploads with `guestLimiter('sailor-upload', 30)`.

| Route | Behaviour |
|---|---|
| `GET /` | own non-deleted documents, newest first: `{id,type,expiry_date,extracted_data,approval_count,created_at,versions:[{id,file_name,content_type,size_bytes,uploaded_at}]}` (`approval_count` across all marinas) |
| `POST /?type=&document_id=&expiry_date=` raw body, `X-File-Name` | with `document_id` (own, not deleted): adds a version (409 at 10). Without: new document of `type` (400 unknown type; 409 at 50). `expiry_date` optional `YYYY-MM-DD`. Stores blob, inserts, awaits `extractSailorVersion` (errors swallowed), returns 201 document as in `GET /` |
| `PUT /:id` `{ expiry_date }` | own doc; `null` clears; 400 bad date |
| `DELETE /:id` | own doc: `docs.store.del` all version blobs, set `file_deleted_at` on versions, `deleted_at` on doc; 204 |
| `GET /versions/:id/file` | own version; streams like `streamDocumentFile` (`src/controllers/marinaDocuments.js:96-107`); 410 when file deleted |

Not own / unknown / bad uuid → 404 everywhere.

- [ ] **Step 1: Failing HTTP checks:** `no token → 401`; `upload creates a document with one version`; `upload with document_id adds a version`; `unknown type → 400`; `non-PDF bytes → 400`; `PUT sets and clears expiry`; `B cannot read, version, PUT or DELETE A's document → 404` (Review Focus 2); `delete removes blobs and hides the document`; `deleted file → 410`; `11th version → 409`.
- [ ] **Step 2: Run** `node -r dotenv/config scripts/check-sailor-documents-http.js` → FAIL.
- [ ] **Step 3: Implement** controller, routes, mount, extraction helper, swagger entries.
- [ ] **Step 4: Run** → `ok`; also run `scripts/check-marina-http.js` → still `ok`.
- [ ] **Step 5: Commit** `Sailor documents: sailor API (list, upload, version, expiry, delete, file)`.

### Task 4: Guest rail — requirement status + enforced booking create

**Files:**
- Modify: `src/routes/marina.js`, `src/controllers/marinaGuest.js` (`createGuestBooking` ~line 141), `src/docs/swagger.js`
- Test: `scripts/check-sailor-documents-http.js`

**Interfaces — Consumes:** `requirementStatus`, `missingMandatory`, `optionalSailor`.

- `GET /api/marina/guest/:marina/requirements-status?arrival=&departure=` — `authenticateOrApiKey, resolveMarina, optionalSailor`. No active requirements → `{ sign_in_required: false, requirements: [] }`. Requirements and no sailor → `{ sign_in_required: true, requirements: [{id,type,name,mandatory,met:false}] }`. With sailor → `met` + `document` per requirement (`document` fields as `requirementStatus`).
- `POST ${G}/bookings` gains `optionalSailor`. Inside `createGuestBooking`, before the berth insert: if the marina has active requirements → no sailor = 401 `{ error: 'Sign in required' }`; `missingMandatory` non-empty = 409 `{ error: 'Required documents missing', missing: [...] }`. When a sailor is present (requirements or not): `contact_email` is replaced by `req.sailor.email` and `email_verified = true` on the insert. No sailor and no requirements: unchanged behaviour, `email_verified = false`.

- [ ] **Step 1: Failing checks:** `status without requirements says no sign-in`; `status with requirements and no token says sign-in required`; `status reports met/unmet per requirement for the sailor`; `create without token at a marina with requirements → 401`; `create with mandatory unmet → 409 listing it`; `create when met → 201, contact_email = token email, email_verified true` (send a different `contact_email` in body, assert it's ignored); `document deleted after status check → create 409` (Review Focus 4); `marina without requirements books as before`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this check and `scripts/check-marina-http.js` → `ok` (existing guest tests use a marina without active requirements; if any fixture adds requirements before creating a booking, give it a sailor token).
- [ ] **Step 5: Commit** `Marina guest rail: Clerk-token requirement status and enforced booking create`.

### Task 5: Staff — panel, file access, approvals, auto-confirm

**Files:**
- Modify: `src/controllers/marinaDocuments.js` (`getBookingVerification`), `src/routes/marina.js`, `src/lib/marinaLifecycle.js` (`maybeAutoConfirm` ~line 308), `src/docs/swagger.js`
- Create (in `src/controllers/marinaDocuments.js`): `streamSailorVersion`, `decideSailorVersion`
- Test: `scripts/check-sailor-documents-http.js` (bearer controllers driven directly with the `call()` helper from `scripts/check-marina-http.js:476-482`)

**Interfaces — Consumes:** `requirementStatus`, `canStaffSee`.

- `getBookingVerification` response gains `sailor: null | { email, requirements: [{ requirement_id, document: {...requirementStatus document, versions:[{id,file_name,uploaded_at, my_verdict: {status,notes,decided_at}|null}]} | null }] }` — non-null only when `b.email_verified`. Existing `requirements`/`documents` (legacy) unchanged.
- `GET /api/marina/sailor-versions/:id/file` (`authenticate`) — 404 unless `canStaffSee({ marinaIds: marinas of req.property_id, email })`; streams as Task 3.
- `PUT /api/marina/bookings/:id/sailor-versions/:versionId` (`authenticate`) `{ status: 'approved'|'rejected', notes?, expiry_date? }` — booking must belong to `req.property_id`, be `email_verified`, and the version's document's email must equal the booking's; upserts `(version_id, marina_id)` with `staff_user = req.user.id`; `expiry_date` (if present) updates the document; then `life.republish(booking.id)` and, on `approved`, `life.maybeAutoConfirm(booking.id)`.
- `maybeAutoConfirm`: a mandatory requirement is satisfied by a legacy verified `marina_document` (existing clause) **or**, when `email_verified`, by `requirementStatus`'s document having an `approved` verdict from this marina on any of its versions. Contract and payment checks unchanged.

- [ ] **Step 1: Failing checks:** `panel has sailor block only for verified bookings`; `staff approve records verdict on the version and shows as my_verdict`; `re-deciding overwrites the same row`; `approval of another email's version → 404`; `staff at a property without a verified booking for that email get 404 on the file` (Review Focus 3); `staff can correct expiry while approving`; `auto-confirm fires once every mandatory requirement has this marina's approval` (auto_confirm on, no PI); `another marina's approval does not satisfy auto-confirm`; `legacy verified marina_document still satisfies auto-confirm`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both HTTP checks → `ok`.
- [ ] **Step 5: Commit** `Marina staff: sailor document panel, approvals and auto-confirm`.

### Task 6: Requirement types + MCP tools

**Files:**
- Modify: the marina requirement create/update handlers (`grep -rn "marina_doc_requirement" src/controllers src/mcp* src/lib/mcp*` to locate; MCP tools added in commit `b099ca9`)
- Test: `scripts/check-sailor-documents-http.js`

- Requirement create/update rejects a `type` not in `sailorDocTypes` with 400 `type must be one of insurance, acord25, registration, uscg_cod, passport, safety`. MCP tool schema uses the same enum.
- Report (don't change) live requirement rows with other types: add `scripts/report-requirement-types.js` printing `marina, type, name` for non-conforming active rows, so Robert can fix them before switch-on.

- [ ] **Step 1: Failing check:** `requirement with unknown type → 400`; `known type → 201`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → `ok`.
- [ ] **Step 5: Commit** `Marina requirements: shared document type vocabulary`.

### Task 7: Import sidon-ai wallet into OTA

**Files:**
- Create: `scripts/import-sidon-wallet.js` (pattern: `scripts/import-sidon-marina.js` — dry run by default, `--commit` to write)
- Test: `scripts/check-import-sidon-wallet.js` (fake Clerk + fake fetch + in-memory store, like `scripts/check-import-sidon.js`)

Env: `SIDON_POSTGRES_URL`, `SIDON_CLERK_SECRET_KEY`. For each `sailor_document` row in sidon-ai:
- `sailor_id` null → skip, count as `guest_skipped` (deleted on the sidon-ai side, Task 8).
- Clerk user's primary verified email (same rule as `resolveSailor`); none → skip `unverified`.
- Unknown `type` → skip `bad_type`.
- Fetch `file_url` (public), sniff type, put to private store at the sailor path, insert document + one version with `extracted_data` (parse the JSON string) and `expiry_date` from the row (sidon-ai's expiry was extraction-derived; import it as-is — *my call*, the sailor can correct it; flag in the summary count `expiry_imported`).
- Idempotent: record `source_ref = 'sidon:' || id` — add nullable `source_ref varchar(50) unique` to `sailor_document` in this task's migration step, skip rows already imported.
- Prints per-reason counts; writes `sidon-wallet-import.json` mapping sidon id → OTA document id (Task 8 deletes blobs only for mapped rows).

- [ ] **Step 1: Failing check:** `imports a verified user's document with one version`; `skips guest rows, unverified emails, bad types`; `second run imports nothing new`; `dry run writes nothing`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (+ `ALTER TABLE sailor_document ADD COLUMN IF NOT EXISTS source_ref varchar(50) UNIQUE` in a migration file and `schema.sql`). **Step 4: Run** → `ok`.
- [ ] **Step 5: Commit** `Sailor documents: sidon-ai wallet import`.

### Task 8: Switchover (other repos) and removal of the per-booking upload

Gated: do the OTA removal only after Robert confirms every live marina booking site uses the new flow.

- [ ] **sidon-ai** (`C:\Users\robert\source\repos\sidon-ai`): documents page and upload call OTA `/api/sailor/documents` with `X-Sailor-Token` from Clerk `getToken()`; after upload show `extracted_data.expiry_date` as a prefilled, confirmable expiry → `PUT`; "you already have a current <type>: new version or renewal?" prompt sends `document_id` for a version; files open via an authenticated fetch to `/versions/:id/file` (blob URL in the browser), not a public link. Then delete the public blobs for rows in `sidon-wallet-import.json` and for guest rows, and drop `file_url`. Commit in sidon-ai.
- [ ] **Booking sites:** follow the contract in swagger (`requirements-status`, `X-Sailor-Token` on create, upload via `/api/sailor/documents`). Per site: add domain to the sidon-ai Clerk instance.
- [ ] **OTA removal** (after confirmation): `git revert 5784a82`; delete `POST ${G}/bookings/:id/documents`, `uploadDocument`, `extractBookingDocuments`, the `afterChange` extraction hook, `rawDocSafe`/`uploadLimiter` if unused, its swagger entry and its tests in `scripts/check-marina-http.js`. Run both HTTP checks → `ok`. Commit `Marina: remove per-booking guest upload (sailor documents replace it)`.
- [ ] **Live DB:** apply `migrate-2026-10-17-sailor-documents.sql` (+ Task 7's) to production; set `SAILOR_CLERK_SECRET_KEYS` on Render; run `report-requirement-types.js`; run the wallet import dry-run then `--commit`.
