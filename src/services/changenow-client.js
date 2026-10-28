import { fromBaseUnits, toBaseUnits } from '../utils/amounts.js';
import { transactionExplorerUrl } from './transaction-explorer.js';

const NETWORKS = Object.freeze({ btc: 'btc', ltc: 'ltc', doge: 'doge', eth: 'eth', bsc: 'bsc', sol: 'sol', arb: 'arbitrum', base: 'base', op: 'op', pol: 'matic', avax: 'avaxc', trx: 'trx' });
const NATIVE = Object.freeze({ btc: 'btc', ltc: 'ltc', doge: 'doge', eth: 'eth', bsc: 'bnb', sol: 'sol', arb: 'eth', base: 'eth', op: 'eth', pol: 'pol', avax: 'avax', trx: 'trx' });
const STATUSES = Object.freeze({ new: 'PENDING_DEPOSIT', waiting: 'PENDING_DEPOSIT', confirming: 'KNOWN_DEPOSIT_TX', exchanging: 'PROCESSING', sending: 'PROCESSING', finished: 'SUCCESS', refunded: 'REFUNDED', verifying: 'PROCESSING', failed: 'PROCESSING', refunding: 'PROCESSING' });

export class ChangeNowError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'ChangeNowError';
    this.code = code;
    this.status = status;
  }
}

// Only explicit chain + native-asset/contract matches are eligible. Symbols alone
// cannot distinguish native, bridged and unrelated tokens with the same ticker.
export function matchChangeNowAsset(asset, currencies, side) {
  const network = NETWORKS[asset.blockchain];
  if (!network) return null;
  const candidates = currencies.filter((coin) => coin.network === network
    && coin.ticker === asset.symbol.toLowerCase() && coin[side] === true
    && !coin.isFiat && sameContract(coin.tokenContract, asset.contractAddress, asset.blockchain)
    && (asset.contractAddress || NATIVE[asset.blockchain] === coin.ticker));
  return candidates.length === 1 ? candidates[0] : null;
}

function sameContract(left, right, chain) {
  if (!left || !right) return !left && !right;
  return ['eth', 'bsc', 'arb', 'base', 'op', 'pol', 'avax'].includes(chain)
    ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class ChangeNowClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.currencies = null;
    this.currenciesAt = 0;
  }

  get enabled() { return Boolean(this.config.changeNowApiKey); }

  async request(path, { query, body } = {}) {
    if (!this.enabled) throw new ChangeNowError('CHANGENOW_UNAVAILABLE', 'ChangeNOW is not configured.');
    const url = new URL(path, 'https://api.changenow.io/v2/');
    if (query) url.search = new globalThis.URLSearchParams(query).toString();
    let response;
    try {
      response = await this.fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-changenow-api-key': this.config.changeNowApiKey, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: globalThis.AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new ChangeNowError('CHANGENOW_UNAVAILABLE', 'ChangeNOW did not respond. Please try again later.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
      const text = String(payload?.error ?? '') + ' ' + String(payload?.message ?? '');
      const code = [401, 403].includes(response.status) ? 'CHANGENOW_AUTHENTICATION'
        : response.status === 429 ? 'CHANGENOW_RATE_LIMITED'
          : response.status >= 500 ? 'CHANGENOW_UNAVAILABLE'
            : /max_amount|maximum/i.test(text) ? 'AMOUNT_TOO_HIGH'
              : /minimal|min_amount|minimum/i.test(text) ? 'AMOUNT_TOO_LOW'
              : /pair_is_inactive|not_available|not available|unsupported_pair/i.test(text) ? 'NO_LIQUIDITY_ROUTE'
                : 'CHANGENOW_REQUEST_REJECTED';
      throw new ChangeNowError(code, 'ChangeNOW could not complete this request. Refresh the quote or try another route.', response.status);
    }
    if (!payload || typeof payload !== 'object') throw new ChangeNowError('CHANGENOW_INVALID_RESPONSE', 'ChangeNOW returned an invalid response.');
    return payload;
  }

  async getCurrencies() {
    if (this.currencies && Date.now() - this.currenciesAt < 60_000) return this.currencies;
    const currencies = await this.request('exchange/currencies', { query: { active: 'true', flow: 'standard' } });
    if (!Array.isArray(currencies)) throw new ChangeNowError('CHANGENOW_INVALID_RESPONSE', 'ChangeNOW currencies are unavailable.');
    this.currencies = currencies;
    this.currenciesAt = Date.now();
    return currencies;
  }

  async getQuote(parameters) {
    const { originAsset, destinationAsset, amountBase, recipient, refundTo, dry } = parameters;
    const currencies = await this.getCurrencies();
    const from = matchChangeNowAsset(originAsset, currencies, 'sell');
    const to = matchChangeNowAsset(destinationAsset, currencies, 'buy');
    if (!from || !to) throw new ChangeNowError('NO_LIQUIDITY_ROUTE', 'ChangeNOW does not support this exact asset and network pair.');
    for (const [address, currency, code] of [[recipient, to.network, 'INVALID_RECIPIENT_ADDRESS'], [refundTo, from.network, 'INVALID_REFUND_ADDRESS']]) {
      // The validation endpoint does not accept BSC and several other EVM
      // network names. They share Ethereum's address/checksum format.
      const validationCurrency = ['bsc', 'arbitrum', 'base', 'op', 'matic', 'avaxc'].includes(currency) ? 'eth' : currency;
      const validation = await this.request('validate/address', { query: { address, currency: validationCurrency } });
      if (validation.result !== true) throw new ChangeNowError(code, 'Check the receiving and refund addresses for the selected networks.');
    }
    const pair = { fromCurrency: from.ticker, fromNetwork: from.network, toCurrency: to.ticker, toNetwork: to.network, flow: 'standard', type: 'direct' };
    const fromAmount = fromBaseUnits(amountBase, originAsset.decimals);
    const estimate = await this.request('exchange/estimated-amount', { query: { ...pair, fromAmount } });
    validatePair(estimate, pair);
    if (decimalToAtomic(estimate.fromAmount, originAsset.decimals) !== amountBase) invalidResponse();
    const amountOut = decimalToAtomic(estimate.toAmount, destinationAsset.decimals);
    if (BigInt(amountOut) <= 0n) invalidResponse();
    const deadline = new Date(Date.now() + this.config.fundingDeadlineMs).toISOString();
    const envelope = {
      provider: 'changenow',
      providerData: { ...pair, originDecimals: originAsset.decimals, destinationDecimals: destinationAsset.decimals, originChain: originAsset.blockchain, destinationChain: destinationAsset.blockchain, originPrice: originAsset.price, destinationPrice: destinationAsset.price },
      quoteRequest: { dry, originAsset: originAsset.assetId, destinationAsset: destinationAsset.assetId, amount: amountBase, recipient, refundTo, deadline, appFees: [] },
      quote: {
        amountIn: amountBase, amountInFormatted: fromAmount,
        amountOut, amountOutFormatted: fromBaseUnits(amountOut, destinationAsset.decimals),
        amountInUsd: usdEstimate(fromAmount, originAsset.price),
        amountOutUsd: usdEstimate(estimate.toAmount, destinationAsset.price),
        deadline, floating: true, minAmountOut: null,
      },
    };
    if (dry) return envelope;
    if (!this.config.changeNowZeroCommissionConfirmed) {
      throw new ChangeNowError('CHANGENOW_COMMISSION_UNCONFIRMED', 'ChangeNOW rates are available, but deposit creation is disabled until the account partner commission is confirmed at 0%.');
    }
    // Never automatically retry this POST: a timeout can leave an unfunded order
    // at the provider. No fallback/replacement is attempted after this point.
    const order = await this.request('exchange', { body: { ...pair, fromAmount, address: recipient, refundAddress: refundTo } });
    validatePair(order, pair);
    if (!/^[a-zA-Z0-9_-]{6,128}$/.test(order.id ?? '') || !safeAddress(order.payinAddress)
      || order.payoutAddress !== recipient || order.refundAddress !== refundTo
      || decimalToAtomic(order.fromAmount, originAsset.decimals) !== amountBase) invalidResponse();
    envelope.providerData.exchangeId = order.id;
    envelope.quote.depositAddress = order.payinAddress;
    envelope.quote.depositMemo = order.payinExtraId ?? null;
    if (envelope.quote.depositMemo && !safeAddress(envelope.quote.depositMemo)) invalidResponse();
    envelope.quote.amountOut = decimalToAtomic(order.toAmount, destinationAsset.decimals);
    if (BigInt(envelope.quote.amountOut) <= 0n) invalidResponse();
    envelope.quote.amountOutFormatted = fromBaseUnits(envelope.quote.amountOut, destinationAsset.decimals);
    envelope.quote.amountOutUsd = usdEstimate(order.toAmount, destinationAsset.price);
    return envelope;
  }

  async getExecutionStatus(swap) {
    const stored = swap.executable_quote;
    const data = stored?.providerData;
    if (stored?.provider !== 'changenow' || !data?.exchangeId) invalidResponse();
    const response = await this.request('exchange/by-id', { query: { id: data.exchangeId } });
    validatePair(response, data, false);
    if (response.id !== data.exchangeId || response.payinAddress !== swap.deposit_address
      || (response.payinExtraId ?? null) !== (swap.deposit_memo ?? null)
      || response.payoutAddress !== swap.recipient || response.refundAddress !== swap.refund_to) invalidResponse();
    const status = STATUSES[response.status];
    if (!status) throw new ChangeNowError('CHANGENOW_UNKNOWN_STATUS', 'ChangeNOW returned an unfamiliar status; tracking will retry.');
    const details = {};
    if (response.amountFrom != null) {
      details.depositedAmount = decimalToAtomic(response.amountFrom, data.originDecimals);
      details.amountInFormatted = fromBaseUnits(details.depositedAmount, data.originDecimals);
      details.amountInUsd = usdEstimate(details.amountInFormatted, data.originPrice);
    }
    if (response.amountTo != null) {
      details.amountOut = decimalToAtomic(response.amountTo, data.destinationDecimals);
      details.amountOutFormatted = fromBaseUnits(details.amountOut, data.destinationDecimals);
      details.amountOutUsd = usdEstimate(details.amountOutFormatted, data.destinationPrice);
    }
    if (status === 'SUCCESS' && (!details.amountOut || BigInt(details.amountOut) <= 0n || !response.payoutHash)) invalidResponse();
    details.originChainTxHashes = txDetails(data.originChain, response.payinHash);
    details.destinationChainTxHashes = txDetails(data.destinationChain, response.payoutHash);
    details.refundTxHashes = txDetails(data.originChain, response.refundHash);
    return { status, provider: 'changenow', providerStatus: response.status, requiresAttention: ['verifying', 'failed'].includes(response.status), updatedAt: response.updatedAt ?? new Date().toISOString(), swapDetails: details };
  }
}

function validatePair(value, pair, includeFlow = true) {
  for (const field of ['fromCurrency', 'fromNetwork', 'toCurrency', 'toNetwork', ...(includeFlow ? ['flow', 'type'] : [])]) {
    if (value[field] !== pair[field]) invalidResponse();
  }
}
function invalidResponse() { throw new ChangeNowError('CHANGENOW_INVALID_RESPONSE', 'ChangeNOW returned inconsistent swap details. No new deposit instructions can be shown.'); }
function safeAddress(value) { return typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\s`<>]/u.test(value) && ![...value].some((char) => char.codePointAt(0) < 32); }
function txDetails(chain, hash) { return typeof hash === 'string' && hash.length > 0 ? [{ hash, explorerUrl: transactionExplorerUrl(chain, hash) ?? undefined }] : []; }
function usdEstimate(amount, price) {
  const value = Number(amount) * Number(price);
  return Number.isFinite(value) && value > 0 ? value.toFixed(8) : null;
}

export function decimalToAtomic(value, decimals) {
  // Expand JSON numeric exponent notation before exact BigInt conversion.
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || text.length > 100 || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) invalidResponse();
  const digits = match[1] + (match[2] ?? '');
  const scale = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
  const shift = decimals - scale;
  if (Math.abs(shift) > 300) invalidResponse();
  if (shift >= 0) return (BigInt(digits) * 10n ** BigInt(shift)).toString();
  const divisor = 10n ** BigInt(-shift);
  if (BigInt(digits) % divisor !== 0n) invalidResponse();
  return toBaseUnits(fromBaseUnits((BigInt(digits) / divisor).toString(), decimals), decimals);
}
