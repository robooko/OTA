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

    // ---- Task 3: enrolments ----
    const kid = (first_name, date_of_birth) => ({ first_name, date_of_birth });
    const enrol = (participants, extra = {}, key) => api('POST', '/api/courses/enrolments',
      { run_id: run.id, contact_name: 'Ana', contact_email: 'ana@example.com', participants, ...extra }, key);
    let first;
    await check('enrol: priced from the course, participants returned', async () => {
      const r = await enrol([kid('Lucia', '2018-07-01'), kid('Mateo', '2019-01-15')]);
      assert.equal(r.status, 201, r.text);
      first = r.body;
      assert.equal(first.total_price, '400.00');
      assert.deepEqual(first.participants.map((p) => p.first_name).sort(), ['Lucia', 'Mateo']);
    });
    await check('enrol: run price overrides course price', async () => {
      const [sat] = (await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, price: 150 }] })).body;
      const r = await api('POST', '/api/courses/enrolments', { run_id: sat.id, contact_name: 'Ana', participants: [kid('Leo', '2019-01-01')] });
      assert.equal(r.body.total_price, '150.00');
      assert.equal((await api('DELETE', `/api/courses/runs/${sat.id}`)).status, 409); // live enrolment
      await api('PUT', `/api/courses/enrolments/${r.body.id}`, { status: 'cancelled' });
      assert.equal((await api('DELETE', `/api/courses/runs/${sat.id}`)).status, 204);
    });
    await check('enrol: supplied total_price wins', async () => {
      const r = await enrol([kid('Sofia', '2019-05-05')], { total_price: 99.5 });
      assert.equal(r.body.total_price, '99.50');
    });
    await check('enrol: age band names the child', async () => {
      const r = await enrol([kid('Lucia', '2018-07-01'), kid('Hugo', '2017-07-01')]);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Hugo is 13/);
    });
    await check('enrol: garbage participants are 400', async () => {
      assert.equal((await enrol([])).status, 400);
      assert.equal((await enrol([kid('', '2019-01-01')])).status, 400);
      assert.equal((await enrol([kid('Ana', '2019-02-30')])).status, 400);
      assert.equal((await enrol([kid('Ana', '2031-01-01')])).status, 400); // born after the course starts
      assert.equal((await enrol([kid('Ana', '2019-01-01')], { contact_name: '' })).status, 400);
      assert.equal((await enrol([kid('Ana', '2019-01-01')], { total_price: -1 })).status, 400);
    });
    await check('enrol: other property gets 404', async () => {
      assert.equal((await enrol([kid('Ana', '2019-01-01')], {}, OTHER_KEY)).status, 404);
      assert.equal((await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'cancelled' }, OTHER_KEY)).status, 404);
      assert.ok(!(await api('GET', '/api/courses/enrolments', null, OTHER_KEY)).body.length);
    });
    await check('seats: 3 taken of 10, 8 more is 409, 7 fits', async () => {
      const eight = Array.from({ length: 8 }, (_, i) => kid(`K${i}`, '2019-01-01'));
      const full = await enrol(eight);
      assert.equal(full.status, 409);
      assert.match(full.body.error, /Only 7 places left/);
      assert.equal((await enrol(eight.slice(0, 7))).status, 201);
    });
    await check('seats: two parents racing for the last place -- one wins', async () => {
      await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'cancelled' }); // frees 2 -> 2 left
      await enrol([kid('Fill', '2019-01-01')]); // 1 left
      const [a, b] = await Promise.all([enrol([kid('A', '2019-01-01')]), enrol([kid('B', '2019-01-01')])]);
      assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    });
    await check('reinstate re-checks seats; capacity cut below taken is 409', async () => {
      const r = await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'confirmed' });
      assert.equal(r.status, 409, r.text); // run is full, Lucia + Mateo don't fit
      assert.equal((await api('PUT', `/api/courses/runs/${run.id}`, { capacity: 5 })).status, 409);
      assert.equal((await api('PUT', `/api/courses/enrolments/${first.id}`, { status: 'bogus' })).status, 400);
      assert.equal((await api('PUT', `/api/courses/enrolments/${first.id}`, { notes: 'called back' })).body.notes, 'called back');
    });
    await check('list enrolments: filter by run and status, participants included', async () => {
      const r = await api('GET', `/api/courses/enrolments?run_id=${run.id}&status=cancelled`);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.body.length >= 1 && r.body.every((e) => e.status === 'cancelled'));
      assert.ok(r.body.find((e) => e.id === first.id).participants.some((p) => p.date_of_birth === '2018-07-01'));
    });
    await check('started run: 409 without total_price, 201 with it', async () => {
      const [old] = (await api('POST', `/api/courses/${course.id}/runs`, { runs: [{ ...camp, start_date: '2020-01-06', end_date: '2020-01-10' }] })).body;
      const late = { run_id: old.id, contact_name: 'Ana', participants: [kid('Late', '2010-01-01')] };
      assert.equal((await api('POST', '/api/courses/enrolments', late)).status, 409);
      assert.equal((await api('POST', '/api/courses/enrolments', { ...late, total_price: 50 })).status, 201);
    });
    await check('inactive run is not bookable', async () => {
      const [rn] = (await api('POST', `/api/courses/${course.id}/runs`, { runs: [camp] })).body;
      await api('PUT', `/api/courses/runs/${rn.id}`, { status: 'inactive' });
      assert.equal((await api('POST', '/api/courses/enrolments', { run_id: rn.id, contact_name: 'Ana', participants: [kid('X', '2019-01-01')] })).status, 409);
    });

    // ---- Task 4: search and roster ----
    await check('search: seats_left, effective price, sessions; age filter', async () => {
      const r = await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02');
      assert.equal(r.status, 200, r.text);
      const hit = r.body.find((x) => x.id === run.id);
      assert.equal(hit.seats_left, 0);
      assert.equal(hit.price, '200.00');
      assert.equal(hit.sessions.length, 5);
      assert.ok(!r.body.some((x) => x.start_date === '2030-09-07')); // starts outside [from, to)
      assert.ok(!(await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02&age=14')).body.some((x) => x.id === run.id));
      assert.ok((await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02&age=12')).body.some((x) => x.id === run.id));
    });
    await check('search: bad input is 400', async () => {
      assert.equal((await api('GET', '/api/courses/runs/search?from=2030-07-01')).status, 400);
      assert.equal((await api('GET', '/api/courses/runs/search?from=2030-07-02&to=2030-07-01')).status, 400);
      assert.equal((await api('GET', '/api/courses/runs/search?from=2030-07-01&to=2030-07-02&age=x')).status, 400);
    });
    await check('roster: live participants with ages; other property 404', async () => {
      const r = await api('GET', `/api/courses/runs/${run.id}/roster`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.participants.length, 10);
      assert.ok(!r.body.participants.some((p) => p.first_name === 'Lucia')); // her enrolment is cancelled
      assert.equal(r.body.participants.find((p) => p.first_name === 'Sofia').age, 11);
      assert.equal(r.body.run.sessions.length, 5);
      assert.equal((await api('GET', `/api/courses/runs/${run.id}/roster`, null, OTHER_KEY)).status, 404);
    });
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
