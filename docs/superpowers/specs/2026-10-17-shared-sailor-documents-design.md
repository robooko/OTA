# Shared sailor documents — design

Date: 2026-10-17. Repos: OTA (this one), sidon-ai (sailor app), the marina booking websites.

## Why

Today a sailor's documents live in two unconnected places: sidon-ai keeps a
wallet (public Vercel Blob, keyed by Clerk user id), and OTA keeps a separate
copy per marina booking (private Blob, keyed by booking). The sailor uploads
the same insurance again for every booking, and every marina's check is
stranded on its own copy.

Sidon and OTA have the same goal: hold a sailor's documents once and build
trust in them as marinas check them. So there is **one set of documents per
sailor**, held by OTA, keyed by a proven email. Each marina still checks for
itself — two humans having checked a document is where the value is.

## Goals

- One document set per sailor, stored once in OTA's private Blob store.
- sidon-ai is a client of OTA for documents: upload, list, view, delete
  through OTA's API. It stores no files itself.
- Booking sites enforce required documents: the guest signs in (Clerk), sees
  which of the marina's requirements are met, uploads anything missing,
  and cannot book until every mandatory requirement is met.
- Marina staff approve or reject per marina, against a specific version of a
  document. Other marinas see how many marinas have checked it.

## Non-goals (for now)

- Staff scanning/uploading documents face to face. Parked; may come later.
- Documents for hotel, courses or equipment bookings. Marina only.
- Sharing one marina's notes or identity with another marina.

## Anti-goals

- A passport reachable by anyone who isn't the sailor or a marina they've
  booked with. Today's sidon-ai public URLs are exactly this and must end.
- A booking typed with someone else's email pulling in that person's
  documents. Documents only ever attach through a proven email.
- Duplicate documents piling up so approvals scatter across copies.

## The model

**Document** — a real-world item: "Allianz policy, expires 2027-03-01".
Belongs to a sailor (verified email). Has a type, extracted data, an expiry.
A renewal is a new document; the old one stays as history.

**Expiry** — *my call:* extraction prefills the expiry; the sailor confirms
or corrects it at upload (required for `insurance`, `acord25`, `passport`;
optional for the rest, where null means "does not expire"). Staff can correct
it when approving. Extraction itself never decides met/unmet.

**Version** — a file under a document. A sailor re-uploading a better photo of
the same policy adds a version, not a document. Only the sailor uploads.
The document's current file is its newest version.

**Approval** — one marina's verdict (approved / rejected, notes, staff user,
time) on one version. One live verdict per marina per version. Other marinas
see only a count of marinas that approved any version of the document.

Tables (names are the builder's call; these are indicative):
- `sailor_document` (id, email, type, extracted_data, expiry_date, created_at, deleted_at)
- `sailor_document_version` (id, document_id, blob_pathname, file_name, content_type, size_bytes, uploaded_at)
- `sailor_document_approval` (id, version_id, marina_id, property_id, status, notes, staff_user, decided_at)

Document types are the shared vocabulary sidon-ai already uses: `insurance`,
`acord25`, `registration`, `uscg_cod`, `passport`, `safety`. Marina
requirements (`marina_doc_requirement.type`) must use one of these.

## Identity

- The sailor proves their email by signing in with Clerk — in sidon-ai, or on
  a booking site that loads Clerk sign-in itself. No redirect flow.
- The site sends the Clerk session token (`getToken()`) to OTA in a header,
  alongside its existing API key. OTA verifies the token and reads the user's
  **primary, verified** email from Clerk. That email is the key.
- **OTA does not care which site or who built it** — API key says which
  marina, token says which sailor. Nothing else is required of a site.
- OTA trusts a configured list of sailor Clerk instances (separate from the
  staff Clerk instance). *My call:* the intended setup is one instance —
  sidon-ai's — with each booking site's domain added to it, so a sailor has one
  login everywhere; the list just keeps the door open.

## Flows

**Sidon (sailor app).** Sign in → list my documents (with per-document
approval count) → upload. If the sailor already has a current document of
that type, the UI asks: "new version of this one, or a different/renewed
document?" and sends `document_id` for a version. No reliance on extraction
to decide. Delete removes a document and its files.

**Booking site (happy path).**
1. Guest picks berth and dates.
2. If the marina has active requirements, the guest signs in with Clerk.
   Marinas with none need no sign-in.
3. Site asks OTA: requirements for this marina + which are met by this
   sailor's current documents. "Met" = a non-deleted document of that type
   whose expiry is null or on/after departure (arrival for open-ended).
4. Missing ones: the guest uploads right there (same OTA upload API, Clerk
   token) or in Sidon. Book stays disabled until mandatory ones are met.
5. Book. The request carries the Clerk token, no files. OTA re-checks the
   requirements server-side and rejects with 409 if any mandatory one is
   unmet. The booking's contact email is the verified email, flagged
   verified.

**Marina staff.** The booking's verification panel lists requirements and,
for each, the sailor's current document (newest version), its approval
count from other marinas, and this marina's own verdict on each version.
Approve / reject records against the version shown. *My call:* if a sailor
has several current documents of one type, the panel and auto-confirm use the
newest unexpired one. Auto-confirm counts a
requirement as met when this marina has approved any version of the
matching current document.

## Access rules

- Sailor: full access to their own documents (by verified email).
- Marina staff: **documents are not hidden from staff** — once a sailor has
  any booking at the marina made with a verified email (any status, any age),
  that marina's staff see all their documents for good, until the sailor
  deletes them. The only gate is that the link comes from a verified-email
  booking, never from an email typed into a staff booking. Staff/import
  bookings (unverified email) show only legacy per-booking documents.
- Booking sites (API key + Clerk token): only the signed-in sailor's own
  documents, and only metadata + met/unmet, plus their own files.
- Files stay private; streamed through authenticated OTA routes only.

## What changes in OTA

- Remove the guest per-booking upload route
  (`POST /api/marina/guest/:marina/bookings/:id/documents`) and revert commit
  5784a82 (uploads during hold) as part of this.
- New sailor document API (Clerk-token auth) for list / upload / version /
  delete / view, used by sidon-ai and booking sites.
- Guest booking create: Clerk token required when the marina has active
  requirements; server-side enforcement; verified-email flag on the booking.
- Staff verification panel, approvals and auto-confirm read the new model.
- Extraction (existing `extractDocument` prompt) runs on each new version;
  still advisory only, never drives status.
- Delete (*my call*): the sailor deleting a document deletes its files from
  Blob and soft-deletes the rows; approval history stays as a record (file
  gone). A live booking that relied on it goes back to unmet.
- In-flight bookings (*my call*): dual read during the crossover — legacy
  `marina_document` rows stay approvable and still count for auto-confirm on
  the bookings that have them, so nothing gets stuck.
- Retention: sailor documents are kept until the sailor deletes them (their
  wallet, not the marina's). The 90-day per-booking file deletion stays for
  the legacy per-booking documents only.

## Migration

- **sidon-ai wallet → OTA.** For each `sailor_document` row: look up the
  Clerk user's primary verified email, copy the public blob into OTA's
  private store as a document + version, then delete the public blob and
  drop `file_url`. sidon-ai's documents UI switches to OTA's API. Until this
  ships, sidon-ai passports are publicly readable — fix urgently.
- sidon-ai rows with no Clerk user (`sailor_id` null, guest_email only):
  *my call* — deleted with their blobs, not migrated; their email can't be
  proven.
- **Existing OTA `marina_document` rows** (incl. the sidon-marina import):
  *my call* — left as legacy per-booking documents, read-only, still shown
  on their bookings and still deleted by retention. Not merged into sailor
  wallets, because their emails were never proven.

## Left to the builder

Table/column names, API paths and payload shapes, how the Clerk instances are
configured, UI wording in sidon-ai and booking sites, extraction timing,
ordering of the rollout across the three repos.
