// Courses checks. Pure helpers are asserted directly; HTTP checks run the
// real app on an ephemeral port with fixtures committed under a throwaway
// property and deleted at the end (pass or fail). Local DB only, with
// migrate-2026-10-15-courses.sql applied.
//   node -r dotenv/config scripts/check-courses.js
delete process.env.RESEND_API_KEY;
delete process.env.ABLY_API_KEY;
const assert = require('node:assert/strict');
const crypto = require('crypto');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
const { sessionDates, ageOn } = require('../src/lib/courseSessions');
const { isValidDate } = require('../src/middleware/validate');

(async () => {
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };

  // ---- Task 1: pure helpers ----
  await check('sessionDates: Mon-Fri camp week', async () => {
    assert.deepEqual(sessionDates({ start_date: '2030-07-01', end_date: '2030-07-05', weekdays: [1, 2, 3, 4, 5], skip_dates: [] }),
      ['2030-07-01', '2030-07-02', '2030-07-03', '2030-07-04', '2030-07-05']);
  });
  await check('sessionDates: Saturdays with a skip date', async () => {
    assert.deepEqual(sessionDates({ start_date: '2030-09-07', end_date: '2030-09-28', weekdays: [6], skip_dates: ['2030-09-14'] }),
      ['2030-09-07', '2030-09-21', '2030-09-28']);
  });
  await check('sessionDates: single-day run, and no matching weekday', async () => {
    assert.deepEqual(sessionDates({ start_date: '2030-07-01', end_date: '2030-07-01', weekdays: [1], skip_dates: [] }), ['2030-07-01']);
    assert.deepEqual(sessionDates({ start_date: '2030-07-01', end_date: '2030-07-01', weekdays: [0], skip_dates: [] }), []);
  });
  await check('ageOn: birthday on the date counts', async () => {
    assert.equal(ageOn('2018-07-01', '2030-07-01'), 12);
    assert.equal(ageOn('2018-07-02', '2030-07-01'), 11);
    assert.equal(ageOn('2017-07-01', '2030-07-01'), 13);
  });
  await check('isValidDate rejects impossible dates', async () => {
    assert.equal(isValidDate('2030-02-28'), true);
    assert.equal(isValidDate('2030-02-30'), false);
    assert.equal(isValidDate('2030-13-01'), false);
  });
  await check('DATE[] reads back as strings', async () => {
    const { rows: [r] } = await pool.query("SELECT ARRAY['2030-12-25','2030-12-26']::date[] AS d, '{}'::date[] AS e");
    assert.deepEqual(r.d, ['2030-12-25', '2030-12-26']);
    assert.deepEqual(r.e, []);
  });

  // HTTP_CHECKS (Tasks 2-4 insert their blocks here)

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
