// Time-window maths for equipment hires. Times are minutes from midnight;
// windows are half-open [start, end), so 10-11 and 11-12 don't overlap.
// A per_hour hire with a start_time is timed; anything else holds the whole day.
const DAY = { start: 0, end: 1440 };

// Accepts 'HH:MM' or pg's 'HH:MM:SS'.
function toMinutes(time) {
  const [h, m] = String(time).split(':');
  return Number(h) * 60 + Number(m);
}

function fmt(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function hireWindow(hire) {
  if (hire.rate_type !== 'per_hour' || !hire.start_time) return { ...DAY };
  const start = toMinutes(hire.start_time);
  return { start, end: start + Math.round(Number(hire.duration ?? 1) * 60) };
}

// Most units out at any instant inside window. Use only rises at a hire's
// start, so the window's start plus each start inside it covers every peak.
function peakUse(hires, window) {
  const spans = hires
    .map((h) => ({ ...hireWindow(h), quantity: Number(h.quantity) }))
    .filter((s) => s.start < window.end && s.end > window.start);
  const instants = [window.start, ...spans.map((s) => s.start).filter((t) => t > window.start)];
  let peak = 0;
  for (const t of instants) {
    const out = spans.reduce((sum, s) => (s.start <= t && t < s.end ? sum + s.quantity : sum), 0);
    peak = Math.max(peak, out);
  }
  return peak;
}

function fitsHours(item, window) {
  if (window.end > 1440) return false;
  if (!item.open_time || !item.close_time) return true;
  return window.start >= toMinutes(item.open_time) && window.end <= toMinutes(item.close_time);
}

// Bookable starts on the item's slot grid for a duration in hours. now
// (minutes, or null) drops starts already past.
function startTimes(item, hires, durationHours, quantity = 1, now = null) {
  const length = Math.round(durationHours * 60);
  const step = item.slot_interval_minutes || 60;
  const out = [];
  for (let start = item.open_time ? toMinutes(item.open_time) : 0; start < 1440; start += step) {
    const window = { start, end: start + length };
    if (!fitsHours(item, window) || (now != null && start < now)) continue;
    const available_quantity = item.quantity - peakUse(hires, window);
    if (available_quantity >= quantity) out.push({ start_time: fmt(start), available_quantity });
  }
  return out;
}

module.exports = { toMinutes, fmt, hireWindow, peakUse, fitsHours, startTimes };
