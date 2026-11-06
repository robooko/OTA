-- Money columns NUMERIC(10,2) -> NUMERIC(14,2): (10,2) tops out at 99,999,999.99,
-- which IDR amounts (Rp 100M+) overflow. Widening keeps the scale, so no table
-- rewrite. room_type_availability reads three of the rate columns, so it is
-- dropped and recreated as in schema.sql (unchanged definition).
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS room_type_availability;
ALTER TABLE booking ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE booking_extra ALTER COLUMN unit_price TYPE NUMERIC(14,2);
ALTER TABLE channel_ari ALTER COLUMN rate TYPE NUMERIC(14,2);
ALTER TABLE course ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE course_enrolment ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE course_run ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE equipment ALTER COLUMN price_per_day TYPE NUMERIC(14,2), ALTER COLUMN price_per_hour TYPE NUMERIC(14,2);
ALTER TABLE equipment_hire ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE extra ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE folio_adjustment ALTER COLUMN amount TYPE NUMERIC(14,2);
ALTER TABLE golf_booking ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE golf_booking_item ALTER COLUMN unit_price TYPE NUMERIC(14,2);
ALTER TABLE golf_course ALTER COLUMN price_per_player TYPE NUMERIC(14,2);
ALTER TABLE marina_berth ALTER COLUMN price_per_night TYPE NUMERIC(14,2);
ALTER TABLE marina_booking ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE marina_price_tier ALTER COLUMN price_per_month TYPE NUMERIC(14,2), ALTER COLUMN price_per_night TYPE NUMERIC(14,2), ALTER COLUMN price_per_year TYPE NUMERIC(14,2);
ALTER TABLE minibar_item ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE minibar_usage ALTER COLUMN unit_price TYPE NUMERIC(14,2);
ALTER TABLE payment ALTER COLUMN amount TYPE NUMERIC(14,2);
ALTER TABLE proshop_item ALTER COLUMN price TYPE NUMERIC(14,2), ALTER COLUMN sale_price TYPE NUMERIC(14,2);
ALTER TABLE proshop_order ALTER COLUMN items_subtotal TYPE NUMERIC(14,2), ALTER COLUMN shipping_cost TYPE NUMERIC(14,2), ALTER COLUMN tax_amount TYPE NUMERIC(14,2), ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE proshop_order_item ALTER COLUMN subtotal TYPE NUMERIC(14,2), ALTER COLUMN unit_price TYPE NUMERIC(14,2);
ALTER TABLE rate_plan ALTER COLUMN deposit_value TYPE NUMERIC(14,2);
ALTER TABLE restaurant ALTER COLUMN payment_protection_amount TYPE NUMERIC(14,2);
ALTER TABLE restaurant_menu_item ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE restaurant_order ALTER COLUMN items_subtotal TYPE NUMERIC(14,2), ALTER COLUMN tax_amount TYPE NUMERIC(14,2), ALTER COLUMN total_price TYPE NUMERIC(14,2);
ALTER TABLE restaurant_order_item ALTER COLUMN unit_price TYPE NUMERIC(14,2);
ALTER TABLE room_availability ALTER COLUMN override_rate TYPE NUMERIC(14,2);
ALTER TABLE room_type ALTER COLUMN base_rate TYPE NUMERIC(14,2);
ALTER TABLE room_type_rate ALTER COLUMN rate TYPE NUMERIC(14,2);
ALTER TABLE shop_basket ALTER COLUMN items_subtotal TYPE NUMERIC(14,2);
ALTER TABLE spa_appointment ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE spa_treatment ALTER COLUMN member_price TYPE NUMERIC(14,2), ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE tour ALTER COLUMN child_price TYPE NUMERIC(14,2), ALTER COLUMN price TYPE NUMERIC(14,2);
ALTER TABLE tour_booking ALTER COLUMN total_price TYPE NUMERIC(14,2);
CREATE MATERIALIZED VIEW room_type_availability AS
WITH grid AS (
  SELECT r.property_id, r.room_type_id, ra.date,
         COUNT(*) AS total_rooms,
         COUNT(*) FILTER (WHERE ra.is_available AND h.room_id IS NULL)     AS available_rooms,
         COUNT(*) FILTER (WHERE NOT ra.is_available AND h.room_id IS NULL) AS blocked_rooms,
         MIN(COALESCE(ra.override_rate, rtr.rate, rt.base_rate))           AS min_rate
  FROM room_availability ra
  JOIN room      r  ON r.id  = ra.room_id AND r.status = 'active'
  JOIN room_type rt ON rt.id = r.room_type_id
  LEFT JOIN booking_night h ON h.room_id = ra.room_id AND h.night = ra.date
  LEFT JOIN room_type_rate rtr ON rtr.room_type_id = r.room_type_id AND rtr.date = ra.date
  GROUP BY r.property_id, r.room_type_id, ra.date
),
sold AS (
  SELECT COALESCE(hr.room_type_id, b.room_type_id) AS room_type_id, bn.night, COUNT(*) AS n
  FROM booking_night bn JOIN booking b ON b.id = bn.booking_id
  LEFT JOIN room hr ON hr.id = bn.room_id
  GROUP BY 1, bn.night
),
alw AS (
  SELECT g.room_type_id, g.date,
         CASE WHEN p.overbooking_enabled
              THEN LEAST(COALESCE(o.manual_allowance, o.model_allowance, 0), floor(p.oversell_max_pct / 100 * g.total_rooms))::int
              ELSE 0 END AS allowance
  FROM grid g
  JOIN property p ON p.id = g.property_id
  LEFT JOIN room_type_oversell o ON o.room_type_id = g.room_type_id AND o.date = g.date
)
SELECT g.property_id, g.room_type_id, g.date, g.total_rooms, g.available_rooms, g.min_rate,
       COALESCE(s.n, 0)                                                              AS sold,
       a.allowance                                                                   AS oversell_allowance,
       GREATEST(0, g.total_rooms - g.blocked_rooms - COALESCE(s.n, 0) + a.allowance) AS sellable_rooms
FROM grid g
JOIN alw a ON a.room_type_id = g.room_type_id AND a.date = g.date
LEFT JOIN sold s ON s.room_type_id = g.room_type_id AND s.night = g.date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rta_property_type_date ON room_type_availability(property_id, room_type_id, date);
COMMIT;
