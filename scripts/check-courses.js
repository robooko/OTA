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
const app = require('../src/app');

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

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = crypto.randomBytes(4).toString('hex');
  const KEY = `courses_check_${tag}`;
  const OTHER_KEY = `courses_check_other_${tag}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, api_key) VALUES ('Course Check', $1) RETURNING id`, [KEY])).id;
  const Q = (await one(`INSERT INTO property (name, api_key) VALUES ('Course Check Other', $1) RETURNING id`, [OTHER_KEY])).id;
  // ponytail: ~60 requests on one key, under the 100/window API-key limit; split keys if checks grow past it.
  const api = async (method, path, body, key = KEY) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, text };
  };
  const camp = { start_date: '2030-07-01', end_date: '2030-07-05', weekdays: [1, 2, 3, 4, 5], start_time: '10:00', end_time: '14:00', capacity: 10 };

  try {
    // ---- Task 2: courses and runs ----
    let course, run;
    await check('create course; validation', async () => {
      assert.equal((await api('POST', '/api/courses', { name: 'Kids Sailing', price: -1 })).status, 400);
      assert.equal((await api('POST', '/api/courses', { name: 'Kids Sailing', price: 200, min_age: 12, max_age: 8 })).status, 400);
      const r = await api('POST', '/api/courses', { name: 'Kids Sailing', price: 200, min_age: 8, max_age: 12 });
      assert.equal(r.status, 201, r.text);
      course = r.body;
      assert.equal(course.min_age, 8);
    });
    await check('list courses; other property sees none', async () => {
      assert.ok((await api('GET', '/api/courses')).body.some((c) => c.id === course.id));
      assert.ok(!(await api('GET', '/api/courses', null, OTHER_KEY)).body.some((c) => c.id === course.id));
    });
    await check('update course: partial, null clears a bound, merged band validated', async () => {
      const r = await api('PUT', `/api/courses/${course.id}`, { max_age: null });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.max_age, null);
      assert.equal(r.body.name, 'Kids Sailing');
      assert.equal((await api('PUT', `/api/courses/${course.id}`, { max_age: 7 })).status, 400); // below min_age 8
      assert.equal((await api('PUT', `/api/courses/${course.id}`, { max_age: 12 })).status, 200);
      assert.equal((await api('PUT', `/api/courses/${course.id}`, { name: 'x' }, OTHER_KEY)).status, 404);
    });
    await check('create runs: sessions returned, skip_dates as strings', async () => {
      const r = await api('POST', `/api/courses/${course.id}/runs`, { runs: [
        camp,
        { start_date: '2030-09-07', end_date: '2030-09-28', weekdays: [6], skip_dates: ['2030-09-14'], start_time: '10:00', end_time: '13:00', capacity: 8, price: 150 },
      ] });
      assert.equal(r.status, 201, r.text);
      run = r.body[0];
      assert.equal(run.sessions.length, 5);
      assert.deepEqual(r.body[1].skip_dates, ['2030-09-14']);
      assert.deepEqual(r.body[1].sessions, ['2030-09-07', '2030-09-21', '2030-09-28']);
    });
    await check('create runs: bad input is 400 with the run index', async () => {
      const bad = await api('POST', `/api/courses/${course.id}/runs`, { runs: [camp, { ...camp, weekdays: [0] }] });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /^runs\[1\]/);
      assert.equal((await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, end_time: '09:00' }] })).status, 400);
      assert.equal((await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, end_date: '2031-08-01' }] })).status, 400); // > 366 days
      assert.equal((await api('POST', `/api/courses/${course.id}/runs`, { runs: [camp] }, OTHER_KEY)).status, 404);
    });
    await check('update run: edit that leaves no sessions is 400', async () => {
      assert.equal((await api('PUT', `/api/courses/runs/${run.id}`, { weekdays: [0, 6] })).status, 400);
      const r = await api('PUT', `/api/courses/runs/${run.id}`, { skip_dates: ['2030-07-03'] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.sessions.length, 4);
      assert.equal((await api('PUT', `/api/courses/runs/${run.id}`, { skip_dates: [] })).status, 200);
    });
    await check('delete run and course with no enrolments', async () => {
      const c = (await api('POST', '/api/courses', { name: 'Throwaway', price: 10 })).body;
      const [rn] = (await api('POST', `/api/courses/${c.id}/runs`, { runs: [camp] })).body;
      assert.equal((await api('DELETE', `/api/courses/runs/${rn.id}`, null, OTHER_KEY)).status, 404);
      assert.equal((await api('DELETE', `/api/courses/runs/${rn.id}`)).status, 204);
      assert.equal((await api('DELETE', `/api/courses/${c.id}`)).status, 204);
      assert.equal((await api('DELETE', `/api/courses/${c.id}`)).status, 404);
    });

    // TASK_3_CHECKS
  } finally {
    const props = [P, Q];
    await pool.query('DELETE FROM course_participant WHERE enrolment_id IN (SELECT id FROM course_enrolment WHERE property_id = ANY($1))', [props]);
    await pool.query('DELETE FROM course_enrolment WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM course_run WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM course WHERE property_id = ANY($1)', [props]);
    await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    server.close();
  }

  await pool.end();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
