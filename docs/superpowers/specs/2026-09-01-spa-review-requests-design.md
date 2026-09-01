# Spa module: post-visit Google review requests

## Context

Bedford Barber Co sits in the Google map pack for "barbershop" (searched
from Bedford) with **3 Google reviews**, between Christopher's Barbers (141)
and Kurd Star (135). Search Console shows the website is *shown* for the
"near me" family ~155 times a quarter and clicked 4 times: those searches
are answered by the map pack, and the map pack ranks on Google Business
Profile signals — review count and recency above all. The shop's 473
five-star Booksy reviews count for nothing there.

OTA already holds everything needed to ask for a Google review at the right
moment except the trigger:

- `spa_appointment` records who came in, when it ended (`appointment_date`
  + `end_time`), and `contact_email`. `status` is `confirmed`/`cancelled`.
- Resend is wired (`src/lib/resend.js`) with a branded appointment email
  template (header logo / accent / `header_bg`, details card, muted footer).
- Branding now lives on the property (`property.email_branding`,
  `property.email_cancel_url`, `migrate-2026-09-01-property-email-branding.sql`)
  with per-request override via `resolveEmailBranding()` in
  `src/controllers/spa.js`. A background job has no request, so it needs
  exactly this property-level fallback — which is why this spec was not
  writable before that migration landed.
- There is a precedent for in-process scheduled work: `availabilitySeeder.js`
  and `teeTimeSeeder.js` run on boot and on a `setInterval`, started from
  `src/server.js`. The 2026-08-30 spa spec deferred reminders "until a
  scheduler/cron exists in this codebase"; this spec uses the same
  in-process pattern rather than introducing a new one, and is deliberately
  the simplest possible time-triggered email so that reminders can follow
  the same shape later.

## Goals

- After an attended appointment ends, email the customer once asking for a
  Google review, with a single button that opens the review box directly.
- Property-level opt-in and configuration: off by default, so Pirates Bight
  (and every other property) sends nothing until a review URL is set and
  the feature is switched on.
- Idempotent and restart-safe: an appointment is asked at most once, ever,
  regardless of how many times the process restarts or the sweep runs.
- Don't nag regulars: one request per email address per property per
  cooldown window (default 90 days). A fortnightly customer is asked once.
- Customer opt-out from the email itself, honoured for that property
  forever after.
- Same branding as the confirmation email (logo, accent, `header_bg`), from
  `property.email_branding`.

## Non-goals (explicitly out of scope)

- **No review gating and no incentives.** Google's policy prohibits asking
  only customers you believe are happy, and offering anything in return.
  Every eligible attendee is asked in the same words. There is no
  "rate us first, then we decide" step — the button goes straight to Google.
- No SMS. Email only (Resend is what exists).
- No pre-appointment reminders. Same job pattern could carry them; separate
  spec, separate template, separate timing — not bundled here.
- No proof of attendance. `payment_status = 'paid'` (tap-to-pay) is proof
  the visit happened, but most of Omar's customers pay cash or via Booksy,
  so requiring it would silence the feature. `status = 'confirmed'` and the
  end time having passed is the attendance signal. A future `no_show`
  status (already anticipated by the 2026-08-30 spec as a free `VARCHAR(20)`
  value) is excluded by this spec's query the day it appears.
- No dashboard UI in this repo — hotal-ui is separate. The settings are
  exposed on the existing property email-branding endpoints so the
  Settings → Branding screen can grow two fields.
- No per-spa configuration. Review URL and the switch live on `property`,
  next to `email_branding`. A property with several spas that want
  different review targets is not a case anyone has.
- No backfill. Switching the feature on must not email everyone who visited
  in the past year — see the lookback bound in the query.
- No tracking of whether a review was actually left (Google exposes nothing
  usable for that).

## Data model

### `property`: configuration (extends the email-branding columns)

```sql
ALTER TABLE property
  ADD COLUMN IF NOT EXISTS review_request_enabled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_url              TEXT,           -- e.g. https://g.page/r/XXXX/review
  ADD COLUMN IF NOT EXISTS review_request_delay_mins    INT NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS review_request_cooldown_days INT NOT NULL DEFAULT 90;
```

`review_url` is the "Ask for reviews" short link from the Google Business
Profile dashboard (`https://g.page/r/…/review`), validated with the
existing `isValidUrl`. `review_request_enabled` may only be set `true` when
`review_url` is non-null (400 otherwise). Delay and cooldown are exposed so
the dashboard can tune them but ship with sensible defaults; neither needs
UI on day one.

### `spa_appointment`: send record (mirrors `confirmation_resend_email_id`)

```sql
ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS review_request_sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_request_resend_email_id TEXT,
  ADD COLUMN IF NOT EXISTS review_request_attempts        SMALLINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_spa_appointment_review_pending
  ON spa_appointment (property_id, appointment_date)
  WHERE review_request_sent_at IS NULL AND status = 'confirmed' AND contact_email IS NOT NULL;
```

`review_request_sent_at` is the claim *and* the record: it is set in the
same statement that selects the row (see "Claiming" below), so two
overlapping sweeps cannot both send. `review_request_attempts` caps retries
after a Resend failure at 3; after that the row is left alone and logged.

### New: `review_request_opt_out`

```sql
CREATE TABLE IF NOT EXISTS review_request_opt_out (
  property_id UUID NOT NULL REFERENCES property(id),
  email       VARCHAR(255) NOT NULL,   -- stored lower-cased
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (property_id, email)
);
```

Property-scoped, not global: opting out of Bedford Barber's request says
nothing about a hotel the same person stays at.

All three migrations are idempotent (`IF NOT EXISTS`) and additive, matching
the repo convention; `schema.sql` gets the same columns with a pointer
comment to the migration file, like `email_branding` has.

## The job: `src/lib/reviewRequester.js`

Started from `src/server.js` alongside the two seeders:

```js
const { startReviewRequestJob } = require('./lib/reviewRequester');
// ...
startReviewRequestJob();
```

Boot + every **15 minutes** (`setInterval`, `timer.unref()` like the
seeders). Daily is too coarse — the point is "a couple of hours after the
cut, same evening"; 15 minutes keeps the send within a quarter-hour of the
configured delay without being a busy loop. Each tick:

### 1. Claiming (one statement, the idempotency guarantee)

```sql
UPDATE spa_appointment sa
SET review_request_sent_at = now(),
    review_request_attempts = sa.review_request_attempts + 1
FROM property p
WHERE p.id = sa.property_id
  AND p.review_request_enabled
  AND p.review_url IS NOT NULL
  AND sa.status = 'confirmed'
  AND sa.contact_email IS NOT NULL
  AND sa.review_request_sent_at IS NULL
  AND sa.review_request_attempts < 3
  -- ended at least delay_mins ago, in the property's own timezone
  AND (sa.appointment_date + sa.end_time) AT TIME ZONE p.timezone
        <= now() - (p.review_request_delay_mins || ' minutes')::interval
  -- lookback bound: never backfill history when the switch is flipped
  AND sa.appointment_date >= CURRENT_DATE - 2
  -- cooldown: nobody asked at this property in the window
  AND NOT EXISTS (
    SELECT 1 FROM spa_appointment prev
    WHERE prev.property_id = sa.property_id
      AND lower(prev.contact_email) = lower(sa.contact_email)
      AND prev.id <> sa.id
      AND prev.review_request_sent_at >= now() - (p.review_request_cooldown_days || ' days')::interval
  )
  -- opt-out
  AND NOT EXISTS (
    SELECT 1 FROM review_request_opt_out o
    WHERE o.property_id = sa.property_id AND o.email = lower(sa.contact_email)
  )
RETURNING sa.id;
```

Postgres row-locks each updated row inside the statement, so a second
process (or a redeploy overlap on Render) running the identical statement
skips the rows already claimed. This is the same "claim, then act" shape
as the `FOR UPDATE` booking lock in the 2026-08-30 spec.

Timezone note: `appointment_date`/`end_time` are timezone-less wall-clock
columns (the 2026-08-30 spec is explicit about this); `AT TIME ZONE
p.timezone` turns them into an instant for comparison with `now()`. Do not
do this arithmetic in JS — the process TZ on Render is UTC and the
`addDaysUTC` comment in `spa.js` already documents why that bites.

### 2. Sending

For each returned id: `getFullAppointmentForEmail(id)` (exists — the
joined shape with `property_name`, `spa_address`, `spa_phone`,
`treatment_name`, `therapist_name`), then
`resolveEmailBranding(property_id)` with no request override, then
`sendReviewRequest(full, propertyName, branding, reviewUrl, optOutUrl)`.

On success: `UPDATE spa_appointment SET review_request_resend_email_id = $1
WHERE id = $2`. On failure: log with the appointment id and **reset
`review_request_sent_at = NULL`** so the next tick retries — the attempts
counter (already incremented by the claim) stops it retrying forever. Never
throw out of the tick; catch per row, same as the Ably `.catch()`
convention.

Log one line per tick only when something was sent
(`Review requests: sent N`), mirroring the seeders' quiet-when-idle
logging.

## The email: `sendReviewRequest` in `src/lib/resend.js`

Reuses the header/footer construction of `sendAppointmentEmail` (factor
the logo/`header_bg`/footer pieces out rather than copy them; the three
appointment emails should share one skeleton). Content:

- Subject: `How was your {treatment_name}?` (Bedford: "How was your Skin
  Fade?")
- Greeting: `Hi {contact_name},`
- One line: `Thanks for coming in on {date}. If you've got thirty seconds,
  a Google review makes a real difference to a small shop like ours.`
- Button: **Leave a Google review** → `review_url`, styled like the cancel
  button (`brand_color` background). Nothing between the customer and the
  Google review box — no star picker, no "how did we do" form (that would
  be gating).
- Footer: address, phone, and `Don't want these? Unsubscribe` → opt-out URL.

`from` matches the other appointment emails
(`${propertyName} via Forge <bookings@hotal.forge-build.co.uk>`); `replyTo`
the spa's contact email when set. Plain-text part carries the same wording
with the two URLs on their own lines, as the existing template does.

## Opt-out route

`GET /api/spa/review-opt-out/:appointment_id` — **unauthenticated**, added
to the same allow-list as the Resend inbound webhook in `src/app.js`. The
appointment UUID is the capability (unguessable, only ever in that
customer's email) — the same reasoning as the `{id}` cancel link. Handler:

1. Look the appointment up; 404 if unknown.
2. `INSERT INTO review_request_opt_out (property_id, email) VALUES ($1,
   lower($2)) ON CONFLICT DO NOTHING`.
3. Respond with a minimal HTML page: "You won't be asked for a review by
   {propertyName} again." No branding needed; it is a one-line page.

GET rather than POST because it is a link in an email. It is idempotent
and its only effect is to suppress future emails, so link-prefetching by a
mail client is harmless.

## API: settings

Extend the existing property email-branding endpoints
(`getEmailBranding` / `updateEmailBranding` in `src/controllers/property.js`,
`src/routes/property.js`) rather than adding new ones — the dashboard's
Settings → Branding screen is where this belongs:

- GET adds `review_request_enabled`, `review_url`,
  `review_request_delay_mins`, `review_request_cooldown_days`.
- PUT accepts the same four. Validation: `review_url` via `isValidUrl`;
  `review_request_enabled: true` requires a non-null `review_url` (400
  `"review_url is required to enable review requests"`); delay 0–1440;
  cooldown 0–365.

Swagger: document the four fields on the existing schema. MCP: no new
tool — this is a settings screen concern, not an agent action.

## Policy guardrails (why the defaults are what they are)

- **Everyone eligible is asked, identically.** The query has no notion of
  satisfaction, rating, tip, or repeat status. This is what keeps the
  feature on the right side of Google's review policy.
- **90-day cooldown** — a barbershop regular visits every 2–4 weeks; asking
  each visit is the fastest way to get the emails marked as spam and the
  domain reputation damaged for the confirmation emails too.
- **2-hour delay** — long enough that they've left and seen the result,
  short enough to be the same evening. Next-morning asks convert worse.
- **2-day lookback** — enabling the feature on a Monday asks Saturday's
  and Sunday's customers (they are still "recent"), not the last year's.
- **Opt-out is per property and permanent.**

## Bedford Barber Co rollout

1. Omar (or Robert) copies the review link from the Business Profile
   dashboard → Settings → Branding → Review URL, switch on.
2. `email_branding` is already set for the property (logo, `#c9a84c`,
   `#f5f0e8`), so the request email matches the confirmation.
3. Nothing changes on the bedford-barber site. The website's booking flow
   is one source of appointments; walk-ins entered via the dashboard and AI
   reply bookings feed the same table and get the same request — provided
   staff capture an email for walk-ins, which today they mostly don't
   (yesterday's walk-in row has none). That is a dashboard habit, not a
   code change.

## Verification (dev, against a local Resend key)

- Property with `review_request_enabled = false`: sweep sends nothing even
  with eligible rows.
- Enable with a null `review_url`: PUT returns 400.
- Eligible appointment (ended > delay ago, email set): one email to
  `delivered@resend.dev`; row gets `sent_at` + `resend_email_id`;
  fetched back from Resend, HTML contains the button href = `review_url`
  and the opt-out href with the appointment id.
- Run the sweep twice more: no second email, row unchanged.
- Two sweeps started concurrently against the same eligible row: exactly
  one email (assert on `review_request_resend_email_id` being set once).
- Same email address, second appointment 3 days later: not asked
  (cooldown). Set `review_request_cooldown_days = 0`: asked.
- Opt-out GET → row in `review_request_opt_out`, page renders; a later
  eligible appointment for that email is skipped.
- Cancelled appointment, no-email appointment, appointment 5 days ago on
  first enable: all skipped.
- Simulated Resend failure: `sent_at` reset to NULL, `attempts` = 1; after
  three failures the row stays untouched with `attempts` = 3.
- `appointment_date + end_time` boundary in BST vs UTC: an appointment
  ending 19:30 London on a summer day is not eligible at 19:00 UTC
  (20:00 London) with a 120-minute delay, and is at 19:31 UTC + 2h.

## Open questions

- Delay and cooldown defaults are judgement calls; both are per-property
  settings so Omar can change them without a deploy.
- Whether AI-reply-created bookings should be treated any differently.
  This spec says no — they are ordinary rows once created.
- Whether the "Unsubscribe" wording should also suppress a future reminder
  email if/when that exists. Suggest yes: rename the table
  `spa_email_opt_out` with a `kind` column if reminders land, rather than
  a second table. Not needed now.
