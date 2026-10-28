import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        'jwt',
        'token',
        'discordToken',
        'oneClickJwt',
        'fixedFloatApiKey',
        'fixedFloatApiSecret',
        '*.fixedFloatApiKey',
        '*.fixedFloatApiSecret',
        '*.providerData.token',
        'providerData.token',
        'changellyPrivateKeyHex',
        '*.changellyPrivateKeyHex',
        'changeNowApiKey',
        '*.changeNowApiKey',
        '*.jwt',
        '*.token',
        '*.recipient',
        '*.refundTo',
        '*.depositAddress',
        '*.depositMemo',
        '*.txHash',
        '*.body',
        '*.request',
        '*.responseBody',
        '*.quote',
        '*.quoteRequest',
        '*.quoteResponse',
      ],
      censor: '[REDACTED]',
    },
  });
}
