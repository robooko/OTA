const pool = require('../db');

// Room housekeeping -- see docs/superpowers/specs/2026-10-31-housekeeping-design.md.
// Housekeeping state is never availability: nothing here touches room.status
// or room_availability.

// ── Pure rules ───────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Nights since check-in for a 'YYYY-MM-DD' pair (night 0 = arrival day).
function nightIndex(checkIn, date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
}

// Every `everyDays` nights into a stay; never on arrival day; null = never.
function stayoverDue(n, everyDays) {
  return everyDays != null && n > 0 && n % everyDays === 0;
}

const linenDue = stayoverDue;

// Grades an inspection against the property's active checklist. Every active
// item must be scored exactly once, 1-5 integers; the room fails when any
// item is under its pass mark. rows snapshot name and pass mark so archiving
// an item never rewrites history.
function scoreInspection(items, scores) {
  if (!Array.isArray(scores)) return { error: 'scores must be an array' };
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set();
  const rows = [];
  for (const s of scores) {
    const item = byId.get(s?.item_id);
    if (!item) return { error: `Unknown checklist item ${s?.item_id}` };
    if (seen.has(item.id)) return { error: `${item.name} scored twice` };
    seen.add(item.id);
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) return { error: `${item.name}: score must be a whole number 1 to 5` };
    if (s.comment != null && (typeof s.comment !== 'string' || s.comment.length > 2000)) return { error: `${item.name}: comment must be text up to 2000 characters` };
    if (s.photo_url != null && (typeof s.photo_url !== 'string' || !/^https:\/\//.test(s.photo_url))) return { error: `${item.name}: photo_url must be an https URL` };
    rows.push({ item_id: item.id, item_name: item.name, pass_mark: item.pass_mark, score: s.score, comment: s.comment ?? null, photo_url: s.photo_url ?? null });
  }
  const missing = items.filter((i) => !seen.has(i.id));
  if (missing.length) return { error: `Missing scores for: ${missing.map((i) => i.name).join(', ')}` };
  if (!rows.length) return { error: 'No checklist items to score' };
  const score = Math.round((rows.reduce((a, r) => a + r.score, 0) / rows.length) * 100) / 100;
  return { passed: rows.every((r) => r.score >= r.pass_mark), score, rows };
}

// Room state once a clean is finished: only a checkout clean at a property
// that requires inspection waits at 'clean'.
function statusAfterFinish(kind, inspectionRequired) {
  return kind === 'checkout' && inspectionRequired ? 'clean' : 'ready';
}

module.exports = { nightIndex, stayoverDue, linenDue, scoreInspection, statusAfterFinish };
