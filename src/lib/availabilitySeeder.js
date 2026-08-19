const pool = require('../db');

// Open-by-default availability: every active room carries an open
// room_availability row for every night from today out to this horizon, so
// staff never "create" availability -- they only manage exceptions (blocks,
// rate overrides) and bookings flip nights as they always have.
// ON CONFLICT DO NOTHING preserves those mutations on already-seeded nights.
const HORIZON_DAYS = 548; // ~18 months

// The materialized-view refresh is skipped when nothing was inserted --
// steady-state daily runs insert exactly one new night per room, but a
// no-op run (e.g. a second boot the same day) shouldn't pay for a refresh.
async function refreshIfSeeded(inserted) {
  if (inserted > 0) {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
  }
  return inserted;
}

async function seedRoomAvailability(roomId) {
  const { rowCount } = await pool.query(
    `INSERT INTO room_availability (property_id, room_id, date)
     SELECT r.property_id, r.id, d::date
     FROM room r
     CROSS JOIN generate_series(CURRENT_DATE::timestamp, (CURRENT_DATE + $2::int)::timestamp, interval '1 day') d
     WHERE r.id = $1 AND r.status = 'active'
     ON CONFLICT (room_id, date) DO NOTHING`,
    [roomId, HORIZON_DAYS]
  );
  return refreshIfSeeded(rowCount);
}

async function seedAllActiveRooms() {
  const { rowCount } = await pool.query(
    `INSERT INTO room_availability (property_id, room_id, date)
     SELECT r.property_id, r.id, d::date
     FROM room r
     CROSS JOIN generate_series(CURRENT_DATE::timestamp, (CURRENT_DATE + $1::int)::timestamp, interval '1 day') d
     WHERE r.status = 'active'
     ON CONFLICT (room_id, date) DO NOTHING`,
    [HORIZON_DAYS]
  );
  return refreshIfSeeded(rowCount);
}

// Boot + daily sweep keeps the horizon rolling for every active room,
// including rooms flipped back to active outside the create/update hooks.
function startAvailabilityHorizonJob() {
  const run = () =>
    seedAllActiveRooms()
      .then((n) => { if (n > 0) console.log(`Availability horizon: seeded ${n} room-nights`); })
      .catch((err) => console.error('Availability horizon seed failed:', err.message));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref(); // don't hold the process open for the sweep
}

module.exports = { seedRoomAvailability, seedAllActiveRooms, startAvailabilityHorizonJob, HORIZON_DAYS };
