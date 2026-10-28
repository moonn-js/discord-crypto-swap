import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@defuse-protocol/one-click-sdk-typescript';
import {
  OneClickClient,
  QuoteSecurityError,
  quoteAppFeesAreAllowed,
  quoteAppFeesMatch,
  quoteAssetIdsMatch,
  statusQuoteMatchesStored,
} from '../src/services/oneclick-client.js';

function config(overrides = {}) {
  return {
    oneClickBaseUrl: 'https://1click.chaindefuser.com',
    oneClickJwt: 'test-jwt-that-is-never-sent',
    slippageBps: 50,
    quoteWaitMs: 3000,
    fundingDeadlineMs: 60 * 60_000,
    targetTotalCostBps: 0,
    botFeeRecipient: null,
    ...overrides,
  };
}

describe('OneClick request policy', () => {
  it('builds exact-input origin-chain requests without fees', () => {
    const client = new OneClickClient(config());
    const request = client.buildQuoteRequest({
      dry: true,
      originAsset: { assetId: 'origin', blockchain: 'eth' },
      destinationAsset: { assetId: 'destination', blockchain: 'sol' },
      amountBase: '1000000',
      recipient: 'recipient-address',
      refundTo: 'refund-address',
    });
    expect(request).toMatchObject({
      dry: true,
      swapType: 'EXACT_INPUT',
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      slippageTolerance: 50,
      depositMode: 'SIMPLE',
    });
    expect(request).not.toHaveProperty('appFees');
  });

  it('uses memo deposits for Stellar and a one-hour funding deadline on every chain', () => {
    const client = new OneClickClient(config());
    const stellar = client.buildQuoteRequest({
      dry: false,
      originAsset: { assetId: 'xlm', blockchain: 'stellar' },
      destinationAsset: { assetId: 'near', blockchain: 'near' },
      amountBase: '1',
      recipient: 'recipient',
      refundTo: 'refund',
    });
    expect(stellar.depositMode).toBe('MEMO');

    const now = Date.now();
    expect(new Date(client.deadlineFor(now)).getTime() - now).toBe(60 * 60_000);
  });

  it('adds only the calculated application fee to quote requests', () => {
    const client = new OneClickClient(config({ botFeeRecipient: 'fee-recipient.near' }));
    const request = client.buildQuoteRequest({
      dry: true,
      originAsset: { assetId: 'origin', blockchain: 'eth' },
      destinationAsset: { assetId: 'destination', blockchain: 'sol' },
      amountBase: '1000000',
      recipient: 'recipient-address',
      refundTo: 'refund-address',
      appFeeBps: 12,
    });
    expect(request.appFees).toEqual([{ recipient: 'fee-recipient.near', fee: 12 }]);
  });

  it('rejects an application fee without a configured recipient', () => {
    const client = new OneClickClient(config({ botFeeRecipient: null }));
    expect(() => client.buildQuoteRequest({
      dry: true,
      originAsset: { assetId: 'origin', blockchain: 'eth' },
      destinationAsset: { assetId: 'destination', blockchain: 'near' },
      amountBase: '100000000',
      recipient: 'recipient.near',
      refundTo: 'refund.near',
      appFeeBps: 12,
    })).toThrow(/fee recipient/i);
  });

  it('uses a fresh fee-free baseline before requesting one executable quote with the residual fee', async () => {
    const client = new OneClickClient(config({
      targetTotalCostBps: 30,
      botFeeRecipient: 'fee-recipient.near',
    }));
    const baseline = {
      quoteRequest: { depositMode: 'SIMPLE' },
      quote: { amountInUsd: '100', amountOutUsd: '99.82' },
    };
    const executable = { quoteRequest: { appFees: [{ recipient: 'fee-recipient.near', fee: 12 }] } };
    const request = vi.spyOn(client, 'requestVerifiedQuote')
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(executable);
    const parameters = {
      dry: false,
      originAsset: { assetId: 'origin', blockchain: 'eth' },
      destinationAsset: { assetId: 'destination', blockchain: 'sol' },
      amountBase: '1000000',
      recipient: 'recipient-address',
      refundTo: 'refund-address',
    };

    await expect(client.getVerifiedQuote(parameters)).resolves.toBe(executable);
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ dry: true, appFeeBps: 0 }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ dry: false, appFeeBps: 12, depositMode: 'SIMPLE' }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the deposit-ready Bitcoin asset ID in quote requests', () => {
    const client = new OneClickClient(config());
    const request = client.buildQuoteRequest({
      dry: true,
      originAsset: { assetId: 'nep141:btc.omft.near', blockchain: 'btc' },
      destinationAsset: { assetId: 'nep141:btc.omft.near', blockchain: 'btc' },
      amountBase: '100000',
      recipient: 'recipient-address',
      refundTo: 'refund-address',
    });

    expect(request.originAsset).toBe('nep141:btc.omft.near');
    expect(request.destinationAsset).toBe('nep141:btc.omft.near');
  });

  it('accepts only the known signed Bitcoin asset alias', () => {
    expect(quoteAssetIdsMatch('nep141:btc.omft.near', '1cs_v1:btc:native:coin')).toBe(true);
    expect(quoteAssetIdsMatch('1cs_v1:btc:native:coin', 'nep141:btc.omft.near')).toBe(true);
    expect(quoteAssetIdsMatch('nep141:btc.omft.near', 'unrelated-btc-asset')).toBe(false);
  });

  it('compares normalized application fees without allowing changed recipients or rates', () => {
    expect(quoteAppFeesMatch(undefined, [])).toBe(true);
    expect(quoteAppFeesMatch(
      [{ recipient: 'fee-recipient.near', fee: 12 }],
      [{ recipient: 'fee-recipient.near', fee: '12' }],
    )).toBe(true);
    expect(quoteAppFeesMatch(
      [{ recipient: 'fee-recipient.near', fee: 12 }],
      [{ recipient: 'different.near', fee: 12 }],
    )).toBe(false);
  });

  it('allows only a 0-0.2% forced buybacks fee when a fee-free quote is unavailable', () => {
    const fallbackFee = {
      recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
      fee: 10,
    };

    expect(quoteAppFeesAreAllowed(undefined, undefined)).toBe(true);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 0 }], undefined)).toBe(true);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 1 }], undefined)).toBe(true);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 9 }], [])).toBe(true);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 20 }], [])).toBe(true);
    expect(quoteAppFeesAreAllowed([fallbackFee], [])).toBe(true);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 21 }], undefined)).toBe(false);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: -1 }], undefined)).toBe(false);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 1.5 }], undefined)).toBe(false);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, fee: 'not-a-fee' }], undefined)).toBe(false);
    expect(quoteAppFeesAreAllowed([{ ...fallbackFee, recipient: 'different.near' }], undefined)).toBe(false);
    expect(quoteAppFeesAreAllowed([fallbackFee, { recipient: 'extra.near', fee: 1 }], undefined)).toBe(false);
    expect(quoteAppFeesAreAllowed([fallbackFee], [{ recipient: 'configured.near', fee: 5 }])).toBe(false);
  });

  it('blocks an invalid quote signature before consuming the deposit address', () => {
    const client = new OneClickClient(config());
    expect(() => client.verifyQuote({ signature: 'invalid', quoteRequest: {}, quote: {} }, {}, true)).toThrow(QuoteSecurityError);
  });

  it('anchors normalized status copies to the already-verified stored quote', () => {
    const stored = statusQuote();
    const returned = JSON.parse(JSON.stringify(stored));
    returned.quoteRequest.insured = false;
    returned.quoteRequest.quoteWaitingTimeMs = null;
    returned.quoteRequest.appFees = [];
    returned.quoteRequest.referral = null;

    expect(statusQuoteMatchesStored(returned, stored)).toBe(true);
    returned.quoteRequest.recipient = 'different-recipient';
    expect(statusQuoteMatchesStored(returned, stored)).toBe(false);
  });

  it('rejects a status copy whose stored application fee changed', () => {
    const stored = statusQuote();
    stored.quoteRequest.appFees = [{ recipient: 'fee-recipient.near', fee: 12 }];
    const returned = JSON.parse(JSON.stringify(stored));
    returned.quoteRequest.appFees[0].fee = 13;
    expect(statusQuoteMatchesStored(returned, stored)).toBe(false);
  });

  it('classifies only explicit deposit-mode API errors for fallback', () => {
    const client = new OneClickClient(config());
    const depositModeError = new ApiError(
      { method: 'POST', url: '/v0/quote' },
      { url: '/v0/quote', ok: false, status: 400, statusText: 'Bad Request', body: { message: 'depositMode MEMO is required' } },
      'Bad Request',
    );
    expect(client.isDepositModeError(depositModeError)).toBe(true);
    expect(client.isDepositModeError({ status: 400, body: { message: 'invalid recipient' } })).toBe(false);
  });
});

function statusQuote() {
  return {
    signature: 'same-verified-signature',
    timestamp: '2026-08-06T12:00:00.000Z',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 50,
      originAsset: 'origin',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'destination',
      amount: '100',
      refundTo: 'refund',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'recipient',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-08-06T12:30:00.000Z',
      quoteWaitingTimeMs: 3000,
    },
    quote: {
      amountIn: '100',
      amountInFormatted: '1',
      amountInUsd: '1',
      minAmountIn: '100',
      amountOut: '99',
      amountOutFormatted: '0.99',
      amountOutUsd: '0.99',
      minAmountOut: '98',
      depositAddress: 'deposit',
      depositMemo: null,
      deadline: '2026-08-06T12:30:00.000Z',
      withdrawFee: '1',
    },
  };
}
