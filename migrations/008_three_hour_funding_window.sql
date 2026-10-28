UPDATE swaps s
SET quote_deadline = LEAST(
      s.quote_deadline,
      (
        SELECT MIN(e.created_at) + INTERVAL '3 hours'
        FROM swap_status_events e
        WHERE e.swap_id = s.id
          AND e.status = 'PENDING_DEPOSIT'
      )
    ),
    next_poll_at = NOW(),
    updated_at = NOW()
FROM tickets t
WHERE t.id = s.ticket_id
  AND t.state = 'DELETED'
  AND s.status = 'PENDING_DEPOSIT'
  AND s.executable_quote IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM swap_status_events e
    WHERE e.swap_id = s.id
      AND e.status = 'PENDING_DEPOSIT'
  );
