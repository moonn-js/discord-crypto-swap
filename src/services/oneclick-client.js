import {
  ApiError,
  OneClickService,
  OpenAPI,
  QuoteRequest,
  verifyQuoteSignature,
} from '@defuse-protocol/one-click-sdk-typescript';
import { residualAppFeeBps } from '../utils/amounts.js';
import { classifyOperationalError, safeErrorLogFields } from './error-classifier.js';

const TERMINAL_STATUSES = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const FORCED_FALLBACK_FEE_RECIPIENT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
// 1Click may attach the approved buybacks fee when the caller requested no app fee.
// Keep this allowlist narrow: only the known recipient and a fee up to 0.2% are accepted.
const MAX_FORCED_FALLBACK_FEE_BPS = 20;
const QUOTE_ASSET_ALIASES = new Map([
  // 1Click accepts the legacy OmniBridge BTC ID but normalizes signed quotes to its canonical native ID.
  ['nep141:btc.omft.near', '1cs_v1:btc:native:coin'],
]);

export class QuoteSecurityError extends Error {
  constructor(message, code = 'QUOTE_SECURITY_ERROR') {
    super(message);
    this.name = 'QuoteSecurityError';
    this.code = code;
  }
}

export class OneClickClient {
  constructor(config) {
    this.config = config;
    OpenAPI.BASE = config.oneClickBaseUrl;
    OpenAPI.TOKEN = config.oneClickJwt;
  }

  getTokens() {
    return OneClickService.getTokens();
  }

  deadlineFor(now = Date.now()) {
    return new Date(now + this.config.fundingDeadlineMs).toISOString();
  }

  buildQuoteRequest({ dry, originAsset, destinationAsset, amountBase, recipient, refundTo, depositMode, appFeeBps = 0 }) {
    if (!Number.isInteger(appFeeBps) || appFeeBps < 0 || appFeeBps > 500) {
      throw new TypeError('Application fee must be an integer from 0 to 500 basis points.');
    }
    if (appFeeBps > 0 && !this.config.botFeeRecipient) {
      throw new TypeError('An application fee recipient is required when application fees are enabled.');
    }
    const request = {
      dry,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: this.config.slippageBps,
      originAsset: originAsset.assetId,
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: destinationAsset.assetId,
      amount: amountBase,
      refundTo,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient,
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline: this.deadlineFor(),
      depositMode: depositMode ?? (originAsset.blockchain === 'stellar' ? QuoteRequest.depositMode.MEMO : QuoteRequest.depositMode.SIMPLE),
      quoteWaitingTimeMs: this.config.quoteWaitMs,
    };
    if (appFeeBps > 0) {
      request.appFees = [{ recipient: this.config.botFeeRecipient, fee: appFeeBps }];
    }
    return request;
  }

  async getVerifiedQuote(parameters) {
    const targetTotalCostBps = this.config.targetTotalCostBps ?? 0;
    if (targetTotalCostBps <= 0) return this.requestVerifiedQuote(parameters);

    const baseline = await this.requestVerifiedQuote({ ...parameters, dry: true, appFeeBps: 0 });
    const appFeeBps = residualAppFeeBps(baseline.quote, targetTotalCostBps);
    if (parameters.dry && appFeeBps === 0) return baseline;

    return this.requestVerifiedQuote({
      ...parameters,
      appFeeBps,
      depositMode: baseline.quoteRequest?.depositMode ?? parameters.depositMode,
    });
  }

  async requestVerifiedQuote(parameters) {
    let request = this.buildQuoteRequest(parameters);
    let response;
    try {
      response = await OneClickService.getQuote(request);
    } catch (error) {
      if (!this.isDepositModeError(error)) throw error;
      const alternate = request.depositMode === QuoteRequest.depositMode.MEMO
        ? QuoteRequest.depositMode.SIMPLE
        : QuoteRequest.depositMode.MEMO;
      request = this.buildQuoteRequest({ ...parameters, depositMode: alternate });
      response = await OneClickService.getQuote(request);
    }

    this.verifyQuote(response, request, !parameters.dry);
    return response;
  }

  verifyQuote(response, request, requireDepositAddress) {
    if (!verifyQuoteSignature(response)) {
      throw new QuoteSecurityError('1Click returned a quote with an invalid signature.', 'INVALID_QUOTE_SIGNATURE');
    }

    const echoed = response?.quoteRequest;
    const fields = [
      'dry',
      'swapType',
      'slippageTolerance',
      'originAsset',
      'depositType',
      'destinationAsset',
      'amount',
      'refundTo',
      'refundType',
      'recipient',
      'recipientType',
      'deadline',
    ];
    for (const field of fields) {
      const matches = field === 'originAsset' || field === 'destinationAsset'
        ? quoteAssetIdsMatch(echoed?.[field], request[field])
        : String(echoed?.[field]) === String(request[field]);
      if (!matches) {
        throw new QuoteSecurityError(`1Click quote did not match the requested ${field}.`, 'QUOTE_PARAMETER_MISMATCH');
      }
    }
    if (!quoteAppFeesAreAllowed(echoed?.appFees, request.appFees)) {
      throw new QuoteSecurityError('1Click quote did not match the requested application fees.', 'QUOTE_PARAMETER_MISMATCH');
    }

    if (!response?.quote?.amountOut || !response?.quote?.minAmountOut) {
      throw new QuoteSecurityError('1Click quote omitted output amounts.', 'INVALID_QUOTE_PAYLOAD');
    }
    if (requireDepositAddress && !response?.quote?.depositAddress) {
      throw new QuoteSecurityError('1Click executable quote omitted its deposit address.', 'MISSING_DEPOSIT_ADDRESS');
    }
    if (requireDepositAddress && !response?.quote?.deadline) {
      throw new QuoteSecurityError('1Click executable quote omitted its deadline.', 'MISSING_QUOTE_DEADLINE');
    }
  }

  async getExecutionStatus(swap) {
    const response = await OneClickService.getExecutionStatus(swap.deposit_address, swap.deposit_memo ?? undefined);
    const storedQuote = swap.executable_quote;
    if (!storedQuote || !verifyQuoteSignature(storedQuote)) {
      throw new QuoteSecurityError('The stored executable quote no longer has a valid signature.', 'INVALID_STORED_QUOTE_SIGNATURE');
    }
    if (!statusQuoteMatchesStored(response?.quoteResponse, storedQuote)) {
      throw new QuoteSecurityError('1Click status did not match the stored executable quote.', 'STATUS_QUOTE_MISMATCH');
    }
    if (response.quoteResponse.quote?.depositAddress !== swap.deposit_address) {
      throw new QuoteSecurityError('1Click status referred to a different deposit address.', 'STATUS_DEPOSIT_MISMATCH');
    }
    if ((response.quoteResponse.quote?.depositMemo ?? null) !== (swap.deposit_memo ?? null)) {
      throw new QuoteSecurityError('1Click status referred to a different deposit memo.', 'STATUS_MEMO_MISMATCH');
    }
    return response;
  }

  submitDepositTransaction(swap, txHash) {
    return OneClickService.submitDepositTx({
      depositAddress: swap.deposit_address,
      txHash,
      memo: swap.deposit_memo ?? undefined,
    });
  }

  isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
  }

  isDepositModeError(error) {
    if (!(error instanceof ApiError) || error.status !== 400) return false;
    const text = JSON.stringify(error?.body ?? '').toLowerCase();
    return text.includes('depositmode') || text.includes('deposit mode') || text.includes('memo');
  }

  errorCode(error) {
    return classifyOperationalError(error, { operation: 'oneclick_api' }).code;
  }

  classifyError(error, context) {
    return classifyOperationalError(error, context);
  }

  safeErrorLogFields(error, context) {
    return safeErrorLogFields(error, context);
  }

  userMessage(error, context) {
    return this.classifyError(error, context).userMessage;
  }
}

function canonicalQuoteAssetId(assetId) {
  return QUOTE_ASSET_ALIASES.get(assetId) ?? assetId;
}

export function quoteAssetIdsMatch(left, right) {
  return canonicalQuoteAssetId(left) === canonicalQuoteAssetId(right);
}

export function quoteAppFeesMatch(left, right) {
  const normalizedLeft = normalizeAppFees(left);
  const normalizedRight = normalizeAppFees(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

export function quoteAppFeesAreAllowed(returnedFees, requestedFees) {
  if (quoteAppFeesMatch(returnedFees, requestedFees)) return true;
  if (!quoteAppFeesMatch(requestedFees, [])) return false;
  const normalizedReturnedFees = normalizeAppFees(returnedFees);
  if (normalizedReturnedFees?.length !== 1) return false;
  const [returnedFee] = normalizedReturnedFees;
  if (returnedFee.recipient !== FORCED_FALLBACK_FEE_RECIPIENT) return false;
  if (!/^(0|[1-9]\d*)$/.test(returnedFee.fee)) return false;
  const feeBps = Number(returnedFee.fee);
  return Number.isSafeInteger(feeBps) && feeBps >= 0 && feeBps <= MAX_FORCED_FALLBACK_FEE_BPS;
}

const STATUS_REQUEST_FIELDS = [
  'dry',
  'swapType',
  'slippageTolerance',
  'originAsset',
  'depositType',
  'destinationAsset',
  'amount',
  'refundTo',
  'refundType',
  'recipient',
  'recipientType',
  'deadline',
];

const STATUS_QUOTE_FIELDS = [
  'amountIn',
  'amountInFormatted',
  'amountInUsd',
  'minAmountIn',
  'amountOut',
  'amountOutFormatted',
  'amountOutUsd',
  'minAmountOut',
  'depositAddress',
  'depositMemo',
  'deadline',
  'timeWhenInactive',
  'timeEstimate',
  'virtualChainRecipient',
  'virtualChainRefundRecipient',
  'customRecipientMsg',
  'refundFee',
  'withdrawFee',
];

export function statusQuoteMatchesStored(returnedQuote, storedQuote) {
  if (!returnedQuote || !storedQuote) return false;
  if (returnedQuote.signature !== storedQuote.signature || returnedQuote.timestamp !== storedQuote.timestamp) return false;
  return fieldsMatch(returnedQuote.quoteRequest, storedQuote.quoteRequest, STATUS_REQUEST_FIELDS)
    && quoteAppFeesMatch(returnedQuote.quoteRequest?.appFees, storedQuote.quoteRequest?.appFees)
    && fieldsMatch(returnedQuote.quote, storedQuote.quote, STATUS_QUOTE_FIELDS);
}

function normalizeAppFees(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const normalized = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || entry.recipient == null || entry.fee == null) return null;
    normalized.push({ recipient: String(entry.recipient), fee: String(entry.fee) });
  }
  return normalized;
}

function fieldsMatch(left, right, fields) {
  if (!left || !right) return false;
  return fields.every((field) => String(left[field] ?? '') === String(right[field] ?? ''));
}
