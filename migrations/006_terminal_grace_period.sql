UPDATE tickets t
SET state = 'OPEN',
    step = 'TERMINAL',
    locked_at = NULL,
    updated_at = NOW()
FROM swaps s
WHERE s.ticket_id = t.id
  AND s.terminal_at IS NOT NULL
  AND t.state = 'CLOSING'
  AND t.delete_at > NOW();
