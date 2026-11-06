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
  assert.match(bad.error, /Unknown rate plan code &quot;XYZ&quot;|Unknown rate plan code "XYZ"/);
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

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
