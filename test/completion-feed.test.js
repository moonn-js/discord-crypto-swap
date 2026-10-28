import { createHash } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

describe('completed-deal feed', () => {
  it('publishes a successful deal once and records the Discord message id', async () => {
    const completed = swap();
    const channel = {
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
      send: vi.fn().mockResolvedValue({ id: 'summary-message' }),
    };
    const repositories = repositoryMocks(completed);
    const service = makeService(channel, repositories);

    await expect(service.publishCompletionSummary(completed)).resolves.toBe(true);

    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.send.mock.calls[0][0]).toMatchObject({
      content: 'Exchanged by <@123456789012345678>',
      allowedMentions: { parse: [] },
    });
    expect(channel.send.mock.calls[0][0].files[0].name).toBe('deal-history.gif');
    expect(repositories.completeCompletionSummary).toHaveBeenCalledWith('swap', 'summary-message');
    const sent = channel.send.mock.calls[0][0].embeds[0].toJSON();
    expect(JSON.stringify(sent)).not.toMatch(/recipient|refund|deposit-address/);
  });

  it('recovers from send-before-database-save without posting a duplicate', async () => {
    const completed = swap();
    const reference = createHash('sha256').update('swap').digest('hex').slice(0, 12);
    const existing = {
      id: 'existing-message',
      author: { id: 'bot' },
      embeds: [{ footer: { text: `Order ${reference.slice(0, 6).toUpperCase()}` } }],
    };
    const channel = {
      messages: { fetch: vi.fn().mockResolvedValue(new Map([[existing.id, existing]])) },
      send: vi.fn(),
    };
    const repositories = repositoryMocks(completed);
    const service = makeService(channel, repositories);

    await expect(service.publishCompletionSummary(completed)).resolves.toBe(true);

    expect(channel.send).not.toHaveBeenCalled();
    expect(repositories.completeCompletionSummary).toHaveBeenCalledWith('swap', 'existing-message');
  });

  it('omits attribution for a missing or invalid user id without blocking publication', async () => {
    const completed = { ...swap(), user_id: 'not-a-discord-user' };
    const channel = {
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
      send: vi.fn().mockResolvedValue({ id: 'summary-message' }),
    };
    const repositories = repositoryMocks(completed);
    const service = makeService(channel, repositories);

    await expect(service.publishCompletionSummary(completed)).resolves.toBe(true);

    expect(channel.send.mock.calls[0][0]).not.toHaveProperty('content');
    expect(channel.send.mock.calls[0][0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(repositories.completeCompletionSummary).toHaveBeenCalledWith('swap', 'summary-message');
  });

  it('refreshes summary embeds without changing new attribution or legacy anonymous content', async () => {
    const attributedMessage = {
      id: 'attributed-message',
      content: 'Exchanged by <@123456789012345678>',
      embeds: [{}],
      components: [],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const legacyMessage = {
      id: 'legacy-message',
      content: '',
      embeds: [{}],
      components: [],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const attributedSwap = { ...swap(), completion_summary_message_id: attributedMessage.id };
    const legacySwap = { ...swap(), id: 'legacy-swap', completion_summary_message_id: legacyMessage.id };
    const channel = {
      messages: {
        fetch: vi.fn(async (id) => id === attributedMessage.id ? attributedMessage : legacyMessage),
      },
    };
    const repositories = {
      listPostedCompletionSummaries: vi.fn().mockResolvedValue([attributedSwap, legacySwap]),
    };
    const service = makeService(channel, repositories);

    await service.reconcileCompletionSummaries();

    expect(attributedMessage.edit).toHaveBeenCalledOnce();
    expect(legacyMessage.edit).toHaveBeenCalledOnce();
    expect(attributedMessage.edit.mock.calls[0][0]).not.toHaveProperty('content');
    expect(legacyMessage.edit.mock.calls[0][0]).not.toHaveProperty('content');
    expect(attributedMessage.content).toBe('Exchanged by <@123456789012345678>');
    expect(legacyMessage.content).toBe('');
  });

  it('DMs the successful swap owner with the configured vouch channel once', async () => {
    const completed = swap();
    const send = vi.fn().mockResolvedValue(undefined);
    const repositories = {
      claimCompletionVouchDm: vi.fn().mockResolvedValue({ ...completed, user_id: 'owner' }),
      completeCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
      failCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: { users: { fetch: vi.fn().mockResolvedValue({ send }) } },
      repositories,
      catalogue: {},
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: { guildId: 'guild', vouchChannelId: '1522362740415660113' },
      health: {},
      logger: { warn: vi.fn() },
    });

    await expect(service.notifyCompletionVouch(completed)).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(
      'Your swap is complete! If you were happy with the service, please leave a vouch in <#1522362740415660113>',
    );
    expect(repositories.completeCompletionVouchDm).toHaveBeenCalledWith('swap');
  });

  it('DMs the swap owner before 1Click SUCCESS when an external payout detector finishes it', async () => {
    const detected = {
      ...swap(),
      status: 'PROCESSING',
      payout_detected_at: new Date('2026-08-11T12:00:00.000Z'),
      payout_sent_message_id: 'payout-message',
    };
    const send = vi.fn().mockResolvedValue(undefined);
    const repositories = {
      claimCompletionVouchDm: vi.fn().mockResolvedValue({ ...detected, user_id: 'owner' }),
      completeCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
      failCompletionVouchDm: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: { users: { fetch: vi.fn().mockResolvedValue({ send }) } },
      repositories,
      catalogue: {},
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: { guildId: 'guild', vouchChannelId: '1522362740415660113' },
      health: {},
      logger: { warn: vi.fn() },
    });

    await expect(service.notifyCompletionVouch(detected)).resolves.toBe(true);

    expect(send).toHaveBeenCalledOnce();
    expect(repositories.completeCompletionVouchDm).toHaveBeenCalledWith('swap');
  });

  it('posts the payout-sent message once and records its Discord message id', async () => {
    const processing = {
      ...swap(),
      status: 'PROCESSING',
      ticket_id: 'ticket',
      destination_asset_id: 'usdt',
    };
    const response = {
      status: 'PROCESSING',
      swapDetails: {
        amountOutFormatted: '99.25',
        destinationChainTxHashes: [{
          hash: 'destination-transaction-hash',
          explorerUrl: 'https://explorer.example/tx/destination-transaction-hash',
        }],
      },
    };
    const channel = {
      type: ChannelType.GuildText,
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
      send: vi.fn().mockResolvedValue({ id: 'payout-message' }),
    };
    const repositories = {
      claimPayoutSentNotification: vi.fn().mockResolvedValue({
        ...processing,
        user_id: 'owner',
        channel_id: 'channel',
        ticket_state: 'OPEN',
      }),
      completePayoutSentNotification: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: {
        user: { id: 'bot' },
        channels: { fetch: vi.fn().mockResolvedValue(channel) },
      },
      repositories,
      catalogue: { getAsset: () => ({ symbol: 'USDT', blockchain: 'bsc' }) },
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });

    await expect(service.notifyPayoutSent(processing, response)).resolves.toBe(true);

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: '<@owner> Your payout of `99.25 USDT` has been sent to your receiving wallet. This ticket will close automatically after the transaction is confirmed.',
      allowedMentions: { users: ['owner'] },
      components: [],
    }));
    expect(repositories.completePayoutSentNotification).toHaveBeenCalledWith('swap', 'payout-message');
  });

  it('does not duplicate a payout-sent message after its database claim is completed', async () => {
    const channel = { type: ChannelType.GuildText, send: vi.fn() };
    const repositories = {
      claimPayoutSentNotification: vi.fn().mockResolvedValue(null),
      completePayoutSentNotification: vi.fn(),
    };
    const service = new TicketService({
      client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      repositories,
      catalogue: { getAsset: () => ({ symbol: 'USDT', blockchain: 'bsc' }) },
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });

    await expect(service.notifyPayoutSent({ id: 'swap' }, {
      status: 'PROCESSING',
      swapDetails: { destinationChainTxHashes: [{ hash: 'destination-transaction-hash' }] },
    })).resolves.toBe(false);

    expect(channel.send).not.toHaveBeenCalled();
    expect(repositories.completePayoutSentNotification).not.toHaveBeenCalled();
  });

  it('posts the closing message and schedules deletion for BlockCypher-detected payouts', async () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    const deleteAt = new Date(now + 5 * 60_000);
    const channel = {
      type: ChannelType.GuildText,
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
      send: vi.fn().mockResolvedValue({ id: 'closing-message' }),
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
    };
    const repositories = {
      claimPayoutSentNotification: vi.fn().mockResolvedValue({
        ...swap(),
        status: 'PROCESSING',
        ticket_id: 'ticket',
        destination_asset_id: 'ltc',
        payout_detected_provider: 'blockcypher',
        payout_detected_at: new Date('2026-08-11T12:00:00.000Z'),
        user_id: 'owner',
        channel_id: 'channel',
        ticket_state: 'OPEN',
      }),
      scheduleTerminalTicketDeletion: vi.fn().mockResolvedValue({
        id: 'ticket',
        user_id: 'owner',
        channel_id: 'channel',
        delete_at: deleteAt,
        closure_reason: 'PAYOUT_BROADCAST',
      }),
      completePayoutSentNotification: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: {
        user: { id: 'bot' },
        channels: { fetch: vi.fn().mockResolvedValue(channel) },
      },
      repositories,
      catalogue: { getAsset: () => ({ symbol: 'LTC', blockchain: 'ltc' }) },
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: { channelDeleteDelayMs: 5 * 60_000 },
      health: {},
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    service.notifyCompletionVouch = vi.fn().mockResolvedValue(true);

    try {
      await expect(service.notifyPayoutSent({ id: 'swap' }, {
        status: 'PROCESSING',
        swapDetails: { destinationChainTxHashes: [{ hash: 'destination-transaction-hash' }] },
      })).resolves.toBe(true);
    } finally {
      dateNow.mockRestore();
    }

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('<@owner> Your payout'),
      allowedMentions: { users: ['owner'] },
    }));
    expect(channel.send.mock.calls[0][0].embeds[0].toJSON().title).toBe('Swap completed');
    expect(repositories.scheduleTerminalTicketDeletion)
      .toHaveBeenCalledWith('ticket', deleteAt, 'PAYOUT_BROADCAST');
    expect(repositories.completePayoutSentNotification).toHaveBeenCalledWith('swap', 'closing-message');
    expect(service.notifyCompletionVouch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'swap',
      payout_detected_provider: 'blockcypher',
    }));
  });

  it('recovers from a payout send completed immediately before a restart', async () => {
    const existing = {
      id: 'existing-payout-message',
      author: { id: 'bot' },
      content: '<@owner> An earlier version of the payout message.',
      embeds: [{ title: 'Payout sent' }],
    };
    const channel = {
      type: ChannelType.GuildText,
      messages: { fetch: vi.fn().mockResolvedValue(new Map([[existing.id, existing]])) },
      send: vi.fn(),
    };
    const repositories = {
      claimPayoutSentNotification: vi.fn().mockResolvedValue({
        ...swap(),
        status: 'PROCESSING',
        ticket_id: 'ticket',
        user_id: 'owner',
        channel_id: 'channel',
        ticket_state: 'OPEN',
      }),
      completePayoutSentNotification: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: {
        user: { id: 'bot' },
        channels: { fetch: vi.fn().mockResolvedValue(channel) },
      },
      repositories,
      catalogue: { getAsset: () => ({ symbol: 'USDT', blockchain: 'bsc' }) },
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });

    await expect(service.notifyPayoutSent({ id: 'swap' }, {
      status: 'PROCESSING',
      swapDetails: { destinationChainTxHashes: [{ hash: 'destination-transaction-hash' }] },
    })).resolves.toBe(true);

    expect(channel.send).not.toHaveBeenCalled();
    expect(repositories.completePayoutSentNotification)
      .toHaveBeenCalledWith('swap', 'existing-payout-message');
  });
});

function makeService(channel, repositories) {
  const service = new TicketService({
    client: { user: { id: 'bot' } },
    repositories,
    catalogue: {
      getAsset: (id) => id === 'ltc'
        ? { symbol: 'LTC', blockchain: 'ltc' }
        : { symbol: 'USDT', blockchain: 'bsc' },
    },
    coinPolicy: {},
    emojis: {},
    oneClick: {},
    config: {},
    health: {},
    logger: { warn: vi.fn(), info: vi.fn() },
  });
  service.completionChannel = channel;
  service.completionGif = Buffer.from('gif');
  return service;
}

function repositoryMocks(completed) {
  return {
    claimCompletionSummary: vi.fn().mockResolvedValue(completed),
    completeCompletionSummary: vi.fn().mockResolvedValue(undefined),
    releaseCompletionSummary: vi.fn().mockResolvedValue(undefined),
  };
}

function swap() {
  return {
    id: 'swap',
    user_id: '123456789012345678',
    status: 'SUCCESS',
    origin_asset_id: 'ltc',
    destination_asset_id: 'usdt',
    amount_display: '1',
    amount_usd_requested: '100',
    recipient: 'recipient',
    refund_to: 'refund',
    deposit_address: 'deposit-address',
    terminal_at: new Date('2026-08-06T12:00:00Z'),
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
  };
}
