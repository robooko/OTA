// Berth placement from a pontoon's drawing: where each data-berth-id group
// lands on the map, and which way its bow points. Mirrors how every map
// overlays the SVG: a div spanning the two raw corners (an axis-aligned box,
// whatever the corner labels say), the SVG filling it with its default
// preserveAspectRatio (xMidYMid meet, or "none"), then the whole div
// CSS-rotated clockwise about its centre by the pontoon's rotation.
//
// Berth rotation is absolute: the bow's heading in degrees clockwise from
// east. A drawn berth's data-role="entrance" bar sits on its pier edge, so
// its bow points from the bar through the berth's centre (stern-to). No bar
// (a buoy circle, a hand-drawn slot) -> null, and maps fall back to the
// pontoon's own angle.

const IDENTITY = [1, 0, 0, 1, 0, 0];
// [a b c d e f] maps (x, y) -> (a x + c y + e, b x + d y + f), as SVG does.
const mul = ([a, b, c, d, e, f], [A, B, C, D, E, F]) => [
  a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f,
];
const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
const rad = (deg) => (deg * Math.PI) / 180;

function parseTransform(s) {
  let m = IDENTITY;
  for (const [, fn, args] of (s || '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = args.trim().split(/[\s,]+/).map(Number);
    let t;
    if (fn === 'matrix') t = n;
    else if (fn === 'translate') t = [1, 0, 0, 1, n[0], n[1] || 0];
    else if (fn === 'scale') t = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else if (fn === 'rotate') {
      const c = Math.cos(rad(n[0])), s2 = Math.sin(rad(n[0])), [cx = 0, cy = 0] = n.slice(1);
      t = mul(mul([1, 0, 0, 1, cx, cy], [c, s2, -s2, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewX') t = [1, 0, Math.tan(rad(n[0])), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan(rad(n[0])), 0, 1, 0, 0];
    if (t?.length === 6 && t.every(Number.isFinite)) m = mul(m, t);
  }
  return m;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? all);
function attrs(s) {
  const out = {};
  for (const [, k, , dq, sq] of s.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[k] = decode(dq ?? sq);
  return out;
}
const num = (x) => Number.parseFloat(x) || 0;
// Centre of a body/entrance shape in its own user space.
function centre(tag, a) {
  if (tag === 'rect') return [num(a.x) + num(a.width) / 2, num(a.y) + num(a.height) / 2];
  if (tag === 'circle' || tag === 'ellipse') return [num(a.cx), num(a.cy)];
  return null;
}

// -> { viewBox: [x, y, w, h] | null, stretch, berths: [{ label, centre, entrance }] }
// with centre/entrance in viewBox coordinates (entrance null if not drawn).
function readSvg(svg) {
  const clean = svg.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<style[\s\S]*?<\/style>|<\?[\s\S]*?\?>|<![^>]*>/gi, '');
  const stack = [];
  let ctm = IDENTITY, viewBox = null, stretch = false, berth = null, sawRoot = false;
  const berths = [];
  for (const [, close, rawTag, rest, selfClose] of clean.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const tag = rawTag.toLowerCase();
    if (close) {
      const top = stack.pop();
      if (!top) continue;
      ctm = top.ctm;
      if (berth && top.berth) { berths.push(berth); berth = null; }
      continue;
    }
    const a = attrs(rest);
    if (tag === 'svg' && !sawRoot) {
      sawRoot = true;
      const vb = (a.viewBox || '').trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) viewBox = vb;
      stretch = /^\s*none\b/.test(a.preserveAspectRatio || '');
    }
    const own = a.transform ? mul(ctm, parseTransform(a.transform)) : ctm;
    const startsBerth = !berth && a['data-berth-id'] != null;
    if (startsBerth) berth = { label: a['data-berth-id'], centre: null, entrance: null };
    if (berth) {
      const c = centre(tag, a);
      if (c && a['data-role'] === 'entrance') berth.entrance ??= apply(own, c);
      else if (c && !a['data-role'] && (tag === 'rect' || tag === 'circle')) berth.centre ??= apply(own, c);
    }
    if (selfClose) { if (startsBerth) { berths.push(berth); berth = null; } continue; }
    stack.push({ ctm, berth: startsBerth });
    ctm = own;
  }
  return { viewBox, stretch, berths: berths.filter((b) => b.centre) };
}

const M_PER_LAT = 111320;

// pontoon: { svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation }
// -> { berths: [{ label, lat, lng, rotation }] } or { skipped: reason }
function placeBerths(p) {
  const corners = [p.sw_lat, p.sw_lng, p.ne_lat, p.ne_lng].map((x) => (x == null ? NaN : Number(x)));
  if (!p.svg_data) return { skipped: 'no drawing' };
  if (!corners.every(Number.isFinite)) return { skipped: 'corners not set' };
  const { viewBox, stretch, berths } = readSvg(p.svg_data);
  if (!viewBox) return { skipped: 'drawing has no viewBox' };

  const [lat1, lng1, lat2, lng2] = corners;
  const lat0 = (lat1 + lat2) / 2, lng0 = (lng1 + lng2) / 2;
  const mPerLng = M_PER_LAT * Math.cos(rad(lat0));
  const W = Math.abs(lng2 - lng1) * mPerLng, H = Math.abs(lat2 - lat1) * M_PER_LAT;
  const [vx, vy, vw, vh] = viewBox;
  const sx = stretch ? W / vw : Math.min(W / vw, H / vh), sy = stretch ? H / vh : sx;
  const ox = (W - vw * sx) / 2, oy = (H - vh * sy) / 2;
  const turn = rad(Number(p.rotation) || 0), cos = Math.cos(turn), sin = Math.sin(turn);
  // viewBox point -> metres from the box centre, x east, y down (screen), after the CSS turn.
  const toScreen = ([x, y]) => {
    const px = ox + (x - vx) * sx - W / 2, py = oy + (y - vy) * sy - H / 2;
    return [px * cos - py * sin, px * sin + py * cos];
  };

  return {
    berths: berths.map((b) => {
      const [x, y] = toScreen(b.centre);
      let rotation = null;
      if (b.entrance) {
        const [ex, ey] = toScreen(b.entrance);
        // y is down, so atan2 here is already clockwise from east.
        if (Math.hypot(x - ex, y - ey) > 1e-9) rotation = Math.round((((Math.atan2(y - ey, x - ex) * 180) / Math.PI) + 360) % 360 * 10) / 10;
      }
      return { label: b.label, lat: lat0 - y / M_PER_LAT, lng: lng0 + x / mPerLng, rotation };
    }),
  };
}

// Writes each drawn berth's position, bow heading and pontoon onto the
// marina's berth with that label, in one statement. The drawing wins over
// hand-entered values. -> { placed, unmatched: [labels] } or { skipped }
async function applyPlacement(client, pontoon) {
  const result = placeBerths(pontoon);
  if (result.skipped) return { skipped: result.skipped };
  const bs = result.berths;
  if (!bs.length) return { placed: 0, unmatched: [] };
  const { rows } = await client.query(
    `UPDATE marina_berth b SET lat = v.lat, lng = v.lng, rotation = v.rotation, pontoon_id = $2
       FROM unnest($3::text[], $4::float8[], $5::float8[], $6::float8[]) AS v(label, lat, lng, rotation)
      WHERE b.marina_id = $1 AND b.label = v.label
      RETURNING b.label`,
    [pontoon.marina_id, pontoon.id, bs.map((b) => b.label), bs.map((b) => b.lat), bs.map((b) => b.lng), bs.map((b) => b.rotation)]
  );
  const placed = new Set(rows.map((r) => r.label));
  return { placed: placed.size, unmatched: bs.map((b) => b.label).filter((l) => !placed.has(l)) };
}

const PLACEMENT_COLS = ['svg_data', 'sw_lat', 'sw_lng', 'ne_lat', 'ne_lng', 'rotation'];

// A pontoon drawing as maps are served it. shown: Map of label -> dock_side
// (or null) for every berth that isn't inactive. A drawn berth not in it is
// dropped, so an inactive berth disappears from every map. A dock_side moves
// the berth's entrance bar onto that edge of its body rect, in the berth's
// own frame: end is the rect's top edge, far_end the bottom, left and right
// the long sides. Never saved: placeBerths reads the stored bar as the stern,
// so a bar moved onto a long side there would turn the berth 90 degrees.
// ponytail: regex over flat berth groups (a <g> holding rects and text, as
// every editor draws them); a berth group with nested <g>s is left as drawn.
const DOCK_SIDES = ['end', 'far_end', 'left', 'right'];
function servedDrawing(svg, shown) {
  if (!svg) return svg;
  return svg.replace(/<g\b([^>]*)>((?:(?!<\/?g\b)[\s\S])*)<\/g>/g, (all, open, inner) => {
    const label = attrs(open)['data-berth-id'];
    if (label == null) return all;
    if (!shown.has(label)) return '';
    const side = shown.get(label);
    if (!side) return all;
    const body = [...inner.matchAll(/<rect\b([^>]*?)\/?>/g)].map((m) => attrs(m[1])).find((a) => !a['data-role']);
    if (!body) return all;
    const x = num(body.x), y = num(body.y), w = num(body.width), h = num(body.height);
    const [bx, by, bw, bh] = {
      end: [x + 2, y + 2, w - 4, 4], far_end: [x + 2, y + h - 6, w - 4, 4],
      left: [x + 2, y + 2, 4, h - 4], right: [x + w - 6, y + 2, 4, h - 4],
    }[side];
    const bar = /<rect\b[^>]*data-role=(["'])entrance\1[^>]*?\/?>/;
    const fill = inner.match(bar)?.[0].match(/\bfill=(["'])([^"']*)\1/)?.[2] || '#22c55e';
    const rect = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="2" fill="${fill}" data-role="entrance"/>`;
    return `<g${open}>${bar.test(inner) ? inner.replace(bar, rect) : inner.replace(/<rect\b[^>]*?\/?>/, (r) => r + rect)}</g>`;
  });
}

module.exports = { placeBerths, applyPlacement, PLACEMENT_COLS, servedDrawing, DOCK_SIDES };
