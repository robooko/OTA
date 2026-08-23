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

// Mirrors new-order/order-status-changed onto a property-wide channel, for a
// dashboard that shows orders across every restaurant on the property rather
// than one restaurant at a time (the restaurant-scoped channel above stays,
// for guest-facing views scoped to a single restaurant).
async function publishNewOrderForProperty(propertyId, order) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:orders`);
  await channel.publish('new-order', order);
}

async function publishOrderStatusChangedForProperty(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:orders`);
  await channel.publish('order-status-changed', payload);
}

// Mirrors the restaurant-wide status event onto a per-booking channel, so a
// guest-facing view can subscribe without seeing every other guest's orders
// (peter-island mints a booking-scoped Ably token for that channel).
async function publishOrderStatusChangedForBooking(bookingId, payload) {
  if (!client || !bookingId) return;
  const channel = client.channels.get(`room-service:${bookingId}`);
  await channel.publish('order-status-changed', payload);
}

// Restaurant reservations had no Ably publishing at all before this --
// property:{id}:reservations already has a subscriber (the main dashboard's
// <live-reservations-feed> via reservations/ably-auth.ts) that's been
// wired up but silently dead since nothing ever published to it; this
// fixes that as well as adding the new restaurant-scoped channel below.
async function publishNewReservation(restaurantId, propertyId, reservation) {
  if (!client) return;
  await Promise.all([
    client.channels.get(`restaurant:${restaurantId}:reservations`).publish('new-reservation', reservation),
    client.channels.get(`property:${propertyId}:reservations`).publish('new-reservation', reservation),
  ]);
}

async function publishReservationStatusChanged(restaurantId, propertyId, payload) {
  if (!client) return;
  await Promise.all([
    client.channels.get(`restaurant:${restaurantId}:reservations`).publish('reservation-status-changed', payload),
    client.channels.get(`property:${propertyId}:reservations`).publish('reservation-status-changed', payload),
  ]);
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

async function publishNewBooking(propertyId, booking) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:bookings`);
  await channel.publish('new-booking', booking);
}

async function publishBookingStatusChanged(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:bookings`);
  await channel.publish('booking-status-changed', payload);
}

async function publishNewAppointment(spaId, appointment) {
  if (!client) return;
  const channel = client.channels.get(`spa:${spaId}:appointments`);
  await channel.publish('new-appointment', appointment);
}

async function publishAppointmentStatusChanged(spaId, payload) {
  if (!client) return;
  const channel = client.channels.get(`spa:${spaId}:appointments`);
  await channel.publish('appointment-status-changed', payload);
}

// Mirrors new-appointment/appointment-status-changed onto a property-wide
// channel, for @forgebuild/hotal-ui's <live-spa-bookings-feed> (a property
// dashboard showing bookings across every spa, not one spa at a time --
// same relationship as publishNewOrderForProperty is to publishNewOrder).
// Event names ('new-booking'/'booking-status-changed') match what that
// component subscribes to, not the spa-scoped appointment event names above.
async function publishNewSpaBookingForProperty(propertyId, booking) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:spa-bookings`);
  await channel.publish('new-booking', booking);
}

async function publishSpaBookingStatusChangedForProperty(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:spa-bookings`);
  await channel.publish('booking-status-changed', payload);
}

// For @forgebuild/hotal-ui's <live-golf-bookings-feed> -- golf has no prior
// per-course Ably channel to mirror (unlike spa's spa:{id}:appointments), so
// this is the only publish path for golf bookings.
async function publishNewGolfBookingForProperty(propertyId, booking) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:golf-bookings`);
  await channel.publish('new-booking', booking);
}

async function publishGolfBookingStatusChangedForProperty(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:golf-bookings`);
  await channel.publish('booking-status-changed', payload);
}

// Pro shop purchases don't have a "booking" of their own -- an item is a line
// added to (or removed from) an existing golf booking, so there's no
// new-booking/status-changed lifecycle to mirror here, just the item event
// itself. Property-wide only: addBookingItem/removeBookingItem take no
// shop_id, so there's no per-shop channel to scope to (unlike spa's
// spa:{id}:appointments).
async function publishProshopItemAdded(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:proshop`);
  await channel.publish('item-added', payload);
}

async function publishProshopItemRemoved(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:proshop`);
  await channel.publish('item-removed', payload);
}

module.exports = {
  publishNewInquiry,
  publishNewOrder,
  publishOrderStatusChanged,
  publishNewOrderForProperty,
  publishOrderStatusChangedForProperty,
  publishOrderStatusChangedForBooking,
  publishNewReservation,
  publishReservationStatusChanged,
  publishNewReply,
  publishInquiryUpdated,
  publishNewBooking,
  publishBookingStatusChanged,
  publishNewAppointment,
  publishAppointmentStatusChanged,
  publishNewSpaBookingForProperty,
  publishSpaBookingStatusChangedForProperty,
  publishNewGolfBookingForProperty,
  publishGolfBookingStatusChangedForProperty,
  publishProshopItemAdded,
  publishProshopItemRemoved,
  client,
};
