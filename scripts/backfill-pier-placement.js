// Places berths from pontoon drawings saved before placement ran on save
// (c7c2614): any active pontoon whose drawn berths still lack lat/lng.
//   node scripts/backfill-pier-placement.js          dry run
//   node scripts/backfill-pier-placement.js --apply
// DATABASE_URL picks the DB (DATABASE_URL_LIVE for prod).
require('dotenv').config();
const pool = require('../src/db');
const { applyPlacement } = require('../src/lib/pierPlacement');

(async () => {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query(`
    SELECT p.*, m.name AS marina FROM marina_pontoon p JOIN marina m ON m.id = p.marina_id
     WHERE p.status = 'active' AND p.svg_data IS NOT NULL
       AND EXISTS (SELECT 1 FROM marina_berth b WHERE b.marina_id = p.marina_id AND b.lat IS NULL AND b.status <> 'inactive'
                     AND p.svg_data LIKE '%data-berth-id="' || b.label || '"%')`);
  for (const p of rows) {
    if (!apply) { console.log(`would place: ${p.marina} / ${p.name}`); continue; }
    console.log(`${p.marina} / ${p.name}:`, await applyPlacement(pool, p));
  }
  if (!rows.length) console.log('nothing to place');
  await pool.end();
})();
