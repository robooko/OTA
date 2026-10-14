// After deploying the BUXS code: moves credits the old code made after the
// wallet migration into the wallets (see src/lib/buxsReconcile.js). Safe to
// re-run.
//   node -r dotenv/config scripts/reconcile-buxs-migration.js [--live]
if (process.argv.includes('--live')) {
  if (!process.env.DATABASE_URL_LIVE) throw new Error('--live needs DATABASE_URL_LIVE');
  process.env.DATABASE_URL = process.env.DATABASE_URL_LIVE;
}
const pool = require('../src/db');
const { reconcileAfterMigration } = require('../src/lib/buxsReconcile');

reconcileAfterMigration()
  .then((r) => console.log(`checked ${r.checked} old-ledger credit(s) since the migration, moved ${r.moved}`))
  .finally(() => pool.end());
