import { ApiError } from '@defuse-protocol/one-click-sdk-typescript';
import { describe, expect, it } from 'vitest';
import { classifyOperationalError, safeErrorLogFields } from '../src/services/error-classifier.js';

describe('operational error classification', () => {
  it.each([
    ['invalid destination recipient address', 'INVALID_RECIPIENT_ADDRESS'],
    ['refundTo is a malformed address', 'INVALID_REFUND_ADDRESS'],
    ['amount is below the minimum supported', 'AMOUNT_TOO_LOW'],
    ['amount exceeds the maximum', 'AMOUNT_TOO_HIGH'],
    ['no route with sufficient liquidity', 'NO_LIQUIDITY_ROUTE'],
    ['swap could not be fulfilled', 'NO_LIQUIDITY_ROUTE'],
    ['Quoting for this pair is not available', 'NO_LIQUIDITY_ROUTE'],
    ['quote deadline expired', 'QUOTE_EXPIRED'],
  ])('maps a safe 1Click reason without exposing its body: %s', (message, expectedCode) => {
    const error = apiError(400, { message, recipient: '0xsecret-wallet-address' });
    const classification = classifyOperationalError(error, { operation: 'preview_quote' });
    expect(classification).toMatchObject({ source: 'oneclick', code: expectedCode, status: 400 });
    expect(JSON.stringify(classification)).not.toContain('0xsecret-wallet-address');
  });

  it('describes a missing-liquidity route as having no solvers', () => {
    const classification = classifyOperationalError(
      apiError(400, { message: 'no route with sufficient liquidity' }),
      { operation: 'preview_quote' },
    );
    expect(classification.userMessage).toBe('No solvers are available for this swap right now. Try another network or token.');
  });

  it('does not misclassify a Discord HTTP 400 as a 1Click route rejection', () => {
    const error = { name: 'DiscordAPIError', status: 400, code: 50035, body: { value: 'wallet-address' } };
    const classification = classifyOperationalError(error);
    expect(classification).toMatchObject({ source: 'discord', code: 'DISCORD_50035', status: 400 });
    expect(classification.userMessage).toContain('Discord');
  });

  it('returns only allowlisted diagnostic fields for logs', () => {
    const error = apiError(400, { message: 'invalid recipient', recipient: 'wallet-address' });
    const fields = safeErrorLogFields(error, { operation: 'preview_quote' });
    expect(fields).toEqual({
      errorSource: 'oneclick',
      errorCode: 'INVALID_RECIPIENT_ADDRESS',
      httpStatus: 400,
      operation: 'preview_quote',
    });
    expect(JSON.stringify(fields)).not.toContain('wallet-address');
  });

  it('maps authentication, rate limits, and upstream failures separately', () => {
    expect(classifyOperationalError(apiError(401, {})).code).toBe('ONECLICK_AUTHENTICATION');
    expect(classifyOperationalError(apiError(429, {})).code).toBe('ONECLICK_RATE_LIMITED');
    expect(classifyOperationalError(apiError(503, {})).code).toBe('ONECLICK_UNAVAILABLE');
  });

  it('uses transaction-specific wording when deposit submission is rejected', () => {
    const classification = classifyOperationalError(apiError(400, { message: 'invalid tx hash' }), {
      operation: 'deposit_submission',
    });
    expect(classification.code).toBe('DEPOSIT_TX_REJECTED');
    expect(classification.userMessage).toContain('transaction ID');
    expect(classification.userMessage).not.toContain('quote');
  });

  it('uses status-specific security wording after deposit instructions exist', () => {
    const classification = classifyOperationalError(
      { name: 'QuoteSecurityError', code: 'STATUS_QUOTE_MISMATCH' },
      { operation: 'status_refresh' },
    );
    expect(classification.userMessage).toContain('Automatic tracking will retry');
    expect(classification.userMessage).not.toContain('No deposit instructions were created');
  });

  it('surfaces a route-specific USD bound only when the response states one explicitly', () => {
    const minimum = classifyOperationalError(apiError(400, { message: 'Minimum supported amount for this route is $12.345' }), { operation: 'preview_quote' });
    expect(minimum.userMessage).toContain('Current route minimum: $12.35');
    expect(minimum.routeLimit).toEqual({ kind: 'minimum', usd: '12.35', display: '$12.35' });

    const maximum = classifyOperationalError(apiError(400, { message: 'Amount exceeds 2,500.009 USD maximum' }), { operation: 'preview_quote' });
    expect(maximum.userMessage).toContain('Current route maximum: $2,500.00');

    const unspecified = classifyOperationalError(apiError(400, { message: 'amount is below the minimum supported' }), { operation: 'preview_quote' });
    expect(unspecified.userMessage).not.toContain('Current route minimum:');
    expect(unspecified.routeLimit).toBeNull();
  });
});

function apiError(status, body) {
  return new ApiError(
    { method: 'POST', url: '/v0/quote' },
    { url: '/v0/quote', ok: false, status, statusText: 'Error', body },
    'API failure',
  );
}
