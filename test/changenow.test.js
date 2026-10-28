import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@defuse-protocol/one-click-sdk-typescript';
import { ChangeNowClient, ChangeNowError, decimalToAtomic, matchChangeNowAsset } from '../src/services/changenow-client.js';
import { SwapClient } from '../src/services/swap-client.js';
import { OneClickClient, QuoteSecurityError } from '../src/services/oneclick-client.js';
import { classifyOperationalError } from '../src/services/error-classifier.js';
import { StatusWorker } from '../src/jobs/status-worker.js';

const origin = { assetId: 'native-ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8, price: 55 };
const destination = { assetId: 'bsc-usdt', symbol: 'USDT', blockchain: 'bsc', decimals: 18, price: 1, contractAddress: '0x55d398326f99059ff775485246999027b3197955' };
const currencies = [
  { ticker: 'ltc', network: 'ltc', tokenContract: null, buy: true, sell: true },
  { ticker: 'usdt', network: 'bsc', tokenContract: destination.contractAddress, buy: true, sell: true },
];
const pair = { fromCurrency: 'ltc', fromNetwork: 'ltc', toCurrency: 'usdt', toNetwork: 'bsc', flow: 'standard', type: 'direct' };
const parameters = { dry: true, originAsset: origin, destinationAsset: destination, amountBase: '100000000', recipient: 'receiving-wallet', refundTo: 'refund-wallet' };
const estimate = { ...pair, fromAmount: 1, toAmount: 54.5 };
const order = { ...estimate, id: 'test-order-123', payinAddress: 'deposit-wallet', payoutAddress: parameters.recipient, refundAddress: parameters.refundTo };
const config = { oneClickBaseUrl: 'https://1click.chaindefuser.com', changeNowApiKey: 'test-secret', changeNowZeroCommissionConfirmed: true, fundingDeadlineMs: 3600000 };

function fixture(overrides = {}, configOverrides = {}) {
  const fetchImpl = vi.fn(async (url, options) => {
    const path = url.pathname;
    let body = path.endsWith('/currencies') ? currencies : path.endsWith('/address') ? { result: true }
      : path.endsWith('/estimated-amount') ? estimate : path.endsWith('/by-id')
        ? { ...order, status: 'finished', amountFrom: 1, amountTo: 54.4, payoutHash: '0x' + 'a'.repeat(64), updatedAt: new Date().toISOString() } : order;
    if (overrides[path] !== undefined) body = overrides[path];
    return { ok: true, status: 200, json: async () => typeof body === 'function' ? body(url, options) : body };
  });
  return { client: new ChangeNowClient({ ...config, ...configOverrides }, { fetchImpl }), fetchImpl };
}

afterEach(() => vi.restoreAllMocks());

describe('ChangeNOW exact asset mapping', () => {
  it('uses Ethereum checksum validation for BSC addresses while quoting the BSC network', async () => {
    const { client, fetchImpl } = fixture();
    const quote = await client.getQuote(parameters);
    const validations = fetchImpl.mock.calls.filter(([url]) => url.pathname.endsWith('/address'));
    expect(validations.map(([url]) => url.searchParams.get('currency'))).toEqual(['eth', 'ltc']);
    expect(quote.providerData.toNetwork).toBe('bsc');
  });
  it('matches native LTC and the actual BSC USDT contract', () => {
    expect(matchChangeNowAsset(origin, currencies, 'sell')).toBe(currencies[0]);
    expect(matchChangeNowAsset(destination, currencies, 'buy')).toBe(currencies[1]);
  });
  it.each([
    { ...destination, blockchain: 'eth' },
    { ...destination, contractAddress: '0x' + 'a'.repeat(40) },
    { ...destination, contractAddress: null },
    { ...origin, blockchain: 'bsc' },
  ])('rejects incorrect chain/contract identities', (asset) => {
    expect(matchChangeNowAsset(asset, currencies, 'buy')).toBeNull();
  });
  it('rejects disabled and ambiguous assets', () => {
    expect(matchChangeNowAsset(origin, [{ ...currencies[0], sell: false }], 'sell')).toBeNull();
    expect(matchChangeNowAsset(origin, [currencies[0], currencies[0]], 'sell')).toBeNull();
  });
  it('preserves case-sensitive Solana contracts', () => {
    const asset = { symbol: 'USDT', blockchain: 'sol', contractAddress: 'CaseSensitive' };
    expect(matchChangeNowAsset(asset, [{ ticker: 'usdt', network: 'sol', buy: true, tokenContract: 'casesensitive' }], 'buy')).toBeNull();
  });
});

describe('ChangeNOW quote and order lifecycle', () => {
  it('estimates without creating any order and exposes floating rate without a fake minimum', async () => {
    const { client, fetchImpl } = fixture({}, { changeNowZeroCommissionConfirmed: false });
    const quote = await client.getQuote(parameters);
    expect(quote).toMatchObject({ provider: 'changenow', quoteRequest: { appFees: [] }, quote: { amountOut: '54500000000000000000', minAmountOut: null, floating: true } });
    expect(fetchImpl.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    expect(fetchImpl.mock.calls.every(([url, options]) => !url.toString().includes('test-secret') && options.headers['x-changenow-api-key'] === 'test-secret')).toBe(true);
  });
  it('blocks executable orders until the account commission is confirmed zero', async () => {
    const { client, fetchImpl } = fixture({}, { changeNowZeroCommissionConfirmed: false });
    await expect(client.getQuote({ ...parameters, dry: false })).rejects.toMatchObject({ code: 'CHANGENOW_COMMISSION_UNCONFIRMED' });
    expect(fetchImpl.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });
  it('creates an order with exact networks, refund address, and no invented commission override', async () => {
    const { client, fetchImpl } = fixture();
    const quote = await client.getQuote({ ...parameters, dry: false });
    expect(quote.providerData.exchangeId).toBe(order.id);
    expect(quote.quote.depositAddress).toBe(order.payinAddress);
    const posts = fetchImpl.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ ...pair, fromAmount: '1', address: parameters.recipient, refundAddress: parameters.refundTo });
  });
  it('rejects a bad address before persisting a preview or creating an order', async () => {
    const { client, fetchImpl } = fixture({ '/v2/validate/address': { result: false } });
    await expect(client.getQuote(parameters)).rejects.toMatchObject({ code: 'INVALID_RECIPIENT_ADDRESS' });
    expect(fetchImpl.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  });
  it.each([
    { ...order, toNetwork: 'eth' }, { ...order, payoutAddress: 'attacker' },
    { ...order, refundAddress: 'attacker' }, { ...order, fromAmount: 2 },
    { ...order, payinAddress: '' }, { ...order, toAmount: 0 },
  ])('rejects inconsistent executable response', async (badOrder) => {
    const { client } = fixture({ '/v2/exchange': badOrder });
    await expect(client.getQuote({ ...parameters, dry: false })).rejects.toMatchObject({ code: 'CHANGENOW_INVALID_RESPONSE' });
  });
  it('does not retry an ambiguous create timeout', async () => {
    const { client, fetchImpl } = fixture({ '/v2/exchange': () => { throw new Error('timeout'); } });
    await expect(client.getQuote({ ...parameters, dry: false })).rejects.toThrow();
    expect(fetchImpl.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });
  it('tracks a persisted order after restart using its order ID', async () => {
    const { client } = fixture();
    const executable = JSON.parse(JSON.stringify(await client.getQuote({ ...parameters, dry: false })));
    const { client: restarted } = fixture();
    const status = await restarted.getExecutionStatus({ executable_quote: executable, deposit_address: order.payinAddress, recipient: parameters.recipient, refund_to: parameters.refundTo });
    expect(status).toMatchObject({ status: 'SUCCESS', provider: 'changenow', swapDetails: { depositedAmount: '100000000', amountOut: '54400000000000000000', amountInUsd: '55.00000000', amountOutUsd: '54.40000000' } });
  });
  it.each(['verifying', 'failed', 'refunding'])('keeps %s swaps tracked instead of claiming settlement', async (status) => {
    const { client } = fixture({ '/v2/exchange/by-id': { ...order, status } });
    const executable = await client.getQuote({ ...parameters, dry: false });
    const response = await client.getExecutionStatus({ executable_quote: executable, deposit_address: order.payinAddress, recipient: parameters.recipient, refund_to: parameters.refundTo });
    expect(response.status).toBe('PROCESSING');
    expect(response.requiresAttention).toBe(status !== 'refunding');
  });
  it('rejects mismatched status deposit addresses', async () => {
    const { client } = fixture({ '/v2/exchange/by-id': { ...order, status: 'finished', payinAddress: 'different-address' } });
    const executable = await client.getQuote({ ...parameters, dry: false });
    await expect(client.getExecutionStatus({ executable_quote: executable, deposit_address: order.payinAddress, recipient: parameters.recipient, refund_to: parameters.refundTo })).rejects.toMatchObject({ code: 'CHANGENOW_INVALID_RESPONSE' });
  });
});

describe('fallback routing policy', () => {
  const noRoute = new ApiError({ method: 'POST', url: '/v0/quote' }, { url: '/v0/quote', ok: false, status: 400, statusText: 'Error', body: { message: 'no route with sufficient liquidity' } }, 'API failure');
  it('leaves a successful primary quote unchanged', async () => {
    const primary = { signature: 'valid-primary-response' };
    vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote').mockResolvedValue(primary);
    const client = new SwapClient(config);
    const fallback = vi.spyOn(client.changeNow, 'getQuote');
    expect(await client.getVerifiedQuote(parameters)).toBe(primary);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('passes the exact swap to fallback only for no route', async () => {
    vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote').mockRejectedValue(noRoute);
    const client = new SwapClient(config);
    const fallback = vi.spyOn(client.changeNow, 'getQuote').mockResolvedValue({ provider: 'changenow' });
    await client.getVerifiedQuote(parameters);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(parameters);
  });
  it.each([new QuoteSecurityError('invalid signature'), new Error('timeout'), { status: 401 }, { status: 429 }, { status: 500 }])('never falls back on security, auth or operational errors', async (error) => {
    vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote').mockRejectedValue(error);
    const client = new SwapClient(config);
    const fallback = vi.spyOn(client.changeNow, 'getQuote');
    await expect(client.getVerifiedQuote(parameters)).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('requires a new preview rather than silently switching providers during confirmation', async () => {
    vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote').mockRejectedValue(noRoute);
    const client = new SwapClient(config);
    const fallback = vi.spyOn(client.changeNow, 'getQuote');
    await expect(client.getVerifiedQuote({ ...parameters, dry: false, provider: 'oneclick' })).rejects.toMatchObject({ code: 'CHANGENOW_REFRESH_REQUIRED' });
    expect(fallback).not.toHaveBeenCalled();
  });
  it('pins confirmation to the fallback displayed in the preview', async () => {
    const primary = vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote');
    const client = new SwapClient(config);
    vi.spyOn(client.changeNow, 'getQuote').mockResolvedValue({ provider: 'changenow' });
    await client.getVerifiedQuote({ ...parameters, dry: false, provider: 'changenow' });
    expect(primary).not.toHaveBeenCalled();
  });
  it('routes legacy stored quotes through 1Click verification', async () => {
    const primary = vi.spyOn(OneClickClient.prototype, 'getExecutionStatus').mockResolvedValue({ status: 'PROCESSING' });
    const client = new SwapClient(config);
    await client.getExecutionStatus({ executable_quote: { signature: 'original' } });
    expect(primary).toHaveBeenCalledOnce();
  });
  it('classifies fallback authentication independently', () => {
    expect(classifyOperationalError(new ChangeNowError('CHANGENOW_AUTHENTICATION', 'Credentials need attention', 401))).toMatchObject({ source: 'changenow', code: 'CHANGENOW_AUTHENTICATION' });
  });
});

describe('ChangeNOW floating tracking', () => {
  it('continues polling after the local funding window rather than expiring a floating order', async () => {
    const repositories = { updateSwapStatus: vi.fn().mockResolvedValue({ changed: false, swap: {} }), markSwapTrackingStale: vi.fn() };
    const oneClick = { getExecutionStatus: vi.fn().mockResolvedValue({ status: 'PENDING_DEPOSIT' }), isTerminal: () => false };
    const worker = new StatusWorker({ repositories, oneClick, health: {}, config: { staleTrackingMs: 86400000 } });
    await worker.refreshSwap({ id: 'swap', status: 'PENDING_DEPOSIT', executable_quote: { provider: 'changenow' }, quote_deadline: new Date(Date.now() - 1000) });
    expect(oneClick.getExecutionStatus).toHaveBeenCalledOnce();
    expect(repositories.markSwapTrackingStale).not.toHaveBeenCalled();
  });
});

describe('amount conversion', () => {
  it.each([[1e-8, 8, '1'], ['54.50000000', 18, '54500000000000000000'], [1, 8, '100000000']])('converts %s precisely', (value, decimals, expected) => {
    expect(decimalToAtomic(value, decimals)).toBe(expected);
  });
  it.each([-1, 'NaN', 'Infinity', '0.000000001', '1e9999'])('rejects invalid or unrepresentable amounts', (value) => {
    expect(() => decimalToAtomic(value, 8)).toThrow();
  });
});
