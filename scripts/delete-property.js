// Deletes one property row -- for cleaning up a property that was
// auto-provisioned by the auth middleware for a Clerk org that has since
// been deleted. Refuses if any table still references it (every child
// table has a property_id FK), so a property with real data can't be
// removed by accident. --with-websites also drops its property_website
// rows first: those are config, not guest data, and a stray property
// often has one from someone poking at Settings.
//   node scripts/delete-property.js <property-id> [--live] [--with-websites]
require('dotenv').config();
const { Client } = require('pg');

const id = process.argv[2];
const live = process.argv.includes('--live');
const withWebsites = process.argv.includes('--with-websites');
if (!id) {
  console.error('usage: node scripts/delete-property.js <property-id> [--live]');
  process.exit(1);
}
const url = process.env[live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL'];
if (!url) {
  console.error(`${live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL'} is not set`);
  process.exit(1);
}

(async () => {
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows: props } = await client.query('SELECT id, name, clerk_org_id FROM property WHERE id = $1', [id]);
    if (!props.length) {
      console.error('Property not found');
      process.exit(1);
    }

    if (withWebsites) {
      const { rowCount } = await client.query('DELETE FROM property_website WHERE property_id = $1', [id]);
      console.log(`Removed ${rowCount} property_website row(s)`);
    }

    const { rows: refs } = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'property_id' AND table_schema = 'public' AND table_name <> 'property'
       ORDER BY table_name`
    );
    const nonEmpty = [];
    for (const { table_name } of refs) {
      const { rows } = await client.query(`SELECT COUNT(*) FROM "${table_name}" WHERE property_id = $1`, [id]);
      const n = parseInt(rows[0].count, 10);
      if (n > 0) nonEmpty.push(`${table_name}=${n}`);
    }
    if (nonEmpty.length) {
      console.error(`Refusing to delete "${props[0].name}": still referenced by ${nonEmpty.join(', ')}`);
      process.exit(1);
    }

    await client.query('DELETE FROM property WHERE id = $1', [id]);
    console.log(`Deleted property "${props[0].name}" (${id}, org ${props[0].clerk_org_id ?? '-'}) -- no dependent rows in ${refs.length} tables`);
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
