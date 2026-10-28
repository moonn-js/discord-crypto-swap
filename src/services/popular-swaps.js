export const POPULAR_SWAPS = Object.freeze([
  popularSwap('popular-ltc-usdt-bsc', 'LTC', 'ltc', 'USDT', 'bsc', 'LTC → USDT (BEP-20)'),
  popularSwap('popular-usdt-bsc-ltc', 'USDT', 'bsc', 'LTC', 'ltc', 'USDT (BEP-20) → LTC'),
  popularSwap('popular-ltc-usdt-eth', 'LTC', 'ltc', 'USDT', 'eth', 'LTC → USDT (ERC-20)'),
]);

export function getPopularSwap(action) {
  return POPULAR_SWAPS.find((route) => route.action === action) ?? null;
}

function popularSwap(action, originCoin, originBlockchain, destinationCoin, destinationBlockchain, label) {
  return Object.freeze({ action, originCoin, originBlockchain, destinationCoin, destinationBlockchain, label });
}
