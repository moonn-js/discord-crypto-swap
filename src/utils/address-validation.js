const EVM_CHAINS = new Set(['abs', 'arb', 'avax', 'base', 'bsc', 'eth', 'gnosis', 'op', 'pol', 'scroll', 'xlayer']);
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

export function validateSwapAddresses({ recipient, refundTo, originBlockchain, destinationBlockchain }) {
  const recipientIssue = validateKnownAddressFormat(recipient, destinationBlockchain);
  if (recipientIssue) {
    return `The receiving address does not look like a valid ${recipientIssue.network} address. Check the receiving network and paste the address again.`;
  }

  const refundIssue = validateKnownAddressFormat(refundTo, originBlockchain);
  if (refundIssue) {
    return `The refund address does not look like a valid ${refundIssue.network} address. Check the sending network and paste the address again.`;
  }

  return null;
}

export function validateKnownAddressFormat(value, blockchain) {
  const address = String(value ?? '');
  if (EVM_CHAINS.has(blockchain)) {
    return /^0x[0-9a-fA-F]{40}$/.test(address) ? null : { network: evmNetworkName(blockchain) };
  }
  if (blockchain === 'sol') {
    return new RegExp(`^${BASE58}{32,44}$`).test(address) ? null : { network: 'Solana' };
  }
  if (blockchain === 'tron') {
    return new RegExp(`^T${BASE58}{33}$`).test(address) ? null : { network: 'Tron' };
  }
  if (blockchain === 'stellar') {
    return /^[GM][A-Z2-7]{55}$/.test(address) ? null : { network: 'Stellar' };
  }
  if (blockchain === 'aptos') {
    return /^0x[0-9a-fA-F]{1,64}$/.test(address) ? null : { network: 'Aptos' };
  }
  if (blockchain === 'sui') {
    return /^0x[0-9a-fA-F]{64}$/.test(address) ? null : { network: 'Sui' };
  }
  return null;
}

function evmNetworkName(blockchain) {
  return {
    arb: 'Arbitrum',
    avax: 'Avalanche',
    base: 'Base',
    bsc: 'BNB Chain',
    eth: 'Ethereum',
    op: 'Optimism',
    pol: 'Polygon',
  }[blockchain] ?? 'EVM';
}
