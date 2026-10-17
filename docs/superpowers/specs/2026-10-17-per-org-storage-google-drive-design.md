# Per-org storage: marina documents in the org's Google Drive

Date: 2026-10-17. Status: draft for approval.

## Intent

Two kinds of document, two owners, kept clearly apart:

| | Shared sailor documents | Marina documents |
|---|---|---|
| Whose | The sailor's, reused across marinas | One marina's, tied to one booking |
| File lives | OTA's private Vercel Blob store (unchanged) | The marina org's own storage — Google Drive first, more providers later |
| OTA keeps | File, versions, approvals | A record only: booking, requirement, type, status, expiry, extracted data, a pointer to the Drive file |
| Deletes files | OTA (its retention rules) | The marina, in their Drive. OTA never deletes there |

Why: OTA should hold as little marina data as possible. Holding passports and
insurance certificates on a marina's behalf is liability; in the marina's own
account they own it, pay for it and answer for it. Shared sailor documents are
the opposite case — holding them centrally *is* the product.

Per-booking upload is expected to return as a feature; this design makes sure
that when it does, files land in the marina's storage, never OTA's.

## Goals

- Org admins connect Google Drive once per Clerk org, the same way QuickBooks
  connects (connect → Google consent → back connected; status; disconnect).
- Integration plumbing that the next providers reuse, rather than more
  provider columns on `organization`.
- Marina per-booking document uploads go to the connected Drive, passing
  through OTA in memory only.
- With no Drive connected, OTA has **nowhere** to put marina documents: no
  upload is offered, and any upload that arrives is refused. No fallback store.
- Existing marina document files and rows in OTA are deleted (test data, per
  the user).
- **No fallbacks anywhere; clear errors until everything is in place**
  (user). Mandatory requirements stay mandatory when the org has no Drive:
  nothing is relaxed, hidden or auto-waived. Every place that can't proceed
  says exactly why and what fixes it:
  - guest upload with no Drive → 409 `{ error: "This marina can't accept
    document uploads yet", details: "The marina has not connected document
    storage" }` (wording left to the builder, meaning not);
  - Drive grant expired/revoked → same 409 with "reconnect" details to staff,
    and `status` reports `reconnect_required`;
  - Drive API failure → 502 naming Google Drive, nothing stored;
  - integrations not configured on the server (missing `GOOGLE_*` or
    `INTEGRATIONS_ENCRYPTION_KEY`) → 503 naming what's missing;
  - staff verification panel / booking detail: when a booking has unmet
    mandatory requirements and the org has no working Drive, say so
    ("Guests can't upload documents: connect Google Drive in Settings").

## Non-goals

- Shared sailor documents: untouched, stay in OTA's private store.
- Public marina images (`putPublic`): untouched.
- Other providers (SharePoint, Dropbox, S3...): later, on the same plumbing.
- Moving QuickBooks onto the new table: possible later, not now.
- Migrating existing files into Drive: they are deleted instead.

## Anti-goals (failure even if it "works")

- Any code path that writes a marina document to Vercel Blob or anywhere else
  OTA owns, including as a fallback when Drive fails.
- OTA able to read the rest of a marina's Drive.
- OTA deleting or modifying files in a marina's Drive after upload.
- Integration tokens readable from a DB dump.

## Decided

**By the user**
- Per-org (Clerk org), QuickBooks-style connect flow, "or better".
- Google Drive is the first provider; more will follow.
- No Drive → OTA ignores marina document files; no fallback storage.
- Existing marina document files/rows: delete them all.

**My calls (check these)**
1. **One `org_integration` table** instead of columns on `organization`:
   `(clerk_org_id, provider)` primary key; `account_email`, encrypted
   `refresh_token` / `access_token`, `access_token_expires_at`, `settings JSONB`
   (e.g. Drive root folder id), `connected_at`. One row per org per provider.
2. **Shared integration module** (`src/lib/integrations.js` or similar): a
   provider map (only `google_drive` today) with auth/token/revoke URLs, scope
   and env var names; signed OAuth `state` (same HMAC idea as QuickBooks);
   token refresh under a row lock (same as QuickBooks' `getAccessToken`);
   connect / callback / status / disconnect handlers.
   Routes: `/api/integrations/:provider/{connect,callback,status,disconnect}`,
   same auth as QuickBooks (`authenticateOrg`, admin for connect/disconnect).
3. **Tokens encrypted at rest** with AES-256-GCM (Node `crypto`), key from a
   new env var `INTEGRATIONS_ENCRYPTION_KEY`. Never returned to clients.
4. **Google scope `drive.file` only**: OTA sees only files it created. This is
   also a non-sensitive scope, so no Google security assessment is needed.
   OAuth with `access_type=offline&prompt=consent` so a refresh token is
   always issued. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REDIRECT_URI`.
5. **No new dependency**: Drive REST v3 via `fetch` (multipart upload, folder
   create), like the QuickBooks code.
6. **Folder layout** in the connected Drive, created lazily and ids cached in
   `settings`: `OTA / <property name> / <marina name> / <arrival date>
   <guest name> (<first 8 of booking id>) / file`. Guest names in folder
   names are fine: it's the marina's own Drive. Multi-property orgs share one
   Drive, split by property folder. The same Google account may connect to
   several orgs: each org gets its own `OTA` folder (`drive.file` + per-org
   folder ids), so nothing mixes.
7. **Upload path**: guest upload (same route and checks as today) → resolve
   marina → property → `clerk_org_id` → org's Drive row. Not connected → 409
   with a clear message. Connected → upload buffer to Drive → insert
   `marina_document` row with `drive_file_id` and `drive_web_link`. Drive
   failure → 502, no row, nothing kept.
8. **AI field extraction** runs on the in-memory buffer during upload (async,
   as today, but handed the buffer instead of re-reading storage). OTA never
   reads the file back from Drive.
9. **Staff viewing**: staff document JSON (list + verification panel)
   carries `drive_web_link`; the dashboard opens it in a new tab. The old
   bearer-only file route goes (a 302 to a `fetch` can't open a tab). OTA
   does not stream marina document bytes. Google handles access, so staff
   need access in the marina's Drive (shared folder or the connecting
   account).
10. **Guest side**: guest-facing marina/requirements responses expose whether
    uploads are accepted (e.g. `document_uploads: false` when the org has no
    Drive). Widget and booking sites hide the upload UI on `false` — follow-up
    in those repos, the API refusal is the guarantee.
11. **Disconnect**: revokes at Google (best effort, like QuickBooks), clears
    the row. Files stay in their Drive; existing `marina_document` rows keep
    their link. New uploads are refused until reconnected. A revoked/expired
    grant behaves the same as disconnected and surfaces "reconnect" in status.
    Reconnecting (any account) clears cached folder ids; old rows keep their
    links as they are.
12. **Schema change on `marina_document`**, in two migrations so live never
    breaks: (a) before deploy, additive: `drive_file_id`, `drive_web_link`,
    `blob_pathname` made nullable. (b) after the new code serves and the
    one-off cleanup ran: drop `blob_pathname` and `file_deleted_at`.
13. **One-off cleanup script** (count shown to the user first, then
    `--commit`): delete every `marina_document` blob and row, and everything
    under `marina-docs-archive/`. After it, OTA's private store holds only
    `sailor-docs/`.
14. **Removed**: marina-document part of `retentionOnce`, the
    `marina-docs-archive/` purge, `docPath`, the staff marina file route.
    Sailor-document code that shares `store` / `sniffType` / `extractFields`
    keeps working.
15. **Dashboard** (ota-table-bookings) is in scope: a Settings card to
    connect/disconnect Google Drive (status, account email), and document
    rows opening `drive_web_link`. Widget/booking-site UI hiding is the
    follow-up in item 10.
16. Size/type limits unchanged (4 MB, PDF/JPEG/PNG, 10 per booking).

## Constraints

- Pushing OTA `main` deploys to Render: the live migration runs before the
  code that needs it. The delete of existing rows is a separate, confirmed step.
- Render env vars (`GOOGLE_*`, `INTEGRATIONS_ENCRYPTION_KEY`) are set by the
  user; a Google Cloud OAuth client (Drive API enabled, consent screen) must
  exist first.
- Checks follow the repo pattern: `scripts/check-*.js` against the local DB,
  with the Drive client behind a seam (like `store`) swapped for an in-memory
  fake.

## Left to the builder

File/module names, the exact status JSON shape, error wording, how the Drive
seam is faked in checks, swagger entries, and whether `check-marina-http.js`
is extended or a new check script is added.
