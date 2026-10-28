ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS route_watch_action TEXT,
  ADD COLUMN IF NOT EXISTS route_watch_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS route_watch_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS route_watch_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS route_watch_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS route_watch_notification_message_id TEXT;

CREATE INDEX IF NOT EXISTS tickets_route_watch_due_idx
  ON tickets (route_watch_checked_at, route_watch_created_at)
  WHERE state = 'OPEN'
    AND step = 'ORIGIN_COIN'
    AND route_watch_action IS NOT NULL
    AND route_watch_notified_at IS NULL;
