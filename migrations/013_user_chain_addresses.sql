CREATE TABLE IF NOT EXISTS user_chain_addresses (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  blockchain TEXT NOT NULL,
  address TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, blockchain)
);

WITH address_candidates AS (
  SELECT
    tickets.guild_id,
    tickets.user_id,
    destination_assets.blockchain,
    swaps.recipient AS address,
    swaps.created_at AS used_at,
    swaps.id AS swap_id,
    1 AS input_order
  FROM swaps
  JOIN tickets ON tickets.id = swaps.ticket_id
  JOIN supported_assets AS destination_assets ON destination_assets.asset_id = swaps.destination_asset_id
  WHERE swaps.recipient <> ''

  UNION ALL

  SELECT
    tickets.guild_id,
    tickets.user_id,
    origin_assets.blockchain,
    swaps.refund_to AS address,
    swaps.created_at AS used_at,
    swaps.id AS swap_id,
    2 AS input_order
  FROM swaps
  JOIN tickets ON tickets.id = swaps.ticket_id
  JOIN supported_assets AS origin_assets ON origin_assets.asset_id = swaps.origin_asset_id
  WHERE swaps.refund_to <> ''
), ranked_addresses AS (
  SELECT
    guild_id,
    user_id,
    blockchain,
    address,
    used_at,
    swap_id,
    ROW_NUMBER() OVER (
      PARTITION BY guild_id, user_id, blockchain
      ORDER BY used_at DESC, input_order DESC, swap_id DESC
    ) AS position
  FROM address_candidates
)
INSERT INTO user_chain_addresses (guild_id, user_id, blockchain, address, updated_at)
SELECT guild_id, user_id, blockchain, address, used_at
FROM ranked_addresses
WHERE position = 1
ON CONFLICT (guild_id, user_id, blockchain) DO NOTHING;
