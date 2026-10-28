import { once } from 'node:events';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { ensureDatabaseSchema, runMigrations } from './db/migrate.js';
import { Repositories } from './db/repositories.js';
import { HealthState } from './health.js';
import { startHealthServer } from './http/health-server.js';
import { LifecycleWorker } from './jobs/lifecycle-worker.js';
import { StatusWorker } from './jobs/status-worker.js';
import { createLogger } from './logger.js';
import { AssetCatalogue } from './services/asset-catalogue.js';
import { CoinPolicy } from './services/coin-policy.js';
import { EmojiService } from './services/emoji-service.js';
import { SwapClient } from './services/swap-client.js';
import { PayoutMonitor } from './services/payout-monitor.js';
import { QrService } from './services/qr-service.js';
import { TicketService } from './services/ticket-service.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const health = new HealthState();
const pool = createPool(config);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let healthServer;
let catalogue;
let statusWorker;
let lifecycleWorker;
let payoutMonitor;
let shuttingDown = false;

try {
  healthServer = await startHealthServer({
    port: config.port,
    health,
    logger,
    webhookHandler: (request, response) => payoutMonitor?.handleWebhook(request, response) ?? false,
  });
  await ensureDatabaseSchema(pool, config.databaseSchema);
  await runMigrations(pool, logger);
  await pool.query('SELECT 1');
  health.database = true;

  const repositories = new Repositories(pool);
  const oneClick = new SwapClient(config);
  catalogue = new AssetCatalogue({
    repositories,
    oneClick,
    health,
    logger,
    refreshMs: config.assetRefreshMs,
  });
  await catalogue.initialize();

  const coinPolicy = new CoinPolicy(catalogue);
  const emojis = new EmojiService({ client, logger });
  const qrService = new QrService();
  const ticketService = new TicketService({
    client,
    repositories,
    catalogue,
    coinPolicy,
    emojis,
    oneClick,
    qrService,
    config,
    health,
    logger,
  });
  statusWorker = new StatusWorker({ repositories, oneClick, client, ticketService, catalogue, config, health, logger });
  lifecycleWorker = new LifecycleWorker({ repositories, client, ticketService, config, logger });
  payoutMonitor = new PayoutMonitor({ repositories, ticketService, catalogue, config, logger });
  ticketService.setStatusWorker(statusWorker);

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await ticketService.handleInteraction(interaction);
    } catch (error) {
      logger.error({ errorCode: oneClick.errorCode(error), interactionId: interaction.id }, 'Unhandled Discord interaction error');
    }
  });
  client.on(Events.MessageCreate, async (message) => {
    try {
      await ticketService.handleMessage(message);
    } catch (error) {
      logger.error({ errorName: error.name, operation: 'ticket_message' }, 'Unhandled ticket message error');
    }
  });
  client.on(Events.Error, (error) => logger.error({ errorName: error.name }, 'Discord client error'));
  client.on(Events.Warn, (message) => logger.warn({ discordWarning: message }, 'Discord client warning'));

  const ready = once(client, Events.ClientReady);
  await client.login(config.discordToken);
  await ready;
  health.discord = true;

  await emojis.initialize();
  await ticketService.initializeGuildConfigurations();
  logger.info({ botUserId: client.user.id, guildCount: ticketService.guildConfigs.size }, 'Discord client ready');
  await ticketService.initializeCommands();
  await ticketService.initializeCompletionChannel();
  await ticketService.initializeTranscriptChannel();
  await ticketService.reconcileCompletionSummaries();
  await ticketService.reconcileOpenTickets();
  await ticketService.initializePanel();
  statusWorker.start();
  lifecycleWorker.start();
  payoutMonitor.start();
} catch (error) {
  logger.fatal({ errorName: error.name, message: error.message }, 'Bot startup failed');
  await shutdown(1);
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ exitCode }, 'Shutting down');
  statusWorker?.stop();
  lifecycleWorker?.stop();
  payoutMonitor?.stop();
  catalogue?.stop();
  health.discord = false;
  client.destroy();
  if (healthServer) await new Promise((resolve) => healthServer.close(resolve));
  await pool.end().catch(() => null);
  process.exitCode = exitCode;
}
