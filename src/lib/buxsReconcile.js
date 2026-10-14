// Run once after the BUXS deploy. Credits the old code made to
// property_token_ledger between the wallet migration and the deploy going
// live (a Stripe purchase, a starter grant, a refund) would otherwise never
// reach buxs_wallet: the seed has run and won't run again. Also the recovery
// path if a deploy fails after the migration ran.
//
// Idempotent: a purchase on its Stripe id, any other credit on
// 'legacy:<old ledger id>', and a starter through grantStarter (once per
// owner, as for any new property). Spends in that window stay lost, in the
// customer's favour.
const pool = require('../db');
const tokens = require('./tokens');

async function reconcileAfterMigration() {
  const { rows } = await pool.query(
    `SELECT id, property_id, delta, reason, ref_id, stripe_checkout_session_id
     FROM property_token_ledger
     WHERE delta > 0
       AND created_at >= (SELECT created_at FROM buxs_ledger WHERE idem_key = 'hotal-migration')
     ORDER BY created_at, id`
  );
  let moved = 0;
  for (const r of rows) {
    const result = r.reason === 'starter'
      ? await tokens.grantStarter(r.property_id)
      : await tokens.credit(r.property_id, r.delta * 2500, r.reason, {
        refId: r.ref_id,
        idemKey: r.stripe_checkout_session_id || `legacy:${r.id}`,
      });
    if (result.credited) moved++;
  }
  return { checked: rows.length, moved };
}

module.exports = { reconcileAfterMigration };
