export class AmountValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmountValidationError';
  }
}

export function toBaseUnits(value, decimals) {
  if (typeof value !== 'string') throw new AmountValidationError('Amount must be entered as text.');
  const input = value.trim();
  if (input.length === 0 || input.length > 100) throw new AmountValidationError('Enter a valid amount.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new AmountValidationError('This asset has invalid decimal metadata.');
  }

  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(input);
  if (!match) {
    throw new AmountValidationError('Use a positive decimal amount without commas or scientific notation.');
  }

  const [whole, fraction = ''] = input.split('.');
  if (fraction.length > decimals) {
    throw new AmountValidationError(`This asset supports at most ${decimals} decimal places.`);
  }

  const base = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(base) || BigInt(base) <= 0n) {
    throw new AmountValidationError('Amount must be greater than zero.');
  }
  return base;
}

export function shortenMiddle(value, visible = 8) {
  if (!value || value.length <= visible * 2 + 1) return value;
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

export function fromBaseUnits(value, decimals) {
  const digits = String(value ?? '0');
  if (!/^\d+$/.test(digits) || !Number.isInteger(decimals) || decimals < 0) return 'n/a';
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function roundBaseUnitsUpToPrecision(value, assetDecimals, precision) {
  const digits = String(value ?? '');
  if (!/^\d+$/.test(digits) || BigInt(digits) <= 0n) {
    throw new AmountValidationError('Amount must be a positive base-unit value.');
  }
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 255) {
    throw new AmountValidationError('This asset has invalid decimal metadata.');
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > assetDecimals) {
    throw new AmountValidationError('The requested amount precision is invalid for this asset.');
  }

  const quantum = pow10(assetDecimals - precision);
  return (ceilDiv(BigInt(digits), quantum) * quantum).toString();
}

export function parseUsdAmount(value) {
  if (typeof value !== 'string') throw new AmountValidationError('Enter the USD amount as text.');
  let input = value.trim().replace(/\s+usd$/i, '').trim();
  if (input.startsWith('$')) input = input.slice(1).trim();
  else if (input.endsWith('$')) input = input.slice(0, -1).trim();
  if (input.length === 0 || input.length > 40) throw new AmountValidationError('Enter a valid USD amount, such as $25.');

  if (input.includes(',')) {
    if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(input)) {
      throw new AmountValidationError('Use a USD amount such as $25 or $1,000.50.');
    }
    input = input.replaceAll(',', '');
  }
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(input);
  if (!match) throw new AmountValidationError('USD amounts can have at most two decimal places.');

  const [whole, fraction = ''] = input.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw new AmountValidationError('The USD amount must be at least $0.01.');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function usdToBaseUnits(usdValue, priceValue, assetDecimals) {
  const usd = parsePositiveDecimal(parseUsdAmount(usdValue), 'USD amount');
  const price = parsePositiveDecimal(priceValue, 'asset USD price');
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 255) {
    throw new AmountValidationError('This asset has invalid decimal metadata.');
  }

  const numerator = usd.units * pow10(assetDecimals + price.scale);
  const denominator = price.units * pow10(usd.scale);
  const amount = numerator / denominator;
  if (amount <= 0n) throw new AmountValidationError('That USD amount is too small for this asset.');
  return amount.toString();
}

export function formatUsd(value, maximumDecimals = 2) {
  try {
    const decimal = parsePositiveDecimal(value, 'USD value', true);
    const targetScale = Math.max(2, Math.min(6, maximumDecimals));
    const scaled = roundDiv(decimal.units * pow10(targetScale), pow10(decimal.scale));
    return `$${groupDecimal(formatScaled(scaled, targetScale, 2))}`;
  } catch {
    return '$0.00';
  }
}

export function completedSwapAmountUsd(swap) {
  const values = [
    ['changenow', 'changelly', 'fixedfloat'].includes(swap?.executable_quote?.provider) ? swap?.last_status_response?.swapDetails?.amountInUsd : null,
    swap?.executable_quote?.quote?.amountInUsd,
    swap?.last_status_response?.swapDetails?.depositedAmountUsd,
    swap?.last_status_response?.swapDetails?.amountInUsd,
    swap?.amount_usd_requested,
  ];
  for (const value of values) {
    try {
      const decimal = parsePositiveDecimal(value, 'completed swap USD value');
      return formatScaled(decimal.units, decimal.scale, 0);
    } catch {
      // Try the next stored representation.
    }
  }
  return null;
}

export function quotedNetworkAndSpreadFeeDisplay(quote, appFeeBps = 0) {
  try {
    const inputUsd = parsePositiveDecimal(quote.amountInUsd, 'input USD value');
    const outputUsd = parsePositiveDecimal(quote.amountOutUsd, 'output USD value');
    const scale = Math.max(inputUsd.scale, outputUsd.scale);
    const inputUnits = inputUsd.units * pow10(scale - inputUsd.scale);
    const outputUnits = outputUsd.units * pow10(scale - outputUsd.scale);
    if (outputUnits >= inputUnits) return '≈$0.00 (0.00%)';

    const feeBps = validFeeBps(appFeeBps);
    const costNumerator = ((inputUnits - outputUnits) * 10_000n) - (inputUnits * BigInt(feeBps));
    if (costNumerator <= 0n) return '≈$0.00 (0.00%)';
    const usdScaled = roundDiv(costNumerator * 10_000n, 10_000n * pow10(scale));
    const percentScaled = roundDiv(costNumerator, inputUnits);
    return `≈$${formatScaled(usdScaled, 4, 2)} (${formatScaled(percentScaled, 2, 2)}%)`;
  } catch {
    return 'Not available';
  }
}

export function lowerConsistentNetworkAndSpreadFeeDisplay(quote, appFeeBps = 0) {
  try {
    const inputUsd = parsePositiveDecimal(quote.amountInUsd, 'input USD value');
    const outputUsd = parsePositiveDecimal(quote.amountOutUsd, 'output USD value');
    const scale = Math.max(inputUsd.scale, outputUsd.scale);
    const inputUnits = inputUsd.units * pow10(scale - inputUsd.scale);
    const outputUnits = outputUsd.units * pow10(scale - outputUsd.scale);
    if (outputUnits >= inputUnits) return '≈$0.00 (0.00%)';

    const feeBps = validFeeBps(appFeeBps);
    const costNumerator = ((inputUnits - outputUnits) * 10_000n) - (inputUnits * BigInt(feeBps));
    if (costNumerator <= 0n) return '≈$0.00 (0.00%)';

    const usdScaled = roundDiv(costNumerator * 10_000n, 10_000n * pow10(scale));
    const percentScaled = roundDiv(costNumerator, inputUnits);
    const usdCandidate = usdScaled * pow10(scale);
    const percentCandidate = inputUnits * percentScaled;

    if (usdCandidate <= percentCandidate) {
      const matchingPercentScaled = roundDiv(usdScaled * pow10(scale), inputUnits);
      return `≈$${formatScaled(usdScaled, 4, 2)} (${formatScaled(matchingPercentScaled, 2, 2)}%)`;
    }

    const matchingUsdScaled = roundDiv(inputUnits * percentScaled, pow10(scale));
    return `≈$${formatScaled(matchingUsdScaled, 4, 2)} (${formatScaled(percentScaled, 2, 2)}%)`;
  } catch {
    return 'Not available';
  }
}

export function quotedRouteCostBps(quote) {
  try {
    const inputUsd = parsePositiveDecimal(quote?.amountInUsd, 'input USD value');
    const outputUsd = parsePositiveDecimal(quote?.amountOutUsd, 'output USD value');
    const scale = Math.max(inputUsd.scale, outputUsd.scale);
    const inputUnits = inputUsd.units * pow10(scale - inputUsd.scale);
    const outputUnits = outputUsd.units * pow10(scale - outputUsd.scale);
    if (outputUnits >= inputUnits) return 0;
    return Number(ceilDiv((inputUnits - outputUnits) * 10_000n, inputUnits));
  } catch {
    return null;
  }
}

export function lowerQuotedRouteCostValues(quote) {
  return [quote, quote?.providerUsd]
    .map(values => ({ values, display: routeCostPercentDisplay(values) }))
    .filter(entry => entry.display !== 'Not available')
    .sort((a, b) => Number.parseFloat(a.display) - Number.parseFloat(b.display))[0]?.values ?? quote;
}

export function quotedRouteCostPercentDisplay(quote) {
  return routeCostPercentDisplay(lowerQuotedRouteCostValues(quote));
}

function routeCostPercentDisplay(quote) {
  try {
    const inputUsd = parsePositiveDecimal(quote?.amountInUsd, 'input USD value');
    const outputUsd = parsePositiveDecimal(quote?.amountOutUsd, 'output USD value');
    const scale = Math.max(inputUsd.scale, outputUsd.scale);
    const inputUnits = inputUsd.units * pow10(scale - inputUsd.scale);
    const outputUnits = outputUsd.units * pow10(scale - outputUsd.scale);
    if (outputUnits >= inputUnits) return '0.00%';
    const percentScaled = roundDiv((inputUnits - outputUnits) * 10_000n, inputUnits);
    return `${formatScaled(percentScaled, 2, 2)}%`;
  } catch {
    return 'Not available';
  }
}

export function residualAppFeeBps(quote, targetTotalCostBps) {
  const target = validFeeBps(targetTotalCostBps);
  if (target === 0) return 0;
  const routeCost = quotedRouteCostBps(quote);
  if (routeCost === null) return 0;
  return Math.max(0, target - routeCost);
}

export function quoteAppFeeBps(quoteResponse) {
  const fees = quoteResponse?.quoteRequest?.appFees;
  if (!Array.isArray(fees)) return 0;
  return fees.reduce((total, entry) => total + validFeeBps(entry?.fee), 0);
}

export function quotedAppFeeDisplay(quoteResponse, inputUsdOverride = null) {
  const feeBps = quoteAppFeeBps(quoteResponse);
  if (feeBps === 0) return '$0.00 (0%)';
  const percentage = `${formatScaled(BigInt(feeBps), 2, 0)}%`;
  try {
    const inputUsd = parsePositiveDecimal(inputUsdOverride ?? quoteResponse?.quote?.amountInUsd, 'input USD value');
    const usdScaled = roundDiv(inputUsd.units * BigInt(feeBps) * 10_000n, 10_000n * pow10(inputUsd.scale));
    return `≈$${formatScaled(usdScaled, 4, 2)} (${percentage})`;
  } catch {
    return percentage;
  }
}

function parsePositiveDecimal(value, label, allowZero = false) {
  const input = String(value ?? '').trim();
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(input);
  if (!match) throw new AmountValidationError(`The ${label} is unavailable.`);
  const [whole, fraction = ''] = input.split('.');
  if (fraction.length > 30) throw new AmountValidationError(`The ${label} has unsupported precision.`);
  const units = BigInt(`${whole}${fraction}`);
  if (allowZero ? units < 0n : units <= 0n) throw new AmountValidationError(`The ${label} is unavailable.`);
  return { units, scale: fraction.length };
}

function pow10(exponent) {
  return 10n ** BigInt(exponent);
}

function roundDiv(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function validFeeBps(value) {
  const fee = Number(value);
  return Number.isInteger(fee) && fee >= 0 && fee <= 500 ? fee : 0;
}

function formatScaled(value, scale, minimumDecimals) {
  const digits = value.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const whole = digits.slice(0, -scale);
  let fraction = digits.slice(-scale);
  while (fraction.length > minimumDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

function groupDecimal(value) {
  const [whole, fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function tokenAmountUsd(amount, price) {
  const token = parsePositiveDecimal(amount, 'token amount');
  const rate = parsePositiveDecimal(price, 'USD price');
  return formatScaled(roundDiv(token.units * rate.units * 100n, pow10(token.scale + rate.scale)), 2, 2);
}
