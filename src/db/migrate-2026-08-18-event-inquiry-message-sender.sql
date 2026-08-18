-- One-time migration: attribute outbound event-inquiry replies to the staff
-- member who actually sent them, instead of the client guessing "whoever's
-- signed in now" (see event-inquiry-dialogs.ts buildAvatarEl). Denormalized
-- (name/avatar_url captured at send time) rather than a live Clerk lookup on
-- every list, same tradeoff as event_inquiry storing guest name/email inline.
-- All nullable: inbound messages have no sender, and existing outbound rows
-- predate attribution and can't be backfilled.

ALTER TABLE event_inquiry_message
  ADD COLUMN IF NOT EXISTS sent_by_user_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sent_by_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sent_by_avatar_url TEXT;
