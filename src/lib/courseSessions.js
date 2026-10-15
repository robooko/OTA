// A course run's sessions: every date in [start_date, end_date] on one of
// its weekdays (0 = Sunday) and not in skip_dates. Dates are 'YYYY-MM-DD'
// strings (see db/index.js); the walk is in UTC so it never slips a day.
function sessionDates({ start_date, end_date, weekdays, skip_dates = [] }) {
  const skip = new Set(skip_dates);
  const dates = [];
  const end = new Date(`${end_date}T00:00:00Z`);
  for (const d = new Date(`${start_date}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (weekdays.includes(d.getUTCDay()) && !skip.has(iso)) dates.push(iso);
  }
  return dates;
}

// Whole years old on `date`; a birthday falling on `date` counts.
function ageOn(dob, date) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

module.exports = { sessionDates, ageOn };
