import { ApiError } from '@defuse-protocol/one-click-sdk-typescript';
import { DiscordAPIError, HTTPError } from 'discord.js';

const MESSAGES = Object.freeze({
  INVALID_RECIPIENT_ADDRESS: 'The receiving address is not valid for the selected destination network. Check the network and address, then try again.',
  INVALID_REFUND_ADDRESS: 'The refund address is not valid for the selected sending network. Check the network and address, then try again.',
  INVALID_WALLET_ADDRESS: 'One of the wallet addresses is not valid for its selected network. Check both addresses and try again.',
  AMOUNT_TOO_LOW: 'The amount is below the minimum available for this route. Enter a larger amount and request a new preview.',
  AMOUNT_TOO_HIGH: 'The amount is above the maximum available for this route. Enter a smaller amount and request a new preview.',
  NO_LIQUIDITY_ROUTE: 'No solvers are available for this swap right now. Try another network or token.',
  QUOTE_EXPIRED: 'The quote request expired before it could be completed. Request a fresh preview.',
  ONECLICK_AUTHENTICATION: 'The swap service is temporarily unavailable because its API credentials need attention.',
  ONECLICK_RATE_LIMITED: 'The swap service is receiving too many requests. Wait a moment and try again.',
  ONECLICK_NOT_FOUND: 'The deposit is not visible yet. If it was just sent, wait briefly and refresh.',
  DEPOSIT_TX_REJECTED: 'The provider could not match that transaction ID to this swap yet. Check the sending-network transaction ID, or wait briefly for automatic detection.',
  ONECLICK_REQUEST_REJECTED: 'The swap service declined this quote. Check the amount and both wallet networks, then try another route if needed.',
  ONECLICK_UNAVAILABLE: 'The swap service is temporarily unavailable. No funds were moved; try again later.',
  QUOTE_SECURITY_ERROR: 'The quote failed a security check. No deposit instructions were created. Try again later.',
  STATUS_SECURITY_ERROR: 'The status response failed a security check. Automatic tracking will retry; do not send another deposit.',
  DISCORD_INTERACTION_FAILED: 'Discord could not update this ticket. Your saved selections are unchanged; try the control again.',
  INTERNAL_ERROR: 'The bot could not complete that action. Your saved selections are unchanged; try again later.',
});

const ONECLICK_OPERATIONS = new Set([
  'alternative_route_quote',
  'asset_catalogue',
  'deposit_submission',
  'executable_quote',
  'execution_status',
  'oneclick_api',
  'preview_quote',
  'status_refresh',
]);

export function classifyOperationalError(error, { operation = 'request' } = {}) {
  if (error?.name === 'RelayError') {
    return result('relay', error.code, numericStatus(error), MESSAGES[error.code] ?? error.message, operation);
  }
  if (error?.name === 'FixedFloatError') {
    return result('fixedfloat', error.code, numericStatus(error), MESSAGES[error.code] ?? error.message, operation);
  }
  if (error?.name === 'ChangellyError') {
    return result('changelly', error.code, numericStatus(error), MESSAGES[error.code] ?? error.message, operation);
  }
  if (error?.name === 'ChangeNowError') {
    return result('changenow', error.code, numericStatus(error), MESSAGES[error.code] ?? error.message, operation);
  }
  if (error?.name === 'QuoteSecurityError') {
    const userMessage = ['execution_status', 'status_refresh'].includes(operation)
      ? MESSAGES.STATUS_SECURITY_ERROR
      : MESSAGES.QUOTE_SECURITY_ERROR;
    return result('security', error.code ?? 'QUOTE_SECURITY_ERROR', null, userMessage, operation);
  }

  if (isDiscordError(error)) {
    const discordCode = typeof error.code === 'number' || typeof error.code === 'string' ? String(error.code) : null;
    return {
      ...result('discord', discordCode ? `DISCORD_${discordCode}` : 'DISCORD_INTERACTION_FAILED', numericStatus(error), MESSAGES.DISCORD_INTERACTION_FAILED, operation),
      discordCode,
    };
  }

  if (isOneClickApiError(error)) {
    return classifyOneClickApiError(error, operation);
  }

  if (ONECLICK_OPERATIONS.has(operation)) {
    return result('oneclick', 'ONECLICK_UNAVAILABLE', null, MESSAGES.ONECLICK_UNAVAILABLE, operation);
  }

  return result('internal', typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR', null, MESSAGES.INTERNAL_ERROR, operation);
}

export function messageForErrorCode(code) {
  return MESSAGES[code] ?? null;
}

export function safeErrorLogFields(error, context = {}) {
  const classification = classifyOperationalError(error, context);
  return {
    errorSource: classification.source,
    errorCode: classification.code,
    httpStatus: classification.status,
    operation: classification.operation,
    ...(classification.discordCode ? { discordCode: classification.discordCode } : {}),
  };
}

function classifyOneClickApiError(error, operation) {
  const status = numericStatus(error);
  const text = collectBodyText(error.body);
  let code;

  if (status === 401 || status === 403) code = 'ONECLICK_AUTHENTICATION';
  else if (status === 429) code = 'ONECLICK_RATE_LIMITED';
  else if (operation === 'deposit_submission' && [400, 404, 422].includes(status)) code = 'DEPOSIT_TX_REJECTED';
  else if (status === 404) code = 'ONECLICK_NOT_FOUND';
  else if (status >= 500) code = 'ONECLICK_UNAVAILABLE';
  else if (mentionsInvalidRefund(text)) code = 'INVALID_REFUND_ADDRESS';
  else if (mentionsInvalidRecipient(text)) code = 'INVALID_RECIPIENT_ADDRESS';
  else if (mentionsInvalidAddress(text)) code = 'INVALID_WALLET_ADDRESS';
  else if (mentionsAmountTooLow(text)) code = 'AMOUNT_TOO_LOW';
  else if (mentionsAmountTooHigh(text)) code = 'AMOUNT_TOO_HIGH';
  else if (mentionsNoRoute(text)) code = 'NO_LIQUIDITY_ROUTE';
  else if (mentionsExpiry(text)) code = 'QUOTE_EXPIRED';
  else if (status === 400 || status === 422) code = 'ONECLICK_REQUEST_REJECTED';
  else code = 'ONECLICK_UNAVAILABLE';

  const routeLimit = extractExplicitUsdRouteLimit(error.body, code);
  const limitHint = routeLimit ? `Current route ${routeLimit.kind}: ${routeLimit.display}.` : null;
  const userMessage = limitHint ? `${MESSAGES[code]} ${limitHint}` : MESSAGES[code];
  return Object.freeze({ ...result('oneclick', code, status, userMessage, operation), routeLimit });
}

export function extractExplicitUsdRouteLimit(body, code) {
  if (code !== 'AMOUNT_TOO_LOW' && code !== 'AMOUNT_TOO_HIGH') return null;
  const message = typeof body === 'string' ? body : body?.message;
  if (typeof message !== 'string' || message.length > 1000) return null;
  const kind = code === 'AMOUNT_TOO_LOW' ? 'minimum' : 'maximum';
  const keyword = code === 'AMOUNT_TOO_LOW' ? '(?:minimum|min)' : '(?:maximum|max)';
  const afterKeyword = new RegExp(`${keyword}[\\s\\S]{0,80}?(?:\\$\\s*([0-9][0-9,.]*)|([0-9][0-9,.]*)\\s*USD\\b)`, 'i');
  const beforeKeyword = new RegExp(`(?:\\$\\s*([0-9][0-9,.]*)|([0-9][0-9,.]*)\\s*USD\\b)[\\s\\S]{0,40}?${keyword}`, 'i');
  const match = afterKeyword.exec(message) ?? beforeKeyword.exec(message);
  const rawAmount = match?.[1] ?? match?.[2];
  const amount = formatRouteUsdBound(rawAmount, code === 'AMOUNT_TOO_LOW');
  return amount ? { kind, usd: amount.replace('$', '').replaceAll(',', ''), display: amount } : null;
}

function formatRouteUsdBound(value, roundUp) {
  const clean = String(value ?? '').replaceAll(',', '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  let cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  if (roundUp && /[1-9]/.test(fraction.slice(2))) cents += 1n;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${String(cents % 100n).padStart(2, '0')}`;
}

function isOneClickApiError(error) {
  return error instanceof ApiError || error?.name === 'ApiError';
}

function isDiscordError(error) {
  return error instanceof DiscordAPIError
    || error instanceof HTTPError
    || error?.name === 'DiscordAPIError'
    || error?.name === 'HTTPError';
}

function result(source, code, status, userMessage, operation) {
  return Object.freeze({ source, code, status, userMessage, operation });
}

function numericStatus(error) {
  return Number.isInteger(error?.status) ? error.status : null;
}

function collectBodyText(body) {
  const values = [];
  const visit = (value, depth) => {
    if (values.join(' ').length >= 4096 || depth > 4 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value).slice(0, 30)) {
        values.push(key);
        if (/(?:recipient|refund|address|wallet|deposit|memo|hash|jwt|token|quote|request)/i.test(key)) continue;
        visit(item, depth + 1);
      }
    }
  };
  visit(body, 0);
  return values.join(' ').slice(0, 4096).toLowerCase();
}

function mentionsInvalidRefund(text) {
  return /(?:refund|refundto)[\s\S]{0,80}(?:invalid|malformed|address)/.test(text)
    || /(?:invalid|malformed)[\s\S]{0,80}(?:refund|refundto)/.test(text);
}

function mentionsInvalidRecipient(text) {
  return /(?:recipient|destination)[\s\S]{0,80}(?:invalid|malformed|address)/.test(text)
    || /(?:invalid|malformed)[\s\S]{0,80}(?:recipient|destination)/.test(text);
}

function mentionsInvalidAddress(text) {
  return /(?:invalid|malformed|unsupported)[\s\S]{0,50}(?:address|wallet)/.test(text)
    || /(?:address|wallet)[\s\S]{0,50}(?:invalid|malformed)/.test(text);
}

function mentionsAmountTooLow(text) {
  return /(?:amount|minimum|min amount)[\s\S]{0,80}(?:too low|below|minimum|small)/.test(text)
    || /(?:too low|below minimum)[\s\S]{0,80}(?:amount|deposit)/.test(text)
    || /(?:minimum|min)[\s\S]{0,40}(?:amount|deposit)/.test(text);
}

function mentionsAmountTooHigh(text) {
  return /(?:amount|maximum|max amount)[\s\S]{0,80}(?:too high|above|maximum|exceed)/.test(text)
    || /(?:too high|above maximum|exceed)[\s\S]{0,80}(?:amount|deposit)/.test(text)
    || /(?:maximum|max)[\s\S]{0,40}(?:amount|deposit)/.test(text);
}

function mentionsNoRoute(text) {
  return /no (?:available )?(?:route|quote|liquidity)/.test(text)
    || /no (?:solver|solvers|market maker|market makers)(?: available| found| responded)?/.test(text)
    || /(?:swap|quote|request)[\s\S]{0,80}(?:cannot|can't|could not|unable to)[\s\S]{0,50}(?:fulfill|fulfil|execute|fill)/.test(text)
    || /(?:pair|route|liquidity|market maker)[\s\S]{0,80}(?:not available|unavailable|unsupported|insufficient|not found)/.test(text)
    || /unsupported (?:pair|route|asset pair)/.test(text);
}

function mentionsExpiry(text) {
  return /(?:deadline|quote|request)[\s\S]{0,60}(?:expired|too old|timeout)/.test(text)
    || /expired[\s\S]{0,60}(?:deadline|quote|request)/.test(text);
}
