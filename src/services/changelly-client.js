import { fromBaseUnits, toBaseUnits } from '../utils/amounts.js';
import { createPrivateKey, createPublicKey, createHash, sign, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { transactionExplorerUrl } from './transaction-explorer.js';

const CHAINS = { btc: ['bitcoin', 'btc'], ltc: ['litecoin', 'ltc'], eth: ['ethereum', 'eth'], bsc: ['binance_smart_chain', 'bsc'], sol: ['solana', 'sol'] };
const NATIVE = { btc: 'btc', ltc: 'ltc', eth: 'eth', bsc: 'bnb', sol: 'sol' };
const STATUSES = { new: 'PENDING_DEPOSIT', waiting: 'PENDING_DEPOSIT', confirming: 'KNOWN_DEPOSIT_TX', exchanging: 'PROCESSING', sending: 'PROCESSING', finished: 'SUCCESS', refunded: 'REFUNDED', hold: 'PROCESSING', failed: 'PROCESSING', overdue: 'PROCESSING', expired: 'PROCESSING' };
export class ChangellyError extends Error {
  constructor(code, message, status = null) { super(message); this.name = 'ChangellyError'; this.code = code; this.status = status; }
}
export function matchChangellyAsset(asset, currencies, side) {
  const matches = currencies.filter(coin => CHAINS[asset.blockchain]?.includes(coin.blockchain ?? coin.network)
    && coin.enabled === true && coin[side === 'sell' ? 'enabledFrom' : 'enabledTo'] === true
    && coin.blockchainPrecision === asset.decimals
    && (asset.contractAddress ? sameContract(coin.contractAddress, asset.contractAddress, asset.blockchain)
      : !coin.contractAddress && coin.ticker === NATIVE[asset.blockchain] && asset.symbol.toLowerCase() === NATIVE[asset.blockchain]));
  return matches.length === 1 ? matches[0] : null;
}
function sameContract(left, right, chain) {
  if (!left || !right) return false;
  return ['eth', 'bsc'].includes(chain) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class ChangellyClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.currencies = null;
    this.currenciesAt = 0;
  }

  get enabled() { return Boolean(this.config.changellyEnabled && this.config.changellyPrivateKeyHex); }

  async rpc(method, params = {}) {
    if (!this.config.changellyPrivateKeyHex) throw new ChangellyError('CHANGELLY_UNAVAILABLE', 'Changelly is not configured.');
    let key;
    try {
      const hex = this.config.changellyPrivateKeyHex;
      if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error();
      key = createPrivateKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'pkcs8' });
      if (key.asymmetricKeyType !== 'rsa') throw new Error();
    } catch { throw new ChangellyError('CHANGELLY_AUTHENTICATION', 'Changelly API credentials need attention.'); }
    const id = randomUUID();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const publicKey = createPublicKey(key).export({ type: 'pkcs1', format: 'der' });
    let response, payload;
    try {
      response = await this.fetch('https://api.changelly.com/v2', {
        method: 'POST', redirect: 'error', signal: globalThis.AbortSignal.timeout(15000), body,
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': createHash('sha256').update(publicKey).digest('base64'), 'X-Api-Signature': sign('sha256', Buffer.from(body), key).toString('base64') },
      });
      payload = await response.json().catch(() => null);
    } catch { throw new ChangellyError('CHANGELLY_UNAVAILABLE', 'Changelly did not respond. Please try again later.'); }
    if (!response.ok || payload?.error) {
      const message = String(payload?.error?.message ?? '');
      const code = [401,403].includes(response.status) || /not allowed for api key/i.test(message) ? 'CHANGELLY_AUTHENTICATION'
        : response.status === 429 || /requests limit/i.test(message) ? 'CHANGELLY_RATE_LIMITED'
          : response.status >= 500 ? 'CHANGELLY_UNAVAILABLE'
            : /minimal/i.test(message) ? 'AMOUNT_TOO_LOW' : /maximum|max amount/i.test(message) ? 'AMOUNT_TOO_HIGH'
              : /invalid pair:.*not available|invalid currency:.*disabled/i.test(message) ? 'NO_LIQUIDITY_ROUTE' : 'CHANGELLY_REQUEST_REJECTED';
      throw new ChangellyError(code, 'Changelly could not complete this request. Refresh the quote or try another route.', response.status);
    }
    if (payload?.jsonrpc !== '2.0' || payload.id !== id || payload.result == null) invalidResponse();
    return payload.result;
  }
  async getCurrencies() {
    if (this.currencies && Date.now() - this.currenciesAt < 60000) return this.currencies;
    const currencies = await this.rpc('getCurrenciesFull');
    if (!Array.isArray(currencies)) invalidResponse();
    this.currencies = currencies; this.currenciesAt = Date.now(); return currencies;
  }

  async getQuote(parameters) {
    const { originAsset, destinationAsset, amountBase, recipient, refundTo, dry } = parameters;
    const currencies = await this.getCurrencies();
    const from = matchChangellyAsset(originAsset, currencies, 'sell');
    const to = matchChangellyAsset(destinationAsset, currencies, 'buy');
    if (!from || !to) throw new ChangellyError('NO_LIQUIDITY_ROUTE', 'Changelly does not support this exact asset and network pair.');
    for (const [address, currency, code] of [[recipient, to.ticker, 'INVALID_RECIPIENT_ADDRESS'], [refundTo, from.ticker, 'INVALID_REFUND_ADDRESS']]) {
      const validation = await this.rpc('validateAddress', {address, currency});
      if (validation.result !== true) throw new ChangellyError(code, 'Check the receiving and refund addresses for the selected networks.');
    }
    const pair = { fromCurrency: from.ticker, toCurrency: to.ticker };
    const fromAmount = fromBaseUnits(amountBase, originAsset.decimals);
    const estimates = await this.rpc('getExchangeAmount', { from: from.ticker, to: to.ticker, amountFrom: fromAmount });
    if (!Array.isArray(estimates) || estimates.length !== 1) invalidResponse();
    const estimate = estimates[0];
    if (estimate.from !== from.ticker || estimate.to !== to.ticker || decimalToAtomic(estimate.amountFrom, originAsset.decimals) !== amountBase) invalidResponse();
    estimate.toAmount = netPayout(estimate.amountTo, estimate.networkFee, destinationAsset.decimals);
    const amountOut = decimalToAtomic(estimate.toAmount, destinationAsset.decimals);
    if (BigInt(amountOut) <= 0n) invalidResponse();
    const deadline = new Date(Date.now() + this.config.fundingDeadlineMs).toISOString();
    const envelope = {
      provider: 'changelly',
      providerData: { ...pair, originDecimals: originAsset.decimals, destinationDecimals: destinationAsset.decimals, originChain: originAsset.blockchain, destinationChain: destinationAsset.blockchain, originPrice: originAsset.price, destinationPrice: destinationAsset.price },
      quoteRequest: { dry, originAsset: originAsset.assetId, destinationAsset: destinationAsset.assetId, amount: amountBase, recipient, refundTo, deadline, appFees: [] },
      quote: {
        providerNotices: [from.notifications?.payin, to.notifications?.payout].filter(value => typeof value === 'string').map(value => value.slice(0, 450)),
        amountIn: amountBase, amountInFormatted: fromAmount,
        amountOut, amountOutFormatted: fromBaseUnits(amountOut, destinationAsset.decimals),
        amountInUsd: usdEstimate(fromAmount, originAsset.price),
        amountOutUsd: usdEstimate(estimate.toAmount, destinationAsset.price),
        deadline, floating: true, minAmountOut: null,
      },
    };
    if (dry) return envelope;
    if (!this.config.changellyZeroCommissionConfirmed) {
      throw new ChangellyError('CHANGELLY_COMMISSION_UNCONFIRMED', 'Changelly rates are available, but deposit creation is disabled until the account partner commission is confirmed at 0%.');
    }
    // Never automatically retry this POST: a timeout can leave an unfunded order
    // at the provider. No fallback/replacement is attempted after this point.
    const order = normalizeOrder(await this.rpc('createTransaction', { from: from.ticker, to: to.ticker, amountFrom: fromAmount, address: recipient, refundAddress: refundTo }), destinationAsset.decimals, true);
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
    if (stored?.provider !== 'changelly' || !data?.exchangeId) invalidResponse();
    const results = await this.rpc('getTransactions', { id: data.exchangeId });
    if (!Array.isArray(results) || results.length !== 1) invalidResponse();
    const response = normalizeOrder(results[0], data.destinationDecimals, false);
    validatePair(response, data, false);
    if (response.id !== data.exchangeId || response.payinAddress !== swap.deposit_address
      || (response.payinExtraId ?? null) !== (swap.deposit_memo ?? null)
      || response.payoutAddress !== swap.recipient || response.refundAddress !== swap.refund_to) invalidResponse();
    const status = STATUSES[response.status];
    if (!status) throw new ChangellyError('CHANGELLY_UNKNOWN_STATUS', 'Changelly returned an unfamiliar status; tracking will retry.');
    const details = {};
    if (response.amountFrom != null && response.amountFrom !== '') {
      details.depositedAmount = decimalToAtomic(response.amountFrom, data.originDecimals);
      details.amountInFormatted = fromBaseUnits(details.depositedAmount, data.originDecimals);
      details.amountInUsd = usdEstimate(details.amountInFormatted, data.originPrice);
    }
    if (response.amountTo != null && response.amountTo !== '') {
      details.amountOut = decimalToAtomic(response.amountTo, data.destinationDecimals);
      details.amountOutFormatted = fromBaseUnits(details.amountOut, data.destinationDecimals);
      details.amountOutUsd = usdEstimate(details.amountOutFormatted, data.destinationPrice);
    }
    if (status === 'SUCCESS' && (!details.amountOut || BigInt(details.amountOut) <= 0n || !response.payoutHash)) invalidResponse();
    details.originChainTxHashes = txDetails(data.originChain, response.payinHash);
    details.destinationChainTxHashes = txDetails(data.destinationChain, response.payoutHash);
    details.refundTxHashes = txDetails(data.originChain, response.refundHash);
    return { status, provider: 'changelly', providerStatus: response.status, requiresAttention: ['hold', 'failed', 'overdue', 'expired'].includes(response.status), updatedAt: response.updatedAt ?? new Date().toISOString(), swapDetails: details };
  }
}

function validatePair(value, pair) {
  for (const field of ['fromCurrency', 'toCurrency']) {
    if (value[field] !== pair[field]) invalidResponse();
  }
}
function invalidResponse() { throw new ChangellyError('CHANGELLY_INVALID_RESPONSE', 'Changelly returned inconsistent swap details. No new deposit instructions can be shown.'); }
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

function normalizeOrder(order, decimals, creating) {
  if (!order || order.type !== 'float' || order.payoutExtraId || order.refundExtraId) invalidResponse();
  return { ...order, fromCurrency: order.currencyFrom, toCurrency: order.currencyTo,
    fromAmount: order.amountExpectedFrom,
    ...(creating ? {toAmount: netPayout(order.amountExpectedTo, order.networkFee, decimals)} : {}) };
}
export function netPayout(gross, fee, decimals) {
  const net = BigInt(decimalToAtomic(gross, decimals)) - BigInt(decimalToAtomic(fee, decimals));
  if (net <= 0n) invalidResponse();
  return fromBaseUnits(net.toString(), decimals);
}
