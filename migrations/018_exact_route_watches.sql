CREATE INDEX IF NOT EXISTS tickets_exact_route_watch_due_idx
  ON tickets (route_watch_checked_at, route_watch_created_at)
  WHERE state = 'OPEN'
    AND step = 'USD_AMOUNT'
    AND route_watch_action = 'exact'
    AND route_watch_notified_at IS NULL;
