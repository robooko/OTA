// Spa "regulars' rate" (member pricing) -- see
// migrate-2026-09-21-spa-member-pricing.sql for the columns.
//
// A client gets a treatment's member_price for an appointment dated D when
// they had a visit on or after D - MEMBER_WINDOW_DAYS, or guest.member_until
// covers D. A visit counts once staff have checked it in or marked it
// completed (so an in-chair rebook qualifies the moment the client is
// checked in), or once a still-'confirmed' appointment has ended -- the
// same "not ticked off but clearly happened" rule the review-request sweep
// uses (reviewRequester.js). cancelled / no_show never count.
//
// Identity is an email the CALLER vouches for (member_email on the API),
// never the booking's own contact_email: a public booking form's email field
// is unverified, so trusting it would let anyone type a regular's address to
// get their rate. The Proper site passes the signed-in Clerk user's email;
// staff-side callers can pass the contact email they're entering.

const MEMBER_WINDOW_DAYS = 28;

// Returns 'YYYY-MM-DD' -- the last appointment date this email gets the
// regulars' rate for at this property -- or null. `db` is the pool or a
// transaction client.
async function memberRateUntil(db, propertyId, email) {
  if (!email) return null;
  const { rows: [row] } = await db.query(
    `SELECT to_char(GREATEST(
       (SELECT max(g.member_until) FROM guest g
        WHERE g.property_id = $1 AND lower(g.email) = lower($2)),
       (SELECT max(sa.appointment_date) + $3::int
        FROM spa_appointment sa
        JOIN property p ON p.id = sa.property_id
        LEFT JOIN guest g ON g.id = sa.guest_id
        WHERE sa.property_id = $1
          AND (lower(sa.contact_email) = lower($2) OR lower(g.email) = lower($2))
          AND (
            sa.status IN ('checked_in', 'completed')
            OR (sa.status = 'confirmed'
                AND (sa.appointment_date + sa.end_time) AT TIME ZONE p.timezone <= now())
          ))
     ), 'YYYY-MM-DD') AS until`,
    [propertyId, email, MEMBER_WINDOW_DAYS]
  );
  return row?.until ?? null;
}

// Which price/duration a treatment books at on `date` for someone whose
// rate runs through `memberUntil` (from memberRateUntil, or null).
// Returns { ok: true, price, durationMins, memberRate } or
// { ok: false, code: 'members_only' } for a regulars-only treatment the
// client doesn't qualify for on that date.
function resolveRate(treatment, memberUntil, date) {
  const member = treatment.member_price != null && memberUntil != null && date <= memberUntil;
  if (member) {
    return {
      ok: true,
      price: treatment.member_price,
      durationMins: treatment.member_duration_mins ?? treatment.duration_mins,
      memberRate: true,
    };
  }
  if (treatment.price == null) return { ok: false, code: 'members_only' };
  return { ok: true, price: treatment.price, durationMins: treatment.duration_mins, memberRate: false };
}

module.exports = { MEMBER_WINDOW_DAYS, memberRateUntil, resolveRate };
