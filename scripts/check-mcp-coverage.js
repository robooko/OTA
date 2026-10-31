// MCP coverage: every API route needs a tool in mcp-server/tools.js, an
// entry in EXCLUDE (never a tool), or a line in mcp-coverage-baseline.json
// (known gap, to backfill). Fails on any route that is none of these. No DB.
//   node -r dotenv/config scripts/check-mcp-coverage.js
//   node -r dotenv/config scripts/check-mcp-coverage.js --update   (rewrite the baseline)
process.env.CLERK_SECRET_KEY ||= 'x';
const fs = require('fs');
const path = require('path');
const app = require('../src/app');

// Routes that should never be agent tools.
const EXCLUDE = [
  /^\S+ \/api\/(mcp|docs|auth|voice|sms)\b/,           // transport, auth, inbound telephony
  /\/webhooks\//,                                      // provider callbacks
  /\/(connect|callback)$/,                             // OAuth redirects
  /ably-token$|connection-token$/,                     // realtime / terminal client tokens
  /\/(payment-intent|confirm-payment)(\/confirm)?$/,   // Stripe client-side payment flows
  /^\S+ \/api\/billing\/checkout/,
  /opt-out|confirm-booking|^\S+ \/api\/cleanliness\//, // public guest email links
  /^\S+ \/api\/organization\/api-keys?\b/,             // key management stays with humans
  /^\S+ \/api\/housekeeping\/(jobs\/:p\/|booking-extras\/|photos)/, // cleaning is staff-app only
  /^DELETE \/api\/guests\/:p$/,                        // irreversible, dashboard only
  /^\S+ \/api\/property\/(api-keys?|staff)\b/,         // keys and staff permission grants
  /\/(stripe\/(publishable-)?key|vercel\/pat|marina\/key)(\/clear)?$|\/vercel\/disconnect$/, // secrets and connections, dashboard only
  /^PUT \/api\/property\/(ai-replies|voice)$/,         // mode/auto-send stay admin; tools use the narrow voice routes
  /^\S+ \/api\/marina\/(guest|sailor|public)\b/,       // guest site and sailor app rails
  /sailor-versions/,                                   // shared passport docs: bearer only, records who decided
  /\/images\/upload$/,                                 // raw file upload
  /^\S+ \/api\/restaurant-table-sessions\b/,           // the table QR app (guest devices)
  /^\S+ \/api\/(buxs|integrations|quickbooks|organization|site|sailor)\b/, // service secret, org-level (no property) and sailor app rails
  /^(POST|PUT) \/api\/beach-club\/|^GET \/api\/beach-club\/bookings$/, // global env API_KEY, not a property key: always 401 over MCP
  /^PUT \/api\/billing$/,                              // billing settings, admin dashboard
  /^PUT \/api\/proshop\/baskets$|\/baskets\/mine$/,    // a shopper's own basket
  /^GET \/api\/golf\/bookings\/live$/,                 // dashboard feed; list_golf_bookings covers it
];

const BASELINE = path.join(__dirname, 'mcp-coverage-baseline.json');
const norm = (p) => p.replace(/\$\{[^}]+\}/g, ':p').replace(/:\w+/g, ':p').replace(/(.)\/$/, '$1');
const mountPath = (re) => re.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');

const routes = new Set();
(function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) for (const m of Object.keys(layer.route.methods)) routes.add(`${m.toUpperCase()} ${norm(prefix + layer.route.path)}`);
    else if (layer.name === 'router') walk(layer.handle.stack, prefix + mountPath(layer.regexp));
  }
})(app._router.stack, '');

// Every tool runs once with every argument 'X1'; a route is covered when a
// tool called it with 'X1' in each :param slot. Catches generated paths
// (`/marinas/${id}/${kind}`) the source scan below can't read.
const traced = new Set();
const dummy = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'X1' : undefined) });
for (const tool of require('../mcp-server/tools').createTools((method, p) => { traced.add(`${method} ${p.split('?')[0].replace(/(.)\/$/, '$1')}`); return Promise.resolve({}); })) {
  try { Promise.resolve(tool.run(dummy)).catch(() => {}); } catch { /* the source scan still sees it */ }
}
// Fallback for tools that throw on dummy args.
const toolsSrc = fs.readFileSync(path.join(__dirname, '../mcp-server/tools.js'), 'utf8');
const scanned = new Set([...toolsSrc.matchAll(/apiRequest\(\s*'(\w+)',\s*[`'"]([^`'"?]+)/g)].map((m) => `${m[1]} ${norm(m[2].replace(/\$\{[^}]*$/, ''))}`)); // drop a cut-off `${q ? '?..' : ''}`
const isCovered = (r) => scanned.has(r) || traced.has(r.replace(/:p/g, 'X1'));

const gaps = [...routes].filter((r) => !isCovered(r) && !EXCLUDE.some((re) => re.test(r))).sort();

if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(gaps, null, 2) + '\n');
  console.log(`baseline: ${gaps.length} known gaps written`);
  process.exit(0);
}

const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE, 'utf8')));
const fresh = gaps.filter((r) => !baseline.has(r));
const stale = [...baseline].filter((r) => !gaps.includes(r));
console.log(`${routes.size} routes, ${traced.size} tool paths, ${gaps.length} known gaps`);
if (stale.length) console.log(`no longer gaps (run --update to drop):\n  ${stale.join('\n  ')}`);
if (fresh.length) {
  console.error(`routes with no MCP tool -- add one to mcp-server/tools.js or an EXCLUDE rule:\n  ${fresh.join('\n  ')}`);
  process.exit(1);
}
console.log('ok');
