CREATE TABLE IF NOT EXISTS bot_panels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supported_assets (
  asset_id TEXT PRIMARY KEY,
  blockchain TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 255),
  contract_address TEXT,
  price TEXT,
  price_updated_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supported_assets_active_chain_idx
  ON supported_assets (active, blockchain, symbol);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT UNIQUE,
  progress_message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'OPEN', 'CLOSING', 'DELETED')),
  step TEXT NOT NULL,
  state_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  delete_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_open_per_user_idx
  ON tickets (guild_id, user_id)
  WHERE state <> 'DELETED';

CREATE INDEX IF NOT EXISTS tickets_delete_at_idx
  ON tickets (delete_at)
  WHERE state = 'CLOSING';

CREATE TABLE IF NOT EXISTS swaps (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  origin_asset_id TEXT NOT NULL,
  destination_asset_id TEXT NOT NULL,
  amount_display TEXT NOT NULL,
  amount_base TEXT NOT NULL,
  recipient TEXT NOT NULL,
  refund_to TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  dry_quote JSONB NOT NULL,
  executable_quote JSONB,
  deposit_address TEXT,
  deposit_memo TEXT,
  deposit_tx_hash TEXT,
  quote_deadline TIMESTAMPTZ,
  preview_expires_at TIMESTAMPTZ NOT NULL,
  last_status_response JSONB,
  next_poll_at TIMESTAMPTZ,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminal_at TIMESTAMPTZ,
  tracking_stale_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS swaps_due_poll_idx
  ON swaps (next_poll_at)
  WHERE next_poll_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS swaps_terminal_at_idx
  ON swaps (terminal_at)
  WHERE terminal_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS swap_status_events (
  id BIGSERIAL PRIMARY KEY,
  swap_id UUID NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS swap_status_events_swap_idx
  ON swap_status_events (swap_id, created_at);
