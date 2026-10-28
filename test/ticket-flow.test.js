import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

const definitions = {
  LTC: { key: 'LTC', group: 'featured' },
  ETH: { key: 'ETH', group: 'featured' },
  USDT: { key: 'USDT', group: 'featured' },
  USDC: { key: 'USDC', group: 'featured' },
  AVAX: { key: 'AVAX', group: 'other' },
};
const assets = {
  LTC: [{ assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8, price: 50 }],
  ETH: [
    { assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18, price: 2_000 },
    { assetId: 'arb', symbol: 'ETH', blockchain: 'arb', decimals: 18, price: 2_000 },
  ],
  USDT: [
    { assetId: 'usdt-bsc', symbol: 'USDT', blockchain: 'bsc', decimals: 18, price: 1 },
    { assetId: 'usdt-eth', symbol: 'USDT', blockchain: 'eth', decimals: 6, price: 1 },
  ],
  USDC: [
    { assetId: 'usdc-eth', symbol: 'USDC', blockchain: 'eth', decimals: 6, price: 1 },
    { assetId: 'usdc-sol', symbol: 'USDC', blockchain: 'sol', decimals: 6, price: 1 },
  ],
  AVAX: [{ assetId: 'avax', symbol: 'AVAX', blockchain: 'avax', decimals: 18, price: 25 }],
};
const policy = {
  getCoin: (key) => definitions[key] ?? null,
  getAssetsForCoin: (key, exclude) => (assets[key] ?? []).filter((asset) => asset.assetId !== exclude),
};

describe('coin-first ticket transitions', () => {
  it.each([
    ['popular-ltc-usdt-bsc', 'ltc', 'usdt-bsc'],
    ['popular-usdt-bsc-ltc', 'usdt-bsc', 'ltc'],
    ['popular-ltc-usdt-eth', 'ltc', 'usdt-eth'],
  ])('selects both assets for the %s shortcut', async (action, originAssetId, destinationAssetId) => {
    const getVerifiedQuote = vi.fn().mockResolvedValue({ quote: { amountOut: '1', minAmountOut: '1' } });
    const { service, updates } = makeService({ oneClick: { getVerifiedQuote } });

    const interaction = buttonInteraction();
    await service.routeTicketInteraction(interaction, ticket('ORIGIN_COIN'), action);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(getVerifiedQuote).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      expected: 'ORIGIN_COIN',
      step: 'USD_AMOUNT',
      data: { originAssetId, destinationAssetId },
    });
  });

  it('starts the backup flow immediately from an unavailable popular pick', async () => {
    const { service, updates } = makeService();
    const interaction = buttonInteraction();
    await service.routeTicketInteraction(
      interaction,
      ticket('ORIGIN_COIN'),
      'use-backup-popular',
      'popular-ltc-usdt-bsc',
    );

    expect(updates.at(-1)).toMatchObject({
      expected: 'ORIGIN_COIN',
      step: 'USD_AMOUNT',
      data: { originAssetId: 'ltc', destinationAssetId: 'usdt-bsc', backupConsent: true },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Backup selected. Continue in the ticket below.',
      components: [],
    }));
  });

  it('enables a persistent route watch and pauses inactivity handling', async () => {
    const watched = { id: 'ticket-id', route_watch_action: 'popular-usdt-bsc-ltc' };
    const enableRouteWatch = vi.fn().mockResolvedValue(watched);
    const { service } = makeService({ repositories: { enableRouteWatch } });
    const interaction = buttonInteraction();

    await service.routeTicketInteraction(
      interaction,
      ticket('ORIGIN_COIN'),
      'watch-route',
      'popular-usdt-bsc-ltc',
    );

    expect(enableRouteWatch).toHaveBeenCalledWith('ticket-id', 'popular-usdt-bsc-ltc');
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Inactivity reminders and automatic inactivity closure are paused'),
      components: [],
    }));
  });

  it('pings the ticket owner and provides the popular pick when a watched route returns', async () => {
    const channel = {
      type: 0,
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
      send: vi.fn().mockResolvedValue({ id: 'notification' }),
    };
    const completeRouteWatchNotification = vi.fn().mockResolvedValue({ id: 'ticket-id' });
    const { service } = makeService({
      client: { user: { id: 'bot' }, channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      repositories: { completeRouteWatchNotification },
      oneClick: { getVerifiedQuote: vi.fn().mockResolvedValue({ quote: { amountOut: '1', minAmountOut: '1' } }) },
    });
    const claimedAt = new Date();

    await expect(service.checkWatchedPopularRoute({
      id: 'ticket-id',
      user_id: 'owner',
      channel_id: 'channel',
      route_watch_action: 'popular-usdt-bsc-ltc',
      route_watch_claimed_at: claimedAt,
    })).resolves.toBe(true);

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('<@owner>'),
      allowedMentions: { users: ['owner'] },
    }));
    const notification = channel.send.mock.calls[0][0];
    expect(notification.components[0].toJSON().components[0]).toMatchObject({
      custom_id: 't:ticket-id:popular-usdt-bsc-ltc',
      label: 'Use this route',
    });
    expect(completeRouteWatchNotification).toHaveBeenCalledWith('ticket-id', claimedAt, 'notification');
  });

  it('keeps a watch active without pinging while the route still has no solver', async () => {
    const error = Object.assign(new Error('No route'), { status: 400 });
    const completeRouteWatchCheck = vi.fn().mockResolvedValue(undefined);
    const client = { channels: { fetch: vi.fn() } };
    const { service } = makeService({
      client,
      repositories: { completeRouteWatchCheck },
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(error),
        classifyError: vi.fn().mockReturnValue({ code: 'NO_LIQUIDITY_ROUTE' }),
      },
    });
    const claimedAt = new Date();

    await expect(service.checkWatchedPopularRoute({
      id: 'ticket-id',
      route_watch_action: 'popular-ltc-usdt-bsc',
      route_watch_claimed_at: claimedAt,
    })).resolves.toBe(false);

    expect(completeRouteWatchCheck).toHaveBeenCalledWith('ticket-id', claimedAt);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('auto-selects LTC and every other single-network coin', async () => {
    const { service, updates } = makeService();
    await service.routeTicketInteraction(selectInteraction('LTC'), ticket('ORIGIN_COIN'), 'select-origin-coin');
    expect(updates.at(-1)).toMatchObject({
      step: 'DESTINATION_COIN',
      data: { originCoin: 'LTC', originAssetId: 'ltc', originNetworkAutoSelected: true },
    });

    await service.routeTicketInteraction(selectInteraction('AVAX'), ticket('ORIGIN_OTHER'), 'select-origin-other');
    expect(updates.at(-1)).toMatchObject({
      step: 'DESTINATION_COIN',
      data: { originCoin: 'AVAX', originCoinGroup: 'other', originAssetId: 'avax' },
    });
  });

  it('requires a short network step for a multi-network coin', async () => {
    const { service, updates } = makeService();
    await service.routeTicketInteraction(selectInteraction('ETH'), ticket('ORIGIN_COIN'), 'select-origin-coin');
    expect(updates.at(-1)).toMatchObject({ step: 'ORIGIN_NETWORK', data: { originCoin: 'ETH', originAssetId: null } });

    await service.routeTicketInteraction(
      selectInteraction('arb'),
      ticket('ORIGIN_NETWORK', { originCoin: 'ETH', originCoinGroup: 'featured' }),
      'select-origin-network',
    );
    expect(updates.at(-1)).toMatchObject({ step: 'DESTINATION_COIN', data: { originAssetId: 'arb', originNetworkAutoSelected: false } });
  });

  it('allows same-coin cross-network selection and blocks exact asset-to-itself', async () => {
    const { service, updates } = makeService();
    const state = { originCoin: 'USDC', originCoinGroup: 'featured', originAssetId: 'usdc-eth' };
    await service.routeTicketInteraction(selectInteraction('USDC'), ticket('DESTINATION_COIN', state), 'select-destination-coin');
    expect(updates.at(-1)).toMatchObject({
      step: 'USD_AMOUNT',
      data: { destinationCoin: 'USDC', destinationAssetId: 'usdc-sol', destinationNetworkAutoSelected: true },
    });

    await expect(service.routeTicketInteraction(
      selectInteraction('LTC'),
      ticket('DESTINATION_COIN', { originAssetId: 'ltc' }),
      'select-destination-coin',
    )).rejects.toThrow('send an asset to itself');
  });
});

function makeService({ oneClick = {}, repositories: repositoryOverrides = {}, client = {} } = {}) {
  const updates = [];
  const repositories = {
    updateTicketFlow: async (id, step, data) => {
      updates.push({ id, step, data: JSON.parse(JSON.stringify(data)) });
      return { id, step, state_data: data };
    },
    updateTicketFlowIfStep: async (id, expected, step, data) => {
      updates.push({ id, expected, step, data: JSON.parse(JSON.stringify(data)) });
      return { id, step, state_data: data };
    },
    ...repositoryOverrides,
  };
  const service = new TicketService({
    client,
    repositories,
    catalogue: { getAsset: (id) => Object.values(assets).flat().find((asset) => asset.assetId === id) ?? null },
    coinPolicy: policy,
    emojis: { get: () => '🔹' },
    oneClick,
    config: {},
    health: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
  service.renderProgress = async () => {};
  return { service, updates };
}

function selectInteraction(value) {
  return {
    values: [value],
    deferred: false,
    replied: false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    deferUpdate: async function deferUpdate() { this.deferred = true; },
  };
}

function buttonInteraction() {
  const interaction = {
    deferred: false,
    replied: false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  interaction.deferUpdate = vi.fn(async () => { interaction.deferred = true; });
  return interaction;
}

function ticket(step, stateData = {}) {
  return { id: 'ticket-id', step, state_data: stateData };
}
