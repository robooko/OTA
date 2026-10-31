// MCP coverage: every API route needs a tool in mcp-server/tools.js or an
// EXCLUDE rule below (never a tool, with the reason). Fails on any route
// that is neither. No DB.
//   node -r dotenv/config scripts/check-mcp-coverage.js
process.env.CLERK_SECRET_KEY ||= 'x';
const app = require('../src/app');
const { createTools } = require('../mcp-server/tools');

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

const norm = (p) => p.replace(/:\w+/g, ':p').replace(/(.)\/$/, '$1');
const mountPath = (re) => re.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');

const routes = new Set();
(function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) for (const m of Object.keys(layer.route.methods)) routes.add(`${m.toUpperCase()} ${norm(prefix + layer.route.path)}`);
    else if (layer.name === 'router') walk(layer.handle.stack, prefix + mountPath(layer.regexp));
  }
})(app._router.stack, '');

// Every tool runs once with every argument 'X1'; a route is covered when a
// tool called it with 'X1' in each :param slot.
const traced = new Set();
const dummy = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'X1' : undefined) });
const tools = createTools((method, p) => { traced.add(`${method} ${p.split('?')[0].replace(/(.)\/$/, '$1')}`); return Promise.resolve({}); });
const broken = [];
for (const tool of tools) {
  try { Promise.resolve(tool.run(dummy)).catch(() => {}); } catch (err) { broken.push(`${tool.name}: ${err.message}`); }
}

const gaps = [...routes].filter((r) => !traced.has(r.replace(/:p/g, 'X1')) && !EXCLUDE.some((re) => re.test(r))).sort();
console.log(`${routes.size} routes, ${tools.length} tools, ${traced.size} tool paths`);
if (broken.length) console.log(`tools that threw on dummy args (their routes may show as gaps):\n  ${broken.join('\n  ')}`);
if (gaps.length) {
  console.error(`routes with no MCP tool -- add one to mcp-server/tools.js or an EXCLUDE rule:\n  ${gaps.join('\n  ')}`);
  process.exit(1);
}
console.log('ok');
