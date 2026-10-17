// Lists active marina document requirements whose type isn't in the shared
// sailor document vocabulary: those can never be met by a sailor document,
// so fix them before switching a marina's sailor_documents on. Read-only.
//   node -r dotenv/config scripts/report-requirement-types.js
const pool = require('../src/db');
const { TYPE_NAMES } = require('../src/lib/sailorDocTypes');

(async () => {
  const { rows } = await pool.query(
    `SELECT m.name AS marina, m.slug, r.type, r.name, r.mandatory FROM marina_doc_requirement r JOIN marina m ON m.id = r.marina_id
     WHERE r.status = 'active' AND NOT (r.type = ANY($1)) ORDER BY m.name, r.sort_order, r.name`, [TYPE_NAMES]);
  if (!rows.length) console.log('All active requirement types are in the shared vocabulary.');
  for (const r of rows) console.log(`${r.marina} (${r.slug}): type "${r.type}" -- ${r.name}${r.mandatory ? ' [mandatory]' : ''}`);
  console.log(`\nAllowed: ${TYPE_NAMES.join(', ')}`);
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
