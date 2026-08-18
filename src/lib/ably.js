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

async function publishNewOrder(restaurantId, order) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('new-order', order);
}

async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}

async function publishNewReply(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('new-reply', payload);
}

async function publishInquiryUpdated(propertyId, inquiry) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:inquiries`);
  await channel.publish('inquiry-updated', inquiry);
}

module.exports = { publishNewInquiry, publishNewOrder, publishOrderStatusChanged, publishNewReply, publishInquiryUpdated, client };
