// Moves BUXS balances out of Clerk metadata into OTA wallets, once.
//   --orgs   FORGE's org balances (private_metadata.tokenBudget). Run right
//            after forge reads its balance from OTA (Plan C).
//   --users  forge-app's per-user balances. Run right after forge-app spends
//            through OTA (Plan D) -- earlier, forge-app would see an emptied
//            balance and re-grant its free 50k.
//   --dry-run  print the plan, write nothing.
//   --live     use DATABASE_URL_LIVE and CLERK_SECRET_KEY_LIVE instead.
// Credits first, then clears the Clerk field. Each credit is idempotent
// (clerk-org:<id> / clerk-user:<id>), so a re-run after a partial failure is
// safe.
//   node -r dotenv/config scripts/migrate-clerk-buxs.js --orgs --dry-run
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
if (live) {
  if (!process.env.DATABASE_URL_LIVE || !process.env.CLERK_SECRET_KEY_LIVE) {
    throw new Error('--live needs DATABASE_URL_LIVE and CLERK_SECRET_KEY_LIVE');
  }
  process.env.DATABASE_URL = process.env.DATABASE_URL_LIVE;
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY_LIVE;
}
const mode = args.has('--orgs') ? 'orgs' : args.has('--users') ? 'users' : null;
if (!mode) throw new Error('pass --orgs or --users');
const dryRun = args.has('--dry-run');

const { createClerkClient } = require('@clerk/backend');
const pool = require('../src/db');
const tokens = require('../src/lib/tokens');
const { planOrgMoves, planUserMoves } = require('../src/lib/clerkBuxsMove');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function all(list) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const { data, totalCount } = await list({ limit: 100, offset });
    out.push(...data);
    if (!data.length || out.length >= totalCount) return out;
  }
}

(async () => {
  let moves;
  if (mode === 'orgs') {
    moves = planOrgMoves(await all((p) => clerk.organizations.getOrganizationList(p)));
  } else {
    const users = await all((p) => clerk.users.getUserList(p));
    const memberships = new Map();
    for (const u of users) {
      const { data } = await clerk.users.getOrganizationMembershipList({ userId: u.id, limit: 100 });
      memberships.set(u.id, data);
    }
    moves = planUserMoves(users, memberships);
  }

  console.log(`${live ? 'LIVE' : 'local'} ${mode}${dryRun ? ' (dry run)' : ''}: ${moves.length} balance(s)`);
  let total = 0;
  let failed = 0;
  for (const m of moves) {
    const who = m.label ?? m.userId;
    if (m.skipped) { console.log(`skip   ${who}: ${m.amount} (${m.skipped})`); continue; }
    total += m.amount;
    if (dryRun) { console.log(`plan   ${who} -> ${m.owner}: ${m.amount}`); continue; }
    try {
      const r = await tokens.creditTo(m.owner, m.amount, 'migration', { idemKey: m.idemKey, source: 'migration' });
      if (mode === 'orgs') {
        await clerk.organizations.updateOrganizationMetadata(m.owner, { privateMetadata: { tokenBudget: null, creditedSessions: null } });
      } else {
        await clerk.users.updateUserMetadata(m.userId, { privateMetadata: { tokenBudget: null }, unsafeMetadata: { tokenBudget: null } });
      }
      console.log(`${r.credited ? 'moved ' : 'again '} ${who} -> ${m.owner}: ${m.amount} (wallet ${r.balance})`);
    } catch (err) {
      failed++;
      console.log(`FAIL   ${who}: ${err.message}`);
    }
  }
  console.log(`total ${total}${failed ? `, ${failed} failed (re-run to retry)` : ''}`);
  await pool.end();
  process.exitCode = failed ? 1 : 0;
})();
