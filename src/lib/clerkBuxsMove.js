// Plans the one-time move of BUXS balances out of Clerk metadata into OTA
// wallets (scripts/migrate-clerk-buxs.js does the writing). Pure, so the
// plan can be printed and checked before anything is credited.

const budget = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// FORGE sold BUXS to orgs: private_metadata.tokenBudget.
function planOrgMoves(orgs) {
  return orgs
    .map((o) => ({ owner: o.id, amount: budget(o.privateMetadata?.tokenBudget), idemKey: `clerk-org:${o.id}`, label: o.name }))
    .filter((m) => m.amount > 0);
}

// forge-app kept a per-user balance: unsafe_metadata on main, private on its
// unmerged branch. Whichever is larger moves, whole, into the user's oldest
// org. A user with no org keeps it in Clerk for now; forge-app moves it
// (same idem key) once they create one.
function planUserMoves(users, membershipsByUser) {
  const moves = [];
  for (const u of users) {
    const amount = Math.max(budget(u.privateMetadata?.tokenBudget), budget(u.unsafeMetadata?.tokenBudget));
    if (!amount) continue;
    const oldest = [...(membershipsByUser.get(u.id) ?? [])].sort((a, b) => a.createdAt - b.createdAt)[0];
    moves.push(oldest
      ? { userId: u.id, owner: oldest.organization.id, amount, idemKey: `clerk-user:${u.id}` }
      : { userId: u.id, amount, skipped: 'no organisation yet' });
  }
  return moves;
}

module.exports = { planOrgMoves, planUserMoves };
