-- Raise the auto-send quality-score default from 80 to 90 -- a new
-- property hasn't yet seen how good its own AI drafts actually are, so
-- starting more conservative (fewer unreviewed auto-sends) is the safer
-- default. Only changes what future INSERTs get; existing rows (whether
-- explicitly set or still at the old default) are untouched -- there's no
-- way to tell those two cases apart, so this doesn't try to.
ALTER TABLE property ALTER COLUMN ai_reply_auto_send_min_score SET DEFAULT 90;
