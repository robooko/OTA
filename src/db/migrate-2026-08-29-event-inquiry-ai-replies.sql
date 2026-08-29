-- One-time migration: Claude-drafted replies for event inquiries.
--
-- property gains three admin-editable settings: ai_reply_mode ('off' = no
-- automation, 'draft' = every AI reply needs individual approval, 'auto' =
-- send without review when the model scores itself >= ai_reply_auto_send_min_score
-- and did not flag requires_human), and ai_reply_instructions -- free-text
-- venue knowledge/tone/limits that is the ONLY source of facts the model may
-- state. Defaults to 'off': nothing changes for any property until an admin
-- opts in.
--
-- event_inquiry_ai_draft is one row per generation attempt (new inquiry,
-- inbound guest reply, or a manual staff request). Failed calls are stored
-- too (status 'failed', error text, requires_human = true) so the approval
-- queue shows "needs a human" instead of silently doing nothing. 'sending'
-- is a claim state: a draft moves pending -> sending atomically before Resend
-- is called, so two staff approving at once, or a crash between send and
-- persist, can't email the guest twice.
--
-- event_inquiry_message.ai_draft_id is added via ALTER (the draft table
-- references event_inquiry_message, so the back-reference has to go on
-- after both exist -- same shape as restaurant_table_session.reservation_id).
--
-- No backfill: existing properties stay 'off'; existing messages have a NULL
-- ai_draft_id (human-written).
--
-- Idempotent-safe via IF NOT EXISTS / pg_constraint guards.

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS ai_reply_mode VARCHAR(10) NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS ai_reply_instructions TEXT,
  ADD COLUMN IF NOT EXISTS ai_reply_auto_send_min_score INT NOT NULL DEFAULT 80;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_ai_reply_mode_check'
  ) THEN
    ALTER TABLE property
      ADD CONSTRAINT property_ai_reply_mode_check CHECK (ai_reply_mode IN ('off', 'draft', 'auto'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'property_ai_reply_auto_send_min_score_check'
  ) THEN
    ALTER TABLE property
      ADD CONSTRAINT property_ai_reply_auto_send_min_score_check CHECK (ai_reply_auto_send_min_score BETWEEN 0 AND 100);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_inquiry_ai_draft (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id             UUID NOT NULL REFERENCES property(id),
  event_inquiry_id        UUID NOT NULL REFERENCES event_inquiry(id),
  trigger_type            VARCHAR(20) NOT NULL,
  trigger_message_id      UUID REFERENCES event_inquiry_message(id),
  body                    TEXT NOT NULL,
  quality_score           INT NOT NULL,
  requires_human          BOOLEAN NOT NULL,
  requires_human_reason   TEXT,
  summary                 TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
  auto_sent               BOOLEAN NOT NULL DEFAULT false,
  sent_message_id         UUID REFERENCES event_inquiry_message(id),
  sent_body               TEXT,
  reviewed_by_user_id     VARCHAR(255),
  reviewed_by_name        VARCHAR(255),
  reviewed_at             TIMESTAMPTZ,
  reject_reason           TEXT,
  model                   VARCHAR(50),
  input_tokens            INT,
  output_tokens           INT,
  cache_read_input_tokens INT,
  error                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT event_inquiry_ai_draft_trigger_type_check
    CHECK (trigger_type IN ('new_inquiry', 'inbound_reply', 'manual')),
  CONSTRAINT event_inquiry_ai_draft_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'superseded', 'failed')),
  CONSTRAINT event_inquiry_ai_draft_quality_score_check
    CHECK (quality_score BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_ai_draft_inquiry ON event_inquiry_ai_draft(event_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_ai_draft_property_pending
  ON event_inquiry_ai_draft(property_id) WHERE status = 'pending';

ALTER TABLE event_inquiry_message
  ADD COLUMN IF NOT EXISTS ai_draft_id UUID REFERENCES event_inquiry_ai_draft(id);
