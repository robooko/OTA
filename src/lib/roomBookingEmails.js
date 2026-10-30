// Guest emails for room bookings on a rate plan: the staff-booking pay link
// and the confirmation. Fire-and-forget -- errors are logged, never thrown,
// so an email failure can't undo a booking. See
// docs/superpowers/specs/2026-10-30-room-rate-plans-design.md §10.
const pool = require('../db');
const resend = require('./resend');
const { computeFolio, toCents, fromCents } = require('./folio');
const { cancelDeadline, effectiveMode, chargeAmountCents } = require('./ratePlans');

const formatLocal = (date, timezone) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(date);

function cancelTermsLine(terms, deadline, timezone) {
  if (!terms.refundable || !deadline) return 'Non-refundable.';
  return `Free cancellation until ${formatLocal(deadline, timezone)} (${timezone}).`;
}

function bookingUrl(template, bookingId) {
  return template ? template.replaceAll('{id}', bookingId) : null;
}

async function loadEmailContext(bookingId) {
  const { rows: [b] } = await pool.query(
    `SELECT b.id, b.property_id, b.check_in, b.check_out, (b.check_out - b.check_in) AS nights,
            b.rate_plan_terms, b.payment_due_at,
            g.email, g.first_name, rt.name AS room_type_name,
            p.name AS property_name, p.email_branding, p.room_booking_url, p.timezone, p.currency
     FROM booking b
     JOIN guest g     ON g.id = b.guest_id
     JOIN room r      ON r.id = b.room_id
     JOIN room_type rt ON rt.id = r.room_type_id
     JOIN property p  ON p.id = b.property_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!b?.rate_plan_terms) return null;
  const folio = await computeFolio(b.id, b.property_id);
  const terms = b.rate_plan_terms;
  return {
    b, folio, terms,
    deadline: terms.refundable ? cancelDeadline(b.check_in, b.timezone, terms.cancel_cutoff_hours) : null,
    common: {
      to: b.email,
      name: b.first_name,
      propertyName: b.property_name,
      branding: b.email_branding ?? undefined,
      stay: { room_type_name: b.room_type_name, check_in: b.check_in, check_out: b.check_out, nights: b.nights },
      planName: terms.name,
      currency: b.currency,
    },
  };
}

async function sendPayRequest(bookingId) {
  try {
    const ctx = await loadEmailContext(bookingId);
    if (!ctx) return;
    const { b, folio, terms, deadline, common } = ctx;
    const mode = terms.mode_used ?? effectiveMode(terms, deadline, new Date());
    const due = chargeAmountCents(mode, terms, toCents(folio.charges_total), toCents(folio.balance));
    await resend.sendRoomPayRequest({
      ...common,
      amountDue: fromCents(due),
      payBy: formatLocal(new Date(b.payment_due_at), b.timezone),
      payUrl: bookingUrl(b.room_booking_url, b.id),
      idempotencyKey: `room-pay-request-${b.id}`,
    });
  } catch (err) {
    console.error(`Room pay-request email failed for ${bookingId}:`, err.message);
  }
}

async function sendConfirmation(bookingId) {
  try {
    const ctx = await loadEmailContext(bookingId);
    if (!ctx) return;
    const { b, folio, terms, deadline, common } = ctx;
    await resend.sendRoomConfirmation({
      ...common,
      amountPaid: folio.payments_total,
      balanceDue: folio.balance,
      cancelLine: cancelTermsLine(terms, deadline, b.timezone),
      manageUrl: bookingUrl(b.room_booking_url, b.id),
      idempotencyKey: `room-confirmation-${b.id}`,
    });
  } catch (err) {
    console.error(`Room confirmation email failed for ${bookingId}:`, err.message);
  }
}

module.exports = { cancelTermsLine, bookingUrl, sendPayRequest, sendConfirmation };
