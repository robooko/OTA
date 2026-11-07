// Guest emails for room bookings on a rate plan: the staff-booking pay link
// and the confirmation. None when booking.send_emails is false. Fire-and-forget -- errors are logged, never thrown,
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

// A multi-room booking gets one email listing every room still booked:
// money is summed over the rooms, keys are per booking (group), not per room.
async function loadEmailContext(bookingId) {
  const { rows: [b] } = await pool.query(
    `SELECT b.id, b.property_id, b.check_in, b.check_out, (b.check_out - b.check_in) AS nights,
            b.rate_plan_terms, b.payment_due_at, b.group_id,
            g.email, g.first_name, rt.name AS room_type_name,
            p.name AS property_name, p.email_branding, p.room_booking_url, p.timezone, p.currency
     FROM booking b
     JOIN guest g     ON g.id = b.guest_id
     LEFT JOIN room r      ON r.id = b.room_id
     JOIN room_type rt ON rt.id = b.room_type_id
     JOIN property p  ON p.id = b.property_id
     WHERE b.id = $1 AND b.send_emails`,
    [bookingId]
  );
  if (!b?.rate_plan_terms) return null;
  const { rows: members } = b.group_id ? await pool.query(
    `SELECT m.id, m.rate_plan_terms, m.check_in, m.check_out, (m.check_out - m.check_in) AS nights, rt.name AS room_type_name
     FROM booking m JOIN room_type rt ON rt.id = m.room_type_id
     WHERE m.group_id = $1 AND m.status NOT IN ('cancelled', 'expired', 'walked') ORDER BY m.id`, [b.group_id]) : { rows: [b] };
  const folios = [];
  for (const m of members) folios.push(await computeFolio(m.id, b.property_id));
  const sum = (k) => fromCents(folios.reduce((a, f) => a + toCents(f[k]), 0));
  const folio = { charges_total: sum('charges_total'), payments_total: sum('payments_total'), balance: sum('balance') };
  const terms = b.rate_plan_terms;
  const stayOf = (m) => ({ room_type_name: m.room_type_name, check_in: m.check_in, check_out: m.check_out, nights: m.nights });
  return {
    b, folio, terms, members, folios,
    key: b.group_id ?? b.id,
    deadline: terms.refundable ? cancelDeadline(b.check_in, b.timezone, terms.cancel_cutoff_hours) : null,
    common: {
      to: b.email,
      name: b.first_name,
      propertyName: b.property_name,
      branding: b.email_branding ?? undefined,
      ...(b.group_id ? { stays: members.map(stayOf) } : { stay: stayOf(b) }),
      planName: terms.name,
      currency: b.currency,
    },
  };
}

async function sendPayRequest(bookingId) {
  try {
    const ctx = await loadEmailContext(bookingId);
    if (!ctx) return;
    const { b, terms, deadline, common, members, folios, key } = ctx;
    const mode = terms.mode_used ?? effectiveMode(terms, deadline, new Date());
    const due = members.reduce((a, m, i) => a + chargeAmountCents(mode, m.rate_plan_terms, toCents(folios[i].charges_total), toCents(folios[i].balance)), 0);
    await resend.sendRoomPayRequest({
      ...common,
      amountDue: fromCents(due),
      payBy: formatLocal(new Date(b.payment_due_at), b.timezone),
      payUrl: bookingUrl(b.room_booking_url, b.id),
      idempotencyKey: `room-pay-request-${key}`,
    });
  } catch (err) {
    console.error(`Room pay-request email failed for ${bookingId}:`, err.message);
  }
}

async function sendConfirmation(bookingId) {
  try {
    const ctx = await loadEmailContext(bookingId);
    if (!ctx) return;
    const { b, folio, terms, deadline, common, key } = ctx;
    await resend.sendRoomConfirmation({
      ...common,
      amountPaid: folio.payments_total,
      balanceDue: folio.balance,
      cancelLine: cancelTermsLine(terms, deadline, b.timezone),
      manageUrl: bookingUrl(b.room_booking_url, b.id),
      idempotencyKey: `room-confirmation-${key}`,
    });
  } catch (err) {
    console.error(`Room confirmation email failed for ${bookingId}:`, err.message);
  }
}

module.exports = { cancelTermsLine, bookingUrl, sendPayRequest, sendConfirmation, loadEmailContext };
