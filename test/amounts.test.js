import { describe, expect, it } from 'vitest';
import {
  AmountValidationError,
  formatUsd,
  fromBaseUnits,
  lowerConsistentNetworkAndSpreadFeeDisplay,
  parseUsdAmount,
  quoteAppFeeBps,
  quotedAppFeeDisplay,
  quotedNetworkAndSpreadFeeDisplay,
  quotedRouteCostBps,
  residualAppFeeBps,
  roundBaseUnitsUpToPrecision,
  toBaseUnits,
  usdToBaseUnits,
} from '../src/utils/amounts.js';

describe('amount conversion', () => {
  it('converts human decimals without floating point arithmetic', () => {
    expect(toBaseUnits('1.25', 6)).toBe('1250000');
    expect(toBaseUnits('0.000001', 6)).toBe('1');
    expect(toBaseUnits('100', 0)).toBe('100');
  });

  it.each(['0', '0.0', '-1', '1e3', '1,000', '.5', '01', '1 2'])(
    'rejects invalid amount %s',
    (value) => expect(() => toBaseUnits(value, 6)).toThrow(AmountValidationError),
  );

  it('rejects precision beyond the asset metadata', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow('at most 6 decimal places');
  });

  it('formats base amounts for minimum-output presentation', () => {
    expect(fromBaseUnits('1250000', 6)).toBe('1.25');
    expect(fromBaseUnits('1', 6)).toBe('0.000001');
    expect(fromBaseUnits('100', 0)).toBe('100');
  });

  it('parses familiar USD input and normalizes it to cents', () => {
    expect(parseUsdAmount('$25')).toBe('25.00');
    expect(parseUsdAmount('100$')).toBe('100.00');
    expect(parseUsdAmount('100 $')).toBe('100.00');
    expect(parseUsdAmount('25 usd')).toBe('25.00');
    expect(parseUsdAmount('$1,000.50')).toBe('1000.50');
    expect(() => parseUsdAmount('$1.001')).toThrow(AmountValidationError);
  });

  it('converts USD to token base units using integer arithmetic', () => {
    expect(usdToBaseUnits('25.00', '50000', 8)).toBe('50000');
    expect(usdToBaseUnits('25.00', '1', 6)).toBe('25000000');
  });

  it('rounds base units upward to a wallet-friendly precision', () => {
    expect(roundBaseUnitsUpToPrecision('1040828499485590530061', 18, 6)).toBe('1040828500000000000000');
    expect(roundBaseUnitsUpToPrecision('1040828500000000000000', 18, 6)).toBe('1040828500000000000000');
    expect(roundBaseUnitsUpToPrecision('25000000', 6, 6)).toBe('25000000');
  });

  it('formats the combined quoted network and spread cost in USD and percentage', () => {
    expect(quotedNetworkAndSpreadFeeDisplay({
      withdrawFee: '1000000',
      amountOut: '100000000',
      amountOutUsd: '98.50',
      amountInUsd: '100',
    })).toBe('≈$1.50 (1.50%)');
    expect(quotedNetworkAndSpreadFeeDisplay({
      amountOutUsd: '100.01',
      amountInUsd: '100',
    })).toBe('≈$0.00 (0.00%)');
    expect(formatUsd('25')).toBe('$25.00');
  });

  it('selects the lower rounded fee representation per swap and shows two percentage decimals', () => {
    expect(lowerConsistentNetworkAndSpreadFeeDisplay({
      amountInUsd: '99.80',
      amountOutUsd: '99.4525',
    })).toBe('≈$0.3475 (0.35%)');

    expect(lowerConsistentNetworkAndSpreadFeeDisplay({
      amountInUsd: '99.80',
      amountOutUsd: '99.456',
    })).toBe('≈$0.3393 (0.34%)');

    expect(lowerConsistentNetworkAndSpreadFeeDisplay({
      amountInUsd: '100',
      amountOutUsd: '98.8',
    })).toBe('≈$1.20 (1.20%)');
  });

  it('calculates a conservative residual application fee under the total-cost target', () => {
    const route = { amountInUsd: '100', amountOutUsd: '99.82' };
    expect(quotedRouteCostBps(route)).toBe(18);
    expect(residualAppFeeBps(route, 30)).toBe(12);
    expect(residualAppFeeBps({ amountInUsd: '100', amountOutUsd: '99.819' }, 30)).toBe(11);
    expect(residualAppFeeBps({ amountInUsd: '100', amountOutUsd: '99.65' }, 30)).toBe(0);
    expect(residualAppFeeBps({}, 30)).toBe(0);
  });

  it('separates the application fee from the quoted network and spread display', () => {
    const quoteResponse = {
      quoteRequest: { appFees: [{ recipient: 'fee-recipient.near', fee: 12 }] },
      quote: { amountInUsd: '100', amountOutUsd: '99.70' },
    };
    expect(quoteAppFeeBps(quoteResponse)).toBe(12);
    expect(quotedAppFeeDisplay(quoteResponse)).toBe('≈$0.12 (0.12%)');
    expect(quotedNetworkAndSpreadFeeDisplay(quoteResponse.quote, 12)).toBe('≈$0.18 (0.18%)');
  });
});
