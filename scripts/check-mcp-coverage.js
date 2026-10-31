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

const toolsSrc = fs.readFileSync(path.join(__dirname, '../mcp-server/tools.js'), 'utf8');
const covered = new Set([...toolsSrc.matchAll(/apiRequest\(\s*'(\w+)',\s*[`'"]([^`'"?]+)/g)].map((m) => `${m[1]} ${norm(m[2])}`));

const gaps = [...routes].filter((r) => !covered.has(r) && !EXCLUDE.some((re) => re.test(r))).sort();

if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(gaps, null, 2) + '\n');
  console.log(`baseline: ${gaps.length} known gaps written`);
  process.exit(0);
}

const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE, 'utf8')));
const fresh = gaps.filter((r) => !baseline.has(r));
const stale = [...baseline].filter((r) => !gaps.includes(r));
console.log(`${routes.size} routes, ${covered.size} tool paths, ${gaps.length} known gaps`);
if (stale.length) console.log(`no longer gaps (run --update to drop):\n  ${stale.join('\n  ')}`);
if (fresh.length) {
  console.error(`routes with no MCP tool -- add one to mcp-server/tools.js or an EXCLUDE rule:\n  ${fresh.join('\n  ')}`);
  process.exit(1);
}
console.log('ok');
