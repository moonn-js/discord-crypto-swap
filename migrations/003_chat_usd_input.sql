ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS amount_usd_requested TEXT,
  ADD COLUMN IF NOT EXISTS conversion_price_usd TEXT,
  ADD COLUMN IF NOT EXISTS conversion_price_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_message_id TEXT;

DELETE FROM swaps s
USING tickets t
WHERE s.ticket_id = t.id
  AND t.state = 'OPEN'
  AND s.executable_quote IS NULL;

UPDATE tickets t
SET step = 'ORIGIN_COIN',
    state_data = '{}'::jsonb,
    last_error_code = NULL,
    last_error_status = NULL,
    last_error_at = NULL,
    updated_at = NOW()
WHERE t.state = 'OPEN'
  AND NOT EXISTS (
    SELECT 1
    FROM swaps s
    WHERE s.ticket_id = t.id
      AND s.executable_quote IS NOT NULL
  );
