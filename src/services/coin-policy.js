export const OTHER_COIN_KEY = 'OTHER';

const NETWORK_LABELS = Object.freeze({
  aptos: 'Aptos',
  arb: 'Arbitrum',
  avax: 'Avalanche',
  base: 'Base',
  bch: 'Bitcoin Cash',
  bsc: 'BNB Chain',
  btc: 'Bitcoin',
  cardano: 'Cardano',
  doge: 'Dogecoin',
  eth: 'Ethereum',
  ltc: 'Litecoin',
  near: 'NEAR',
  op: 'Optimism',
  pol: 'Polygon',
  sol: 'Solana',
  stellar: 'Stellar',
  sui: 'Sui',
  ton: 'TON',
  tron: 'Tron',
  xrp: 'XRP Ledger',
  zec: 'Zcash',
});

const FEATURED_COINS = Object.freeze([
  coin('BTC', 'Bitcoin', [asset('btc', 'nep141:btc.omft.near')]),
  coin('ETH', 'Ethereum', [
    asset('eth', 'nep141:eth.omft.near'),
    asset('arb', 'nep141:arb.omft.near'),
    asset('base', 'nep141:base.omft.near'),
    asset('op', 'nep245:v2_1.omni.hot.tg:10_11111111111111111111'),
  ]),
  coin('SOL', 'Solana', [asset('sol', 'nep141:sol.omft.near')]),
  coin('LTC', 'Litecoin', [asset('ltc', 'nep141:ltc.omft.near')]),
  coin('USDT', 'Tether USD', [
    asset('eth', 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near'),
    asset('tron', 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near'),
    asset('bsc', 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g'),
    asset('sol', 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near'),
    asset('pol', 'nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr'),
  ]),
  coin('USDC', 'USD Coin', [
    asset('eth', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'),
    asset('bsc', 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r'),
    asset('base', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'),
    asset('arb', 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'),
    asset('sol', 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'),
    asset('pol', 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L'),
    asset('avax', 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o'),
  ]),
  coin('BNB', 'BNB', [asset('bsc', 'nep245:v2_1.omni.hot.tg:56_11111111111111111111')]),
  coin('POL', 'POL', [asset('pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111')]),
]);

const OTHER_COINS = Object.freeze([
  coin('AVAX', 'Avalanche', [asset('avax', 'nep245:v2_1.omni.hot.tg:43114_11111111111111111111')], 'other'),
  coin('DOGE', 'Dogecoin', [asset('doge', 'nep141:doge.omft.near')], 'other'),
  coin('XRP', 'XRP', [asset('xrp', 'nep141:xrp.omft.near')], 'other'),
  coin('TRX', 'TRON', [asset('tron', 'nep141:tron.omft.near')], 'other'),
  coin('SUI', 'Sui', [asset('sui', 'nep141:sui.omft.near')], 'other'),
  coin('ADA', 'Cardano', [asset('cardano', 'nep141:cardano.omft.near')], 'other'),
  coin('BCH', 'Bitcoin Cash', [asset('bch', 'nep141:bch.omft.near')], 'other'),
  coin('ZEC', 'Zcash', [asset('zec', 'nep141:zec.omft.near')], 'other'),
  coin('XLM', 'Stellar', [asset('stellar', 'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz')], 'other'),
  coin('APT', 'Aptos', [asset('aptos', 'nep141:aptos.omft.near')], 'other'),
]);

const DYNAMIC_NATIVE_COINS = Object.freeze([
  dynamicCoin('NEAR', 'NEAR', 'near'),
  dynamicCoin('TON', 'Toncoin', 'ton'),
]);

const DEFINITIONS = new Map(
  [...FEATURED_COINS, ...OTHER_COINS, ...DYNAMIC_NATIVE_COINS].map((definition) => [definition.key, definition]),
);

export class CoinPolicy {
  constructor(catalogue) {
    this.catalogue = catalogue;
  }

  getCoin(key) {
    return DEFINITIONS.get(String(key ?? '').toUpperCase()) ?? null;
  }

  getFeaturedCoins(excludeAssetId = null) {
    return FEATURED_COINS.filter((definition) => this.getAssetsForCoin(definition.key, excludeAssetId).length > 0);
  }

  getOtherCoins(excludeAssetId = null) {
    return [...OTHER_COINS, ...DYNAMIC_NATIVE_COINS]
      .filter((definition) => this.getAssetsForCoin(definition.key, excludeAssetId).length > 0);
  }

  hasOtherCoins(excludeAssetId = null) {
    return this.getOtherCoins(excludeAssetId).length > 0;
  }

  getAssetsForCoin(key, excludeAssetId = null) {
    const definition = this.getCoin(key);
    if (!definition) return [];

    const candidates = definition.dynamic
      ? this.getDynamicCandidates(definition)
      : definition.assets
        .map((expected) => {
          const live = this.catalogue.getAsset(expected.assetId);
          if (!live) return null;
          if (live.blockchain !== expected.blockchain || live.symbol.toUpperCase() !== definition.key) return null;
          return live;
        })
        .filter(Boolean);

    return candidates.filter((candidate) => candidate.assetId !== excludeAssetId);
  }

  getGroup(key) {
    return this.getCoin(key)?.group ?? null;
  }

  describeNetworks(key, excludeAssetId = null) {
    return this.getAssetsForCoin(key, excludeAssetId)
      .map((entry) => networkLabel(entry.blockchain))
      .join(', ');
  }

  getDynamicCandidates(definition) {
    const matches = this.catalogue.getAssets().filter((candidate) => (
      candidate.blockchain === definition.nativeBlockchain
      && candidate.symbol.toUpperCase() === definition.key
    ));
    return matches.length === 1 ? matches : [];
  }
}

export function networkLabel(blockchain) {
  return NETWORK_LABELS[blockchain] ?? String(blockchain ?? '').toUpperCase();
}

function asset(blockchain, assetId) {
  return Object.freeze({ blockchain, assetId });
}

function coin(key, name, assets, group = 'featured') {
  return Object.freeze({ key, name, assets: Object.freeze(assets), group, dynamic: false });
}

function dynamicCoin(key, name, nativeBlockchain) {
  return Object.freeze({ key, name, assets: Object.freeze([]), group: 'other', dynamic: true, nativeBlockchain });
}
