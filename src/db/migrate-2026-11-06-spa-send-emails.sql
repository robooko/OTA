-- false = OTA sends this spa appointment's guest no confirmation,
-- cancellation, reminder (email or SMS) or review request.
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS send_emails BOOLEAN NOT NULL DEFAULT true;
