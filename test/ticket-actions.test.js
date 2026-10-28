import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

describe('ticket owner actions', () => {
  it('counts every owner control interaction as ticket activity', async () => {
    const activeTicket = ticket({ user_id: 'owner' });
    const repositories = {
      getTicket: vi.fn().mockResolvedValue(activeTicket),
      touchTicket: vi.fn().mockResolvedValue(activeTicket),
    };
    const service = makeService({ channel: null, repositories });
    service.routeTicketInteraction = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: 't:ticket:back',
      channelId: 'channel',
      user: { id: 'owner' },
      isButton: () => false,
    };

    await service.handleInteraction(interaction);

    expect(repositories.touchTicket).toHaveBeenCalledWith('ticket');
    expect(service.routeTicketInteraction).toHaveBeenCalledWith(interaction, activeTicket, 'back');
  });

  it('backs out to the refund step while a quote is loading', async () => {
    const service = makeService({ channel: null, repositories: {} });
    service.updateAndRender = vi.fn().mockResolvedValue({ id: 'ticket' });
    const loadingTicket = ticket({ step: 'QUOTE_LOADING', state_data: { refundTo: 'refund' } });
    const interaction = buttonInteraction(null);

    await service.routeTicketInteraction(interaction, loadingTicket, 'back');

    expect(service.updateAndRender).toHaveBeenCalledWith(
      interaction,
      'ticket',
      'REFUND_ADDRESS',
      loadingTicket.state_data,
      { append: false, expectedStep: 'QUOTE_LOADING' },
    );
  });

  it('identifies a Back button from an old progress message', async () => {
    const service = makeService({ channel: null, repositories: {} });
    const activeTicket = ticket({ step: 'ACTIVE', progress_message_id: 'latest-message' });
    const interaction = buttonInteraction(null);
    interaction.message = { id: 'old-message' };

    await service.routeTicketInteraction(interaction, activeTicket, 'back');

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'That Back button belongs to an earlier step. Use the Back button in the latest message.',
    }));
  });

  it('DMs the owner after an inactivity closure without surfacing DM failures', async () => {
    const send = vi.fn().mockRejectedValue(new Error('DMs disabled'));
    const service = makeService({ channel: null, repositories: {} });
    service.client.users = { fetch: vi.fn().mockResolvedValue({ send }) };
    service.config.ticketInactivityMs = 30 * 60_000;

    await expect(service.notifyInactivityClosure(ticket({ user_id: 'owner' }))).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledWith(expect.stringContaining('closed after 30 minutes of inactivity'));
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INACTIVITY_DM_FAILED', userId: 'owner' }),
      'Could not send inactivity closure DM',
    );
  });

  it('requires confirmation before deleting a ticket mid-deal', async () => {
    const channel = { type: ChannelType.GuildText, delete: vi.fn().mockResolvedValue(undefined) };
    const repositories = {
      getTicket: vi.fn().mockResolvedValue(ticket()),
      getSwapByTicket: vi.fn().mockResolvedValue(swap()),
      markTicketDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ channel, repositories });
    const close = buttonInteraction(channel);

    await service.routeTicketInteraction(close, ticket(), 'close');

    expect(close.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: 64 }));
    expect(close.reply.mock.calls[0][0].embeds[0].toJSON().description).toContain('does not cancel the swap');
    expect(channel.delete).not.toHaveBeenCalled();

    const confirm = buttonInteraction(channel);
    await service.routeTicketInteraction(confirm, ticket(), 'close-confirm');
    expect(confirm.deferUpdate).toHaveBeenCalledOnce();
    expect(channel.delete).toHaveBeenCalledWith('Closed by the ticket owner after confirmation');
    expect(repositories.markTicketDeleted).toHaveBeenCalledWith('ticket');
  });

  it('dismisses the close confirmation without changing the ticket', async () => {
    const channel = { type: ChannelType.GuildText, delete: vi.fn() };
    const repositories = { markTicketDeleted: vi.fn() };
    const service = makeService({ channel, repositories });
    const interaction = buttonInteraction(channel);

    await service.routeTicketInteraction(interaction, ticket(), 'close-cancel');

    expect(interaction.update).toHaveBeenCalledWith({ content: 'Ticket kept open.', embeds: [], components: [] });
    expect(channel.delete).not.toHaveBeenCalled();
    expect(repositories.markTicketDeleted).not.toHaveBeenCalled();
  });

  it('closes immediately from the final completed message', async () => {
    const channel = { type: ChannelType.GuildText, delete: vi.fn().mockResolvedValue(undefined) };
    const terminalTicket = ticket({ step: 'TERMINAL' });
    const repositories = {
      getTicket: vi.fn().mockResolvedValue(terminalTicket),
      markTicketDeleted: vi.fn().mockResolvedValue(undefined),
      getSwapByTicket: vi.fn(),
    };
    const service = makeService({ channel, repositories });
    const interaction = buttonInteraction(channel);

    await service.routeTicketInteraction(interaction, terminalTicket, 'close');

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(channel.delete).toHaveBeenCalledWith('Closed by the ticket owner after completion');
  });

  it('refreshes the quote in place from the review message', async () => {
    const service = makeService({ channel: null, repositories: {} });
    service.updateAndRender = vi.fn().mockResolvedValue({ id: 'ticket' });
    service.createPreviewFromChat = vi.fn().mockResolvedValue({ ok: true });
    const previewTicket = ticket({ step: 'PREVIEW', state_data: { amountBase: '100' } });
    const interaction = buttonInteraction(null);

    await service.routeTicketInteraction(interaction, previewTicket, 'refresh-preview');

    expect(service.updateAndRender).toHaveBeenCalledWith(
      interaction,
      'ticket',
      'QUOTE_LOADING',
      previewTicket.state_data,
      { append: false, expectedStep: 'PREVIEW' },
    );
    expect(service.createPreviewFromChat).toHaveBeenCalledWith('ticket', previewTicket.state_data, null);
  });

  it('checks both quote legs before showing a verified alternative route', async () => {
    const origin = { assetId: 'sol', symbol: 'SOL', blockchain: 'sol', decimals: 9 };
    const bridge = { assetId: 'usdc-bsc', symbol: 'USDC', blockchain: 'bsc', decimals: 18 };
    const destination = { assetId: 'usdt-bsc', symbol: 'USDT', blockchain: 'bsc', decimals: 18 };
    const coinPolicy = {
      getAssetsForCoin: (coin) => ({ SOL: [origin], USDC: [bridge], USDT: [destination] })[coin] ?? [],
    };
    const oneClick = {
      getVerifiedQuote: vi.fn()
        .mockResolvedValueOnce({ quote: { minAmountOut: '50000000000000000000', amountOutFormatted: '50' } })
        .mockResolvedValueOnce({ quote: { minAmountOut: '49500000000000000000', amountOutFormatted: '49.5' } }),
      classifyError: vi.fn(),
      safeErrorLogFields: vi.fn(),
    };
    const service = makeService({
      channel: null,
      repositories: {},
      assets: [origin, bridge, destination],
      coinPolicy,
      oneClick,
    });
    const unavailableTicket = ticket({
      step: 'USD_AMOUNT',
      state_data: {
        originAssetId: origin.assetId,
        destinationAssetId: destination.assetId,
        amountBase: '1000000000',
        recipient: 'bsc-recipient',
        refundTo: 'sol-refund',
      },
    });
    const interaction = buttonInteraction(null);

    await service.routeTicketInteraction(interaction, unavailableTicket, 'check-routes');

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(oneClick.getVerifiedQuote).toHaveBeenNthCalledWith(1, {
      dry: true,
      originAsset: origin,
      destinationAsset: bridge,
      amountBase: '1000000000',
      recipient: 'bsc-recipient',
      refundTo: 'sol-refund',
    });
    expect(oneClick.getVerifiedQuote).toHaveBeenNthCalledWith(2, {
      dry: true,
      originAsset: bridge,
      destinationAsset: destination,
      amountBase: '50000000000000000000',
      recipient: 'bsc-recipient',
      refundTo: 'bsc-recipient',
    });
    expect(interaction.editReply.mock.calls[0][0].content).toContain(
      'SOL → USDC on BNB Chain → USDT on BNB Chain',
    );
    expect(interaction.editReply.mock.calls[0][0].content).toContain('~49.5 USDT');
    expect(interaction.editReply.mock.calls[0][0].content).toContain('two separate swaps');

    const repeatedInteraction = buttonInteraction(null);
    await service.routeTicketInteraction(repeatedInteraction, unavailableTicket, 'check-routes');
    expect(repeatedInteraction.reply.mock.calls[0][0].content).toMatch(/^Wait \d+ seconds before checking routes again\.$/);
    expect(oneClick.getVerifiedQuote).toHaveBeenCalledTimes(2);
  });

  it('reports when no two-step route passes both quote checks', async () => {
    const origin = { assetId: 'sol', symbol: 'SOL', blockchain: 'sol', decimals: 9 };
    const bridge = { assetId: 'usdc-bsc', symbol: 'USDC', blockchain: 'bsc', decimals: 18 };
    const destination = { assetId: 'usdt-bsc', symbol: 'USDT', blockchain: 'bsc', decimals: 18 };
    const quoteError = Object.assign(new Error('no route'), { status: 400 });
    const oneClick = {
      getVerifiedQuote: vi.fn().mockRejectedValue(quoteError),
      classifyError: vi.fn().mockReturnValue({ code: 'NO_LIQUIDITY_ROUTE', status: 400 }),
      safeErrorLogFields: vi.fn().mockReturnValue({ errorCode: 'NO_LIQUIDITY_ROUTE' }),
    };
    const service = makeService({
      channel: null,
      repositories: {},
      assets: [origin, bridge, destination],
      coinPolicy: {
        getAssetsForCoin: (coin) => ({ SOL: [origin], USDC: [bridge], USDT: [destination] })[coin] ?? [],
      },
      oneClick,
    });
    const unavailableTicket = ticket({
      step: 'USD_AMOUNT',
      state_data: {
        originAssetId: origin.assetId,
        destinationAssetId: destination.assetId,
        amountBase: '1000000000',
        recipient: 'bsc-recipient',
        refundTo: 'sol-refund',
      },
    });
    const interaction = buttonInteraction(null);

    await service.routeTicketInteraction(interaction, unavailableTicket, 'check-routes');

    expect(oneClick.getVerifiedQuote).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'No verified two-step routes are available right now. Try another network or check again later.',
    }));
  });

  it('posts the deposit address and exact coin amount as separate copyable messages', async () => {
    const channel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
    };
    const repositories = {
      getSwapByTicket: vi.fn().mockResolvedValue(swap()),
    };
    const service = makeService({ channel, repositories });

    await service.routeTicketInteraction(buttonInteraction(channel), ticket(), 'show-deposit');

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[0][0].content).toBe('deposit-address');
    expect(channel.send.mock.calls[1][0].content).toBe('1.25');
  });

  it('posts the deposit address and remaining coin amount from an incomplete-deposit button', async () => {
    const channel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({}),
    };
    const repositories = {
      getSwapByTicket: vi.fn().mockResolvedValue(swap({
        status: 'INCOMPLETE_DEPOSIT',
        executable_quote: { quote: { amountIn: '125000000', amountInFormatted: '1.25' } },
        last_status_response: {
          status: 'INCOMPLETE_DEPOSIT',
          swapDetails: { depositedAmount: '100000000' },
        },
      })),
    };
    const service = makeService({ channel, repositories });

    await service.routeTicketInteraction(buttonInteraction(channel), ticket(), 'show-incomplete-deposit');

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[0][0].content).toBe('deposit-address');
    expect(channel.send.mock.calls[1][0].content).toBe('0.25');
  });

  it('attaches the QR image to the executable-swap progress message', async () => {
    const activeTicket = ticket({ progress_message_id: 'progress' });
    const activeSwap = swap({ qr_message_id: null });
    const progress = { id: 'progress', edit: vi.fn().mockResolvedValue(undefined) };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn().mockResolvedValue(progress) },
      send: vi.fn(),
    };
    const repositories = {
      getTicket: vi.fn().mockResolvedValue(activeTicket),
      getSwapByTicket: vi.fn().mockImplementation(async () => activeSwap),
      claimQrMessage: vi.fn().mockImplementation(async (_swapId, messageId) => {
        activeSwap.qr_message_id = messageId;
        return true;
      }),
      clearMissingQrMessage: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeService({ channel, repositories, qrService: { createDepositAddressPng: vi.fn().mockResolvedValue(Buffer.from('png')) } });

    await service.ensureDepositQr('ticket');

    expect(channel.send).not.toHaveBeenCalled();
    expect(repositories.claimQrMessage).toHaveBeenCalledWith('swap', 'progress');
    expect(progress.edit).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ name: 'deposit-address.png' })],
      attachments: [],
    }));
    const edited = progress.edit.mock.calls[0][0];
    expect(edited.embeds[0].toJSON().thumbnail.url).toBe('attachment://deposit-address.png');
  });

  it('posts one separate speedup message immediately after rendering the active swap', async () => {
    const order = [];
    const activeTicket = ticket({ progress_message_id: 'progress' });
    const activeSwap = swap({ deposit_speedup_message_id: null });
    const progress = {
      id: 'progress',
      edit: vi.fn().mockImplementation(async () => order.push('progress')),
    };
    const speedup = {
      id: 'speedup',
      edit: vi.fn().mockImplementation(async () => order.push('speedup-edit')),
      delete: vi.fn(),
    };
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockImplementation(async (query) => {
          if (query === 'progress') return progress;
          if (query === 'speedup') return speedup;
          return new Map();
        }),
      },
      send: vi.fn().mockImplementation(async () => {
        order.push('speedup-send');
        return speedup;
      }),
    };
    const repositories = {
      getTicket: vi.fn().mockResolvedValue(activeTicket),
      getSwapByTicket: vi.fn().mockImplementation(async () => activeSwap),
      claimDepositSpeedupMessage: vi.fn().mockImplementation(async (_swapId, messageId) => {
        activeSwap.deposit_speedup_message_id = messageId;
        return true;
      }),
      clearMissingDepositSpeedupMessage: vi.fn(),
    };
    const service = makeService({ channel, repositories });
    service.client.user = { id: 'bot' };

    await service.renderProgress('ticket');
    await service.renderProgress('ticket');

    expect(order.slice(0, 2)).toEqual(['progress', 'speedup-send']);
    expect(channel.send).toHaveBeenCalledOnce();
    expect(repositories.claimDepositSpeedupMessage).toHaveBeenCalledWith('swap', 'speedup');
    expect(channel.send.mock.calls[0][0].embeds[0].toJSON().title).toBe('⚡ Speed up deposit detection (optional)');
    expect(speedup.edit).toHaveBeenCalledOnce();
    expect(speedup.delete).not.toHaveBeenCalled();
  });

  it('removes the QR attachment when an automatically completed ticket is closed', async () => {
    const channel = {
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
    };
    const repositories = {
      scheduleTicketClosure: vi.fn().mockResolvedValue({
        ...ticket(),
        header_message_id: null,
      }),
    };
    const service = makeService({ channel, repositories });
    service.config.channelDeleteDelayMs = 5 * 60_000;
    service.editProgress = vi.fn().mockResolvedValue(undefined);

    await service.scheduleClosure('ticket', 'Swap reached terminal status: SUCCESS');

    expect(service.editProgress).toHaveBeenCalledWith('ticket', expect.objectContaining({
      attachments: [],
      components: [],
    }));
  });
});

function makeService({
  channel,
  repositories,
  qrService = null,
  assets = null,
  coinPolicy = null,
  oneClick = null,
}) {
  const availableAssets = assets ?? [
    { assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8 },
    { assetId: 'usdt', symbol: 'USDT', blockchain: 'bsc', decimals: 18 },
  ];
  return new TicketService({
    client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
    repositories,
    catalogue: { getAsset: (id) => availableAssets.find((asset) => asset.assetId === id) ?? null },
    coinPolicy: coinPolicy ?? {},
    emojis: {},
    oneClick: oneClick ?? {},
    qrService,
    config: {},
    health: {},
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
}

function buttonInteraction(channel) {
  return {
    channel,
    deferred: false,
    replied: false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferReply: vi.fn(async function deferReply() { this.deferred = true; }),
    deferUpdate: vi.fn(async function defer() { this.deferred = true; }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn(async function reply() { this.replied = true; }),
    update: vi.fn(async function update() { this.replied = true; }),
  };
}

function ticket(overrides = {}) {
  return {
    id: 'ticket',
    channel_id: 'channel',
    progress_message_id: 'progress',
    step: 'ACTIVE',
    state: 'OPEN',
    state_data: {},
    ...overrides,
  };
}

function swap(overrides = {}) {
  return {
    id: 'swap',
    ticket_id: 'ticket',
    status: 'PENDING_DEPOSIT',
    origin_asset_id: 'ltc',
    destination_asset_id: 'usdt',
    amount_display: '1.25',
    amount_usd_requested: '100',
    recipient: 'recipient',
    refund_to: 'refund',
    deposit_address: 'deposit-address',
    deposit_memo: '12345',
    quote_deadline: new Date(Date.now() + 60_000),
    executable_quote: { quote: { amountInFormatted: '1.25', amountOutFormatted: '99' } },
    ...overrides,
  };
}
