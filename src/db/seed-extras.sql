INSERT INTO extra (name, description, price) VALUES
  ('Flowers',              'A curated arrangement of tropical blooms placed in your room on arrival.',          75.00),
  ('Champagne',            'A chilled bottle of Moët & Chandon awaiting your arrival.',                       120.00),
  ('Chocolates',           'Hand-crafted artisan chocolates from our island pastry kitchen.',                   45.00),
  ('Fruit Basket',         'A fresh selection of tropical fruits sourced from local growers.',                  60.00),
  ('Romantic Turndown',    'Rose petals, candles, and a personalised note prepared for your evening.',         150.00),
  ('Birthday Cake',        'A bespoke celebration cake crafted by our pastry team.',                           110.00),
  ('Private Chef Dinner',  'An exclusive in-villa dining experience prepared by our executive chef.',          450.00),
  ('Couples Massage',      'A 60-minute couples massage in the privacy of your villa.',                        320.00),
  ('Late Check-out',       'Extend your stay until 4pm and make the most of your final morning.',              100.00),
  ('Early Check-in',       'Arrive from 10am and settle in before the standard check-in time.',                100.00)
ON CONFLICT DO NOTHING;
