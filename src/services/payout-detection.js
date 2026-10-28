const INTEGER_PATTERN = /^\d+$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function payoutAmountRange(swap) {
  const details = swap?.last_status_response?.swapDetails ?? {};
  const quote = swap?.executable_quote?.quote ?? {};
  const finalizedAmount = parseAtomicAmount(details.amountOut);
  if (finalizedAmount !== null) return { minimum: finalizedAmount, maximum: finalizedAmount };

  const quotedAmount = parseAtomicAmount(quote.amountOut);
  if (quotedAmount === null) return null;
  const quotedMinimum = parseAtomicAmount(quote.minAmountOut) ?? quotedAmount;
  const minimum = quotedMinimum <= quotedAmount ? quotedMinimum : quotedAmount;
  const maximum = (quotedAmount * 102n + 99n) / 100n;
  return { minimum, maximum: maximum >= minimum ? maximum : minimum };
}

export function amountMatchesRange(amount, range) {
  return typeof amount === 'bigint'
    && range
    && amount >= range.minimum
    && amount <= range.maximum;
}

export function blockCypherOutputAmount(payload, recipient) {
  if (!payload || typeof recipient !== 'string' || !Array.isArray(payload.outputs)) return null;
  let total = 0n;
  let matched = false;
  for (const output of payload.outputs) {
    if (!Array.isArray(output?.addresses) || !output.addresses.some((address) => addressesEqual(address, recipient))) continue;
    const value = parseAtomicAmount(output.value);
    if (value === null) return null;
    matched = true;
    total += value;
  }
  return matched ? total : null;
}

export function isUnconfirmedBlockCypherTransaction(payload) {
  if (!payload || typeof payload.hash !== 'string' || payload.hash.trim().length < 16) return false;
  return payload.confirmations === 0 || payload.block_height === -1 || payload.block_height == null;
}

export function evmBalanceOfData(recipient) {
  if (!EVM_ADDRESS_PATTERN.test(String(recipient ?? ''))) return null;
  return `0x70a08231000000000000000000000000${recipient.slice(2).toLowerCase()}`;
}

export function parseRpcQuantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function detectedPayoutStatus(swap) {
  const existing = swap?.last_status_response ?? {};
  const details = existing.swapDetails ?? {};
  const transaction = swap?.payout_detected_tx_hash
    ? [{
        hash: swap.payout_detected_tx_hash,
        explorerUrl: swap.payout_detected_explorer_url ?? undefined,
      }]
    : [];
  return {
    ...existing,
    status: swap?.status ?? existing.status ?? 'PROCESSING',
    updatedAt: swap?.payout_detected_at ?? existing.updatedAt ?? new Date().toISOString(),
    swapDetails: {
      ...details,
      amountOutFormatted: firstText(details.amountOutFormatted, swap?.executable_quote?.quote?.amountOutFormatted),
      destinationChainTxHashes: transaction.length > 0
        ? transaction
        : (details.destinationChainTxHashes ?? []),
    },
  };
}

export function payoutExplorerUrl(blockchain, txHash) {
  if (typeof txHash !== 'string' || txHash.length < 16) return null;
  const encoded = encodeURIComponent(txHash);
  if (blockchain === 'btc') return `https://mempool.space/tx/${encoded}`;
  if (blockchain === 'ltc') return `https://blockchair.com/litecoin/transaction/${encoded}`;
  if (blockchain === 'doge') return `https://blockchair.com/dogecoin/transaction/${encoded}`;
  if (blockchain === 'sol') return `https://explorer.solana.com/tx/${encoded}`;
  return null;
}

function parseAtomicAmount(value) {
  const text = String(value ?? '').trim();
  if (!INTEGER_PATTERN.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function addressesEqual(left, right) {
  if (typeof left !== 'string') return false;
  if (isCaseInsensitiveAddress(left) && isCaseInsensitiveAddress(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isCaseInsensitiveAddress(address) {
  return /^(bc1|ltc1|doge1)/i.test(String(address ?? ''));
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}
