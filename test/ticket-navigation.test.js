import { describe, expect, it } from 'vitest';
import { previousVisibleStep } from '../src/services/ticket-service.js';

const policy = {
  getAssetsForCoin: (coin, exclude) => {
    const assets = {
      ETH: [{ assetId: 'eth' }, { assetId: 'arb' }],
      LTC: [{ assetId: 'ltc' }],
      USDC: [{ assetId: 'usdc-eth' }, { assetId: 'usdc-sol' }],
    }[coin] ?? [];
    return assets.filter((asset) => asset.assetId !== exclude);
  },
};

describe('conditional ticket Back navigation', () => {
  it('returns through a visible origin network screen for multi-network coins', () => {
    const data = { originCoin: 'ETH', originCoinGroup: 'featured', originAssetId: 'eth' };
    expect(previousVisibleStep('DESTINATION_COIN', data, policy)).toBe('ORIGIN_NETWORK');
  });

  it('skips the origin network screen for a single-network coin', () => {
    const data = { originCoin: 'LTC', originCoinGroup: 'featured', originAssetId: 'ltc' };
    expect(previousVisibleStep('DESTINATION_COIN', data, policy)).toBe('ORIGIN_COIN');
  });

  it('returns from amount to the destination network only when multiple choices remain', () => {
    const multi = { originAssetId: 'eth', destinationCoin: 'USDC', destinationCoinGroup: 'featured' };
    expect(previousVisibleStep('USD_AMOUNT', multi, policy)).toBe('DESTINATION_NETWORK');

    const single = { originAssetId: 'eth', destinationCoin: 'LTC', destinationCoinGroup: 'featured' };
    expect(previousVisibleStep('USD_AMOUNT', single, policy)).toBe('DESTINATION_COIN');
  });

  it('returns Other selections to their Other submenu', () => {
    const data = { originCoin: 'LTC', originCoinGroup: 'other', destinationCoin: 'LTC', destinationCoinGroup: 'other' };
    expect(previousVisibleStep('DESTINATION_COIN', data, policy)).toBe('ORIGIN_OTHER');
    expect(previousVisibleStep('DESTINATION_NETWORK', data, policy)).toBe('DESTINATION_OTHER');
  });

  it('lets a member back out while a quote is still loading', () => {
    expect(previousVisibleStep('QUOTE_LOADING', {}, policy)).toBe('REFUND_ADDRESS');
  });
});
