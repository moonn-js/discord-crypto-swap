import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

describe('ticket chat input', () => {
  it('accepts USD, receiving address, and refund address as three owner messages', async () => {
    const origin = {
      assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8,
      price: '100', priceUpdatedAt: new Date().toISOString(),
    };
    const destination = {
      assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18,
      price: '2000', priceUpdatedAt: new Date().toISOString(),
    };
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'USD_AMOUNT',
      state_data: { originAssetId: 'ltc', destinationAssetId: 'eth' },
    };
    const updates = [];
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      saveUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain, address) => address),
      updateTicketFlowIfStep: async (id, expected, next, data) => {
        if (ticket.step !== expected) return null;
        ticket.step = next;
        ticket.state_data = JSON.parse(JSON.stringify(data));
        updates.push({ id, expected, next, data: JSON.parse(JSON.stringify(data)) });
        return ticket;
      },
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    service.renderProgress = vi.fn();
    service.createPreviewFromChat = vi.fn();

    await service.handleMessage(message('$25'));
    expect(updates.at(-1)).toMatchObject({
      next: 'RECIPIENT_ADDRESS',
      data: { amountUsdRequested: '25.00', amountBase: '25000000', amountDisplay: '0.25' },
    });

    const recipient = `0x${'a'.repeat(40)}`;
    await service.handleMessage(message(recipient));
    expect(updates.at(-1)).toMatchObject({ next: 'REFUND_ADDRESS', data: { recipient } });

    await service.handleMessage(message('ltc-refund-address'));
    expect(updates.at(-1)).toMatchObject({ next: 'QUOTE_LOADING', data: { refundTo: 'ltc-refund-address' } });
    expect(service.createPreviewFromChat).toHaveBeenCalledOnce();
  });

  it.each(['USDT', 'USDC'])('uses the exact %s token amount instead of converting USD', async (symbol) => {
    const origin = {
      assetId: 'usdt-bsc', symbol, blockchain: 'bsc', decimals: 18,
      price: '0.9992040304', priceUpdatedAt: new Date().toISOString(),
    };
    const destination = {
      assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8,
      price: '100', priceUpdatedAt: new Date().toISOString(),
    };
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'USD_AMOUNT',
      state_data: { originAssetId: 'usdt-bsc', destinationAssetId: 'ltc' },
    };
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      updateTicketFlowIfStep: async (id, expected, next, data) => {
        if (ticket.step !== expected) return null;
        ticket.step = next;
        ticket.state_data = JSON.parse(JSON.stringify(data));
        return ticket;
      },
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    service.renderProgress = vi.fn();

    await service.handleMessage(message(`1040 ${symbol}`));

    expect(ticket.state_data).toMatchObject({
      amountUsdRequested: '1039.17',
      amountBase: '1040000000000000000000',
      amountDisplay: '1040',
    });
  });

  it('reuses the latest address saved for each blockchain when the owner types yes', async () => {
    const origin = { assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8 };
    const destination = { assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18 };
    const recipient = `0x${'b'.repeat(40)}`;
    const refundTo = 'ltc-saved-refund-address';
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'RECIPIENT_ADDRESS',
      state_data: { originAssetId: 'ltc', destinationAssetId: 'eth' },
    };
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain) => (
        blockchain === 'eth' ? recipient : refundTo
      )),
      saveUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain, address) => address),
      updateTicketFlowIfStep: async (id, expected, next, data) => {
        if (ticket.step !== expected) return null;
        ticket.step = next;
        ticket.state_data = JSON.parse(JSON.stringify(data));
        return ticket;
      },
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    service.renderProgress = vi.fn();
    service.createPreviewFromChat = vi.fn();

    await service.handleMessage(message('yes'));
    expect(ticket.state_data).toMatchObject({ recipient, rememberedRefundAddress: refundTo });

    await service.handleMessage(message('YES'));
    expect(ticket.state_data).toMatchObject({ refundTo });
    expect(service.createPreviewFromChat).toHaveBeenCalledOnce();
    expect(repositories.saveUserChainAddress).not.toHaveBeenCalled();
  });

  it('asks for an address when yes is entered without a saved address', async () => {
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'RECIPIENT_ADDRESS',
      state_data: { destinationAssetId: 'eth' },
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      saveUserChainAddress: vi.fn(),
    };
    const service = makeService({
      repositories,
      assets: [{ assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18 }],
    });
    const reply = vi.fn().mockResolvedValue(undefined);

    await service.handleMessage(message('yes', reply));

    expect(reply.mock.calls[0][0].content).toContain('do not have a saved address');
    expect(repositories.saveUserChainAddress).not.toHaveBeenCalled();
  });

  it('hydrates saved addresses for tickets already waiting on an address after restart', async () => {
    const repositories = { getUserChainAddress: vi.fn().mockResolvedValue('saved-sol-address') };
    const service = makeService({
      repositories,
      assets: [{ assetId: 'sol', symbol: 'SOL', blockchain: 'sol', decimals: 9 }],
    });
    const ticket = {
      guild_id: 'guild', user_id: 'owner', step: 'RECIPIENT_ADDRESS',
      state_data: { destinationAssetId: 'sol' },
    };

    await expect(service.withRememberedAddress(ticket)).resolves.toMatchObject({
      state_data: { rememberedRecipientAddress: 'saved-sol-address' },
    });
    expect(repositories.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'sol');
  });

  it('remembers both addresses after the provider accepts the preview quote', async () => {
    const repositories = {
      getTicket: vi.fn().mockResolvedValue({ guild_id: 'guild', user_id: 'owner' }),
      saveUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain, address) => address),
    };
    const service = makeService({ repositories });

    await expect(service.rememberUserAddresses(
      'ticket',
      { blockchain: 'ltc' },
      { blockchain: 'eth' },
      { recipient: `0x${'c'.repeat(40)}`, refundTo: 'ltc-refund' },
    )).resolves.toBe(true);
    expect(repositories.saveUserChainAddress).toHaveBeenNthCalledWith(1, 'guild', 'owner', 'eth', `0x${'c'.repeat(40)}`);
    expect(repositories.saveUserChainAddress).toHaveBeenNthCalledWith(2, 'guild', 'owner', 'ltc', 'ltc-refund');
  });

  it('rejects malformed USD without logging the message contents', async () => {
    const logger = { warn: vi.fn() };
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'USD_AMOUNT',
      state_data: { originAssetId: 'ltc', destinationAssetId: 'eth' },
    };
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      updateTicketFlowIfStep: vi.fn(),
    };
    const service = makeService({
      repositories,
      logger,
      assets: [{
        assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8,
        price: '100', priceUpdatedAt: new Date().toISOString(),
      }],
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.handleMessage(message('$9.99 PRIVATE', reply));
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0].content).toContain('at most two decimal places');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE');
    expect(repositories.updateTicketFlowIfStep).not.toHaveBeenCalled();
    expect(repositories.touchTicket).toHaveBeenCalledWith('ticket');
  });

  it('submits an owner-pasted transaction ID and immediately refreshes tracking', async () => {
    const transactionId = 'a'.repeat(64);
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const swap = {
      id: 'swap', ticket_id: 'ticket', status: 'PENDING_DEPOSIT', executable_quote: { quote: {} },
      deposit_address: 'deposit-address', deposit_memo: null, deposit_tx_hash: null,
    };
    const saved = { ...swap, deposit_tx_hash: transactionId };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue(swap),
      saveDepositTransactionHash: vi.fn().mockResolvedValue(saved),
    };
    const oneClick = {
      submitDepositTransaction: vi.fn().mockResolvedValue({ status: 'KNOWN_DEPOSIT_TX' }),
      safeErrorLogFields: vi.fn().mockReturnValue({ errorCode: 'NONE' }),
    };
    const health = { oneClickAuthentication: false };
    const service = makeService({ repositories, oneClick, health });
    service.renderProgress = vi.fn().mockResolvedValue(undefined);
    const statusWorker = { refreshSwap: vi.fn().mockResolvedValue(saved) };
    service.setStatusWorker(statusWorker);
    const reply = vi.fn().mockResolvedValue(undefined);

    await service.handleMessage(message(transactionId, reply));

    expect(oneClick.submitDepositTransaction).toHaveBeenCalledWith(swap, transactionId);
    expect(repositories.saveDepositTransactionHash).toHaveBeenCalledWith('ticket', transactionId);
    expect(service.renderProgress).toHaveBeenCalledWith('ticket');
    expect(statusWorker.refreshSwap).toHaveBeenCalledWith(saved, { announce: true, rethrow: false });
    expect(reply.mock.calls[0][0].content).toContain('Transaction ID submitted');
    expect(health.oneClickAuthentication).toBe(true);
  });

  it('silently ignores non-transaction chat in an active ticket without contacting the provider', async () => {
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue({
        status: 'PENDING_DEPOSIT', executable_quote: { quote: {} }, deposit_tx_hash: null,
      }),
      saveDepositTransactionHash: vi.fn(),
    };
    const oneClick = { submitDepositTransaction: vi.fn() };
    const service = makeService({ repositories, oneClick });
    const reply = vi.fn().mockResolvedValue(undefined);

    const handled = await service.handleMessage(message('I sent it', reply));

    expect(oneClick.submitDepositTransaction).not.toHaveBeenCalled();
    expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
    expect(repositories.touchTicket).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it('stops treating chat messages as transaction submissions after one is saved', async () => {
    const transactionId = 'a'.repeat(64);
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue({
        status: 'PENDING_DEPOSIT', executable_quote: { quote: {} }, deposit_tx_hash: transactionId,
      }),
      saveDepositTransactionHash: vi.fn(),
    };
    const oneClick = { submitDepositTransaction: vi.fn() };
    const service = makeService({ repositories, oneClick });
    const reply = vi.fn().mockResolvedValue(undefined);

    const handled = await service.handleMessage(message('b'.repeat(64), reply));

    expect(oneClick.submitDepositTransaction).not.toHaveBeenCalled();
    expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
    expect(repositories.touchTicket).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it('silently ignores a transaction ID that the provider cannot match', async () => {
    const transactionId = 'a'.repeat(64);
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue({
        status: 'PENDING_DEPOSIT', executable_quote: { quote: {} }, deposit_tx_hash: null,
      }),
      saveDepositTransactionHash: vi.fn(),
    };
    const oneClick = {
      submitDepositTransaction: vi.fn().mockRejectedValue(new Error('not matched')),
      classifyError: vi.fn().mockReturnValue({ code: 'DEPOSIT_TX_REJECTED', userMessage: 'Invalid transaction ID.' }),
      safeErrorLogFields: vi.fn().mockReturnValue({ errorCode: 'DEPOSIT_TX_REJECTED' }),
    };
    const service = makeService({ repositories, oneClick });
    const reply = vi.fn().mockResolvedValue(undefined);

    const handled = await service.handleMessage(message(transactionId, reply));

    expect(oneClick.submitDepositTransaction).toHaveBeenCalledWith(expect.anything(), transactionId);
    expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it('returns amount and liquidity quote failures to the USD step without clearing addresses', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const error = Object.assign(new Error('too high'), { status: 400 });
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: {},
      emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(error),
        classifyError: () => ({ code: 'AMOUNT_TOO_HIGH', status: 400, userMessage: 'Enter a smaller amount.' }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_HIGH' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const data = {
      originAssetId: 'ltc', destinationAssetId: 'usdt', amountBase: '1', amountDisplay: '1',
      amountUsdRequested: '25.00', recipient: 'recipient', refundTo: 'refund',
    };

    await service.createPreviewFromChat('ticket', data, sourceMessage);

    expect(repositories.updateTicketFlowIfStep).toHaveBeenCalledWith('ticket', 'QUOTE_LOADING', 'USD_AMOUNT', data);
    expect(data).toMatchObject({ recipient: 'recipient', refundTo: 'refund' });
  });

  it('suggests another network or retrying later when no solver is available', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const sol = { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const error = Object.assign(new Error('no route'), { status: 400 });
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination, sol].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: {
        getAssetsForCoin: (coin) => ({ LTC: [origin], USDT: [destination], SOL: [sol] })[coin] ?? [],
      },
      emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(error),
        getFixedFloatIndicativeQuote: vi.fn().mockResolvedValue({ amountInUsd: '100', amountOutUsd: '98.75' }),
        classifyError: () => ({
          code: 'NO_LIQUIDITY_ROUTE',
          status: 400,
          userMessage: 'No solvers are available for this swap right now.',
        }),
        safeErrorLogFields: () => ({ errorCode: 'NO_LIQUIDITY_ROUTE' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const data = {
      originAssetId: origin.assetId,
      destinationAssetId: destination.assetId,
      amountBase: '100000000',
      amountDisplay: '1',
      amountUsdRequested: '100.00',
      recipient: 'recipient',
      refundTo: 'refund',
    };

    const result = await service.createPreviewFromChat('ticket', data, sourceMessage);

    expect(result.userMessage).toBe(
      "No solvers are available for LTC → USDT on BNB Chain right now. If you'd like, you can use our backup provider.",
    );
    expect(sourceMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: result.userMessage }));
    const buttons = sourceMessage.reply.mock.calls[0][0].components[0].toJSON().components;
    expect(buttons.map(button => button.custom_id)).toEqual(['t:ticket:use-backup', 't:ticket:watch-exact']);
    expect(buttons[0]).toMatchObject({ label: 'Use backup · 1.25% quote', style: 1 });
    expect(buttons[1]).toMatchObject({ label: 'Notify me when available', style: 2 });
  });

  it('offers FixedFloat when 1Click minimum is too high but FixedFloat supports the amount', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const getFixedFloatIndicativeQuote = vi.fn().mockResolvedValue({ amountInUsd: '200', amountOutUsd: '198' });
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] },
      emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(new Error('minimum is $1000')),
        getFixedFloatIndicativeQuote,
        classifyError: () => ({
          code: 'AMOUNT_TOO_LOW',
          status: 400,
          userMessage: 'The amount is below the current minimum.',
          routeLimit: { kind: 'minimum', usd: '1000.00', display: '$1,000.00' },
        }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_LOW' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const data = {
      originAssetId: origin.assetId,
      destinationAssetId: destination.assetId,
      amountBase: '400000000',
      amountDisplay: '4',
      amountUsdRequested: '200.00',
      recipient: 'recipient',
      refundTo: 'refund',
    };

    const result = await service.createPreviewFromChat('ticket', data, sourceMessage);

    expect(getFixedFloatIndicativeQuote).toHaveBeenCalledWith({ originAsset: origin, destinationAsset: destination, amountBase: '400000000' });
    expect(result.userMessage).toBe("The amount is below the minimum available for this route. Current route minimum: $1,000.00. If you'd like, you can use our backup provider for this transaction.");
    expect(result.userPayload.components[0].toJSON().components.map(button => button.custom_id)).toEqual([
      't:ticket:use-backup',
      't:ticket:watch-exact',
    ]);
    expect(data.noRouteOffer).toBe(JSON.stringify(['ltc', 'usdt-bsc', '400000000', 'recipient', 'refund']));
  });

  it('keeps the normal minimum message when FixedFloat also rejects the amount', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const service = new TicketService({
      client: {}, repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] }, emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(new Error('minimum is $1000')),
        canUseFixedFloat: vi.fn().mockResolvedValue(false),
        classifyError: () => ({ code: 'AMOUNT_TOO_LOW', status: 400, userMessage: 'The amount is below the minimum available for this route.' }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_LOW' }),
      },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();

    const result = await service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId,
      amountBase: '400000000', amountDisplay: '4', amountUsdRequested: '200.00',
      recipient: 'recipient', refundTo: 'refund',
    }, sourceMessage);

    expect(result.userMessage).toBe('The amount is below the minimum available for this route.');
    expect(result.userPayload).toEqual({ content: result.userMessage });
  });

  it('does not offer the backup again when an already-selected backup has no route', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const getVerifiedQuote = vi.fn().mockRejectedValue(new Error('FixedFloat does not support this route'));
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] },
      emojis: {},
      oneClick: {
        getVerifiedQuote,
        classifyError: () => ({ code: 'NO_LIQUIDITY_ROUTE', status: null, userMessage: 'FixedFloat does not support this route.' }),
        safeErrorLogFields: () => ({ errorCode: 'NO_LIQUIDITY_ROUTE' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();

    const result = await service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId,
      destinationAssetId: destination.assetId,
      amountBase: '100000000',
      amountDisplay: '1',
      amountUsdRequested: '100.00',
      recipient: 'recipient',
      refundTo: 'refund',
      backupConsent: true,
    }, sourceMessage);

    expect(getVerifiedQuote).toHaveBeenCalledWith(expect.objectContaining({ provider: 'fixedfloat', backupConsent: true }));
    expect(result.userMessage).toBe('The backup provider is unavailable for this route right now. Try a different amount or choose another route.');
    expect(result.userPayload).toEqual({ content: result.userMessage });
  });
});

function makeService({
  repositories,
  assets = [],
  logger = { warn: () => {} },
  oneClick = {},
  health = {},
}) {
  return new TicketService({
    client: {},
    repositories,
    catalogue: { getAsset: (id) => assets.find((asset) => asset.assetId === id) ?? null },
    coinPolicy: {},
    emojis: {},
    oneClick,
    config: {},
    health,
    logger,
  });
}

function message(content, reply = vi.fn().mockResolvedValue(undefined)) {
  return {
    guildId: 'guild',
    channelId: 'channel',
    author: { id: 'owner', bot: false },
    content,
    webhookId: null,
    reply,
  };
}
