// Moves Sidon Marina's marina data into OTA (spec: Cutover steps 2 and 4).
// Reads Sidon with raw SQL and explicit column lists (8 of its table names
// are OTA's too, and its drizzle schema.ts lists columns live doesn't have),
// plans the mapping from a map file, and writes in one target transaction.
//   node scripts/import-sidon-marina.js --map [<map-file>] [--live]
// <map-file> defaults to .superpowers/import-map.local.json (.live.json with --live).
// Output carries owner aliases, slugs and counts only: never a name, an
// email or a Sidon owner id.
require('dotenv').config();
require('../src/db'); // DATE as 'YYYY-MM-DD' strings, for every pg client in the process
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');

class ImportRefused extends Error {}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const alias = (ownerId) => 'o_' + sha1(String(ownerId)).slice(0, 6);

// UUID v5-style from Sidon identity, so re-runs keep booking ids (and with
// them booking tokens and blob paths) stable.
function uid(table, id) {
  const h = sha1(`sidon:${table}:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Sidon tier dates look like '2026-06-01T00:00:00.000+01:00': the date the
// operator typed. Converting zones would move it a day for zones behind +01:00.
const tierDate = (text) => String(text).slice(0, 10);

function cleanEmail(s) {
  const t = String(s ?? '').trim();
  return t.indexOf('@') >= 1 ? t : null;
}

const STATUSES = new Set(['pending', 'confirmed', 'declined', 'cancelled']);
// A pending request nobody answered before it lapsed (or before the stay
// ended) is dead: OTA would never act on it.
function mapBookingStatus(b, today, now) {
  if (!STATUSES.has(b.status)) return null;
  if (b.status === 'pending' && (b.expires_at == null || b.expires_at <= now || b.departure_date < today)) {
    return { status: 'cancelled', cancel_reason: 'expired' };
  }
  return { status: b.status, cancel_reason: null };
}

const daysBefore = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// Mirrors marinaDocuments.retentionOnce: a file it would delete on its first
// pass is not worth copying.
function insideRetention(b, today, now) {
  if (b.departure !== null && b.departure < daysBefore(today, 90)) return false;
  if ((b.status === 'cancelled' || b.status === 'declined') && b.updated_at < new Date(now.getTime() - 90 * 864e5)) return false;
  return true;
}

const DECISIONS = new Set(['accept_as_property_currency', 'drop_prices']);
function loadMap(path) {
  let map;
  try { map = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (err) { throw new ImportRefused(`map file ${path}: ${err.message}`); }
  if (!map || typeof map.owners !== 'object' || Array.isArray(map.owners)) throw new ImportRefused('map file: "owners" must be an object');
  for (const [key, e] of Object.entries(map.owners)) {
    const at = `map owner ${key.startsWith('o_') ? key : alias(key)}`;
    if (!e || !['property', 'create', 'skip', 'rekey'].includes(e.action)) throw new ImportRefused(`${at}: unknown action`);
    if (e.currency_decision === 'reprice') throw new ImportRefused(`${at}: currency_decision 'reprice' is not supported in phase 1`);
    if (e.currency_decision != null && !DECISIONS.has(e.currency_decision)) throw new ImportRefused(`${at}: unknown currency_decision`);
    if (e.action === 'property' && typeof e.property_id !== 'string') throw new ImportRefused(`${at}: property_id is required`);
    if (e.action === 'create') {
      // Without an org the owner's first sign-in auto-creates a second, empty property.
      if (!e.clerk_org_id) throw new ImportRefused(`${at}: clerk_org_id is required for create`);
      if (!e.name || !e.timezone) throw new ImportRefused(`${at}: name and timezone are required for create`);
    }
    if (e.action === 'skip' && !e.reason) throw new ImportRefused(`${at}: skip needs a reason`);
    if (e.action === 'rekey' && !e.to_owner) throw new ImportRefused(`${at}: rekey needs to_owner`);
  }
  return map;
}

// Exactly the live columns (survey sidon-import.md §1); schema is
// 'sidon_fixture' in the check.
const SOURCE_SQL = {
  profiles: 'SELECT owner_id, slug, name, lat, lng, description, phone, email, website, response_window_hours, currency, updated_at FROM %s.marina_profile ORDER BY owner_id',
  layouts: 'SELECT owner_id, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation FROM %s.marina_layout ORDER BY owner_id',
  overlays: 'SELECT id, owner_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order FROM %s.marina_overlay ORDER BY id',
  berths: 'SELECT id, owner_id, berth_id, overlay_id, lat, lng, length_m, min_length_m, beam_m, depth_m, status, guest_name, notes, price_per_night, price_mode, rotation FROM %s.marina_berth ORDER BY id',
  tiers: 'SELECT id, owner_id, valid_from, valid_to, max_len_m, max_beam_m, price_per_night, price_per_month, price_per_year, created_at FROM %s.marina_price_tier ORDER BY id',
  bookings: 'SELECT id, owner_id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, notes, status, payment_intent_id, amount_cents, expires_at, created_at, updated_at FROM %s.berth_booking ORDER BY created_at, id',
  requirements: 'SELECT id, owner_id, type, name, description, schema, mandatory, sort_order FROM %s.marina_doc_requirement ORDER BY id',
  documents: 'SELECT id, owner_id, requirement_id, booking_id, status, notes, submitted_at, verified_at, type, file_url, file_name, extracted_data, expiry_date FROM %s.marina_document ORDER BY id',
  templates: 'SELECT id, owner_id, name, body_markdown, min_nights, active, created_at FROM %s.marina_contract_template ORDER BY id',
  signatures: 'SELECT id, owner_id, template_id, booking_id, rendered_body, signed_at, ip_address, user_agent FROM %s.marina_contract_signature ORDER BY id',
  pois: 'SELECT id, owner_id, label, type, lat, lng FROM %s.marina_poi ORDER BY id',
  images: 'SELECT id, owner_id, url, description, sort_order, created_at FROM %s.marina_image ORDER BY id',
  messages: 'SELECT id, owner_id, sailor_id, enquiry_cookie_hash, sailor_email, sailor_name, direction, body, created_at, read_at FROM %s.marina_message ORDER BY id',
};

// SELECTs only: the caller owns the transaction (the CLI opens it READ ONLY).
async function readSource(src, schema = 'public') {
  if (!/^[a-z_]+$/.test(schema)) throw new ImportRefused(`bad source schema ${schema}`);
  const out = {};
  for (const [k, sql] of Object.entries(SOURCE_SQL)) out[k] = (await src.query(sql.replace('%s', schema))).rows;
  return out;
}

const TABLES = Object.keys(SOURCE_SQL);
const ownersIn = (source) => [...new Set(TABLES.flatMap((t) => source[t].map((r) => r.owner_id)))].sort();

// Map keys may be an owner id or its alias (G2). Returns owner id -> entry,
// plus refusals for keys matching no owner or an ambiguous alias.
function resolveKeys(map, owners) {
  const byOwner = new Map();
  const refusals = [];
  const find = (key) => {
    if (owners.includes(key)) return key;
    const hits = owners.filter((o) => alias(o) === key);
    if (hits.length > 1) { refusals.push(`alias ${key} matches ${hits.length} owners: use the owner id`); return null; }
    if (!hits.length) { refusals.push(`map key ${key.startsWith('o_') ? key : alias(key)} matches no Sidon owner`); return null; }
    return hits[0];
  };
  for (const [key, entry] of Object.entries(map.owners)) {
    const id = find(key);
    if (id) byOwner.set(id, entry);
  }
  return { byOwner, refusals, find };
}

const createKey = (e) => `create:${e.clerk_org_id}:${e.name}`;

// Read-only: the target state the plan depends on.
async function readTargets(dst, source, map) {
  const owners = ownersIn(source);
  const { byOwner } = resolveKeys(map, owners);
  const properties = {};
  const reruns = {};
  const loadProps = async (ids) => {
    const { rows } = await dst.query('SELECT id, currency, timezone, clerk_org_id FROM property WHERE id::text = ANY($1)', [ids]);
    for (const r of rows) properties[r.id] = { currency: r.currency, timezone: r.timezone, clerk_org_id: r.clerk_org_id };
  };
  await loadProps([...byOwner.values()].filter((e) => e.action === 'property').map((e) => e.property_id));
  const groups = new Map();
  for (const [id, e] of byOwner) if (e.action === 'create') groups.set(createKey(e), [...(groups.get(createKey(e)) || []), id]);
  for (const [key, ids] of groups) {
    // A previous run's property: by its marinas first (one per owner), then
    // by the first owner it was created for.
    const { rows: [m] } = await dst.query('SELECT property_id FROM marina WHERE sidon_owner_id = ANY($1) LIMIT 1', [ids]);
    const { rows: [p] } = m ? { rows: [] } : await dst.query('SELECT id FROM property WHERE sidon_marina_id = ANY($1) LIMIT 1', [ids]);
    const pid = m?.property_id ?? p?.id;
    if (pid) reruns[key] = pid;
  }
  await loadProps(Object.values(reruns));
  return { properties, reruns };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Pure: everything the import will do, or why it won't.
function planMapping(source, map, targets) {
  const owners = ownersIn(source);
  const { byOwner, refusals, find } = resolveKeys(map, owners);
  const profile = new Map(source.profiles.map((p) => [p.owner_id, p]));
  const hasRows = (id) => TABLES.some((t) => t !== 'messages' && source[t].some((r) => r.owner_id === id));
  const plan = { properties: [], owners: [], currencyFlags: [], suggestions: [], refusals };
  const propByKey = new Map();

  // Importing owners first, in map-file order (owners[0] becomes sidon_marina_id).
  for (const [id, e] of byOwner) {
    if (e.action !== 'property' && e.action !== 'create') continue;
    const a = alias(id);
    const p = profile.get(id);
    if (!p) { refusals.push(`${a} has no marina profile: rekey or skip it`); continue; }
    let pp;
    if (e.action === 'property') {
      const t = targets.properties[e.property_id];
      if (!t) { refusals.push(`${a}: property ${e.property_id} not found on the target`); continue; }
      pp = propByKey.get(e.property_id);
      if (!pp) {
        pp = { key: e.property_id, property_id: e.property_id, create: null, currency: t.currency.toUpperCase(), owners: [] };
        propByKey.set(pp.key, pp);
        plan.properties.push(pp);
      }
    } else {
      const key = createKey(e);
      const currency = String(e.currency ?? p.currency).toUpperCase();
      pp = propByKey.get(key);
      if (!pp) {
        const rerun = targets.reruns[key];
        pp = rerun
          ? { key, property_id: rerun, create: null, currency: targets.properties[rerun].currency.toUpperCase(), owners: [], timezone: e.timezone, wanted: currency }
          : { key, property_id: null, create: { name: e.name, timezone: e.timezone, clerk_org_id: e.clerk_org_id, currency }, currency, owners: [], timezone: e.timezone, wanted: currency };
        propByKey.set(key, pp);
        plan.properties.push(pp);
      } else if (pp.timezone !== e.timezone || pp.wanted !== currency) {
        // G1: owners sharing one created property must agree on both.
        refusals.push(`${a}: timezone/currency differ from the other owners of "${e.name}"`);
        continue;
      }
    }
    pp.owners.push(id);
    const slug = e.slug ?? p.slug ?? slugify(p.name);
    if (!SLUG.test(slug)) refusals.push(`${a}: slug "${slug}" is not a valid slug`);
    const marinaCurrency = String(p.currency).toUpperCase();
    const decision = e.currency_decision ?? null;
    if (marinaCurrency !== pp.currency) {
      plan.currencyFlags.push({ alias: a, marina_currency: marinaCurrency, property_currency: pp.currency, decision });
      // A guest would pay the right number in the wrong currency.
      if (!decision) refusals.push(`${a}: marina currency ${marinaCurrency} differs from property currency ${pp.currency}; set currency_decision`);
    }
    plan.owners.push({ owner_id: id, alias: a, action: 'import', property_key: pp.key, slug,
      prices: decision === 'drop_prices' ? 'drop' : 'keep', rekey_to: null, reason: null });
  }
  for (const pp of plan.properties) { delete pp.timezone; delete pp.wanted; }

  const importing = new Set(plan.owners.map((o) => o.owner_id));
  const slugs = new Map();
  for (const o of plan.owners) {
    if (slugs.has(o.slug)) refusals.push(`${o.alias} and ${slugs.get(o.slug)} both use slug "${o.slug}"`);
    slugs.set(o.slug, o.alias);
  }

  for (const id of owners) {
    if (importing.has(id)) continue;
    const a = alias(id);
    const e = byOwner.get(id);
    if (e?.action === 'property' || e?.action === 'create') continue; // refused above
    if (e?.action === 'skip') { plan.owners.push({ owner_id: id, alias: a, action: 'skip', property_key: null, slug: null, prices: 'keep', rekey_to: null, reason: e.reason }); continue; }
    if (e?.action === 'rekey') {
      const to = find(e.to_owner);
      if (to && !importing.has(to)) refusals.push(`${a}: rekey target ${alias(to)} is not an importing owner`);
      if (to) plan.owners.push({ owner_id: id, alias: a, action: 'rekey', property_key: null, slug: null, prices: 'keep', rekey_to: to, reason: null });
      continue;
    }
    // G13: absent owners are auto-skipped only when nothing but messages hangs off them.
    if (!hasRows(id)) plan.owners.push({ owner_id: id, alias: a, action: 'skip', property_key: null, slug: null, prices: 'keep', rekey_to: null, reason: 'no child rows' });
    else refusals.push(`${a} is not in the map and has rows: add property/create/rekey/skip`);
  }

  // Re-key hints for profile-less owners: the overlays their berths sit on,
  // and labels that exist in exactly one profiled marina.
  const labelsOf = new Map();
  for (const b of source.berths) if (profile.has(b.owner_id)) labelsOf.set(b.berth_id, [...new Set([...(labelsOf.get(b.berth_id) || []), b.owner_id])]);
  const overlayOwner = new Map(source.overlays.map((o) => [o.id, o.owner_id]));
  for (const id of owners) {
    if (profile.has(id) || !hasRows(id)) continue;
    const cands = new Set();
    for (const b of source.berths) if (b.owner_id === id && overlayOwner.has(b.overlay_id) && profile.has(overlayOwner.get(b.overlay_id))) cands.add(overlayOwner.get(b.overlay_id));
    for (const r of [...source.berths, ...source.bookings]) {
      const hit = r.owner_id === id && labelsOf.get(r.berth_id);
      if (hit && hit.length === 1) cands.add(hit[0]);
    }
    plan.suggestions.push({ alias: alias(id), rekey_to_alias: cands.size === 1 ? alias([...cands][0]) : null });
  }
  return plan;
}

// For terminals and sign-off: aliases, slugs and map-file property names only.
function formatPlan(plan) {
  const name = (key) => {
    const pp = plan.properties.find((p) => p.key === key);
    return pp.create ? `create "${pp.create.name}" (${pp.create.currency}, ${pp.create.timezone})` : `${pp.property_id} (${pp.currency})`;
  };
  const out = ['properties:'];
  for (const pp of plan.properties) out.push(`  ${name(pp.key)} <- ${pp.owners.map(alias).join(', ')}`);
  out.push('owners:');
  for (const o of plan.owners) {
    if (o.action === 'import') out.push(`  ${o.alias} import as ${o.slug}${o.prices === 'drop' ? ' (prices dropped)' : ''}`);
    else if (o.action === 'rekey') out.push(`  ${o.alias} rekey -> ${alias(o.rekey_to)}`);
    else out.push(`  ${o.alias} skip: ${o.reason}`);
  }
  if (plan.currencyFlags.length) out.push('currency flags:', ...plan.currencyFlags.map((f) => `  ${f.alias}: marina ${f.marina_currency}, property ${f.property_currency}, decision ${f.decision ?? 'none'}`));
  if (plan.suggestions.length) out.push('profile-less owners:', ...plan.suggestions.map((s) => `  ${s.alias}: ${s.rekey_to_alias ? `suggest rekey -> ${s.rekey_to_alias}` : 'no single match (skip, or rekey by hand)'}`));
  if (plan.refusals.length) out.push('refusals:', ...plan.refusals.map((r) => `  ${r}`));
  return out.join('\n');
}

module.exports = { ImportRefused, alias, uid, slugify, tierDate, cleanEmail, mapBookingStatus, insideRetention,
  loadMap, readSource, readTargets, planMapping, formatPlan };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const mapFile = argv.find((a) => !a.startsWith('--')) ?? `.superpowers/import-map.${live ? 'live' : 'local'}.json`;
  const ssl = (url) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

  const main = async () => {
    if (!argv.includes('--map')) throw new ImportRefused('only --map is available until the import steps land');
    const dstKey = live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL';
    const srcUrl = process.env.SIDON_DATABASE_URL;
    const dstUrl = process.env[dstKey];
    if (!srcUrl) throw new ImportRefused('SIDON_DATABASE_URL is not set');
    if (!dstUrl) throw new ImportRefused(`${dstKey} is not set`);
    if (srcUrl === dstUrl) throw new ImportRefused(`SIDON_DATABASE_URL and ${dstKey} are the same database`);
    const map = loadMap(mapFile);
    const src = new Client({ connectionString: srcUrl, ssl: ssl(srcUrl) });
    const dst = new Client({ connectionString: dstUrl, ssl: ssl(dstUrl) });
    await src.connect();
    await dst.connect();
    try {
      // READ ONLY makes Postgres itself refuse any write to Sidon.
      await src.query('BEGIN READ ONLY');
      const source = await readSource(src);
      await src.query('COMMIT');
      const plan = planMapping(source, map, await readTargets(dst, source, map));
      console.log(formatPlan(plan));
      if (plan.refusals.length) process.exitCode = 1;
    } finally {
      await src.end();
      await dst.end();
    }
  };

  main().catch((err) => {
    if (!(err instanceof ImportRefused)) throw err; // a real bug: let Node print the stack
    console.error(`refused: ${err.message}`);
    process.exitCode = 1;
  });
}
