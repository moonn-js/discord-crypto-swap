# Discord swap bot

A non-custodial Discord bot that opens a private ticket for each swap and uses a signed quote provider for settlement tracking. Members interact through a public **Start swap** button, private ticket dropdowns, buttons, and ordinary ticket messages. There are no user-facing slash commands or modals.

When `RELAY_API_KEY` is configured, previews race NEAR Intents against Relay deposit-address quotes and choose the highest net destination-token amount (all provider costs included). Ties prefer NEAR. Confirmation creates instructions only with the selected provider; it never silently changes providers. Unsupported Relay assets and operational failures leave NEAR available. Existing fallback providers keep their current policy.

Relay uses strict, single-use deposit addresses with the member's explicit sending-chain refund address, the configured slippage, and funding deadline. Underpayments are refunded rather than topped up. Tracking queries the deposit address to follow regenerated request IDs, verifies network/token/recipient/refund details, and only marks success or refund after the relevant transaction is reported. No wallet approvals or bot-signed transactions are used. Live quote/deposit-instruction checks do not move funds; funded settlement still needs a deliberately small real transfer to validate end to end.

The bot never signs wallet transactions, requests seed phrases, or takes custody of funds. After reviewing a verified quote, the member sends the exact deposit from their own wallet.

## What it does

- Maintains one public, restart-safe swap panel message with a private live supported-coins and networks view.
- Creates a channel visible to the ticket owner and bot, while Discord administrators retain their normal override capabilities.
- Refreshes the complete supported-asset catalogue live while exposing a curated, pinned coin and network policy in Discord.
- Presents BTC, ETH, SOL, LTC, USDT, USDC, BNB, POL, and a ten-coin Other menu with branded application emojis.
- Produces a verified preview, then creates separate executable deposit instructions with the selected provider.
- Adds a **Check available routes** button when no direct solver responds and only suggests two-step alternatives after fresh dry quotes succeed for both legs.
- Verifies NEAR quote signatures and validates provider responses against the ticket's exact networks, tokens and amounts before showing a deposit address.
- Displays required deposit memos and passes them to status requests.
- Accepts the requested value in USD, converts it without floating-point arithmetic, and validates it again with the member's real wallet addresses.
- Remembers each member's latest provider-validated address per blockchain and accepts `yes` to reuse it at receiving and refund steps.
- Checks popular routes before collecting addresses or an amount. When a route has no solver, members can subscribe to a persistent ticket watch that pings them when the route returns and pauses inactivity reminders and closure while they wait.
- Embeds a locally generated, address-only deposit QR code in the executable-swap message.
- Detects deposits automatically every ten seconds and temporarily checks every five seconds after a member submits the sending-network transaction ID.
- Tracks deposits through success, refund, or failure in PostgreSQL.
- When BlockCypher detects a matching unconfirmed BTC, LTC, or DOGE payout, pings the ticket owner with the closing message and starts the normal five-minute deletion grace period. Other early monitors keep the confirmation-waiting message. Backend confirmation tracking continues until 1Click reports a terminal result.
- Posts privacy-safe completed-deal and fee summaries with a silent, clickable ticket-owner mention to the configured public channel.
- Optionally DMs successful swap owners with a direct link to a configured vouch channel.
- Pings the owner when a swap reaches a final state and deletes the completed ticket after a five-minute grace period unless the owner closes it first.
- Warns unfinished tickets after five inactive minutes, closes them immediately at 30 minutes, and DMs the owner after closure.
- Archives full plain-text transcripts for final swaps in a restricted administrative channel before deleting their ticket channels.
- Optionally exposes an administrator-only `/setup` wizard that configures additional servers with Discord channel selectors and stores their settings in PostgreSQL.

## Prerequisites

- A Discord application and bot token.
- A Discord server where you can create a panel channel and private-ticket category.
- A 1Click partner JWT from the NEAR Intents partner dashboard.
- Docker with Compose, or Node.js 22+ and PostgreSQL.

NEAR Intents 1Click has no testnet. Do not use a meaningful mainnet amount until the complete flow has been tested with dry quotes and then a deliberately small deposit.

## Discord setup

1. Create an application in the Discord Developer Portal and add a bot user.
2. On the bot settings page, enable the **Message Content Intent**. It is required because USD amounts and wallet addresses are entered as ordinary private-ticket messages.
3. Invite the bot with the `bot` and `applications.commands` scopes.
4. Grant the bot only these guild/category permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Attach Files (for the locally generated deposit QR code)
   - Read Message History
   - Manage Channels
5. Create a public text channel for the swap panel and another text channel for completed-deal summaries.
6. Create a tightly restricted administrative channel for ticket transcripts. Grant the bot View Channel, Send Messages, Attach Files, and Read Message History there.
7. Create a category where private ticket channels will be placed. Deny ordinary roles access at the category level as defense in depth.
8. Enable Discord Developer Mode, then copy the server, panel-channel, completed-deals-channel, transcript-channel, and category IDs.

The bot creates channel-specific overwrites denying `@everyone` and allowing only the ticket owner and bot. A Discord member with Administrator permission can still view or override any guild channel.

## Configuration

Copy `.env.example` to `.env` and fill in all required values:

```dotenv
DISCORD_TOKEN=your-discord-bot-token
DISCORD_GUILDS_JSON=
DISCORD_GUILD_ID=your-server-id
PANEL_CHANNEL_ID=your-public-panel-channel-id
TICKET_CATEGORY_ID=your-private-category-id
COMPLETED_DEALS_CHANNEL_ID=your-completed-deals-channel-id
TRANSCRIPT_CHANNEL_ID=your-private-transcript-channel-id
VOUCH_CHANNEL_ID=
SELF_SERVICE_SETUP_ENABLED=false
CENTRAL_TRANSCRIPT_GUILD_ID=
CENTRAL_TRANSCRIPT_CHANNEL_ID=
ONECLICK_JWT=your-1click-partner-jwt
DATABASE_URL=postgresql://swapbot:swapbot@localhost:5432/swapbot
DATABASE_SCHEMA=public
TARGET_TOTAL_COST_BPS=0
BOT_FEE_RECIPIENT=
```

Never paste either token into Discord or commit `.env`. Keep the transcript channel restricted: its text files intentionally contain full ticket messages, wallet addresses, deposit instructions, memos, and transaction values. The quote made with the member's real addresses is authoritative. Standard quotes expire after 30 minutes; BTC-family origins use 90 minutes. See `.env.example` for every operational setting.

The legacy Discord location variables configure one server. To run the same bot identity in any number of servers, replace those location variables with one `DISCORD_GUILDS_JSON` array:

```dotenv
DISCORD_GUILDS_JSON=[{"guildId":"111111111111111111","panelChannelId":"111111111111111112","ticketCategoryId":"111111111111111113","completedDealsChannelId":"111111111111111114","transcriptChannelId":"111111111111111115","vouchChannelId":null},{"guildId":"222222222222222221","panelChannelId":"222222222222222222","ticketCategoryId":"222222222222222223","completedDealsChannelId":"222222222222222224","transcriptChannelId":"222222222222222225","vouchChannelId":"222222222222222226"}]
```

Every guild ID must be unique. Panel, ticket-category, completed-deals, and vouch channels must belong to their configured guild. A transcript channel may be shared across guilds as long as the bot can view it, send messages, attach files, and read its history. The bot validates all guilds during startup, maintains one panel per guild, routes completed-deal posts, transcripts, tickets, remembered addresses, and vouch DMs by guild, and rejects controls used across guild boundaries. Provider, fee, retention, and polling settings remain shared by the bot process.

Set `SELF_SERVICE_SETUP_ENABLED=true` to register the global administrator-only `/setup` command. It asks for the panel channel, ticket category, completed-swaps channel, transcript channel, and vouch channel one at a time. The last three may be set to None. Existing environment guilds are imported into `guild_configurations` without overwriting administrator changes. Re-running `/setup` requires confirmation, preserves the old configuration until Save Setup is pressed, validates the bot's permissions, updates the panel without leaving the old one behind, and makes `/stats` and `/leaderboard` available in the newly configured server.

`CENTRAL_TRANSCRIPT_GUILD_ID` and `CENTRAL_TRANSCRIPT_CHANNEL_ID` are an optional paired operator setting. When present, every final transcript is also copied to that restricted channel in addition to the server-selected transcript destination. The central destination is intentionally controlled only by deployment configuration and does not appear in `/setup`.

`DATABASE_SCHEMA` defaults to `public`. Run one bot process with its own PostgreSQL database. All servers served by this bot share that schema and are separated by `guild_id`. `/stats` and `/leaderboard` read only this bot's statistics for the current Discord server.

`VOUCH_CHANNEL_ID` is optional. When configured, the bot sends the ticket owner one private vouch request after a successful swap. Leave it unset to disable these DMs.

`TARGET_TOTAL_COST_BPS` is an optional quote-time target for the combined network, spread, and application fee. For example, `30` targets approximately 0.30%. The bot first obtains a fee-free dry quote, rounds its estimated route cost upward, and applies only the non-negative residual as `appFees`; routes already at or above the target receive no application fee. Set it to `0` to disable application fees. `BOT_FEE_RECIPIENT` is required when the target is enabled and must be a NEAR-supported recipient accepted by 1Click; for automatic multi-token aggregation, use the deposit address from a 1Click `ANY_INPUT` quote. The target excludes the origin-wallet transaction fee, can vary with market conditions, and does not override the quote provider's fee-sharing terms.

### Early payout APIs

The normal 1Click status worker remains authoritative for `SUCCESS`, refunds, and failures. Chain APIs surface matching destination broadcasts before final confirmation:

- `BLOCKCYPHER_API_TOKEN`, `PAYOUT_WEBHOOK_BASE_URL`, and `PAYOUT_WEBHOOK_SECRET` enable address-filtered unconfirmed-transaction webhooks for Bitcoin, Litecoin, and Dogecoin. Configure all three together. The base URL must be the service's public HTTPS origin, and the secret must be a newly generated 24-128 character URL-safe value.
- Solana `processed` WebSocket monitoring covers native SOL plus SPL USDT and USDC. It uses PublicNode by default through `PAYOUT_SOL_RPC_URL` and `PAYOUT_SOL_WS_URL`; `HELIUS_API_KEY` remains an optional drop-in override. `processed` is Solana's earliest observable state and is not final confirmation.
- Native/ERC-20 pending-balance checks cover ETH/USDT/USDC on Ethereum and BNB/USDT/USDC on BNB Chain through free PublicNode defaults. The `PAYOUT_*_RPC_URL` values can override those defaults or add Arbitrum, Base, Optimism, Polygon, and Avalanche. A provider that does not expose pending state simply falls back to the normal 1Click message.

Detection is amount-checked against the signed executable quote before Discord is notified. Solana and EVM detections do not mark a swap successful or close a ticket; 1Click still controls terminal status. BlockCypher broadcast detections use the completed-looking closing message and start the normal deletion grace period while backend status tracking continues. Unsupported chains preserve the existing 1Click-only behavior. Store all API keys and keyed RPC URLs only in deployment environment secrets, never in `.env.example`, logs, or source control.

## Run with Docker

```sh
docker compose up --build -d
docker compose logs -f bot
```

The app applies versioned PostgreSQL migrations during startup. The panel is created after the database, asset catalogue, and Discord client are ready.

At startup the bot also creates any missing `swap_*` application emojis from the bundled 128×128 logo assets. These application-owned emojis do not consume guild emoji slots and do not require a guild expression-management permission. A failed emoji upload falls back to Unicode icons without disabling swaps.

Health endpoints:

- `GET /healthz` — process liveness
- `GET /readyz` — database, Discord, asset-catalogue, and quote-provider authentication readiness

## Run locally

```sh
npm install
npm run db:migrate
npm start
```

For development:

```sh
npm run dev
npm run check
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to include repository/migration integration tests. Unit tests never call Discord or create a live 1Click quote.

## User flow

1. Click **Start swap** in the panel channel.
2. Choose the coin you are sending, or use a popular-pick shortcut to select both assets and networks at once. Select a network only when that coin has multiple approved networks.
3. Choose the coin you want to receive and, when needed, its receiving network.
4. Type the USD amount in the ticket channel, then paste the requested receiving and refund addresses as two separate messages.
5. Review the dry quote, including the combined quoted network and spread cost.
6. Confirm to create signed deposit instructions.
7. Verify the chain, asset, amount, deposit address, optional memo, and deadline before sending from your wallet.
8. Scan the address-only QR code in the executable-swap message if useful, or press **Copy details** for exactly two plain messages: the deposit address, then the numeric coin amount.
9. A separate message directly below the deposit instructions explains that you can optionally paste only the sending-network transaction ID after sending. The bot notifies the provider and refreshes tracking immediately; automatic detection continues if no transaction ID is submitted.

The persistent **Close ticket** control is kept in the first ticket message. It opens a private confirmation before deleting the channel immediately. Closing never cancels an executable quote or an on-chain deposit: PostgreSQL tracking continues after the Discord channel is deleted, but no private Discord notification can be delivered to that deleted channel. Final tickets are archived to `TRANSCRIPT_CHANNEL_ID` immediately before deletion. Unfinished manual closures and inactivity closures are not archived. Successful swaps are summarized with a silent ticket-owner mention and an origin-chain explorer link to the member's deposit transaction in `COMPLETED_DEALS_CHANNEL_ID`.

## Security and operations

### Opt-in FixedFloat backup and route notifications

When the regular provider chain returns no route for a quote, the ticket offers **Notify me when available**, **Use backup · 0.5% fee**, and alternative routes. A notification watches the exact asset IDs and token amount, persists across restarts and pings the user in the ticket when a regular provider returns a quote. Inactivity closure is paused while watching. Changing the selection cancels the watch; the paid backup is excluded from availability checks. Migration `018_exact_route_watches.sql` adds an index for these watches.

Set `FIXEDFLOAT_API_KEY` and `FIXEDFLOAT_API_SECRET` in the environment. FixedFloat is never part of automatic fallback: choosing its button requests a floating preview, and confirming that preview creates the order. The service charges 0.5%; network costs also affect the final quote, so total cost is not guaranteed to be 0.5%. No affiliate markup is added. Exact live catalogue network/contract matching is required (initially BTC, LTC, DOGE, ETH, BSC and SOL networks).

Order IDs and security tokens are stored in the executable quote JSON for restart-safe polling. Tokens are not shown in Discord or status responses. Keep database access restricted. API requests are HMAC-SHA256 signed and order creation is never automatically retried. FixedFloat's create endpoint does not register the stored refund address; emergency exchanges/refunds require user action with FixedFloat support. The bot does not automatically choose a new rate or a refund. Expired and emergency orders remain tracked until normal tracking limits, and are shown as requiring assistance.

See [FixedFloat API documentation](https://ff.io/api). Authentication or security failures from regular providers do not trigger the paid-backup offer; they must not be represented as missing liquidity.

### Optional Changelly fallback

Routing is 1Click first, then enabled Changelly, then configured ChangeNOW. The next provider is tried only after an explicit no-route result. Authentication, rate-limit, validation, amount-limit and security errors stop the request. Confirmation stays pinned to the provider shown in the preview; there is no automatic provider change after order creation.

Changelly Exchange API v2 requires registration of an RSA public key with Changelly. Run `npm run setup:changelly` to generate a key pair locally (or reuse the configured private key). The private PKCS#8 DER hex key is stored in ignored `.env` as `CHANGELLY_PRIVATE_KEY_HEX`. Only public registration details are written to `exports/changelly-registration.txt`. Create/sign in to your Changelly account, fill its email into that draft, and send it to `pro@changelly.com` to request API activation and 0% partner extra fee. Never send the private key. See the [official setup](https://docs.changelly.com/) and [authentication guide](https://docs.changelly.com/development/authentication).

After activation, use `npm run rates:changelly` for read-only LTC → USDT BSC/Solana estimates. Set `CHANGELLY_ENABLED=true` to enable fallback previews, and `CHANGELLY_ZERO_COMMISSION_CONFIRMED=true` only after the partner fee is confirmed at zero to allow deposit creation. Neither switch changes Changelly's account fees. The bot adds no markup; provider exchange/network fees remain. No live rates or execution can be verified before activation.

Floating previews subtract `networkFee` from `amountTo`; order creation subtracts it from `amountExpectedTo`. Settled `amountTo` is already net and is not charged again. Exact network, contract and precision matching is required; initially BTC, LTC, Ethereum, BSC and Solana are eligible. Unrecognized catalogue network names fail closed pending verification against the activated account's catalogue. Swaps in `hold`, `failed`, `overdue` or `expired` state keep tracking and direct users to provider support, rather than claiming funds were refunded.

### Optional ChangeNOW fallback

Set `CHANGENOW_API_KEY` in the environment to enable ChangeNOW previews only when 1Click explicitly reports no liquidity route for the requested swap. Authentication failures, timeouts, rate limits and failed security checks never trigger fallback. Exact network and contract matching is required; unsupported assets remain unavailable. Existing orders retain their original provider across restarts.

ChangeNOW standard quotes use a floating rate, with no guaranteed minimum payout. The preview identifies the provider before confirmation. The bot adds no commission to these orders. ChangeNOW service, partner and network costs remain included in their quoted rate, and verification or support intervention may be required. USD settlement values use actual settled token amounts valued at the preview's reference prices.

The default 0.4% partner commission is controlled by ChangeNOW, not a request parameter. Ask ChangeNOW support to set the API account's partner commission to 0%, and only after confirmation set `CHANGENOW_ZERO_COMMISSION_CONFIRMED=true`. Until then, previews work but deposit creation is disabled. This setting attests to support confirmation; it does not change the provider's commission itself. See [ChangeNOW commission documentation](https://support.changenow.io/hc/en-us/articles/22686447453596-Integration-Commissions-fees-and-payouts).

Run `npm run rates:changenow` for read-only LTC → USDT BSC/Solana quotes at 1, 10 and 100 LTC. It creates no orders. Indicative costs compare against 1Click catalogue USD prices and exclude your sending-wallet transaction fee; they are not guaranteed executable market comparisons.

ChangeNOW orders use automatic deposit detection and persist their provider order ID in the existing quote JSON. The displayed local funding window is not a price guarantee. Provider status polling continues after that window; the normal stale-tracking limit still applies. A provider `failed` or `verifying` state requires attention and continues polling instead of claiming that a refund has completed.

- The JWT and Discord token are environment-only and are never written to PostgreSQL.
- Structured logs redact wallet, quote, deposit, memo, transaction, and token fields.
- 1Click errors are reduced to safe categories before logging or persistence; raw API error bodies are never written to logs.
- Coin choices are pinned to exact 1Click asset IDs. An unavailable or metadata-mismatched asset is hidden instead of being replaced by another token with the same symbol.
- Full signed quote payloads are retained for dispute/debug evidence and removed according to the configured retention window.
- Use TLS for a remote PostgreSQL service (`DATABASE_SSL=true`), provider encryption at rest, restricted database credentials, and encrypted backups.
- Monitor `/readyz`; a 1Click `401` marks the process unready until an authenticated request succeeds.
