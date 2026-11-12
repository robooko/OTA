-- Spa appointments marked paid before payment rows recorded spa money: one
-- completed payment each, for the price as frozen at booking, so a spa
-- appointment's folio (lib/entityFolio.js) shows what was paid. Payment rows
-- are the record from here on: the spa payment flows and the import write
-- them. Re-runnable: an appointment with any payment row is skipped. Data
-- only, no schema.sql change. See
-- docs/superpowers/plans/2026-11-12-entity-charges-2-spa.md.
INSERT INTO payment (property_id, spa_appointment_id, amount, method, status, stripe_payment_intent_id, paid_at)
SELECT sa.property_id, sa.id, COALESCE(sa.price, st.price, 0), sa.payment_method, 'completed',
       sa.stripe_payment_intent_id, COALESCE(sa.paid_at, now())
FROM spa_appointment sa
JOIN spa_treatment st ON st.id = sa.treatment_id
WHERE sa.payment_status = 'paid'
  AND COALESCE(sa.price, st.price, 0) > 0
  AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.spa_appointment_id = sa.id);
