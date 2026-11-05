// Who to upgrade first when a room type is oversold: a fixed weighted score
// over what OTA knows about the guest and the stay, with the reasons shown to
// the desk so staff can overrule it (occasions, complaints and group blocks
// aren't recorded, so those stay human judgement).
// ponytail: fixed weights, no per-property settings -- add them if a property asks.

const YEAR_MS = 365 * 24 * 3600 * 1000;

// h: { past_stays, past_spend, past_extras, last_stay (YYYY-MM-DD|null),
//      cancellations, direct, refundable, adjustment_pct, check_in }
function upgradeScore(h) {
  let score = 0;
  const reasons = [];
  const add = (pts, why) => { if (pts) { score += pts; reasons.push(why); } };

  const stays = Number(h.past_stays) || 0;
  if (stays) add(Math.min(stays, 5) * 10, `${stays} past stay${stays === 1 ? '' : 's'}`);
  else add(5, 'first stay');
  const spend = Number(h.past_spend) || 0;
  if (spend) add(Math.min(Math.floor(spend / 200), 15), `${Math.round(spend)} spent before`);
  if (Number(h.past_extras) > 0) add(10, 'buys extras');
  if (stays >= 2 && h.last_stay && Date.parse(h.check_in) - Date.parse(h.last_stay) > YEAR_MS) add(10, 'lapsed regular');
  if (h.direct) add(15, 'booked direct');
  if (h.adjustment_pct != null && Number(h.adjustment_pct) >= 0) add(10, 'full rate');
  if (h.refundable) add(5, 'flexible rate');
  const cancels = Number(h.cancellations) || 0;
  if (cancels) add(-Math.min(cancels, 3) * 5, `${cancels} cancellation${cancels === 1 ? '' : 's'}`);
  return { upgrade_score: score, upgrade_reasons: reasons };
}

module.exports = { upgradeScore };

if (require.main === module) {
  const assert = require('node:assert');
  const regular = upgradeScore({ past_stays: 6, past_spend: 4000, past_extras: 120, last_stay: '2024-01-01',
    cancellations: 0, direct: true, refundable: true, adjustment_pct: 0, check_in: '2026-11-05' });
  assert.strictEqual(regular.upgrade_score, 50 + 15 + 10 + 10 + 15 + 10 + 5);
  assert.ok(regular.upgrade_reasons.includes('lapsed regular'));
  const ota = upgradeScore({ past_stays: 0, past_spend: 0, past_extras: 0, last_stay: null,
    cancellations: 2, direct: false, refundable: false, adjustment_pct: -12, check_in: '2026-11-05' });
  assert.strictEqual(ota.upgrade_score, 5 - 10);
  assert.deepStrictEqual(ota.upgrade_reasons, ['first stay', '2 cancellations']);
  console.log('upgradeScore ok');
}
