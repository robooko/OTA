-- false = OTA sends this room booking's guest no emails: pay link,
-- confirmation, review request, cleanliness rating.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS send_emails BOOLEAN NOT NULL DEFAULT true;
