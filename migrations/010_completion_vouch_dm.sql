ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS completion_vouch_dm_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_vouch_dm_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_vouch_dm_failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS swaps_pending_completion_vouch_dm_idx
  ON swaps (terminal_at, updated_at)
  WHERE status = 'SUCCESS'
    AND executable_quote IS NOT NULL
    AND completion_vouch_dm_sent_at IS NULL
    AND completion_vouch_dm_failed_at IS NULL;
