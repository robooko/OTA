# Event inquiries: general / group-booking enquiries

## Context

The event-inquiries module (`2026-08-16-event-inquiries-design.md`,
replies in `2026-08-16-event-inquiry-replies-design.md`, AI drafts in
`2026-08-29-event-inquiry-ai-replies-design.md`) is a complete loop:
a property's public site `POST`s with its `X-Api-Key` → staff are
notified over Ably → staff (or Claude, in `draft`/`auto` mode) reply via
Resend from `inquiries@hotal.forge-build.co.uk` → the guest's reply
routes back in through the `inquiry+<id>@` reply-to and the inbound
webhook. It was built for weddings/conferences at hotels.

Bedford Barber Co (a barbershop, see
`2026-08-30-spa-barbershop-bookings-design.md` for the booking side)
wants the same thing for group bookings — stag dos, wedding-party
grooming, a football team before a night out — and for plain "can you
do X" questions from its website. Everything needed is already here;
two things are wrong for that use:

1. **`event_date` is `NOT NULL`.** The original spec flagged this as a
   product question ("an early-stage 'just exploring' inquiry might not
   have a firm date") and deliberately shipped it required pending a
   real need. A general enquiry is that need.
2. **The outbound email is hard-coded to events**: subject
   `Re: Your event inquiry` in `sendReply`. Wrong for a barbershop, and
   slightly wrong for any non-wedding hotel enquiry too.

Everything else already fits: `guests` is optional (party size),
`event_type` is free text (`stag`, `wedding_party`, `general`),
`restaurant_id` is optional, `message` is free text, and
`property.ai_reply_instructions` is where Omar's prices/hours/tone go
so Claude can draft answers.

## Goals

- `event_date` nullable end-to-end: schema, `createInquiry` /
  `updateInquiry` validation, Ably payload (the AI prompt already
  tolerates it).
- Outbound subject derived from the property, not the word "event".
- Seed a `Bedford Barber Co` property so the site can be wired up
  immediately, independent of the spa spec.
- Document the site-side endpoint shape and the spam exposure, since
  this is the first property to put the module behind a non-hotel
  public form.

## Non-goals (explicitly out of scope)

- No new `inquiry_kind`/`category` column. `event_type` already carries
  this as free text and the dashboard filters on it; adding a second
  taxonomy would only create drift.
- No rename of the module, tables, routes or MCP tools
  (`event_inquiry`, `/api/event-inquiries`, `create_event_inquiry`). The
  name is wrong for a barbershop but the rename is pure churn across
  OTA, hotal-ui and the MCP server for no behaviour change. Not now.
- No per-property from-address or sender-name customisation. Stays
  `"${propertyName} via Forge <inquiries@hotal.forge-build.co.uk>"`.
- No per-key rate limiting in OTA. Flagged below as a risk; mitigated on
  the site side for this property. A general solution (per-property
  limits on the api-key rail) is its own spec.
- No SMS.
- No change to the AI-reply lifecycle, scoring, or auto-send rules.

## Data model

```sql
ALTER TABLE event_inquiry ALTER COLUMN event_date DROP NOT NULL;
```

That is the whole schema change. `schema.sql` updated in place to drop
`NOT NULL` from `event_date` (the `event_time` comment line beside it
already documents the nullable-time precedent).

## API & behavior

### `createInquiry`

- Required becomes `name`, `email` (was `name`, `email`, `event_date`).
- `event_date`, when present and not `null`, must still pass
  `isValidDate` → `400 'Invalid date format'` otherwise.
- Insert passes `event_date ?? null`.
- Ably `new-inquiry` payload is the inserted row, so `event_date: null`
  flows through with no change. hotal-ui's `EventInquiriesFeed.svelte`
  `formatDate` does `new Date(iso)` — with `null` that is the epoch and
  renders as **"Jan 1, 1970"**, silently wrong. It needs a null guard
  ("Date TBC"), and `global.d.ts`'s `event_date: string` becomes
  `string | null`. One-line changes on that side, noted here so they
  aren't missed.

### `updateInquiry`

Already accepts `event_date`. Add the same `!== null` guard `event_time`
has so a client sending `event_date: null` (hotal-ui round-tripping a
dateless inquiry) gets `200` instead of `400 'Invalid event_date
format'`. As with every other field here, `null` is a no-op through the
`COALESCE` update — it does not clear an existing date. Clearing is not
needed for this use case and would break the module's one update
convention for a single column.

### Email subject (`src/lib/resend.js` → `sendReply`)

```
subject: `Re: Your enquiry to ${propertyName}`
```

British spelling matches the audience of every property currently on
the platform. Applied to all properties — the old subject was not
better for hotels either.

### AI drafts (`src/lib/aiReplies.js`)

No change needed: `buildUserMessage` emits `event_date` through
`field()`, which already omits null/empty values, so a dateless enquiry
simply has no `<field name="event_date">` in the prompt. Test 6 below
confirms the model doesn't invent one. `requires_human` logic is
unchanged — a missing date is not by itself a reason to escalate.

### Swagger

`event_date` marked optional on the `POST /api/event-inquiries` body.

## Seed — Bedford Barber Co property

New `src/db/seed-property-bedford-barber.sql`, additive and idempotent
(`INSERT … WHERE NOT EXISTS (SELECT 1 FROM property WHERE name = 'Bedford
Barber Co')`):

- `name = 'Bedford Barber Co'`, `currency = 'GBP'`, `timezone =
  'Europe/London'` (defaults, stated explicitly).
- `api_key` NULL — mint with `POST /api/property/api-key/rotate` after a
  Clerk org is linked, or set directly in SQL. The key is then stored as
  `OTA_API_KEY` in the site's Vercel env, never committed.
- `ai_reply_mode = 'draft'` — every Claude draft needs Omar's approval;
  flip to `'auto'` only after seeing a few.
- `ai_reply_instructions` seeded with the facts the model may state, and
  nothing else (per the AI-replies spec's "the ONLY facts the model may
  state" rule):

  > Bedford Barber Co, 20C Miller Rd, Bedford MK42 9NZ. Phone 07429 153
  > 339. Men's barbershop, est. 2017, owner Omar. Hours: Mon 10–8, Tue
  > closed, Wed–Fri 10–8, Sat 9–6, Sun 11:30–4. Prices: Haircut £20,
  > Skin Fade £25, Haircut + Beard £25, Skin Fade + Beard £30, Beard
  > Trim £8, Wet Shave + Foam Steam £15, Kids Haircut (under 12) £15,
  > Kids Skin Fade (under 12) £20, Senior Citizens £10. Individual
  > bookings are via Booksy (https://booksy.com/en-gb/46833_bedford-barber-co_barber_143761_bedford).
  > Group bookings (4+) are arranged by phone or by replying to this
  > email; do not confirm a group time yourself — say Omar will confirm.
  > Tone: friendly, short, no exclamation marks. Sign off "Omar".

The spa spec's `seed-spa-bedford-barber.sql` reuses this property by
name if it already exists.

## Migration & rollout

New `migrate-2026-08-30-event-inquiry-optional-date.sql`:

```sql
ALTER TABLE event_inquiry ALTER COLUMN event_date DROP NOT NULL;
```

Idempotent (dropping an absent constraint is a no-op). No backfill —
existing rows all have a date. Local first, then production; the code
change is safe to deploy before or after the migration (the controller
only *stops* requiring the field; the database is the one that becomes
more permissive).

Then `seed-property-bedford-barber.sql` on production, mint the key,
put it in the site's Vercel env.

## Risk: the api-key rail behind a public form

`POST /api/event-inquiries` with a valid `X-Api-Key` creates a row,
fires Ably, and — in `draft`/`auto` mode — spends Anthropic tokens on a
Claude draft, per submission, with no throttle. For hotels this has been
fine; a barbershop contact form on a public site is a more obvious spam
target. Mitigation for this property lives on the site side (below):
honeypot field, minimum time-on-form, and a per-IP limit at the Astro
endpoint. If a second non-hotel property joins, per-property limits on
the api-key rail should get their own spec rather than being bolted on
here.

## Testing approach

Manual `curl` against `npm run dev` with the Bedford Barber Co key:

1. Run the migration. `\d event_inquiry` → `event_date` nullable.
2. `POST /api/event-inquiries {name, email, message}` (no date) → `201`,
   `event_date: null`. Ably `new-inquiry` fires with the null date.
3. Same with `event_date: "not-a-date"` → `400`. With a valid date →
   `201` as before (regression).
4. `PUT /:id {event_date: null}` → `200`, existing date unchanged
   (was a `400`).
5. `POST /:id/replies {body}` → email received with subject
   `Re: Your enquiry to Bedford Barber Co`. Reply from the inbox →
   inbound message appears under `GET /:id/replies`.
6. With `ai_reply_mode = 'draft'`: submit a dateless enquiry asking
   "how much is a skin fade for my son" → a draft appears in
   `GET /api/event-inquiries/ai-drafts` quoting £20, not inventing a
   date, `requires_human = false`. Ask "can you fit 8 of us in Saturday
   at 5" → draft says Omar will confirm, does not commit to a time.
7. Seed on a clean DB → one `Bedford Barber Co` property; run the seed
   again → still one.
8. MCP `create_event_inquiry` via `ota-dev` without `event_date` → `201`.

## Consuming site (bedford-barber) — for reference, not in this repo

The site is static Astro on Vercel with no adapter. It needs
`@astrojs/vercel` and one `prerender = false` endpoint,
`POST /api/enquiry`, that:

- reads `OTA_API_KEY` from env and forwards `{name, email, phone,
  event_date?, guests?, event_type, message}` to
  `POST https://ota-u6ii.onrender.com/api/event-inquiries`;
- rejects submissions where the hidden honeypot field is filled or the
  form was submitted under ~3 s after render;
- applies a small per-IP limit (a handful per hour is plenty for a
  barbershop);
- returns a plain success/failure the form can render without
  JavaScript being required for the page to score 100 on Lighthouse.

The form itself is a new section in the existing Forge design language
(gold accent, Syne/Inter) — "Group bookings & enquiries" — with fields
name, email, phone, date (optional), party size, occasion (select →
`event_type`), message. The Booksy CTA stays the primary action for
individual bookings.
