import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  parseSetupComponentId,
  setupRedoConfirmationPayload,
  setupReviewPayload,
  setupStepPayload,
} from '../src/discord/setup-wizard.js';
import { TicketService } from '../src/services/ticket-service.js';

describe('guild setup views', () => {
  it('asks for channels one at a time and offers None only for optional destinations', () => {
    const required = setupStepPayload('00000000-0000-4000-8000-000000000000', 0).components.map((row) => row.toJSON());
    const optional = setupStepPayload('00000000-0000-4000-8000-000000000000', 2).components.map((row) => row.toJSON());

    expect(required[0].components[0].type).toBe(8);
    expect(required.flatMap((row) => row.components).map((component) => component.label)).not.toContain('None');
    expect(optional.flatMap((row) => row.components).map((component) => component.label)).toContain('None');
  });

  it('warns before replacing an existing setup and keeps Save on the final review', () => {
    const sessionId = '00000000-0000-4000-8000-000000000000';
    const confirmation = setupRedoConfirmationPayload(sessionId);
    const review = setupReviewPayload(sessionId, {
      panelChannelId: '1', ticketCategoryId: '2', completedDealsChannelId: null,
      transcriptChannelId: '3', vouchChannelId: null,
    });

    expect(confirmation.content).toContain('Nothing will change');
    expect(confirmation.components[0].toJSON().components.map((component) => component.label)).toEqual([
      'Redo Setup', 'Cancel',
    ]);
    expect(review.components[0].toJSON().components.map((component) => component.label)).toContain('Save Setup');
    expect(parseSetupComponentId(`setup:${sessionId}:save`)).toEqual({ sessionId, action: 'save' });
  });
});

describe('/setup command', () => {
  it('is administrator-only and asks for confirmation when configuration already exists', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const service = setupService({
      repositories: {
        getGuildConfiguration: vi.fn().mockResolvedValue({ guildId: 'guild' }),
      },
    });
    const interaction = setupCommandInteraction({ reply });

    await service.handleSetupCommand(interaction);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('already configured'),
      flags: MessageFlags.Ephemeral,
    }));
  });

  it('rejects a non-administrator without creating a setup session', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const service = setupService();
    const interaction = setupCommandInteraction({ reply, administrator: false });

    await service.handleSetupCommand(interaction);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Only a server administrator'),
    }));
    expect(service.setupSessions.size).toBe(0);
  });

  it('persists the setup and posts the panel immediately after validation', async () => {
    const panelMessage = { id: 'panel-message' };
    const panel = setupChannel('panel', ChannelType.GuildText, {
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
      send: vi.fn().mockResolvedValue(panelMessage),
    });
    const category = setupChannel('category', ChannelType.GuildCategory);
    const channels = new Map([['panel', panel], ['category', category]]);
    const guild = {
      id: 'guild',
      members: { me: { permissions: { has: vi.fn().mockReturnValue(true) } } },
      channels: { fetch: vi.fn(async (id) => channels.get(id) ?? null) },
      commands: {
        fetch: vi.fn().mockResolvedValue({ find: vi.fn().mockReturnValue(null) }),
        create: vi.fn().mockResolvedValue(undefined),
      },
    };
    const saved = {
      guildId: 'guild', panelChannelId: 'panel', ticketCategoryId: 'category',
      completedDealsChannelId: null, transcriptChannelId: null, vouchChannelId: null,
      configuredByUserId: 'admin',
    };
    const repositories = {
      getPanel: vi.fn().mockResolvedValue(null),
      savePanel: vi.fn().mockResolvedValue(undefined),
      upsertGuildConfiguration: vi.fn().mockResolvedValue(saved),
    };
    const service = setupService({ repositories });

    await expect(service.applyGuildSetup(guild, {
      panelChannelId: 'panel',
      ticketCategoryId: 'category',
      completedDealsChannelId: null,
      transcriptChannelId: null,
      vouchChannelId: null,
    }, 'admin')).resolves.toEqual(saved);

    expect(repositories.upsertGuildConfiguration).toHaveBeenCalledWith(saved);
    expect(panel.send).toHaveBeenCalledOnce();
    expect(repositories.savePanel).toHaveBeenCalledWith('guild', 'panel', 'panel-message');
    expect(service.guildConfigs.get('guild')).toEqual(saved);
  });

  it('registers /setup globally only when self-service is enabled', async () => {
    const globalCommands = { find: vi.fn().mockReturnValue(null) };
    const create = vi.fn().mockResolvedValue(undefined);
    const service = setupService({
      client: {
        application: { commands: { fetch: vi.fn().mockResolvedValue(globalCommands), create } },
        guilds: { fetch: vi.fn().mockResolvedValue(null) },
      },
    });

    await service.initializeCommands();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'setup',
      defaultMemberPermissions: PermissionFlagsBits.Administrator.toString(),
    }));
  });
});

function setupService({ repositories = {}, client = null } = {}) {
  return new TicketService({
    client: client ?? { user: { id: 'bot' }, channels: { fetch: vi.fn() } },
    repositories,
    catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
    config: { guilds: [], selfServiceSetupEnabled: true },
    health: { isReady: vi.fn().mockReturnValue(true) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

function setupCommandInteraction({ reply, administrator = true }) {
  return {
    guildId: 'guild',
    guild: { id: 'guild' },
    user: { id: 'admin' },
    memberPermissions: { has: vi.fn().mockReturnValue(administrator) },
    reply,
  };
}

function setupChannel(id, type, overrides = {}) {
  return {
    id,
    guildId: 'guild',
    type,
    isTextBased: vi.fn().mockReturnValue(type !== ChannelType.GuildCategory),
    permissionsFor: vi.fn().mockReturnValue({ has: vi.fn().mockReturnValue(true) }),
    ...overrides,
  };
}
