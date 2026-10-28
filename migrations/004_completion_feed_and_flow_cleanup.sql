ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS completion_summary_message_id TEXT,
  ADD COLUMN IF NOT EXISTS completion_summary_claimed_at TIMESTAMPTZ;

UPDATE tickets
SET step = 'USD_AMOUNT',
    state_data = state_data - 'routeLimits',
    updated_at = NOW()
WHERE state = 'OPEN'
  AND step = 'ROUTE_LIMITS_LOADING';

UPDATE tickets
SET state_data = state_data - 'routeLimits',
    updated_at = NOW()
WHERE state = 'OPEN'
  AND state_data ? 'routeLimits';

CREATE INDEX IF NOT EXISTS swaps_pending_completion_summary_idx
  ON swaps (terminal_at, updated_at)
  WHERE status = 'SUCCESS' AND completion_summary_message_id IS NULL;
