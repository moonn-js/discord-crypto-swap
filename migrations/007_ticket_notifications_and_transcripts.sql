ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS inactivity_reminder_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inactivity_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closure_reason TEXT,
  ADD COLUMN IF NOT EXISTS transcript_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transcript_message_id TEXT;

CREATE INDEX IF NOT EXISTS tickets_inactivity_due_idx
  ON tickets (last_activity_at)
  WHERE state IN ('OPEN', 'CREATING');

CREATE INDEX IF NOT EXISTS tickets_transcript_pending_idx
  ON tickets (delete_at)
  WHERE transcript_message_id IS NULL;
