-- Seed data for hotel booking API
-- Run after schema.sql

-- Room types
INSERT INTO room_type (id, name, description, max_occupancy, base_rate) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Standard',    'Comfortable room with queen bed, en-suite bathroom and city view', 2, 120.00),
  ('a1000000-0000-0000-0000-000000000002', 'Deluxe',      'Spacious room with king bed, lounge area and garden view',         2, 180.00),
  ('a1000000-0000-0000-0000-000000000003', 'Family',      'Two queen beds, kitchenette, ideal for families up to 4 guests',   4, 240.00),
  ('a1000000-0000-0000-0000-000000000004', 'Suite',       'Luxury suite with separate living room, king bed and ocean view',  2, 350.00),
  ('a1000000-0000-0000-0000-000000000005', 'Penthouse',   'Full-floor penthouse with panoramic views and private terrace',    4, 750.00);

-- Rooms
INSERT INTO room (id, room_type_id, room_number, floor, status) VALUES
  -- Standard rooms (floor 1-3)
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '101', 1, 'active'),
  ('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', '102', 1, 'active'),
  ('b1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', '201', 2, 'active'),
  ('b1000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', '202', 2, 'active'),
  ('b1000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001', '301', 3, 'maintenance'),
  -- Deluxe rooms (floor 4-5)
  ('b1000000-0000-0000-0000-000000000006', 'a1000000-0000-0000-0000-000000000002', '401', 4, 'active'),
  ('b1000000-0000-0000-0000-000000000007', 'a1000000-0000-0000-0000-000000000002', '402', 4, 'active'),
  ('b1000000-0000-0000-0000-000000000008', 'a1000000-0000-0000-0000-000000000002', '501', 5, 'active'),
  -- Family rooms (floor 3-4)
  ('b1000000-0000-0000-0000-000000000009', 'a1000000-0000-0000-0000-000000000003', '302', 3, 'active'),
  ('b1000000-0000-0000-0000-000000000010', 'a1000000-0000-0000-0000-000000000003', '403', 4, 'active'),
  -- Suites (floor 6)
  ('b1000000-0000-0000-0000-000000000011', 'a1000000-0000-0000-0000-000000000004', '601', 6, 'active'),
  ('b1000000-0000-0000-0000-000000000012', 'a1000000-0000-0000-0000-000000000004', '602', 6, 'active'),
  -- Penthouse (floor 10)
  ('b1000000-0000-0000-0000-000000000013', 'a1000000-0000-0000-0000-000000000005', '1001', 10, 'active');

-- Availability: populate 90 days from 2026-04-03 for all active rooms
-- All dates default to available at room_type base_rate (no override)
INSERT INTO room_availability (room_id, date, is_available)
SELECT
  r.id,
  generate_series('2026-04-03'::date, '2026-07-01'::date, '1 day'::interval)::date AS date,
  true
FROM room r
WHERE r.status = 'active'
ON CONFLICT (room_id, date) DO NOTHING;

-- Override rates for peak season (June)
UPDATE room_availability ra
SET override_rate = rt.base_rate * 1.25
FROM room r
JOIN room_type rt ON rt.id = r.room_type_id
WHERE ra.room_id = r.id
  AND ra.date >= '2026-06-01'
  AND ra.date <  '2026-07-01';

-- Block room 101 for maintenance Apr 10-12
UPDATE room_availability
SET is_available = false, block_reason = 'maintenance'
WHERE room_id = 'b1000000-0000-0000-0000-000000000001'
  AND date >= '2026-04-10'
  AND date <  '2026-04-12';

-- Sample guests
INSERT INTO guest (id, first_name, last_name, email, phone) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'Alice',   'Johnson',  'alice.johnson@example.com',  '+1-555-0101'),
  ('c1000000-0000-0000-0000-000000000002', 'Bob',     'Williams', 'bob.williams@example.com',   '+1-555-0102'),
  ('c1000000-0000-0000-0000-000000000003', 'Carol',   'Smith',    'carol.smith@example.com',    '+44-7700-900001'),
  ('c1000000-0000-0000-0000-000000000004', 'David',   'Brown',    'david.brown@example.com',    '+61-400-000001'),
  ('c1000000-0000-0000-0000-000000000005', 'Emma',    'Davis',    'emma.davis@example.com',     NULL);

-- Sample bookings
-- Alice: Standard room 102, Apr 15-18 (3 nights @ $120 = $360)
INSERT INTO booking (id, guest_id, room_id, check_in, check_out, guests, total_price, status) VALUES
  ('d1000000-0000-0000-0000-000000000001',
   'c1000000-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000002',
   '2026-04-15', '2026-04-18', 1, 360.00, 'confirmed');

-- Mark those dates unavailable
UPDATE room_availability
SET is_available = false
WHERE room_id = 'b1000000-0000-0000-0000-000000000002'
  AND date >= '2026-04-15' AND date < '2026-04-18';

-- Bob: Deluxe room 401, Apr 20-23 (3 nights @ $180 = $540)
INSERT INTO booking (id, guest_id, room_id, check_in, check_out, guests, total_price, status) VALUES
  ('d1000000-0000-0000-0000-000000000002',
   'c1000000-0000-0000-0000-000000000002',
   'b1000000-0000-0000-0000-000000000006',
   '2026-04-20', '2026-04-23', 2, 540.00, 'confirmed');

UPDATE room_availability
SET is_available = false
WHERE room_id = 'b1000000-0000-0000-0000-000000000006'
  AND date >= '2026-04-20' AND date < '2026-04-23';

-- Carol: Suite 601, May 5-10 (5 nights @ $350 = $1750)
INSERT INTO booking (id, guest_id, room_id, check_in, check_out, guests, total_price, status) VALUES
  ('d1000000-0000-0000-0000-000000000003',
   'c1000000-0000-0000-0000-000000000003',
   'b1000000-0000-0000-0000-000000000011',
   '2026-05-05', '2026-05-10', 2, 1750.00, 'confirmed');

UPDATE room_availability
SET is_available = false
WHERE room_id = 'b1000000-0000-0000-0000-000000000011'
  AND date >= '2026-05-05' AND date < '2026-05-10';

-- David: Family room, Apr 5-7, already checked out
INSERT INTO booking (id, guest_id, room_id, check_in, check_out, guests, total_price, status) VALUES
  ('d1000000-0000-0000-0000-000000000004',
   'c1000000-0000-0000-0000-000000000004',
   'b1000000-0000-0000-0000-000000000009',
   '2026-04-05', '2026-04-07', 3, 480.00, 'checked_out');

-- Sample payments
INSERT INTO payment (booking_id, amount, method, status, paid_at) VALUES
  ('d1000000-0000-0000-0000-000000000001', 360.00, 'card',          'completed', '2026-04-14 10:00:00+00'),
  ('d1000000-0000-0000-0000-000000000002', 540.00, 'card',          'completed', '2026-04-19 14:30:00+00'),
  ('d1000000-0000-0000-0000-000000000003', 875.00, 'bank_transfer', 'completed', '2026-05-01 09:00:00+00'),
  ('d1000000-0000-0000-0000-000000000003', 875.00, 'bank_transfer', 'completed', '2026-05-04 09:00:00+00'),
  ('d1000000-0000-0000-0000-000000000004', 480.00, 'cash',          'completed', '2026-04-07 11:00:00+00');

-- Refresh materialised view
REFRESH MATERIALIZED VIEW room_type_availability;
