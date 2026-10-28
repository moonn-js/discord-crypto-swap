import { ChannelType, MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { LifecycleWorker } from '../src/jobs/lifecycle-worker.js';
import { TicketService } from '../src/services/ticket-service.js';

const guildConfigs = [
  guildConfig('111111111111111111'),
  guildConfig('222222222222222222', '222222222222222227'),
];

describe('multi-guild bot runtime', () => {
  it('reconciles and validates every configured guild independently', async () => {
    const first = guildRuntime(guildConfigs[0]);
    const second = guildRuntime(guildConfigs[1]);
    const repositories = {
      getPanel: vi.fn(async (guildId) => ({
        channel_id: `${guildId}-panel`,
        message_id: `${guildId}-panel-message`,
      })),
      savePanel: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ runtimes: [first, second], repositories });

    await service.initializeCompletionChannel();
    await service.initializeTranscriptChannel();
    await service.initializePanel();

    expect(first.panelMessage.edit).toHaveBeenCalledOnce();
    expect(second.panelMessage.edit).toHaveBeenCalledOnce();
    expect(repositories.savePanel).toHaveBeenCalledWith(
      guildConfigs[0].guildId,
      guildConfigs[0].panelChannelId,
      first.panelMessage.id,
    );
    expect(repositories.savePanel).toHaveBeenCalledWith(
      guildConfigs[1].guildId,
      guildConfigs[1].panelChannelId,
      second.panelMessage.id,
    );
    expect(service.completionChannels.get(guildConfigs[0].guildId)).toBe(first.completionChannel);
    expect(service.completionChannels.get(guildConfigs[1].guildId)).toBe(second.completionChannel);
    expect(service.transcriptChannels.get(guildConfigs[0].guildId)).toBe(first.transcriptChannel);
    expect(service.transcriptChannels.get(guildConfigs[1].guildId)).toBe(second.transcriptChannel);
  });

  it('keeps other guilds available when one guild setup contains stale channels', async () => {
    const first = guildRuntime(guildConfigs[0]);
    const second = guildRuntime(guildConfigs[1]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const repositories = {
      getPanel: vi.fn().mockResolvedValue(null),
      savePanel: vi.fn().mockResolvedValue(undefined),
    };
    second.guild.channels.fetch.mockResolvedValue(null);
    const service = makeService({ runtimes: [first, second], repositories, logger });
    service.client.channels.fetch.mockImplementation(async (channelId) => {
      if (channelId === guildConfigs[1].transcriptChannelId) return null;
      if (channelId === guildConfigs[0].transcriptChannelId) return first.transcriptChannel;
      return null;
    });

    await expect(service.initializeCompletionChannel()).resolves.toBeUndefined();
    await expect(service.initializeTranscriptChannel()).resolves.toBeUndefined();
    await expect(service.initializePanel()).resolves.toBeUndefined();

    expect(service.completionChannels.get(guildConfigs[0].guildId)).toBe(first.completionChannel);
    expect(service.completionChannels.has(guildConfigs[1].guildId)).toBe(false);
    expect(service.transcriptChannels.get(guildConfigs[0].guildId)).toBe(first.transcriptChannel);
    expect(service.transcriptChannels.has(guildConfigs[1].guildId)).toBe(false);
    expect(first.panelMessage.edit).toHaveBeenCalledOnce();
    expect(second.panelMessage.edit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      guildId: guildConfigs[1].guildId,
      completedDealsChannelId: guildConfigs[1].completedDealsChannelId,
    }), 'Completed-deals channel could not be initialized');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      guildId: guildConfigs[1].guildId,
      transcriptChannelId: guildConfigs[1].transcriptChannelId,
    }), 'Ticket transcript channel could not be initialized');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      guildId: guildConfigs[1].guildId,
      panelChannelId: guildConfigs[1].panelChannelId,
      ticketCategoryId: guildConfigs[1].ticketCategoryId,
    }), 'Swap panel could not be initialized');
  });

  it('allows multiple guilds to archive transcripts in one shared channel', async () => {
    const sharedGuildConfig = {
      ...guildConfigs[1],
      transcriptChannelId: guildConfigs[0].transcriptChannelId,
    };
    const first = guildRuntime(guildConfigs[0]);
    const second = guildRuntime(sharedGuildConfig);
    const service = makeService({
      runtimes: [first, second],
      guildConfigurations: [guildConfigs[0], sharedGuildConfig],
    });

    await service.initializeTranscriptChannel();

    expect(service.transcriptChannels.get(guildConfigs[0].guildId)).toBe(first.transcriptChannel);
    expect(service.transcriptChannels.get(sharedGuildConfig.guildId)).toBe(first.transcriptChannel);
  });

  it('publishes completed deals and vouch DMs using the ticket guild configuration', async () => {
    const firstChannel = completionChannel('first-summary');
    const secondChannel = completionChannel('second-summary');
    const sendDm = vi.fn().mockResolvedValue(undefined);
    const completed = successfulSwap({ guild_id: guildConfigs[1].guildId });
    const repositories = {
      claimCompletionSummary: vi.fn().mockResolvedValue(completed),
      completeCompletionSummary: vi.fn().mockResolvedValue(undefined),
      releaseCompletionSummary: vi.fn().mockResolvedValue(undefined),
      claimCompletionVouchDm: vi.fn().mockResolvedValue(completed),
      completeCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
      failCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
      releaseCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ repositories });
    service.completionGif = Buffer.from('gif');
    service.completionChannels.set(guildConfigs[0].guildId, firstChannel);
    service.completionChannels.set(guildConfigs[1].guildId, secondChannel);
    service.client.users = { fetch: vi.fn().mockResolvedValue({ send: sendDm }) };

    await expect(service.publishCompletionSummary(completed)).resolves.toBe(true);
    await expect(service.notifyCompletionVouch(completed)).resolves.toBe(true);

    expect(firstChannel.send).not.toHaveBeenCalled();
    expect(secondChannel.send).toHaveBeenCalledOnce();
    expect(sendDm).toHaveBeenCalledWith(
      `Your swap is complete! If you were happy with the service, please leave a vouch in <#${guildConfigs[1].vouchChannelId}>`,
    );
  });

  it('uses the correct ticket category and rejects cross-guild ticket controls', async () => {
    const second = guildRuntime(guildConfigs[1]);
    second.guild.channels.create = vi.fn().mockRejectedValue(new Error('stop after inspecting category'));
    const repositories = {
      getOpenTicketsForUser: vi.fn().mockResolvedValue([]),
      reserveTicket: vi.fn().mockResolvedValue({ created: true }),
      failTicketCreation: vi.fn().mockResolvedValue(undefined),
      getTicket: vi.fn().mockResolvedValue({
        id: 'ticket',
        guild_id: guildConfigs[0].guildId,
        user_id: 'owner',
        channel_id: 'channel',
        state: 'OPEN',
      }),
      touchTicket: vi.fn(),
    };
    const service = makeService({ runtimes: [second], repositories });
    const start = {
      customId: 'panel:start',
      guildId: guildConfigs[1].guildId,
      guild: second.guild,
      user: { id: 'owner', username: 'owner' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      isButton: () => true,
    };

    await service.startTicket(start);

    expect(second.guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({
      parent: guildConfigs[1].ticketCategoryId,
    }));
    expect(repositories.reserveTicket).toHaveBeenCalledWith(expect.objectContaining({
      guildId: guildConfigs[1].guildId,
      maxActiveTickets: 3,
    }));

    const reply = vi.fn().mockResolvedValue(undefined);
    const crossGuildControl = {
      customId: 't:ticket:back',
      guildId: guildConfigs[1].guildId,
      channelId: 'channel',
      user: { id: 'owner' },
      isButton: () => false,
      reply,
    };
    await expect(service.handleInteraction(crossGuildControl)).resolves.toBe(true);
    expect(reply).toHaveBeenCalledWith({
      content: 'This control belongs to a different server.',
      flags: MessageFlags.Ephemeral,
    });
    expect(repositories.touchTicket).not.toHaveBeenCalled();
  });

  it('allows up to three active tickets and rejects a fourth', async () => {
    const runtime = guildRuntime(guildConfigs[0]);
    const activeTickets = ['channel-1', 'channel-2', 'channel-3'].map((channelId, index) => ({
      id: `ticket-${index + 1}`,
      channel_id: channelId,
      state: 'OPEN',
    }));
    runtime.guild.channels.fetch = vi.fn().mockResolvedValue({ type: ChannelType.GuildText });
    const repositories = {
      getOpenTicketsForUser: vi.fn().mockResolvedValue(activeTickets),
      reserveTicket: vi.fn(),
      markTicketDeleted: vi.fn(),
    };
    const service = makeService({ runtimes: [runtime], repositories });
    const interaction = {
      guildId: guildConfigs[0].guildId,
      guild: runtime.guild,
      user: { id: 'owner', username: 'owner' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await service.startTicket(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringMatching(/up to 3 active swap tickets/i));
    expect(interaction.editReply.mock.calls[0][0]).toContain('<#channel-1>');
    expect(repositories.reserveTicket).not.toHaveBeenCalled();
  });

  it('retries vouch DMs only for guilds that have a vouch channel', async () => {
    const repositories = {
      claimInactiveDraftTickets: vi.fn().mockResolvedValue([]),
      claimInactiveTicketReminders: vi.fn().mockResolvedValue([]),
      listTicketsDueForDeletion: vi.fn().mockResolvedValue([]),
      listPendingCompletionSummaries: vi.fn().mockResolvedValue([]),
      listPendingCompletionVouchDms: vi.fn().mockResolvedValue([]),
      deleteExpiredRecords: vi.fn().mockResolvedValue(0),
    };
    const ticketService = {
      getVouchGuildIds: () => [guildConfigs[1].guildId],
      publishCompletionSummary: vi.fn(),
      notifyCompletionVouch: vi.fn(),
    };
    const worker = new LifecycleWorker({
      repositories,
      client: {},
      ticketService,
      config: {
        ticketInactivityMs: 30 * 60_000,
        ticketInactivityReminderMs: 5 * 60_000,
        terminalRetentionMs: 30 * 86_400_000,
        abandonedRetentionMs: 24 * 3_600_000,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await worker.run();

    expect(repositories.listPendingCompletionVouchDms).toHaveBeenCalledWith(
      expect.any(Date),
      25,
      [guildConfigs[1].guildId],
    );
  });
});

function makeService({
  runtimes = [],
  repositories = {},
  guildConfigurations = guildConfigs,
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}) {
  const runtimeByGuild = new Map(runtimes.map((runtime) => [runtime.guild.id, runtime]));
  const runtimeChannels = runtimes.flatMap((runtime) => [
    runtime.panelChannel,
    runtime.completionChannel,
    runtime.transcriptChannel,
  ]);
  return new TicketService({
    client: {
      user: { id: 'bot' },
      users: { fetch: vi.fn() },
      channels: { fetch: vi.fn(async (channelId) => runtimeChannels.find((channel) => channel.id === channelId)) },
      guilds: { fetch: vi.fn(async (guildId) => runtimeByGuild.get(guildId)?.guild) },
    },
    repositories,
    catalogue: {
      getAsset: (id) => id === 'ltc'
        ? { symbol: 'LTC', blockchain: 'ltc' }
        : { symbol: 'USDT', blockchain: 'bsc' },
    },
    coinPolicy: {},
    emojis: {},
    oneClick: { safeErrorLogFields: () => ({}) },
    qrService: {},
    config: {
      guilds: guildConfigurations,
      channelDeleteDelayMs: 5 * 60_000,
      vouchChannelId: null,
    },
    health: { isReady: () => true },
    logger,
  });
}

function guildRuntime(config) {
  const panelMessage = {
    id: `${config.guildId}-panel-message`,
    createdTimestamp: 1,
    author: { id: 'bot' },
    components: [{ components: [{ customId: 'panel:start' }] }],
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const panelChannel = {
    id: config.panelChannelId,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    messages: {
      fetch: vi.fn(async (target) => target?.limit
        ? new Map([[panelMessage.id, panelMessage]])
        : panelMessage),
    },
    send: vi.fn(),
  };
  const completion = initializedChannel(config.completedDealsChannelId);
  const transcript = initializedChannel(config.transcriptChannelId);
  const category = { id: config.ticketCategoryId, type: ChannelType.GuildCategory };
  const channels = new Map([
    [panelChannel.id, panelChannel],
    [completion.id, completion],
    [transcript.id, transcript],
    [category.id, category],
  ]);
  const guild = {
    id: config.guildId,
    roles: { everyone: { id: `${config.guildId}-everyone` } },
    channels: {
      fetch: vi.fn(async (channelId) => channels.get(channelId)),
      create: vi.fn(),
    },
  };
  return { guild, panelMessage, panelChannel, completionChannel: completion, transcriptChannel: transcript };
}

function initializedChannel(id) {
  return {
    id,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
  };
}

function completionChannel(messageId) {
  return {
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    send: vi.fn().mockResolvedValue({ id: messageId }),
  };
}

function successfulSwap(overrides = {}) {
  return {
    id: 'swap',
    ticket_id: 'ticket',
    user_id: '123456789012345678',
    status: 'SUCCESS',
    origin_asset_id: 'ltc',
    destination_asset_id: 'usdt',
    amount_display: '1',
    amount_usd_requested: '100',
    terminal_at: new Date('2026-08-13T12:00:00Z'),
    executable_quote: {
      quote: {
        amountIn: '100000000',
        amountInFormatted: '1',
        amountInUsd: '100',
        amountOut: '99000000',
        amountOutFormatted: '99',
        amountOutUsd: '99',
        withdrawFee: '1000000',
      },
    },
    ...overrides,
  };
}

function guildConfig(guildId, vouchChannelId = null) {
  const prefix = guildId.slice(0, 16);
  return {
    guildId,
    panelChannelId: `${prefix}01`,
    ticketCategoryId: `${prefix}02`,
    completedDealsChannelId: `${prefix}03`,
    transcriptChannelId: `${prefix}04`,
    vouchChannelId,
  };
}
