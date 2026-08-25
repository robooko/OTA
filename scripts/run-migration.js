// Runs one src/db/migrate-*.sql file against DATABASE_URL and, when set,
// DATABASE_URL_LIVE -- both DBs need every schema change (see README).
//   node scripts/run-migration.js src/db/migrate-2026-08-25-restaurant-website.sql
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/run-migration.js <migration.sql>');
  process.exit(1);
}
const sql = fs.readFileSync(file, 'utf8');

(async () => {
  for (const key of ['DATABASE_URL', 'DATABASE_URL_LIVE']) {
    const url = process.env[key];
    if (!url) {
      console.log(`${key}: not set, skipped`);
      continue;
    }
    const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query(sql);
      console.log(`${key}: ok`);
    } finally {
      await client.end();
    }
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
