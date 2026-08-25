// Lists properties (id, name, clerk_org_id, created_at) in DATABASE_URL or,
// with --live, DATABASE_URL_LIVE -- for reconciling against Clerk's orgs.
//   node scripts/list-properties.js [--live]
require('dotenv').config();
const { Client } = require('pg');

const live = process.argv.includes('--live');
const url = process.env[live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL'];
if (!url) {
  console.error(`${live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL'} is not set`);
  process.exit(1);
}

(async () => {
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT p.id, p.name, p.clerk_org_id, p.created_at,
              (SELECT COUNT(*) FROM restaurant r WHERE r.property_id = p.id) AS restaurants,
              (SELECT COUNT(*) FROM room_type rt WHERE rt.property_id = p.id) AS room_types,
              (SELECT COUNT(*) FROM booking b WHERE b.property_id = p.id) AS bookings
       FROM property p ORDER BY p.created_at`
    );
    for (const r of rows) {
      console.log(`${r.id} | ${r.name} | ${r.clerk_org_id ?? '-'} | ${r.created_at.toISOString().slice(0, 10)} | restaurants=${r.restaurants} room_types=${r.room_types} bookings=${r.bookings}`);
    }
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
