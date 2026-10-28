import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import {
  AmountValidationError,
  completedSwapAmountUsd,
  fromBaseUnits,
  parseUsdAmount,
  toBaseUnits,
  tokenAmountUsd,
  quotedRouteCostPercentDisplay,
  roundBaseUnitsUpToPrecision,
  usdToBaseUnits,
} from '../utils/amounts.js';
import {
  closeConfirmationPayload,
  completedDealComponents,
  completedDealEmbed,
  depositSpeedupPayload,
  incompleteDepositDetails,
  leaderboardPayload,
  panelPayload,
  payoutClosingPayload,
  payoutSentPayload,
  renderTicket,
  supportedCoinsPayload,
  ticketHeaderPayload,
  userStatsPayload,
} from '../discord/views.js';
import { networkLabel, OTHER_COIN_KEY } from './coin-policy.js';
import { getPopularSwap } from './popular-swaps.js';
import { buildTranscriptFiles, fetchAllChannelMessages } from './transcript-service.js';
import { validateKnownAddressFormat } from '../utils/address-validation.js';
import {
  GUILD_SETUP_STEPS,
  parseSetupComponentId,
  setupRedoConfirmationPayload,
  setupReviewPayload,
  setupSavedPayload,
  setupStepPayload,
} from '../discord/setup-wizard.js';

const MAX_PRICE_AGE_MS = 30 * 60 * 1000;
const MAX_ACTIVE_TICKETS_PER_USER = 3;
const STALE_APPLICATION_COMMAND_NAMES = Object.freeze(['mutuals']);
const ROUTE_CHECK_COOLDOWN_MS = 30_000;
const MAX_ALTERNATIVE_ROUTE_CANDIDATES = 6;
const MAX_ALTERNATIVE_ROUTE_RESULTS = 2;
const ALTERNATIVE_ROUTE_CONCURRENCY = 3;
const ROUTE_BRIDGE_COINS = Object.freeze(['USDC', 'USDT', 'SOL', 'ETH', 'BNB']);
const POPULAR_ROUTE_PROBE_USD = '100';
const SETUP_SESSION_TTL_MS = 15 * 60_000;
const POPULAR_ROUTE_PROBE_ADDRESSES = Object.freeze({
  // Probe previews never expose deposit instructions or move funds.
  ltc: 'LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE',
  bsc: '0x1111111111111111111111111111111111111111',
  eth: '0x1111111111111111111111111111111111111111',
});

export class TicketService {
  constructor({ client, repositories, catalogue, coinPolicy, emojis, oneClick, qrService, config, health, logger }) {
    this.client = client;
    this.repositories = repositories;
    this.catalogue = catalogue;
    this.coinPolicy = coinPolicy;
    this.emojis = emojis;
    this.oneClick = oneClick;
    this.qrService = qrService;
    this.config = config;
    this.health = health;
    this.logger = logger;
    this.guildConfigs = new Map(configuredGuilds(config).map((guild) => [guild.guildId, guild]));
    this.statusWorker = null;
    this.messageQueues = new Map();
    this.completionChannel = null;
    this.transcriptChannel = null;
    this.completionChannels = new Map();
    this.transcriptChannels = new Map();
    this.completionGif = null;
    this.routeChecks = new Set();
    this.routeCheckCooldowns = new Map();
    this.setupSessions = new Map();
    this.centralTranscriptChannel = null;
  }

  setStatusWorker(statusWorker) {
    this.statusWorker = statusWorker;
  }

  async initializeGuildConfigurations() {
    if (!this.config.selfServiceSetupEnabled) return;
    await this.repositories.seedGuildConfigurations([...this.guildConfigs.values()]);
    const stored = await this.repositories.listGuildConfigurations();
    this.guildConfigs = new Map(stored.map((guild) => [guild.guildId, guild]));
    this.logger.info({ guildCount: this.guildConfigs.size }, 'Persistent Discord guild configurations loaded');
  }

  async handleMessage(message) {
    if (!message.guildId || message.author?.bot || message.webhookId || typeof message.content !== 'string') return false;
    if (this.guildConfigs.size > 0 && !this.guildConfigs.has(message.guildId)) return false;
    const previous = this.messageQueues.get(message.channelId) ?? Promise.resolve(false);
    const current = previous.catch(() => false).then(() => this.handleMessageInOrder(message));
    this.messageQueues.set(message.channelId, current);
    try {
      return await current;
    } finally {
      if (this.messageQueues.get(message.channelId) === current) this.messageQueues.delete(message.channelId);
    }
  }

  async handleMessageInOrder(message) {
    const ticket = await this.repositories.getOpenTicketByChannel(message.channelId);
    if (!ticket || ticket.user_id !== message.author.id) return false;

    const data = { ...(ticket.state_data ?? {}) };
    if (ticket.step !== 'ACTIVE') await this.repositories.touchTicket(ticket.id);
    try {
      if (ticket.step === 'USD_AMOUNT') {
        data.noRouteOffer = null;
        const origin = this.catalogue.getAsset(data.originAssetId);
        if (!origin) throw new UserInputError('The selected sending asset is no longer available. Go back and choose it again.');
        const tokenInput = ['USDT', 'USDC'].includes(origin.symbol);
        const enteredAmount = tokenInput ? parseTokenAmount(message.content, origin.symbol) : parseUsdAmount(message.content);
        const priceUpdatedAt = new Date(origin.priceUpdatedAt).getTime();
        if (!origin.price || !Number.isFinite(priceUpdatedAt) || Date.now() - priceUpdatedAt > MAX_PRICE_AGE_MS) {
          throw new UserInputError('The current USD price for this coin is unavailable. Please try again in a few minutes.');
        }
        const amountBase = tokenInput
          ? toBaseUnits(enteredAmount, origin.decimals)
          : usdToBaseUnits(enteredAmount, String(origin.price), origin.decimals);
        const amountUsdRequested = tokenInput ? tokenAmountUsd(enteredAmount, String(origin.price)) : enteredAmount;
        Object.assign(data, {
          amountUsdRequested,
          amountBase,
          amountDisplay: fromBaseUnits(amountBase, origin.decimals),
          conversionPriceUsd: String(origin.price),
          conversionPriceAt: new Date(priceUpdatedAt).toISOString(),
        });
        const destination = this.catalogue.getAsset(data.destinationAssetId);
        const rememberedRecipientAddress = destination
          ? await this.repositories.getUserChainAddress(ticket.guild_id, ticket.user_id, destination.blockchain)
          : null;
        setRememberedAddress(data, 'rememberedRecipientAddress', rememberedRecipientAddress);
        const updated = await this.repositories.updateTicketFlowIfStep(ticket.id, 'USD_AMOUNT', 'RECIPIENT_ADDRESS', data);
        if (updated) await this.renderProgress(ticket.id, { append: true });
        return true;
      }

      if (ticket.step === 'RECIPIENT_ADDRESS') {
        const destination = this.catalogue.getAsset(data.destinationAssetId);
        if (!destination) throw new UserInputError('The selected receiving asset is no longer available. Go back and choose it again.');
        const recipient = await this.resolveAddressInput(
          message.content,
          ticket,
          destination.blockchain,
          data.rememberedRecipientAddress,
        );
        const issue = validateKnownAddressFormat(recipient, destination.blockchain);
        if (issue) throw new UserInputError(`That does not look like a valid ${issue.network} address. Check the receiving network and paste it again.`);
        data.recipient = recipient;
        data.rememberedRecipientAddress = recipient;
        const origin = this.catalogue.getAsset(data.originAssetId);
        if (!origin) throw new UserInputError('The selected sending asset is no longer available. Go back and choose it again.');
        const rememberedRefundAddress = origin.blockchain === destination.blockchain
          ? recipient
          : await this.repositories.getUserChainAddress(ticket.guild_id, ticket.user_id, origin.blockchain);
        setRememberedAddress(data, 'rememberedRefundAddress', rememberedRefundAddress);
        const updated = await this.repositories.updateTicketFlowIfStep(ticket.id, 'RECIPIENT_ADDRESS', 'REFUND_ADDRESS', data);
        if (updated) await this.renderProgress(ticket.id, { append: true });
        return true;
      }

      if (ticket.step === 'REFUND_ADDRESS') {
        const origin = this.catalogue.getAsset(data.originAssetId);
        if (!origin) throw new UserInputError('The selected sending asset is no longer available. Go back and choose it again.');
        const refundTo = await this.resolveAddressInput(
          message.content,
          ticket,
          origin.blockchain,
          data.rememberedRefundAddress,
        );
        const issue = validateKnownAddressFormat(refundTo, origin.blockchain);
        if (issue) throw new UserInputError(`That does not look like a valid ${issue.network} address. Check the sending network and paste it again.`);
        data.refundTo = refundTo;
        data.rememberedRefundAddress = refundTo;
        const updated = await this.repositories.updateTicketFlowIfStep(ticket.id, 'REFUND_ADDRESS', 'QUOTE_LOADING', data);
        if (!updated) return true;
        await this.renderProgress(ticket.id, { append: true });
        await this.createPreviewFromChat(ticket.id, data, message);
        return true;
      }

      if (ticket.step === 'ACTIVE') {
        const swap = await this.repositories.getSwapByTicket(ticket.id);
        if (!swap?.executable_quote) throw new UserInputError('Deposit instructions are not available for this ticket.');
        if (['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap.executable_quote.provider)) return false;
        if (swap.status !== 'PENDING_DEPOSIT' || swap.deposit_tx_hash) return false;

        const transactionId = parseTransactionId(message.content);
        if (!transactionId) return false;
        await this.repositories.touchTicket(ticket.id);

        try {
          await this.oneClick.submitDepositTransaction(swap, transactionId);
        } catch (error) {
          this.markAuthenticationHealth(error);
          const context = { operation: 'deposit_submission' };
          const classification = this.oneClick.classifyError(error, context);
          this.logger.warn({ ticketId: ticket.id, ...this.oneClick.safeErrorLogFields(error, context) }, 'Deposit transaction ID submission failed');
          if (classification.code === 'DEPOSIT_TX_REJECTED') return false;
          await this.replyToTicketMessage(message, classification.userMessage);
          return true;
        }

        const saved = await this.repositories.saveDepositTransactionHash(ticket.id, transactionId);
        if (!saved) throw new Error('The submitted deposit transaction ID could not be saved.');
        this.health.oneClickAuthentication = true;
        await this.renderProgress(ticket.id);
        await this.replyToTicketMessage(message, 'Transaction ID submitted. The swap provider has been notified, and automatic tracking is continuing.');
        if (this.statusWorker) {
          await this.statusWorker.refreshSwap(saved, { announce: true, rethrow: false }).catch((error) => {
            this.logger.warn({ ticketId: ticket.id, ...this.oneClick.safeErrorLogFields(error, { operation: 'status_refresh' }) }, 'Immediate status refresh after transaction submission failed');
          });
        }
        return true;
      }
    } catch (error) {
      const userMessage = error instanceof UserInputError || error instanceof AmountValidationError
        ? error.message
        : 'I could not process that message. Please try again.';
      this.logger.warn({ ticketId: ticket.id, errorName: error.name, operation: 'ticket_message' }, 'Ticket chat input was rejected');
      await this.replyToTicketMessage(message, userMessage);
      return true;
    }
    return false;
  }

  async resolveAddressInput(value, ticket, blockchain, suggestedAddress) {
    if (!isAddressReuseAnswer(value)) return cleanAddress(value);
    const rememberedAddress = suggestedAddress ?? await this.repositories.getUserChainAddress(
      ticket.guild_id,
      ticket.user_id,
      blockchain,
    );
    if (!rememberedAddress) {
      throw new UserInputError('I do not have a saved address for you on this network yet. Paste an address instead.');
    }
    return cleanAddress(rememberedAddress);
  }

  async initializePanel() {
    for (const guildConfig of this.guildConfigs.values()) {
      const guild = await this.client.guilds.fetch(guildConfig.guildId).catch(() => null);
      if (!guild) continue;
      try {
        await this.initializeGuildPanel(guildConfig, guild);
      } catch (error) {
        this.logger.warn({
          guildId: guildConfig.guildId,
          panelChannelId: guildConfig.panelChannelId,
          ticketCategoryId: guildConfig.ticketCategoryId,
          errorName: error.name,
          errorCode: error.code,
        }, 'Swap panel could not be initialized');
      }
    }
  }

  async initializeCommands() {
    const guildDefinitions = [
      {
        name: 'stats',
        description: 'Show overall completed swap totals',
        options: [{
          type: ApplicationCommandOptionType.User,
          name: 'user',
          description: 'The person whose swap stats you want to view',
          required: false,
        }],
      },
      {
        name: 'leaderboard',
        description: 'Show the top five swappers in this server',
      },
    ];
    const globalCommands = typeof this.client.application?.commands?.fetch === 'function'
      ? await this.client.application.commands.fetch()
      : null;
    await this.removeStaleCommands(globalCommands, {});
    await this.syncSetupCommand(globalCommands);
    for (const guildConfig of this.guildConfigs.values()) {
      const guild = await this.client.guilds.fetch(guildConfig.guildId).catch(() => null);
      if (!guild) {
        this.logger.warn({ guildId: guildConfig.guildId }, 'Configured guild is not currently available to the bot');
        continue;
      }
      await this.initializeGuildCommands(guild, guildDefinitions);
    }
  }

  async syncSetupCommand(globalCommands) {
    if (typeof globalCommands?.find !== 'function') return;
    const existing = globalCommands.find((command) => command.name === 'setup');
    if (!this.config.selfServiceSetupEnabled) {
      if (existing) await existing.delete();
      return;
    }
    const definition = {
      name: 'setup',
      description: 'Configure the swap bot for this server',
      defaultMemberPermissions: PermissionFlagsBits.Administrator.toString(),
      integrationTypes: [ApplicationIntegrationType.GuildInstall],
      contexts: [InteractionContextType.Guild],
    };
    if (existing) await existing.edit(definition);
    else if (typeof this.client.application?.commands?.create === 'function') {
      await this.client.application.commands.create(definition);
    }
    this.logger.info({ commandName: definition.name }, 'Global setup command is ready');
  }

  async initializeGuildCommands(guild, definitions = null) {
    const guildDefinitions = definitions ?? [
      {
        name: 'stats',
        description: 'Show overall completed swap totals',
        options: [{
          type: ApplicationCommandOptionType.User,
          name: 'user',
          description: 'The person whose swap stats you want to view',
          required: false,
        }],
      },
      {
        name: 'leaderboard',
        description: 'Show the top five swappers in this server',
      },
    ];
    const commands = await guild.commands.fetch();
    await this.removeStaleCommands(commands, { guildId: guild.id });
    for (const definition of guildDefinitions) {
      const existing = commands.find((command) => command.name === definition.name);
      if (existing) await existing.edit(definition);
      else await guild.commands.create(definition);
      this.logger.info({ guildId: guild.id, commandName: definition.name }, 'Guild command is ready');
    }
  }

  async removeStaleCommands(commands, context) {
    if (typeof commands?.find !== 'function') return;
    for (const commandName of STALE_APPLICATION_COMMAND_NAMES) {
      const command = commands.find((candidate) => candidate.name === commandName);
      if (!command) continue;
      await command.delete();
      this.logger.info({ ...context, commandName }, 'Stale application command removed');
    }
  }

  async initializeGuildPanel(guildConfig, knownGuild = null) {
    const guild = knownGuild ?? await this.client.guilds.fetch(guildConfig.guildId);
    const panelChannel = await guild.channels.fetch(guildConfig.panelChannelId);
    const category = await guild.channels.fetch(guildConfig.ticketCategoryId);
    if (!panelChannel?.isTextBased() || panelChannel.type !== ChannelType.GuildText) {
      throw new Error('PANEL_CHANNEL_ID must refer to a guild text channel.');
    }
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error('TICKET_CATEGORY_ID must refer to a guild category.');
    }

    const saved = await this.repositories.getPanel(guild.id);
    const recent = await panelChannel.messages.fetch({ limit: 100 }).catch(() => new Map());
    const candidates = [...recent.values()]
      .filter((candidate) => isSwapPanelMessage(candidate, this.client.user.id))
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp);

    let savedMessage = null;
    if (saved?.channel_id === panelChannel.id) {
      const fetched = await panelChannel.messages.fetch(saved.message_id).catch(() => null);
      if (isSwapPanelMessage(fetched, this.client.user.id)) savedMessage = fetched;
    }

    let message = savedMessage ?? candidates[0] ?? null;
    const payload = { ...panelPayload(!this.health.isReady()), allowedMentions: { parse: [] } };
    if (message) {
      await message.edit(payload);
    } else {
      message = await panelChannel.send(payload);
    }

    const duplicateCandidates = candidates.filter((candidate) => candidate.id !== message.id);
    for (const duplicate of duplicateCandidates) {
      await duplicate.delete().catch((error) => {
        this.logger.warn(
          { guildId: guild.id, panelChannelId: panelChannel.id, messageId: duplicate.id, errorName: error.name },
          'Duplicate swap panel could not be deleted',
        );
      });
    }
    await this.repositories.savePanel(guild.id, panelChannel.id, message.id);
    this.logger.info({ guildId: guild.id, panelChannelId: panelChannel.id }, 'Swap panel is ready');
  }

  async initializeCompletionChannel() {
    this.completionGif = await readFile(new URL('../assets/completion/history.gif', import.meta.url));
    for (const guildConfig of this.guildConfigs.values()) {
      if (!guildConfig.completedDealsChannelId) continue;
      const guild = await this.client.guilds.fetch(guildConfig.guildId).catch(() => null);
      if (!guild) continue;
      try {
        await this.initializeGuildCompletionChannel(guildConfig, guild);
      } catch (error) {
        this.logger.warn({
          guildId: guildConfig.guildId,
          completedDealsChannelId: guildConfig.completedDealsChannelId,
          errorName: error.name,
          errorCode: error.code,
        }, 'Completed-deals channel could not be initialized');
      }
    }
  }

  async initializeGuildCompletionChannel(guildConfig, knownGuild = null) {
    const guild = knownGuild ?? await this.client.guilds.fetch(guildConfig.guildId);
    const channel = await guild.channels.fetch(guildConfig.completedDealsChannelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      throw new Error('COMPLETED_DEALS_CHANNEL_ID must refer to a guild text or announcement channel.');
    }
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    if (!channel.permissionsFor(this.client.user)?.has(required)) {
      throw new Error('The bot needs View Channel, Send Messages, Embed Links, and Read Message History in COMPLETED_DEALS_CHANNEL_ID.');
    }
    this.completionChannels.set(guild.id, channel);
    this.completionChannel ??= channel;
    this.logger.info({ guildId: guild.id, completedDealsChannelId: channel.id }, 'Completed-deals channel is ready');
  }

  async initializeTranscriptChannel() {
    for (const guildConfig of this.guildConfigs.values()) {
      if (!guildConfig.transcriptChannelId) continue;
      const guild = await this.client.guilds.fetch(guildConfig.guildId).catch(() => null);
      if (!guild) continue;
      try {
        await this.initializeGuildTranscriptChannel(guildConfig);
      } catch (error) {
        this.logger.warn({
          guildId: guildConfig.guildId,
          transcriptChannelId: guildConfig.transcriptChannelId,
          errorName: error.name,
          errorCode: error.code,
        }, 'Ticket transcript channel could not be initialized');
      }
    }
    await this.initializeCentralTranscriptChannel();
  }

  async initializeGuildTranscriptChannel(guildConfig) {
    const channel = await this.client.channels.fetch(guildConfig.transcriptChannelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      throw new Error('TRANSCRIPT_CHANNEL_ID must refer to a guild text or announcement channel.');
    }
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    if (!channel.permissionsFor(this.client.user)?.has(required)) {
      throw new Error('The bot needs View Channel, Send Messages, Attach Files, and Read Message History in TRANSCRIPT_CHANNEL_ID.');
    }
    this.transcriptChannels.set(guildConfig.guildId, channel);
    this.transcriptChannel ??= channel;
    this.logger.info({ guildId: guildConfig.guildId, transcriptChannelId: channel.id }, 'Ticket transcript channel is ready');
  }

  async initializeCentralTranscriptChannel() {
    if (!this.config.centralTranscriptChannelId) return;
    const channel = await this.client.channels.fetch(this.config.centralTranscriptChannelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      throw new Error('CENTRAL_TRANSCRIPT_CHANNEL_ID must refer to a guild text or announcement channel.');
    }
    if (channel.guildId !== this.config.centralTranscriptGuildId) {
      throw new Error('CENTRAL_TRANSCRIPT_CHANNEL_ID must belong to CENTRAL_TRANSCRIPT_GUILD_ID.');
    }
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    if (!channel.permissionsFor(this.client.user)?.has(required)) {
      throw new Error('The bot needs View Channel, Send Messages, Attach Files, and Read Message History in CENTRAL_TRANSCRIPT_CHANNEL_ID.');
    }
    this.centralTranscriptChannel = channel;
    this.logger.info({
      guildId: channel.guildId,
      centralTranscriptChannelId: channel.id,
    }, 'Central ticket transcript channel is ready');
  }

  async handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.()) {
      if (interaction.commandName === 'setup') {
        await this.handleSetupCommand(interaction);
        return true;
      }
      if (interaction.commandName === 'stats') {
        await this.handleStatsCommand(interaction);
        return true;
      }
      if (interaction.commandName === 'leaderboard') {
        await this.handleLeaderboardCommand(interaction);
        return true;
      }
      return false;
    }
    if ('customId' in interaction && interaction.customId.startsWith('setup:')) {
      await this.handleSetupInteraction(interaction);
      return true;
    }
    if (interaction.isButton() && interaction.customId === 'panel:start') {
      await this.startTicket(interaction);
      return true;
    }
    if (interaction.isButton() && interaction.customId === 'panel:supported-coins') {
      if (!this.guildConfigs.has(interaction.guildId)) {
        await this.privateReply(interaction, 'This swap panel belongs to a different server.');
        return true;
      }
      await interaction.reply({
        ...supportedCoinsPayload(this.coinPolicy),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return true;
    }
    if (!('customId' in interaction) || !interaction.customId.startsWith('t:')) return false;

    const parsed = parseComponentId(interaction.customId);
    if (!parsed) return false;
    const ticket = await this.repositories.getTicket(parsed.ticketId);
    if (!ticket || ticket.state === 'DELETED') {
      await this.privateReply(interaction, 'This ticket no longer exists. Open a new one from the swap panel.');
      return true;
    }
    if (this.guildConfigs.size > 0 && (ticket.guild_id !== interaction.guildId || !this.guildConfigs.has(ticket.guild_id))) {
      await this.privateReply(interaction, 'This control belongs to a different server.');
      return true;
    }
    if (ticket.user_id !== interaction.user.id) {
      await this.privateReply(interaction, 'Only the member who opened this ticket can use its controls.');
      return true;
    }
    if (ticket.channel_id && ticket.channel_id !== interaction.channelId) {
      await this.privateReply(interaction, 'This control belongs to a different ticket channel.');
      return true;
    }
    await this.repositories.touchTicket(ticket.id);
    if (ticket.state === 'CLOSING') {
      await this.privateReply(interaction, 'This ticket is already closing.');
      return true;
    }

    try {
      if (parsed.argument === null) await this.routeTicketInteraction(interaction, ticket, parsed.action);
      else await this.routeTicketInteraction(interaction, ticket, parsed.action, parsed.argument);
    } catch (error) {
      this.logger.error({ ticketId: ticket.id, ...this.oneClick.safeErrorLogFields(error, { operation: 'ticket_interaction' }) }, 'Ticket interaction failed');
      await this.privateReply(interaction, error instanceof UserInputError ? error.message : this.oneClick.userMessage(error, { operation: 'ticket_interaction' }));
    }
    return true;
  }

  async handleSetupCommand(interaction) {
    if (!this.config.selfServiceSetupEnabled) {
      await this.privateReply(interaction, 'Self-service setup is not enabled for this bot.');
      return;
    }
    if (!interaction.guildId || !interaction.guild) {
      await this.privateReply(interaction, 'Run this command inside the server you want to configure.');
      return;
    }
    if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
      await this.privateReply(interaction, 'Only a server administrator can configure the bot.');
      return;
    }

    this.removeExpiredSetupSessions();
    const sessionId = randomUUID();
    const existing = this.guildConfigs.get(interaction.guildId)
      ?? await this.repositories.getGuildConfiguration(interaction.guildId);
    const session = {
      id: sessionId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      stepIndex: 0,
      values: {},
      confirmed: !existing,
      expiresAt: Date.now() + SETUP_SESSION_TTL_MS,
    };
    this.setupSessions.set(sessionId, session);
    await interaction.reply({
      ...(existing
        ? setupRedoConfirmationPayload(sessionId)
        : setupStepPayload(sessionId, 0, session.values)),
      flags: MessageFlags.Ephemeral,
    });
  }

  async handleSetupInteraction(interaction) {
    const parsed = parseSetupComponentId(interaction.customId);
    const session = parsed ? this.setupSessions.get(parsed.sessionId) : null;
    if (!parsed || !session || session.expiresAt <= Date.now()) {
      if (session) this.setupSessions.delete(session.id);
      await this.privateReply(interaction, 'This setup session expired. Run /setup again.');
      return;
    }
    if (interaction.guildId !== session.guildId || interaction.user.id !== session.userId) {
      await this.privateReply(interaction, 'Only the administrator who started this setup can use these controls.');
      return;
    }
    if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
      this.setupSessions.delete(session.id);
      await this.privateReply(interaction, 'You must still be a server administrator to finish setup.');
      return;
    }
    session.expiresAt = Date.now() + SETUP_SESSION_TTL_MS;

    if (parsed.action === 'cancel') {
      this.setupSessions.delete(session.id);
      await interaction.update({
        content: 'Setup cancelled. The existing server configuration was not changed.',
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (parsed.action === 'redo') {
      session.confirmed = true;
      session.stepIndex = 0;
      session.values = {};
      await interaction.update(setupStepPayload(session.id, session.stepIndex, session.values));
      return;
    }
    if (!session.confirmed) {
      await this.privateReply(interaction, 'Confirm that you want to redo setup before changing anything.');
      return;
    }
    if (parsed.action === 'back') {
      session.stepIndex = Math.max(0, Math.min(GUILD_SETUP_STEPS.length - 1, session.stepIndex - 1));
      await interaction.update(setupStepPayload(session.id, session.stepIndex, session.values));
      return;
    }
    if (parsed.action === 'none') {
      const step = GUILD_SETUP_STEPS[session.stepIndex];
      if (!step?.optional) {
        await this.privateReply(interaction, 'This setup choice is required.');
        return;
      }
      session.values[step.key] = null;
      session.stepIndex += 1;
      await interaction.update(this.nextSetupPayload(session));
      return;
    }
    if (parsed.action === 'select') {
      const step = GUILD_SETUP_STEPS[session.stepIndex];
      const channelId = interaction.values?.[0];
      if (!step || !channelId) {
        await this.privateReply(interaction, 'Select one channel to continue.');
        return;
      }
      session.values[step.key] = channelId;
      session.stepIndex += 1;
      await interaction.update(this.nextSetupPayload(session));
      return;
    }
    if (parsed.action !== 'save' || session.stepIndex < GUILD_SETUP_STEPS.length) {
      await this.privateReply(interaction, 'That setup control is no longer valid.');
      return;
    }

    await interaction.deferUpdate();
    try {
      const saved = await this.applyGuildSetup(interaction.guild, session.values, interaction.user.id);
      this.setupSessions.delete(session.id);
      await interaction.editReply(setupSavedPayload(saved));
    } catch (error) {
      this.logger.warn({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        errorName: error.name,
        operation: 'guild_setup',
      }, 'Guild setup could not be saved');
      await interaction.editReply({
        content: error instanceof UserInputError
          ? error.message
          : 'Setup could not be saved. Check the selected channels and the bot permissions, then try again.',
        components: setupReviewPayload(session.id, session.values).components,
        allowedMentions: { parse: [] },
      });
    }
  }

  nextSetupPayload(session) {
    return session.stepIndex < GUILD_SETUP_STEPS.length
      ? setupStepPayload(session.id, session.stepIndex, session.values)
      : setupReviewPayload(session.id, session.values);
  }

  removeExpiredSetupSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.setupSessions) {
      if (session.expiresAt <= now) this.setupSessions.delete(sessionId);
    }
  }

  async applyGuildSetup(guild, values, configuredByUserId) {
    const configuration = await this.validateGuildSetup(guild, values, configuredByUserId);
    const previousPanel = await this.repositories.getPanel(guild.id);
    const saved = await this.repositories.upsertGuildConfiguration(configuration);
    this.guildConfigs.set(guild.id, saved);
    this.completionChannels.delete(guild.id);
    this.transcriptChannels.delete(guild.id);

    if (saved.completedDealsChannelId) await this.initializeGuildCompletionChannel(saved, guild);
    if (saved.transcriptChannelId) await this.initializeGuildTranscriptChannel(saved);
    await this.initializeGuildPanel(saved, guild);
    await this.initializeGuildCommands(guild).catch((error) => {
      this.logger.warn({ guildId: guild.id, errorName: error.name }, 'Guild stats commands could not be initialized after setup');
    });

    if (previousPanel && previousPanel.channel_id !== saved.panelChannelId) {
      const oldChannel = await this.client.channels.fetch(previousPanel.channel_id).catch(() => null);
      const oldMessage = oldChannel?.messages?.fetch
        ? await oldChannel.messages.fetch(previousPanel.message_id).catch(() => null)
        : null;
      if (oldMessage?.delete) await oldMessage.delete().catch(() => null);
    }
    this.logger.info({ guildId: guild.id, configuredByUserId }, 'Guild setup saved');
    return saved;
  }

  async validateGuildSetup(guild, values, configuredByUserId) {
    if (!values.panelChannelId || !values.ticketCategoryId) {
      throw new UserInputError('The swap panel channel and ticket category are required.');
    }
    const member = guild.members?.me ?? await guild.members?.fetchMe?.();
    if (!member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
      throw new UserInputError('The bot needs Manage Channels before setup can be saved.');
    }

    const requirements = {
      panelChannelId: {
        types: [ChannelType.GuildText],
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        permissionNames: 'View Channel, Send Messages, Embed Links, and Read Message History',
      },
      ticketCategoryId: {
        types: [ChannelType.GuildCategory],
        permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
        permissionNames: 'View Channel and Manage Channels',
      },
      completedDealsChannelId: {
        types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        permissionNames: 'View Channel, Send Messages, Embed Links, Attach Files, and Read Message History',
      },
      transcriptChannelId: {
        types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        permissionNames: 'View Channel, Send Messages, Attach Files, and Read Message History',
      },
      vouchChannelId: {
        types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        permissions: [PermissionFlagsBits.ViewChannel],
        permissionNames: 'View Channel',
      },
    };

    for (const [key, requirement] of Object.entries(requirements)) {
      const channelId = values[key];
      if (!channelId) continue;
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      const label = GUILD_SETUP_STEPS.find((step) => step.key === key)?.label ?? 'Selected channel';
      if (!channel || channel.guildId !== guild.id || !requirement.types.includes(channel.type)) {
        throw new UserInputError(`${label} must be a valid channel in this server.`);
      }
      if (!channel.permissionsFor?.(member)?.has?.(requirement.permissions)) {
        throw new UserInputError(`The bot needs ${requirement.permissionNames} in ${label}.`);
      }
    }

    return {
      guildId: guild.id,
      panelChannelId: values.panelChannelId,
      ticketCategoryId: values.ticketCategoryId,
      completedDealsChannelId: values.completedDealsChannelId ?? null,
      transcriptChannelId: values.transcriptChannelId ?? null,
      vouchChannelId: values.vouchChannelId ?? null,
      configuredByUserId,
    };
  }

  async handleStatsCommand(interaction) {
    await interaction.deferReply();
    if (!interaction.guildId || !this.guildConfigs.has(interaction.guildId)) {
      await interaction.editReply('Swap stats are not configured for this server.');
      return;
    }
    const targetUser = interaction.options?.getUser?.('user') ?? interaction.user;
    const stats = await this.getUserSwapStats(interaction.guildId, targetUser.id);
    await interaction.editReply({
      ...userStatsPayload(stats, targetUser),
      allowedMentions: { parse: [] },
    });
  }

  async handleLeaderboardCommand(interaction) {
    await interaction.deferReply();
    if (!interaction.guildId || !this.guildConfigs.has(interaction.guildId)) {
      await interaction.editReply('The swap leaderboard is not configured for this server.');
      return;
    }
    const entries = await this.repositories.listUserSwapLeaderboard(interaction.guildId, 5);
    await interaction.editReply({
      ...leaderboardPayload(entries),
      allowedMentions: { parse: [] },
    });
  }

  async getUserSwapStats(guildId, userId, { includeSwap = null } = {}) {
    if (typeof this.repositories.getUserSwapStats !== 'function') return null;
    return this.repositories.getUserSwapStats(guildId, userId, {
      includeSwapId: includeSwap?.id ?? null,
      includeAmountUsd: completedSwapAmountUsd(includeSwap),
    });
  }

  async startTicket(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildConfig = this.guildConfigs.get(interaction.guildId);
    if (!guildConfig) {
      await interaction.editReply('This swap panel is not configured for this server.');
      return;
    }
    if (!this.health.isReady()) {
      await interaction.editReply('The swap service is temporarily unavailable. Please try again later.');
      return;
    }

    const guild = interaction.guild;
    const existingTickets = await this.repositories.getOpenTicketsForUser(guild.id, interaction.user.id);
    const activeTickets = [];
    for (const existing of existingTickets) {
      if (!existing.channel_id) {
        activeTickets.push(existing);
        continue;
      }
      const existingChannel = await guild.channels.fetch(existing.channel_id).catch(() => null);
      if (existingChannel) activeTickets.push(existing);
      else await this.repositories.markTicketDeleted(existing.id);
    }
    if (activeTickets.length >= MAX_ACTIVE_TICKETS_PER_USER) {
      await interaction.editReply(activeTicketLimitMessage(activeTickets));
      return;
    }

    const ticketId = randomUUID();
    const reservation = await this.repositories.reserveTicket({
      id: ticketId,
      guildId: guild.id,
      userId: interaction.user.id,
      maxActiveTickets: MAX_ACTIVE_TICKETS_PER_USER,
    });
    if (!reservation.created) {
      await interaction.editReply(activeTicketLimitMessage(reservation.tickets ?? [reservation.ticket].filter(Boolean)));
      return;
    }

    let channel = null;
    try {
      channel = await guild.channels.create({
        name: ticketChannelName(interaction.user.username, ticketId),
        type: ChannelType.GuildText,
        parent: guildConfig.ticketCategoryId,
        topic: `Private non-custodial swap ticket ${ticketId}; owner ${interaction.user.id}`,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: interaction.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          },
          {
            id: this.client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
            ],
          },
        ],
        reason: `Private swap ticket for Discord user ${interaction.user.id}`,
      });
      const ticket = await this.repositories.completeTicketCreation(ticketId, channel.id);
      const header = await channel.send({
        content: `<@${interaction.user.id}> use the controls below to build one swap. Never post a private key or seed phrase.`,
        ...ticketHeaderPayload(ticket.id),
        allowedMentions: { users: [interaction.user.id] },
      });
      await this.repositories.setHeaderMessage(ticketId, header.id);
      const message = await channel.send({
        ...renderTicket(ticket, this.catalogue, null, this.config, this.coinPolicy, this.emojis),
        allowedMentions: { parse: [] },
      });
      await this.repositories.setProgressMessage(ticketId, message.id);
      await interaction.editReply(`Your private swap ticket is ready: <#${channel.id}>`);
    } catch (error) {
      if (channel) await channel.delete('Ticket setup failed').catch(() => null);
      await this.repositories.failTicketCreation(ticketId);
      this.logger.error({ ticketId, errorCode: 'TICKET_CREATE_FAILED', errorName: error.name }, 'Private ticket channel creation failed');
      await interaction.editReply('I could not create the private ticket. Ask the server owner to verify the bot category and Manage Channels permission.');
    }
  }

  async routeTicketInteraction(interaction, ticket, action, argument = null) {
    const data = { ...(ticket.state_data ?? {}) };

    if (['watch-exact', 'use-backup', 'retry-exact'].includes(action) && interaction.isButton() && ticket.step === 'USD_AMOUNT') {
      if (data.noRouteOffer !== routeFingerprint(data) || !data.amountBase || !data.recipient || !data.refundTo) throw new UserInputError('Request a new quote before using this option.');
      if (action === 'watch-exact') {
        const watched = await this.repositories.enableRouteWatch(ticket.id, 'exact');
        if (!watched) throw new UserInputError('This ticket changed. Request a fresh quote.');
        await interaction.update({ content: 'I’ll watch this exact pair and amount and ping you in this ticket when a regular provider has a route. Automatic inactivity closure is paused while you wait.', components: [], allowedMentions: { parse: [] } });
        return;
      }
      data.backupConsent = action === 'use-backup';
      await this.repositories.cancelRouteWatch(ticket.id);
      const updated = await this.updateAndRender(interaction, ticket.id, 'QUOTE_LOADING', data, { expectedStep: ticket.step });
      if (!updated) return;
      await this.dismissRouteChoicePrompt(interaction);
      const result = await this.createPreviewFromChat(ticket.id, data, null);
      if (!result.ok) await this.privateReply(interaction, result.userPayload ?? result.userMessage);
      return;
    }

    if (action === 'watch-route' && interaction.isButton() && ticket.step === 'ORIGIN_COIN') {
      await this.enablePopularRouteWatch(interaction, ticket, argument);
      return;
    }

    if (action === 'use-backup-popular' && interaction.isButton() && ticket.step === 'ORIGIN_COIN') {
      const popularBackup = getPopularSwap(argument);
      if (!popularBackup) throw new UserInputError('That popular route is no longer available. Choose the coins and networks manually.');
      await this.choosePopularBackup(interaction, ticket, data, popularBackup);
      return;
    }

    const popularSwap = getPopularSwap(action);
    if (popularSwap && interaction.isButton() && ticket.step === 'ORIGIN_COIN') {
      await this.choosePopularSwap(interaction, ticket, data, popularSwap);
      return;
    }

    if (action === 'select-origin-coin' && interaction.isStringSelectMenu() && ticket.step === 'ORIGIN_COIN') {
      const coinKey = interaction.values[0];
      if (coinKey === OTHER_COIN_KEY) {
        await this.updateAndRender(interaction, ticket.id, 'ORIGIN_OTHER', data, { expectedStep: ticket.step });
        return;
      }
      await this.chooseOriginCoin(interaction, ticket.id, data, coinKey, 'featured', ticket.step);
      return;
    }

    if (action === 'select-origin-other' && interaction.isStringSelectMenu() && ticket.step === 'ORIGIN_OTHER') {
      await this.chooseOriginCoin(interaction, ticket.id, data, interaction.values[0], 'other', ticket.step);
      return;
    }

    if (action === 'select-origin-network' && interaction.isStringSelectMenu() && ticket.step === 'ORIGIN_NETWORK') {
      const asset = this.coinPolicy.getAssetsForCoin(data.originCoin).find((candidate) => candidate.assetId === interaction.values[0]);
      if (!asset) throw new UserInputError('That sending network is no longer available. Choose the coin again.');
      clearDestination(data);
      Object.assign(data, { originAssetId: asset.assetId, originNetworkAutoSelected: false });
      await this.updateAndRender(interaction, ticket.id, 'DESTINATION_COIN', data, { expectedStep: ticket.step });
      return;
    }

    if (action === 'select-destination-coin' && interaction.isStringSelectMenu() && ticket.step === 'DESTINATION_COIN') {
      const coinKey = interaction.values[0];
      if (coinKey === OTHER_COIN_KEY) {
        await this.updateAndRender(interaction, ticket.id, 'DESTINATION_OTHER', data, { expectedStep: ticket.step });
        return;
      }
      await this.chooseDestinationCoin(interaction, ticket.id, data, coinKey, 'featured', ticket.step);
      return;
    }

    if (action === 'select-destination-other' && interaction.isStringSelectMenu() && ticket.step === 'DESTINATION_OTHER') {
      await this.chooseDestinationCoin(interaction, ticket.id, data, interaction.values[0], 'other', ticket.step);
      return;
    }

    if (action === 'select-destination-network' && interaction.isStringSelectMenu() && ticket.step === 'DESTINATION_NETWORK') {
      const asset = this.coinPolicy.getAssetsForCoin(data.destinationCoin, data.originAssetId)
        .find((candidate) => candidate.assetId === interaction.values[0]);
      if (!asset) throw new UserInputError('That receiving network is no longer available. Choose the coin again.');
      clearSwapDetails(data);
      Object.assign(data, { destinationAssetId: asset.assetId, destinationNetworkAutoSelected: false });
      await this.updateAndRender(interaction, ticket.id, 'USD_AMOUNT', data, { expectedStep: ticket.step });
      return;
    }

    if (action === 'back' && interaction.isButton()) {
      const previousStep = previousVisibleStep(ticket.step, data, this.coinPolicy);
      if (!previousStep) {
        const staleMessage = interaction.message?.id
          && ticket.progress_message_id
          && interaction.message.id !== ticket.progress_message_id;
        const message = staleMessage
          ? 'That Back button belongs to an earlier step. Use the Back button in the latest message.'
          : ['ACTIVE', 'TERMINAL'].includes(ticket.step)
            ? 'This swap has already been confirmed, so its setup can no longer be changed.'
            : 'You are already at the first step.';
        await this.privateReply(interaction, message);
        return;
      }
      await this.updateAndRender(interaction, ticket.id, previousStep, data, { append: false, expectedStep: ticket.step });
      return;
    }

    if (action === 'check-routes' && interaction.isButton() && ['USD_AMOUNT', 'PREVIEW'].includes(ticket.step)) {
      await this.checkAvailableRoutes(interaction, ticket, data);
      return;
    }

    if (action === 'refresh-preview' && interaction.isButton() && ticket.step === 'PREVIEW') {
      const updated = await this.updateAndRender(interaction, ticket.id, 'QUOTE_LOADING', data, {
        append: false,
        expectedStep: ticket.step,
      });
      if (!updated) return;
      const result = await this.createPreviewFromChat(ticket.id, data, null);
      if (!result.ok) await this.privateReply(interaction, result.userPayload ?? result.userMessage);
      return;
    }

    if (action === 'confirm' && interaction.isButton() && ticket.step === 'PREVIEW') {
      await interaction.deferUpdate();
      const claimed = await this.repositories.claimSwapConfirmation(ticket.id);
      if (!claimed) {
        const current = await this.repositories.getSwapByTicket(ticket.id);
        if (current?.executable_quote) {
          await this.repositories.updateTicketFlow(ticket.id, 'ACTIVE', data);
        } else {
          await this.repositories.updateTicketFlow(ticket.id, 'REFUND_ADDRESS', data);
          await interaction.followUp({ content: 'This preview expired or is already being confirmed. Generate a fresh preview.', flags: MessageFlags.Ephemeral });
        }
        await this.renderProgress(ticket.id);
        return;
      }

      await this.editProgress(ticket.id, loadingPayload('Creating and verifying executable deposit instructions…'));
      const originAsset = this.catalogue.getAsset(claimed.origin_asset_id);
      const destinationAsset = this.catalogue.getAsset(claimed.destination_asset_id);
      try {
        if (!originAsset || !destinationAsset) throw new Error('A selected asset is no longer supported.');
        const quote = await this.oneClick.getVerifiedQuote({
          dry: false,
          originAsset,
          destinationAsset,
          amountBase: claimed.amount_base,
          provider: claimed.dry_quote?.provider ?? 'oneclick',
          backupConsent: claimed.dry_quote?.quoteRequest?.backupConsent === true,
          recipient: claimed.recipient,
          refundTo: claimed.refund_to,
        });
        const active = await this.repositories.activateSwap(ticket.id, quote, new Date(Date.now() + 10_000));
        if (!active) throw new Error('The executable quote could not be activated.');
        await this.repositories.clearTicketError(ticket.id);
        await this.repositories.updateTicketFlow(ticket.id, 'ACTIVE', data);
        if (!['changenow', 'changelly', 'fixedfloat', 'relay'].includes(quote.provider)) this.health.oneClickAuthentication = true;
        await this.renderProgress(ticket.id);
        await this.ensureDepositQr(ticket.id);
      } catch (error) {
        this.markAuthenticationHealth(error);
        const classification = this.oneClick.classifyError(error, { operation: 'executable_quote' });
        await this.repositories.recordTicketError(ticket.id, classification.code, classification.status);
        await this.repositories.revertSwapConfirmation(ticket.id, classification.code);
        this.logger.warn({ ticketId: ticket.id, ...this.oneClick.safeErrorLogFields(error, { operation: 'executable_quote' }) }, 'Executable quote request failed');
        await this.renderProgress(ticket.id);
        await interaction.followUp({
          ...quoteFailurePayload(ticket.id, classification, originAsset, destinationAsset, this.coinPolicy, {
            backupSelected: claimed.dry_quote?.provider === 'fixedfloat'
              || claimed.dry_quote?.quoteRequest?.backupConsent === true,
          }),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    if (action === 'refresh' && interaction.isButton() && ticket.step === 'ACTIVE') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const swap = await this.repositories.getSwapByTicket(ticket.id);
        if (!swap?.executable_quote) {
          await interaction.editReply('No executable swap exists in this ticket.');
          return;
        }
        if (!this.statusWorker) throw new Error('Status tracking is not ready.');
        await this.statusWorker.refreshSwap(swap, { announce: false, rethrow: true });
        await this.renderProgress(ticket.id);
        const refreshed = await this.repositories.getSwapByTicket(ticket.id);
        await interaction.editReply(`Current swap status: **${refreshed.status}**`);
      } catch (error) {
        this.markAuthenticationHealth(error);
        await interaction.editReply(this.oneClick.userMessage(error, { operation: 'status_refresh' }));
      }
      return;
    }

    if (['ff-exchange', 'ff-refund'].includes(action) && interaction.isButton() && ticket.step === 'ACTIVE') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const swap = await this.repositories.getSwapByTicket(ticket.id);
      await this.oneClick.chooseFixedFloatRecovery(swap, action === 'ff-refund' ? 'REFUND' : 'EXCHANGE');
      await interaction.editReply(action === 'ff-refund'
        ? 'Refund requested to your configured refund address, minus the network fee. Tracking continues.'
        : 'Exchange requested for the received funds at the current market rate. Tracking continues.');
      await this.statusWorker.refreshSwap(swap, { announce: false, rethrow: true });
      await this.renderProgress(ticket.id);
      return;
    }

    if (action === 'show-deposit' && interaction.isButton() && ticket.step === 'ACTIVE') {
      await interaction.deferUpdate();
      const swap = await this.repositories.getSwapByTicket(ticket.id);
      if (!swap?.executable_quote || !swap.deposit_address) throw new UserInputError('Deposit instructions are not available yet.');
      const quote = swap.executable_quote.quote ?? {};
      const channel = interaction.channel;
      if (!channel?.isTextBased()) throw new Error('The ticket channel is unavailable.');
      await channel.send({
        content: swap.deposit_address,
        allowedMentions: { parse: [] },
      });
      await channel.send({
        content: String(quote.amountInFormatted ?? swap.amount_display),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (action === 'show-incomplete-deposit' && interaction.isButton() && ticket.step === 'ACTIVE') {
      await interaction.deferUpdate();
      const swap = await this.repositories.getSwapByTicket(ticket.id);
      if (!swap?.deposit_address) throw new UserInputError('Deposit instructions are not available yet.');
      const originAsset = this.catalogue.getAsset(swap.origin_asset_id);
      const details = incompleteDepositDetails(swap.last_status_response, swap, originAsset);
      if (!details) throw new UserInputError('The remaining deposit amount is no longer available. Use Check status for the latest swap state.');
      const channel = interaction.channel;
      if (!channel?.isTextBased()) throw new Error('The ticket channel is unavailable.');
      await channel.send({
        content: swap.deposit_address,
        allowedMentions: { parse: [] },
      });
      await channel.send({
        content: details.remainingFormatted,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (action === 'close' && interaction.isButton()) {
      if (ticket.step === 'TERMINAL') {
        await interaction.deferUpdate();
        await this.deleteTicketImmediately(ticket.id, 'Closed by the ticket owner after completion');
        return;
      }
      const swap = await this.repositories.getSwapByTicket(ticket.id);
      await interaction.reply({
        ...closeConfirmationPayload(ticket.id, Boolean(swap?.executable_quote)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === 'close-cancel' && interaction.isButton()) {
      await interaction.update({ content: 'Ticket kept open.', embeds: [], components: [] });
      return;
    }

    if (action === 'close-confirm' && interaction.isButton()) {
      await interaction.deferUpdate();
      await this.deleteTicketImmediately(ticket.id, 'Closed by the ticket owner after confirmation');
      return;
    }

    await this.privateReply(interaction, 'That control is no longer valid for the current ticket step.');
  }

  async checkAvailableRoutes(interaction, ticket, data) {
    const now = Date.now();
    for (const [ticketId, checkedAt] of this.routeCheckCooldowns) {
      if (now - checkedAt >= ROUTE_CHECK_COOLDOWN_MS) this.routeCheckCooldowns.delete(ticketId);
    }
    if (this.routeChecks.has(ticket.id)) {
      await this.privateReply(interaction, 'Alternative routes are already being checked for this ticket.');
      return;
    }
    const previousCheck = this.routeCheckCooldowns.get(ticket.id);
    if (previousCheck) {
      const seconds = Math.max(1, Math.ceil((previousCheck + ROUTE_CHECK_COOLDOWN_MS - now) / 1000));
      await this.privateReply(interaction, `Wait ${seconds} seconds before checking routes again.`);
      return;
    }

    const originAsset = this.catalogue.getAsset(data.originAssetId);
    const destinationAsset = this.catalogue.getAsset(data.destinationAssetId);
    if (!originAsset || !destinationAsset || !positiveAtomicAmount(data.amountBase) || !data.recipient || !data.refundTo) {
      throw new UserInputError('The original swap details are no longer available. Enter the amount and wallet addresses again.');
    }

    this.routeChecks.add(ticket.id);
    this.routeCheckCooldowns.set(ticket.id, now);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.routeChecks.delete(ticket.id);
      this.routeCheckCooldowns.delete(ticket.id);
      throw error;
    }
    try {
      const result = await this.findAlternativeRoutes({
        ticketId: ticket.id,
        originAsset,
        destinationAsset,
        amountBase: data.amountBase,
        recipient: data.recipient,
        refundTo: data.refundTo,
      });
      await interaction.editReply({
        content: alternativeRoutesMessage(result, originAsset, destinationAsset, this.coinPolicy),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      this.markAuthenticationHealth(error);
      const context = { operation: 'alternative_route_quote' };
      this.logger.warn({ ticketId: ticket.id, ...this.oneClick.safeErrorLogFields(error, context) }, 'Alternative route check failed');
      await interaction.editReply({
        content: this.oneClick.userMessage(error, context),
        allowedMentions: { parse: [] },
      }).catch(() => null);
    } finally {
      this.routeChecks.delete(ticket.id);
    }
  }

  async findAlternativeRoutes({ ticketId, originAsset, destinationAsset, amountBase, recipient, refundTo }) {
    const candidates = alternativeBridgeAssets(originAsset, destinationAsset, this.coinPolicy);
    const routes = [];
    let hadOperationalErrors = false;
    let checkedCount = 0;

    for (let index = 0; index < candidates.length; index += ALTERNATIVE_ROUTE_CONCURRENCY) {
      const batch = candidates.slice(index, index + ALTERNATIVE_ROUTE_CONCURRENCY);
      const checked = await Promise.all(batch.map((bridgeAsset) => this.checkAlternativeRoute({
        ticketId,
        originAsset,
        destinationAsset,
        bridgeAsset,
        amountBase,
        recipient,
        refundTo,
      })));
      checkedCount += checked.length;
      for (const result of checked) {
        if (result.route) routes.push(result.route);
        hadOperationalErrors ||= result.operationalError;
      }
      if (routes.length >= MAX_ALTERNATIVE_ROUTE_RESULTS) break;
    }

    return {
      routes: routes.slice(0, MAX_ALTERNATIVE_ROUTE_RESULTS),
      checkedCount,
      hadOperationalErrors,
    };
  }

  async checkAlternativeRoute({
    ticketId,
    originAsset,
    destinationAsset,
    bridgeAsset,
    amountBase,
    recipient,
    refundTo,
  }) {
    const bridgeAddress = bridgeAsset.blockchain === destinationAsset.blockchain ? recipient : refundTo;
    try {
      const firstQuote = await this.oneClick.getVerifiedQuote({
        dry: true,
        originAsset,
        destinationAsset: bridgeAsset,
        amountBase,
        recipient: bridgeAddress,
        refundTo,
      });
      const secondAmountBase = positiveAtomicAmount(firstQuote?.quote?.minAmountOut);
      if (!secondAmountBase) throw new Error('The first alternative-route quote omitted a usable minimum output.');
      const secondQuote = await this.oneClick.getVerifiedQuote({
        dry: true,
        originAsset: bridgeAsset,
        destinationAsset,
        amountBase: secondAmountBase,
        recipient,
        refundTo: bridgeAddress,
      });
      return {
        route: { bridgeAsset, firstQuote, secondQuote },
        operationalError: false,
      };
    } catch (error) {
      this.markAuthenticationHealth(error);
      const context = { operation: 'alternative_route_quote' };
      const classification = this.oneClick.classifyError(error, context);
      const expectedUnavailable = [
        'AMOUNT_TOO_LOW',
        'AMOUNT_TOO_HIGH',
        'INVALID_RECIPIENT_ADDRESS',
        'INVALID_REFUND_ADDRESS',
        'INVALID_WALLET_ADDRESS',
        'NO_LIQUIDITY_ROUTE',
        'ONECLICK_REQUEST_REJECTED',
      ].includes(classification.code);
      if (!expectedUnavailable) {
        this.logger.warn({
          ticketId,
          bridgeAssetId: bridgeAsset.assetId,
          ...this.oneClick.safeErrorLogFields(error, context),
        }, 'Alternative route candidate could not be checked');
      }
      return { route: null, operationalError: !expectedUnavailable };
    }
  }

  async createPreviewFromChat(ticketId, data, sourceMessage) {
    const originAsset = this.catalogue.getAsset(data.originAssetId);
    const destinationAsset = this.catalogue.getAsset(data.destinationAssetId);
    if (!originAsset || !destinationAsset) {
      await this.repositories.updateTicketFlowIfStep(ticketId, 'QUOTE_LOADING', 'REFUND_ADDRESS', data);
      await this.replyToTicketMessage(sourceMessage, 'A selected asset is no longer available. Go back and choose the coins again.');
      await this.renderProgress(ticketId);
      return { ok: false, userMessage: 'A selected asset is no longer available. Go back and choose the coins again.' };
    }

    try {
      const quote = await this.oneClick.getVerifiedQuote({
        dry: true,
        provider: data.backupConsent ? 'fixedfloat' : undefined,
        backupConsent: data.backupConsent === true,
        originAsset,
        destinationAsset,
        amountBase: data.amountBase,
        recipient: data.recipient,
        refundTo: data.refundTo,
      });
      const preview = await this.repositories.savePreview({
        id: randomUUID(),
        ticketId,
        originAssetId: originAsset.assetId,
        destinationAssetId: destinationAsset.assetId,
        amountDisplay: data.amountDisplay,
        amountBase: data.amountBase,
        amountUsdRequested: data.amountUsdRequested,
        conversionPriceUsd: data.conversionPriceUsd,
        conversionPriceAt: data.conversionPriceAt,
        recipient: data.recipient,
        refundTo: data.refundTo,
        slippageBps: this.config.slippageBps,
        dryQuote: quote,
        previewExpiresAt: new Date(Date.now() + this.config.previewTtlMs),
      });
      if (!preview) throw new Error('An executable quote already exists for this ticket.');
      await this.repositories.updateTicketFlowIfStep(ticketId, 'QUOTE_LOADING', 'PREVIEW', data);
      await this.rememberUserAddresses(ticketId, originAsset, destinationAsset, data).catch((error) => {
        this.logger.warn({ ticketId, errorName: error.name, operation: 'remember_user_addresses' }, 'Validated wallet addresses could not be remembered');
      });
      if (!['changenow', 'changelly', 'fixedfloat', 'relay'].includes(quote.provider)) this.health.oneClickAuthentication = true;
      await this.renderProgress(ticketId);
      return { ok: true };
    } catch (error) {
      this.markAuthenticationHealth(error);
      const classification = this.oneClick.classifyError(error, { operation: 'preview_quote' });
      const backupSelected = data.backupConsent === true;
      let backupAvailable = false;
      let backupQuote = null;
      if (!backupSelected && ['AMOUNT_TOO_LOW', 'NO_LIQUIDITY_ROUTE'].includes(classification.code)
        && (typeof this.oneClick.getFixedFloatIndicativeQuote === 'function'
          || typeof this.oneClick.canUseFixedFloat === 'function')) {
        try {
          if (typeof this.oneClick.getFixedFloatIndicativeQuote === 'function') {
            backupQuote = await this.oneClick.getFixedFloatIndicativeQuote({ originAsset, destinationAsset, amountBase: data.amountBase });
            backupAvailable = Boolean(backupQuote);
          } else {
            backupAvailable = await this.oneClick.canUseFixedFloat({ originAsset, destinationAsset, amountBase: data.amountBase });
          }
        } catch (backupError) {
          this.logger.warn({
            ticketId,
            ...this.oneClick.safeErrorLogFields(backupError, { operation: 'fixedfloat_availability' }),
          }, 'FixedFloat amount availability could not be checked');
        }
      }
      const offerRecovery = classification.code === 'NO_LIQUIDITY_ROUTE' || backupAvailable;
      data.noRouteOffer = offerRecovery ? routeFingerprint(data) : null;
      data.backupConsent = false;
      await this.repositories.updateTicketFlowIfStep(ticketId, 'QUOTE_LOADING', quoteRecoveryStep(classification.code), data);
      await this.repositories.recordTicketError(ticketId, classification.code, classification.status);
      this.logger.warn({ ticketId, ...this.oneClick.safeErrorLogFields(error, { operation: 'preview_quote' }) }, 'Preview quote request failed');
      await this.renderProgress(ticketId);
      const userPayload = quoteFailurePayload(ticketId, classification, originAsset, destinationAsset, this.coinPolicy, {
        backupSelected,
        backupAvailable,
        backupQuote,
      });
      await this.replyToTicketMessage(sourceMessage, userPayload);
      return { ok: false, userMessage: userPayload.content, userPayload };
    }
  }

  async ensureDepositQr(ticketId) {
    if (!this.qrService) return;
    const ticket = await this.repositories.getTicket(ticketId);
    const swap = await this.repositories.getSwapByTicket(ticketId);
    if (!ticket?.channel_id || ticket.state !== 'OPEN' || !swap?.executable_quote || !swap.deposit_address) return;
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;

    if (!ticket.progress_message_id) return;
    if (swap.qr_message_id) {
      const existing = await channel.messages.fetch(swap.qr_message_id).catch(() => null);
      const integrated = swap.qr_message_id === ticket.progress_message_id;
      const hasQrAttachment = existing?.attachments?.some?.((attachment) => attachment.name === 'deposit-address.png') ?? false;
      if (integrated && existing && hasQrAttachment) return;
      if (existing && !integrated) await existing.delete().catch(() => null);
      await this.repositories.clearMissingQrMessage(swap.id, swap.qr_message_id);
    }

    try {
      const png = await this.qrService.createDepositAddressPng(swap.deposit_address);
      const claimed = await this.repositories.claimQrMessage(swap.id, ticket.progress_message_id);
      if (!claimed) return;
      const message = await channel.messages.fetch(ticket.progress_message_id).catch(() => null);
      if (!message) {
        await this.repositories.clearMissingQrMessage(swap.id, ticket.progress_message_id);
        return;
      }
      const currentTicket = await this.repositories.getTicket(ticketId);
      const currentSwap = await this.repositories.getSwapByTicket(ticketId);
      const payload = renderTicket(currentTicket, this.catalogue, currentSwap, this.config, this.coinPolicy, this.emojis);
      await message.edit({
        ...payload,
        attachments: [],
        files: [{ attachment: png, name: 'deposit-address.png', description: 'Deposit address QR code' }],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await this.repositories.clearMissingQrMessage(swap.id, ticket.progress_message_id).catch(() => null);
      this.logger.warn({ ticketId, errorName: error.name, operation: 'deposit_qr' }, 'Deposit QR code could not be created');
    }
  }

  async rememberUserAddresses(ticketId, originAsset, destinationAsset, data) {
    const ticket = await this.repositories.getTicket(ticketId);
    if (!ticket) return false;
    await this.repositories.saveUserChainAddress(
      ticket.guild_id,
      ticket.user_id,
      destinationAsset.blockchain,
      data.recipient,
    );
    await this.repositories.saveUserChainAddress(
      ticket.guild_id,
      ticket.user_id,
      originAsset.blockchain,
      data.refundTo,
    );
    return true;
  }

  async syncDepositSpeedupMessage(ticket, swap) {
    if (['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap?.executable_quote?.provider)) return;
    if (!ticket?.channel_id || ticket.state !== 'OPEN' || !swap?.executable_quote) return;
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;

    let existing = swap.deposit_speedup_message_id
      ? await channel.messages.fetch(swap.deposit_speedup_message_id).catch(() => null)
      : null;
    if (!existing && swap.deposit_speedup_message_id) {
      await this.repositories.clearMissingDepositSpeedupMessage(swap.id, swap.deposit_speedup_message_id);
      swap.deposit_speedup_message_id = null;
    }

    if (!existing) {
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      existing = recent
        ? [...recent.values()].find((message) => (
            message.author?.id === this.client.user?.id
            && message.embeds?.some((embed) => DEPOSIT_SPEEDUP_TITLES.has(embed.title))
          )) ?? null
        : null;
      if (existing) {
        const claimed = await this.repositories.claimDepositSpeedupMessage(swap.id, existing.id);
        if (claimed) swap.deposit_speedup_message_id = existing.id;
      }
    }

    const payload = { ...depositSpeedupPayload(swap), allowedMentions: { parse: [] } };
    if (existing) {
      await existing.edit({ ...payload, attachments: [] }).catch(() => null);
      return;
    }
    if (swap.status !== 'PENDING_DEPOSIT' || swap.deposit_tx_hash) return;

    const message = await channel.send(payload);
    const claimed = await this.repositories.claimDepositSpeedupMessage(swap.id, message.id);
    if (!claimed) await message.delete().catch(() => null);
  }

  async publishCompletionSummary(swap) {
    if (swap?.status !== 'SUCCESS' || !swap.executable_quote) return false;
    if (swap.guild_id && !this.guildConfigs.get(swap.guild_id)?.completedDealsChannelId) return false;
    const claimed = await this.repositories.claimCompletionSummary(
      swap.id,
      new Date(Date.now() - 5 * 60_000),
    );
    if (!claimed) return false;

    const reference = createHash('sha256').update(String(claimed.id)).digest('hex').slice(0, 12);
    const footerText = `Order ${reference.slice(0, 6).toUpperCase()}`;
    const legacyFooterText = `Deal ${reference}`;
    const attribution = completionAttribution(claimed.user_id);
    try {
      const channel = await this.getCompletionChannel(claimed.guild_id);
      const recent = await channel.messages.fetch({ limit: 100 });
      const existing = [...recent.values()].find((message) => (
        message.author?.id === this.client.user.id
        && message.embeds?.some((embed) => [footerText, legacyFooterText].includes(embed.footer?.text))
      ));
      if (existing) {
        await this.repositories.completeCompletionSummary(claimed.id, existing.id);
        return true;
      }

      const message = await channel.send({
        ...(attribution ? { content: attribution } : {}),
        embeds: [completedDealEmbed(claimed, this.catalogue, reference)],
        components: completedDealComponents(claimed, this.catalogue),
        files: [{ attachment: this.completionGif, name: 'deal-history.gif', description: 'Animated deal history' }],
        allowedMentions: { parse: [] },
      });
      await this.repositories.completeCompletionSummary(claimed.id, message.id);
      return true;
    } catch (error) {
      await this.repositories.releaseCompletionSummary(claimed.id).catch(() => null);
      this.logger.warn({ swapId: claimed.id, errorName: error.name, operation: 'completion_summary' }, 'Completed-deal summary will be retried');
      return false;
    }
  }

  async reconcileCompletionSummaries() {
    const swaps = await this.repositories.listPostedCompletionSummaries();
    let reconciled = 0;
    for (const swap of swaps) {
      try {
        if (swap.guild_id && !this.guildConfigs.get(swap.guild_id)?.completedDealsChannelId) continue;
        const channel = await this.getCompletionChannel(swap.guild_id);
        const message = await channel.messages.fetch(swap.completion_summary_message_id).catch(() => null);
        if (!message) continue;
        const reference = createHash('sha256').update(String(swap.id)).digest('hex').slice(0, 12);
        const embed = completedDealEmbed(swap, this.catalogue, reference);
        const components = completedDealComponents(swap, this.catalogue);
        if (completionSummaryIsCurrent(message, embed, components)) continue;
        await message.edit({
          embeds: [embed],
          components,
          attachments: [],
          files: [{ attachment: this.completionGif, name: 'deal-history.gif', description: 'Animated deal history' }],
          allowedMentions: { parse: [] },
        });
        reconciled += 1;
      } catch (error) {
        this.logger.warn({ swapId: swap.id, errorName: error.name, operation: 'completion_summary_reconciliation' }, 'Completed-deal summary could not be refreshed');
      }
    }
    this.logger.info({ reconciledCompletionSummaryCount: reconciled }, 'Completed-deal summaries reconciled');
  }

  async getCompletionChannel(guildId = null) {
    if (guildId && this.completionChannels.has(guildId)) return this.completionChannels.get(guildId);
    if (!guildId && this.completionChannel) return this.completionChannel;
    const guildConfig = guildId ? this.guildConfigs.get(guildId) : configuredGuilds(this.config)[0];
    if (!guildConfig) throw new Error('The completed-deals guild is not configured.');
    const channel = await this.client.channels.fetch(guildConfig.completedDealsChannelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      throw new Error('The completed-deals channel is unavailable.');
    }
    this.completionChannels.set(guildConfig.guildId, channel);
    if (!this.completionChannel) this.completionChannel = channel;
    return channel;
  }

  async replyToTicketMessage(message, response) {
    if (!message?.reply) return;
    const payload = typeof response === 'string' ? { content: response } : response;
    await message.reply({
      ...payload,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => null);
  }

  async chooseOriginCoin(interaction, ticketId, data, coinKey, expectedGroup, expectedStep) {
    const definition = this.coinPolicy.getCoin(coinKey);
    if (!definition || definition.group !== expectedGroup) throw new UserInputError('That sending coin is not available.');
    const assets = this.coinPolicy.getAssetsForCoin(definition.key);
    if (assets.length === 0) throw new UserInputError('That sending coin is temporarily unavailable.');

    clearOrigin(data);
    Object.assign(data, { originCoin: definition.key, originCoinGroup: definition.group });
    if (assets.length === 1) {
      Object.assign(data, { originAssetId: assets[0].assetId, originNetworkAutoSelected: true });
      await this.updateAndRender(interaction, ticketId, 'DESTINATION_COIN', data, { expectedStep });
      return;
    }
    Object.assign(data, { originAssetId: null, originNetworkAutoSelected: false });
    await this.updateAndRender(interaction, ticketId, 'ORIGIN_NETWORK', data, { expectedStep });
  }

  async choosePopularSwap(interaction, ticket, data, route) {
    const details = this.resolvePopularSwapRoute(route);
    if (!details) {
      throw new UserInputError('That popular swap is temporarily unavailable. Choose the coins and networks manually.');
    }
    const { originDefinition, destinationDefinition, originChoices, originAsset, destinationChoices, destinationAsset } = details;

    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    clearOrigin(data);
    Object.assign(data, {
      originCoin: originDefinition.key,
      originCoinGroup: originDefinition.group,
      originAssetId: originAsset.assetId,
      originNetworkAutoSelected: originChoices.length === 1,
      destinationCoin: destinationDefinition.key,
      destinationCoinGroup: destinationDefinition.group,
      destinationAssetId: destinationAsset.assetId,
      destinationNetworkAutoSelected: destinationChoices.length === 1,
    });
    await this.updateAndRender(interaction, ticket.id, 'USD_AMOUNT', data, { expectedStep: ticket.step });
  }

  async choosePopularBackup(interaction, ticket, data, route) {
    const details = this.resolvePopularSwapRoute(route);
    if (!details) throw new UserInputError('That popular route is temporarily unavailable. Choose the coins and networks manually.');
    const { originDefinition, destinationDefinition, originChoices, originAsset, destinationChoices, destinationAsset } = details;
    clearOrigin(data);
    Object.assign(data, {
      originCoin: originDefinition.key,
      originCoinGroup: originDefinition.group,
      originAssetId: originAsset.assetId,
      originNetworkAutoSelected: originChoices.length === 1,
      destinationCoin: destinationDefinition.key,
      destinationCoinGroup: destinationDefinition.group,
      destinationAssetId: destinationAsset.assetId,
      destinationNetworkAutoSelected: destinationChoices.length === 1,
      backupConsent: true,
    });
    const updated = await this.updateAndRender(interaction, ticket.id, 'USD_AMOUNT', data, { expectedStep: ticket.step });
    if (updated) await this.dismissRouteChoicePrompt(interaction);
  }

  async enablePopularRouteWatch(interaction, ticket, routeAction) {
    const route = getPopularSwap(routeAction);
    if (!route) throw new UserInputError('That popular route is no longer available to watch.');
    const watched = await this.repositories.enableRouteWatch(ticket.id, route.action);
    if (!watched) throw new UserInputError('This ticket moved to another step. Return to popular picks and try again.');
    await interaction.update({
      content: `I’ll watch **${route.label}** and ping you in this ticket when it becomes available. Inactivity reminders and automatic inactivity closure are paused while you wait.`,
      components: [],
      allowedMentions: { parse: [] },
    });
  }

  async dismissRouteChoicePrompt(interaction) {
    if (typeof interaction?.editReply !== 'function') return;
    await interaction.editReply({
      content: 'Backup selected. Continue in the ticket below.',
      components: [],
      allowedMentions: { parse: [] },
    }).catch(() => null);
  }

  resolvePopularSwapRoute(route) {
    const originDefinition = this.coinPolicy.getCoin(route.originCoin);
    const destinationDefinition = this.coinPolicy.getCoin(route.destinationCoin);
    const originChoices = this.coinPolicy.getAssetsForCoin(route.originCoin);
    const originAsset = originChoices.find((asset) => asset.blockchain === route.originBlockchain);
    const destinationChoices = originAsset
      ? this.coinPolicy.getAssetsForCoin(route.destinationCoin, originAsset.assetId)
      : [];
    const destinationAsset = destinationChoices.find((asset) => asset.blockchain === route.destinationBlockchain);
    if (!originDefinition || !destinationDefinition || !originAsset || !destinationAsset) return null;
    return { originDefinition, destinationDefinition, originChoices, originAsset, destinationChoices, destinationAsset };
  }

  async probePopularSwapRoute({ originAsset, destinationAsset }) {
    const probeRecipient = POPULAR_ROUTE_PROBE_ADDRESSES[destinationAsset.blockchain];
    const probeRefundTo = POPULAR_ROUTE_PROBE_ADDRESSES[originAsset.blockchain];
    if (!probeRecipient || !probeRefundTo) {
      throw new AmountValidationError('That popular swap cannot be checked right now.');
    }
    const probeAmountBase = popularRouteProbeAmount(originAsset);
    return this.oneClick.getVerifiedQuote({
      dry: true,
      originAsset,
      destinationAsset,
      amountBase: probeAmountBase,
      recipient: probeRecipient,
      refundTo: probeRefundTo,
    });
  }

  classifyPopularRouteProbeError(error, context = { operation: 'popular_route_probe' }) {
    return error instanceof AmountValidationError
      ? { code: 'POPULAR_ROUTE_PROBE_UNAVAILABLE', userMessage: 'This popular route could not be checked right now.' }
      : this.oneClick.classifyError(error, context);
  }

  async checkWatchedExactRoute(ticket) {
    const data = ticket.state_data ?? {};
    if (data.noRouteOffer !== routeFingerprint(data)) { await this.repositories.cancelRouteWatch(ticket.id); return false; }
    const originAsset = this.catalogue.getAsset(data.originAssetId);
    const destinationAsset = this.catalogue.getAsset(data.destinationAssetId);
    try {
      if (!originAsset || !destinationAsset) throw new Error('Asset unavailable');
      await this.oneClick.getVerifiedQuote({dry:true,originAsset,destinationAsset,amountBase:data.amountBase,recipient:data.recipient,refundTo:data.refundTo});
      const channel = await this.client.channels.fetch(ticket.channel_id);
      if (!channel?.isTextBased()) throw new Error('Channel unavailable');
      const content = '<@' + ticket.user_id + '>, a regular provider has a route for your selected pair and amount. Review a fresh quote before sending funds.';
      const recent = await channel.messages.fetch({limit:100});
      const existing = [...recent.values()].find(message => message.author?.id === this.client.user?.id && message.content === content && message.createdTimestamp >= new Date(ticket.route_watch_created_at).getTime());
      const message = existing ?? await channel.send({content,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('t:' + ticket.id + ':retry-exact').setLabel('Review quote').setStyle(ButtonStyle.Primary))],allowedMentions:{users:[ticket.user_id]}});
      const completed = await this.repositories.completeRouteWatchNotification(ticket.id,ticket.route_watch_claimed_at,message.id);
      if (!completed && !existing) await message.delete().catch(()=>null);
      return Boolean(completed);
    } catch {
      await this.repositories.completeRouteWatchCheck(ticket.id,ticket.route_watch_claimed_at);
      return false;
    }
  }

  async checkWatchedPopularRoute(ticket) {
    if (ticket.route_watch_action === 'exact') return this.checkWatchedExactRoute(ticket);
    const route = getPopularSwap(ticket.route_watch_action);
    if (!route) {
      await this.repositories.cancelRouteWatch(ticket.id);
      return false;
    }
    const details = this.resolvePopularSwapRoute(route);
    if (!details) {
      await this.repositories.completeRouteWatchCheck(ticket.id, ticket.route_watch_claimed_at);
      return false;
    }

    try {
      await this.probePopularSwapRoute(details);
      this.health.oneClickAuthentication = true;
    } catch (error) {
      this.markAuthenticationHealth(error);
      const context = { operation: 'popular_route_watch' };
      const classification = this.classifyPopularRouteProbeError(error, context);
      if (classification.code !== 'NO_LIQUIDITY_ROUTE') {
        this.logger.debug?.({
          ticketId: ticket.id,
          originAssetId: details.originAsset.assetId,
          destinationAssetId: details.destinationAsset.assetId,
          ...(error instanceof AmountValidationError
            ? { errorCode: classification.code }
            : this.oneClick.safeErrorLogFields(error, context)),
        }, 'Watched popular route could not be checked');
      }
      await this.repositories.completeRouteWatchCheck(ticket.id, ticket.route_watch_claimed_at);
      return false;
    }

    const channel = ticket.channel_id
      ? await this.client.channels.fetch(ticket.channel_id).catch(() => null)
      : null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await this.repositories.cancelRouteWatch(ticket.id);
      return false;
    }

    const content = `<@${ticket.user_id}>, **${route.label} is available now.** Click below to continue with that popular route.`;
    try {
      const recent = channel.messages?.fetch
        ? await channel.messages.fetch({ limit: 100 }).catch(() => null)
        : null;
      const existing = recent && [...recent.values()].find((message) => (
        message.author?.id === this.client.user?.id && message.content === content
      ));
      const message = existing ?? await channel.send({
        content,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`t:${ticket.id}:${route.action}`)
            .setLabel('Use this route')
            .setStyle(ButtonStyle.Primary),
        )],
        allowedMentions: { users: [ticket.user_id] },
      });
      const completed = await this.repositories.completeRouteWatchNotification(
        ticket.id,
        ticket.route_watch_claimed_at,
        message.id,
      );
      if (!completed && !existing) await message.delete().catch(() => null);
      if (completed) {
        this.logger.info({ ticketId: ticket.id, routeAction: route.action }, 'Watched popular route became available');
      }
      return Boolean(completed);
    } catch (error) {
      await this.repositories.completeRouteWatchCheck(ticket.id, ticket.route_watch_claimed_at).catch(() => null);
      this.logger.warn({
        ticketId: ticket.id,
        routeAction: route.action,
        errorName: error.name,
        errorCode: 'ROUTE_WATCH_NOTIFICATION_FAILED',
      }, 'Watched popular route notification will be retried');
      return false;
    }
  }

  async chooseDestinationCoin(interaction, ticketId, data, coinKey, expectedGroup, expectedStep) {
    const definition = this.coinPolicy.getCoin(coinKey);
    if (!definition || definition.group !== expectedGroup) throw new UserInputError('That receiving coin is not available.');
    const assets = this.coinPolicy.getAssetsForCoin(definition.key, data.originAssetId);
    if (assets.length === 0) throw new UserInputError('That choice would send an asset to itself. Choose another coin or network.');

    clearDestinationSelection(data);
    Object.assign(data, { destinationCoin: definition.key, destinationCoinGroup: definition.group });
    if (assets.length === 1) {
      Object.assign(data, { destinationAssetId: assets[0].assetId, destinationNetworkAutoSelected: true });
      await this.updateAndRender(interaction, ticketId, 'USD_AMOUNT', data, { expectedStep });
      return;
    }
    Object.assign(data, { destinationAssetId: null, destinationNetworkAutoSelected: false });
    await this.updateAndRender(interaction, ticketId, 'DESTINATION_NETWORK', data, { expectedStep });
  }

  async updateAndRender(interaction, ticketId, step, data, { append = true, expectedStep = null } = {}) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const updated = expectedStep
      ? await this.repositories.updateTicketFlowIfStep(ticketId, expectedStep, step, data)
      : await this.repositories.updateTicketFlow(ticketId, step, data);
    if (!updated) {
      await this.privateReply(interaction, 'That control is no longer current. Use the controls in the latest message.');
      return null;
    }
    await this.renderProgress(ticketId, { append });
    return updated;
  }

  async renderProgress(ticketId, { append = false } = {}) {
    let ticket = await this.repositories.getTicket(ticketId);
    if (!ticket?.channel_id) return;
    ticket = await this.withRememberedAddress(ticket);
    const swap = await this.repositories.getSwapByTicket(ticketId);
    const payload = renderTicket(ticket, this.catalogue, swap, this.config, this.coinPolicy, this.emojis);
    if (append) await this.appendProgress(ticket, payload);
    else await this.editProgress(ticketId, payload);
    await this.syncDepositSpeedupMessage(ticket, swap).catch((error) => {
      this.logger.warn({ ticketId, errorName: error.name, operation: 'deposit_speedup_message' }, 'Deposit speedup message could not be synchronized');
    });
  }

  async withRememberedAddress(ticket) {
    const data = { ...(ticket.state_data ?? {}) };
    let blockchain = null;
    let key = null;
    if (ticket.step === 'RECIPIENT_ADDRESS') {
      blockchain = this.catalogue.getAsset(data.destinationAssetId)?.blockchain;
      key = 'rememberedRecipientAddress';
    } else if (ticket.step === 'REFUND_ADDRESS') {
      blockchain = this.catalogue.getAsset(data.originAssetId)?.blockchain;
      key = 'rememberedRefundAddress';
    }
    if (!blockchain || !key) return ticket;
    if (data[key]) return ticket;
    const rememberedAddress = await this.repositories.getUserChainAddress(ticket.guild_id, ticket.user_id, blockchain);
    setRememberedAddress(data, key, rememberedAddress);
    return { ...ticket, state_data: data };
  }

  async reconcileOpenTickets() {
    const tickets = await this.repositories.listOpenTickets();
    let reconciled = 0;
    for (const ticket of tickets) {
      try {
        if (this.guildConfigs.size > 0 && !this.guildConfigs.has(ticket.guild_id)) continue;
        if (!ticket.channel_id) continue;
        await this.ensureTicketHeader(ticket);
        await this.removeLegacyTicketFooters(ticket);
        if (ticket.step === 'TERMINAL' && ticket.delete_at) await this.makeTerminalTicketActionable(ticket);
        if (!ticket.progress_message_id) continue;
        const swap = await this.repositories.getSwapByTicket(ticket.id);
        if (
          ticket.step === 'PREVIEW'
          && swap?.status === 'PREVIEW'
          && !swap.executable_quote
          && Number(swap.slippage_bps) !== this.config.slippageBps
        ) {
          const data = { ...(ticket.state_data ?? {}) };
          await this.repositories.updateTicketFlowIfStep(ticket.id, 'PREVIEW', 'QUOTE_LOADING', data);
          await this.renderProgress(ticket.id);
          await this.createPreviewFromChat(ticket.id, data, null);
        }
        await this.renderProgress(ticket.id);
        await this.ensureDepositQr(ticket.id);
        reconciled += 1;
      } catch (error) {
        this.logger.warn({ ticketId: ticket.id, ...this.oneClick.safeErrorLogFields(error, { operation: 'ticket_reconciliation' }) }, 'Open ticket could not be rerendered');
      }
    }
    this.logger.info({ reconciledTicketCount: reconciled }, 'Open Discord tickets reconciled');
  }

  async ensureTicketHeader(ticket) {
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const payload = {
      content: `<@${ticket.user_id}>`,
      ...ticketHeaderPayload(ticket.id),
      allowedMentions: { users: [ticket.user_id] },
    };
    if (ticket.header_message_id) {
      const existing = await channel.messages.fetch(ticket.header_message_id).catch(() => null);
      if (existing) {
        await existing.edit({ ...payload, attachments: [] });
        return;
      }
    }

    const messages = await channel.messages.fetch({ after: '0', limit: 100 }).catch(() => null);
    const candidate = messages
      ? [...messages.values()]
        .filter((message) => message.author?.id === this.client.user.id && message.id !== ticket.progress_message_id)
        .sort((left, right) => left.createdTimestamp - right.createdTimestamp)[0]
      : null;
    const header = candidate ?? await channel.send(payload);
    if (candidate) await candidate.edit({ ...payload, attachments: [] });
    await this.repositories.setHeaderMessage(ticket.id, header.id);
  }

  async removeLegacyTicketFooters(ticket) {
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    let before;
    for (let page = 0; page < 10; page += 1) {
      const options = before ? { limit: 100, before } : { limit: 100 };
      const messages = await channel.messages.fetch(options).catch(() => null);
      if (!messages) return;
      for (const message of messages.values()) {
        if (message.author?.id !== this.client.user.id) continue;
        const embeds = message.embeds?.map((embed) => embed.toJSON()) ?? [];
        let changed = false;
        for (const embed of embeds) {
          if (embed.footer?.text?.startsWith(`Ticket ${ticket.id}`)) {
            delete embed.footer;
            changed = true;
          }
        }
        if (changed) await message.edit({ embeds, allowedMentions: { parse: [] } }).catch(() => null);
      }
      if (messages.size < 100) return;
      const oldest = [...messages.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp)[0];
      if (!oldest || oldest.id === before) return;
      before = oldest.id;
    }
  }

  async editProgress(ticketId, payload) {
    const ticket = await this.repositories.getTicket(ticketId);
    if (!ticket?.channel_id) return;
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const message = ticket.progress_message_id
      ? await channel.messages.fetch(ticket.progress_message_id).catch(() => null)
      : null;
    if (message) {
      await message.edit(progressEditPayload(payload));
      return;
    }
    const replacement = await channel.send({ ...payload, allowedMentions: { parse: [] } });
    await this.repositories.setProgressMessage(ticketId, replacement.id);
  }

  async appendProgress(ticket, payload) {
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const previous = ticket.progress_message_id
      ? await channel.messages.fetch(ticket.progress_message_id).catch(() => null)
      : null;
    if (previous) {
      const previousComponents = previous.flags?.has?.(MessageFlags.IsComponentsV2)
        ? disableInteractiveComponents(previous.components)
        : [];
      await previous.edit({ components: previousComponents, allowedMentions: { parse: [] } });
    }

    let nextMessage;
    try {
      nextMessage = await channel.send({ ...payload, allowedMentions: { parse: [] } });
      await this.repositories.setProgressMessage(ticket.id, nextMessage.id);
    } catch (error) {
      if (nextMessage) await nextMessage.delete().catch(() => null);
      if (previous) await previous.edit(progressEditPayload(payload)).catch(() => null);
      throw error;
    }
  }

  async scheduleClosure(ticketId, reason) {
    const deleteAt = new Date(Date.now() + this.config.channelDeleteDelayMs);
    const ticket = await this.repositories.scheduleTicketClosure(ticketId, deleteAt, 'MANUAL');
    if (!ticket?.channel_id) return;
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    if (ticket.header_message_id) {
      const header = await channel.messages.fetch(ticket.header_message_id).catch(() => null);
      if (header) await header.edit({ components: [], allowedMentions: { parse: [] } }).catch(() => null);
    }
    await channel.permissionOverwrites.edit(ticket.user_id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
    }, { reason }).catch(() => null);
    const unix = Math.floor(deleteAt.getTime() / 1000);
    await this.editProgress(ticket.id, {
      content: '',
      attachments: [],
      embeds: [{
        color: 0x808080,
        title: 'Ticket closed',
        description: `${reason}. This channel is locked and will be deleted <t:${unix}:R>. Closing never cancels an executable swap.`,
      }],
      components: [],
    });
  }

  async scheduleTerminalDeletion(ticketId, reason, closureReason = 'TERMINAL') {
    const deleteAt = new Date(Date.now() + this.config.channelDeleteDelayMs);
    const ticket = await this.repositories.scheduleTerminalTicketDeletion(ticketId, deleteAt, closureReason);
    if (!ticket) return null;
    await this.makeTerminalTicketActionable(ticket);
    this.logger.info({ ticketId, deleteAt, reason }, 'Terminal ticket scheduled for automatic deletion');
    return ticket;
  }

  async makeTerminalTicketActionable(ticket) {
    if (!ticket?.channel_id) return;
    const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    await channel.permissionOverwrites.edit(ticket.user_id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
    }, { reason: 'Terminal swap grace period' }).catch(() => null);
  }

  async deleteTicketImmediately(ticketId, reason) {
    const ticket = await this.repositories.getTicket(ticketId);
    if (!ticket) return;
    if (ticket.channel_id) {
      const channel = await this.client.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel && channel.type === ChannelType.GuildText) {
        await this.archiveFinalTicketTranscript(ticket, channel);
        await channel.delete(reason);
      }
    }
    await this.repositories.markTicketDeleted(ticketId);
    this.logger.info({ ticketId }, 'Private ticket channel deleted immediately by owner');
  }

  async archiveFinalTicketTranscript(ticket, channel) {
    if (ticket.closure_reason === 'INACTIVITY') return false;
    const transcriptChannels = await this.getTranscriptArchiveChannels(ticket.guild_id);
    if (transcriptChannels.length === 0) {
      this.logger.error?.({ ticketId: ticket.id, guildId: ticket.guild_id, errorCode: 'TRANSCRIPT_CHANNEL_UNAVAILABLE' }, 'Ticket transcript channel is unavailable; deletion will continue');
      return false;
    }
    try {
      const claimed = await this.repositories.claimTicketTranscript(
        ticket.id,
        new Date(Date.now() - 5 * 60_000),
      );
      if (!claimed) return false;
      const swap = await this.repositories.getSwapByTicket(ticket.id);
      if (!swap?.executable_quote || !['SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE'].includes(swap.status)) {
        await this.repositories.releaseTicketTranscript(ticket.id);
        return false;
      }
      const messages = await fetchAllChannelMessages(channel);
      const files = buildTranscriptFiles({ ticket: claimed, swap, messages });
      const content = `Archived final swap ticket ${ticket.id} (${swap.status}).`;
      const archives = [];
      for (const transcriptChannel of transcriptChannels) {
        const recent = transcriptChannel.messages?.fetch
          ? await transcriptChannel.messages.fetch({ limit: 100 }).catch(() => null)
          : null;
        const existing = recent && [...recent.values()].find((message) => (
          message.author?.id === this.client.user?.id && message.content === content
        ));
        const archive = existing ?? await transcriptChannel.send({
          content,
          files,
          allowedMentions: { parse: [] },
        });
        archives.push(archive);
      }
      await this.repositories.completeTicketTranscript(ticket.id, archives[0].id);
      this.logger.info({
        ticketId: ticket.id,
        transcriptMessageIds: archives.map((archive) => archive.id),
      }, 'Final swap ticket transcript archived');
      return true;
    } catch (error) {
      await this.repositories.releaseTicketTranscript(ticket.id).catch(() => null);
      this.logger.error({ ticketId: ticket.id, errorName: error.name, errorCode: 'TRANSCRIPT_ARCHIVE_FAILED' }, 'Ticket transcript upload failed; deletion will continue');
      return false;
    }
  }

  async notifyInactivityClosure(ticket) {
    try {
      const user = await this.client.users.fetch(ticket.user_id);
      const inactivityMinutes = Math.round(this.config.ticketInactivityMs / 60_000);
      await user.send(`Your swap ticket was closed after ${inactivityMinutes} minutes of inactivity. No executable swap or deposit instructions were created. You can open a new ticket from the swap panel at any time.`);
    } catch (error) {
      this.logger.warn({ ticketId: ticket.id, userId: ticket.user_id, errorName: error.name, errorCode: 'INACTIVITY_DM_FAILED' }, 'Could not send inactivity closure DM');
    }
  }

  async notifyPayoutSent(swap, statusResponse) {
    const claimed = await this.repositories.claimPayoutSentNotification(
      swap.id,
      new Date(Date.now() - 5 * 60_000),
    );
    if (!claimed || claimed.ticket_state !== 'OPEN' || !claimed.channel_id) return false;

    try {
      const channel = await this.client.channels.fetch(claimed.channel_id);
      if (!channel || channel.type !== ChannelType.GuildText) return false;
      const closesAtBroadcast = claimed.payout_detected_provider === 'blockcypher';
      const recent = channel.messages?.fetch
        ? await channel.messages.fetch({ limit: 100 }).catch(() => null)
        : null;
      const existing = recent && [...recent.values()].find((message) => (
        message.author?.id === this.client.user?.id
        && message.embeds?.some((embed) => embed.title === (closesAtBroadcast ? 'Swap completed' : 'Payout sent'))
      ));
      let deleteAt = null;
      if (closesAtBroadcast) {
        deleteAt = claimed.delete_at
          ? new Date(claimed.delete_at)
          : deletionTimeFromMessage(existing) ?? new Date(Date.now() + this.config.channelDeleteDelayMs);
      }

      const message = existing ?? await channel.send(
        closesAtBroadcast
          ? payoutClosingPayload(
              claimed.user_id,
              claimed,
              statusResponse ?? claimed.last_status_response,
              this.catalogue,
              claimed.ticket_id,
              deleteAt,
            )
          : payoutSentPayload(
              claimed.user_id,
              claimed,
              statusResponse ?? claimed.last_status_response,
              this.catalogue,
            ),
      );
      if (closesAtBroadcast) {
        const ticket = await this.repositories.scheduleTerminalTicketDeletion(
          claimed.ticket_id,
          deleteAt,
          'PAYOUT_BROADCAST',
        );
        if (ticket) {
          await this.makeTerminalTicketActionable(ticket);
          this.logger.info({ ticketId: ticket.id, deleteAt }, 'Broadcast-detected payout ticket scheduled for automatic deletion');
        }
      }
      await this.repositories.completePayoutSentNotification(swap.id, message.id);
      try {
        await this.notifyCompletionVouch(claimed);
      } catch (error) {
        this.logger.warn({
          swapId: swap.id,
          ticketId: claimed.ticket_id,
          errorName: error.name,
          errorCode: 'EARLY_COMPLETION_VOUCH_DM_FAILED',
        }, 'Could not process the early completion vouch DM; it will be retried');
      }
      return true;
    } catch (error) {
      this.logger.warn({
        swapId: swap.id,
        ticketId: claimed.ticket_id,
        errorName: error.name,
        errorCode: 'PAYOUT_SENT_NOTIFICATION_FAILED',
      }, 'Could not send payout notification; it will be retried');
      return false;
    }
  }

  async getTranscriptChannel(guildId = null) {
    if (guildId && this.transcriptChannels.has(guildId)) return this.transcriptChannels.get(guildId);
    if (!guildId && this.transcriptChannel) return this.transcriptChannel;
    const guildConfig = guildId ? this.guildConfigs.get(guildId) : configuredGuilds(this.config)[0];
    if (!guildConfig?.transcriptChannelId) return null;
    const channel = await this.client.channels.fetch(guildConfig.transcriptChannelId).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return null;
    this.transcriptChannels.set(guildConfig.guildId, channel);
    if (!this.transcriptChannel) this.transcriptChannel = channel;
    return channel;
  }

  async getTranscriptArchiveChannels(guildId) {
    const local = await this.getTranscriptChannel(guildId).catch(() => null);
    const central = await this.getCentralTranscriptChannel().catch((error) => {
      this.logger.error?.({
        guildId,
        errorName: error.name,
        errorCode: 'CENTRAL_TRANSCRIPT_CHANNEL_UNAVAILABLE',
      }, 'Central ticket transcript channel is unavailable');
      return null;
    });
    return [...new Map([local, central].filter(Boolean).map((channel) => [channel.id, channel])).values()];
  }

  async getCentralTranscriptChannel() {
    if (!this.config.centralTranscriptChannelId) return null;
    if (this.centralTranscriptChannel) return this.centralTranscriptChannel;
    await this.initializeCentralTranscriptChannel();
    return this.centralTranscriptChannel;
  }

  async notifyCompletionVouch(swap) {
    const completedOrPayoutDetected = swap?.status === 'SUCCESS' || Boolean(swap?.payout_detected_at);
    if (!completedOrPayoutDetected || !swap.executable_quote) return false;
    const requestedGuildConfig = swap.guild_id ? this.guildConfigs.get(swap.guild_id) : null;
    if (swap.guild_id && !requestedGuildConfig?.vouchChannelId) return false;

    const claimed = await this.repositories.claimCompletionVouchDm(
      swap.id,
      new Date(Date.now() - 5 * 60_000),
    );
    if (!claimed) return false;
    const guildConfig = claimed.guild_id ? this.guildConfigs.get(claimed.guild_id) : requestedGuildConfig;
    const channelId = guildConfig?.vouchChannelId ?? (!claimed.guild_id ? this.config.vouchChannelId : null);
    if (!channelId) {
      await this.repositories.releaseCompletionVouchDm(swap.id).catch(() => null);
      return false;
    }

    try {
      const user = await this.client.users.fetch(claimed.user_id);
      await user.send(`Your swap is complete! If you were happy with the service, please leave a vouch in <#${channelId}>`);
      await this.repositories.completeCompletionVouchDm(swap.id);
      return true;
    } catch (error) {
      if (Number(error?.code) === 50007) {
        await this.repositories.failCompletionVouchDm(swap.id).catch(() => null);
      }
      this.logger.warn({
        swapId: swap.id,
        userId: claimed.user_id,
        errorName: error.name,
        errorCode: 'COMPLETION_VOUCH_DM_FAILED',
      }, 'Could not send completion vouch DM');
      return false;
    }
  }

  getVouchGuildIds() {
    return [...this.guildConfigs.values()]
      .filter((guild) => Boolean(guild.vouchChannelId))
      .map((guild) => guild.guildId);
  }

  async privateReply(interaction, response) {
    const payload = typeof response === 'string' ? { content: response } : response;
    const reply = { ...payload, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(reply).catch(() => null);
    } else {
      await interaction.reply(reply).catch(() => null);
    }
  }

  markAuthenticationHealth(error) {
    if (error?.status === 401 && !['ChangeNowError', 'ChangellyError', 'FixedFloatError', 'RelayError'].includes(error?.name)) this.health.oneClickAuthentication = false;
  }
}

function parseComponentId(value) {
  const parts = value.split(':');
  if (parts.length < 3 || parts[0] !== 't') return null;
  return { ticketId: parts[1], action: parts[2], argument: parts[3] ?? null };
}

export function previousVisibleStep(currentStep, data, coinPolicy) {
  if (currentStep === 'ORIGIN_OTHER') return 'ORIGIN_COIN';
  if (currentStep === 'ORIGIN_NETWORK') return data.originCoinGroup === 'other' ? 'ORIGIN_OTHER' : 'ORIGIN_COIN';
  if (currentStep === 'DESTINATION_COIN') {
    const originChoices = coinPolicy.getAssetsForCoin(data.originCoin);
    if (originChoices.length > 1) return 'ORIGIN_NETWORK';
    return data.originCoinGroup === 'other' ? 'ORIGIN_OTHER' : 'ORIGIN_COIN';
  }
  if (currentStep === 'DESTINATION_OTHER') return 'DESTINATION_COIN';
  if (currentStep === 'DESTINATION_NETWORK') return data.destinationCoinGroup === 'other' ? 'DESTINATION_OTHER' : 'DESTINATION_COIN';
  if (currentStep === 'USD_AMOUNT') {
    const destinationChoices = coinPolicy.getAssetsForCoin(data.destinationCoin, data.originAssetId);
    if (destinationChoices.length > 1) return 'DESTINATION_NETWORK';
    return data.destinationCoinGroup === 'other' ? 'DESTINATION_OTHER' : 'DESTINATION_COIN';
  }
  if (currentStep === 'RECIPIENT_ADDRESS') return 'USD_AMOUNT';
  if (currentStep === 'REFUND_ADDRESS') return 'RECIPIENT_ADDRESS';
  if (currentStep === 'QUOTE_LOADING') return 'REFUND_ADDRESS';
  if (currentStep === 'PREVIEW') return 'REFUND_ADDRESS';
  return null;
}

function clearOrigin(data) {
  for (const key of [
    'originCoin', 'originCoinGroup', 'originAssetId', 'originNetworkAutoSelected',
    'originChain', 'originChainPage', 'originAssetPage',
  ]) delete data[key];
  clearDestination(data);
}

function clearDestination(data) {
  clearDestinationSelection(data);
  for (const key of ['destinationChain', 'destinationChainPage', 'destinationAssetPage']) delete data[key];
}

function clearDestinationSelection(data) {
  for (const key of ['destinationCoin', 'destinationCoinGroup', 'destinationAssetId', 'destinationNetworkAutoSelected']) delete data[key];
  clearSwapDetails(data);
}

function clearSwapDetails(data) {
  for (const key of [
    'backupConsent', 'noRouteOffer',
    'amountDisplay', 'amountBase', 'amountUsdRequested', 'conversionPriceUsd', 'conversionPriceAt',
    'recipient', 'refundTo', 'rememberedRecipientAddress', 'rememberedRefundAddress',
  ]) delete data[key];
}

function quoteRecoveryStep(errorCode) {
  if (['AMOUNT_TOO_LOW', 'AMOUNT_TOO_HIGH', 'NO_LIQUIDITY_ROUTE'].includes(errorCode)) return 'USD_AMOUNT';
  if (errorCode === 'INVALID_RECIPIENT_ADDRESS') return 'RECIPIENT_ADDRESS';
  return 'REFUND_ADDRESS';
}

function quoteFailureMessage(classification, originAsset, destinationAsset, coinPolicy) {
  if (classification.code !== 'NO_LIQUIDITY_ROUTE' || !originAsset || !destinationAsset) {
    return classification.userMessage;
  }
  const origin = compactRouteAsset(originAsset, coinPolicy);
  const destination = compactRouteAsset(destinationAsset, coinPolicy);
  return `No solvers are available for ${origin} → ${destination} right now. If you'd like, you can use our backup provider.`;
}

function quoteFailurePayload(
  ticketId,
  classification,
  originAsset,
  destinationAsset,
  coinPolicy,
  { backupSelected = false, backupAvailable = false, backupQuote = null } = {},
) {
  let content = quoteFailureMessage(classification, originAsset, destinationAsset, coinPolicy);
  if (backupSelected && classification.code === 'NO_LIQUIDITY_ROUTE') {
    content = 'The backup provider is unavailable for this route right now. Try a different amount or choose another route.';
  } else if (backupAvailable && classification.code === 'AMOUNT_TOO_LOW' && originAsset && destinationAsset) {
    const minimum = classification.routeLimit?.kind === 'minimum'
      ? ` Current route minimum: ${classification.routeLimit.display}.`
      : '';
    content = `The amount is below the minimum available for this route.${minimum} If you'd like, you can use our backup provider for this transaction.`;
  } else if (!backupAvailable && classification.code === 'NO_LIQUIDITY_ROUTE' && originAsset && destinationAsset) {
    const origin = compactRouteAsset(originAsset, coinPolicy);
    const destination = compactRouteAsset(destinationAsset, coinPolicy);
    content = `No solvers are available for ${origin} → ${destination} right now. You can ask to be notified when the route becomes available.`;
  }
  const offerChoice = classification.code === 'NO_LIQUIDITY_ROUTE' || backupAvailable;
  if (backupSelected || !offerChoice || !originAsset || !destinationAsset) return { content };
  const buttons = [];
  if (backupAvailable) {
    buttons.push(new ButtonBuilder().setCustomId(`t:${ticketId}:use-backup`).setLabel(`Use backup · ${fixedFloatOfferQuote(backupQuote)} quote`).setStyle(ButtonStyle.Primary));
  }
  buttons.push(new ButtonBuilder().setCustomId(`t:${ticketId}:watch-exact`).setLabel('Notify me when available').setStyle(ButtonStyle.Secondary));
  return {
    content,
    components: [new ActionRowBuilder().addComponents(buttons)],
  };
}

function fixedFloatOfferQuote(quote) {
  return quotedRouteCostPercentDisplay(quote);
}

function popularRouteProbeAmount(originAsset) {
  let amountBase = usdToBaseUnits(POPULAR_ROUTE_PROBE_USD, String(originAsset.price), originAsset.decimals);
  if (isStablecoin(originAsset)) {
    amountBase = roundBaseUnitsUpToPrecision(amountBase, originAsset.decimals, Math.min(6, originAsset.decimals));
  }
  return amountBase;
}

function alternativeBridgeAssets(originAsset, destinationAsset, coinPolicy) {
  const alternateStablecoin = String(destinationAsset.symbol).toUpperCase() === 'USDT'
    ? 'USDC'
    : String(destinationAsset.symbol).toUpperCase() === 'USDC' ? 'USDT' : null;
  const coinOrder = [...new Set([alternateStablecoin, ...ROUTE_BRIDGE_COINS].filter(Boolean))];
  const seen = new Set();
  const candidates = [];
  for (const coin of coinOrder) {
    const assets = coinPolicy?.getAssetsForCoin?.(coin);
    if (!Array.isArray(assets)) continue;
    const ordered = [...assets]
      .filter((asset) => (
        asset?.assetId
        && asset.assetId !== originAsset.assetId
        && asset.assetId !== destinationAsset.assetId
        && [originAsset.blockchain, destinationAsset.blockchain].includes(asset.blockchain)
      ))
      .sort((left, right) => bridgeChainPriority(left, destinationAsset, originAsset)
        - bridgeChainPriority(right, destinationAsset, originAsset));
    for (const asset of ordered) {
      if (seen.has(asset.assetId)) continue;
      seen.add(asset.assetId);
      candidates.push(asset);
      if (candidates.length >= MAX_ALTERNATIVE_ROUTE_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

function bridgeChainPriority(asset, destinationAsset, originAsset) {
  if (asset.blockchain === destinationAsset.blockchain) return 0;
  if (asset.blockchain === originAsset.blockchain) return 1;
  return 2;
}

function alternativeRoutesMessage(result, originAsset, destinationAsset, coinPolicy) {
  if (result.routes.length === 0) {
    return result.hadOperationalErrors
      ? 'I could not finish checking alternative routes right now. Try again in a moment.'
      : 'No verified two-step routes are available right now. Try another network or check again later.';
  }
  const origin = compactRouteAsset(originAsset, coinPolicy);
  const destination = compactRouteAsset(destinationAsset, coinPolicy);
  const destinationSymbol = safeAssetSymbol(destinationAsset);
  const routes = result.routes.map(({ bridgeAsset, secondQuote }) => {
    const bridge = compactRouteAsset(bridgeAsset, coinPolicy);
    const estimate = safeFormattedAmount(secondQuote?.quote?.amountOutFormatted);
    return `- **${origin} → ${bridge} → ${destination}**${estimate ? ` (~${estimate} ${destinationSymbol})` : ''}`;
  });
  const heading = routes.length === 1 ? 'Verified alternative available now:' : 'Verified alternatives available now:';
  return `${heading}\n${routes.join('\n')}\n\nComplete each route as two separate swaps. Use a self-custody wallet you control for the intermediate asset. Availability and amounts will be refreshed before each deposit.`;
}

function positiveAtomicAmount(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text) > 0n ? text : null;
  } catch {
    return null;
  }
}

function safeFormattedAmount(value) {
  const text = String(value ?? '').trim();
  return /^\d+(?:\.\d+)?$/.test(text) && text.length <= 80 ? text : null;
}

function safeAssetSymbol(asset) {
  return String(asset?.symbol ?? 'asset').toUpperCase().replace(/[^A-Z0-9._-]/g, '').slice(0, 20) || 'asset';
}

function compactRouteAsset(asset, coinPolicy) {
  const symbol = safeAssetSymbol(asset);
  const networkCount = coinPolicy?.getAssetsForCoin?.(symbol)?.length ?? 0;
  if (networkCount <= 1 && !['USDT', 'USDC'].includes(symbol)) return symbol;
  const network = String(networkLabel(asset?.blockchain)).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40);
  return `${symbol} on ${network}`;
}

function activeTicketLimitMessage(tickets) {
  const channels = tickets.map((ticket) => ticket?.channel_id).filter(Boolean).slice(0, MAX_ACTIVE_TICKETS_PER_USER);
  const references = channels.length > 0 ? ` ${channels.map((channelId) => `<#${channelId}>`).join(' ')}` : '';
  return `You can have up to ${MAX_ACTIVE_TICKETS_PER_USER} active swap tickets.${references} Close one before opening another.`;
}

function ticketChannelName(username, ticketId) {
  const safe = username.normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'member';
  return `swap-${safe}-${ticketId.slice(0, 8)}`;
}

function cleanAddress(value) {
  const result = value.trim();
  if (result.length < 3 || result.length > 200 || containsWhitespaceOrControl(result)) {
    throw new UserInputError('Wallet addresses must be 3–200 characters and cannot contain whitespace.');
  }
  return result;
}

function isAddressReuseAnswer(value) {
  return value.trim().toLowerCase() === 'yes';
}

function isStablecoin(asset) {
  return ['USDT', 'USDC'].includes(String(asset?.symbol ?? '').toUpperCase());
}

function setRememberedAddress(data, key, address) {
  if (address) data[key] = address;
  else delete data[key];
}

function parseTransactionId(value) {
  const result = value.trim();
  if (
    result.length < 32
    || result.length > 180
    || containsWhitespaceOrControl(result)
    || !/^[A-Za-z0-9:+/=_-]+$/.test(result)
  ) {
    return null;
  }
  return result;
}

function loadingPayload(message) {
  return {
    content: '',
    embeds: [{ color: 0x5865f2, title: 'Please wait', description: message }],
    components: [],
  };
}

class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserInputError';
  }
}

function containsWhitespaceOrControl(value) {
  return [...value].some((character) => /\s/u.test(character) || character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

function deletionTimeFromMessage(message) {
  const match = /<t:(\d{10,}):[A-Za-z]>/.exec(message?.content ?? '');
  return match ? new Date(Number(match[1]) * 1000) : null;
}

function disableInteractiveComponents(components) {
  return (components ?? []).map((component) => {
    const data = component?.toJSON?.() ?? JSON.parse(JSON.stringify(component));
    if (Array.isArray(data?.components)) data.components = disableInteractiveComponents(data.components);
    if ([2, 3, 5, 6, 7, 8].includes(data?.type)) data.disabled = true;
    return data;
  });
}

function progressEditPayload(payload) {
  const normalized = payload.flags === MessageFlags.IsComponentsV2
    ? { content: null, embeds: [], attachments: [], ...payload }
    : payload;
  return { ...normalized, allowedMentions: { parse: [] } };
}

const DEPOSIT_SPEEDUP_TITLES = new Set([
  '⚡ Speed up deposit detection (optional)',
  '✅ Transaction ID submitted',
  '✅ Transaction ID no longer needed',
]);

function completionSummaryIsCurrent(message, desiredEmbed, desiredComponents) {
  const current = message.embeds?.[0]?.toJSON?.() ?? {};
  const desired = desiredEmbed.toJSON();
  const currentUrl = message.components?.[0]?.components?.[0]?.url ?? null;
  const desiredUrl = desiredComponents?.[0]?.toJSON?.().components?.[0]?.url ?? null;
  return current.title === desired.title
    && current.description === desired.description
    && current.footer?.text === desired.footer?.text
    && current.thumbnail?.url?.includes('deal-history.gif')
    && currentUrl === desiredUrl;
}

function isSwapPanelMessage(message, botUserId) {
  if (!message || message.author?.id !== botUserId) return false;
  const ids = (message.components ?? [])
    .flatMap((row) => row.components ?? [])
    .map((component) => component.customId ?? component.custom_id)
    .filter(Boolean);
  const isLegacyPanel = ids.length === 1 && ids[0] === 'panel:start';
  const isCurrentPanel = ids.length === 2
    && ids.includes('panel:start')
    && ids.includes('panel:supported-coins');
  return isLegacyPanel || isCurrentPanel;
}

function completionAttribution(userId) {
  const value = String(userId ?? '');
  return /^\d{17,20}$/.test(value) ? `Exchanged by <@${value}>` : null;
}

function configuredGuilds(config) {
  if (Array.isArray(config?.guilds) && config.guilds.length > 0) return config.guilds;
  if (!config?.guildId) return [];
  return [{
    guildId: config.guildId,
    panelChannelId: config.panelChannelId,
    ticketCategoryId: config.ticketCategoryId,
    completedDealsChannelId: config.completedDealsChannelId,
    transcriptChannelId: config.transcriptChannelId,
    vouchChannelId: config.vouchChannelId ?? null,
  }];
}

function routeFingerprint(data) { return JSON.stringify([data.originAssetId,data.destinationAssetId,data.amountBase,data.recipient,data.refundTo]); }

function parseTokenAmount(content, symbol) {
  return String(content).trim().replace(/^(?:\$)\s*/, '').replace(new RegExp('\\s*(?:' + symbol + '|USD|\\$)$', 'i'), '').trim();
}
