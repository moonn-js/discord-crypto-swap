import { ChannelType, MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

describe('swap panel reconciliation', () => {
  it('edits the saved panel, deletes only exact duplicate panels, and keeps unrelated messages', async () => {
    const savedPanel = panelMessage('saved', 20, ['panel:start']);
    const olderDuplicate = panelMessage('duplicate', 10, ['panel:start', 'panel:supported-coins']);
    const unrelated = panelMessage('unrelated', 5, ['different:button']);
    const memberPanel = panelMessage('member-panel', 1, ['panel:start'], 'member');
    const recent = new Map([
      [olderDuplicate.id, olderDuplicate],
      [savedPanel.id, savedPanel],
      [unrelated.id, unrelated],
      [memberPanel.id, memberPanel],
    ]);
    const panelChannel = {
      id: 'panel-channel',
      type: ChannelType.GuildText,
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async (target) => target?.limit ? recent : recent.get(target) ?? null),
      },
      send: vi.fn(),
    };
    const category = { id: 'category', type: ChannelType.GuildCategory };
    const repositories = {
      getPanel: vi.fn().mockResolvedValue({ channel_id: panelChannel.id, message_id: savedPanel.id }),
      savePanel: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ panelChannel, category, repositories });

    await service.initializePanel();

    expect(savedPanel.edit).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
    expect(olderDuplicate.delete).toHaveBeenCalledOnce();
    expect(unrelated.delete).not.toHaveBeenCalled();
    expect(memberPanel.delete).not.toHaveBeenCalled();
    expect(panelChannel.send).not.toHaveBeenCalled();
    expect(repositories.savePanel).toHaveBeenCalledWith('guild', panelChannel.id, savedPanel.id);
  });

  it('falls back to the oldest matching panel when the saved reference is missing', async () => {
    const oldest = panelMessage('oldest', 10, ['panel:start']);
    const newer = panelMessage('newer', 20, ['panel:start', 'panel:supported-coins']);
    const recent = new Map([[newer.id, newer], [oldest.id, oldest]]);
    const panelChannel = {
      id: 'panel-channel',
      type: ChannelType.GuildText,
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async (target) => target?.limit ? recent : null),
      },
      send: vi.fn(),
    };
    const repositories = {
      getPanel: vi.fn().mockResolvedValue({ channel_id: panelChannel.id, message_id: 'missing' }),
      savePanel: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ panelChannel, category: { type: ChannelType.GuildCategory }, repositories });

    await service.initializePanel();

    expect(oldest.edit).toHaveBeenCalledOnce();
    expect(newer.delete).toHaveBeenCalledOnce();
    expect(panelChannel.send).not.toHaveBeenCalled();
    expect(repositories.savePanel).toHaveBeenCalledWith('guild', panelChannel.id, oldest.id);
  });

  it('answers the supported-coins button privately with the live policy even when swaps are unavailable', async () => {
    const policy = {
      getFeaturedCoins: () => [{ key: 'BTC', symbol: 'BTC' }],
      getOtherCoins: () => [{ key: 'AVAX', symbol: 'AVAX' }],
      describeNetworks: (key) => key === 'BTC' ? 'Bitcoin' : 'Avalanche',
    };
    const service = new TicketService({
      client: {},
      repositories: {},
      catalogue: {},
      coinPolicy: policy,
      emojis: {},
      oneClick: {},
      qrService: {},
      config: { guildId: 'guild' },
      health: { isReady: () => false },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const interaction = {
      customId: 'panel:supported-coins',
      guildId: 'guild',
      isButton: () => true,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(service.handleInteraction(interaction)).resolves.toBe(true);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    }));
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(JSON.stringify(embed)).toContain('**BTC** — Bitcoin');
    expect(JSON.stringify(embed)).toContain('**AVAX** — Avalanche');
  });
});

function makeService({ panelChannel, category, repositories }) {
  const guild = {
    id: 'guild',
    channels: {
      fetch: vi.fn(async (id) => id === 'panel-channel' ? panelChannel : category),
    },
  };
  return new TicketService({
    client: { user: { id: 'bot' }, guilds: { fetch: vi.fn().mockResolvedValue(guild) } },
    repositories,
    catalogue: {},
    coinPolicy: {},
    emojis: {},
    oneClick: {},
    qrService: {},
    config: { guildId: 'guild', panelChannelId: 'panel-channel', ticketCategoryId: 'category' },
    health: { isReady: () => true },
    logger: { warn: vi.fn(), info: vi.fn() },
  });
}

function panelMessage(id, createdTimestamp, componentIds, authorId = 'bot') {
  return {
    id,
    createdTimestamp,
    author: { id: authorId },
    components: [{ components: componentIds.map((customId) => ({ customId })) }],
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}
