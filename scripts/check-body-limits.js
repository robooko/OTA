// 500-item imports and the MCP calls carrying them get past the JSON body
// limit (5 MB on those paths); everything else keeps the 100 kB default.
// Boots the app on a free port and posts unauthenticated, so nothing is written.
//   node -r dotenv/config scripts/check-body-limits.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const app = require('../src/app');

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => ({ external_ref: `R${i}`, note: 'x'.repeat(200) })) }); // ~1 MB
  const post = async (path) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status;
  let failed = 0;
  const expect = async (path, tooLarge) => {
    const status = await post(path);
    const ok = tooLarge ? status === 413 : status !== 413;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${path} -> ${status}`);
  };
  try {
    for (const p of ['/api/mcp', '/api/bookings/import', '/api/restaurant-orders/import', '/api/event-inquiries/bulk',
      '/api/spa/00000000-0000-0000-0000-000000000000/appointments/import',
      '/api/spa/00000000-0000-0000-0000-000000000000/appointments/bulk']) await expect(p, false);
    for (const p of ['/api/guests', '/api/spa/00000000-0000-0000-0000-000000000000/appointments']) await expect(p, true);
  } finally {
    server.close();
  }
  assert.equal(failed, 0, `${failed} failed`);
  console.log('\nall passed');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
