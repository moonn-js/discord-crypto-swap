ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS payout_sent_notification_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_sent_message_id TEXT;
