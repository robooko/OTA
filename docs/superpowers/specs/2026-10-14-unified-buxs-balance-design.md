# One BUXS balance per org, held in OTA

Agreed with Robert, 14 Oct 2026. Supersedes the per-property token model of
`migrate-2026-09-01-property-token-billing.sql` and the Clerk-metadata
balances in forge and forge-app.

## Problem

Three balances exist today and none of them talk to each other:

| Balance | Owner | Lives in | Bought on | Spent by |
|---|---|---|---|---|
| FORGE BUXS | Clerk org | org `private_metadata.tokenBudget` | forge-build.co.uk | nothing |
| forge-app BUXS | Clerk user | user `unsafe_metadata.tokenBudget` (`main`; the unmerged `buxs-private-metadata` branch moves it to `private_metadata`) | forge-app (old webhook) | forge-app `generate.ts`, `build-astro.ts` |
| HOTAL tokens | OTA property | `property.token_balance` | dashboard Settings → Billing / header popover | `ai_reply`, `reply_send` |

So BUXS bought on FORGE can't be spent, the dashboard shows a different
number from FORGE's header for the same org, and forge-app's balance on
`main` is browser-writable.

## Decisions

1. **Owner: the Clerk org.** One balance per org, shared by every property
   and member. OTA's `organization` table (2026-10-11) holds it.
2. **Unit: BUXS** (weighted Claude tokens, forge-app's existing unit),
   priced at **£40 per 1M** (£10–£1,000 in £10 steps, FORGE's slider).
   HOTAL's flat-fee actions keep their £ price: 1 old token (£0.10) =
   **2,500 BUXS**, so `ai_reply` and `reply_send` cost 2,500 each.
3. **OTA is the source of truth**, reached server-to-server. forge and
   forge-app keep their own Stripe accounts and checkouts; only the balance
   moves.
4. **forge-app builds need an active org.** Leftover user balances fold
   into the user's first org once.
5. **Starter grant: 50,000 BUXS per new org** (equal to both old grants: 20
   HOTAL tokens × 2,500, and forge-app's `FREE_TOKEN_GRANT`). Per org, not
   per property or per user.

## OTA

### Schema (one migration, idempotent)

- `organization.buxs_balance BIGINT NOT NULL DEFAULT 0`.
- New `buxs_ledger`: `id`, `clerk_org_id NOT NULL`, `property_id NULL`
  (set for HOTAL actions), `delta BIGINT`, `balance_after BIGINT`,
  `reason VARCHAR(40)`, `ref_id TEXT`, `source VARCHAR(20)` (`hotal` |
  `forge` | `forge-app` | `migration`), `idem_key TEXT UNIQUE` (credits and
  migration moves; NULL for spends), `created_at`. Index on
  `(clerk_org_id, created_at DESC)`.
- Ensure an `organization` row for every `property.clerk_org_id`
  (`INSERT … ON CONFLICT DO NOTHING`, `api_key` NULL).
- Seed: per org, `buxs_balance = SUM(property.token_balance) × 2500`, one
  `migration` ledger row per org with `idem_key = 'hotal-migration:<org>'`.
  `property_token_ledger` rows are copied across (delta × 2500) so the
  activity history survives.
- `property.token_balance` and `property_token_ledger` stay read-only until
  the cleanup migration drops them, after forge and forge-app are on OTA.

Every org row needs to exist before a spend or credit: `organization.js`
already inserts one on org creation; the auth auto-create path gets the
same insert.

### `src/lib/tokens.js` (org-level)

- `getBalance(orgId)`.
- `spend(orgId, amount, reason, { propertyId, refId, source })`: one
  `UPDATE organization SET buxs_balance = buxs_balance - $amount WHERE
  clerk_org_id = $org AND buxs_balance >= $amount RETURNING buxs_balance`,
  plus the ledger row, in one transaction. No row → `{ ok: false, balance }`.
  HOTAL callers pass `TOKEN_COSTS[reason]`; forge-app passes its measured
  usage.
- `credit(orgId, amount, reason, { idemKey, refId, propertyId, source })`:
  locks the org row, returns `{ credited: false }` when `idemKey` is
  already in the ledger. Replaces `checkoutSessionId`.
- `TOKEN_COSTS = { ai_reply: 2500, reply_send: 2500 }`;
  `STARTER_BALANCE = 50_000` (env `BUXS_STARTER_BALANCE`), granted on org
  creation with `idem_key = 'starter:<org>'`, so it's once per org whichever
  path creates it.
- Callers (`aiReplyPipeline.js`, `inquiryReplies.js`) pass the
  inquiry's property's org; behaviour at zero is unchanged (fallback email,
  402 on manual send).

### Purchases (dashboard)

`platformStripe.js` drops `TOKEN_PACKS` for an amount: `£MIN_GBP`–`£MAX_GBP`
in `£STEP_GBP` (10 / 1000 / 10), `TOKENS_PER_POUND = 25_000`, the same
constants as forge's `src/lib/buxs.ts`. `/api/billing/payment-intent` and
`/checkout` take `{ amount_gbp }` instead of `{ pack }`, validated the same
way. Webhook and confirm routes credit the active org with
`idem_key = <PaymentIntent or Session id>`. `GET /api/billing` returns
`balance` (the org's), `costs`, `currency`, `min_gbp`/`max_gbp`/`step_gbp`/
`tokens_per_pound` instead of `packs`. `/ledger` lists the org's
`buxs_ledger` (all sources).

### Service API (`src/routes/buxs.js`)

All three require `X-Buxs-Secret: $BUXS_SERVICE_SECRET` (constant-time
compare); no Clerk auth, because forge and forge-app vouch for the org from
their own verified Clerk session.

- `GET /api/buxs/balance?org=<clerk_org_id>` → `{ balance }` (0 for an
  unknown org).
- `POST /api/buxs/spend` `{ org, amount, reason, ref, source, partial? }` →
  `{ spent, balance }` or `402 { balance }`. With `partial: true` it never
  402s: it debits `min(amount, balance)` (forge-app's after-the-fact
  charge, below).
- `POST /api/buxs/credit` `{ org, amount, reason, idem_key, ref, source }` →
  `{ credited, balance }`. Creates the org row if missing.

Amounts are positive integers ≤ 50,000,000 (£2,000 of BUXS); anything else
is 400.

## forge (forge-build.co.uk)

- `src/lib/ota.ts`: tiny client for the three routes (`OTA_API_BASE_URL`,
  `BUXS_SERVICE_SECRET`).
- `/api/buxs-balance` → `GET /balance?org=<session orgId>`.
- `creditBuxs(orgId, tokens, ref)` → `POST /credit` with `idem_key = ref`;
  `creditedSessions` in Clerk goes away.
- WebMCP `list_organisations` keeps reporting the active org's balance, now
  from OTA.

## forge-app

- Active org required for `generate.ts` / `build-astro.ts` (`403
  { error: 'no_org' }`); the build UI opens Clerk's Create organisation,
  then retries.
- Before the model call: `GET /balance`; empty → today's out-of-tokens
  path. After: `POST /spend` with `partial: true`, the weighted usage
  (`computeTokensUsed`) and `ref` = build id. The usage is only known after
  the call, so a balance that runs short is drained to zero rather than
  refused; the shortfall is the platform's loss, same as today's
  `Math.max(0, …)`.
- `TokenBudget.astro` / `token-budget.ts` / `AuthIsland.astro` read the org
  balance from OTA; the 50k per-user grant goes (the org starter replaces
  it).
- `tokenUsageLog` stays in user `unsafe_metadata` as display only.
- `admin.astro` lists org balances from OTA instead of user metadata.
- The `buxs-private-metadata` branch is not merged; its webhook removal is
  already superseded by this.

## One-time Clerk → OTA move

A script in OTA (`scripts/migrate-clerk-buxs.js`, Clerk secret from env):

1. For every Clerk org with `private_metadata.tokenBudget > 0`: `credit`
   with `idem_key = 'clerk-org:<orgId>'`, source `migration`, then clear
   the field.
2. For every user with a `tokenBudget` (private or unsafe metadata, the
   larger if both), all of it moves: users with an org credit their first
   org (oldest membership) with `idem_key = 'clerk-user:<userId>'`, then
   the field is cleared. Users without an org are left untouched.
3. forge-app, on the first build after a user gets an org, runs step 2 for
   that user (same idem key, so it can't double-credit).

`--dry-run` prints the per-org totals before anything is written. Robert
checks them against Clerk before the real run.

## Dashboard (ota-table-bookings)

- Header pill and Settings show BUXS in FORGE's format (`2.25M`, `277.5K`);
  label "BUXS", not "tokens".
- The popover buyer becomes FORGE's £ slider (count in BUXS, price in £),
  posting `{ amount_gbp }`.
- Settings costs read "AI reply draft: 2,500 BUXS · Reply sent: 2,500
  BUXS"; the activity list shows every source (FORGE purchase, forge-app
  build, AI draft) with its property where it has one.

## Errors

- OTA unreachable: forge-app refuses the build ("Couldn't check your BUXS,
  try again"); forge's header pill stays hidden; a FORGE purchase still
  succeeds at Stripe, and the webhook's credit fails → Stripe retries the
  webhook (non-2xx), and the idem key makes the retry safe.
- HOTAL behaviour at zero is unchanged.
- The service secret is never sent to a browser; forge and forge-app call
  OTA from their server routes only.

## Testing

- `scripts/check-buxs.js` (alongside `check-marina.js`): concurrent spends
  can't go below zero; a repeated credit `idem_key` credits once; starter
  is once per org; spend/credit write matching ledger rows; the service
  routes reject a missing or wrong secret.
- Migration: run against a copy of live, compare per-org sums with the
  dry-run output.

## Order

1. OTA: migration, `tokens.js`, billing routes, service API, check script.
   Deploy (old dashboard keeps working: `GET /api/billing` still returns
   `balance`).
2. Dashboard: BUXS display and £ slider.
3. forge: read/credit via OTA.
4. Clerk → OTA move script (dry run, then real).
5. forge-app: org-required builds spending via OTA.
6. Cleanup migration: drop `property.token_balance`,
   `property_token_ledger`.

Each of 2, 3 and 5 starts in its own repo's session.
