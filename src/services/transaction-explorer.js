const EXPLORER_PATHS = Object.freeze({
  aptos: (hash) => `https://explorer.aptoslabs.com/txn/${hash}?network=mainnet`,
  arb: (hash) => `https://arbiscan.io/tx/${hash}`,
  avax: (hash) => `https://snowtrace.io/tx/${hash}`,
  base: (hash) => `https://basescan.org/tx/${hash}`,
  bch: (hash) => `https://blockchair.com/bitcoin-cash/transaction/${hash}`,
  bsc: (hash) => `https://bscscan.com/tx/${hash}`,
  btc: (hash) => `https://mempool.space/tx/${hash}`,
  cardano: (hash) => `https://cardanoscan.io/transaction/${hash}`,
  doge: (hash) => `https://blockchair.com/dogecoin/transaction/${hash}`,
  eth: (hash) => `https://etherscan.io/tx/${hash}`,
  ltc: (hash) => `https://blockchair.com/litecoin/transaction/${hash}`,
  near: (hash) => `https://nearblocks.io/txns/${hash}`,
  op: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
  pol: (hash) => `https://polygonscan.com/tx/${hash}`,
  sol: (hash) => `https://explorer.solana.com/tx/${hash}`,
  stellar: (hash) => `https://stellar.expert/explorer/public/tx/${hash}`,
  sui: (hash) => `https://suiscan.xyz/mainnet/tx/${hash}`,
  ton: (hash) => `https://tonscan.org/tx/${hash}`,
  tron: (hash) => `https://tronscan.org/#/transaction/${hash}`,
  xrp: (hash) => `https://xrpscan.com/tx/${hash}`,
  zec: (hash) => `https://blockchair.com/zcash/transaction/${hash}`,
});

export function transactionExplorerUrl(blockchain, txHash) {
  const builder = EXPLORER_PATHS[String(blockchain ?? '').toLowerCase()];
  if (!builder || !isSafeTransactionHash(txHash)) return null;
  return builder(encodeURIComponent(txHash));
}

function isSafeTransactionHash(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 200
    && ![...value].some((character) => /\s/u.test(character) || character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}
