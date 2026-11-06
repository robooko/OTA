// OpenTravel message build/parse checks. Pure, no DB: node scripts/check-opentravel.js
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const m = require('../src/lib/channels/opentravel/messages');
const { parse } = require('../src/lib/channels/opentravel/xml');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures/opentravel', f), 'utf8');
const row = (date, o = {}) => ({ mapping_id: 1, room_code: 'DBL', rate_code: 'BAR', date, available: 2, rate: 120, stop_sell: false, ...o });
const dates = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-05'];
const body = (xml) => Object.values(parse(xml).Body)[0];
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
};

check('groupRuns collapses consecutive equal days', () => {
  const runs = m.groupRuns(dates.map((d) => row(d)));
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[0].start, runs[0].end, runs[0].changes.length], ['2026-12-01', '2026-12-03', 3]);
  assert.deepEqual([runs[1].start, runs[1].end], ['2026-12-05', '2026-12-05']);
});
check('groupRuns splits on a value change', () => {
  const runs = m.groupRuns(dates.slice(0, 3).map((d) => row(d, d === '2026-12-02' ? { rate: 130 } : {})));
  assert.deepEqual(runs.map((r) => [r.start, r.end]), [['2026-12-01', '2026-12-01'], ['2026-12-02', '2026-12-02'], ['2026-12-03', '2026-12-03']]);
});
check('availNotifRQ round-trips', () => {
  const xml = m.availNotifRQ({ hotelCode: 'H1', runs: m.groupRuns(dates.slice(0, 3).map((d) => row(d))), username: 'u&x', password: 'p' });
  assert.equal(parse(xml).Header.Security.UsernameToken.Username, 'u&amp;x');
  const msgs = body(xml).AvailStatusMessages;
  assert.equal(msgs['@HotelCode'], 'H1');
  const a = msgs.AvailStatusMessage;
  assert.equal(a['@BookingLimit'], '2');
  assert.deepEqual(a.StatusApplicationControl, { '@Start': '2026-12-01', '@End': '2026-12-03', '@InvTypeCode': 'DBL', '@RatePlanCode': 'BAR' });
  assert.equal(a.RestrictionStatus['@Status'], 'Open');
  const stop = m.availNotifRQ({ hotelCode: 'H1', runs: m.groupRuns([row('2026-12-01', { stop_sell: true })]), username: 'u', password: 'p' });
  assert.equal(body(stop).AvailStatusMessages.AvailStatusMessage.RestrictionStatus['@Status'], 'Close');
});
check('rateNotifRQ carries amount and currency', () => {
  const xml = m.rateNotifRQ({ hotelCode: 'H1', currency: 'GBP', runs: m.groupRuns([row('2026-12-01')]), username: 'u', password: 'p' });
  const amt = body(xml).RateAmountMessages.RateAmountMessage.Rates.Rate.BaseByGuestAmts.BaseByGuestAmt;
  assert.deepEqual(amt, { '@AmountAfterTax': '120.00', '@CurrencyCode': 'GBP' });
});
check('parseNotifRS', () => {
  assert.deepEqual(m.parseNotifRS(fx('avail-rs-success.xml')), { ok: true });
  const bad = m.parseNotifRS(fx('rate-rs-errors.xml'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown rate plan code "XYZ"/);
  assert.equal(m.parseNotifRS(fx('not-xml.html')).ok, false);
  assert.deepEqual(m.parseNotifRS(m.availNotifRS({})), { ok: true });
  assert.equal(m.parseNotifRS(m.rateNotifRS({ error: 'nope' })).error, 'nope');
  const fault = m.parseNotifRS(m.soapFault('soap:Server', 'boom'));
  assert.equal(fault.ok, false);
  assert.match(fault.error, /boom/);
});
check('parseResNotifRQ new/modify/cancel/no-email', () => {
  const r = m.parseResNotifRQ(fx('res-notif-new.xml'));
  assert.deepEqual([r.username, r.password], ['partner', 's3cret']);
  assert.equal(r.reservations.length, 1);
  assert.deepEqual(r.reservations[0], {
    channel_ref: 'CH-1001', action: 'new', room_code: 'DBL', rate_code: 'BAR', check_in: '2026-12-01', check_out: '2026-12-04',
    guests: 3, total_price: 360, currency: 'GBP',
    guest: { first_name: 'Anna & Co', last_name: 'Lewis', email: 'anna@example.com', phone: '+447700900123' }, _uid: 'CH-1001',
  });
  assert.equal(m.parseResNotifRQ(fx('res-notif-modify.xml')).reservations[0].action, 'modify');
  assert.equal(m.parseResNotifRQ(fx('res-notif-cancel.xml')).reservations[0].action, 'cancel');
  const ne = m.parseResNotifRQ(fx('res-notif-no-email.xml')).reservations[0];
  assert.equal(ne.guest.email, undefined);
  assert.ok(!('email' in ne.guest));
});
check('reservation edge cases', () => {
  const base = fx('res-notif-new.xml');
  const root = base.replace(/(<HotelReservation [^>]*?) ResStatus="Commit"/, '$1');
  assert.ok(!/<HotelReservation [^>]*ResStatus/.test(root) && /<OTA_HotelResNotifRQ[^>]*ResStatus="Commit"/.test(root));
  assert.equal(m.parseResNotifRQ(root).reservations[0].action, 'new');
  const noAmt = m.parseResNotifRQ(base.replace('AmountAfterTax="360.00"', 'AmountAfterTax=""')).reservations[0];
  assert.ok(!('total_price' in noAmt));
  const dt = m.parseResNotifRQ(base.replace('Start="2026-12-01" End="2026-12-04"', 'Start="2026-12-01T14:00:00" End="2026-12-04T10:00:00"')).reservations[0];
  assert.deepEqual([dt.check_in, dt.check_out], ['2026-12-01', '2026-12-04']);
});
check('DOCTYPE/entities never expand', () => {
  const evil = fx('res-notif-new.xml')
    .replace('<soap:Envelope', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><soap:Envelope')
    .replace('Anna &amp; Co', '&e;');
  const r = m.parseResNotifRQ(evil);
  assert.ok(r.error);
  assert.doesNotMatch(JSON.stringify(r), /root:/);
});
check('resNotifRS reports failures', () => {
  const xml = m.resNotifRS({ echoToken: 't', results: [{ channel_ref: 'A', booking_id: 'b1' }, { channel_ref: 'B', error: 'no room available' }] });
  assert.match(xml, /<Errors>/);
  assert.match(xml, /ShortText="no room available"/);
  assert.match(xml, /ResID_Value="b1"/);
  const ok = m.resNotifRS({ results: [{ channel_ref: 'A', booking_id: 'b1' }] });
  assert.match(ok, /<Success\/>/);
  assert.doesNotMatch(ok, /Errors/);
});



const http = require('http');
const ot = require('../src/lib/channels/opentravel');
const acheck = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}
     ${err.stack}`); }
};
const OK = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><OTA_X_RS xmlns="http://www.opentravel.org/OTA/2003/05" Version="1.0"><Success/></OTA_X_RS></s:Body></s:Envelope>';
const ERR = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><OTA_X_RS xmlns="http://www.opentravel.org/OTA/2003/05" Version="1.0"><Errors><Error Type="3">bad</Error></Errors></OTA_X_RS></s:Body></s:Envelope>';
// Stand-in OTA: answer(kind, n) -> { body, status?, delay? }; records every request.
async function stand(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const kind = /OTA_HotelAvailNotifRQ/.test(b) ? 'avail' : 'rate';
      seen.push({ kind, body: b, headers: req.headers });
      const a = answer(kind);
      setTimeout(() => { res.writeHead(a.status || 200, { 'Content-Type': 'text/xml' }); res.end(a.body); }, a.delay || 0);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, server, url: `http://127.0.0.1:${server.address().port}/ota` };
}
const chan = (url) => ({ currency: 'GBP', config: { endpoint_url: url, username: 'u', password: 'p', hotel_code: 'H1', inbound_username: 'iu', inbound_password: 'ip' } });

(async () => {
  await acheck('push: one avail + one rate request, ok in input order', async () => {
    const s = await stand(() => ({ body: OK }));
    const cs = [row('2026-12-03'), row('2026-12-01'), row('2026-12-10', { available: 5 })]; // 2 runs
    const r = await ot.push(chan(s.url), cs);
    s.server.close();
    assert.deepEqual(r, cs.map(() => ({ ok: true })));
    assert.deepEqual(s.seen.map((x) => x.kind).sort(), ['avail', 'rate']);
    assert.equal(s.seen[0].headers['content-type'], 'text/xml; charset=utf-8');
    assert.ok(s.seen[0].headers.soapaction !== undefined);
  });
  await acheck('push: rate errors fail every change in them, avail ones stay ok', async () => {
    const s = await stand((k) => ({ body: k === 'rate' ? ERR : OK }));
    const cs = [row('2026-12-01'), row('2026-12-02')];
    const r = await ot.push(chan(s.url), cs);
    s.server.close();
    assert.ok(r.every((x) => x.ok === false && /rate/.test(x.error)));
  });
  await acheck('push: closed port, HTML answer and timeout all fail without throwing', async () => {
    const dead = await stand(() => ({ body: OK }));
    dead.server.close();
    const cs = [row('2026-12-01')];
    assert.equal((await ot.push(chan(dead.url), cs))[0].ok, false);
    const html = await stand(() => ({ body: '<html><body>oops</body></html>' }));
    assert.equal((await ot.push(chan(html.url), cs))[0].ok, false);
    html.server.close();
    const slow = await stand(() => ({ body: OK, delay: 1500 }));
    ot.timeouts.ms = 200;
    const t = Date.now();
    const r = await ot.push(chan(slow.url), cs);
    ot.timeouts.ms = 15000;
    slow.server.close();
    assert.equal(r[0].ok, false);
    assert.ok(Date.now() - t < 1400);
  });
  await acheck('push: 400 runs split into requests of at most MAX_RUNS', async () => {
    const s = await stand(() => ({ body: OK }));
    const cs = Array.from({ length: 400 }, (_, i) => row('2027-01-01', { room_code: 'R' + String(i).padStart(3, '0') }));
    const r = await ot.push(chan(s.url), cs);
    s.server.close();
    assert.equal(ot.MAX_RUNS, 200);
    assert.ok(r.every((x) => x.ok));
    assert.equal(s.seen.filter((x) => x.kind === 'avail').length, 2);
    assert.ok(s.seen.every((x) => (x.body.match(/<(AvailStatusMessage|RateAmountMessage)[ >]/g) || []).length <= 200));
  });
  await acheck('validateConfig', async () => {
    assert.equal(ot.validateConfig({}).length, 6);
    const full = chan('https://x.test/ota').config;
    assert.deepEqual(ot.validateConfig(full), []);
    assert.equal(ot.validateConfig({ ...full, extra: 1 }).length, 1);
    assert.equal(ot.validateConfig({ ...full, endpoint_url: 'http://x' }).length, 1);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    assert.equal(ot.validateConfig({ ...full, endpoint_url: 'http://localhost:1/ota' }).length, 1);
    process.env.NODE_ENV = prev;
  });

  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('all passed');
})();
