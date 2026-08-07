// One-off data migration: copies schema + rows from the old Render Postgres
// instance to a new target (Neon) database. Run with:
//   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node scripts/migrate-to-neon.js
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Keep DATE columns as raw 'YYYY-MM-DD' strings so copying doesn't shift the
// calendar day for whatever timezone this script happens to run in.
types.setTypeParser(1082, (val) => val);

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;

if (!SOURCE_URL || !TARGET_URL) {
  console.error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL env vars.');
  process.exit(1);
}

const source = new Pool({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
const target = new Pool({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

const BATCH_SIZE = 500;

function getTablesInOrder(schemaSql) {
  const tables = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+)/g;
  let m;
  while ((m = re.exec(schemaSql))) tables.push(m[1]);
  return tables;
}

async function copyTable(table) {
  const { rows } = await source.query(`SELECT * FROM ${table}`);
  if (rows.length === 0) {
    console.log(`${table}: 0 rows`);
    return;
  }
  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(', ');

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, r) => {
      const base = r * columns.length;
      columns.forEach((c) => values.push(row[c]));
      return `(${columns.map((_, c) => `$${base + c + 1}`).join(', ')})`;
    });
    await target.query(
      `INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(', ')}`,
      values
    );
  }
  console.log(`${table}: copied ${rows.length} rows`);
}

async function main() {
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

  console.log('Applying schema to target...');
  await target.query(schemaSql);

  const tables = getTablesInOrder(schemaSql);
  console.log(`Copying ${tables.length} tables in FK-safe order...`);
  for (const table of tables) {
    await copyTable(table);
  }

  console.log('Refreshing materialized view...');
  await target.query('REFRESH MATERIALIZED VIEW room_type_availability');

  console.log('Verifying row counts...');
  let mismatches = 0;
  for (const table of tables) {
    const [{ rows: [srcRow] }, { rows: [dstRow] }] = await Promise.all([
      source.query(`SELECT COUNT(*) FROM ${table}`),
      target.query(`SELECT COUNT(*) FROM ${table}`),
    ]);
    if (srcRow.count !== dstRow.count) {
      mismatches++;
      console.warn(`MISMATCH ${table}: source=${srcRow.count} target=${dstRow.count}`);
    }
  }
  console.log(mismatches === 0 ? 'All row counts match.' : `${mismatches} table(s) mismatched.`);

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
