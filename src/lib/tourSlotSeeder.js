const pool = require('../db');

// Open-by-default timetables for fixed-schedule tours (e.g. a ferry): every
// active tour with a non-empty departure_times carries a tour_slot row for
// each departure from today out to this horizon, so staff only manage
// exceptions (deactivating a sailing) and bookings. Tours without a
// timetable keep their manual slots via POST /api/tours/slots/bulk.
// ON CONFLICT DO NOTHING preserves staff edits on already-seeded slots.
const TOUR_HORIZON_DAYS = 180; // matches the golf tee-sheet horizon

// One tour x N days x departures-per-day. EXTRACT(DOW) is 0 = Sunday, the
// same convention departure_days uses; NULL departure_days = every day.
const SLOT_SELECT = `
  SELECT t.property_id, t.id, d::date, dep
  FROM tour t
  CROSS JOIN generate_series(CURRENT_DATE::timestamp, (CURRENT_DATE + $1::int)::timestamp, interval '1 day') d
  CROSS JOIN LATERAL unnest(t.departure_times) dep
  WHERE t.status = 'active'
    AND (t.departure_days IS NULL OR EXTRACT(DOW FROM d)::int = ANY(t.departure_days))`;

async function seedTourSlots(tourId) {
  const { rowCount } = await pool.query(
    `INSERT INTO tour_slot (property_id, tour_id, slot_date, slot_time)
     ${SLOT_SELECT}
       AND t.id = $2
     ON CONFLICT (tour_id, slot_date, slot_time) DO NOTHING`,
    [TOUR_HORIZON_DAYS, tourId]
  );
  return rowCount;
}

async function seedAllScheduledTours() {
  const { rowCount } = await pool.query(
    `INSERT INTO tour_slot (property_id, tour_id, slot_date, slot_time)
     ${SLOT_SELECT}
     ON CONFLICT (tour_id, slot_date, slot_time) DO NOTHING`,
    [TOUR_HORIZON_DAYS]
  );
  return rowCount;
}

// Boot + daily sweep keeps the horizon rolling for every scheduled tour,
// including tours flipped back to active outside the create/update hooks.
function startTourTimetableHorizonJob() {
  const run = () =>
    seedAllScheduledTours()
      .then((n) => { if (n > 0) console.log(`Tour timetable horizon: seeded ${n} tour slots`); })
      .catch((err) => console.error('Tour timetable horizon seed failed:', err.message));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref(); // don't hold the process open for the sweep
}

module.exports = { seedTourSlots, seedAllScheduledTours, startTourTimetableHorizonJob, TOUR_HORIZON_DAYS };
