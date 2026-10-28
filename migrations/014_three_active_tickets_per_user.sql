DROP INDEX IF EXISTS tickets_one_open_per_user_idx;

CREATE INDEX IF NOT EXISTS tickets_active_per_user_idx
  ON tickets (guild_id, user_id, created_at DESC)
  WHERE state <> 'DELETED';
