# Review requests for every module, one per visit

## Context

Post-visit review requests exist for the spa only
(`2026-09-01-spa-review-requests-design.md`, `src/lib/reviewRequester.js`).
State lives in three columns on `spa_appointment`
(`review_request_sent_at`, `review_request_attempts`,
`review_request_resend_email_id`), plus the per-property settings on
`property` (`review_request_enabled`, `review_url`,
`review_request_delay_mins`, `review_request_cooldown_days`) and the
`review_request_opt_out` table. A 15-minute in-process job claims and
sends.

Venues need reviews from nearly every kind of booking. Decided with the
user:

- **One request per visit**, not per booking or per module. A hotel
  guest who stays three nights, has a treatment, two dinners and a tour
  gets one email, after their visit ends.
- **Public link only**, as today: the email links to the property's
  `review_url`. Nothing about ratings, opens or clicks is stored.

## Goals

- A `review_request` table recording every request sent, whatever the
  module.
- A `review_candidate` view that lists finished bookings from every
  eligible module in one shape.
- The existing job generalised to claim per guest (property + email)
  once their visit is over, honouring the cooldown and opt-outs.
- The spa moves onto the new path with no gap and no double-sends.

## Non-goals

- Ratings, comments, open or click tracking.
- Different review links per module (one `review_url` per property).
- Beach club: `beach_booking` / `beach_bed` carry no `property_id`, so
  there is no property to send for. In scope once that module is
  property-scoped.
- Shop orders (online purchases, often shipped, not visits) and event
  enquiries (an enquiry is not proof of attendance).
- sidon-marina (the same pattern can be ported later).
- A reporting endpoint; the table is queryable.

## Eligible modules and when a booking "ends"

All times are local to the property (`property.timezone`); date/time
columns carry no zone of their own. A module contributes only when its
key is in `property.enabled_modules` (or `enabled_modules` is NULL,
meaning all modules on, as elsewhere).

| `module` | Source | Email | Ends at | Counts when status is |
|---|---|---|---|---|
| `rooms` | `booking` join `guest` | `guest.email` | `check_out` at 11:00 | not `cancelled` / `no_show` |
| `restaurant_reservations` | `restaurant_reservation` | `contact_email` | `reservation_date + end_time` (or `start_time` + 2 h when `end_time` is null) | not `cancelled` / `no_show` |
| `restaurants` | `restaurant_order` | `contact_email` | `paid_at` | `payment_status = 'paid'` |
| `spa` | `spa_appointment` | `contact_email` | `appointment_date + end_time` | not `cancelled` / `no_show` |
| `tours` | `tour_booking` join `tour_slot` join `tour` | `contact_email` (else `guest.email`) | `slot_date + slot_time + tour.duration_mins` | not `cancelled` / `no_show` |
| `golf` | `golf_booking` join `tee_time` | `contact_email` (else `guest.email`) | `tee_date + tee_time` + 4 h | not `cancelled` |
| `equipment` | `equipment_hire` | `contact_email` (else `guest.email`) | `hire_date + start_time + duration` hours (start of day + 24 h when `start_time` is null) | not `cancelled` |

The fixed offsets (11:00 check-out, +2/3/4 h) are deliberately coarse:
the review delay (default 120 min) is added on top, and being an hour
late on a review email is harmless. They live in the view definition as
named constants in comments.

`review_candidate` (a plain view, recreated by the migration) returns
`(property_id, email, contact_name, module, booking_id, ended_at)`, where
`email` is `lower(trim(...))` and rows without an email are dropped.
Bookings that haven't ended yet are included (with `ended_at` in the
future) so the claim can see that a visit is still in progress.

## Data model

```sql
CREATE TABLE review_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID NOT NULL REFERENCES property(id),
  email            VARCHAR(255) NOT NULL,          -- lowercased
  contact_name     VARCHAR(100),                   -- copied at claim time, for the greeting and retries
  module           VARCHAR(30)  NOT NULL,          -- the booking that triggered it
  booking_id       UUID NOT NULL,
  sent_at          TIMESTAMPTZ,                    -- NULL while released for retry
  attempts         SMALLINT NOT NULL DEFAULT 1,
  resend_email_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module, booking_id)
);
CREATE INDEX ON review_request (property_id, email, created_at);
```

Backfill: one row per `spa_appointment` with `review_request_sent_at IS
NOT NULL` (module `spa`, its email, `sent_at`, attempts, resend id), so
the cooldown keeps counting past spa sends. The spa columns stay, unused,
as history; nothing writes them after this change.

Opt-out keeps using `review_request_opt_out (property_id, email)`.

## The claim (one per visit)

Every 15 minutes the job runs one statement that inserts a
`review_request` row for each guest due a request and returns them. A
guest (property `P`, email `E`) is due when:

1. P has `review_request_enabled` and a `review_url`;
2. some candidate of E at P ended between 2 days ago and
   `now() - review_request_delay_mins` (the 2-day floor means switching
   the feature on never backfills history);
3. **their visit is over**: no room stay of E at P is in progress or
   starts within 24 hours (a stay starts at 15:00 local on check-in), and
   no other booking of E at P ends within the next 24 hours. A regular
   who's back next week is asked now; the cooldown handles repeat visits.
   (Revised after review: a 14-day lookahead meant weekly regulars were
   never asked.)
4. no `review_request` for E at P was created within
   `review_request_cooldown_days`;
5. E has not opted out at P.

The row records the most recently ended candidate as the trigger
(`DISTINCT ON (property_id, email) ... ORDER BY ended_at DESC`).
`INSERT ... SELECT ... ON CONFLICT (module, booking_id) DO NOTHING
RETURNING` makes overlapping sweeps safe: whichever sweep inserts the row
sends; the other gets nothing back. Two different bookings of the same
guest claimed by two concurrent sweeps is guarded by the cooldown check
running inside the same statement; the residual window (two sweeps
within milliseconds, picking different trigger bookings) is accepted:
sweeps run 15 minutes apart from a single process.

Sending: as today, sequentially. On a Resend failure, `sent_at` is set
NULL and the row is retried on the next sweep while `attempts < 3`
(the retry path updates the existing row rather than inserting).
Rows with `sent_at IS NULL` and `attempts >= 3` are left as the record
of a failed request.

## Email

`sendReviewRequest` is generalised from one appointment to a visit:
subject "How was your visit to {property}?", greeting by the contact
name from the trigger booking (or "Hi there"), the same
review-link and opt-out layout, and the same branding resolution
(`resolveEmailBranding` with the property default). The opt-out link
becomes `/api/review-opt-out/:requestId`, writing
`review_request_opt_out` for the request's property and email; the old
spa route (`/api/spa/review-opt-out/:appointmentId`) keeps working for
emails already sent.

## Files

- `src/db/migrate-2026-10-06-review-requests-all-modules.sql`: table,
  index, view, spa backfill (mirrored in `schema.sql`).
- `src/lib/reviewRequester.js`: new claim SQL, retry and send; same
  `startReviewRequestJob` export, so `server.js` is unchanged.
- `src/lib/resend.js`: `sendReviewRequest` signature becomes
  `({ to, name, propertyName, branding, reviewUrl, optOutUrl })`.
- `src/controllers/reviews.js` + route: the property-wide opt-out.
- `src/controllers/spa.js`: old opt-out route delegates to the shared
  opt-out writer.

## Testing

`scripts/check-review-requests.js` against the local DB (inside a
transaction it rolls back, so nothing persists): a test property with
reviews on and delay 0; a guest with a room stay, a spa treatment and
two dinners; it calls the claim with an injectable `now`:

1. mid-stay (dinner 1 finished, check-out tomorrow) → nothing claimed;
2. after check-out → exactly one row, triggered by the latest-ended
   booking;
3. a second sweep → nothing (cooldown);
4. a new guest with only a tour that ended 3 hours ago → claimed;
5. a cancelled booking only → nothing;
6. an opted-out email → nothing;
7. a booking that ended 3 days ago → nothing (2-day floor);
8. a module not in `enabled_modules` → ignored;
9. the claim run twice concurrently (two connections) → one row.

Then on the local server with a real Resend key and a test inbox: one
end-to-end send, and the opt-out link writes `review_request_opt_out`.

## Deploy order

Deploy the code first, then run the migration on the live DB. The other
order lets the old spa sender keep claiming after the backfill snapshot,
so a spa guest could be asked twice; deploy-first only costs
`review_candidate does not exist` log lines until the migration runs.
