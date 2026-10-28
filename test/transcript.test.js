import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';
import { buildTranscriptFiles } from '../src/services/transcript-service.js';

describe('ticket transcripts', () => {
  it('writes private values as readable text and preserves chronological messages, embeds, and safe attachment links', () => {
    const files = buildTranscriptFiles({
      ticket: ticket(),
      swap: swap(),
      messages: [
        message({ id: '2', createdTimestamp: 2, content: 'second', author: { id: 'bot', username: 'Bot' } }),
        message({
          id: '1',
          createdTimestamp: 1,
          content: '<script>first & private</script>',
          embeds: [{
            title: '<Status>',
            description: 'Deposit & memo',
            fields: [{ name: 'Wallet', value: '<wallet>' }],
            footer: { text: 'footer > text' },
          }],
          attachments: new Map([
            ['safe', { name: '<receipt>.txt', url: 'https://cdn.discordapp.com/receipt.txt' }],
            ['unsafe', { name: 'bad.txt', url: 'http://example.com/bad.txt' }],
          ]),
        }),
      ],
    });

    expect(files).toHaveLength(1);
    const text = files[0].attachment.toString('utf8');
    expect(files[0].name).toBe('swap-ticket-ticket.txt');
    expect(text).toContain('<script>first & private</script>');
    expect(text).toContain('Title: <Status>');
    expect(text).toContain('Recipient wallet: recipient-private');
    expect(text).toContain('Refund wallet: refund-private');
    expect(text).toContain('Deposit address: deposit-private');
    expect(text).toContain('Deposit memo: memo-private');
    expect(text).toContain('Deposit transaction: tx-private');
    expect(text).toContain('<receipt>.txt: https://cdn.discordapp.com/receipt.txt');
    expect(text).not.toContain('http://example.com');
    expect(text.indexOf('first & private')).toBeLessThan(text.indexOf('second'));
  });

  it('splits large transcripts into numbered text attachments', () => {
    const messages = Array.from({ length: 900 }, (_, index) => message({
      id: String(index),
      createdTimestamp: index,
      content: `${index}-${'x'.repeat(8_000)}`,
    }));

    const files = buildTranscriptFiles({ ticket: ticket(), swap: swap(), messages });

    expect(files.length).toBeGreaterThan(1);
    expect(files[0].name).toContain(`-1-of-${files.length}.txt`);
    expect(files.at(-1).name).toContain(`-${files.length}-of-${files.length}.txt`);
  });

  it('stores the archive message ID and never mentions anyone', async () => {
    const archiveMessage = { id: 'archive-message' };
    const archiveChannel = { send: vi.fn().mockResolvedValue(archiveMessage) };
    const ticketChannel = transcriptChannel();
    const repositories = transcriptRepositories();
    const service = serviceForTranscript({ repositories, ticketChannel });
    service.transcriptChannel = archiveChannel;

    const archived = await service.archiveFinalTicketTranscript(ticket(), ticketChannel);

    expect(archived).toBe(true);
    expect(archiveChannel.send).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
      files: [expect.objectContaining({ name: 'swap-ticket-ticket.txt' })],
    }));
    expect(repositories.completeTicketTranscript).toHaveBeenCalledWith('ticket', 'archive-message');
  });

  it('silently copies each final transcript to the configured central archive', async () => {
    const localArchive = { id: 'local-archive' };
    const centralArchive = { id: 'central-archive' };
    const localChannel = { id: 'local', send: vi.fn().mockResolvedValue(localArchive) };
    const centralChannel = { id: 'central', send: vi.fn().mockResolvedValue(centralArchive) };
    const ticketChannel = transcriptChannel();
    const repositories = transcriptRepositories();
    const service = serviceForTranscript({ repositories, ticketChannel });
    service.transcriptChannel = localChannel;
    service.centralTranscriptChannel = centralChannel;
    service.config = { centralTranscriptChannelId: 'central' };

    await expect(service.archiveFinalTicketTranscript(ticket(), ticketChannel)).resolves.toBe(true);

    expect(localChannel.send).toHaveBeenCalledOnce();
    expect(centralChannel.send).toHaveBeenCalledOnce();
    expect(centralChannel.send).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
      files: [expect.objectContaining({ name: 'swap-ticket-ticket.txt' })],
    }));
    expect(repositories.completeTicketTranscript).toHaveBeenCalledWith('ticket', 'local-archive');
  });

  it('deletes the ticket even when transcript upload fails', async () => {
    const ticketChannel = transcriptChannel();
    const repositories = transcriptRepositories();
    const service = serviceForTranscript({ repositories, ticketChannel });
    service.transcriptChannel = { send: vi.fn().mockRejectedValue(new Error('upload failed')) };

    await service.deleteTicketImmediately('ticket', 'Closed after completion');

    expect(repositories.releaseTicketTranscript).toHaveBeenCalledWith('ticket');
    expect(ticketChannel.delete).toHaveBeenCalledWith('Closed after completion');
    expect(repositories.markTicketDeleted).toHaveBeenCalledWith('ticket');
  });

  it('does not archive unfinished or inactivity-closed tickets', async () => {
    const ticketChannel = transcriptChannel();
    const repositories = transcriptRepositories();
    const service = serviceForTranscript({ repositories, ticketChannel });
    service.transcriptChannel = { send: vi.fn() };

    expect(await service.archiveFinalTicketTranscript(ticket({ closure_reason: 'INACTIVITY' }), ticketChannel)).toBe(false);
    expect(repositories.claimTicketTranscript).not.toHaveBeenCalled();
  });
});

function ticket(overrides = {}) {
  return {
    id: 'ticket', user_id: 'owner', channel_id: 'channel', state: 'OPEN', step: 'TERMINAL',
    closure_reason: 'TERMINAL', created_at: new Date(0),
    ...overrides,
  };
}

function swap() {
  return {
    id: 'swap', ticket_id: 'ticket', status: 'SUCCESS', executable_quote: { quote: {} },
    origin_asset_id: 'btc', destination_asset_id: 'eth', amount_display: '1',
    recipient: 'recipient-private', refund_to: 'refund-private', deposit_address: 'deposit-private',
    deposit_memo: 'memo-private', deposit_tx_hash: 'tx-private', terminal_at: new Date(3),
  };
}

function message(overrides = {}) {
  return {
    id: 'message', createdTimestamp: 0, content: '', author: { id: 'owner', username: 'Owner' },
    embeds: [], attachments: new Map(),
    ...overrides,
  };
}

function transcriptChannel() {
  return {
    type: ChannelType.GuildText,
    messages: { fetch: vi.fn().mockResolvedValue(new Map([['message', message({ content: 'hello' })]])) },
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function transcriptRepositories() {
  const finalTicket = ticket();
  return {
    getTicket: vi.fn().mockResolvedValue(finalTicket),
    claimTicketTranscript: vi.fn().mockResolvedValue(finalTicket),
    getSwapByTicket: vi.fn().mockResolvedValue(swap()),
    completeTicketTranscript: vi.fn().mockResolvedValue(undefined),
    releaseTicketTranscript: vi.fn().mockResolvedValue(undefined),
    markTicketDeleted: vi.fn().mockResolvedValue(undefined),
  };
}

function serviceForTranscript({ repositories, ticketChannel }) {
  return new TicketService({
    client: { channels: { fetch: vi.fn().mockResolvedValue(ticketChannel) } },
    repositories,
    catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {}, config: {}, health: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}
