-- Property, bootstrap admin, and bungalow rooms for BBYC (Bora Bora Yacht
-- Club). Run after schema.sql - independent of seed.sql's data, but kept in
-- the same file list for fresh resets. Not safely re-runnable (would create
-- a duplicate BBYC property) - same one-time-script caveat as
-- seed-restaurant-bbyc.sql. See
-- docs/superpowers/specs/2026-07-22-bbyc-rooms-design.md.

INSERT INTO property (id, name, status) VALUES
  ('e1000000-0000-0000-0000-000000000004', 'BBYC', 'active');

-- Bootstrap admin (password: "changeme123", same hash as the other seeded admins)
INSERT INTO api_user (id, property_id, name, email, password_hash, role) VALUES
  ('f4000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000004',
   'BBYC Admin', 'admin@bbyc.example.com',
   '$2b$12$AeG.yVLwhNPTxp2WeowJ8OZ6J9m4Kyn/sasVTECO/nHbxaBXMzycu', 'admin');

-- Room type
INSERT INTO room_type (id, property_id, name, description, max_occupancy, base_rate) VALUES
  ('a4000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000004',
   'Bungalow', 'Waterfront bungalow at the Bora Bora Yacht Club', 2, 450.00);

-- Rooms
INSERT INTO room (id, property_id, room_type_id, room_number, floor, status) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B1', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B2', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B3', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B4', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000005', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B5', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000006', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B6', NULL, 'active');

-- Availability: 90 days forward from today (2026-07-22) so BBYC is bookable now
INSERT INTO room_availability (property_id, room_id, date, is_available)
SELECT
  r.property_id,
  r.id,
  generate_series('2026-07-22'::date, '2026-10-20'::date, '1 day'::interval)::date AS date,
  true
FROM room r
WHERE r.property_id = 'e1000000-0000-0000-0000-000000000004'
  AND r.status = 'active'
ON CONFLICT (room_id, date) DO NOTHING;

REFRESH MATERIALIZED VIEW room_type_availability;
