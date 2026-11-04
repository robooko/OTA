// Channel distribution checks (spec 2026-11-04-channel-distribution-design).
// Runs the real app on an ephemeral port with fixtures under throwaway
// properties, deleted at the end (pass or fail). Local DB only, with
// migrate-2026-11-04-channels.sql applied.
//   node -r dotenv/config scripts/check-channels.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const apiKeys = require('../src/lib/apiKeys');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

  const app = require('../src/app');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `channels_check_${tag}`;
  const P = (await one(`INSERT INTO property (name, timezone, currency) VALUES ('Channel Check', 'Europe/London', 'EUR') RETURNING id`)).id;
  await apiKeys.create(pool, { property_id: P }, { key: KEY });
  const Q = (await one(`INSERT INTO property (name) VALUES ('Channel Check Other') RETURNING id`)).id;
  await apiKeys.create(pool, { property_id: Q }, { key: `${KEY}_other` });

  try {
    await check('schema: channel tables and booking columns exist', async () => {
      for (const t of ['channel', 'channel_mapping', 'channel_trim', 'channel_ari', 'channel_reservation_log']) {
        assert.ok((await one('SELECT to_regclass($1) AS r', [t])).r, t);
      }
      const cols = (await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'booking' AND column_name IN ('channel_id', 'channel_ref')`)).rows;
      assert.equal(cols.length, 2);
    });
  } finally {
    const props = [P, Q];
    const has = async (t) => (await one('SELECT to_regclass($1) AS r', [t])).r;
    await pool.query('DELETE FROM payment WHERE property_id = ANY($1)', [props]);
    if (await has('channel_reservation_log')) await pool.query('DELETE FROM channel_reservation_log WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM booking WHERE property_id = ANY($1)', [props]);
    if (await has('channel')) await pool.query('DELETE FROM channel WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_availability WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_type_rate WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM rate_plan WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM room_type WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM guest WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    await pool.query('REFRESH MATERIALIZED VIEW room_type_availability').catch(() => {});
    server.close();
  }

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
