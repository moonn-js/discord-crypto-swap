import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const secureBooleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = optionalNonEmptyString.pipe(z.url().optional());
const discordId = z.string().trim().regex(/^\d+$/);
const optionalDiscordId = optionalNonEmptyString.pipe(discordId.optional());

const guildConfigurationSchema = z.object({
  guildId: discordId,
  panelChannelId: discordId,
  ticketCategoryId: discordId,
  completedDealsChannelId: discordId,
  transcriptChannelId: discordId.nullish().transform((value) => value ?? null),
  vouchChannelId: discordId.nullish().transform((value) => value ?? null),
}).strict();

const DEFAULT_SOLANA_RPC_URL = 'https://solana-rpc.publicnode.com';
const DEFAULT_SOLANA_WEBSOCKET_URL = 'wss://solana-rpc.publicnode.com';
const DEFAULT_ETHEREUM_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const DEFAULT_BSC_RPC_URL = 'https://bsc-rpc.publicnode.com';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_GUILDS_JSON: optionalNonEmptyString,
  DISCORD_GUILD_ID: optionalDiscordId,
  PANEL_CHANNEL_ID: optionalDiscordId,
  TICKET_CATEGORY_ID: optionalDiscordId,
  COMPLETED_DEALS_CHANNEL_ID: optionalDiscordId,
  TRANSCRIPT_CHANNEL_ID: optionalDiscordId,
  VOUCH_CHANNEL_ID: optionalDiscordId,
  SELF_SERVICE_SETUP_ENABLED: booleanFromString,
  CENTRAL_TRANSCRIPT_GUILD_ID: optionalDiscordId,
  CENTRAL_TRANSCRIPT_CHANNEL_ID: optionalDiscordId,
  ONECLICK_JWT: z.string().min(20),
  ONECLICK_BASE_URL: z.url().default('https://1click.chaindefuser.com'),
  CHANGENOW_API_KEY: optionalNonEmptyString,
  RELAY_API_KEY: optionalNonEmptyString,
  CHANGELLY_PRIVATE_KEY_HEX: optionalNonEmptyString,
  CHANGELLY_ENABLED: booleanFromString,
  FIXEDFLOAT_API_KEY: optionalNonEmptyString,
  FIXEDFLOAT_API_SECRET: optionalNonEmptyString,
  CHANGELLY_ZERO_COMMISSION_CONFIRMED: booleanFromString,
  CHANGENOW_ZERO_COMMISSION_CONFIRMED: booleanFromString,
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('public'),
  DATABASE_SSL: booleanFromString,
  DATABASE_SSL_REJECT_UNAUTHORIZED: secureBooleanFromString,
  SLIPPAGE_BPS: z.coerce.number().int().min(1).max(500).default(50),
  TARGET_TOTAL_COST_BPS: z.coerce.number().int().min(0).max(500).default(0),
  BOT_FEE_RECIPIENT: optionalNonEmptyString,
  QUOTE_WAIT_MS: z.coerce.number().int().min(0).max(10_000).default(3000),
  PREVIEW_TTL_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  FUNDING_DEADLINE_MINUTES: z.coerce.number().int().min(30).max(360).default(60),
  STALE_TRACKING_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  TICKET_INACTIVITY_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  TICKET_INACTIVITY_REMINDER_MINUTES: z.coerce.number().int().min(1).max(1439).default(5),
  CHANNEL_DELETE_DELAY_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  TERMINAL_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ABANDONED_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  ASSET_REFRESH_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  STATUS_WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(60).default(5),
  STATUS_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  PAYOUT_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(30).default(2),
  BLOCKCYPHER_API_TOKEN: optionalNonEmptyString,
  PAYOUT_WEBHOOK_BASE_URL: optionalUrl,
  PAYOUT_WEBHOOK_SECRET: optionalNonEmptyString,
  HELIUS_API_KEY: optionalNonEmptyString,
  PAYOUT_SOL_RPC_URL: optionalUrl,
  PAYOUT_SOL_WS_URL: optionalUrl,
  PAYOUT_ETH_RPC_URL: optionalUrl,
  PAYOUT_ARBITRUM_RPC_URL: optionalUrl,
  PAYOUT_BASE_RPC_URL: optionalUrl,
  PAYOUT_OPTIMISM_RPC_URL: optionalUrl,
  PAYOUT_BSC_RPC_URL: optionalUrl,
  PAYOUT_POLYGON_RPC_URL: optionalUrl,
  PAYOUT_AVALANCHE_RPC_URL: optionalUrl,
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
}).superRefine((environment, context) => {
  if (!environment.DISCORD_GUILDS_JSON) {
    for (const name of ['DISCORD_GUILD_ID', 'PANEL_CHANNEL_ID', 'TICKET_CATEGORY_ID', 'COMPLETED_DEALS_CHANNEL_ID']) {
      if (!environment[name]) {
        context.addIssue({ code: 'custom', path: [name], message: 'is required when DISCORD_GUILDS_JSON is not configured' });
      }
    }
  }
  if (environment.TARGET_TOTAL_COST_BPS > 0 && !environment.BOT_FEE_RECIPIENT) {
    context.addIssue({
      code: 'custom',
      path: ['BOT_FEE_RECIPIENT'],
      message: 'is required when TARGET_TOTAL_COST_BPS is greater than zero',
    });
  }
  if (Boolean(environment.CENTRAL_TRANSCRIPT_GUILD_ID) !== Boolean(environment.CENTRAL_TRANSCRIPT_CHANNEL_ID)) {
    context.addIssue({
      code: 'custom',
      path: ['CENTRAL_TRANSCRIPT_CHANNEL_ID'],
      message: 'CENTRAL_TRANSCRIPT_GUILD_ID and CENTRAL_TRANSCRIPT_CHANNEL_ID must be configured together',
    });
  }
  if (environment.TICKET_INACTIVITY_REMINDER_MINUTES >= environment.TICKET_INACTIVITY_MINUTES) {
    context.addIssue({
      code: 'custom',
      path: ['TICKET_INACTIVITY_REMINDER_MINUTES'],
      message: 'must be less than TICKET_INACTIVITY_MINUTES',
    });
  }
  const blockCypherValues = [
    environment.BLOCKCYPHER_API_TOKEN,
    environment.PAYOUT_WEBHOOK_BASE_URL,
    environment.PAYOUT_WEBHOOK_SECRET,
  ];
  if (blockCypherValues.some(Boolean) && !blockCypherValues.every(Boolean)) {
    context.addIssue({
      code: 'custom',
      path: ['BLOCKCYPHER_API_TOKEN'],
      message: 'BLOCKCYPHER_API_TOKEN, PAYOUT_WEBHOOK_BASE_URL, and PAYOUT_WEBHOOK_SECRET must be configured together',
    });
  }
  if (environment.PAYOUT_WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{24,128}$/.test(environment.PAYOUT_WEBHOOK_SECRET)) {
    context.addIssue({
      code: 'custom',
      path: ['PAYOUT_WEBHOOK_SECRET'],
      message: 'must be 24-128 URL-safe characters',
    });
  }
  if (environment.PAYOUT_WEBHOOK_BASE_URL && new URL(environment.PAYOUT_WEBHOOK_BASE_URL).protocol !== 'https:') {
    context.addIssue({
      code: 'custom',
      path: ['PAYOUT_WEBHOOK_BASE_URL'],
      message: 'must use HTTPS',
    });
  }
  if (environment.PAYOUT_SOL_WS_URL && new URL(environment.PAYOUT_SOL_WS_URL).protocol !== 'wss:') {
    context.addIssue({ code: 'custom', path: ['PAYOUT_SOL_WS_URL'], message: 'must use WSS' });
  }
  if (Boolean(environment.PAYOUT_SOL_RPC_URL) !== Boolean(environment.PAYOUT_SOL_WS_URL)) {
    context.addIssue({
      code: 'custom',
      path: ['PAYOUT_SOL_RPC_URL'],
      message: 'PAYOUT_SOL_RPC_URL and PAYOUT_SOL_WS_URL must be configured together',
    });
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith('PAYOUT_') || !name.endsWith('_RPC_URL') || !value) continue;
    if (!['http:', 'https:'].includes(new URL(value).protocol)) {
      context.addIssue({ code: 'custom', path: [name], message: 'must use HTTP or HTTPS' });
    }
  }
});

export function loadConfig(environment = process.env) {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }

  const env = parsed.data;
  const guilds = parseGuildConfigurations(env);
  const primaryGuild = guilds[0];
  const heliusRpcSuffix = env.HELIUS_API_KEY ? `?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}` : '';
  return Object.freeze({
    discordToken: env.DISCORD_TOKEN,
    guilds,
    guildId: primaryGuild.guildId,
    panelChannelId: primaryGuild.panelChannelId,
    ticketCategoryId: primaryGuild.ticketCategoryId,
    completedDealsChannelId: primaryGuild.completedDealsChannelId,
    transcriptChannelId: primaryGuild.transcriptChannelId,
    vouchChannelId: primaryGuild.vouchChannelId,
    selfServiceSetupEnabled: env.SELF_SERVICE_SETUP_ENABLED,
    centralTranscriptGuildId: env.CENTRAL_TRANSCRIPT_GUILD_ID ?? null,
    centralTranscriptChannelId: env.CENTRAL_TRANSCRIPT_CHANNEL_ID ?? null,
    oneClickJwt: env.ONECLICK_JWT,
    oneClickBaseUrl: env.ONECLICK_BASE_URL,
    changeNowApiKey: env.CHANGENOW_API_KEY ?? null,
    relayApiKey: env.RELAY_API_KEY ?? null,
    changellyPrivateKeyHex: env.CHANGELLY_PRIVATE_KEY_HEX ?? null,
    changellyEnabled: env.CHANGELLY_ENABLED,
    fixedFloatApiKey: env.FIXEDFLOAT_API_KEY ?? null,
    fixedFloatApiSecret: env.FIXEDFLOAT_API_SECRET ?? null,
    changellyZeroCommissionConfirmed: env.CHANGELLY_ZERO_COMMISSION_CONFIRMED,
    changeNowZeroCommissionConfirmed: env.CHANGENOW_ZERO_COMMISSION_CONFIRMED,
    databaseUrl: env.DATABASE_URL,
    databaseSchema: env.DATABASE_SCHEMA,
    databaseSsl: env.DATABASE_SSL,
    databaseSslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
    slippageBps: env.SLIPPAGE_BPS,
    targetTotalCostBps: env.TARGET_TOTAL_COST_BPS,
    botFeeRecipient: env.BOT_FEE_RECIPIENT ?? null,
    quoteWaitMs: env.QUOTE_WAIT_MS,
    previewTtlMs: env.PREVIEW_TTL_MINUTES * 60_000,
    fundingDeadlineMs: env.FUNDING_DEADLINE_MINUTES * 60_000,
    staleTrackingMs: env.STALE_TRACKING_HOURS * 3_600_000,
    ticketInactivityMs: env.TICKET_INACTIVITY_MINUTES * 60_000,
    ticketInactivityReminderMs: env.TICKET_INACTIVITY_REMINDER_MINUTES * 60_000,
    channelDeleteDelayMs: env.CHANNEL_DELETE_DELAY_MINUTES * 60_000,
    terminalRetentionMs: env.TERMINAL_RETENTION_DAYS * 86_400_000,
    abandonedRetentionMs: env.ABANDONED_RETENTION_HOURS * 3_600_000,
    assetRefreshMs: env.ASSET_REFRESH_MINUTES * 60_000,
    statusWorkerIntervalMs: env.STATUS_WORKER_INTERVAL_SECONDS * 1000,
    statusConcurrency: env.STATUS_CONCURRENCY,
    payoutMonitorIntervalMs: env.PAYOUT_MONITOR_INTERVAL_SECONDS * 1000,
    blockCypherApiToken: env.BLOCKCYPHER_API_TOKEN ?? null,
    payoutWebhookBaseUrl: env.PAYOUT_WEBHOOK_BASE_URL ?? null,
    payoutWebhookSecret: env.PAYOUT_WEBHOOK_SECRET ?? null,
    heliusApiKey: env.HELIUS_API_KEY ?? null,
    solanaPayoutRpcUrl: env.PAYOUT_SOL_RPC_URL
      ?? (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/${heliusRpcSuffix}` : DEFAULT_SOLANA_RPC_URL),
    solanaPayoutWebSocketUrl: env.PAYOUT_SOL_WS_URL
      ?? (env.HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/${heliusRpcSuffix}` : DEFAULT_SOLANA_WEBSOCKET_URL),
    evmPayoutRpcUrls: Object.freeze({
      eth: env.PAYOUT_ETH_RPC_URL ?? DEFAULT_ETHEREUM_RPC_URL,
      arb: env.PAYOUT_ARBITRUM_RPC_URL ?? null,
      base: env.PAYOUT_BASE_RPC_URL ?? null,
      op: env.PAYOUT_OPTIMISM_RPC_URL ?? null,
      bsc: env.PAYOUT_BSC_RPC_URL ?? DEFAULT_BSC_RPC_URL,
      pol: env.PAYOUT_POLYGON_RPC_URL ?? null,
      avax: env.PAYOUT_AVALANCHE_RPC_URL ?? null,
    }),
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
  });
}

function parseGuildConfigurations(environment) {
  let values;
  if (environment.DISCORD_GUILDS_JSON) {
    try {
      values = JSON.parse(environment.DISCORD_GUILDS_JSON);
    } catch {
      throw new Error('Invalid configuration: DISCORD_GUILDS_JSON: must contain valid JSON');
    }
  } else {
    values = [{
      guildId: environment.DISCORD_GUILD_ID,
      panelChannelId: environment.PANEL_CHANNEL_ID,
      ticketCategoryId: environment.TICKET_CATEGORY_ID,
      completedDealsChannelId: environment.COMPLETED_DEALS_CHANNEL_ID,
      transcriptChannelId: environment.TRANSCRIPT_CHANNEL_ID ?? null,
      vouchChannelId: environment.VOUCH_CHANNEL_ID ?? null,
    }];
  }

  const parsed = guildConfigurationSchema.array().min(1).safeParse(values);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: DISCORD_GUILDS_JSON: ${details}`);
  }
  const seen = new Set();
  for (const guild of parsed.data) {
    if (seen.has(guild.guildId)) {
      throw new Error(`Invalid configuration: DISCORD_GUILDS_JSON: duplicate guildId ${guild.guildId}`);
    }
    seen.add(guild.guildId);
  }
  return Object.freeze(parsed.data.map((guild) => Object.freeze(guild)));
}
