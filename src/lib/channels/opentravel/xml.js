// OpenTravel plumbing: SOAP 1.1 envelope with a WS-Security UsernameToken,
// the one escaper every interpolated value goes through, and a parser with
// entity processing off.
const { XMLParser } = require('fast-xml-parser');

const NS = 'http://www.opentravel.org/OTA/2003/05';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PASSWORD_TEXT = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// processEntities is off, so text and attributes arrive still escaped.
const UNESC = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (v) => String(v).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return UNESC[e.toLowerCase()];
  const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});

function envelope({ username, password, body }) {
  const header = username === undefined ? '' :
    `<soap:Header><wsse:Security xmlns:wsse="${WSSE}"><wsse:UsernameToken>` +
    `<wsse:Username>${esc(username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_TEXT}">${esc(password)}</wsse:Password>` +
    '</wsse:UsernameToken></wsse:Security></soap:Header>';
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP}">${header}<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, processEntities: false,
  parseTagValue: false, parseAttributeValue: false, trimValues: true,
});

// Throws on anything that is not a SOAP envelope. A DOCTYPE is refused
// outright: no partner message needs one, and it is the entity-attack vector.
function parse(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml ?? '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCTYPE not allowed');
  const env = parser.parse(text).Envelope;
  if (!env || typeof env !== 'object') throw new Error('not a SOAP envelope');
  return env;
}

const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const attr = (node, name) => (node && node['@' + name] !== undefined ? unesc(node['@' + name]) : undefined);
const text = (node) => {
  const t = node && typeof node === 'object' ? node['#text'] : node;
  return t === undefined || t === '' ? undefined : unesc(t);
};

// The one element in Body that is not a Fault: [name, node].
function bodyOf(env) {
  const body = env.Body;
  if (!body || typeof body !== 'object') throw new Error('SOAP body missing');
  if (body.Fault) throw new Error(`SOAP fault: ${text(body.Fault.faultstring) || text(body.Fault.faultcode) || 'unknown'}`);
  const name = Object.keys(body).find((k) => !k.startsWith('@'));
  if (!name) throw new Error('SOAP body empty');
  return [name, body[name]];
}

module.exports = { NS, esc, unesc, envelope, parse, bodyOf, arr, attr, text };
