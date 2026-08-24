const pool = require('../db');

// Open-by-default tee sheets: every active course with a complete schedule
// (first_tee, last_tee, tee_interval_minutes -- all three set) carries a
// tee_time row for every slot from today out to this horizon, so staff never
// "create" tee times -- they only manage exceptions (blocking a slot, resizing
// max_players) and bookings. Courses without a schedule keep their manual
// tee sheet via POST /api/golf/tee-times/bulk.
// ON CONFLICT DO NOTHING preserves staff edits on already-seeded slots.
const TEE_HORIZON_DAYS = 180; // ~6 months -- typical resort tee-sheet window

// One course x N days x slots-per-day. generate_series over timestamps
// (date + first_tee .. date + last_tee, stepping the interval) gives the
// slot times in pure SQL; the ::time cast drops the date back off.
// tee_interval_minutes > 0 guards generate_series against a zero step.
const SLOT_SELECT = `
  SELECT gc.property_id, gc.id, d::date, t::time, gc.default_max_players
  FROM golf_course gc
  CROSS JOIN generate_series(CURRENT_DATE::timestamp, (CURRENT_DATE + $1::int)::timestamp, interval '1 day') d
  CROSS JOIN LATERAL generate_series(d + gc.first_tee, d + gc.last_tee, make_interval(mins => gc.tee_interval_minutes)) t
  WHERE gc.status = 'active'
    AND gc.first_tee IS NOT NULL
    AND gc.last_tee IS NOT NULL
    AND gc.tee_interval_minutes IS NOT NULL
    AND gc.tee_interval_minutes > 0`;

async function seedCourseTeeTimes(courseId) {
  const { rowCount } = await pool.query(
    `INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players)
     ${SLOT_SELECT}
       AND gc.id = $2
     ON CONFLICT (course_id, tee_date, tee_time) DO NOTHING`,
    [TEE_HORIZON_DAYS, courseId]
  );
  return rowCount;
}

async function seedAllScheduledCourses() {
  const { rowCount } = await pool.query(
    `INSERT INTO tee_time (property_id, course_id, tee_date, tee_time, max_players)
     ${SLOT_SELECT}
     ON CONFLICT (course_id, tee_date, tee_time) DO NOTHING`,
    [TEE_HORIZON_DAYS]
  );
  return rowCount;
}

// Boot + daily sweep keeps the horizon rolling for every scheduled course,
// including courses flipped back to active outside the create/update hooks.
function startTeeSheetHorizonJob() {
  const run = () =>
    seedAllScheduledCourses()
      .then((n) => { if (n > 0) console.log(`Tee-sheet horizon: seeded ${n} tee times`); })
      .catch((err) => console.error('Tee-sheet horizon seed failed:', err.message));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref(); // don't hold the process open for the sweep
}

module.exports = { seedCourseTeeTimes, seedAllScheduledCourses, startTeeSheetHorizonJob, TEE_HORIZON_DAYS };
