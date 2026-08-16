const Ably = require('ably');

// The Ably constructor throws synchronously on a malformed key (not just a
// wrong/revoked one) -- guarded so a bad ABLY_API_KEY disables realtime
// notifications instead of crashing the whole server at boot.
let client = null;
if (process.env.ABLY_API_KEY) {
  try {
    client = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  } catch (err) {
    console.error('Ably client init failed, notifications disabled:', err.message);
  }
}

async function publishNewInquiry(propertyId, inquiry) {
  if (!client) return; // no key configured -- no-op, not an error
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-inquiry', inquiry);
}

module.exports = { publishNewInquiry };
