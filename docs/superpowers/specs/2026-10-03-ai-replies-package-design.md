# `@forgebuild/ai-replies` — shared AI reply generation

## Context

`src/lib/aiReplies.js` (per `2026-08-29-event-inquiry-ai-replies-design.md`)
drafts a reply to an enquiry with Claude and self-assesses it. Sidon
Marina (`sidon-marina`, Astro on Vercel, Drizzle/Neon) needs the same
capability for its dockmaster inbox, and it needs it now: AI-drafted
enquiry replies are the wedge for the forward-deployed work the marina
product is being sold on.

The decision, agreed in conversation: extract the venue-agnostic core of
`aiReplies.js` into a package both apps consume, and leave everything
product-shaped (venue facts, availability lookup, draft persistence,
approve-and-send, booking creation, metering) in each app. OTA is
refactored to consume the package first — it is the only real consumer
today, so it proves the boundary — and sidon-marina integrates against
the published version (its own spec).

Per-marina bespoke work then lives in the venue facts, the instructions
text, host rules and the availability tool; the package holds the stable
rails (prompt discipline, schema, safety and output guards).

## Goals

- `packages/ai-replies/` in this repo as an npm workspace, published to
  npm as `@forgebuild/ai-replies` (`access: public`, like
  `@forgebuild/hotal-ui`). Plain CommonJS JavaScript plus a hand-written
  `index.d.ts`; no build step. OTA `require`s it; sidon-marina (ESM,
  Vite SSR) imports it — Node loads CJS from ESM natively.
- `src/lib/aiReplies.js` becomes a thin OTA adapter with the **same
  exports and the same `generateInquiryReply` signature and result**, so
  `aiReplyPipeline.js`, `controllers/property.js` and
  `controllers/eventInquiries.js` — the only importers — are untouched.
- A runnable, assert-based check for the package that needs no API key.

## Non-goals

- No draft lifecycle in the package (pending/sending/sent, supersede,
  auto-send gate, cap). That is persistence, and the two apps' data
  layers (pg vs Drizzle/neon-http) differ enough that sharing it would
  mean an adapter interface for one real implementation. The lifecycle
  stays documented in the 08-29 spec as the contract sidon-marina mirrors.
- No sidon-marina code in this spec (see "Step 2" at the end).
- No TypeScript source, bundler, or README for the package; `index.d.ts`
  and this spec document it.
- No server-side refusal fallback (`fallbacks` parameter). The 08-29 spec
  made a `refusal` stop a `failed` draft on purpose; this refactor keeps
  that. Opting in later is a one-line change in the package.
- No streaming: drafts are ~4k output tokens at most, well inside the
  120 s client timeout.

## Package layout

```
packages/ai-replies/
  package.json     name @forgebuild/ai-replies, version 0.1.0, main index.js,
                   types index.d.ts, files [index.js, index.d.ts],
                   publishConfig.access public,
                   peerDependencies: @anthropic-ai/sdk >=0.117, zod ^4
                   scripts.check: node check.js
  index.js
  index.d.ts
  check.js
```

Root `package.json` gains `"workspaces": ["packages/*"]` and
`"@forgebuild/ai-replies": "*"` in `dependencies`; npm links the
workspace (locally and in Render's `npm install`) because `*` accepts any
workspace version -- a pinned range like `^0.1.0` would silently fall back
to the registry after a version bump. The peer deps resolve from the root `node_modules`.

## API

```js
const {
  generateReply, buildRequest, neutraliseTags, findCorruption,
  isConfigured, AiReplyError, MODEL, EFFORT,
} = require('@forgebuild/ai-replies');

const result = await generateReply({
  venue: {
    name,          // string
    facts,         // string | null — host-rendered inner text of <venue>: menus, hours, berths, tiers, policies
    instructions,  // string | null — the admin's free-text instructions (tone, policies, what not to promise)
  },
  rules,           // string | undefined — host-specific prompt sections appended to the frozen base (OTA: RETURNS)
  availabilityTool,// { definition, execute } | null
                   //   definition: Anthropic tool JSON, name must be 'check_availability'
                   //   execute(input) -> JSON-serialisable result or { error }
  bookingSchema,   // zod object | null — fields the model must settle before proposing a booking
  inquiry: {
    name,          // guest's name
    fields,        // Record<string, string | number | null | undefined>, rendered in insertion order; null, undefined and '' skipped (0 is rendered)
    message,       // the original enquiry text
    extra,         // string | undefined — pre-rendered XML placed inside <inquiry> after the fields (OTA: <return>)
  },
  thread,          // [{ direction: 'inbound' | 'outbound', body, created_at: Date | string }] oldest first
  triggerType,     // 'new_inquiry' | 'inbound_reply' | 'manual' (unknown -> manual)
  today,           // 'YYYY-MM-DD'; default: today UTC
  model,           // default MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5'
  effort,          // default EFFORT = 'medium'
  maxTokens,       // default 4000
  client,          // an Anthropic client; default: lazy singleton from ANTHROPIC_API_KEY, { timeout: 120_000, maxRetries: 2 }
});
// result: {
//   body, summary, quality_score (0-100, <= 40 when requires_human),
//   requires_human, requires_human_reason (null when false),
//   proposed_booking: object | null  (null when no bookingSchema was given),
//   model, usage: { input_tokens, output_tokens, cache_read_input_tokens },
// }
```

- `buildRequest(opts)` returns the exact first `messages.parse` request
  (`model`, `max_tokens`, `system`, `output_config`, `tools?`,
  `messages`) without calling the API. `generateReply` is built on it;
  the check and scratch scripts inspect it.
- `neutraliseTags(text)` replaces the `<` of any `<tag` or `</tag`
  sequence (a letter follows) with `‹`, so guest text can never open or
  close a tag — the package's own or a host's. Ordinary punctuation
  (`<3`, `a < b`) survives. Hosts use it when rendering `inquiry.extra`
  and may use it on `venue.facts`.
- `isConfigured()` is `!!process.env.ANTHROPIC_API_KEY`. A host passing
  its own `client` does not need it, and `generateReply` throws
  `not_configured` only when no `client` is passed and the key is unset.
- `AiReplyError` has `kind: 'not_configured' | 'refusal' | 'parse' |
  'rate_limit' | 'api' | 'network'` and `cause` where there is one,
  exactly as today.
- `findCorruption(text)` is today's regex, exported for scratch scripts.

## Prompt layout and rules

`system` is three cacheable text blocks, in this order:

1. `BASE_SYSTEM_PROMPT` — frozen in the package, byte-stable across hosts.
2. `rules` — frozen per host (omitted when not given).
3. `<venue name="…">facts</venue>\n\n<venue_instructions>instructions
   or "(none provided -- nearly every factual question will need a
   human)"</venue_instructions>` — per venue, carries the
   `cache_control: { type: 'ephemeral' }` breakpoint.

The user turn is the volatile part: `<inquiry>` (`<field
name="guest_name">`, one `<field>` per non-empty entry of `fields`,
`<field name="original_message">`, then `extra` verbatim), `<thread>`
(`<message from="guest|venue" at="ISO">…</message>`, or `(no replies
yet)`), `<trigger>…</trigger>`, `Today is YYYY-MM-DD. Write the venue's
next reply and assess it.` All guest-authored strings go through
`neutraliseTags`.

Changes to today's base prompt (everything not listed is unchanged):

- Opening line: "You draft replies on behalf of a business (a hotel,
  restaurant, venue, salon, marina or similar) to people who have sent an
  enquiry …" — no longer "email replies", no longer hospitality-only.
- BOOKING, generalised: when the guest has clearly settled every detail
  the proposal schema asks for and `check_availability` confirmed that
  exact slot in this same turn, fill `proposed_booking`; otherwise
  `null`. The system creates the real booking when the reply is approved
  and sent, so the reply reads as a confirmation. A proposal needs every
  field settled by the guest, not assumed. Without a proposal never tell
  the guest a booking is made. Changes and cancellations are for staff.
  What the fields mean comes from the host schema's `.describe()` text.
- TOOLS: "if the tool call errors (e.g. an unmatched treatment name), try
  again with a clearer match from the treatment names it returns" becomes
  "if the tool rejects an input, its result says what it accepts; try
  once more with that". Everything else in TOOLS unchanged.
- STYLE: "Plain text only" and the rest unchanged; "email" wording
  removed where it appears.
- RETURNS: removed from the base; it is OTA's `rules` text, verbatim.

## Assessment schema

```js
z.object({
  summary, body, requires_human, requires_human_reason, quality_score,  // as today
  proposed_booking: bookingSchema.nullable().describe(
    'The booking to make when this reply is approved and sent, or null when no booking is proposed. See BOOKING.'
  ),  // only when a bookingSchema is given
})
```

Nested objects and `anyOf` (nullable) are in the structured-output
JSON-schema subset; `format: date` (`z.iso.date()`) is enforced
server-side; `.regex()`/`.min()` are stripped by the SDK and checked
client-side, so hosts validate those themselves. Score clamping and the
≤ 40 rule stay in the package.

## Generation loop (unchanged behaviour, moved)

`messages.parse` with the request above; while `stop_reason ===
'tool_use'` and fewer than 4 rounds, execute every `tool_use` block in
parallel (an `execute` throw becomes `{ error }`), append results, call
again. Then: `refusal` → `AiReplyError('refusal')`; `max_tokens` or
still `tool_use` → `'parse'`; empty body → `'parse'`; corrupt body →
retry the whole attempt once, then `'parse'`. SDK errors map to
`rate_limit` / `network` / `api`, most specific first.

## OTA adapter (`src/lib/aiReplies.js`)

Keeps `module.exports = { isConfigured, generateInquiryReply,
findCorruption, AiReplyError, MODEL, EFFORT }` by re-exporting from the
package, and keeps `generateInquiryReply({ property, inquiry,
restaurant, spa, thread, triggerType, today, returnRequest })` returning
the same shape as today. Inside:

- `buildVenueFacts(property, restaurant, spa)` — today's
  `buildPropertyBlock` minus the `<venue>` / `<venue_instructions>`
  wrapping: the `<restaurant>` and `<spa>` blocks (services, regulars
  note, hours) and `<return_instructions>`.
- `RULES` — today's RETURNS section, verbatim.
- `BookingProposal = z.object({ treatment_name: z.string().describe(…exact
  name from check_availability results…), date: z.iso.date().describe(…),
  time: z.string().describe('HH:MM, 24-hour') })`.
- `renderReturn(returnRequest)` — today's `<return …><line …/><reason/>`
  block, using the package's `neutraliseTags`; passed as `inquiry.extra`.
- `availabilityTool` = `buildAvailabilityTool(inquiry)` wrapped as
  `{ definition, execute: (input) => executeAvailabilityTool(inquiry, input) }`;
  `aiReplyTools.js` is unchanged.
- Result mapping: `proposed_booking` becomes `{ treatment_name, date,
  time }` when present and `time` matches `^\d{2}:\d{2}$`, else `null`.
  The pipeline's inserts and `bookProposedSlot` see the same values as today.

## What changes for OTA

- Prompt bytes change (generalised wording, RETURNS moved into the
  second block), so each property's cached prefix is rebuilt once.
- `proposed_booking` travels as a nullable object instead of three
  empty-string fields. The adapter normalises; the draft table and the
  pipeline are unaffected.
- `neutraliseTags` now neutralises any tag, not a fixed list: a guest's
  `<br>` reads as `‹br>` in the prompt. Harmless.
- `MODEL` default is `claude-opus-5-5` when `ANTHROPIC_MODEL` is unset;
  Render pins `claude-opus-5` in `render.yaml`, so production is unchanged.
- Everything else — error kinds, retries, tool rounds, usage fields,
  timeouts — is the same code in a different file.

## Environment

`ANTHROPIC_API_KEY` (unset → `isConfigured() === false`,
`generateReply` throws `not_configured`) and `ANTHROPIC_MODEL`, read by
the package. Nothing new.

## Publishing

`npm publish --access public` from `packages/ai-replies`. This machine
is not logged in to npm (`npm whoami` → 401); one `npm login` is needed
first. sidon-marina then `npm install @forgebuild/ai-replies`. Later
versions: bump `version`, publish; OTA picks up the workspace copy
without a publish.

## Testing approach

No test framework, as before. `node packages/ai-replies/check.js`
(offline, `assert`-based) covers: guest text cannot close our tags;
venue block layout and the "(none provided …)" fallback; `fields`
order, empty-value skipping, `extra` placement; "(no replies yet)";
trigger text and the `manual` fallback; `proposed_booking` present in
the output format only when a schema is given; `findCorruption` hits
(`\ffffff`, control chars, U+FFFD) and misses (`£45`, `café`).
`LIVE=1 node packages/ai-replies/check.js` adds one real call with a
fake venue and asserts the result shape (opt-in, since it spends money).

For OTA, after the refactor: start the server and re-run the 08-30
live checks — plain enquiry in `draft` mode (score, facts only from
instructions, `cache_read_input_tokens` > 0 from the second call); "150
people and a discount?" → `requires_human`; a prompt-injection message →
`requires_human`; a spa enquiry settling on a treatment, date and time
→ `proposed_treatment_name/date/time` stored on the draft; an enquiry
on a return thread → no proposal. `POST /:id/ai-drafts` on an existing
inquiry is enough to drive each.

## Order of work

1. Package + check, committed.
2. `npm login` (user), publish 0.1.0.
3. OTA adapter refactor + live re-check; sidon-marina integration starts
   in parallel against the published version.

## Step 2 (separate spec): sidon-marina

For orientation only. `marina_ai_draft` table keyed by `owner_id` +
thread key; `ai_reply_mode` / `ai_reply_instructions` /
`ai_reply_auto_send_min_score` on `marina_profile`; venue facts from the
profile, berths, price tiers and document requirements; the availability
tool over the existing berth-availability query (arrival, departure,
LOA, beam); proposal `{ berth_id, arrival, departure }`; triggered from
the sailor-message endpoints (Vercel needs `waitUntil`, not
fire-and-forget); approve → the existing marina-reply path; approve and
reject in `MarinaInbox`. The reply channel is in-app chat, so the host's
`rules` set the chat style.
