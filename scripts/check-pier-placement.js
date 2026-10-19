// Checks berth placement from pontoon drawings (src/lib/pierPlacement.js).
// Pure maths, no DB.   node scripts/check-pier-placement.js
const assert = require('node:assert/strict');
const { placeBerths, servedDrawing } = require('../src/lib/pierPlacement');

const near = (a, b, m, what) => assert.ok(Math.abs(a - b) * 111320 < m, `${what}: ${a} vs ${b}`);
// A 100 x 100 m box at the equator (1 deg = 111320 m), so 1 SVG unit = 1 m.
const D = 100 / 111320;
const box = { sw_lat: 0, sw_lng: 0, ne_lat: D, ne_lng: D };
// Berth A: slot centred at (75, 50), entrance bar on its west (pier) edge.
const berth = (extra = '') => `<g data-berth-id="A&amp;1"${extra}><rect x="60" y="45" width="30" height="10"/><rect data-role="entrance" x="60" y="45" width="2" height="10"/></g>`;
const svg = (body, root = '') => `<svg viewBox="0 0 100 100"${root}><style>a > b {}</style>${body}</svg>`;

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); } };

check('unturned: centre and stern-to bow heading east', () => {
  const [b] = placeBerths({ ...box, svg_data: svg(berth()), rotation: 0 }).berths;
  assert.equal(b.label, 'A&1');
  near(b.lat, D / 2, 0.01, 'lat'); near(b.lng, (75 / 100) * D, 0.01, 'lng');
  assert.equal(b.rotation, 0);
});

check('pontoon turned 90 clockwise: east of centre moves south, bow heads south', () => {
  const [b] = placeBerths({ ...box, svg_data: svg(berth()), rotation: 90 }).berths;
  near(b.lat, D / 2 - (25 / 100) * D, 0.01, 'lat'); near(b.lng, D / 2, 0.01, 'lng');
  assert.equal(b.rotation, 90);
});

check('nested group transforms compose', () => {
  // translate(-25) then the berth's own rotate(180 75 50): centre (50, 50), bar now on the east.
  const [b] = placeBerths({ ...box, svg_data: svg(`<g transform="translate(-25, 0)">${berth(' transform="rotate(180 75 50)"')}</g>`), rotation: 0 }).berths;
  near(b.lng, D / 2, 0.01, 'lng');
  assert.equal(b.rotation, 180);
});

check('meet letterboxing: a 200 x 100 viewBox in a square box', () => {
  const [b] = placeBerths({ ...box, svg_data: '<svg viewBox="0 0 200 100"><circle data-berth-id="B" cx="200" cy="50" r="5"/></svg>' }).berths;
  // scale 0.5, centred vertically: (200, 50) -> (100, 50) m from the SW-NW edge.
  near(b.lat, D / 2, 0.01, 'lat'); near(b.lng, D, 0.01, 'lng');
  assert.equal(b.rotation, null);
});

check('preserveAspectRatio none stretches', () => {
  const [b] = placeBerths({ ...box, svg_data: '<svg viewBox="0 0 200 100" preserveAspectRatio="none"><circle data-berth-id="B" cx="100" cy="0" r="5"/></svg>' }).berths;
  near(b.lat, D, 0.01, 'lat'); near(b.lng, D / 2, 0.01, 'lng');
});

check('corner labels swapped still give the same box', () => {
  const [b] = placeBerths({ sw_lat: D, sw_lng: D, ne_lat: 0, ne_lng: 0, svg_data: svg(berth()) }).berths;
  near(b.lng, (75 / 100) * D, 0.01, 'lng');
});

check('skips without a drawing, corners or viewBox', () => {
  assert.equal(placeBerths({ ...box, svg_data: null }).skipped, 'no drawing');
  assert.equal(placeBerths({ svg_data: svg(berth()) }).skipped, 'corners not set');
  assert.equal(placeBerths({ ...box, svg_data: '<svg>' + berth() + '</svg>' }).skipped, 'drawing has no viewBox');
});

check('dock_side moves the entrance bar onto that edge, or adds one', () => {
  const g = (id, inner) => `<g data-berth-id="${id}">${inner}</g>`;
  const body = '<rect x="0" y="0" width="10" height="20"/>';
  const drawn = g('A', body + '<rect x="2" y="2" width="6" height="4" fill="#123" data-role="entrance"/>') + g('B', body) + g('C', body);
  const out = servedDrawing(drawn, new Map([['A', 'left'], ['B', 'far_end'], ['C', null]]));
  assert.ok(out.includes('<rect x="2" y="2" width="4" height="16" rx="2" fill="#123" data-role="entrance"/>'), out);
  assert.ok(out.includes('<rect x="2" y="14" width="6" height="4" rx="2" fill="#22c55e" data-role="entrance"/>'), out);
  assert.ok(out.endsWith(g('C', body)), 'unlisted berth untouched');
  assert.equal(servedDrawing(drawn, new Map([['A', null], ['B', null], ['C', null]])), drawn);
  assert.equal(servedDrawing('<svg>' + drawn + '<g id="pier"><rect/></g></svg>', new Map([['B', null]])), '<svg>' + g('B', body) + '<g id="pier"><rect/></g></svg>', 'inactive berths dropped, the pier kept');
});


if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
