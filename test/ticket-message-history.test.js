import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { TicketService } from '../src/services/ticket-service.js';

describe('ticket instruction message history', () => {
  it('reuses the earliest bot message as the persistent close header on restart', async () => {
    const earliest = {
      id: 'earliest',
      author: { id: 'bot' },
      createdTimestamp: 1,
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const progress = {
      id: 'progress',
      author: { id: 'bot' },
      createdTimestamp: 2,
      edit: vi.fn(),
    };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn().mockResolvedValue(new Map([[progress.id, progress], [earliest.id, earliest]])) },
      send: vi.fn(),
    };
    const repositories = { setHeaderMessage: vi.fn().mockResolvedValue(undefined) };
    const service = makeService({ channel, repositories });
    service.client.user = { id: 'bot' };

    await service.ensureTicketHeader({
      ...ticket(),
      user_id: 'member',
      progress_message_id: 'progress',
      header_message_id: null,
    });

    expect(earliest.edit).toHaveBeenCalledWith(expect.objectContaining({ content: '<@member>' }));
    expect(earliest.edit.mock.calls[0][0].components[0].toJSON().components[0].label).toBe('Close ticket');
    expect(progress.edit).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(repositories.setHeaderMessage).toHaveBeenCalledWith('ticket', 'earliest');
  });

  it('removes UUID footers from frozen historical ticket messages', async () => {
    const historical = {
      id: 'history',
      author: { id: 'bot' },
      createdTimestamp: 1,
      embeds: [{ toJSON: () => ({ title: 'Old step', footer: { text: 'Ticket ticket' } }) }],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn().mockResolvedValue(new Map([[historical.id, historical]])) },
    };
    const service = makeService({ channel, repositories: {} });
    service.client.user = { id: 'bot' };

    await service.removeLegacyTicketFooters(ticket());

    expect(historical.edit).toHaveBeenCalledWith({
      embeds: [{ title: 'Old step' }],
      allowedMentions: { parse: [] },
    });
  });

  it('freezes the previous controls, appends the next step, and persists its id', async () => {
    const previous = { edit: vi.fn().mockResolvedValue(undefined) };
    const next = { id: 'next-message', delete: vi.fn() };
    const channel = textChannel({ previous, send: vi.fn().mockResolvedValue(next) });
    const repositories = { setProgressMessage: vi.fn().mockResolvedValue(undefined) };
    const service = makeService({ channel, repositories });
    const payload = { embeds: [{ title: 'Next step' }], components: [{ type: 1 }] };

    await service.appendProgress(ticket(), payload);

    expect(previous.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining(payload));
    expect(repositories.setProgressMessage).toHaveBeenCalledWith('ticket', 'next-message');
  });

  it('keeps a Components V2 card intact while disabling its previous controls', async () => {
    const previous = {
      flags: { has: (flag) => flag === MessageFlags.IsComponentsV2 },
      components: [{
        toJSON: () => ({
          type: 17,
          accent_color: 0x5865f2,
          components: [
            { type: 10, content: 'Opening card' },
            { type: 1, components: [{ type: 2, custom_id: 'popular', label: 'Popular', style: 2 }] },
            { type: 1, components: [{ type: 3, custom_id: 'coins', options: [{ label: 'LTC', value: 'LTC' }] }] },
          ],
        }),
      }],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const channel = textChannel({
      previous,
      send: vi.fn().mockResolvedValue({ id: 'next-message', delete: vi.fn() }),
    });
    const service = makeService({
      channel,
      repositories: { setProgressMessage: vi.fn().mockResolvedValue(undefined) },
    });

    await service.appendProgress(ticket(), { embeds: [{ title: 'Next step' }], components: [] });

    const frozen = previous.edit.mock.calls[0][0].components[0];
    expect(frozen.components[0]).toEqual({ type: 10, content: 'Opening card' });
    expect(frozen.components[1].components[0].disabled).toBe(true);
    expect(frozen.components[2].components[0].disabled).toBe(true);
  });

  it('clears legacy message fields when Back converts the progress message to Components V2', async () => {
    const previous = { edit: vi.fn().mockResolvedValue(undefined) };
    const channel = textChannel({ previous, send: vi.fn() });
    const repositories = {
      getTicket: vi.fn().mockResolvedValue(ticket()),
    };
    const service = makeService({ channel, repositories });
    const container = { type: 17, components: [{ type: 10, content: 'Opening card' }] };

    await service.editProgress('ticket', {
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    expect(previous.edit).toHaveBeenCalledWith({
      content: null,
      embeds: [],
      attachments: [],
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  });

  it('restores the current message when Discord cannot append the next step', async () => {
    const previous = { edit: vi.fn().mockResolvedValue(undefined) };
    const channel = textChannel({ previous, send: vi.fn().mockRejectedValue(new Error('Discord unavailable')) });
    const service = makeService({ channel, repositories: { setProgressMessage: vi.fn() } });
    const payload = { embeds: [{ title: 'Recovered step' }], components: [{ type: 1 }] };

    await expect(service.appendProgress(ticket(), payload)).rejects.toThrow('Discord unavailable');
    expect(previous.edit).toHaveBeenLastCalledWith(expect.objectContaining(payload));
  });

  it('edits for Back and appends for ordinary forward transitions', async () => {
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
    };
    const service = makeService({ channel: null, repositories });
    service.renderProgress = vi.fn().mockResolvedValue(undefined);
    const interaction = { deferred: false, replied: false, deferUpdate: vi.fn(async function defer() { this.deferred = true; }) };

    await service.updateAndRender(interaction, 'ticket', 'NEXT', {}, { expectedStep: 'CURRENT' });
    await service.updateAndRender(interaction, 'ticket', 'PREVIOUS', {}, { append: false, expectedStep: 'NEXT' });

    expect(service.renderProgress).toHaveBeenNthCalledWith(1, 'ticket', { append: true });
    expect(service.renderProgress).toHaveBeenNthCalledWith(2, 'ticket', { append: false });
  });
});

function makeService({ channel, repositories }) {
  return new TicketService({
    client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
    repositories,
    catalogue: {},
    coinPolicy: {},
    emojis: {},
    oneClick: {},
    config: {},
    health: {},
    logger: {},
  });
}

function textChannel({ previous, send }) {
  return {
    isTextBased: () => true,
    messages: { fetch: vi.fn().mockResolvedValue(previous) },
    send,
  };
}

function ticket() {
  return { id: 'ticket', channel_id: 'channel', progress_message_id: 'previous-message' };
}
