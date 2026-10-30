// Rate plans (Saver/Flex): the pure money, deadline and policy rules. No DB,
// no Stripe -- see docs/superpowers/specs/2026-10-30-room-rate-plans-design.md.
const { toCents } = require('./folio');

// How long an unpaid plan booking holds the room, by who made it.
const PAY_WINDOW_MINUTES = { api_key: 30, staff: 1440 };
// Card authorisations last ~7 days; a hold is captured at the deadline.
const HOLD_MAX_DAYS = 6;

const PAYMENT_MODES = ['full', 'deposit', 'hold'];
const PLAN_STATUSES = ['active', 'archived'];

// Nightly rate with the plan's adjustment, rounded per night.
function applyAdjustment(nightRate, adjustmentPct) {
  return Math.round(toCents(nightRate) * (100 + Number(adjustmentPct)) / 100) / 100;
}

// 00:00 on dateStr in tz, as a UTC instant.
function zonedMidnightUtc(dateStr, tz) {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

// Free cancellation ends cutoffHours before check-in day's local midnight.
function cancelDeadline(checkIn, timezone, cutoffHours) {
  if (cutoffHours == null) return null;
  return new Date(zonedMidnightUtc(checkIn, timezone).getTime() - Number(cutoffHours) * 3600 * 1000);
}

// A hold must be captured before the authorisation lapses, so it is only
// used when the deadline is ahead and within HOLD_MAX_DAYS; otherwise full.
function effectiveMode(terms, deadline, now) {
  if (terms.payment_mode !== 'hold') return terms.payment_mode;
  const ahead = deadline ? deadline.getTime() - now.getTime() : -1;
  return ahead > 0 && ahead <= HOLD_MAX_DAYS * 86400 * 1000 ? 'hold' : 'full';
}

function chargeAmountCents(mode, terms, chargesCents, balanceCents) {
  if (mode !== 'deposit') return balanceCents;
  const deposit = terms.deposit_kind === 'percent'
    ? Math.round(chargesCents * Number(terms.deposit_value) / 100)
    : toCents(terms.deposit_value);
  return Math.min(deposit, balanceCents);
}

// What a guest (API-key) cancellation may do.
function guestCancelDecision(booking, deadline, now) {
  const terms = booking.rate_plan_terms;
  if (!terms) return 'as_today';
  if (booking.status === 'pending_payment') return 'release';
  if (terms.refundable && deadline && now < deadline) return 'refund';
  return 'refuse';
}

const isInt = (v) => Number.isInteger(v);

// Validates a full (merged) plan; returns an error message or null.
function validatePlan(p) {
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100) return 'name is required (max 100 characters)';
  const adj = Number(p.adjustment_pct ?? 0);
  if (!Number.isFinite(adj) || adj < -100 || adj > 1000) return 'adjustment_pct must be a number between -100 and 1000';
  if (typeof p.refundable !== 'boolean') return 'refundable must be true or false';
  if (p.refundable) {
    if (!isInt(p.cancel_cutoff_hours) || p.cancel_cutoff_hours < 0 || p.cancel_cutoff_hours > 8760) {
      return 'cancel_cutoff_hours must be a whole number of hours (0-8760) for a refundable plan';
    }
  } else if (p.cancel_cutoff_hours != null) {
    return 'cancel_cutoff_hours must be null for a non-refundable plan';
  }
  if (!PAYMENT_MODES.includes(p.payment_mode)) return `payment_mode must be one of: ${PAYMENT_MODES.join(', ')}`;
  if (p.payment_mode === 'hold' && !p.refundable) return 'hold is only allowed on a refundable plan';
  if (p.payment_mode === 'deposit') {
    if (!['percent', 'fixed'].includes(p.deposit_kind)) return 'deposit_kind must be percent or fixed for a deposit plan';
    const v = Number(p.deposit_value);
    if (p.deposit_value == null || !Number.isFinite(v) || v <= 0 || (p.deposit_kind === 'percent' ? v > 100 : v > 99999999.99)) {
      return p.deposit_kind === 'percent' ? 'deposit_value must be a percentage above 0 and at most 100' : 'deposit_value must be an amount above 0';
    }
  } else if (p.deposit_kind != null || p.deposit_value != null) {
    return 'deposit_kind and deposit_value are only for deposit plans';
  }
  if (p.sort_order != null && !isInt(p.sort_order)) return 'sort_order must be a whole number';
  if (p.status != null && !PLAN_STATUSES.includes(p.status)) return `status must be one of: ${PLAN_STATUSES.join(', ')}`;
  return null;
}

// What a booking keeps of its plan: enforcement reads this, never the live plan.
function termsSnapshot(plan, { pay_at_hotel }) {
  return {
    name: plan.name,
    adjustment_pct: Number(plan.adjustment_pct),
    refundable: plan.refundable,
    cancel_cutoff_hours: plan.cancel_cutoff_hours,
    payment_mode: plan.payment_mode,
    deposit_kind: plan.deposit_kind,
    deposit_value: plan.deposit_value == null ? null : Number(plan.deposit_value),
    pay_at_hotel: !!pay_at_hotel,
  };
}

module.exports = {
  PAY_WINDOW_MINUTES, HOLD_MAX_DAYS,
  applyAdjustment, cancelDeadline, effectiveMode, chargeAmountCents, guestCancelDecision, validatePlan, termsSnapshot,
};
