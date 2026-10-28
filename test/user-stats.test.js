import { describe, expect, it, vi } from 'vitest';
import { leaderboardPayload, payoutClosingPayload, statusUpdateEmbed, userStatsPayload } from '../src/discord/views.js';
import { TicketService } from '../src/services/ticket-service.js';
import { completedSwapAmountUsd } from '../src/utils/amounts.js';

const stats = {
  completed_swap_count: '4',
  total_amount_usd: '12500.5',
  fees_saved_usd: '125.005',
};

describe('user swap stats', () => {
  it('registers stats commands and removes stale global and guild /mutuals commands', async () => {
    const statsCommand = { name: 'stats', edit: vi.fn().mockResolvedValue(undefined) };
    const globalMutuals = { name: 'mutuals', delete: vi.fn().mockResolvedValue(undefined) };
    const guildMutuals = { name: 'mutuals', delete: vi.fn().mockResolvedValue(undefined) };
    const commands = {
      fetch: vi.fn().mockResolvedValue({ find: (predicate) => [statsCommand, guildMutuals].find(predicate) }),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: {
        application: {
          commands: {
            fetch: vi.fn().mockResolvedValue({ find: (predicate) => [globalMutuals].find(predicate) }),
          },
        },
        guilds: { fetch: vi.fn().mockResolvedValue({ id: 'guild', commands }) },
      },
      repositories: {}, catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
      config: { guildId: 'guild' }, health: {}, logger: { info: vi.fn() },
    });

    await service.initializeCommands();

    expect(statsCommand.edit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'stats',
      options: [expect.objectContaining({ name: 'user', type: 6, required: false })],
    }));
    expect(commands.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'leaderboard' }));
    expect(globalMutuals.delete).toHaveBeenCalledOnce();
    expect(guildMutuals.delete).toHaveBeenCalledOnce();
  });

  it('uses the matched executable quote amount for completed volume', () => {
    expect(completedSwapAmountUsd({
      amount_usd_requested: '130',
      executable_quote: { quote: { amountInUsd: '127.35' } },
      last_status_response: { swapDetails: { depositedAmountUsd: '128' } },
    })).toBe('127.35');
  });

  it('keeps cumulative stats out of completion messages', () => {
    const success = statusUpdateEmbed({ status: 'SUCCESS' }, { userStats: stats }).toJSON();
    expect(success.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Your total exchanged' }));
    expect(success.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Fees saved vs. 1%' }));

    const closing = payoutClosingPayload(
      'owner',
      { destination_asset_id: 'usdt', executable_quote: { quote: { amountOutFormatted: '100' } } },
      { status: 'PROCESSING' },
      { getAsset: () => ({ symbol: 'USDT' }) },
      'ticket',
      new Date(Date.now() + 60_000),
    ).embeds[0].toJSON();
    expect(closing.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Your total exchanged' }));
    expect(closing.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Fees saved vs. 1%' }));
  });

  it('renders /stats publicly for the requesting member', async () => {
    const repositories = { getUserSwapStats: vi.fn().mockResolvedValue(stats) };
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: {},
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: { guildId: 'guild' },
      health: {},
      logger: {},
    });
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'stats',
      guildId: 'guild',
      user: { id: 'user', username: 'Requester' },
      options: { getUser: vi.fn().mockReturnValue(null) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(service.handleInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(repositories.getUserSwapStats).toHaveBeenCalledWith('guild', 'user', {
      includeSwapId: null,
      includeAmountUsd: null,
    });
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe("Requester's swap stats");
    expect(embed.fields).toContainEqual({ name: 'Total exchanged', value: '$12,500.50', inline: true });
    expect(embed.fields).toContainEqual({ name: 'Fees saved vs. 1%', value: '$125.01', inline: true });
  });

  it('allows /stats to show another Discord user', async () => {
    const repositories = { getUserSwapStats: vi.fn().mockResolvedValue(stats) };
    const service = new TicketService({
      client: {}, repositories, catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
      config: { guildId: 'guild' }, health: {}, logger: {},
    });
    const selectedUser = { id: 'other-user', username: 'SomeoneElse' };
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'stats',
      guildId: 'guild',
      user: { id: 'requester', username: 'Requester' },
      options: { getUser: vi.fn().mockReturnValue(selectedUser) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await service.handleInteraction(interaction);

    expect(repositories.getUserSwapStats).toHaveBeenCalledWith('guild', 'other-user', {
      includeSwapId: null,
      includeAmountUsd: null,
    });
    expect(interaction.editReply.mock.calls[0][0].embeds[0].toJSON().title).toBe("SomeoneElse's swap stats");
  });

  it('renders a server top-five leaderboard publicly', async () => {
    const userIds = [
      '100000000000000001',
      '100000000000000002',
      '100000000000000003',
      '100000000000000004',
      '100000000000000005',
      '100000000000000006',
    ];
    const entries = Array.from({ length: 6 }, (_, index) => ({
      user_id: userIds[index],
      completed_swap_count: String(6 - index),
      total_amount_usd: String((6 - index) * 1000),
      fees_saved_usd: String((6 - index) * 10),
    }));
    const repositories = { listUserSwapLeaderboard: vi.fn().mockResolvedValue(entries) };
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
      config: { guildId: 'guild' }, health: {}, logger: {},
    });
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'leaderboard',
      guildId: 'guild',
      user: { id: 'requester' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(service.handleInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(repositories.listUserSwapLeaderboard).toHaveBeenCalledWith('guild', 5);
    const payload = interaction.editReply.mock.calls[0][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe('Server swap leaderboard');
    expect(embed.description).toContain('1. <@100000000000000001>');
    expect(embed.description).toContain('$6,000.00 exchanged');
    expect(embed.description).not.toContain('saved vs. 1%');
    expect(embed.description).not.toContain('<@100000000000000006>');
    expect(embed).not.toHaveProperty('footer');
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('omits scope copy and the footer from the stats response', () => {
    const embed = userStatsPayload(stats).embeds[0].toJSON();
    expect(embed).not.toHaveProperty('description');
    expect(embed).not.toHaveProperty('footer');
  });

  it('shows an empty leaderboard cleanly', () => {
    const embed = leaderboardPayload([]).embeds[0].toJSON();
    expect(embed.description).toContain('No completed swaps');
  });
});
