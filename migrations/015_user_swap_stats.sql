CREATE TABLE IF NOT EXISTS user_swap_stats (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  completed_swap_count BIGINT NOT NULL DEFAULT 0 CHECK (completed_swap_count >= 0),
  total_amount_usd NUMERIC(38, 18) NOT NULL DEFAULT 0 CHECK (total_amount_usd >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS stats_recorded_at TIMESTAMPTZ;

WITH successful_swaps AS (
  SELECT s.id,
         t.guild_id,
         t.user_id,
         validated_amount.value AS amount_usd
  FROM swaps s
  JOIN tickets t ON t.id = s.ticket_id
  CROSS JOIN LATERAL (
    SELECT parsed.value
    FROM (
      SELECT candidate.priority,
             CASE
               WHEN candidate.value ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'
               THEN candidate.value::NUMERIC
               ELSE NULL
             END AS value
      FROM (VALUES
        (1, NULLIF(s.executable_quote #>> '{quote,amountInUsd}', '')),
        (2, NULLIF(s.last_status_response #>> '{swapDetails,depositedAmountUsd}', '')),
        (3, NULLIF(s.last_status_response #>> '{swapDetails,amountInUsd}', '')),
        (4, NULLIF(s.amount_usd_requested, ''))
      ) candidate(priority, value)
    ) parsed
    WHERE parsed.value > 0
    ORDER BY parsed.priority
    LIMIT 1
  ) validated_amount
  WHERE s.status = 'SUCCESS'
    AND s.stats_recorded_at IS NULL
), aggregated AS (
  SELECT guild_id,
         user_id,
         COUNT(*)::BIGINT AS completed_swap_count,
         SUM(amount_usd)::NUMERIC(38, 18) AS total_amount_usd
  FROM successful_swaps
  GROUP BY guild_id, user_id
), recorded AS (
  INSERT INTO user_swap_stats (guild_id, user_id, completed_swap_count, total_amount_usd)
  SELECT guild_id, user_id, completed_swap_count, total_amount_usd
  FROM aggregated
  ON CONFLICT (guild_id, user_id) DO UPDATE
  SET completed_swap_count = user_swap_stats.completed_swap_count + EXCLUDED.completed_swap_count,
      total_amount_usd = user_swap_stats.total_amount_usd + EXCLUDED.total_amount_usd,
      updated_at = NOW()
  RETURNING guild_id, user_id
)
UPDATE swaps s
SET stats_recorded_at = NOW()
FROM successful_swaps successful
WHERE s.id = successful.id;

CREATE INDEX IF NOT EXISTS swaps_unrecorded_success_stats_idx
  ON swaps (terminal_at, updated_at)
  WHERE status = 'SUCCESS' AND stats_recorded_at IS NULL;
