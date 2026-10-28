import { describe, expect, it } from 'vitest';
import { validateKnownAddressFormat, validateSwapAddresses } from '../src/utils/address-validation.js';

describe('conservative wallet format validation', () => {
  it('validates EVM, Solana, Tron, Stellar, Aptos, and Sui formats', () => {
    expect(validateKnownAddressFormat(`0x${'a'.repeat(40)}`, 'eth')).toBeNull();
    expect(validateKnownAddressFormat('not-an-evm-address', 'eth')).not.toBeNull();
    expect(validateKnownAddressFormat('11111111111111111111111111111111', 'sol')).toBeNull();
    expect(validateKnownAddressFormat(`T${'A'.repeat(33)}`, 'tron')).toBeNull();
    expect(validateKnownAddressFormat(`G${'A'.repeat(55)}`, 'stellar')).toBeNull();
    expect(validateKnownAddressFormat('0x1', 'aptos')).toBeNull();
    expect(validateKnownAddressFormat(`0x${'a'.repeat(64)}`, 'sui')).toBeNull();
  });

  it('identifies which side has the obvious network mismatch', () => {
    const recipient = validateSwapAddresses({
      recipient: 'wrong',
      refundTo: `0x${'a'.repeat(40)}`,
      originBlockchain: 'eth',
      destinationBlockchain: 'sol',
    });
    expect(recipient).toContain('receiving address');

    const refund = validateSwapAddresses({
      recipient: '11111111111111111111111111111111',
      refundTo: 'wrong',
      originBlockchain: 'eth',
      destinationBlockchain: 'sol',
    });
    expect(refund).toContain('refund address');
  });

  it('does not reject address families without a complete local validator', () => {
    expect(validateKnownAddressFormat('bc1p-new-format', 'btc')).toBeNull();
    expect(validateKnownAddressFormat('bitcoincash:anything', 'bch')).toBeNull();
  });
});
