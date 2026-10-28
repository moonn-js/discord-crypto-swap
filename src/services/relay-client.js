import { fromBaseUnits } from '../utils/amounts.js';
import { transactionExplorerUrl } from './transaction-explorer.js';

const CHAINS = { eth: 1, base: 8453, arb: 42161, op: 10, bsc: 56, pol: 137, avax: 43114, sol: 792703809, btc: 8253038 };
const NATIVE = { eth: 'ETH', base: 'ETH', arb: 'ETH', op: 'ETH', bsc: 'BNB', pol: 'POL', avax: 'AVAX', sol: 'SOL', btc: 'BTC' };
const NATIVE_ADDRESSES = { sol: '11111111111111111111111111111111', btc: 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8' };
const ZERO = '0x0000000000000000000000000000000000000000';
const STATES = { waiting: 'PENDING_DEPOSIT', depositing: 'KNOWN_DEPOSIT_TX', pending: 'PROCESSING', submitted: 'PROCESSING', delayed: 'PROCESSING', success: 'SUCCESS', refund: 'REFUNDED', failure: 'PROCESSING' };

export class RelayError extends Error {
  constructor(code, message = 'The swap service could not complete this request. Please refresh or try again later.', status = null) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

function invalid() { throw new RelayError('RELAY_INVALID_RESPONSE', 'The swap details failed verification. Do not send another deposit; tracking will retry.'); }
function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && (/^0x/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
}
function atomic(value) { return typeof value === 'string' && /^\d+$/.test(value); }
function validAddress(value) { return typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\s`<>]/u.test(value) && ![...value].some(char => char.codePointAt(0) < 32); }

export function relayAsset(asset) {
  const chainId = CHAINS[asset.blockchain];
  if (!chainId) return null;
  const address = asset.contractAddress || (asset.symbol === NATIVE[asset.blockchain] ? NATIVE_ADDRESSES[asset.blockchain] ?? ZERO : null);
  return address ? { chainId, address, decimals: asset.decimals } : null;
}

function verifyCurrency(value, expected) {
  if (value?.chainId !== expected.chainId || value.decimals !== expected.decimals || !sameAddress(value.address, expected.address)) invalid();
}

export class RelayClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.chains = null;
    this.chainsAt = 0;
  }

  get enabled() { return Boolean(this.config.relayApiKey); }

  async request(path, body) {
    if (!this.enabled) throw new RelayError('RELAY_UNAVAILABLE');
    let response;
    try {
      response = await this.fetch(new URL(path, 'https://api.relay.link'), {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.config.relayApiKey },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: globalThis.AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch { throw new RelayError('RELAY_UNAVAILABLE'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new RelayError(response.status === 401 || response.status === 403 ? 'RELAY_AUTHENTICATION' : response.status === 429 ? 'RELAY_RATE_LIMITED' : 'RELAY_UNAVAILABLE', undefined, response.status);
    if (!data || typeof data !== 'object') invalid();
    return data;
  }

  async getChains() {
    if (this.chains && Date.now() - this.chainsAt < 300_000) return this.chains;
    const data = await this.request('/chains');
    if (!Array.isArray(data.chains)) invalid();
    this.chains = data.chains;
    this.chainsAt = Date.now();
    return this.chains;
  }

  async getQuote(parameters) {
    const { originAsset, destinationAsset, amountBase, recipient, refundTo, dry } = parameters;
    const origin = relayAsset(originAsset), destination = relayAsset(destinationAsset);
    if (!origin || !destination) throw new RelayError('NO_LIQUIDITY_ROUTE');
    if (!validAddress(recipient) || !validAddress(refundTo) || sameAddress(refundTo, NATIVE_ADDRESSES[originAsset.blockchain] ?? ZERO)) throw new RelayError('INVALID_REFUND_ADDRESS');
    const chains = await this.getChains();
    const solver = chains.find(chain => chain.id === origin.chainId)?.solverCurrencies;
    if (!solver?.some(currency => sameAddress(currency.address, origin.address) && currency.decimals === origin.decimals)) throw new RelayError('NO_LIQUIDITY_ROUTE');
    const ttl = Math.floor(this.config.fundingDeadlineMs / 1000);
    const createdAt = Date.now();
    // Strict single-use addresses prevent an old ticket's address being reused
    // for a later order. Always refund to the user's explicit origin address.
    // The live API validates user on the origin chain even for deposit mode.
    // Use the user's origin refund wallet, never the destination-chain wallet.
    const request = { user: refundTo, recipient, refundTo, originChainId: origin.chainId, originCurrency: origin.address,
      destinationChainId: destination.chainId, destinationCurrency: destination.address, amount: amountBase,
      tradeType: 'EXACT_INPUT', useDepositAddress: true, strict: true, refundOnOrigin: true,
      slippageTolerance: String(this.config.slippageBps), ttl };
    const response = await this.request('/quote/v2', request);
    const { currencyIn, currencyOut } = response.details ?? {};
    verifyCurrency(currencyIn?.currency, origin);
    verifyCurrency(currencyOut?.currency, destination);
    if (!sameAddress(response.details.recipient, recipient) || currencyIn.amount !== amountBase
      || !atomic(currencyOut.amount) || BigInt(currencyOut.amount) <= 0n
      || !atomic(currencyOut.minimumAmount) || BigInt(currencyOut.minimumAmount) <= 0n
      || BigInt(currencyOut.minimumAmount) > BigInt(currencyOut.amount)
      || BigInt(currencyOut.minimumAmount) * 10000n < BigInt(currencyOut.amount) * BigInt(10000 - this.config.slippageBps) - 10000n) invalid();
    const deposit = response.steps?.find(step => step.id === 'deposit');
    if (response.steps?.length !== 1 || deposit?.kind !== 'transaction' || !validAddress(deposit?.depositAddress)
      || !/^0x[0-9a-f]{64}$/i.test(deposit.requestId ?? '')) invalid();
    const deadline = new Date(createdAt + ttl * 1000).toISOString();
    return {
      provider: 'relay',
      providerData: { requestId: deposit.requestId, origin, destination, originChain: originAsset.blockchain, destinationChain: destinationAsset.blockchain, createdAt },
      quoteRequest: { dry, originAsset: originAsset.assetId, destinationAsset: destinationAsset.assetId, amount: amountBase, recipient, refundTo, deadline, appFees: [] },
      quote: { amountIn: amountBase, amountInFormatted: fromBaseUnits(amountBase, origin.decimals), amountInUsd: currencyIn.amountUsd,
        amountOut: currencyOut.amount, amountOutFormatted: fromBaseUnits(currencyOut.amount, destination.decimals), amountOutUsd: currencyOut.amountUsd,
        minAmountOut: currencyOut.minimumAmount, minAmountOutFormatted: fromBaseUnits(currencyOut.minimumAmount, destination.decimals),
        deadline, timeEstimate: response.details.timeEstimate,
        ...(!dry ? { depositAddress: deposit.depositAddress } : {}),
      },
    };
  }

  async getExecutionStatus(swap) {
    const stored = swap.executable_quote, info = stored?.providerData;
    if (stored?.provider !== 'relay' || !info?.requestId || stored.quote.depositAddress !== swap.deposit_address) invalid();
    // Deposits can regenerate request IDs. Address lookup is authoritative.
    const result = await this.request(`/requests/v3?depositAddress=${encodeURIComponent(swap.deposit_address)}&limit=50`);
    if (!Array.isArray(result.requests) || result.continuation) invalid();
    const rows = result.requests.filter(row => sameAddress(row.depositAddress?.address, swap.deposit_address));
    for (const row of rows) {
      if (row.depositAddress.type !== 'strict' || !sameAddress(row.recipient, swap.recipient) || !sameAddress(row.refundTo, swap.refund_to)) invalid();
    }
    const active = rows.filter(row => !row.supersededByRequestId && !row.duplicateDeposits?.parentRequestId);
    if (active.length > 1) invalid();
    const row = active[0];
    if (!row) return { provider: 'relay', status: 'PENDING_DEPOSIT', updatedAt: new Date().toISOString(), swapDetails: {} };
    if (!/^0x[0-9a-f]{64}$/i.test(row.id ?? '')) invalid();
    const response = await this.request(`/intents/status/v3?requestId=${encodeURIComponent(row.id)}`);
    if (response.originChainId !== info.origin.chainId || response.destinationChainId !== info.destination.chainId) invalid();
    const status = STATES[response.status];
    if (!status) throw new RelayError('RELAY_UNKNOWN_STATUS');
    const details = {};
    const route = row.data?.route?.actual;
    const input = route?.origin?.inputCurrency, output = route?.destination?.outputCurrency;
    if (input) {
      verifyCurrency(input.currency, info.origin);
      if (!atomic(input.amount)) invalid();
      details.depositedAmount = input.amount;
      details.amountInFormatted = fromBaseUnits(input.amount, info.origin.decimals);
      details.amountInUsd = input.amountUsd;
    }
    if (output && status !== 'REFUNDED') {
      verifyCurrency(output.currency, info.destination);
      if (!atomic(output.amount)) invalid();
      details.amountOut = output.amount;
      details.amountOutFormatted = fromBaseUnits(output.amount, info.destination.decimals);
      details.amountOutUsd = output.amountUsd;
    }
    details.originChainTxHashes = txDetails(info.originChain, response.inTxHashes);
    details.destinationChainTxHashes = status === 'REFUNDED' ? [] : txDetails(info.destinationChain, response.txHashes);
    details.refundTxHashes = status === 'REFUNDED' ? txDetails(info.originChain, response.txHashes) : [];
    if (status === 'SUCCESS' && (!details.depositedAmount || BigInt(details.depositedAmount) <= 0n
      || !details.amountOut || BigInt(details.amountOut) <= 0n || !details.destinationChainTxHashes.length)) invalid();
    if (status === 'REFUNDED' && !details.refundTxHashes.length) invalid();
    return { provider: 'relay', status, providerStatus: response.status, requiresAttention: response.status === 'failure',
      updatedAt: new Date(response.updatedAt ?? Date.now()).toISOString(), swapDetails: details };
  }
}

function txDetails(chain, hashes) {
  if (!Array.isArray(hashes)) return [];
  return hashes.filter(hash => validAddress(hash)).map(hash => ({ hash, explorerUrl: transactionExplorerUrl(chain, hash) ?? undefined }));
}
