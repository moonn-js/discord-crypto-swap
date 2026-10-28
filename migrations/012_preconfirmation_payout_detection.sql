ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS payout_monitor_provider TEXT,
  ADD COLUMN IF NOT EXISTS payout_monitor_id TEXT,
  ADD COLUMN IF NOT EXISTS payout_monitor_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_detected_provider TEXT,
  ADD COLUMN IF NOT EXISTS payout_detected_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS payout_detected_explorer_url TEXT,
  ADD COLUMN IF NOT EXISTS payout_detected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS swaps_payout_monitor_candidates_idx
  ON swaps (status, updated_at)
  WHERE executable_quote IS NOT NULL
    AND payout_sent_message_id IS NULL
    AND status IN ('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING');

CREATE INDEX IF NOT EXISTS swaps_payout_monitor_cleanup_idx
  ON swaps (payout_monitor_provider, payout_monitor_created_at)
  WHERE payout_monitor_id IS NOT NULL;
