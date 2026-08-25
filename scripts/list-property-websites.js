// Lists property_website rows for one property.
//   node scripts/list-property-websites.js <property-id> [--live]
require('dotenv').config();
const { Client } = require('pg');

const id = process.argv[2];
const live = process.argv.includes('--live');
const url = process.env[live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL'];
if (!id || !url) {
  console.error('usage: node scripts/list-property-websites.js <property-id> [--live]');
  process.exit(1);
}

(async () => {
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT id, url, label, vercel_project_id, status, created_at FROM property_website WHERE property_id = $1', [id]);
    for (const r of rows) console.log(`${r.id} | ${r.url} | ${r.label ?? '-'} | vercel=${r.vercel_project_id ?? '-'} | ${r.status} | ${r.created_at.toISOString().slice(0, 10)}`);
  } finally {
    await client.end();
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
