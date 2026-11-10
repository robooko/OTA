// room_type.features: search tags like 'ocean_view', 'private_pool',
// 'fine_dining'. Free-form, normalised to lowercase snake_case.
const TAG = /^[a-z0-9_]{1,40}$/;
const MAX = 30;

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }); }

function norm(t) {
  const s = typeof t === 'string' ? t.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (!TAG.test(s)) throw bad(`feature tags are 1-40 letters, digits or _ (got ${JSON.stringify(t)})`);
  return s;
}

// Write: an array of tags (null clears). Deduped.
function parseFeatures(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad('features must be an array of tags');
  const out = [...new Set(v.map(norm))];
  if (out.length > MAX) throw bad(`at most ${MAX} features`);
  return out;
}

// Filter: 'a,b', ['a','b'] or ?features=a&features=b. Every tag must match.
// null = no filter.
function parseFeatureFilter(v) {
  if (v == null || v === '') return null;
  const list = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? x.split(',') : [x]))
    .filter((x) => x !== '');
  return list.length ? [...new Set(list.map(norm))] : null;
}

module.exports = { parseFeatures, parseFeatureFilter };
