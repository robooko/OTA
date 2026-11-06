// Channel adapters, by channel.adapter. An adapter only translates:
//   label: string
//   validateConfig(config) -> string[]   (errors; [] = ok)
//   push(channel, changes) -> Promise<Array<{ ok, error? }>>, parallel to changes
// where a change is a desiredAri row (src/lib/channels/desired.js). Inbound
// reservations are normalised by the adapter and handed to
// receiveReservation (src/lib/channels/reservations.js).
const ADAPTERS = {
  test: require('./test'),
};

// Config keys never returned by the API (masked as ***).
const SECRET_KEYS = ['password', 'inbound_password'];

module.exports = { ADAPTERS, SECRET_KEYS };
