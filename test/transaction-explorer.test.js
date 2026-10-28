import { describe, expect, it } from 'vitest';
import { transactionExplorerUrl } from '../src/services/transaction-explorer.js';

describe('origin transaction explorer links', () => {
  it.each([
    ['ltc', 'https://blockchair.com/litecoin/transaction/transaction-hash'],
    ['bsc', 'https://bscscan.com/tx/transaction-hash'],
    ['eth', 'https://etherscan.io/tx/transaction-hash'],
  ])('uses a direct %s explorer', (blockchain, expected) => {
    expect(transactionExplorerUrl(blockchain, 'transaction-hash')).toBe(expected);
  });

  it('rejects unknown chains and unsafe hashes', () => {
    expect(transactionExplorerUrl('unknown', 'transaction-hash')).toBeNull();
    expect(transactionExplorerUrl('ltc', 'bad hash')).toBeNull();
  });
});
