// Money columns hold IDR amounts past Rp 100M (migrate-2026-11-06-money-precision.sql).
// Local DB only.   node -r dotenv/config scripts/check-money-precision.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');

(async () => {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const narrow = (await pool.query(`SELECT table_name || '.' || column_name c FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'numeric' AND numeric_scale = 2 AND numeric_precision < 14`)).rows
    .map((r) => r.c).filter((c) => !/^(property\.(tax_rate|oversell_max_pct)|rate_plan\.adjustment_pct|equipment_hire\.duration|hk_inspection\.score|marina_.*_m)$/.test(c));
  assert.deepEqual(narrow, [], `money columns still narrower than NUMERIC(14,2): ${narrow}`);

  const P = (await one(`INSERT INTO property (name, currency) VALUES ('Money Check', 'IDR') RETURNING id`)).id;
  try {
    const R = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'R', 90) RETURNING id`, [P])).id;
    const o = await one(`INSERT INTO restaurant_order (property_id, restaurant_id, contact_name, total_price) VALUES ($1, $2, 'X', 150000000) RETURNING total_price`, [P, R]);
    assert.equal(o.total_price, '150000000.00');
    const T = (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Villa', 2, 250000000) RETURNING base_rate`, [P]));
    assert.equal(T.base_rate, '250000000.00');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    console.log('all passed');
  } finally {
    for (const t of ['restaurant_order', 'restaurant', 'room_type']) await pool.query(`DELETE FROM ${t} WHERE property_id = $1`, [P]);
    await pool.query('DELETE FROM property WHERE id = $1', [P]);
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
