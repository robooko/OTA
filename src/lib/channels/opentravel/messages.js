// The four OpenTravel messages the channel speaks (pure: strings in, strings out).
const crypto = require('crypto');
const { NS, esc, envelope, parse, bodyOf, arr, attr, text } = require('./xml');

const token = (t) => t || crypto.randomUUID();
const head = (name, echoToken) =>
  `<${name} xmlns="${NS}" EchoToken="${esc(token(echoToken))}" TimeStamp="${esc(new Date().toISOString())}" Version="1.0"`;
const money = (n) => Number(n).toFixed(2);
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);

// Consecutive nights with identical values per room+rate collapse to one run (end inclusive).
function groupRuns(changes) {
  const sorted = [...changes].sort((a, b) =>
    a.room_code.localeCompare(b.room_code) || a.rate_code.localeCompare(b.rate_code) || a.date.localeCompare(b.date));
  const runs = [];
  for (const c of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.room_code === c.room_code && last.rate_code === c.rate_code && nextDay(last.end) === c.date &&
        last.available === c.available && last.rate === c.rate && last.stop_sell === c.stop_sell) {
      last.end = c.date; last.changes.push(c);
    } else {
      runs.push({ room_code: c.room_code, rate_code: c.rate_code, start: c.date, end: c.date,
        available: c.available, rate: c.rate, stop_sell: c.stop_sell, changes: [c] });
    }
  }
  return runs;
}

const control = (r) =>
  `<StatusApplicationControl Start="${esc(r.start)}" End="${esc(r.end)}" InvTypeCode="${esc(r.room_code)}" RatePlanCode="${esc(r.rate_code)}"/>`;

function availNotifRQ({ hotelCode, runs, username, password, echoToken }) {
  const msgs = runs.map((r) => `<AvailStatusMessage BookingLimit="${esc(Number(r.available))}">${control(r)}` +
    `<RestrictionStatus Restriction="Master" Status="${r.stop_sell ? 'Close' : 'Open'}"/></AvailStatusMessage>`).join('');
  return envelope({ username, password, body:
    `${head('OTA_HotelAvailNotifRQ', echoToken)}><AvailStatusMessages HotelCode="${esc(hotelCode)}">${msgs}</AvailStatusMessages></OTA_HotelAvailNotifRQ>` });
}

function rateNotifRQ({ hotelCode, currency, runs, username, password, echoToken }) {
  const msgs = runs.filter((r) => r.rate !== null && r.rate !== undefined).map((r) =>
    `<RateAmountMessage>${control(r)}<Rates><Rate><BaseByGuestAmts><BaseByGuestAmt AmountAfterTax="${esc(money(r.rate))}" CurrencyCode="${esc(currency)}"/>` +
    '</BaseByGuestAmts></Rate></Rates></RateAmountMessage>').join('');
  return envelope({ username, password, body:
    `${head('OTA_HotelRateAmountNotifRQ', echoToken)}><RateAmountMessages HotelCode="${esc(hotelCode)}">${msgs}</RateAmountMessages></OTA_HotelRateAmountNotifRQ>` });
}

const notifRS = (name) => ({ echoToken, error } = {}) => envelope({ body: `${head(name, echoToken)}>` +
  (error ? `<Errors><Error Type="3">${esc(error)}</Error></Errors>` : '<Success/>') + `</${name}>` });
const availNotifRS = notifRS('OTA_HotelAvailNotifRS');
const rateNotifRS = notifRS('OTA_HotelRateAmountNotifRS');

function parseNotifRS(xml) {
  try {
    const [name, rs] = bodyOf(parse(xml));
    if (!/RS$/.test(name) || !rs || typeof rs !== 'object') return { ok: false, error: `unexpected response ${name}` };
    if ('Success' in rs && !rs.Errors) return { ok: true };
    const errs = arr(rs.Errors && rs.Errors.Error).map((e) => text(e) || attr(e, 'ShortText')).filter(Boolean);
    return { ok: false, error: errs.join('; ') || 'response had no Success' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const ACTION = { Commit: 'new', Book: 'new', Modify: 'modify', Cancel: 'cancel' };
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function reservation(hr, rootStatus) {
  const stays = arr(hr.RoomStays && hr.RoomStays.RoomStay);
  const stay = stays[0] || {};
  const counts = arr(stay.GuestCounts && stay.GuestCounts.GuestCount).map((g) => Number(attr(g, 'Count')));
  const cust = (arr(hr.ResGuests && hr.ResGuests.ResGuest)[0] || {}).Profiles?.ProfileInfo?.Profile?.Customer || {};
  const ref = attr(arr(hr.UniqueID)[0], 'ID');
  const total = attr(stay.Total, 'AmountAfterTax');
  const r = clean({
    channel_ref: ref,
    action: ACTION[attr(hr, 'ResStatus') ?? rootStatus],
    room_code: attr(arr(stay.RoomTypes && stay.RoomTypes.RoomType)[0], 'RoomTypeCode'),
    rate_code: attr(arr(stay.RatePlans && stay.RatePlans.RatePlan)[0], 'RatePlanCode'),
    check_in: attr(stay.TimeSpan, 'Start')?.slice(0, 10),
    check_out: attr(stay.TimeSpan, 'End')?.slice(0, 10),
    guests: counts.length ? counts.reduce((a, b) => a + b, 0) : undefined,
    total_price: total === undefined || total.trim() === '' ? undefined : Number(total),
    currency: attr(stay.Total, 'CurrencyCode'),
    guest: clean({
      first_name: text(cust.PersonName?.GivenName) ?? '',
      last_name: text(cust.PersonName?.Surname) ?? '',
      email: text(arr(cust.Email)[0]),
      phone: attr(arr(cust.Telephone)[0], 'PhoneNumber'),
    }),
  });
  return { ...r, _uid: ref, ...(stays.length > 1 && { reject_reason: 'multi-room reservations not supported' }) };
}

function parseResNotifRQ(xml) {
  try {
    const env = parse(xml);
    const [name, rq] = bodyOf(env);
    if (name !== 'OTA_HotelResNotifRQ') return { error: `unexpected message ${name}` };
    const tok = env.Header?.Security?.UsernameToken || {};
    return {
      username: text(tok.Username), password: text(tok.Password), echoToken: attr(rq, 'EchoToken'),
      reservations: arr(rq.HotelReservations && rq.HotelReservations.HotelReservation).filter(Boolean).map((hr) => reservation(hr, attr(rq, 'ResStatus'))),
    };
  } catch (err) {
    return { error: err.message };
  }
}

function resNotifRS({ echoToken, results }) {
  const failed = results.filter((r) => r.error);
  const status = failed.length
    ? `<Errors>${failed.map((r) => `<Error Type="3" ShortText="${esc(r.error)}"/>`).join('')}</Errors>`
    : '<Success/>';
  const res = results.map((r) => `<HotelReservation><UniqueID Type="14" ID="${esc(r.channel_ref)}"/>` +
    (r.booking_id ? `<ResGlobalInfo><HotelReservationIDs><HotelReservationID ResID_Value="${esc(r.booking_id)}"/></HotelReservationIDs></ResGlobalInfo>` : '') +
    '</HotelReservation>').join('');
  return envelope({ body: `${head('OTA_HotelResNotifRS', echoToken)}>${status}<HotelReservations>${res}</HotelReservations></OTA_HotelResNotifRS>` });
}

const soapFault = (code, message) => envelope({ body:
  `<soap:Fault><faultcode>${esc(code)}</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault>` });

module.exports = { groupRuns, availNotifRQ, rateNotifRQ, availNotifRS, rateNotifRS, parseNotifRS, parseResNotifRQ, resNotifRS, soapFault };
