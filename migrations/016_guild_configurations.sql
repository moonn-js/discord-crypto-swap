CREATE TABLE IF NOT EXISTS guild_configurations (
  guild_id TEXT PRIMARY KEY,
  panel_channel_id TEXT NOT NULL,
  ticket_category_id TEXT NOT NULL,
  completed_deals_channel_id TEXT,
  transcript_channel_id TEXT,
  vouch_channel_id TEXT,
  configured_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
