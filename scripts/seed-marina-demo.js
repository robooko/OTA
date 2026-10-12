// Seeds a local demo marina for the booking widget's demo page: property
// 'Marina Demo' (EUR, Europe/Rome, API key on) with marina demo-marina --
// one pontoon, six berths, a 12-month price tier, two document
// requirements and a contract. Safe to re-run: rows are matched on natural
// keys and updated in place, so ids (and any demo bookings, uploads and
// signatures on them) survive. Local DB only.
//   node scripts/seed-marina-demo.js
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const BERTHS = [
  { label: 'A1', length_m: 8, beam_m: 3, depth_m: 2.5, price_per_night: 3.5, price_mode: 'per_metre' },
  { label: 'A2', length_m: 10, beam_m: 3.5, depth_m: 3, price_per_night: 4, price_mode: 'per_metre' },
  { label: 'A3', length_m: 12, beam_m: 4, depth_m: 3, price_per_night: 60, price_mode: 'fixed' },
  { label: 'A4', length_m: 15, beam_m: 5, depth_m: 3.5, price_per_night: 4.5, price_mode: 'per_metre' },
  // min_length_m keeps small boats off the big berth (OTA's fit rule).
  { label: 'A5', length_m: 20, min_length_m: 14, beam_m: 6, depth_m: 4, price_per_night: 5, price_mode: 'per_metre' },
  { label: 'A6', length_m: 18, beam_m: 5.5, depth_m: 4, price_per_night: 5, price_mode: 'per_metre', status: 'maintenance' },
];

// The pontoon overlay: a 300x150 SVG stretched over SW..NE (about 96 x 48 m
// at this latitude, so the aspect matches). Berth lat/lng come from the
// same cells, so the chart style's circles sit on the SVG's rects.
const SW = { lat: 44.3031, lng: 9.209 };
const NE = { lat: 44.30353, lng: 9.2102 };
const W = 300;
const H = 150;
const cell = (i) => ({ x: 15 + (i % 3) * 95, y: i < 3 ? 10 : 88, w: 80, h: 52 });
const at = (c) => ({
  lat: Number((NE.lat - ((c.y + c.h / 2) / H) * (NE.lat - SW.lat)).toFixed(6)),
  lng: Number((SW.lng + ((c.x + c.w / 2) / W) * (NE.lng - SW.lng)).toFixed(6)),
});
// The widget paints the rect INSIDE each [data-berth-id] element and hides
// [data-type="berth"] text, so each berth is a <g> around its rect + label.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`
  + '<rect data-role="pontoon" x="5" y="67" width="290" height="16" fill="#9c8b74"/>'
  + BERTHS.map((b, i) => {
    const c = cell(i);
    return `<g data-type="berth" data-berth-id="${b.label}"><rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="4"/>`
      + `<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2}" text-anchor="middle">${b.label}</text></g>`;
  }).join('')
  + '</svg>';

// Sidon's merge-field names (src/lib/marinaContracts.js FIELDS).
const CONTRACT = `# Berth agreement

Between **{{marina_name}}** ({{marina_email}}, {{marina_phone}}) and **{{sailor_name}}** ({{sailor_email}}), dated {{today}}.

- Boat: {{boat_name}}, {{boat_loa}} m LOA, {{boat_beam}} m beam
- Berth: {{berth_id}}
- Stay: {{arrival_date}} to {{departure_date}} ({{nights}} nights)
- Total: {{amount}}

The skipper keeps the boat insured and safely moored, follows the marina's rules and staff instructions, and leaves the berth by noon on the departure date.`;

// UPDATE, then INSERT if nothing matched. Most marina tables have no unique
// key to ON CONFLICT on, and updating in place keeps ids stable.
async function put(db, table, key, row) {
  const cols = Object.keys(row);
  const keys = Object.keys(key);
  const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const where = keys.map((k, i) => `${k} = $${cols.length + i + 1}`).join(' AND ');
  const { rows: [found] } = await db.query(`UPDATE ${table} SET ${set} WHERE ${where} RETURNING id`, [...Object.values(row), ...Object.values(key)]);
  if (found) return found.id;
  const all = [...keys, ...cols];
  const { rows: [made] } = await db.query(
    `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    [...Object.values(key), ...Object.values(row)]);
  return made.id;
}

async function seed(db) {
  const P = await put(db, 'property', { name: 'Marina Demo' }, { currency: 'EUR', timezone: 'Europe/Rome', api_key_enabled: true });
  // Generated once and then kept, so a running widget demo survives a re-seed.
  const { rows: [{ api_key: apiKey }] } = await db.query(
    'UPDATE property SET api_key = COALESCE(api_key, $2) WHERE id = $1 RETURNING api_key', [P, `prop_${crypto.randomBytes(32).toString('hex')}`]);
  const M = await put(db, 'marina', { property_id: P, slug: 'demo-marina' }, {
    name: 'Demo Marina', description: 'A local demo marina for the booking widget.', phone: '+39 0185 000000',
    email: 'demo-marina@example.com', website: 'https://example.com', lat: 44.30332, lng: 9.2096,
    booking_url: 'http://localhost:5173/booking.html?booking={id}&token={token}', status: 'active',
  });
  const pontoon = await put(db, 'marina_pontoon', { marina_id: M, name: 'Pontoon A' }, {
    property_id: P, svg_data: SVG, sw_lat: SW.lat, sw_lng: SW.lng, ne_lat: NE.lat, ne_lng: NE.lng, rotation: 0, sort_order: 0, status: 'active',
  });
  for (const [i, b] of BERTHS.entries()) {
    await put(db, 'marina_berth', { marina_id: M, label: b.label }, {
      property_id: P, pontoon_id: pontoon, ...at(cell(i)), rotation: null, length_m: b.length_m, min_length_m: b.min_length_m ?? null,
      beam_m: b.beam_m, depth_m: b.depth_m, price_per_night: b.price_per_night, price_mode: b.price_mode, status: b.status ?? 'active',
    });
  }
  // Property-local today, so the season opens on the day the widget sees;
  // valid_to is inclusive (the last night covered).
  const { rows: [d] } = await db.query(
    "SELECT t::text AS today, ((t + interval '12 months')::date - 1)::text AS last FROM (SELECT (now() AT TIME ZONE 'Europe/Rome')::date AS t) x");
  await put(db, 'marina_price_tier', { marina_id: M, max_length_m: 12 }, {
    property_id: P, valid_from: d.today, valid_to: d.last, max_beam_m: null, price_per_night: 45, price_per_month: null, price_per_year: null, status: 'active',
  });
  await put(db, 'marina_doc_requirement', { marina_id: M, type: 'passport' }, {
    property_id: P, name: 'Passport', description: "The skipper's passport photo page", mandatory: true, sort_order: 0, status: 'active',
  });
  await put(db, 'marina_doc_requirement', { marina_id: M, type: 'insurance' }, {
    property_id: P, name: 'Boat insurance', description: 'Third-party liability certificate', mandatory: false, sort_order: 1, status: 'active',
  });
  await put(db, 'marina_contract_template', { marina_id: M, name: 'Berth agreement' }, {
    property_id: P, body_markdown: CONTRACT, min_nights: 0, status: 'active',
  });
  return { P, apiKey };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    const { P, apiKey } = await seed(db);
    await db.query('COMMIT');
    console.log(`Marina Demo seeded (property ${P})`);
    // Machine-readable for the widget demo: KEY=$(... | sed -n 's/^api_key=//p')
    console.log(`api_key=${apiKey}`);
    console.log('slug=demo-marina');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
