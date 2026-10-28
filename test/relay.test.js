import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayClient, RelayError, relayAsset } from '../src/services/relay-client.js';
import { SwapClient } from '../src/services/swap-client.js';
import { OneClickClient, QuoteSecurityError } from '../src/services/oneclick-client.js';
import { StatusWorker } from '../src/jobs/status-worker.js';
import { renderTicket } from '../src/discord/views.js';

const zero = '0x0000000000000000000000000000000000000000';
const address = '0xF0AE622e463fa757Cf72243569E18Be7Df1996cd';
const deposit = '0x44062B04C902E95DE9BE82265a66325F6f68cae5';
const id = `0x${'a'.repeat(64)}`;
const config = { relayApiKey: 'test-key', oneClickBaseUrl: 'https://1click.chaindefuser.com', oneClickJwt: 'test', fundingDeadlineMs: 3600000, slippageBps: 50 };
const originAsset = { assetId: 'base:eth', blockchain: 'base', symbol: 'ETH', decimals: 18 };
const destinationAsset = { ...originAsset, assetId: 'op:eth', blockchain: 'op' };
const params = { originAsset, destinationAsset, amountBase: '10000000000000000', recipient: address, refundTo: address, dry: true };
const origin = { chainId: 8453, address: zero, decimals: 18 };
const destination = { ...origin, chainId: 10 };
const currencyIn = { currency: origin, amount: params.amountBase, amountUsd: '25' };
const currencyOut = { currency: destination, amount: '9990000000000000', minimumAmount: '9940050000000000', amountUsd: '24.975' };
function quote() {
  return { steps: [{ id: 'deposit', kind: 'transaction', requestId: id, depositAddress: deposit }], details: { recipient: address, currencyIn, currencyOut } };
}
function mockClient(responses) {
  const fetchImpl = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => responses.shift() }));
  return { client: new RelayClient(config, { fetchImpl }), fetchImpl };
}
const chains = { chains: [{ id: 8453, solverCurrencies: [{ address: zero, decimals: 18 }] }] };
function swap() {
  return { deposit_address: deposit, recipient: address, refund_to: address,
    executable_quote: { provider: 'relay', quote: { depositAddress: deposit }, providerData: { requestId: id, origin, destination, originChain: 'base', destinationChain: 'op' } } };
}
function row(status = 'success') {
  return { id, status, recipient: address, refundTo: address, depositAddress: { address: deposit, type: 'strict' },
    data: { route: { actual: { origin: { inputCurrency: currencyIn }, destination: { outputCurrency: currencyOut } } } } };
}
function status(value = 'success') { return { status: value, originChainId: 8453, destinationChainId: 10, inTxHashes: ['0xdeposit'], txHashes: ['0xpayout'] }; }
afterEach(() => vi.restoreAllMocks());

describe('Relay deposit addresses', () => {
  it('creates strict address-only quotes with explicit origin refunds and exact atomic amounts', async () => {
    const { client, fetchImpl } = mockClient([chains, quote()]);
    const result = await client.getQuote({ ...params, dry: false });
    expect(result.quote.depositAddress).toBe(deposit);
    expect(result.quote.amountInFormatted).toBe('0.01');
    expect(result.quote.amountOut).toBe(currencyOut.amount);
    expect(result.quote.minAmountOut).toBe(currencyOut.minimumAmount);
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body).toMatchObject({ useDepositAddress: true, strict: true, refundTo: address, refundOnOrigin: true, ttl: 3600, amount: params.amountBase, slippageTolerance: '50' });
    expect(fetchImpl.mock.calls[1][1].headers['x-api-key']).toBe('test-key');
    expect(JSON.stringify(result)).not.toContain('test-key');
  });
  it('does not expose a preview address', async () => {
    const { client } = mockClient([chains, quote()]);
    expect((await client.getQuote(params)).quote.depositAddress).toBeUndefined();
  });
  it.each(['recipient', 'input', 'output', 'decimals', 'amount', 'minimum', 'address', 'approval', 'slippage', 'signature'])('rejects inconsistent %s', async field => {
    const response = globalThis.structuredClone(quote());
    if (field === 'recipient') response.details.recipient = deposit;
    if (field === 'input') response.details.currencyIn.currency.chainId = 1;
    if (field === 'output') response.details.currencyOut.currency.address = deposit;
    if (field === 'decimals') response.details.currencyOut.currency.decimals = 6;
    if (field === 'amount') response.details.currencyIn.amount = '1';
    if (field === 'minimum') response.details.currencyOut.minimumAmount = '0';
    if (field === 'address') delete response.steps[0].depositAddress;
    if (field === 'approval') response.steps.push({ id: 'approve' });
    if (field === 'slippage') response.details.currencyOut.minimumAmount = '9900000000000000';
    if (field === 'signature') response.steps[0].kind = 'signature';
    const { client } = mockClient([chains, response]);
    await expect(client.getQuote(params)).rejects.toMatchObject({ code: 'RELAY_INVALID_RESPONSE' });
  });
  it('rejects unsupported chains and assets with matching symbols but different contracts', async () => {
    expect(relayAsset({ ...originAsset, blockchain: 'ltc' })).toBeNull();
    const { client, fetchImpl } = mockClient([chains]);
    await expect(client.getQuote({ ...params, originAsset: { ...originAsset, contractAddress: deposit } })).rejects.toMatchObject({ code: 'NO_LIQUIDITY_ROUTE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('maps Solana native currency without confusing wrapped SOL', () => {
    expect(relayAsset({ blockchain: 'sol', symbol: 'SOL', decimals: 9 })).toMatchObject({ address: '11111111111111111111111111111111' });
    expect(relayAsset({ blockchain: 'sol', symbol: 'SOL', decimals: 9, contractAddress: 'wrapped' }).address).toBe('wrapped');
  });
  it('uses the origin refund wallet as user for Solana to EVM routes', async () => {
    const sol = '11111111111111111111111111111111';
    const wallet = '7YttLkHDo5DgGcMaoHst7QBdvt3dGBThmDwPMnUQvKzc';
    const solCurrency = { chainId: 792703809, address: sol, decimals: 9 };
    const response = globalThis.structuredClone(quote());
    response.details.currencyIn = { currency: solCurrency, amount: '1000000000', amountUsd: '100' };
    const { client, fetchImpl } = mockClient([{ chains: [{ id: solCurrency.chainId, solverCurrencies: [{ address: sol, decimals: 9 }] }] }, response]);
    await client.getQuote({ ...params, originAsset: { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 }, amountBase: '1000000000', refundTo: wallet });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ user: wallet, refundTo: wallet, recipient: address });
  });
  it('uses a bounded timeout and does not leak error response bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: config.relayApiKey }) });
    const client = new RelayClient(config, { fetchImpl });
    await expect(client.getChains()).rejects.toMatchObject({ code: 'RELAY_AUTHENTICATION', status: 401 });
    await expect(client.getChains()).rejects.not.toThrow(config.relayApiKey);
    expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
  });
});

describe('Relay lifecycle', () => {
  it('continues polling after the funding deadline to catch late deposits and refunds', async () => {
    const repositories = { updateSwapStatus: vi.fn().mockResolvedValue({ changed: false }), markSwapTrackingStale: vi.fn() };
    const oneClick = { getExecutionStatus: vi.fn().mockResolvedValue({ status: 'PENDING_DEPOSIT' }), isTerminal: () => false };
    const health = { oneClickAuthentication: false };
    const worker = new StatusWorker({ repositories, oneClick, health, config: { staleTrackingMs: 86400000 } });
    await worker.refreshSwap({ ...swap(), id: 'swap', status: 'PENDING_DEPOSIT', quote_deadline: new Date(Date.now() - 1000) });
    expect(oneClick.getExecutionStatus).toHaveBeenCalledOnce();
    expect(repositories.markSwapTrackingStale).not.toHaveBeenCalled();
    expect(health.oneClickAuthentication).toBe(false);
  });
  it('tracks regenerated request IDs through the deposit address', async () => {
    const next = { ...row(), id: `0x${'b'.repeat(64)}` };
    const { client, fetchImpl } = mockClient([{ requests: [{ ...row('waiting'), supersededByRequestId: next.id }, next] }, status()]);
    const response = await client.getExecutionStatus(swap());
    expect(response.status).toBe('SUCCESS');
    expect(response.swapDetails.amountOut).toBe(currencyOut.amount);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('depositAddress=');
    expect(String(fetchImpl.mock.calls[1][0])).toContain(next.id);
  });
  it('keeps unfunded orders pending', async () => {
    const { client } = mockClient([{ requests: [] }]);
    expect((await client.getExecutionStatus(swap())).status).toBe('PENDING_DEPOSIT');
  });
  it('reports refunds only after a refund transaction exists', async () => {
    const { client } = mockClient([{ requests: [row('refund')] }, status('refund')]);
    const response = await client.getExecutionStatus(swap());
    expect(response.status).toBe('REFUNDED');
    expect(response.swapDetails.refundTxHashes).toHaveLength(1);
    expect(response.swapDetails.destinationChainTxHashes).toEqual([]);
  });
  it('keeps provider failures under tracking rather than falsely completing', async () => {
    const { client } = mockClient([{ requests: [row('failure')] }, status('failure')]);
    expect(await client.getExecutionStatus(swap())).toMatchObject({ status: 'PROCESSING', requiresAttention: true });
  });
  it.each(['recipient', 'refund', 'currency', 'transaction', 'chain'])('rejects mismatched settlement %s', async field => {
    const request = globalThis.structuredClone(row()), execution = status();
    if (field === 'recipient') request.recipient = deposit;
    if (field === 'refund') request.refundTo = deposit;
    if (field === 'currency') request.data.route.actual.destination.outputCurrency.currency.address = deposit;
    if (field === 'transaction') execution.txHashes = [];
    if (field === 'chain') execution.destinationChainId = 1;
    const { client } = mockClient([{ requests: [request] }, execution]);
    await expect(client.getExecutionStatus(swap())).rejects.toMatchObject({ code: 'RELAY_INVALID_RESPONSE' });
  });
});

it.each(['PREVIEW', 'ACTIVE'])('renders identical normal ticket controls for Relay and NEAR in %s', step => {
  const ticket = { id: '123e4567-e89b-42d3-a456-426614174000', step, state_data: {} };
  const quote = { quoteRequest: { appFees: [] }, quote: { amountInFormatted: '0.01', amountOutFormatted: '0.00999', amountInUsd: '25', amountOutUsd: '24.975' } };
  const base = { status: 'PENDING_DEPOSIT', origin_asset_id: originAsset.assetId, destination_asset_id: destinationAsset.assetId, deposit_address: deposit, recipient: address, quote_deadline: new Date(Date.now() + 3600000), dry_quote: quote, executable_quote: quote };
  const catalogue = { getAsset: assetId => [originAsset, destinationAsset].find(a => a.assetId === assetId) };
  const serialize = s => JSON.stringify(renderTicket(ticket, catalogue, s, config));
  expect(serialize({ ...base, dry_quote: { ...quote, provider: 'relay' }, executable_quote: { ...quote, provider: 'relay' } })).toBe(serialize(base));
});

describe('Competing quotes', () => {
  function compete(primary, relay) {
    const client = new SwapClient(config);
    const near = vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote');
    if (primary instanceof Error) near.mockRejectedValue(primary); else near.mockResolvedValue({ quote: { amountOut: primary } });
    const other = vi.spyOn(client.relay, 'getQuote');
    if (relay instanceof Error) other.mockRejectedValue(relay); else other.mockResolvedValue({ provider: 'relay', quote: { amountOut: relay } });
    return { client, near, other };
  }
  it.each([['100', '101', 'relay'], ['101', '100', undefined], ['100', '100', undefined], ['9007199254740992', '9007199254740993', 'relay']])('selects the highest exact net output (%s vs %s)', async (near, relay, provider) => {
    const { client } = compete(near, relay);
    expect((await client.getVerifiedQuote(params)).provider).toBe(provider);
  });
  it('keeps NEAR available if Relay fails', async () => {
    const { client } = compete('100', new RelayError('RELAY_UNAVAILABLE'));
    expect((await client.getVerifiedQuote(params)).quote.amountOut).toBe('100');
  });
  it('can use Relay if NEAR is unavailable', async () => {
    const { client } = compete(new Error('offline'), '100');
    expect((await client.getVerifiedQuote(params)).provider).toBe('relay');
  });
  it('never masks primary quote verification failures', async () => {
    const { client } = compete(new QuoteSecurityError('invalid signature'), '100');
    await expect(client.getVerifiedQuote(params)).rejects.toThrow('invalid signature');
  });
  it('never switches the confirmed provider or creates a competing executable order', async () => {
    const { client, near, other } = compete('100', '101');
    await client.getVerifiedQuote({ ...params, dry: false, provider: 'oneclick' });
    expect(other).not.toHaveBeenCalled();
    near.mockClear();
    await client.getVerifiedQuote({ ...params, dry: false, provider: 'relay' });
    expect(near).not.toHaveBeenCalled();
    other.mockRejectedValue(new RelayError('RELAY_UNAVAILABLE'));
    await expect(client.getVerifiedQuote({ ...params, dry: false, provider: 'relay' })).rejects.toThrow();
    expect(near).not.toHaveBeenCalled();
  });
});
